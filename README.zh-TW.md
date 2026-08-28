🌐 [English](README.md) | [繁體中文](README.zh-TW.md) | [Deutsch](README.de.md)

<p align="center">
  <h1 align="center">MeMesh</h1>
  <p align="center">
    <strong>給程式開發代理的共享記憶與耐久化本機協作層。</strong><br />
    一個 SQLite 檔案。不需要 Docker。不需要雲端。
  </p>
  <p align="center">
    <a href="https://www.npmjs.com/package/@pcircle/memesh"><img src="https://img.shields.io/npm/v/@pcircle/memesh?style=flat-square&color=3b82f6&label=npm" alt="npm" /></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-22c55e?style=flat-square" alt="MIT" /></a>
    <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%3E%3D22-22c55e?style=flat-square" alt="Node" /></a>
    <a href="https://modelcontextprotocol.io"><img src="https://img.shields.io/badge/MCP-compatible-a855f7?style=flat-square" alt="MCP" /></a>
  </p>
</p>

---

**MeMesh** 是給 AI 程式開發代理用的**開源本機協作層**：讓 Claude Code、Codex、Cursor、自訂或 Ollama-backed agents 與相容的本機 MCP 用戶端共享記憶、交換耐久化單一收件人訊息，並把有價值的經驗轉成受治理的產品改善提案。全部存在一個 SQLite 檔案裡，不需要 Docker，也不需要雲端。

### 新的協作入口

- `message` 讓本機 agent 擁有可恢復 cursor、可明確記錄 receipt 的單一收件人耐久化 inbox，MCP、HTTP、CLI 三個 surface 都可用。
- `improvement` 讓 active memories 直接進入有證據連結的產品工作提案；agent 能發起與查狀態，但只有人類能接受或拒絕。

## 安裝

**在 Claude Code 裡** — 在對話框輸入這兩行（hooks、記憶工具和 `/memesh` skill 會自動接好）：

```
/plugin marketplace add PCIRCLE-AI/memesh
/plugin install memesh@pcircle-memesh
```

重開 Claude Code。下一個 session 開頭出現 `◉ MeMesh` 狀態列，就代表它在記了。

