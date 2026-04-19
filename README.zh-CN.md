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
  </p>
</p>

---

## 问题所在

你的 AI 在每次对话结束后都会忘记一切。每一个决策、每一次修复、每一个学到的教训——全部归零。你不断重新解释相同的背景，Claude 反复重新发现相同的模式，而你的 AI 知识库每次都从零开始。

**MeMesh 让每个 AI 都能拥有持久、可搜索、持续进化的记忆。**

---

## 60 秒快速上手

### 第一步：安装

```bash
npm install -g @pcircle/memesh
```

### 第二步：AI 开始记忆

```bash
memesh remember --name "auth-decision" --type "decision" --obs "Use OAuth 2.0 with PKCE"
```

### 第三步：AI 召回记忆

```bash
memesh recall "login security"
# → 搜索「login security」也能找到「OAuth 2.0 with PKCE」
```

**就这样。** MeMesh 已开始在不同对话之间记忆与召回。

运行以下命令探索你的记忆库：

```bash
memesh
```

<p align="center">
  <img src="docs/images/dashboard-search.png" alt="MeMesh Search — 瞬间找到任何记忆" width="100%" />
</p>

<p align="center">
  <img src="docs/images/dashboard-analytics.png" alt="MeMesh Analytics — 深入了解 AI 的知识" width="100%" />
</p>

<p align="center">
  <img src="docs/images/dashboard-graph.png" alt="MeMesh Graph — 交互式知识图谱，支持类型筛选与自我模式" width="100%" />
</p>

---

## 这是为谁设计的？

| 如果你是… | MeMesh 能帮你… |
|---------------|---------------------|
| **使用 Claude Code 的开发者** | 自动记忆决策、模式与每次对话中的心得 |
| **以 LLM 打造产品的团队** | 通过导出/导入共享团队知识，让每个人的 AI 上下文保持一致 |
| **AI Agent 开发者** | 通过 MCP、HTTP API 或 Python SDK 赋予 Agent 持久记忆 |
| **同时使用多款 AI 工具的重度用户** | 一个记忆层，兼容 Claude、GPT、LLaMA、Ollama 或任何 MCP 客户端 |

---

## 与所有工具兼容

<table>
<tr>
<td width="33%" align="center">

**Claude Code / Desktop**
```bash
memesh-mcp
```
MCP 协议（自动配置）

</td>
<td width="33%" align="center">

**Python / LangChain**
```python
from memesh import MeMesh
m = MeMesh()
m.recall("auth")
```
`pip install memesh`

</td>
<td width="33%" align="center">

**任何 LLM（OpenAI 格式）**
```bash
memesh export-schema \
  --format openai
```
粘贴到任何 API 调用

</td>
</tr>
</table>

---

## 为何不用 Mem0 / Zep？

| | **MeMesh** | Mem0 | Zep |
|---|---|---|---|
| **安装时间** | 5 秒 | 30–60 分钟 | 30+ 分钟 |
| **配置方式** | `npm i -g` — 完成 | Neo4j + VectorDB + API 密钥 | Neo4j + 配置 |
| **存储方式** | 单一 SQLite 文件 | Neo4j + Qdrant | Neo4j |
| **离线使用** | 支持，始终如此 | 不支持 | 不支持 |
| **仪表板** | 内置（7 个标签页 + 分析） | 无 | 无 |
| **依赖包** | 6 | 20+ | 10+ |
| **价格** | 永久免费 | 免费方案／付费 | 免费方案／付费 |

**MeMesh 的取舍：** 放弃企业级多租户功能，换来**即时安装、零基础设施、百分之百隐私**。

---

## 自动运作的功能

你不需要手动记忆每一件事。MeMesh 有 **4 个 Hook**，在你不做任何事的情况下自动捕获知识：

| 时机 | MeMesh 做了什么 |
|------|------------------|
| **每次会话开始** | 依评分算法加载最相关的记忆 |
| **每次 `git commit` 后** | 记录你的变更内容与差异统计 |
| **Claude 结束时** | 捕获已编辑的文件、已修复的错误及做出的决策 |
| **上下文压缩前** | 在知识因上下文限制消失前保存起来 |

> **随时退出：** `export MEMESH_AUTO_CAPTURE=false`

---

## 智能功能

**🧠 智能搜索** — 搜索「login security」就能找到关于「OAuth PKCE」的记忆。MeMesh 使用你配置的 LLM 将查询扩展为相关词汇。

**📊 评分排名** — 结果依相关性（35%）+ 最近使用时间（25%）+ 使用频率（20%）+ 可信度（15%）+ 信息时效性（5%）排序。

**🔄 知识演进** — 决策会改变。`forget` 是归档旧记忆（从不真正删除）。`supersedes` 关系将旧记忆与新记忆链接。你的 AI 始终看到最新版本。

**⚠️ 冲突检测** — 若有两条记忆相互矛盾，MeMesh 会发出警告。

**📦 团队共享** — `memesh export > team-knowledge.json` → 分享给团队 → `memesh import team-knowledge.json`

---

## 启用智能模式（可选）

MeMesh 默认完全离线运作。加入 LLM API 密钥即可解锁更聪明的搜索：

```bash
memesh config set llm.provider anthropic
memesh config set llm.api-key sk-ant-...
```

或使用仪表板的设置标签页（可视化配置）：

```bash
memesh  # 打开仪表板 → 设置标签页
```

| | 第 0 级（默认） | 第 1 级（智能模式） |
|---|---|---|
| **搜索** | FTS5 关键字匹配 | + LLM 查询扩展（约 97% 召回率） |
| **自动捕获** | 规则式模式 | + LLM 提取决策与心得 |
| **压缩** | 不支持 | `consolidate` 压缩冗长记忆 |
| **费用** | 免费，无需 API 密钥 | 约 $0.0001 每次搜索（Haiku） |

---

## 全部 6 个记忆工具

| 工具 | 功能说明 |
|------|-------------|
| `remember` | 存储知识，支持观察记录、关联关系与标签 |
| `recall` | 智能搜索，结合多因子评分与 LLM 查询扩展 |
| `forget` | 软归档（从不真正删除）或移除特定观察记录 |
| `consolidate` | LLM 驱动的冗长记忆压缩 |
| `export` | 将记忆以 JSON 格式分享给其他项目或团队成员 |
| `import` | 导入记忆，支持合并策略（跳过 / 覆盖 / 追加） |

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

核心引擎与框架无关。无论从终端、HTTP 还是 MCP 调用，逻辑完全相同。

---

## 贡献

```bash
git clone https://github.com/PCIRCLE-AI/memesh-llm-memory
cd memesh-llm-memory && npm install && npm run build
npm test -- --run    # 289 tests
```

仪表板：`cd dashboard && npm install && npm run dev`

---

<p align="center">
  <strong>MIT</strong> — 由 <a href="https://pcircle.ai">PCIRCLE AI</a> 开发
</p>
