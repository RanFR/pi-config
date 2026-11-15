/**
 * Todo Extension - Demonstrates state management via session entries
 *
 * This extension:
 * - Registers a `todo` tool for the LLM to manage todos
 * - Registers a `/todos` command for users to view the list
 *
 * State is stored in tool result details (not external files), which allows
 * proper branching - when you branch, the todo state is automatically
 * correct for that point in history.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { matchesKey, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";

/** A single todo item. */
interface Todo {
  /** Stable 1-based id (renumbered from 1 by `set`). */
  id: number;
  /** Todo text. */
  text: string;
  /** Completion state. */
  done: boolean;
}

/** Structured payload attached to every todo tool result via `details`. */
interface TodoDetails {
  /** The action that produced this result. */
  action: "list" | "add" | "set" | "toggle" | "clear";
  /** Full list after the action, so state reconstruction stays trivial. */
  todos: Todo[];
  /** Next id to hand out. */
  nextId: number;
  /** Error summary for failed mutations. */
  error?: string;
}

/** TypeBox schema describing the `todo` tool parameters. */
const TodoParams = Type.Object({
  action: StringEnum(["list", "add", "set", "toggle", "clear"] as const),
  text: Type.Optional(Type.String({ description: "Todo text (for add)" })),
  items: Type.Optional(
    Type.Array(Type.String({ description: "Todo texts (for set)" })),
  ),
  id: Type.Optional(Type.Number({ description: "Todo ID (for toggle)" })),
});

/**
 * UI component for the `/todos` command.
 *
 * Full-screen framed list with per-item check marks and a completion
 * counter; Escape or Ctrl+C closes. Rendering is cached by width.
 */
class TodoListComponent {
  private todos: Todo[];
  private theme: Theme;
  private onClose: () => void;
  private cachedWidth?: number;
  private cachedLines?: string[];

  /**
   * @param todos - Current todo list to display.
   * @param theme - Active pi theme used for styling.
   * @param onClose - Invoked when the user dismisses the list.
   */
  constructor(todos: Todo[], theme: Theme, onClose: () => void) {
    this.todos = todos;
    this.theme = theme;
    this.onClose = onClose;
  }

  /** Closes the list on Escape or Ctrl+C. */
  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      this.onClose();
    }
  }

  /** Renders the framed list; cached by width, call {@link invalidate} when data changes. */
  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) {
      return this.cachedLines;
    }

    const lines: string[] = [];
    const th = this.theme;

    lines.push("");
    const title = th.fg("accent", " Todos ");
    const headerLine =
      th.fg("borderMuted", "─".repeat(3)) +
      title +
      th.fg("borderMuted", "─".repeat(Math.max(0, width - 10)));
    lines.push(truncateToWidth(headerLine, width));
    lines.push("");

    if (this.todos.length === 0) {
      lines.push(
        truncateToWidth(
          `  ${th.fg("dim", "No todos yet. Ask the agent to add some!")}`,
          width,
        ),
      );
    } else {
      const done = this.todos.filter((t) => t.done).length;
      const total = this.todos.length;
      lines.push(
        truncateToWidth(
          `  ${th.fg("muted", `${done}/${total} completed`)}`,
          width,
        ),
      );
      lines.push("");

      for (const todo of this.todos) {
        const check = todo.done ? th.fg("success", "✓") : th.fg("dim", "○");
        const id = th.fg("accent", `#${todo.id}`);
        const text = todo.done
          ? th.fg("dim", todo.text)
          : th.fg("text", todo.text);
        lines.push(truncateToWidth(`  ${check} ${id} ${text}`, width));
      }
    }

    lines.push("");
    lines.push(
      truncateToWidth(`  ${th.fg("dim", "Press Escape to close")}`, width),
    );
    lines.push("");

    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }

  /** Drops the render cache. */
  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }
}

/**
 * Extension entry point: registers the `todo` tool (for the LLM) and the
 * `/todos` command (for users).
 *
 * State lives in memory and is reconstructed from session entries on load,
 * so it branches correctly with history.
 *
 * @param pi - Extension API used to register the tool and the command.
 */
