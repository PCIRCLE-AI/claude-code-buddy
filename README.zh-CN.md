<div align="center">

# 🧠 MeMesh Plugin

### Claude Code 的生产力插件

记忆、智能任务分析、工作流自动化 — 一个插件搞定。

[![npm version](https://img.shields.io/npm/v/@pcircle/memesh)](https://www.npmjs.com/package/@pcircle/memesh)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![MCP](https://img.shields.io/badge/MCP-compatible-purple.svg)](https://modelcontextprotocol.io)

[安装](#安装) • [使用方法](#使用方法) • [故障排除](#故障排除)

[English](README.md) • [繁體中文](README.zh-TW.md) • **简体中文** • [日本語](README.ja.md) • [한국어](README.ko.md) • [Français](README.fr.md) • [Deutsch](README.de.md) • [Español](README.es.md) • [Tiếng Việt](README.vi.md) • [ภาษาไทย](README.th.md) • [Bahasa Indonesia](README.id.md)

</div>

---

## 为什么做这个项目

这个项目的起点很简单：我想帮助更多人 — 特别是刚接触编程的新手 — 更好地用 Claude Code 来 vibe coding。我发现当项目越来越大，很难记住跨 session 做过的所有决策。所以我（跟 Claude Code 一起）做了一个插件，帮你记住。

> **备注**：本项目原名「Claude Code Buddy」，为避免潜在商标问题已更名为 MeMesh Plugin。

## 它能做什么？

MeMesh Plugin 让 Claude Code 更聪明、更有生产力。不只是记忆 — 它是一整套工具：

**可搜索的项目记忆** — 工作时自动保存决策、模式和经验教训。用语义搜索，不只是关键字。问「我们之前怎么决定 auth 的？」就能马上得到答案。

**智能任务分析** — 当你说 `buddy-do "加上用户认证"`，MeMesh 会分析任务、从过去的工作中拉出相关上下文，在执行前给你一个完整的计划。

**工作流自动化** — MeMesh 在后台自动帮你：
- 开始新 session 时显示上次工作摘要
- 追踪你改了哪些文件、测试了哪些
- 在 commit 前提醒你做 code review
- 把任务分配到最合适的模型（搜索用快的、规划用强的）

**从错误中学习** — 记录错误和修复方式，避免重蹈覆辙。MeMesh 会建立一个什么有效、什么不行的知识库。

**跟 Claude 内建记忆有什么不同？**

Claude Code 已经有 auto memory 和 CLAUDE.md — 很适合存一般偏好和指令。MeMesh 在此基础上增加了项目级的**专用工具**：可用语义搜索的记忆、能拉取过去上下文的任务分析、以及让每个 session 都更有效率的自动化工作流。

简单来说：
- **CLAUDE.md** = 你写给 Claude 的使用手册
- **MeMesh** = 可搜索的笔记本 + 随项目成长而学习的智能助手

---

## 安装

**你需要**：[Claude Code](https://docs.anthropic.com/en/docs/claude-code) 和 Node.js 20+

```bash
npm install -g @pcircle/memesh
```

重启 Claude Code，完成。

**确认安装成功** — 在 Claude Code 中输入：

```
buddy-help
```

看到指令列表就代表安装成功。

<details>
<summary>从源码安装（给贡献者）</summary>

```bash
git clone https://github.com/PCIRCLE-AI/claude-code-buddy.git
cd claude-code-buddy
npm install && npm run build
```

</details>

---

## 使用方法

MeMesh 在 Claude Code 中增加 3 个指令：

| 指令 | 功能 |
|------|------|
| `buddy-do "任务"` | 带着记忆上下文执行任务 |
| `buddy-remember "主题"` | 搜索过去的决策和上下文 |
| `buddy-help` | 显示可用指令 |

**示例：**

```bash
buddy-do "解释这个 codebase"
buddy-do "加上用户认证"
buddy-remember "API 设计决策"
buddy-remember "为什么选 PostgreSQL"
```

所有数据都存在你的电脑上。决策保留 90 天，session 笔记保留 30 天。

---

## 支持环境

| 平台 | 状态 |
|------|------|
| **macOS** | ✅ 正常 |
| **Linux** | ✅ 正常 |
| **Windows** | ✅ 正常（建议 WSL2）|

**可搭配使用：**
- Claude Code CLI（终端）
- Claude Code VS Code 扩展
- Cursor（通过 MCP）
- 其他兼容 MCP 的编辑器

**Claude Desktop (Cowork)**：基本指令可用，记忆功能需使用 CLI 版本。详见 [Cowork 说明](docs/COWORK_SUPPORT.md)。

---

## 故障排除

**MeMesh 没出现？**

```bash
# 确认已安装
npm list -g @pcircle/memesh

# 确认 Node.js 版本（需要 20+）
node --version

# 重新设置
memesh setup
```

然后完全重启 Claude Code。

更多说明：[故障排除指南](docs/TROUBLESHOOTING.md)

---

## 了解更多

- **[快速开始](docs/GETTING_STARTED.md)** — 一步步安装教程
- **[使用指南](docs/USER_GUIDE.md)** — 完整使用示例
- **[指令参考](docs/COMMANDS.md)** — 所有可用指令
- **[架构说明](docs/ARCHITECTURE.md)** — 内部运作原理
- **[贡献指南](CONTRIBUTING.md)** — 想帮忙？从这里开始
- **[开发指南](docs/DEVELOPMENT.md)** — 给贡献者

---

## 许可证

MIT — 详见 [LICENSE](LICENSE)

---

<div align="center">

遇到问题？[提交 Issue](https://github.com/PCIRCLE-AI/claude-code-buddy/issues/new) — 我们会快速回应。

[提交 Bug](https://github.com/PCIRCLE-AI/claude-code-buddy/issues/new?labels=bug&template=bug_report.yml) • [功能请求](https://github.com/PCIRCLE-AI/claude-code-buddy/discussions)

</div>
