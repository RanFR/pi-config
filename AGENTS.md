## Python Tooling (uv)

These rules apply only to Python work. Never create Python tooling files (`pyproject.toml`, `uv.lock`, `.python-version`) or run `uv init` in a project that is not a Python project.

- Use `uv` for all Python environment, dependency, and execution tasks.
- Use `uv run` to run Python scripts, modules, and tools (e.g. `uv run script.py`, `uv run python -m module`, `uv run pytest`). Do not invoke system `python` or `python3` directly.
- Use `uv add` / `uv remove` to manage dependencies. Do not use `pip`, `pip3`, `python -m pip`, or `uv pip` unless explicitly required.
- Use `uv sync` to synchronize the environment with `pyproject.toml` and `uv.lock`. In CI or reproducible runs, use `uv sync --frozen`.
- Do not edit `uv.lock` manually; update it with `uv lock`, `uv add`, or `uv remove`.
- If a Python project is not already set up for `uv`, run `uv init` first. Use `uv python install` / `uv python pin` when the Python version matters.

## Task Tracking

- For any request with 3+ distinct items or multi-step complex work, create a todo list with the todo tool before starting.
- Toggle each item to done immediately after completing it, before moving to the next one. Never batch-update at the end.
- When new actionable items come up mid-task, add them to the list right away so nothing gets lost.
- Skip the todo list for simple single-step tasks to avoid noise.
