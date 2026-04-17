🌐 [English](README.md) | [繁體中文](README.zh-TW.md) | [简体中文](README.zh-CN.md) | [日本語](README.ja.md) | [한국어](README.ko.md) | [Português](README.pt.md) | [Français](README.fr.md) | [Deutsch](README.de.md) | [Tiếng Việt](README.vi.md) | [Español](README.es.md) | [ภาษาไทย](README.th.md)

<p align="center">
  <h1 align="center">MeMesh LLM Memory</h1>
  <p align="center">
    <strong>最輕量的通用 AI 記憶層。</strong><br />
    一個 SQLite 檔案。任何 LLM。零雲端依賴。
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

你的 AI 在每次對話結束後都會忘記一切。**MeMesh 解決了這個問題。**

安裝一次，30 秒完成設定，你使用的每一個 AI 工具 — Claude、GPT、LLaMA，或任何 MCP 客戶端 — 都能獲得持久、可搜尋、持續進化的記憶。無需雲端。無需 Neo4j。無需向量資料庫。只要一個 SQLite 檔案。

```bash
npm install -g @pcircle/memesh
```

---

## 儀表板

<p align="center">
  <img src="docs/images/dashboard-search.png" alt="MeMesh Search" width="100%" />
</p>

<p align="center">
  <img src="docs/images/dashboard-analytics.png" alt="MeMesh Analytics" width="100%" />
</p>

<p align="center">
  <img src="docs/images/dashboard-browse.png" alt="MeMesh Browse" width="100%" />
</p>

執行 `memesh` 開啟互動式儀表板，包含搜尋、瀏覽、分析、管理與設定五大功能頁籤。

---

## 快速上手

```bash
# 儲存一條記憶
memesh remember --name "auth-decision" --type "decision" --obs "Use OAuth 2.0 with PKCE"

# 搜尋記憶（智慧模式下搜尋「login security」也能找到「OAuth」）
memesh recall "login security"

# 封存過時的記憶（軟刪除，資料永不真正消失）
memesh forget --name "old-auth-design"

# 開啟儀表板
memesh

# 啟動 HTTP API（供 Python SDK 與第三方整合使用）
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

## 為什麼選擇 MeMesh？

大多數 AI 記憶解決方案需要 Neo4j、向量資料庫、API 金鑰，以及超過 30 分鐘的設定時間。MeMesh 只需要**一條指令**。

| | **MeMesh** | Mem0 | Zep | Anthropic Memory |
|---|---|---|---|---|
| **安裝** | `npm i -g`（5 秒） | pip + Neo4j + VectorDB | pip + Neo4j | 內建（雲端） |
| **儲存** | 單一 SQLite 檔案 | Neo4j + Qdrant | Neo4j | 雲端 |
| **搜尋** | FTS5 + 評分 + LLM 查詢擴展 | 語意搜尋 + BM25 | 時序圖 | 關鍵字查找 |
| **隱私** | 100% 本地，始終如此 | 雲端選項 | 自架 | 雲端 |
| **依賴套件** | 6 | 20+ | 10+ | 0（但鎖定雲端） |
| **離線使用** | 支援 | 不支援 | 不支援 | 不支援 |
| **儀表板** | 內建（5 個頁籤） | 無 | 無 | 無 |
| **價格** | 免費 | 免費／付費 | 免費／付費 | 含於 API 方案 |

---

## 功能特色

### 6 個記憶工具

| 工具 | 功能說明 |
|------|-------------|
| **remember** | 儲存知識，支援觀察記錄、關聯關係與標籤 |
| **recall** | 智慧搜尋，結合多因子評分與 LLM 查詢擴展 |
| **forget** | 軟封存（資料永不真正刪除）或移除特定觀察記錄 |
| **consolidate** | 利用 LLM 壓縮冗長的記憶內容 |
| **export** | 將記憶以 JSON 格式分享給其他專案或團隊成員 |
| **import** | 匯入記憶，支援多種合併策略（跳過 / 覆寫 / 附加） |

### 3 種存取方式

| 方式 | 指令 | 最適合 |
|--------|---------|----------|
| **CLI** | `memesh` | 終端機、腳本自動化、CI/CD |
| **HTTP API** | `memesh serve` | Python SDK、儀表板、第三方整合 |
| **MCP** | `memesh-mcp` | Claude Code、Claude Desktop、任何 MCP 客戶端 |

### 4 個自動擷取 Hook

| Hook | 觸發時機 | 擷取內容 |
|------|---------|-----------------|
| **Session Start** | 每次工作階段開始 | 依相關性載入你的頂部記憶 |
| **Post Commit** | `git commit` 之後 | 記錄提交內容與差異統計 |
| **Session Summary** | Claude 結束時 | 編輯的檔案、修復的錯誤、做出的決策 |
| **Pre-Compact** | 壓縮前 | 在上下文消失前儲存知識 |

### 智慧功能

- **知識演進** — `forget` 是封存，不是刪除。`supersedes` 關係以新決策取代舊決策，歷史完整保留。
- **智慧召回** — LLM 將你的搜尋查詢擴展為相關詞彙。搜尋「login security」即可找到「OAuth PKCE」。
- **多因子評分** — 結果依相關性（35%）、時效性（25%）、使用頻率（20%）、可信度（15%）與時間有效性（5%）排序。
- **衝突偵測** — 當記憶互相矛盾時發出警告。
- **自動衰減** — 超過 30 天未使用的陳舊記憶排名會逐漸降低，但永不刪除。
- **命名空間** — `personal`、`team`、`global` 三種範圍，方便組織與共享。

---

## 架構

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

**核心引擎**與框架無關 — 無論從終端機、HTTP 還是 MCP 呼叫，`remember`/`recall`/`forget` 的邏輯完全相同。

**依賴套件**：`better-sqlite3`、`sqlite-vec`、`@modelcontextprotocol/sdk`、`zod`、`express`、`commander`

---

## 開發

```bash
git clone https://github.com/PCIRCLE-AI/memesh-llm-memory
cd memesh-llm-memory
npm install
npm run build
npm test -- --run    # 289 tests
```

儀表板開發：
```bash
cd dashboard
npm install
npm run dev          # Vite dev server with hot reload
npm run build        # Build to single HTML file
```

---

## 授權條款

MIT — [PCIRCLE AI](https://pcircle.ai)
