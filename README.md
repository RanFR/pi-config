# pi-config

[RanFR](https://github.com/RanFR) 的 [pi coding agent](https://github.com/earendil-works/pi) 个人配置仓库:扩展、提示词模板、主题与全局配置(`settings.json` / `models.json` / `mcp.json` / `AGENTS.md`)。目标版本 **pi 1.6.x**(扩展以 `@earendil-works/pi-coding-agent@1.6.1` 的 API 为准)。

## 目录结构

```
├── extensions/          # TypeScript 扩展(工具 / 命令 / 钩子)
│   ├── ask-user-question.ts
│   ├── shell-timeout.ts
│   ├── todo.ts
│   ├── codex-tools/     # 从 codex CLI 移植的 4 个命令,含独立 README
│   ├── commit/          # /commit:生成 Conventional Commits 消息并提交
│   └── (pi-batch-runner 独立仓库,经 pi packages 安装)
├── prompts/             # 斜杠命令提示词模板(YAML frontmatter + ${ARGUMENTS} 替换)
│   └── plan.md
├── themes/              # 主题 JSON(pi theme schema)
├── settings.json        # 全局设置(模型 / 主题 / packages)
├── models.json          # 模型元数据覆盖
├── mcp.json             # MCP 服务器配置
├── AGENTS.md            # 全局 agent 指南(Python/uv 工具链规则、任务跟踪规则)
├── .prettierrc          # Prettier 配置
└── LICENSE              # MIT
```

## 扩展(extensions/)

| 扩展 | 形态 | 功能 |
|---|---|---|
| [codex-tools](extensions/codex-tools/README.md) | 斜杠命令 | 从 codex CLI 移植的 `/init`(生成 AGENTS.md)、`/diff`(工作区完整 diff 查看器)、`/review`(P0–P3 结构化代码审查)、`/recap`(会话速览摘要) |
| [commit](extensions/commit/) | 斜杠命令 | `/commit [说明]`:单次低推理力度的模型调用生成 Conventional Commits 消息并提交,参考仓库最近 15 条提交的语言与风格;`/commit check` 先审阅再决定(直接提交 / 手动编辑 / 带反馈重写 / 取消)。已暂存内容原样提交;未暂存时自动暂存全部变更,疑似密钥的文件(`.env*`、`*.pem` / `*.key`、`id_rsa`、`.netrc` 等)永不提交。diff 超出预算时裁剪(省略锁文件、每文件最多 200 行、总量约 48k 字符)。底部状态栏实时显示当前阶段(等待模型 → 已接收 N 字符 → 执行 git commit)与耗时;模型调用沿用 pi 会话轮次的超时与重试策略(读取 settings 的 `retry.*` / `httpIdleTimeoutMs`),瞬时错误按退避自动重试并在状态栏显示倒计时;按中断键(默认 Esc)可随时取消模型调用,不会提交 |
| [pi-batch-runner](https://github.com/RanFR/pi-batch-runner) | 斜杠命令 | `/batch` 批处理:按清单文件顺序执行多个提示词任务,支持新会话隔离 / 会话续用、自动重试、断点续跑、汇总报告。**独立仓库维护**,以 pi package 安装,不在本仓库内同步 |
| `ask-user-question.ts` | 工具 | 注册 `ask_user_question` 工具:TUI 弹窗向用户提问,按参数派生自由输入 / 单选 / 多选三种交互,选项列表始终附带 "Other" 自由输入;`executionMode: "sequential"` 串行化弹窗,`outputSchema` 输出结构化结果(`status` / `mode` / `answers`)供 codemode 读取;自由输入模式亦支持 RPC,非交互且非 RPC 模式返回 `unavailable` |
| `todo.ts` | 工具 + 命令 | `todo` 工具(list / add / set / toggle / clear)与 `/todos` 查看命令;状态存于 session entries,分支 / 重载后自动重建,压缩(compaction)或分支摘要后再把当前列表同步回模型上下文 |
| `shell-timeout.ts` | 钩子 | 通过 `tool_call` 钩子给内置 bash/powershell 工具注入并钳制 timeout:默认 300s,上限 600s,防止命令挂起无限运行 |

## 提示词(prompts/)

| 命令 | 功能 |
|---|---|
| `/plan <任务描述>` | 只读探索仓库后产出一份自包含的实施计划,写入当前目录 `.pi/plans/<日期>-<短slug>.md`,不执行实现;除任务描述完全缺失外不打断提问(仅此时经 `ask_user_question` 工具问一次),其余不确定项记为假设;完成后只回复文件路径与 2–3 行摘要 |

## 主题(themes/)

- **nord**(当前启用)— Nord 配色,含 syntax / thinking / tool / export 全量色板
- **selenized-dark** — Selenized Dark 配色

两者均遵循 `https://pi.dev/schemas/theme.schema.json`,可用 `node -e "require('./themes/<file>.json')"` 快速校验 JSON 合法性。

## 全局配置

### settings.json

- 默认模型:`zai-coding-cn / glm-5.4`,thinking level `high`;`enabledModels` 限定模型循环列表;主题 `nord`
- `packages` 声明 git 包 `pi-batch-runner`(独立仓库,更新用 `pi update --extensions`;同步时注意保留该字段,否则会被覆盖)
- `lastChangelogVersion` / `extensionChangelogVersions` 为 pi 自动维护的状态字段,无需手动编辑

### models.json

- 遵循 `https://pi.dev/schemas/models.schema.json`;对 `zai-coding-cn` 的 `glm-5.4` 覆盖 `contextWindow` 为 512000

### mcp.json

- 三个 MCP 服务器,均来自智谱 `open.bigmodel.cn`,以 `Authorization: Bearer ${ZAI_CODING_CN_API_KEY}` 鉴权(需自行设置该环境变量):
  - `web-reader` — 抓取 URL 并转为 model-friendly markdown
  - `web-search-prime` — 联网搜索(新闻 / 行情 / 天气等实时信息)
  - `zread` — GitHub 仓库浏览器(zread.ai),检索知识文档、issue / PR 与目录结构
- 在会话中以 codemode 工具形式暴露(`mcp__web_reader`、`mcp__web_search_prime`、`mcp__zread`)

### AGENTS.md

- 全局 agent 指南,同步到 `~/.pi/agent/AGENTS.md`,对所有项目生效:
  - **Python 工具链**:Python 相关工作一律使用 `uv`(`uv run` / `uv add` / `uv sync` 等),不直接调用系统 `python` / `pip`;不在非 Python 项目中创建 `pyproject.toml`、`uv.lock`、`.python-version`
  - **任务跟踪**:3 项以上或多步骤任务须先用 todo 工具建列表,完成一项立即勾选,新事项随时追加;简单单步任务不建列表

## 安装与同步

pi 从 `~/.pi/agent/` 下的 `extensions/`、`prompts/`、`themes/`、`settings.json`、`models.json`、`mcp.json` 与 `AGENTS.md` 加载用户级配置。本仓库是配置源,同步过去即可全局生效:

```bash
# 复制同步(当前用法)
rsync -av --exclude node_modules extensions/ ~/.pi/agent/extensions/
rsync -av prompts/ ~/.pi/agent/prompts/
rsync -av themes/ ~/.pi/agent/themes/
cp settings.json models.json mcp.json AGENTS.md ~/.pi/agent/

# pi-batch-runner 为独立仓库(github.com/RanFR/pi-batch-runner),以 pi package 安装,不走上面的 rsync:
pi install git:github.com/RanFR/pi-batch-runner   # 首次安装,声明写入 ~/.pi/agent/settings.json 的 packages
pi update --extensions                             # 后续更新(拉取远端 main 并 reconcile)

# 或 symlink 单个扩展(开发期改动即时可见)
ln -s /path/to/pi-config/extensions/codex-tools ~/.pi/agent/extensions/codex-tools

# 或仅本次会话加载某个扩展,不影响全局
pi -e /path/to/pi-config/extensions/shell-timeout.ts
```

修改扩展 / 提示词 / 主题后,重启 pi 或在会话内执行 `/reload` 生效。

## 开发

- 扩展为 TypeScript,单文件或「目录 + `index.ts`」两种形态;pi 运行时经 jiti 加载,无需构建。默认导出 `function (pi: ExtensionAPI)`,类型与运行时 API 来自 `@earendil-works/pi-coding-agent`,另用到 `@earendil-works/pi-ai`、`@earendil-works/pi-tui` 与 `typebox`,运行时均由 pi 自身安装的依赖提供,仓库内无需 `node_modules`
- 目录内的相对导入显式带 `.ts` 后缀(如 `./git.ts`),与 jiti 直接加载方式一致
- 格式化遵循 `.prettierrc`(printWidth 100、2 空格、单引号、尾逗号、LF),提交前用 Prettier 格式化,如 `npx prettier --write <file>`
- 严格类型检查需先让 `@earendil-works/*` 可解析(把 pi 安装目录下的 `node_modules` 链接过来再跑 `tsc`),具体命令见 [codex-tools README](extensions/codex-tools/README.md#维护)
- pi-batch-runner 独立维护于 [RanFR/pi-batch-runner](https://github.com/RanFR/pi-batch-runner),类型检查 / 测试 / CHANGELOG 均在其仓库内进行
- 手工验证:改完 `/reload` 后实际调用对应命令 / 工具,确认行为与 TUI 渲染正常
- 提交信息遵循 Conventional Commits:`<type>[scope]: <description>`,imperative、< 72 字符;可用 `/commit` 直接生成

## 致谢

本仓库部分内容参考或改编自 [github/awesome-copilot](https://github.com/github/awesome-copilot),感谢该仓库及其全体贡献者。该仓库以 [MIT License](https://github.com/github/awesome-copilot/blob/main/LICENSE) 开源,相关内容的版权归原作者所有。

## License

[MIT](LICENSE) © 2026 RanFR
