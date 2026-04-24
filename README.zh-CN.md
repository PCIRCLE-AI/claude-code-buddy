🌐 [English](README.md) | [繁體中文](README.zh-TW.md) | [简体中文](README.zh-CN.md) | [日本語](README.ja.md) | [한국어](README.ko.md) | [Português](README.pt.md) | [Français](README.fr.md) | [Deutsch](README.de.md) | [Tiếng Việt](README.vi.md) | [Español](README.es.md) | [ภาษาไทย](README.th.md)

<p align="center">
  <h1 align="center">MeMesh LLM Memory</h1>
  <p align="center">
    <strong>给 Claude Code 和 MCP coding agents 用的本地记忆层。</strong><br />
    一个 SQLite 文件。不需要 Docker。不需要云端。
  </p>
</p>

> 这份简体中文版 README 是精简导览。最新、最完整的内容请以 [English README](README.md) 为准。

## 它解决什么问题？

coding agent 很容易在不同 session 之间丢失上下文。架构决策、修 bug 的过程、踩过的坑、项目限制，常常要反复解释。

**MeMesh 把这些知识保存在本地，可搜索、可查看，也能在后续工作里再次被召回。**

这个 npm package 是 MeMesh 的本地 plugin / package 版本，重点是本地记忆，不是云端工作台，也不是企业平台。

## 60 秒上手

### 1. 安装

```bash
npm install -g @pcircle/memesh
```

### 2. 记下一条决策

```bash
memesh remember --name "auth-decision" --type "decision" --obs "Use OAuth 2.0 with PKCE"
```

### 3. 之后再找回来

```bash
memesh recall "login security"
# → 即使换种说法，也能找到 "OAuth 2.0 with PKCE"
```

打开 dashboard：

```bash
memesh
```

## 适合谁？

- 使用 Claude Code，希望跨 session 保留项目上下文的开发者
- 使用 MCP coding agents，希望共用同一份本地记忆的高级用户
- 小型 AI-native 开发团队，希望通过 export / import 共享项目知识
- 想把本地记忆接入 CLI、HTTP 或 MCP 工作流的 agent 开发者

## 为什么选 MeMesh？

- 本地优先：数据保存在你自己的 SQLite 文件里
- 安装轻量：`npm install -g` 后即可使用
- 接入直接：同时支持 CLI、HTTP、MCP
- 对 Claude Code 友好：提供 hooks，可在工作流里自动带入相关记忆
- 可查看可清理：内建 dashboard，不是黑盒
- 更安全的导入边界：导入的记忆默认可搜索，但不会直接自动注入到 Claude hooks，除非你重新审核或在本地重新保存

## 在 Claude Code 里会自动做什么？

MeMesh 目前会在 5 个时机帮你：

- session 开始时，加载项目相关记忆和已知教训
- 编辑文件前，先召回与该文件或项目相关的记忆
- `git commit` 后，记录你做了哪些改动
- session 结束时，整理本次修复、错误和 lesson learned
- context compact 之前，先把重要内容写回本地记忆

## Dashboard 里有什么？

Dashboard 目前有 7 个标签页，并支持 11 种语言：

- Search：搜索记忆
- Browse：浏览全部记忆
- Analytics：查看健康度、趋势和使用情况
- Graph：查看知识关系图
- Lessons：查看过往经验教训
- Manage：归档或恢复记忆
- Settings：设置 LLM provider 和语言

## Smart Mode 是什么？

MeMesh 默认就能离线使用。若你额外配置 LLM API key，可以启用更智能的能力，例如：

- query expansion
- 更好的自动提取
- 更智能的记忆整理与压缩

不配置也可以正常使用核心功能。

## 更多信息

- 完整功能、对比、API 和 release 细节：请看 [English README](README.md)
- 平台集成方式：请看 [docs/platforms/README.md](docs/platforms/README.md)
- API 参考：请看 [docs/api/API_REFERENCE.md](docs/api/API_REFERENCE.md)

## 开发与验证

```bash
git clone https://github.com/PCIRCLE-AI/memesh-llm-memory
cd memesh-llm-memory
npm install
npm run build
npm test
```