export default function (pi: ExtensionAPI) {
  // In-memory state (reconstructed from session on load)
  let todos: Todo[] = [];
  let nextId = 1;

  /** Render the full list as the LLM sees it; every mutation result includes it so the plan stays in recent context. */
  const formatTodos = () =>
    todos.length
      ? todos
          .map((t) => `[${t.done ? "x" : " "}] #${t.id}: ${t.text}`)
          .join("\n")
      : "No todos";

  /**
   * After compaction or branch summarization, the model's context no longer contains the todo
   * toolResults it knew the list from. Append a hidden custom message (still model-visible:
   * custom messages become user messages in the LLM context) carrying the full list.
   */
  const syncTodosToContext = () => {
    if (todos.length === 0) return;
    pi.sendMessage(
      {
        customType: "todo-sync",
        content: `Current todo list (state snapshot after history replacement; the todo tool holds the authoritative state):\n${formatTodos()}`,
        display: false,
      },
      { triggerTurn: false },
    );
  };

  /**
   * Reconstruct state from session entries.
   * Scans tool results for this tool and applies them in order.
   */
  const reconstructState = (ctx: ExtensionContext) => {
    todos = [];
    nextId = 1;

    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "message") continue;
      const msg = entry.message;
      if (msg.role !== "toolResult" || msg.toolName !== "todo") continue;

      const details = msg.details as TodoDetails | undefined;
      if (details) {
        todos = details.todos;
        nextId = details.nextId;
      }
    }
  };

  // Reconstruct state on session events
  pi.on("session_start", async (_event, ctx) => reconstructState(ctx));
  pi.on("session_tree", async (event, ctx) => {
    reconstructState(ctx);
    // Branch summarization replaces history with a summary, same gap as compaction.
    if (event.summaryEntry) syncTodosToContext();
  });

  // Compaction replaces the summarized range (including todo toolResults) with a summary
  // that has no obligation to preserve todo state; re-inject the list so the model's
  // view stays aligned with the authoritative in-memory state.
  pi.on("session_compact", async () => syncTodosToContext());

  // Register the todo tool for the LLM
  pi.registerTool({
    name: "todo",
    label: "Todo",
    description:
      "Manage a todo list. Actions: list, add (text), set (items: replace the whole plan in one call), toggle (id), clear. Every mutation returns the full list.",
    parameters: TodoParams,

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      switch (params.action) {
        case "list":
          return {
            content: [{ type: "text", text: formatTodos() }],
            details: {
              action: "list",
              todos: [...todos],
              nextId,
            } as TodoDetails,
          };

        case "add": {
          if (!params.text) {
            return {
              content: [{ type: "text", text: "Error: text required for add" }],
              details: {
                action: "add",
                todos: [...todos],
                nextId,
                error: "text required",
              } as TodoDetails,
              isError: true,
            };
          }
          const newTodo: Todo = {
            id: nextId++,
            text: params.text,
            done: false,
          };
          todos.push(newTodo);
          return {
            content: [
              {
                type: "text",
                text: `Added todo #${newTodo.id}: ${newTodo.text}\n\n${formatTodos()}`,
              },
            ],
            details: {
              action: "add",
              todos: [...todos],
              nextId,
            } as TodoDetails,
          };
        }

        case "set": {
          if (!params.items) {
            return {
              content: [
                { type: "text", text: "Error: items required for set" },
              ],
              details: {
                action: "set",
                todos: [...todos],
                nextId,
                error: "items required",
              } as TodoDetails,
              isError: true,
            };
          }
          // One call replaces the whole plan: ids renumber from 1, subsequent adds continue after.
          todos = params.items.map((text, i) => ({
            id: i + 1,
            text,
            done: false,
          }));
          nextId = todos.length + 1;
          return {
            content: [
              {
                type: "text",
                text: `Set ${todos.length} todos\n\n${formatTodos()}`,
              },
            ],
            details: {
              action: "set",
              todos: [...todos],
              nextId,
            } as TodoDetails,
          };
        }

        case "toggle": {
          if (params.id === undefined) {
            return {
              content: [
                { type: "text", text: "Error: id required for toggle" },
              ],
              details: {
                action: "toggle",
                todos: [...todos],
                nextId,
                error: "id required",
              } as TodoDetails,
              isError: true,
            };
          }
          const todo = todos.find((t) => t.id === params.id);
          if (!todo) {
            return {
              content: [{ type: "text", text: `Todo #${params.id} not found` }],
              details: {
                action: "toggle",
                todos: [...todos],
                nextId,
                error: `#${params.id} not found`,
              } as TodoDetails,
              isError: true,
            };
          }
          todo.done = !todo.done;
          return {
            content: [
              {
                type: "text",
                text: `Todo #${todo.id} ${todo.done ? "completed" : "uncompleted"}\n\n${formatTodos()}`,
              },
            ],
            details: {
              action: "toggle",
              todos: [...todos],
              nextId,
            } as TodoDetails,
          };
        }

        case "clear": {
          const count = todos.length;
          todos = [];
          nextId = 1;
          return {
            content: [
              {
                type: "text",
                text: `Cleared ${count} todos\n\n${formatTodos()}`,
              },
            ],
            details: { action: "clear", todos: [], nextId: 1 } as TodoDetails,
          };
        }

        default:
          return {
            content: [
              { type: "text", text: `Unknown action: ${params.action}` },
            ],
            details: {
              action: "list",
              todos: [...todos],
              nextId,
              error: `unknown action: ${params.action}`,
            } as TodoDetails,
          };
      }
    },

    renderCall(args, theme, _context) {
      // pi-schema's branded Schema<T> degrades to unknown under typebox's Static<>, hence String().
      let text =
        theme.fg("toolTitle", theme.bold("todo ")) +
        theme.fg("muted", String(args.action));
      if (args.text) text += ` ${theme.fg("dim", `"${args.text}"`)}`;
      if (args.items)
        text += ` ${theme.fg("dim", `(${args.items.length} items)`)}`;
      if (args.id !== undefined)
        text += ` ${theme.fg("accent", `#${args.id}`)}`;
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded }, theme, _context) {
      const details = result.details as TodoDetails | undefined;
      if (!details) {
        const text = result.content[0];
        return new Text(text?.type === "text" ? text.text : "", 0, 0);
      }

      if (details.error) {
        return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
      }

      const todoList = details.todos;

      switch (details.action) {
        case "list": {
          if (todoList.length === 0) {
            return new Text(theme.fg("dim", "No todos"), 0, 0);
          }
          let listText = theme.fg("muted", `${todoList.length} todo(s):`);
          const display = expanded ? todoList : todoList.slice(0, 5);
          for (const t of display) {
            const check = t.done
              ? theme.fg("success", "✓")
              : theme.fg("dim", "○");
            const itemText = t.done
              ? theme.fg("dim", t.text)
              : theme.fg("muted", t.text);
            listText += `\n${check} ${theme.fg("accent", `#${t.id}`)} ${itemText}`;
          }
          if (!expanded && todoList.length > 5) {
            listText += `\n${theme.fg("dim", `... ${todoList.length - 5} more`)}`;
          }
          return new Text(listText, 0, 0);
        }

        case "add": {
          const added = todoList[todoList.length - 1];
          return new Text(
            theme.fg("success", "✓ Added ") +
              theme.fg("accent", `#${added.id}`) +
              " " +
              theme.fg("muted", added.text),
            0,
            0,
          );
        }

        case "toggle": {
          // Content is mutation line + full list; the UI keeps only the mutation line.
          const text = result.content[0];
          const msg = (text?.type === "text" ? text.text : "").split("\n")[0];
          return new Text(
            theme.fg("success", "✓ ") + theme.fg("muted", msg),
            0,
            0,
          );
        }

        case "set": {
          let listText =
            theme.fg("success", "✓ ") +
            theme.fg("muted", `Set ${todoList.length} todo(s)`);
          const display = expanded ? todoList : todoList.slice(0, 5);
          for (const t of display) {
            const check = t.done
              ? theme.fg("success", "✓")
              : theme.fg("dim", "○");
            listText += `\n${check} ${theme.fg("accent", `#${t.id}`)} ${theme.fg("muted", t.text)}`;
          }
          if (!expanded && todoList.length > 5) {
            listText += `\n${theme.fg("dim", `... ${todoList.length - 5} more`)}`;
          }
          return new Text(listText, 0, 0);
        }

        case "clear":
          return new Text(
            theme.fg("success", "✓ ") + theme.fg("muted", "Cleared all todos"),
            0,
            0,
          );

        default: {
          // Validation failures arrive as details: {} (truthy but shapeless): neither
          // the !details nor the details.error branches above catch it. Render the
          // raw result text (the validation error) instead of returning undefined,
          // which would crash the TUI on the next render pass.
          const text = result.content[0];
          return new Text(
            text?.type === "text" ? theme.fg("error", text.text) : "",
            0,
            0,
          );
        }
      }
    },
  });

  // Register the /todos command for users
  pi.registerCommand("todos", {
    description: "Show all todos on the current branch",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/todos requires interactive mode", "error");
        return;
      }

      await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
        return new TodoListComponent(todos, theme, () => done());
      });
    },
  });
}
