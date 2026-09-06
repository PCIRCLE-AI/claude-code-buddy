🌐 [English](README.md) | [繁體中文](README.zh-TW.md) | [Deutsch](README.de.md)

<p align="center">
  <h1 align="center">MeMesh</h1>
  <p align="center">
    <strong>讓 AI 寫程式助手記得住事情，換了對話也不會忘。</strong><br />
    一個 SQLite 檔案。不用 Docker，不用雲端。
  </p>
  <p align="center">
    <a href="https://www.npmjs.com/package/@pcircle/memesh"><img src="https://img.shields.io/npm/v/@pcircle/memesh?style=flat-square&color=3b82f6&label=npm" alt="npm" /></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-22c55e?style=flat-square" alt="MIT" /></a>
    <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%3E%3D22.13.0-22c55e?style=flat-square" alt="Node" /></a>
    <a href="https://modelcontextprotocol.io"><img src="https://img.shields.io/badge/MCP-compatible-a855f7?style=flat-square" alt="MCP" /></a>
  </p>
</p>

---

## 它能做什麼

每次開新對話，AI 寫程式助手（agent）都像失憶一樣：上個月你否決過的做法，它又提一次；同一個測試失敗，它又踩一次；連它自己參與設計的架構，都要你重新解釋。

MeMesh 幫它記住。你工作時，做過的決定、踩過的坑、上次做到哪都會記下來，再交還給 agent。Claude Code、Codex、Cursor 和其他 MCP 用戶端都能用。

```
   you work with the agent
            |
            v
   +------------------+      +------------------+
   |  capture         |      |  recall          |
   |  sessions,       | ---> |  at session      |
   |  commits, fixes  |      |  start and       |
   |  (automatic)     |      |  before edits    |
   +------------------+      +------------------+
            |                         ^
            v                         |
   +----------------------------------------+
   |  ~/.memesh/knowledge-graph.db           |
   |  decisions, lessons, links between them |
   +----------------------------------------+
```

左邊是自動記錄（對話、commit、修掉的錯誤），右邊是適時提醒（開新對話時、改檔案之前），中間是存放決定、教訓與關聯的那個檔案。

- **不用手動寫筆記。** 在 Claude Code 裡有 **9 個 hook** 在固定時機執行：開新對話、改檔案前、`git commit` 後、計畫核准或你回答問題後、Claude 停下來時、對話被壓縮前、你說「記下來」時（聽得懂 5 種語言）、會重犯你已接受的教訓的危險指令前，以及有加入的 Codex 對話啟動時。
- **所有工具共用一份記憶。** 今天在 Claude Code 存的決定，明天 Codex 或 Cursor 也用得到。
- **agent 之間可以留言。** 訊息存在你電腦上的收件匣，由收件方自己去取，重開過也一樣。
- **有儀表板** 可以瀏覽全部內容：5 個分頁、11 種語言，在 `http://localhost:3737/dashboard`。

---

## 支援哪些平台

| 平台 | 怎麼接 | 說明 |
|---|---|---|
| Claude Code | plugin：hook、MCP 工具、`/memesh` skill | 自動記錄與提醒都有 |
| Codex CLI、Gemini CLI | MCP server（`memesh-mcp`） | `codex mcp add memesh -- memesh-mcp`、`gemini mcp add -s user memesh memesh-mcp` |
| Cursor、Cline 與其他 MCP 用戶端 | MCP server（`memesh-mcp`） | 把用戶端指向 `memesh-mcp` |
| Hermes Agent | 原生記憶 plugin | [docs/platforms/hermes-agent.md](docs/platforms/hermes-agent.md) |
| OpenClaw | 原生記憶 plugin | 只有原始碼，尚未發佈：[docs/platforms/openclaw.md](docs/platforms/openclaw.md) |
| 你自己的程式或腳本 | `memesh serve` 提供的 HTTP API | [docs/platforms/universal.md](docs/platforms/universal.md) |
| ChatGPT、Gemini 網頁版等線上聊天 | 透過你自己架的本機橋接走 HTTP API | [docs/platforms/README.md](docs/platforms/README.md) |

自動記錄與提醒是 Claude Code 的 hook。其他用戶端要自己呼叫 `recall` 和 `briefing` 工具。

加分功能（自動貼標籤、從失敗整理教訓、檢查矛盾）可選接的 AI 模型：Anthropic、OpenAI，或本機的 Ollama。語意搜尋可選用 Ollama 或 OpenAI 的 embedding。這些都不接，記憶、回想和留言照樣用關鍵字搜尋跑。

---

## 怎麼安裝

安裝方式有兩種，用的是同一個資料庫。用 Claude Code 的人通常兩種都裝。

```
   Claude Code chat                Terminal, Codex, Cursor
         |                                  |
         v                                  v
   +-----------------+              +------------------+
   | A: plugin       |              | B: npm global    |
   | /plugin install |              | npm install -g   |
   | hooks + tools   |              | memesh CLI       |
   | + /memesh skill |              | + memesh-mcp     |
   +-----------------+              +------------------+
         |                                  |
         +---------------+------------------+
                         v
            ~/.memesh/knowledge-graph.db
               (one file, both paths)
```

**A. 在 Claude Code 裡裝**（hook、工具和 `/memesh` skill 會自動設定好）：

```
/plugin marketplace add PCIRCLE-AI/memesh
/plugin install memesh@pcircle-memesh
```

