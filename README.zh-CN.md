🌐 [English](README.md) | [繁體中文](README.zh-TW.md) | [简体中文](README.zh-CN.md) | [日本語](README.ja.md) | [한국어](README.ko.md) | [Português](README.pt.md) | [Français](README.fr.md) | [Deutsch](README.de.md) | [Tiếng Việt](README.vi.md) | [Español](README.es.md) | [ภาษาไทย](README.th.md)

<p align="center">
  <h1 align="center">MeMesh LLM Memory</h1>
  <p align="center">
    <strong>最轻量的通用 AI 记忆层。</strong><br />
    一个 SQLite 文件。任何 LLM。零云端依赖。
  </p>
  <p align="center">
    <a href="https://www.npmjs.com/package/@pcircle/memesh"><img src="https://img.shields.io/npm/v/@pcircle/memesh?style=flat-square&color=3b82f6&label=npm" alt="npm" /></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-22c55e?style=flat-square" alt="MIT" /></a>
    <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%3E%3D20-22c55e?style=flat-square" alt="Node" /></a>
    <a href="https://modelcontextprotocol.io"><img src="https://img.shields.io/badge/MCP-compatible-a855f7?style=flat-square" alt="MCP" /></a>
    <a href="https://pypi.org/project/memesh/"><img src="https://img.shields.io/badge/pip-memesh-3b82f6?style=flat-square" alt="PyPI" /></a>
  </p>
</p>

---

你的 AI 在每次对话结束后都会忘记一切。**MeMesh 解决了这个问题。**

安装一次，30 秒完成配置，你使用的每一个 AI 工具 — Claude、GPT、LLaMA，或任何 MCP 客户端 — 都能获得持久、可搜索、持续演进的记忆。无需云端。无需 Neo4j。无需向量数据库。只要一个 SQLite 文件。

```bash
npm install -g @pcircle/memesh
```

---

## 仪表板

<p align="center">
  <img src="docs/images/dashboard-search.png" alt="MeMesh Search" width="100%" />
</p>

<p align="center">
  <img src="docs/images/dashboard-analytics.png" alt="MeMesh Analytics" width="100%" />
</p>

<p align="center">
  <img src="docs/images/dashboard-browse.png" alt="MeMesh Browse" width="100%" />
</p>

运行 `memesh` 打开交互式仪表板，包含搜索、浏览、分析、管理和设置五个功能标签页。

---

## 快速开始

```bash
# 存储一条记忆
memesh remember --name "auth-decision" --type "decision" --obs "Use OAuth 2.0 with PKCE"

# 搜索记忆（智能模式下搜索"login security"也能找到"OAuth"）
memesh recall "login security"

# 归档过时的记忆（软删除，数据永不真正消失）
memesh forget --name "old-auth-design"

# 打开仪表板
memesh

# 启动 HTTP API（供 Python SDK 与第三方集成使用）
memesh serve
```

### Python

```python
from memesh import MeMesh

m = MeMesh()  # connects to localhost:3737
m.remember("auth", "decision", observations=["Use OAuth 2.0 with PKCE"])
results = m.recall("auth")
```

### 任何 LLM（OpenAI function calling 格式）

```bash
memesh export-schema --format openai
# → JSON array of tools, paste into your OpenAI/Claude/Gemini API call
```

---

## 为什么选择 MeMesh？

大多数 AI 记忆解决方案需要 Neo4j、向量数据库、API 密钥，以及超过 30 分钟的配置时间。MeMesh 只需要**一条命令**。

