# 第三方许可声明

本仓库自身内容以 [MIT](LICENSE) 授权。以下是仓库中改编自第三方项目、需要随分发保留声明的部分。

## pi

[`extensions/todo.ts`](extensions/todo.ts) 改编自 [earendil-works/pi](https://github.com/earendil-works/pi) 的扩展示例 `examples/extensions/todo.ts`。pi 以 MIT 许可发布，按要求保留其版权与许可声明：

```
MIT License

Copyright (c) 2026 Earendil Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## OpenAI Codex

`extensions/codex-tools/` 整体改编自 [openai/codex](https://github.com/openai/codex)，以 Apache-2.0 授权，不适用本仓库的 MIT 协议。该目录带有独立的 [LICENSE](extensions/codex-tools/LICENSE) 与 [NOTICE](extensions/codex-tools/NOTICE)，改编对应关系与改动说明见其 [README](extensions/codex-tools/README.md#来源与许可)。

## github/awesome-copilot

本仓库早期版本（提交 `8d067fa` 至 `f5d83ef`）曾直接包含 [github/awesome-copilot](https://github.com/github/awesome-copilot) 的 `skills/git-commit/SKILL.md`，自 `60bca9d` 起已移除。现有的 `/commit` 扩展（`extensions/commit/`）是为 pi 独立实现的 TypeScript 代码，不包含该仓库的文字，只在流程思路上参考了该 skill，并同样遵循公开的 Conventional Commits 规范。

该仓库以 MIT 许可发布。因上述历史版本分发时未附声明，在此保留其版权与许可声明：

```
MIT License

Copyright GitHub, Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