重開 Claude Code。下次對話開頭會出現 `◉ MeMesh`。

**B. 在終端機裝**（需要 [Node 22.13 以上](https://nodejs.org)）：

```bash
npm install -g @pcircle/memesh
memesh doctor          # 檢查整個安裝是否正常
memesh install-hooks   # 沒裝 A 才需要：幫 Claude Code 接上 hook，不動你原本的設定
```

Codex：`codex mcp add memesh -- memesh-mcp`。Cursor：把 `{ "mcpServers": { "memesh": { "command": "memesh-mcp" } } }` 加進 `~/.cursor/mcp.json`。

> **裝了 plugin 不等於有 `memesh` 指令。** `/plugin install` 之後，在終端機打 `memesh` 會出現 `command not found`，要再跑 `npm install -g @pcircle/memesh` 才會有。只在 Claude Code 對話裡用的話，裝 A 就夠了。

**更新：** plugin 用 `memesh upgrade-plugin`，npm 版用 `memesh update`。**想讓 AI 幫你裝？** 把 [llms-install.md](llms-install.md) 丟給它。

---

## 怎麼開始

```bash
memesh remember "登入功能用 OAuth 2.0 加 PKCE"
memesh recall "登入"
# -> 找到那筆 PKCE 的決定

memesh briefing        # agent 對這個專案知道多少、上次做到哪
memesh serve           # 打開儀表板
```

在 Claude Code 裡連終端機都不用開：在對話裡說「記下來」就好，每次開新對話也會自動先收到摘要。

有了記憶之後，兩件值得知道的事：

- `forget` 是把整筆記憶封存，不是刪掉。新的記憶可以蓋過舊的。
- `memesh dream conflicts`（需要接 AI 模型）會找出兩筆不可能同時成立的記憶。你確認之後，之後 `recall` 碰到其中任何一筆都會附上警告。

完整指令與工具說明：[docs/api/API_REFERENCE.md](docs/api/API_REFERENCE.md)。架構：[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。參與開發：[CONTRIBUTING.md](CONTRIBUTING.md)。

---

## 全部 11 個記憶與協作工具

| 工具 | 做什麼 |
|------|--------|
| `remember` | 用觀察、關係和標籤儲存知識 |
| `recall` | FTS5 + sqlite-vec 搜尋，包含多因素評分（相關性、近期性、頻率、信心、回憶影響）— 熱路徑上不使用 LLM |
| `forget` | 軟歸檔（永不刪除）或移除特定觀察 |
| `export` | 以 JSON 備份、搬遷記憶，或在相容代理之間轉移 |
| `import` | 匯入記憶，包含合併策略（跳過 / 覆寫 / 追加） |
| `learn` | 記錄來自錯誤的結構化教訓（錯誤、根本原因、修復、預防） |
| `task_state` | 讀取或記下工作進度——目標、下一步、卡住的地方、剛完成的事 |
| `briefing` | 提供給任何 MCP client 的工作拓撲；一般情境不顯示未讀訊息，確切的 `project` + `recipient` 才會顯示該收件者尚未擷取的訊息 |
| `user_patterns` | 分析你的工作模式——時間表、工具、優勢、學習領域 |
| `improvement` | 將有證據來源的產品改善送交人類審核，或讀取其狀態；agent 不能自行接受或拒絕 |
| `message` | 先找出活動 agent，再交換確切收件者的不受信任訊息。Durable JSON payload 上限 64 KiB；完整 native envelope 上限 16 KiB，並區分 `native_message_too_large` 與 `recipient_unavailable`。原生接受、探索、輪詢與擷取都不代表 ACK 或 workflow disposition |

---

## 細節

**評分排序** — 結果依相關性（30%）+ 近期性（25%）+ 頻率（18%）+ 信心（17%）+ 回想影響（10%）排序。

**agent 訊息的完整規則**（完整說明：[docs/platforms/agent-messaging.md](docs/platforms/agent-messaging.md)）：

- 今天就能做的：MCP、HTTP 或 CLI sender 可把一份 JSON 編碼後不超過 65,536 UTF-8 bytes（64 KiB）的不受信任 payload 耐久化送給一個指定的本機 recipient。接收端可另行擷取、在重啟後用 opaque cursor 補收，並把 intake、acknowledgement、workflow disposition 與 host activation 分開記錄。
- 啟用 MeMesh Codex plugin 並完成 owner-private 的 `memesh agent setup codex-session` opt-in 後，確切活動中的 Codex session 可在沒有輪詢或人工提醒下透過原生 queue 收到一則完整訊息，也不需要再次 fetch inbox。包含 routing metadata 與 payload 的完整 native envelope 另有 16,384 bytes（16 KiB）上限。exact-session send 只有在原生 queue 接受後才成功；完整 envelope 過大時回報 `native_message_too_large`，其他無法使用或拒絕的 session 則回報 `recipient_unavailable`。scope 相符的 recovery data 仍會保留，Principal target 在無法原生傳遞時仍保有 durable store-and-forward。
- 已停止、缺失或斷線的 Codex session 不會被喚醒，也不會被別的對話頂替。它的收件匣還是留著，`memesh message storage report` 可以看目前存了什麼。直接喚醒目前只支援 macOS 和 Linux。

---

<p align="center"><strong>MIT 授權</strong></p>
