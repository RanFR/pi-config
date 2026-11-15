# pi-config

[RanFR](https://github.com/RanFR) 的 [pi coding agent](https://github.com/earendil-works/pi) 个人配置仓库:扩展、提示词模板、技能与主题。目标版本 **pi 1.5.x**(扩展以 `@earendil-works/pi-coding-agent@1.5.2` 的 API 为准)。

## 目录结构

```
├── extensions/          # TypeScript 扩展(工具 / 命令 / 钩子)
│   ├── ask-user-question.ts
│   ├── shell-timeout.ts
│   ├── todo.ts
│   ├── codex-tools/     # 含独立 README
│   └── pi-batch-runner/ # 含独立 README、可独立类型检查
├── prompts/             # 斜杠命令提示词模板(YAML frontmatter + ${ARGUMENTS} 替换)
├── skills/              # 技能(每目录一个 SKILL.md)
├── themes/              # 主题 JSON(pi theme schema)
├── settings.json        # 全局设置
└── AGENTS.md            # 仓库贡献规范
```

## 扩展(extensions/)

| 扩展 | 形态 | 功能 |
|---|---|---|
| [codex-tools](extensions/codex-tools/README.md) | 斜杠命令 | 从 codex CLI 移植的 `/init`(生成 AGENTS.md)、`/diff`(工作区完整 diff 查看器)、`/review`(P0–P3 结构化代码审查)、`/recap`(会话速览摘要) |
| [pi-batch-runner](extensions/pi-batch-runner/README.md) | 斜杠命令 | `/batch` 批处理:按清单文件顺序执行多个提示词任务,支持新会话隔离 / 会话续用、自动重试、断点续跑、汇总报告 |
| `ask-user-question.ts` | 工具 | 注册 `ask_user_question` 工具:TUI 弹窗向用户提问,按参数派生自由输入 / 单选 / 多选三种交互;`executionMode: "sequential"` 串行化弹窗,`outputSchema` 输出结构化结果供 codemode 读取 |
| `todo.ts` | 工具 + 命令 | `todo` 工具(list / add / set / toggle / clear)与 `/todos` 查看命令;状态存于 session entries,分支/重载后自动重建 |
| `shell-timeout.ts` | 钩子 | 通过 `tool_call` 钩子给内置 bash/powershell 工具注入并钳制 timeout:默认 300s,上限 600s,防止命令挂起无限运行 |

## 提示词(prompts/)

| 命令 | 功能 |
|---|---|
| `/commit [type/scope 或附加说明]` | 加载 `git-commit` 技能,分析 diff、智能暂存并按 Conventional Commits 提交 |
| `/plan <任务描述>` | 只读探索仓库后产出一份自包含的实施计划,写入 `.pi/plans/<日期>-<短slug>.md`,不执行实现 |

## 技能(skills/)

- **git-commit** — 按 Conventional Commits 规范提交:分析 diff、类型/范围推断、智能暂存(跳过密钥)、消息生成与提交执行,含 git 安全协议(不 force、不跳 hooks 等)。

## 主题(themes/)

- **nord**(当前启用)— Nord 配色,含 syntax / thinking / tool / export 全量色板
- **selenized-dark** — Selenized Dark 配色

两者均遵循 `https://pi.dev/schemas/theme.schema.json`,可用 `node -e "require('./themes/<file>.json')"` 快速校验 JSON 合法性。

## 设置(settings.json)

- 默认模型:`zai-coding-cn / glm-5.3-flash`,thinking level `high`;`glm-5.3` 为 `max`
- `enabledModels` 限定模型循环列表;主题 `nord`

## 安装与同步

pi 从 `~/.pi/agent/` 下的 `extensions/`、`prompts/`、`skills/`、`themes/` 与 `settings.json` 加载用户级配置。本仓库是配置源,同步过去即可全局生效:

```bash
# 复制同步(当前用法)
rsync -av --exclude node_modules extensions/ ~/.pi/agent/extensions/
rsync -av prompts/ ~/.pi/agent/prompts/
rsync -av skills/ ~/.pi/agent/skills/
rsync -av themes/ ~/.pi/agent/themes/
cp settings.json ~/.pi/agent/settings.json

# 或 symlink 单个扩展(开发期改动即时可见)
ln -s /path/to/pi-config/extensions/codex-tools ~/.pi/agent/extensions/codex-tools

# 或仅本次会话加载某个扩展,不影响全局
pi -e /path/to/pi-config/extensions/shell-timeout.ts
```

修改扩展 / 提示词 / 技能 / 主题后,重启 pi 或在会话内执行 `/reload` 生效。

## 开发

- 扩展为单文件 TypeScript(pi 运行时经 jiti 加载,无需构建);默认导出 `function (pi: ExtensionAPI)`,类型来自 `@earendil-works/pi-coding-agent`
- `extensions/pi-batch-runner/` 可独立校验:`npm install && npm run typecheck`(vitest 测试框架已就绪,`npm test`)
- 手工验证:改完 `/reload` 后实际调用对应命令 / 工具,确认行为与 TUI 渲染正常
- 提交信息遵循 Conventional Commits:`<type>[scope]: <description>`,imperative、< 72 字符;可用 `/commit` 直接生成

## License

[MIT](LICENSE) © 2026 RanFR