| | **MeMesh** | Mem0 | Zep | Anthropic Memory |
|---|---|---|---|---|
| **安装** | `npm i -g`（5 秒） | pip + Neo4j + VectorDB | pip + Neo4j | 内置（云端） |
| **存储** | 单一 SQLite 文件 | Neo4j + Qdrant | Neo4j | 云端 |
| **搜索** | FTS5 + 评分 + LLM 查询扩展 | 语义搜索 + BM25 | 时序图 | 关键字查找 |
| **隐私** | 100% 本地，始终如此 | 云端选项 | 自建 | 云端 |
| **依赖包** | 6 | 20+ | 10+ | 0（但锁定云端） |
| **离线使用** | 支持 | 不支持 | 不支持 | 不支持 |
| **仪表板** | 内置（5 个标签页） | 无 | 无 | 无 |
| **价格** | 免费 | 免费/付费 | 免费/付费 | 含于 API 套餐 |

---

## 功能特性

### 6 个记忆工具

| 工具 | 功能说明 |
|------|-------------|
| **remember** | 存储知识，支持观察记录、关联关系与标签 |
| **recall** | 智能搜索，结合多因子评分与 LLM 查询扩展 |
| **forget** | 软归档（数据永不真正删除）或移除特定观察记录 |
| **consolidate** | 利用 LLM 压缩冗长的记忆内容 |
| **export** | 将记忆以 JSON 格式分享给其他项目或团队成员 |
| **import** | 导入记忆，支持多种合并策略（跳过 / 覆盖 / 追加） |

### 3 种访问方式

| 方式 | 命令 | 最适合 |
|--------|---------|----------|
| **CLI** | `memesh` | 终端、脚本自动化、CI/CD |
| **HTTP API** | `memesh serve` | Python SDK、仪表板、第三方集成 |
| **MCP** | `memesh-mcp` | Claude Code、Claude Desktop、任何 MCP 客户端 |

### 4 个自动捕获 Hook

| Hook | 触发时机 | 捕获内容 |
|------|---------|-----------------|
| **Session Start** | 每次会话开始 | 按相关性加载你的顶部记忆 |
| **Post Commit** | `git commit` 之后 | 记录提交内容与差异统计 |
| **Session Summary** | Claude 结束时 | 编辑的文件、修复的错误、做出的决策 |
| **Pre-Compact** | 压缩前 | 在上下文消失前保存知识 |

### 智能功能

- **知识演进** — `forget` 是归档，不是删除。`supersedes` 关系以新决策取代旧决策，历史完整保留。
- **智能召回** — LLM 将你的搜索查询扩展为相关词汇。搜索"login security"即可找到"OAuth PKCE"。
- **多因子评分** — 结果依相关性（35%）、时效性（25%）、使用频率（20%）、可信度（15%）与时间有效性（5%）排序。
- **冲突检测** — 当记忆相互矛盾时发出警告。
- **自动衰减** — 超过 30 天未使用的陈旧记忆排名会逐渐降低，但永不删除。
- **命名空间** — `personal`、`team`、`global` 三种范围，方便组织与共享。

---

## 架构

```
                    ┌─────────────────┐
                    │   Core Engine   │
                    │  (6 operations) │
                    └────────┬────────┘
           ┌─────────────────┼─────────────────┐
           │                 │                 │
     CLI (memesh)    HTTP API (serve)    MCP (memesh-mcp)
           │                 │                 │
           └─────────────────┼─────────────────┘
                             │
                    SQLite + FTS5 + sqlite-vec
                    (~/.memesh/knowledge-graph.db)
```

**核心引擎**与框架无关 — 无论从终端、HTTP 还是 MCP 调用，`remember`/`recall`/`forget` 的逻辑完全相同。

**依赖包**：`better-sqlite3`、`sqlite-vec`、`@modelcontextprotocol/sdk`、`zod`、`express`、`commander`

---

## 开发

```bash
git clone https://github.com/PCIRCLE-AI/memesh-llm-memory
cd memesh-llm-memory
npm install
npm run build
npm test -- --run    # 289 tests
```

仪表板开发：
```bash
cd dashboard
npm install
npm run dev          # Vite dev server with hot reload
npm run build        # Build to single HTML file
```

---

## 许可证

MIT — [PCIRCLE AI](https://pcircle.ai)
