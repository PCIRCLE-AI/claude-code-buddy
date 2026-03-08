<div align="center">

<img src="https://img.shields.io/badge/%F0%9F%A7%A0-MeMesh-blueviolet?style=for-the-badge" alt="MeMesh" />

# MeMesh

### 你的 AI 编程会话值得拥有记忆。

MeMesh 为 Claude Code 提供持久的、可搜索的记忆 — 让每次会话都能承接上次的成果。

[![npm version](https://img.shields.io/npm/v/@pcircle/memesh?style=flat-square&color=cb3837)](https://www.npmjs.com/package/@pcircle/memesh)
[![Downloads](https://img.shields.io/npm/dm/@pcircle/memesh?style=flat-square&color=blue)](https://www.npmjs.com/package/@pcircle/memesh)
[![License](https://img.shields.io/badge/license-MIT-green?style=flat-square)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen?style=flat-square)](https://nodejs.org)
[![MCP](https://img.shields.io/badge/MCP-compatible-purple?style=flat-square)](https://modelcontextprotocol.io)

```bash
npm install -g @pcircle/memesh
```

[快速开始](#快速开始) · [运作原理](#运作原理) · [命令](#命令) · [文档](docs/USER_GUIDE.md)

[English](README.md) · [繁體中文](README.zh-TW.md) · **简体中文** · [日本語](README.ja.md) · [한국어](README.ko.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [Español](README.es.md) · [Tiếng Việt](README.vi.md) · [ภาษาไทย](README.th.md) · [Bahasa Indonesia](README.id.md)

</div>

> **注意**：本项目原名「Claude Code Buddy」，为避免潜在的商标问题已更名为 MeMesh Plugin。

---

## 问题所在

你正在用 Claude Code 深入开发一个项目。三个会话之前你做了重要决策 — 选了哪个认证库、为什么选择那个数据库架构、该遵循什么模式。但 Claude 不记得了。你不断重复自己说过的话。你失去了上下文。你浪费了时间。

**MeMesh 解决了这个问题。** 它为 Claude 提供一个持久的、可搜索的记忆，随着你的项目一起成长。

---

## 运作原理

<table>
<tr>
<td width="50%">

### 没有 MeMesh 之前
```
Session 1: "用 JWT 做认证"
Session 2: "我们当时为什么选 JWT 来着？"
Session 3: "等等，我们用的是什么认证库？"
```
你不断重复决策。Claude 忘记上下文。进度停滞。

</td>
<td width="50%">

### 有了 MeMesh 之后
```
Session 1: "用 JWT 做认证" → 已保存
Session 2: buddy-remember "auth" → 即时回忆
Session 3: 启动时自动加载上下文
```
每次会话都能从上次中断的地方继续。

</td>
</tr>
</table>

---

## 你能获得什么

**可搜索的项目记忆** — 问"我们之前怎么决定 auth 的？"就能得到即时的、语义匹配的答案。不是关键字搜索 — 是*语义*搜索，由本地 ONNX 嵌入驱动。

**智能任务分析** — `buddy-do "添加用户认证"` 不只是执行。它会从过去的会话中提取相关上下文，检查你已建立的模式，并在写任何一行代码之前制定完整的计划。

**主动回忆** — MeMesh 在你开始会话、遇到测试失败或出现错误时，自动浮现相关记忆。无需手动搜索。

**工作流自动化** — 启动时展示会话回顾。文件变更追踪。提交前的代码审查提醒。所有这些都在后台静默运行。

**错误学习** — 记录错误和修复方式，构建知识库。同样的错误不会再犯第二次。

---

## 快速开始

**前提条件**：[Claude Code](https://docs.anthropic.com/en/docs/claude-code) + Node.js 20+

```bash
npm install -g @pcircle/memesh
```

重启 Claude Code。搞定。

**验证** — 在 Claude Code 中输入：

```
buddy-help
```

你应该能看到可用命令列表。

<details>
<summary><strong>从源码安装</strong>（贡献者）</summary>

```bash
git clone https://github.com/PCIRCLE-AI/claude-code-buddy.git
cd claude-code-buddy
npm install && npm run build
```

</details>

---

## 命令

| 命令 | 功能 |
|---------|-------------|
| `buddy-do "任务"` | 带着完整记忆上下文执行任务 |
| `buddy-remember "主题"` | 搜索过去的决策和上下文 |
| `buddy-help` | 显示可用命令 |

**实际示例：**

```bash
# 快速了解一个陌生的代码库
buddy-do "explain this codebase"

# 带着过去工作的上下文构建功能
buddy-do "add user authentication"

# 回忆当初为什么做了那些决策
buddy-remember "API design decisions"
buddy-remember "why we chose PostgreSQL"
```

所有数据都保存在你的本机上。决策保留 90 天，会话笔记保留 30 天。

---

## 这和 CLAUDE.md 有什么不同？

| | CLAUDE.md | MeMesh |
|---|-----------|--------|
| **用途** | 给 Claude 的静态指令 | 随项目成长的活记忆 |
| **搜索** | 手动文本搜索 | 基于语义的意义搜索 |
| **更新** | 你手动编辑 | 工作时自动捕获决策 |
| **回忆** | 始终加载（可能变得很长） | 按需浮现相关上下文 |
| **范围** | 通用偏好设置 | 项目专属的知识图谱 |

**它们协同工作。** CLAUDE.md 告诉 Claude *怎么*工作。MeMesh 记住你*做了*什么。

---

## 平台支持

| 平台 | 状态 |
|----------|--------|
| macOS | ✅ |
| Linux | ✅ |
| Windows | ✅（建议使用 WSL2） |

**兼容：** Claude Code CLI · VS Code 扩展 · Cursor（通过 MCP） · 任何兼容 MCP 的编辑器

---

## 架构

MeMesh 作为本地 MCP 服务器与 Claude Code 一起运行：

- **知识图谱** — 基于 SQLite 的实体存储，支持 FTS5 全文搜索
- **向量嵌入** — ONNX 运行时实现语义相似度（100% 本地运行）
- **内容去重** — SHA-256 哈希跳过冗余的嵌入计算
- **批量处理** — 高效的批量操作，适用于大型知识库
- **Hook 系统** — 在会话开始、测试失败和错误发生时主动回忆

一切都在本地运行。无需云服务。无需 API 调用。你的数据永远不会离开你的机器。

---

## 文档

| 文档 | 说明 |
|-----|-------------|
| [快速开始](docs/GETTING_STARTED.md) | 分步设置指南 |
| [使用指南](docs/USER_GUIDE.md) | 完整使用指南与示例 |
| [命令参考](docs/COMMANDS.md) | 完整命令参考 |
| [架构说明](docs/ARCHITECTURE.md) | 技术深度解析 |
| [贡献指南](CONTRIBUTING.md) | 贡献指南 |
| [开发指南](docs/DEVELOPMENT.md) | 贡献者开发设置 |

---

## 贡献

欢迎贡献！请参阅 [CONTRIBUTING.md](CONTRIBUTING.md) 开始。

---

## 许可证

MIT — 详见 [LICENSE](LICENSE)

---

<div align="center">

**用 Claude Code 构建，为 Claude Code 而生。**

[报告 Bug](https://github.com/PCIRCLE-AI/claude-code-buddy/issues/new?labels=bug&template=bug_report.yml) · [功能请求](https://github.com/PCIRCLE-AI/claude-code-buddy/discussions) · [获取帮助](https://github.com/PCIRCLE-AI/claude-code-buddy/issues/new)

</div>
