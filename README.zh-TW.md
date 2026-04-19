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
  </p>
</p>

---

## 問題所在

你的 AI 在每次對話結束後都會忘記一切。每一個決策、每一次修復、每一個學到的教訓——全部歸零。你不斷重新解釋相同的背景，Claude 反覆重新發現相同的模式，而你的 AI 知識庫每次都從零開始。

**MeMesh 讓每個 AI 都能擁有持久、可搜尋、持續進化的記憶。**

---

## 60 秒快速上手

### 步驟一：安裝

```bash
npm install -g @pcircle/memesh
```

### 步驟二：AI 開始記憶

```bash
memesh remember --name "auth-decision" --type "decision" --obs "Use OAuth 2.0 with PKCE"
```

### 步驟三：AI 召回記憶

```bash
memesh recall "login security"
# → 搜尋「login security」也能找到「OAuth 2.0 with PKCE」
```

**就這樣。** MeMesh 已開始在不同對話之間記憶與召回。

執行以下指令探索你的記憶庫：

```bash
memesh
```

<p align="center">
  <img src="docs/images/dashboard-search.png" alt="MeMesh Search — 瞬間找到任何記憶" width="100%" />
</p>

<p align="center">
  <img src="docs/images/dashboard-analytics.png" alt="MeMesh Analytics — 深入了解 AI 的知識" width="100%" />
</p>

<p align="center">
  <img src="docs/images/dashboard-graph.png" alt="MeMesh Graph — 互動式知識圖譜，支援類型篩選與自我模式" width="100%" />
</p>

---

## 這是為誰設計的？

| 如果你是… | MeMesh 能幫你… |
|---------------|---------------------|
| **使用 Claude Code 的開發者** | 自動記憶決策、模式與每次對話中的心得 |
| **以 LLM 打造產品的團隊** | 透過匯出/匯入共享團隊知識，讓每個人的 AI 脈絡保持一致 |
| **AI Agent 開發者** | 透過 MCP、HTTP API 或 Python SDK 賦予 Agent 持久記憶 |
| **同時使用多款 AI 工具的重度用戶** | 一個記憶層，相容 Claude、GPT、LLaMA、Ollama 或任何 MCP 客戶端 |

---

## 與所有工具相容

<table>
<tr>
<td width="33%" align="center">

**Claude Code / Desktop**
```bash
memesh-mcp
```
MCP 協議（自動設定）

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
貼入任何 API 呼叫

</td>
</tr>
</table>

---

## 為何不用 Mem0 / Zep？

| | **MeMesh** | Mem0 | Zep |
|---|---|---|---|
| **安裝時間** | 5 秒 | 30–60 分鐘 | 30+ 分鐘 |
| **設定方式** | `npm i -g` — 完成 | Neo4j + VectorDB + API 金鑰 | Neo4j + 設定 |
| **儲存方式** | 單一 SQLite 檔案 | Neo4j + Qdrant | Neo4j |
| **離線使用** | 支援，始終如此 | 不支援 | 不支援 |
| **儀表板** | 內建（7 個頁籤 + 分析） | 無 | 無 |
| **依賴套件** | 6 | 20+ | 10+ |
| **價格** | 永久免費 | 免費方案／付費 | 免費方案／付費 |

**MeMesh 的取捨：** 放棄企業級多租戶功能，換來**即時安裝、零基礎設施、百分之百隱私**。

---

## 自動運作的功能

你不需要手動記憶每一件事。MeMesh 有 **4 個 Hook**，在你不做任何事的情況下自動擷取知識：

| 時機 | MeMesh 做了什麼 |
|------|------------------|
| **每次工作階段開始** | 依評分演算法載入最相關的記憶 |
| **每次 `git commit` 後** | 記錄你的變更內容與差異統計 |
| **Claude 結束時** | 擷取已編輯的檔案、已修復的錯誤及做出的決策 |
| **上下文壓縮前** | 在知識因上下文限制消失前儲存起來 |

> **隨時退出：** `export MEMESH_AUTO_CAPTURE=false`

---

## 智慧功能

**🧠 智慧搜尋** — 搜尋「login security」就能找到關於「OAuth PKCE」的記憶。MeMesh 使用你設定的 LLM 將查詢擴展為相關詞彙。

**📊 評分排名** — 結果依相關性（35%）+ 最近使用時間（25%）+ 使用頻率（20%）+ 可信度（15%）+ 資訊時效性（5%）排序。

**🔄 知識演進** — 決策會改變。`forget` 是封存舊記憶（從不真正刪除）。`supersedes` 關係將舊記憶與新記憶連結。你的 AI 始終看到最新版本。

**⚠️ 衝突偵測** — 若有兩條記憶相互矛盾，MeMesh 會發出警告。

**📦 團隊共享** — `memesh export > team-knowledge.json` → 分享給團隊 → `memesh import team-knowledge.json`

---

## 啟用智慧模式（選用）

MeMesh 預設完全離線運作。加入 LLM API 金鑰即可解鎖更聰明的搜尋：

```bash
memesh config set llm.provider anthropic
memesh config set llm.api-key sk-ant-...
```

或使用儀表板的設定頁籤（視覺化設定）：

```bash
memesh  # 開啟儀表板 → 設定頁籤
```

| | 第 0 級（預設） | 第 1 級（智慧模式） |
|---|---|---|
| **搜尋** | FTS5 關鍵字匹配 | + LLM 查詢擴展（約 97% 召回率） |
| **自動擷取** | 規則式模式 | + LLM 擷取決策與心得 |
| **壓縮** | 不支援 | `consolidate` 壓縮冗長記憶 |
| **費用** | 免費，無需 API 金鑰 | 約 $0.0001 每次搜尋（Haiku） |

---

## 全部 6 個記憶工具

| 工具 | 功能說明 |
|------|-------------|
| `remember` | 儲存知識，支援觀察記錄、關聯關係與標籤 |
| `recall` | 智慧搜尋，結合多因子評分與 LLM 查詢擴展 |
| `forget` | 軟封存（從不真正刪除）或移除特定觀察記錄 |
| `consolidate` | LLM 驅動的冗長記憶壓縮 |
| `export` | 將記憶以 JSON 格式分享給其他專案或團隊成員 |
| `import` | 匯入記憶，支援合併策略（跳過 / 覆寫 / 附加） |

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

核心引擎與框架無關。無論從終端機、HTTP 還是 MCP 呼叫，邏輯完全相同。

---

## 貢獻

```bash
git clone https://github.com/PCIRCLE-AI/memesh-llm-memory
cd memesh-llm-memory && npm install && npm run build
npm test -- --run    # 289 tests
```

儀表板：`cd dashboard && npm install && npm run dev`

---

<p align="center">
  <strong>MIT</strong> — 由 <a href="https://pcircle.ai">PCIRCLE AI</a> 開發
</p>
