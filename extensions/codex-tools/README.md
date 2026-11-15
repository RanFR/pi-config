# codex-tools

从 codex CLI 移植到 pi 的扩展，提供 4 个斜杠命令。安装于 `~/.pi/agent/extensions/codex-tools/`，全局生效（所有项目可用），修改代码后用 `/reload` 热加载。

源仓库参考：https://github.com/openai/codex （codex-rs Rust 实现）

| 命令 | 功能 | codex 源文件 |
|---|---|---|
| `/init` | 分析仓库并生成 AGENTS.md 贡献者指南 | `tui/assets/prompt_for_init_command.md` |
| `/diff` | 查看工作区完整 diff（含 untracked） | `tui/src/get_git_diff.rs` |
| `/review` | 结构化代码审查（P0–P3 发现 + 结论） | `prompts/src/review_request.rs`、`review/rubric.md` |
| `/recap` | 会话速览摘要（不动上下文） | `tui/src/app/recap.rs`、`recap_prompt.rs` |

---

## /init — 生成 AGENTS.md

```
/init                      # 生成 AGENTS.md
/init 重点写测试约定        # 附加自定义指令
```

- 扩展先本地检查 `AGENTS.md` 是否已存在：存在则警告并返回，**不消耗模型调用**
- 不存在则发送固定提示词，agent 探索仓库后写出标题为 "Repository Guidelines" 的文档（200–400 词，含项目结构 / 构建测试命令 / 代码风格 / 测试指南 / 提交与 PR 规范）
- 附加指令以 "Additional user instructions: ..." 追加到 prompt 末尾
- agent 忙碌时消息自动排队（followUp），不打断当前回合

## /diff — 工作区完整 diff

```
/diff
```

展示 staged + unstaged + untracked 三类变更的完整 diff。

**查看器按键**（TUI 模式）：

| 按键 | 作用 |
|---|---|
| `j/k` 或 `↑/↓` | 逐行滚动 |
| `PgUp/PgDn` 或空格 | 翻页 |
| `g` / `Home` | 跳到顶部 |
| `Shift+G` / `End` | 跳到底部 |
| `q` / `Esc` / `Enter` | 关闭 |

- 行级着色：`+` 绿、`-` 红、`@@` 强调色、`+++/---` 弱化
- 无变更时提示 "No changes detected"；非 git 仓库报错
- 单条 git 命令输出上限 8 MB，查看器上限 2 MB（超出截断）

**安全设计**：所有 git 调用带 `core.hooksPath=/dev/null`（不执行仓库 hooks），并加 `--no-textconv --no-ext-diff`（不执行仓库配置的外部过滤/diff 驱动程序）。

**模式回退**：print 模式（`pi -p "/diff"`）直接输出到 stdout；RPC/JSON 模式写入临时 `.patch` 文件并通知路径。

## /review — 代码审查

```
/review                    # 无参数：TUI 下弹选择框；非 TUI 默认审查未提交变更
/review base               # 对比默认基准分支（origin/HEAD → main → master 自动检测）
/review base main          # 对比指定基准分支
/review main               # 裸分支名，等价于 base <branch>
/review commit <sha>       # 审查指定提交
/review <sha>              # 7–40 位十六进制视为提交 SHA
```

**工作方式**：
1. 扩展解析目标并做 git 预计算：基准分支模式先算 `git merge-base`（SHA 直接嵌入 prompt）；提交模式先取提交标题
2. 构造审查 prompt（目标指令 + rubric）发送到当前会话，agent 用自己的工具实际读 diff、查上下文后输出报告

**报告格式**：
- 每条发现：`### [P0–P3] 标题` + 文件：行范围 + 置信度 + 一段解释
- 优先级：P0 阻塞必须修 · P1 紧急下周期 · P2 常规 · P3 低优先
- 结尾 `## Verdict`：整体 "patch is correct / incorrect" + 1–3 句理由；不生成修复代码

**rubric 要点**（继承 codex 判定标准）：只报本次变更引入的、离散可操作的、作者知情后会修的问题；不报存量问题与投机性猜测；宁缺毋滥。

## /recap — 会话速览

```
/recap
```

一次性旁路模型调用，生成当前会话的 catch-up 摘要（summary + 建议的下一步）。

**与 `/compact` 的区别**：`/compact` 用摘要**替换**会话上下文（释放 token）；`/recap` 完全不触碰上下文，纯粹给你一份"离开后回来接着干"的速览。

**行为细节**：
- 取当前分支最近约 32 KB 的可见对话（用户/助手消息 + 工具调用单行摘要），截头保尾
- 用当前会话模型、低推理力度单独调用，不影响主对话
- 摘要区分 proposed / queued / implemented / tested / published / installed 状态，并保留未验证事项（如"修复未部署"）
- `Next action` 仅在有真实的未回答问题、已约定下一步或明确解法时给出
- TUI 下以 Markdown 浮层展示（Enter/Esc 关闭）；非 TUI 以通知展示

---

## 常见问题

- **命令没生效 / 刚改过代码**：运行 `/reload` 重载扩展。
- **/diff 或 /review 提示 "not inside a git repository"**：pi 会话的 cwd 不在 git 仓库内。
- **/review 时 agent 正在跑别的**：审查 prompt 会排队，等当前回合结束后执行。
- **模型返回的 recap JSON 解析失败**：自动回退为原文展示，不影响使用。

## 维护

```
~/.pi/agent/extensions/codex-tools/
├── index.ts      # 入口：注册 4 个命令
├── git.ts        # 共享 git 辅助（diff 计算、merge-base、分支检测）
├── init.ts       # /init
├── diff.ts       # /diff（含全屏查看器组件）
├── review.ts     # /review（目标解析 + rubric 构造）
└── recap.ts      # /recap（对话提取 + 旁路模型调用 + 浮层展示）
```

扩展由 pi 通过 jiti 加载，无需编译。若改动后想做严格类型检查，需让 `@earendil-works/*` 可解析（例如把 `~/.pi/agent/install/releases/<版本>/node_modules` 链接为同级 `node_modules`），然后：

```bash
tsc --strict --noEmit --allowImportingTsExtensions \
  --module nodenext --moduleResolution nodenext --target es2022 \
  --skipLibCheck ~/.pi/agent/extensions/codex-tools/*.ts
```