**在終端機裡** — `memesh` CLI、儀表板，以及給 Codex / Cursor 與相容本機 MCP 用戶端用的 `memesh-mcp` server（需要 [Node 22.13+](https://nodejs.org)）：

```bash
npm install -g @pcircle/memesh
memesh doctor        # 端到端驗證這份安裝
```

多數 Claude Code 使用者兩種都會裝。它們共用同一個資料庫，不會互相干擾。想知道細節、其他代理怎麼接、怎麼升級，看下面的「60 秒快速開始」。

## 問題所在

你的代理換一次對話就忘光，這還不是最糟的。最糟的是它會**把做過的事再做一次**：

- 重新提議你上個月否決掉的做法
- 再一次被同一個測試絆倒
- 重新「發現」三月那條弄壞 production 的限制
- 要你重講一遍當初它也有份設計的架構

這不是「聊天記錄沒存好」的問題。要留下來的不是對話，是*工作本身*——做過什麼決定、為什麼那樣決定、哪裡失敗過、後來怎麼修的，以及這些事情之間的關係。

**MeMesh 補的就是這一塊。** 它做三件事：

- **自動記下來**：hooks 從代理真正做過的事情擷取——session、commit、失敗，不用你手動寫筆記
- **在需要的時候送回去**：session 開始時、要改檔案之前，把相關記憶放進代理眼前
- **不讓記憶爛掉**：新的決定會取代舊的，兩筆記憶互相矛盾時由 LLM 判斷並標記出來

用 npm 裝，記憶放在 `~/.memesh/knowledge-graph.db`，接上 Claude Code 或任何支援 MCP 的用戶端就能用。

> [!IMPORTANT]
> **持續開發中的專案** — 功能會持續更新，版本之間可能會有變動。遇到問題或想要新功能，請[開 issue](https://github.com/PCIRCLE-AI/memesh/issues)。

---

## Local Agent Collaboration，要說真話

MeMesh 有一個很強的跨代理優勢：凡是連到同一個本機 MeMesh instance 的 host，都能共享持久化記憶；`message` tool 則提供 MCP、HTTP 與 CLI 共用的明確單一收件人訊息路徑。

可選的安全 host-native 喚醒 runtime 目前支援 macOS 與 Linux。Windows 仍可使用 MeMesh 核心記憶、耐久化 message storage 與 MCP tools；Windows host-native 喚醒目前尚未支援。

- 今天就能做的：MCP、HTTP 或 CLI sender 可把訊息耐久化送給一個指定的本機 recipient。接收端可另行擷取 payload、在重啟後用 opaque cursor 補收，並把 intake、acknowledgement、workflow disposition 與 host activation 分開記錄。
- 啟用 MeMesh Codex plugin 並完成 owner-private 的 `memesh agent setup codex-session` opt-in 後，位於**確切設定本機 workspace** 的活動中 Codex session 可在沒有輪詢或人工提醒下收到原生 `memesh_message_available` 喚醒。marker 只含 routing metadata；Codex 接著以 scope 相符的 `message` tool 擷取耐久化 payload。
- 成功的 queue admission（`host_accept`）只代表本機 Codex queue 接受了 marker；它不代表 agent 已讀 payload、已確認收到，或接受了工作。
- Durable message storage 由 owner policy 控制，不會偷偷刪除未解決訊息：`memesh message storage report` 會顯示 logical payload、protected rows、可重用 SQLite pages 與 WAL 大小；bounded prune 預設只 dry-run，且只 tombstone 舊的 terminal payload。可選的 `MEMESH_AGENT_MESSAGE_STORAGE_QUOTA_BYTES` 會在交易內原子拒絕超額 send。詳見 [bounded storage and audit retention](docs/platforms/agent-messaging.md#bounded-storage-and-audit-retention)。
- 已停止、缺失或斷線的 Codex session 不會被喚醒或取代。它的耐久化 inbox 仍可供稽核與復原；`poll` 與 `memesh message watch` 是相容與診斷路徑。原生傳遞不會自動恢復已停止的模型 session、不會執行 payload，也不代表已確認收到。
- 協作式信任邊界：recipient 名稱只是邏輯 routing ID，不是每個 agent 各自登入的身分或 ACL。能存取同一本機 MeMesh instance 的 caller 都必須視為受信任的 workspace participant；host adapter 仍需自行落實權限與人工核准規則。
- Adapter 邊界：這裡的原生喚醒只指已設定的本機 Codex-session 路徑。其他本機 MCP loop 可使用自己 host loop 支援的耐久化 message 操作；這不是通用 host 支援宣告。

完整 lifecycle、現況邊界、支援矩陣和剩餘 adapter 工作，請看 [Local Agent Messaging Guide](docs/platforms/agent-messaging.md)。

### 把 agent 經驗轉成受審核的產品工作

`improvement` tool 能把仍有效的記憶與教訓轉成有證據連結的產品改善提案，不再讓有價值的 feedback 只停在 inbox。Agent 可以提案與查狀態，但不能核准自己的建議；人類透過既有 review surface 接受或拒絕。接受後，MeMesh 會保留全部來源記憶、把工作項目連回證據，並讓它出現在後續 project briefing。這讓學習真正進入產品流程，同時避免 agent 建議在沒有人工授權下直接變成產品政策。

---

## 安裝路徑一覽

MeMesh 有**兩條會共存的安裝路徑**。多數使用者兩條都需要。它們寫入**同一份記憶資料庫**（`~/.memesh/knowledge-graph.db`），所以 Claude Code 對話裡記下的東西在 terminal 也看得到，反之亦然。

```mermaid
flowchart TB
    classDef client fill:#1f2937,stroke:#4b5563,color:#f9fafb,stroke-width:1px
    classDef pathA  fill:#1e3a8a,stroke:#3b82f6,color:#eff6ff,stroke-width:2px
    classDef pathB  fill:#14532d,stroke:#22c55e,color:#f0fdf4,stroke-width:2px
    classDef db     fill:#7c2d12,stroke:#f97316,color:#fff7ed,stroke-width:2px

    subgraph clients["Where you use memesh from"]
      direction LR
      CC["Claude Code<br/>(chat + agent)"]:::client
      TERM["Terminal / other<br/>MCP clients<br/>(Codex, Cursor...)"]:::client
    end

    subgraph paths["Two install paths"]
      direction LR
      A["<b>Path A — /plugin install</b><br/>───────────────<br/>Lives in <code>~/.claude/plugins/</code><br/><br/>• MCP tools in chat<br/>• Auto-capture hooks<br/>• <code>/memesh</code> skill<br/>• Session-start banner"]:::pathA
      B["<b>Path B — npm install -g</b><br/>───────────────<br/>Lives in <code>$(npm prefix -g)/bin/</code><br/><br/>• <code>memesh</code> shell command<br/>• <code>memesh-mcp</code>, <code>-http</code> bins<br/>• For Cursor / Cline / other MCP"]:::pathB
    end

    DB[("Shared memory DB<br/><code>~/.memesh/knowledge-graph.db</code><br/>Same data, both paths see it")]:::db

    CC -->|uses| A
    TERM -->|uses| B
    A --> DB
    B --> DB
```

**你需要哪一條？**

| 你想做什麼 | 安裝路徑 |
|---|---|
| 在 Claude Code 對話裡用 `/memesh` skill | Path A（plugin）|
| 在 Claude Code 自動 capture（session → 教訓 → 下次 recall）| Path A（plugin）|
| 在任何 terminal 跑 `memesh remember` / `memesh recall` / `memesh doctor` | Path B（npm-global）|
| 用 `memesh serve` 直接開 dashboard（沒有 `npx` 啟動延遲）| Path B（npm-global）|
| 把 `memesh-mcp` 接到 Cursor、Cline 或其他 MCP client | Path B（npm-global）|
| 以上都要 | **兩條都裝** — 不會衝突 |

> **常見誤會（小心踩雷）**：Claude Code 的 plugin **不會** 把 `memesh` 放到你的 shell `PATH` 上。如果你只跑 `/plugin install`，然後在 terminal 打 `memesh reindex`，你會看到 `command not found`。這是正常的 — 還要加 `npm install -g @pcircle/memesh` 才有 shell 指令。

### ⚠️ 裝 plugin 不會裝 CLI

這個是最常見的踩坑點，讀一次省下未來的循環：

- 從 Claude Code 跑 `/plugin install memesh@pcircle-memesh` → 只裝 **Path A**。給你 MCP 工具、hooks、`/memesh` skill。**不會**把 `memesh` 放到你的 shell `PATH`。
- 在 terminal 打 `memesh reindex` / `memesh update` / `memesh doctor` → 需要 **Path B**（npm-global）。沒裝就會 `zsh: command not found: memesh`。
- **Claude Code 使用者建議的安裝方式**：**兩條都裝**。共存、共用同一份資料庫、不衝突。

```bash
# 跑完 /plugin install ... 之後，再跑這個：
npm install -g @pcircle/memesh
```

如果你只透過 Claude Code 對話用 memesh（從不在 terminal 打 `memesh`），Path A 自己就夠了。其他人請兩條都裝。

---

## 60 秒快速開始

### 選項 A — Claude Code 外掛（一行安裝）

如果你使用 Claude Code，從 CLI 內把 MeMesh 當外掛安裝：

```
/plugin marketplace add PCIRCLE-AI/memesh
/plugin install memesh@pcircle-memesh
```

Claude Code 會自動接好 hooks、skills 和 MCP server。你會獲得對話內自動擷取、主動回憶、可在 Claude Code 對話中使用的 `/memesh` skill（remember / recall / learn / forget），以及代理可呼叫的 `remember` / `recall` / `forget` / `learn` MCP 工具。

**驗證方式：**重開 Claude Code、開任何 session。開頭出現像 `◉ MeMesh ready · no memories for "your-project" yet` 的狀態列 — 那一行就是外掛在運作的證明，不需要另外跑指令。（有記憶之後會改顯示數量。）CLI 與本地儀表板無需任何額外的全域安裝就能完整使用 — `npx @pcircle/memesh <command>` 可執行所有 CLI 指令，`npx @pcircle/memesh` 可在 `localhost:3737` 啟動儀表板。MCP server 直接從外掛內建的編譯產物啟動 — 不需要 `npx` 查找、不需要 `npm install -g`、不需要本地建置步驟。memesh 透過 Node 內建的 `node:sqlite`（22.13+）存放資料，所以升級 Node 不會留下一個為錯誤 runtime 編譯的二進位檔。

### 選項 B — npm 全域安裝（可選最佳化）

如果你希望二進位執行檔直接放在 shell `PATH` 上（讓 `memesh`、`memesh-mcp` 等指令能在任何終端機直接執行，省去每次呼叫的 `npx` 查找），或想將 `memesh-mcp` 以固定路徑的 stdio 指令暴露給**非 Claude Code 的 MCP 用戶端**（Cursor、Cline、純終端機流程）：

```bash
npm install -g @pcircle/memesh
```

> **首次安裝注意事項（一次性）：**
> - **不需要編譯器** — 資料庫引擎就是 Node 自己的 `node:sqlite`。負責「用意思搜尋」的 `sqlite-vec` 以預先編譯好的檔案形式提供 macOS（arm64/x64）、Linux（x64/arm64）和 Windows x64；在其他平台它就是不存在，回憶維持關鍵字搜尋。這裡沒有任何東西會執行安裝腳本，所以 `npm install --ignore-scripts` 也能裝出完全可用的 memesh。
> - **語意搜尋是選用的** — 預設的檢索路徑是關鍵字搜尋（FTS5），不需要模型也不需要下載。以語意（意義）為基礎的搜尋需要一個 embedder：在本地執行 [Ollama](https://ollama.com)，或設定一個雲端 embedder（見下方「嵌入」）。沒有設定時，memesh 只使用關鍵字搜尋。

### 第一步半：把 MeMesh 接進 Claude Code（僅 npm 路徑需要）

如果你透過**選項 A**（`/plugin install memesh@pcircle-memesh`）安裝，請略過此步驟 — Claude Code 會自動接好外掛 hooks。

如果你透過**選項 B**（`npm install -g`）安裝，CLI 已在 PATH 上 — 但**還沒有任何東西接進 Claude Code**：npm 套件刻意不執行安裝腳本，把 MCP server 和 hooks 接進 Claude Code 的是外掛（選項 A）。npm 路徑自己能接的是 session hooks。沒有這些 hooks 還是可以手動使用 `memesh remember` / `recall`，但**自動擷取迴路**（session → 教訓 → 下次 session 主動回憶）就會靜默不動。

```bash
memesh setup                 # 檢查本機 host 接線並回報結果
```

或手動逐步：

```bash
memesh install-hooks         # 把 memesh hooks 加進 ~/.claude/settings.json
memesh setup --check         # 機器層級驗證：讀各主機自己的設定，什麼都不改
```

這些 hooks 會跟你既有的 `~/.claude/hooks/` 自訂 hooks 共存 — `install-hooks` 用追加方式寫入，從不覆寫你的東西。要移除：`memesh uninstall-hooks`。

### 從 Codex CLI、Cursor 與其他 MCP 用戶端使用同一份記憶

`memesh-mcp` 是標準的 stdio MCP server，任何支援 MCP 的主機都能用 — 不限 Claude Code。裝好選項 B（`memesh-mcp` 在 `PATH` 上）之後，每個主機註冊一次：

```bash
# OpenAI Codex CLI — 會把 [mcp_servers.memesh] 寫進 ~/.codex/config.toml
codex mcp add memesh -- memesh-mcp

```

Cursor 請將同一個 stdio server 加入 `~/.cursor/mcp.json`（全域），或專案內的 `.cursor/mcp.json`：

```json
{
  "mcpServers": {
    "memesh": { "command": "memesh-mcp" }
  }
}
```

每個已設定的本機 host 讀寫的都是同一個 `~/.memesh/knowledge-graph.db`，所以在任何代理儲存的記憶，Codex、Cursor 和其他 MCP 用戶端都能回憶得到。請從主機要求它呼叫 `recall` 工具驗證：

```bash
codex mcp list       # memesh 應顯示為 enabled
```

> **設定的指令要用 `memesh-mcp`，不要用 `npx -p @pcircle/memesh`。**當主機的工作目錄在這個 repo 的 checkout 裡時，`npx -p` 會解析到*本地*套件，靜默執行工作樹當下的狀態而不是安裝好的正式版。

### 原生整合：Hermes Agent

**Hermes Agent** (NousResearch) 有一套第一方 `MemoryProvider` 外掛系統 — MeMesh 整合的層級與 Hermes 自己內建的記憶後端（honcho、mem0、hindsight）相同，不是 HTTP 橋接。與 MCP 模式手動呼叫工具不同，Hermes 的 provider 系統在每一輪自動執行 `recall`/`remember`。

整合將 Hermes 的 `prefetch()` 和 `sync_turn()` hooks 直接對應到 MeMesh 的 HTTP API。完整指南包含 provider 程式結構、設定，以及來自真實部署的四個陷阱：**[docs/platforms/hermes-agent.md](docs/platforms/hermes-agent.md)**

### 原生整合：OpenClaw

**OpenClaw** 有一套第一方記憶能力外掛系統 — MeMesh 整合的層級與 OpenClaw 自己內建的後端（LanceDB）相同，不是 HTTP 橋接。外掛透過 `api.registerMemoryCapability()` 註冊，並提供 `memory_recall`/`memory_store`/`memory_forget` 工具，以及在 `before_prompt_build` hook 上自動 recall。

**與 Hermes 的關鍵差異**：OpenClaw 的自動擷取有門檻控制（觸發時每輪最多 3 筆記憶），而非每一輪都擷取。整合對應到 MeMesh 的 HTTP API（`/v1/recall`、`/v1/remember`、`/v1/forget`）。完整 TypeScript 外掛合約、設定形狀與陷阱：**[docs/platforms/openclaw.md](docs/platforms/openclaw.md)**

### 第二步：保存一個決策

> 下方的 bash 範例假設 `memesh` 已在 `PATH` 上（選項 B）。選項 A（純外掛）使用者有兩條等價路徑：在 Claude Code 對話中發問（`/memesh` skill 與 MCP 工具涵蓋同樣的流程），或將任何 shell 中的 `memesh` 替換為 `npx @pcircle/memesh` — 旗標相同，不需要全域安裝。

```bash
memesh remember "Use OAuth 2.0 with PKCE for the new auth"
```

或使用顯式形式，當你想要穩定的名稱與類型以便日後篩選：

```bash
memesh remember --name "auth-decision" --type "decision" --obs "Use OAuth 2.0 with PKCE"
```

### 第三步：稍後回憶它

```bash
memesh recall "login security"
# → 找到 "OAuth 2.0 with PKCE" 即使你搜尋的是不同的詞彙
```

**完成。** MeMesh 現在已經在跨對話記憶和回憶。

如果你想驗證安裝和本地連線的整個流程：

```bash
memesh doctor
```

開啟儀表板來探索你的記憶：

```bash
memesh serve
```

<p align="center">
  <img src="docs/images/dashboard-search.png" alt="MeMesh — 瞬間找到任何記憶" width="100%" />
</p>

<p align="center">
  <img src="docs/images/dashboard-analytics.png" alt="MeMesh 分析面板 — 健康分數、時間線、模式、知識涵蓋範圍" width="100%" />
</p>

<p align="center">
  <img src="docs/images/dashboard-graph.png" alt="MeMesh 圖表 — 互動式知識圖，具有類型篩選和自我中心模式" width="100%" />
</p>

### 看看它幫你記了什麼

任何時候一條指令，就能印出你的代理對目前專案知道什麼 — 工作做到哪、決策、教訓、近期活動（以參考資料的形式包好）：

```bash
memesh briefing
```

```text
Where "your-project" was left off (today):
- Goal: Ship the payment retry logic
- Next: Open the PR once CI is green

Decisions and direction for "your-project":
- [decision] Use FTS5 as the retrieval baseline
```

Claude Code 在 session 開始時自動收到的就是同一個區塊，其他 MCP 用戶端呼叫 `briefing` 工具也拿到同一份 — 代理一開場就有方向，不用重讀整個 repo，你也不用再重講上禮拜的事。儀表板（`memesh serve`）是完整的視覺化版本。

### 你的資料

- **就一個本機檔案。**所有東西都在 `~/.memesh/knowledge-graph.db` — SQLite、在你的硬碟上。沒有雲端帳號；除非你自己設定雲端 embedder 或 LLM，否則什麼都不會離開你的機器。
- **備份 = 複製那個檔案。**還原 = 複製回去。
- **隨時暫停擷取**：`export MEMESH_AUTO_CAPTURE=false`。
- **全部刪除**：移除 `~/.memesh/`。

---

## 誰應該用 MeMesh？

| 如果你是... | MeMesh 幫你... |
|---------------|---------------------|
| **使用 Claude Code 的開發者** | 在工作時自動回憶專案決策、檔案特定的經驗教訓和過去的失敗 |
| **程式開發代理進階使用者** | 在多個 MCP 相容工具間共享一層在地記憶 |
| **使用 Codex、Cursor、Claude Code 或其他 MCP 用戶端的個人** | 在不同代理與 session 之間使用同一層在地記憶 |
| **整合 AI 代理的開發者** | 透過 MCP、HTTP 或 CLI 添加在地記憶 |

---

## 專為程式開發代理設計

<table>
<tr>
<td width="33%" align="center">

**Claude Code / Desktop**
```bash
memesh-mcp
```
MCP 工具 + Claude Code hooks

</td>
<td width="33%" align="center">

**任何 HTTP 用戶端**
```bash
curl localhost:3737/v1/recall \
  -H "Content-Type: application/json" \
  -d '{"query":"auth"}'
```
`memesh serve`（REST API）

</td>
<td width="33%" align="center">

**任何 LLM（OpenAI 格式）**
```bash
memesh export-schema \
  --format openai
```
貼到任何 API 呼叫中

</td>
</tr>
</table>

---

## 為什麼選 MeMesh 而不是 OpenMemory、Cursor Memories、Mem0 或 Zep？

| | **MeMesh** | OpenMemory | Cursor Memories | Mem0 | Zep / Graphiti |
|---|---|---|---|---|---|
| **最佳用途** | 程式開發代理的在地記憶 | 本地／跨用戶端 MCP 記憶 | Cursor 原生專案記憶 | 受管應用／代理記憶 | 時間性知識圖 |
| **安裝方式** | `npm install -g @pcircle/memesh` | 本地應用／伺服器流程 | 內建於 Cursor | 雲端 API / SDK / MCP | 服務／框架設定 |
| **儲存位置** | 單一本地 SQLite 檔案 | 本地記憶堆疊 | Cursor 管理的規則／記憶 | 託管或自管堆疊 | 圖形資料庫 |
| **需要雲端** | 否 | 否（本地模式） | 取決於 Cursor 帳戶／設定 | 是（平台） | 通常是／自管 |
| **Claude Code hooks** | 一級支援 | MCP 工具 | 否 | MCP 工具 | 不特別針對 Claude Code |
| **儀表板** | 內建 | 內建 | Cursor 設定 | 平台儀表板 | 平台／圖表工具 |
| **取捨** | 簡潔的本地方案，不適合企業規模 | 更寬泛的本地應用足跡 | 綁定到 Cursor | 強大的受管平台，較少本地優先 | 強大的圖形模型，設定更複雜 |

**MeMesh 用立即可用的本地設定、可檢查的儲存和程式開發代理工作流 hooks 來交換企業級受管基礎設施。**

---

## 基準測試 — 95.60% R@5 on LongMemEval-S

MeMesh 的檢索引擎**只用 FTS5**（熱路徑上不使用 LLM、不使用嵌入），對照公開的 [LongMemEval-S](https://huggingface.co/datasets/xiaowu0162/longmemeval) 基準測試（500 題，MIT 授權）量測：

| 系統 | R@5 | 來源 |
|---|---|---|
| **MeMesh（Mode A，經由 `recallEnhanced()`）** | **95.60%** | [benchmarks/longmemeval/RESULTS.md](benchmarks/longmemeval/RESULTS.md) |
| MemPalace | 96.6% | 廠商自行回報 |
| Supermemory | ~82% | 廠商估計值 |
| Zep | 63.8% | LongMemEval 論文 |
| Mem0 | 49.0% | LongMemEval 論文 |

重現指令、資料集 SHA256、原始逐題結果與已知失敗分析全部都在 [`benchmarks/longmemeval/`](benchmarks/longmemeval/)。約 10 秒可重跑一次。

---

## Claude Code 自動進行的事情

你不需要手動記住所有事情。MeMesh 有 **8 個 hooks**，會在你工作時自動擷取與注入知識：

| 何時 | MeMesh 做什麼 |
|------|------------------|
| **每次 session 開始時** | 載入最相關的記憶 + 來自過去教訓的主動警告 |
| **編輯檔案前** | 回憶與檔案或專案相關的記憶，再讓 Claude 寫程式碼 |
| **當你要求記住** | 偵測「remember this」／「guardar en memesh」／「sauvegarder dans memesh」／「記下來」意圖（5 種語言）並提醒 Claude 使用 memesh |
| **每次 `git commit` 之後** | 記錄你的變更，包含 diff 統計 |
| **Claude 停止時** | 擷取已編輯的檔案、已修復的錯誤，並從失敗自動產生結構化教訓 |
| **上下文壓縮前** | 在知識被上下文限制丟掉之前先保存 |
| **危險指令與編輯前** | 觸發你接受過的教訓守衛——在記錄過的錯誤即將重演的那一刻發出警告 |
| **已 opt-in 的 Codex session 啟動或恢復時** | 註冊該確切活動 thread 以接收 metadata-only MeMesh 訊息喚醒；其他 workspace 與已停止 session 不會被附掛 |

> **隨時退出：** `export MEMESH_AUTO_CAPTURE=false`

---

## 設定

所有設定都透過環境變數。預設是純本地、零網路 — 你不需要設定任何東西就能取得可運作的系統。

| 變數 | 預設值 | 用途 |
|---|---|---|
| `MEMESH_DB_PATH` | `~/.memesh/knowledge-graph.db` | 覆寫 SQLite 資料庫位置。 |
| `MEMESH_AUTO_CAPTURE` | `true` | 完全停用自動擷取 hooks（`Stop`、`PreCompact`）。 |
| `MEMESH_AUTO_DETECT_LLM` | 未設定（自動偵測**開啟**） | 設為 `0` 讓 memesh 不使用它在 shell 環境中找到的 API 金鑰。預設情況下，如果設定了 `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `OLLAMA_HOST` 且你沒有在 `~/.memesh/config.json` 設定供應商，memesh 會用它來跑寫入側的 LLM 功能（整合、經驗提取、自動打標籤、dream）。嵌入不受影響 —— 除非你把 `embedder.provider` 明確設定為 `ollama` 或 `openai`，否則保持僅關鍵字（FTS5）。 |
| `MEMESH_AUTO_UPDATE` | `off` | 自動更新策略。`off`（預設）永不自動更新；`patch` 允許 `X.Y.Z → X.Y.Z+N`；`minor` 加上 `X.Y.Z → X.Y+1.0`；`major` 允許任何升級。允許時，分離的 `npm install -g` 會在 session 結束時（Stop hook）執行，避免阻塞你的工作 — 結果寫入 `~/.memesh/auto-update.log`。也可在 `~/.memesh/config.json` 中以 `autoUpdate` 設定（環境變數優先）。維護者的 deprecated 警示絕不會覆寫 `off`：請手動更新，或選擇允許該升級的 policy。 |
| `OPENAI_API_KEY` | 未設定 | 你的 OpenAI 金鑰。除非你設定 `MEMESH_AUTO_DETECT_LLM=0` 或明確設定供應商，否則會自動用於 LLM 功能。 |
| `OLLAMA_HOST` | `http://localhost:11434` | 使用本地 Ollama 供應商時覆寫 Ollama 的端點。 |

`memesh doctor` 會印出已解析的設定，讓你看到目前實際生效的內容。

**備援 LLM 供應商（Smart Mode）。** 在 dashboard 的 **Settings → 「Fallback providers」** 可以設定一條有順序的備援鏈——當你的主要供應商掛掉時，memesh 會依序改用清單裡的下一個。可以加本機的 [Ollama](https://ollama.com) 備援，或雲端的（OpenAI / Anthropic，需要 API key）。隱私取捨：一旦用到雲端備援，記憶內容（可能是私密的）會被送到那個供應商，所以如果你為了隱私只跑本機，這點要留意。

當 npm 將已安裝版本標為 deprecated（通常是安全公告），下次 session-start 會在前面附上強警示橫幅 `⚠️ MeMesh <ver> is DEPRECATED`，`memesh update-status` 也會持續顯示同一行直到你升級為止。檢查結果會被快取於 `~/.memesh/update-check.<version>.json`，以避免短暫網路失敗讓警示變淡。

---

## 儀表板

5 個分頁、11 種語言、零外部相依性。伺服器執行時可在 `http://localhost:3737/dashboard` 存取。

| 分頁 | 你會看到 |
|-----|-------------|
| **Home** | memesh 為你做了什麼 — 以 dreamer 洞察開場：每週摘要和模式提案，一鍵接受／拒絕；完整的分析內容（記憶健康分數、30 天時間線、PM 速度 + KG 連通性、工作模式）收在可展開的區塊裡，需要時再打開 |
| **Memories** | 整座記憶庫集中在同一個介面 — 即時過濾，按 Enter 由伺服器排名搜尋（全文 + 向量）；範圍籤在工作層（目標／決策／教訓／計畫）、佐證、全部、已歸檔之間切換；叢集組成長條；每列可展開細節（教訓保留結構化的錯誤／根本原因／修復／預防檢視）；歸檔／復原直接在列上操作 |
| **Project** | 單一專案的歷史 — 透過專案選擇器檢視路線圖（階段、里程碑、關鍵教訓） |
| **Graph** | 互動式力導向知識圖，具有類型篩選、搜尋、自我中心模式、近期熱力圖 |
| **Settings** | LLM 供應商設定、即時語言選擇器 |

---

## 智慧功能

**🧠 智慧搜尋** — 搜尋「登入安全」並找到關於「OAuth PKCE」的記憶。MeMesh 用 FTS5 + sqlite-vec 在熱路徑上保持 LLM-free，仍能跨同義詞匹配。

**🌏 支援不用空格分詞的文字** — 中文、日文、韓文、泰文、寮文、高棉文和半形片假名都會拆成相鄰兩字一組來建索引，所以寫成「資料庫遷移前一定要先備份」的記憶，搜尋「備份」就找得到，不必打出一模一樣的全文。寫入和查詢兩邊都會做 NFC 正規化，因此在 macOS 上或用韓文、越南文輸入法打的記憶，兩種寫法都找得到。

**📊 評分排名** — 結果按相關性（30%）+ 近期性（25%）+ 頻率（18%）+ 信心（17%）+ 回憶影響（10%）排名。

**🔄 知識演進** — 決策會改變。`forget` 歸檔舊記憶（永不刪除）。`supersedes` 關係連結舊 → 新。你的 AI 總是看到最新版本。

**⚠️ 衝突偵測** — `memesh dream conflicts` 會讓 LLM 判定語意上最接近的記憶配對，找出矛盾、汰換或重複，並把結果暫存成提案。沒有東西會自動套用：你用 `dream list` / `dream show` 檢視，只有被接受的提案才會建立關係 —— 之後每次 `recall` 碰到其中任一筆記憶都會帶上警告。因果關係從不從時間戳推論；判決依據的是記憶內容本身怎麼說。

**🕸️ 知識圖連通性** — `memesh kg backfill-relations --all-rules` 使用標籤共現、專案叢集、會話上下文和名稱相似度連結孤立實體 — 無需 LLM。

**📦 個人備份與搬遷** — `memesh export > memesh-backup.json` → 複製到另一台機器 → `memesh import memesh-backup.json`
匯入的組合保持可搜尋，但 MeMesh 不會自動將匯入的記憶注入 host context，直到你檢查或在本地重新儲存。

---

## 使用範例

> 「MeMesh 記得我們三週前選擇了 PKCE 而不是隱式流程。當我再次問 Claude 關於身份驗證的問題時，它已經知道了——不需要重新解釋。」
> — **獨立開發者，正在打造 SaaS**

> 「我在 Claude Code 儲存的決策，隔天可以從 Codex 找回來。同一份在地記憶跟著工作走，不會被綁在單一代理上。」
> — **使用多個程式開發代理的個人開發者**

> 「儀表板顯示我 90% 的記憶是自動生成的對話日誌。我開始有意使用 `remember` 來記錄架構決策。改變了遊戲規則。」
> — **發現分析面板的開發者**

---

## 食譜

### 在矛盾咬你之前先抓到它

兩個決策，隔了好幾週做的，卻不可能同時為真 — 這正是記憶層存在的目的，就是要抓到這種失敗模式：

```bash
memesh remember --name retry-policy --type decision \
  --obs "所有 HTTP client 在請求失敗時都用指數退避重試，最多 5 次。"
# ...幾週後，有人做了完全相反的決定...
memesh remember --name retry-policy-v2 --type decision \
  --obs "HTTP client 絕對不能自動重試 — 立刻失敗並把錯誤丟出來。"

memesh dream conflicts        # 判定器標出這一對，附上判斷理由
memesh dream show 1           # 看完整的判決、引用的段落，接受後會建立什麼
memesh dream accept 1         # 由你決定 — 沒有東西會自動連起來
memesh recall "retry policy"  # → 警告：偵測到衝突
```

從此之後，任何回憶到這兩個決策之一的代理都會被告知它們互相矛盾 — 而不是自信地引用剛好先找到的那一個。

### 一份記憶，三個代理

MeMesh 是一個 MCP server，所以同一個 SQLite 檔案能服務機器上的每一個 MCP 用戶端。每個工具只要註冊一次（確切指令見上方「60 秒快速開始」），在 Claude Code 記錄的決策，session 進行到一半時就能被 Codex 或另一個已設定的本機 MCP client 回憶起來 — 不用重新解釋，不用在不同廠商之間複製貼上 context。

### 記錄決策讓它們保持可被找到

自動擷取會保留 session 歷史，但真正划算的是那些刻意記下的記憶：

```bash
memesh remember --name auth-approach --type decision \
  --obs "JWT 搭配 RS256；選 PKCE 而不是 implicit flow，因為 client 是公開的。" \
  --tags "project:myapp" "topic:auth"
```

事情發生時，用平常講話的方式把結果連回原因 — 從任何 MCP 用戶端都行，像是：「把這次事故記成一個教訓，受 auth-approach 影響」。`remember` 工具接受自由格式的關係，`caused`／`influenced` 是文件裡定義的因果詞彙（因 → 果，要明確說出來 — MeMesh 從不從時間戳推論因果關係）。幾週後，`memesh recall "為什麼選 PKCE"` 會回傳那個決策，連同它記錄下來的後續影響一起 — 是可以追溯的推理，不只是剛好比對到的文字。

---

## 解鎖智慧模式（可選）

MeMesh 預設離線運作 — 回憶嚴格保持 LLM-free（開箱即用就有 LongMemEval-S 上 95.60% R@5）。只有當你想要在上層加入 LLM 增強的分析流程時，才需要加入 LLM API 金鑰：更聰明的 session 擷取、新記憶的自動標籤、從失敗產生教訓，以及 `dream` 壓縮：

```bash
memesh config set llm.provider anthropic
memesh config set llm.api-key sk-ant-...
```

或使用儀表板 Settings 分頁（視覺化設定）：

```bash
memesh serve  # 開啟儀表板 → Settings 分頁
```

**把過去的對話挖成記憶。** `memesh dream run --from-transcripts` 會讀這個專案的 Claude Code 對話記錄，請 LLM 找出藏在對話裡的決策與教訓，再把它們暫存成提案——不會自動寫進你的知識圖譜。用 `memesh dream show <id>` 逐一檢視，挑值得留的 accept。

### 自帶嵌入(可選)

預設情況下 MeMesh 只做**關鍵字**召回(FTS5)—— 無需 API 金鑰,無需下載模型,資料不離開你的機器。語意(以意義為基礎的)搜尋是選用的,需要一個嵌入器。設定其中之一:

```bash
memesh config set embedder.provider openai          # or: ollama
```

嵌入器**獨立於對話 LLM** 設定 —— 更改 `llm.provider` 絕不會悄悄改變你的嵌入。每個 provider 自己固定模型與維度(`ollama` → nomic-embed-text 768 維、`openai` → text-embedding-3-small 1536 維);模型不另外提供選項,因為一個向量索引的維度是固定的,換第二個模型會把另一個嵌入空間的向量寫進同一個索引。

如果切換到不同維度(如 768 → 1536),**不會刪掉任何東西**。MeMesh 保留現有索引,並在開啟時提示你執行 `memesh reindex`:新索引會建在舊索引旁邊,等到每一筆記憶都有向量才切換過去 —— 所以重建中途被打斷不會損失任何東西,下次會從斷點繼續。這段期間語意搜尋是關閉的,召回只走關鍵字搜尋;`recall` 會回報 `degraded`,不會假裝搜過了。支援的 `embedder.provider` 取值:`ollama`(本地)、`openai`(託管)。兩者都不設定時,召回保持關鍵字搜尋。

| | 等級 0（預設） | 等級 1（智慧模式） |
|---|---|---|
| **搜尋** | FTS5 + sqlite-vec，95.60% R@5 | 不變 — 回憶在每個等級都保持 LLM-free |
| **自動擷取** | 基於規則的模式 | + LLM 擷取決策與教訓 |
| **自動標籤** | 僅手動標籤 | + LLM 為新記憶產生標籤 |
| **失敗分析** | 不可用 | + LLM 將 session 錯誤轉為結構化教訓 |
| **壓縮** | 不可用 | `dream` 壓縮冗長記憶 |
| **成本** | 免費，無需 API 金鑰 | 約 $0.0001 / 次分析呼叫（Haiku） |

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
| `briefing` | 組合好的工作拓撲——Claude Code 在 session 開始拿到的那個區塊，任何 MCP client 都拿得到 |
| `user_patterns` | 分析你的工作模式——時間表、工具、優勢、學習領域 |
| `improvement` | 將有證據來源的產品改善送交人類審核，或讀取其狀態；agent 不能自行接受或拒絕 |
| `message` | 在同一個本機 MeMesh instance 上耐久化送出、輪詢、擷取並明確記錄單一收件人訊息狀態 |

---

## 架構

```
                    ┌─────────────────┐
                    │   核心引擎      │
                    │    核心操作     │
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

核心與框架無關。同一邏輯從終端、HTTP 或 MCP 執行。

---

## 升級

Claude Code 的 plugin marketplace 在安裝時把版本釘住，**不會**自動更新。要拿到新版本：

**方法 A — `/plugin` 介面**：先 uninstall `memesh@pcircle-memesh`，再重新安裝。Claude Code 會抓 marketplace 最新版。

**方法 B — 一行指令**（不用點 UI、可重複執行；需要 npm CLI，`npm install -g @pcircle/memesh`）：

```bash
memesh upgrade-plugin
```

它會自己找到已安裝的 plugin 版本、確認前置工具都在，再幫你執行內建的升級腳本。前置工具：PATH 上要有 `node`、`npm`、`rsync`（macOS 內建 rsync；Debian/Ubuntu：`sudo apt install rsync`）。

只裝了 plugin、沒裝 npm CLI 的人，仍然可以手動執行腳本 — 把路徑裡的版本換成你安裝的版本：

```bash
bash ~/.claude/plugins/cache/pcircle-memesh/memesh/<current-version>/scripts/upgrade-plugin.sh

# v4.2.5 之前的安裝還沒內建這個腳本，改用 npm-global 的副本
# （參考上面「安裝路徑一覽」）：
bash "$(npm prefix -g)/lib/node_modules/@pcircle/memesh/scripts/upgrade-plugin.sh"
```

腳本會 fast-forward marketplace cache、把新版本放進 `~/.claude/plugins/cache/`、安裝 runtime deps，然後把 `installed_plugins.json` 重指向新版本。執行完請重啟 Claude Code 讓 MCP server 重連。

**npm-global 安裝**（`npm install -g @pcircle/memesh`）可以直接 `memesh update` 自動更新。Source checkouts：`git pull && npm install && npm run build`。

Session 開始時，有新版本可下載時會跳一行 banner（每版本每 24 小時節流一次），`memesh doctor` 會回報升級目標版本與對應指令。

---

## 貢獻

```bash
git clone https://github.com/PCIRCLE-AI/memesh
cd memesh && npm install && npm run build
npm test
npm run test:e2e-dashboard
```

儀表板：`cd dashboard && npm install && npm run dev`

---

<p align="center">
  <strong>MIT</strong> — 由 <a href="https://pcircle.com">PCIRCLE AI</a> 製作
</p>
