# pi-batch-runner

pi 批处理扩展：在**单个 TUI 窗口**中，按清单文件顺序逐个执行多个互不相关的提示词任务。

解决的问题：单位局域网大模型算力有限，无法并发跑多个 pi 实例；手动开多个窗口逐条输入繁琐。本扩展一条命令启动整批任务，顺序执行、自动重试、断点续跑、完成后停留在 pi 中供检查。

## 安装

```bash
# 方式一：symlink 本仓库到扩展目录
ln -s /path/to/pi-batch-runner ~/.pi/agent/extensions/batch-runner

# 方式二：开发期直接加载
pi -e /path/to/pi-batch-runner
```

运行时零外部依赖（仅 Node 内置模块）；`@earendil-works/pi-coding-agent@1.4.0` 仅作为 devDependency 供类型检查。目标版本 **pi 1.4.0**。

## 命令

```
/batch <清单文件>                  启动批处理（相对路径基于 cwd；含空格用引号包裹）
/batch <清单文件> --dry-run        仅解析并预览任务列表，不执行
/batch <清单文件> --start <N>      从第 N 条任务开始（1-based，之前的任务标记为跳过）
/batch <清单文件> --retries <N>    覆盖自动重试次数（默认 3）
/batch <清单文件> --on-exhaust <mode>   重试耗尽后的行为：pause（默认）/ skip / abort
/batch stop                        温和停止：当前任务自然结束后停止，不再推进
/batch stop --now                  立即中止当前任务并停止整批
/batch status                      查看当前/最近批次的进度与各任务状态
```

`--on-exhaust` 三种取值：

- `pause`（默认）：弹选择框询问（重试本条 / 跳过，继续下一条 / 终止整批）；关闭对话框视为终止
- `skip`：记录失败并继续下一条
- `abort`：终止整批，进入汇总

## 清单文件格式

纯文本、肉眼可读，以单独一行 `---` 分隔任务条目；首个 `---` 之前的内容整段忽略（可写批次说明）。示例见 [`examples/tasks.example.md`](examples/tasks.example.md)：

```markdown
# 2025-06-20 数据平台批次
首个 --- 之前的内容整段忽略。

---
[新会话] 重构数据导入模块
把 src/import/ 下的解析器重构为流式实现，保持现有测试通过。
提示词正文支持任意多行，直到下一个 --- 或文件结束。

---
[继续] 补充导入模块边界测试
基于上一个任务的重构结果，补充错误路径的单元测试。

---
修复登录页样式
（没有标记时默认视为 [新会话]）
```

规则：

1. 每条任务的第一行是**标题**（用于状态栏、进度、汇总与会话命名），其余行为**提示词正文**；只有一个条目一行时，该行同时作为标题与提示词。
2. 标记 `[新会话]` / `[new]` / `[继续]` / `[continue]`（大小写不敏感）写在首行开头；无标记默认**新会话**（安全默认：上下文隔离）。
3. 「继续」任务沿用上一个任务的会话；**首条任务标记「继续」时，在当前交互会话中执行**（可用它接着手工会话跑批次）。
4. 裸标记行（标记后无标题）之后、标题行之前，允许出现保留字段行（`model:` / `timeout:` / `retries:` / `max-turns:` / `on-exhaust:`），当前版本识别后忽略（为未来扩展预留）；标题确定后出现的 `key: value` 行一律视为正文。
5. 正文空行保留，整体 trim；兼容 CRLF；UTF-8；解析结果为 0 个任务时报错。
6. 提示词中的 `@文件` 引用与模板由 pi 正常展开（`expandPromptTemplates: true`），与手工输入行为一致。

## 运行行为

- **执行**：逐条顺序执行；「新会话」任务通过 `newSession` 切入全新会话（当前交互会话不被污染），并自动为新会话命名（`批次名 · 任务N 标题`）。
- **完成判定**：`agent_settled` 事件 + `waitForIdle()` 双保险；失败判定读分支上最后一条 assistant 消息的 `stopReason`（`error` / `aborted`）。pi 自身的 run 内瞬时错误重试照常工作，本扩展的重试针对**最终以 error 收场**的运行；「模型答非所问」不可检测、不在范围内。
- **中断**：任务运行中按 `Esc` 会中止当前任务并弹出选择框（重试 / 跳过 / 终止），不会静默继续。
- **汇总**：全部定案后 notify 汇总 + 编辑器上方常驻 widget + 写入 `<清单文件>.report.md`，停留在 pi 中（不自动退出）。
- **进度文件**：`<清单文件>.progress.json` 随执行实时落盘，批次结束后改名 `.progress.json.done`。启动时若存在未完成进度会询问「从断点继续 / 从头重新开始 / 取消」；断点是「继续」任务时自动 `switchSession` 找回前置会话（会话文件丢失则降级为新会话并提示）。

## 运行中干预

| 操作 | 效果 |
|---|---|
| `Esc` | 中止当前任务，弹出重试/跳过/终止选择框 |
| `/batch stop` | 温和停止：当前任务自然结束后不再推进 |
| `/batch stop --now` | 立即中止当前任务并终止整批 |
| 直接输入新消息 | 会被 pi 排队在当前 run 之后执行，批处理相应推迟——**不建议**；需要干预用上表操作 |

## 与开发计划（PLAN.md）的偏差

实现过程中经 pi 1.4.0 源码/实测确认的三处调整：

1. **会话命名**（PLAN 6.7）：原方案 `pendingName` 写入 progress 文件 + `session_start` 处理器调 `pi.setSessionName`。实测会话替换后旧 `pi` 门面已失效（调用即抛 stale 错误，且在 `withSession` 链路中为致命错误），改为 `newSession({ setup: (sm) => sm.appendSessionInfo(name) })` 直写 sessionManager，效果相同且无需文件中转。
2. **settled 事件订阅**：`pi.on` 不能在批次运行中调用（stale），改为 factory 期注册 `agent_settled` 桥 + **模块级监听槽位**。注意 pi 每次会话替换都会重新执行扩展工厂（jiti 仅缓存工厂函数对象），因此接线状态必须放模块作用域——工厂体内的闭包变量每次替换都会重建（这是本次开发踩过的真实陷阱）。
3. **重试耗尽后的任务状态**：耗尽后（无论 skip 配置还是 pause 中选跳过）任务定案为 `failed` 并保留最后一次错误——比一律记 `skipped` 更利于汇总判读；`skipped` 保留给未实际运行的任务（`--start` 跳过、中断后跳过）。

## 开发

```bash
npm install        # 安装 devDependencies
npm run typecheck  # tsc --noEmit
npm test           # vitest（parser / executor 单测，不依赖真实 pi 进程与模型）
```

目录结构：

```
index.ts            扩展入口：命令注册、类型适配、事件桥、stop/status 子命令
lib/types.ts        类型与常量（BatchTask / BatchState / 引擎窄接口 / 可注入依赖）
lib/parser.ts       清单解析 + 参数 tokenize
lib/executor.ts     执行引擎（重试、会话边界闭包链、断点起点、汇总收尾）
lib/progress.ts     progress / report 文件读写与 done 改名
lib/report.ts       状态栏 / widget / report.md 渲染
test/               单元测试与 fixtures
examples/           示例清单
```

诊断：设 `PI_BATCH_DEBUG=1` 启动 pi，引擎与命令层会向 `/tmp/pi-batch-debug.log` 追加日志。
