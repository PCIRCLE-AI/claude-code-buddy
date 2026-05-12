🌐 [English](README.md) | [繁體中文](README.zh-TW.md) | [简体中文](README.zh-CN.md) | [日本語](README.ja.md) | [한국어](README.ko.md) | [Português](README.pt.md) | [Français](README.fr.md) | [Deutsch](README.de.md) | [Tiếng Việt](README.vi.md) | [Español](README.es.md) | [ภาษาไทย](README.th.md)

<p align="center">
  <h1 align="center">MeMesh LLM Memory</h1>
  <p align="center">
    <strong>給 Claude Code 和 MCP 程式開發代理的在地記憶系統。</strong><br />
    一個 SQLite 檔案。不需要 Docker。不需要雲端。
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

你的程式開發代理在每次對話之間就會忘記一切。每個架構決策、每個修復的臭蟲、每個失敗的測試、每個代價不菲的教訓，都得重新跟它解釋一遍。Claude Code 每次都從零開始，重新發現舊的限制條件，浪費寶貴的上下文在它本應已知的事情上。

**MeMesh 讓程式開發代理擁有持久、可搜尋、不斷演進的在地記憶。**

這個套件是 MeMesh 產品系列的在地記憶層。我們刻意保持它的精簡和開源：用 npm 安裝，把記憶保存在 `~/.memesh/knowledge-graph.db`，然後連接到 Claude Code 或任何支援 MCP 的用戶端。託管工作區和企業級作業系統產品應該與這個套件的 README 和路線圖分開。

---

## 實證 — 在 LongMemEval-S 上 R@5 達 95.40%

MeMesh 的檢索引擎**只用 FTS5**（熱路徑上不使用 LLM、不使用嵌入），對照公開的 [LongMemEval-S](https://huggingface.co/datasets/xiaowu0162/longmemeval) 基準測試（500 題，MIT 授權）量測：

| 系統 | R@5 | 來源 |
|---|---|---|
| **MeMesh（Mode A，FTS5）** | **95.40%** | [benchmarks/longmemeval/RESULTS.md](benchmarks/longmemeval/RESULTS.md) |
| MemPalace | 96.6% | 廠商自行回報 |
| Supermemory | ~82% | 廠商估計值 |
| Zep | 63.8% | LongMemEval 論文 |
| Mem0 | 49.0% | LongMemEval 論文 |

重現指令、資料集 SHA256、原始逐題結果與已知失敗分析全部都在 [`benchmarks/longmemeval/`](benchmarks/longmemeval/)。約 10 秒可重跑一次。

---

## 60 秒快速開始

### 選項 A — Claude Code 外掛（一行安裝）

如果你使用 Claude Code，從 CLI 內把 MeMesh 當外掛安裝：

```
/plugin marketplace add PCIRCLE-AI/memesh-llm-memory
/plugin install memesh@pcircle-memesh
```

Claude Code 會自動接好 hooks、skills 和 MCP server。你會獲得對話內自動擷取、主動回憶、可在 Claude Code 對話中使用的 `/memesh` skill（remember / recall / learn / forget），以及代理可呼叫的 `remember` / `recall` / `forget` / `learn` MCP 工具。CLI 與本地儀表板無需任何額外的全域安裝就能完整使用 — `npx @pcircle/memesh <command>` 可執行所有 CLI 指令，`npx @pcircle/memesh` 可在 `localhost:3737` 啟動儀表板。MCP server 直接從外掛內建的編譯產物啟動 — 不需要 `npx` 查找、不需要 `npm install -g`、不需要本地建置步驟。如果 `better-sqlite3` 原生 binding 在第一次啟動時缺少（例如 Node 主版本升級後），啟動器會在程序內自動重新編譯後繼續執行。

### 選項 B — npm 全域安裝（可選最佳化）

如果你希望二進位執行檔直接放在 shell `PATH` 上（讓 `memesh`、`memesh-mcp` 等指令能在任何終端機直接執行，省去每次呼叫的 `npx` 查找），或想將 `memesh-mcp` 以固定路徑的 stdio 指令暴露給**非 Claude Code 的 MCP 用戶端**（Cursor、Cline、純終端機流程）：

```bash
npm install -g @pcircle/memesh
```

> **首次安裝注意事項（一次性）：**
> - **原生模組** — `better-sqlite3` 與 `sqlite-vec` 在 macOS（arm64/x64）、Linux（x64/arm64）和 Windows x64 上會以預先編譯的二進位安裝。在較少見的平台或預編譯失敗時，你需要可運作的 C/C++ 工具鏈。
> - **嵌入模型** — 第一次觸發本地嵌入的呼叫（例如 semantic 模式的 `recall`）會把 `Xenova/all-MiniLM-L6-v2`（約 80 MB）下載到 `~/.memesh/models/`。後續呼叫即時生效。預設的檢索路徑（FTS5）不需要這個下載。

### 第一步半：把 MeMesh 接進 Claude Code（僅 npm 路徑需要）

如果你透過**選項 A**（`/plugin install memesh@pcircle-memesh`）安裝，請略過此步驟 — Claude Code 會自動接好外掛 hooks。

如果你透過**選項 B**（`npm install -g`）安裝，CLI 已在 PATH 上、MCP server 也已註冊，但 Claude Code session hooks 並未自動接上。沒有這些 hooks 還是可以手動使用 `memesh remember` / `recall`，但**自動擷取迴路**（session → 教訓 → 下次 session 主動回憶）就會靜默不動。

```bash
memesh install-hooks         # 把 memesh hooks 加進 ~/.claude/settings.json
memesh doctor                # 確認「Hooks wired into Claude Code」過了
```

這些 hooks 會跟你既有的 `~/.claude/hooks/` 自訂 hooks 共存 — `install-hooks` 用追加方式寫入，從不覆寫你的東西。要移除：`memesh uninstall-hooks`。

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
memesh
```

<p align="center">
  <img src="docs/images/dashboard-search.png" alt="MeMesh 搜尋 — 瞬間找到任何記憶" width="100%" />
</p>

<p align="center">
  <img src="docs/images/dashboard-analytics.png" alt="MeMesh 分析 — 健康分數、時間線、模式、知識涵蓋範圍" width="100%" />
</p>

<p align="center">
  <img src="docs/images/dashboard-graph.png" alt="MeMesh 圖表 — 互動式知識圖，具有類型篩選和自我中心模式" width="100%" />
</p>

---

## 誰應該用 MeMesh？

| 如果你是... | MeMesh 幫你... |
|---------------|---------------------|
| **使用 Claude Code 的開發者** | 在工作時自動回憶專案決策、檔案特定的經驗教訓和過去的失敗 |
| **程式開發代理進階使用者** | 在多個 MCP 相容工具間共享一層在地記憶 |
| **嘗試 AI 程式開發工作流的團隊** | 匯出／匯入專案知識，無需引入託管基礎設施 |
| **代理開發者** | 透過 MCP、HTTP、CLI 或 Python SDK 添加在地記憶 |

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

## Claude Code 自動進行的事情

你不需要手動記住所有事情。MeMesh 有 **7 個 hooks**，會在你工作時自動擷取與注入知識：

| 何時 | MeMesh 做什麼 |
|------|------------------|
| **每次 session 開始時** | 載入最相關的記憶 + 來自過去教訓的主動警告 |
| **編輯檔案前** | 回憶與檔案或專案相關的記憶，再讓 Claude 寫程式碼 |
| **執行 bash 指令前** | （可選加入）促使 Claude 將高可驗證性指令（測試、建置、檢查、遷移、部署、基準測試）派遣為背景代理 |
| **當你要求記住** | 偵測「remember this」／「guardar en memesh」／「sauvegarder dans memesh」／「記下來」意圖（5 種語言）並提醒 Claude 使用 memesh |
| **每次 `git commit` 之後** | 記錄你的變更，包含 diff 統計 |
| **Claude 停止時** | 擷取已編輯的檔案、已修復的錯誤，並從失敗自動產生結構化教訓 |
| **上下文壓縮前** | 在知識被上下文限制丟掉之前先保存 |

> **隨時退出：** `export MEMESH_AUTO_CAPTURE=false`

---

## 設定

所有設定都透過環境變數。預設是純本地、零網路 — 你不需要設定任何東西就能取得可運作的系統。

| 變數 | 預設值 | 用途 |
|---|---|---|
| `MEMESH_DB_PATH` | `~/.memesh/knowledge-graph.db` | 覆寫 SQLite 資料庫位置。 |
| `MEMESH_AUTO_CAPTURE` | `true` | 完全停用自動擷取 hooks（`Stop`、`PreCompact`）。 |
| `MEMESH_AUTO_DETECT_LLM` | 未設定 | 設為 `1` 讓 memesh 從你的 shell 環境（`OPENAI_API_KEY` 等）自動偵測供應商，並切換到 BYOK 嵌入。**全新安裝的預設僅使用本地 ONNX（384-dim）** — 想要雲端嵌入時才加入。沒設定這個旗標時，shell 中閒置的 `OPENAI_API_KEY` 會被忽略。 |
| `MEMESH_ENABLE_AGENTIC_ORCHESTRATION` | 未設定 | 設為 `1` 啟用實驗性的工作模型協定（CTO／Orchestrator／Agents 框架）。會加上 session-start 橫幅、Bash 指令提示，以及 `verify_agent_work` 遙測。協定的有效性正在量測中、尚未獲得驗證 — 想參與時才加入。**預設關閉**：核心記憶功能不需要這個旗標就能運作。 |
| `MEMESH_AUTO_UPDATE` | `off` | 自動更新策略。`off`（預設）永不自動更新；`patch` 允許 `X.Y.Z → X.Y.Z+N`；`minor` 加上 `X.Y.Z → X.Y+1.0`；`major` 允許任何升級。允許時，分離的 `npm install -g` 會在 session 結束時（Stop hook）執行，避免阻塞你的工作 — 結果寫入 `~/.memesh/auto-update.log`。也可在 `~/.memesh/config.json` 中以 `autoUpdate` 設定（環境變數優先）。當已安裝版本被維護者標為 deprecated（安全公告）時，即使是 `off` 也會強制允許 `patch` — 仍維持 minor／major 升級的手動門檻，避免靜默行為偏移。 |
| `OPENAI_API_KEY` | 未設定 | 你的 OpenAI 金鑰。僅在 `MEMESH_AUTO_DETECT_LLM=1` 或你明確設定供應商時才使用。 |
| `OLLAMA_HOST` | `http://localhost:11434` | 使用本地 Ollama 供應商時覆寫 Ollama 的端點。 |

`memesh doctor` 會印出已解析的設定，讓你看到目前實際生效的內容。

當 npm 將已安裝版本標為 deprecated（通常是安全公告），下次 session-start 會在前面附上強警示橫幅 `⚠️ MeMesh <ver> is DEPRECATED`，`memesh update-status` 也會持續顯示同一行直到你升級為止。檢查結果會被快取於 `~/.memesh/update-check.<version>.json`，以避免短暫網路失敗讓警示變淡。

---

## 儀表板

8 個分頁、11 種語言、零外部相依性。伺服器執行時可在 `http://localhost:3737/dashboard` 存取。

| 分頁 | 你會看到 |
|-----|-------------|
| **Insights** | 記憶洞察 — 來自 dreamer 引擎的每週摘要和模式提案；一鍵接受／拒絕 |
| **Search** | 全文 + 向量相似度搜尋所有記憶 |
| **Browse** | 所有實體的分頁列表，可以歸檔／復原 |
| **Analytics** | 記憶健康分數、30 天時間線、PM 速度 + KG 連通性指標、工作模式、清理建議 |
| **Graph** | 互動式力導向知識圖，具有類型篩選、搜尋、自我中心模式、近期熱力圖 |
| **Lessons** | 來自過去失敗的結構化教訓（錯誤、根本原因、修復、預防） |
| **Manage** | 歸檔和復原實體 |
| **Settings** | LLM 供應商設定、即時語言選擇器 |

---

## 智慧功能

**🧠 智慧搜尋** — 搜尋「登入安全」並找到關於「OAuth PKCE」的記憶。MeMesh 用 FTS5 + sqlite-vec 在熱路徑上保持 LLM-free，仍能跨同義詞匹配。

**📊 評分排名** — 結果按相關性（30%）+ 近期性（25%）+ 頻率（15%）+ 信心（15%）+ 回憶影響（10%）+ 時間有效性（5%）排名。

**🔄 知識演進** — 決策會改變。`forget` 歸檔舊記憶（永不刪除）。`supersedes` 關係連結舊 → 新。你的 AI 總是看到最新版本。

**⚠️ 衝突偵測** — 如果你有兩個互相矛盾的記憶，MeMesh 會警告你。

**🕸️ 知識圖連通性** — `memesh kg backfill-relations --all-rules` 使用標籤共現、專案叢集、會話上下文和名稱相似度連結孤立實體 — 無需 LLM。在代表性知識庫上將孤立率從 89% 降至 12% 以下。

**📦 團隊共享** — `memesh export > team-knowledge.json` → 與團隊共享 → `memesh import team-knowledge.json`
匯入的組合保持可搜尋，但 MeMesh 不會自動將匯入的記憶注入 Claude hooks，直到你檢查或在本地重新儲存。

---

## 使用範例

> 「MeMesh 記得我們三週前選擇了 PKCE 而不是隱式流程。當我再次問 Claude 關於身份驗證的問題時，它已經知道了——不需要重新解釋。」
> — **獨立開發者，正在打造 SaaS**

> 「我們每個星期五匯出團隊的記憶，星期一匯入。每個人的 Claude 在新一週開始時都知道團隊上週學到的東西。」
> — **3 人新創公司，共享知識庫**

> 「儀表板顯示我 90% 的記憶是自動生成的對話日誌。我開始有意使用 `remember` 來記錄架構決策。改變了遊戲規則。」
> — **發現分析分頁的開發者**

---

## 解鎖智慧模式（可選）

MeMesh 預設離線運作 — 回憶嚴格保持 LLM-free（開箱即用就有 LongMemEval-S 上 95.40% R@5）。只有當你想要在上層加入 LLM 增強的分析流程時，才需要加入 LLM API 金鑰：更聰明的 session 擷取、新記憶的自動標籤、從失敗產生教訓，以及 `consolidate` / `dream` 壓縮：

```bash
memesh config set llm.provider anthropic
memesh config set llm.api-key sk-ant-...
```

或使用儀表板 Settings 分頁（視覺化設定）：

```bash
memesh  # 開啟儀表板 → Settings 分頁
```

| | 等級 0（預設） | 等級 1（智慧模式） |
|---|---|---|
| **搜尋** | FTS5 + sqlite-vec，95.40% R@5（約 18ms/查詢） | 不變 — 回憶在每個等級都保持 LLM-free |
| **自動擷取** | 基於規則的模式 | + LLM 擷取決策與教訓 |
| **自動標籤** | 僅手動標籤 | + LLM 為新記憶產生標籤 |
| **失敗分析** | 不可用 | + LLM 將 session 錯誤轉為結構化教訓 |
| **壓縮** | 不可用 | `consolidate` + `dream` 壓縮冗長記憶 |
| **成本** | 免費，無需 API 金鑰 | 約 $0.0001 / 次分析呼叫（Haiku） |

---

## 全部 9 個記憶工具

| 工具 | 做什麼 |
|------|--------|
| `remember` | 用觀察、關係和標籤儲存知識 |
| `recall` | FTS5 + sqlite-vec 搜尋，包含多因素評分（相關性、近期性、頻率、信心、時間有效性）— 熱路徑上不使用 LLM |
| `forget` | 軟歸檔（永不刪除）或移除特定觀察 |
| `consolidate` | LLM 驅動的冗長記憶壓縮 |
| `export` | 在專案或團隊成員之間以 JSON 共享記憶 |
| `import` | 匯入記憶，包含合併策略（跳過 / 覆寫 / 追加） |
| `learn` | 記錄來自錯誤的結構化教訓（錯誤、根本原因、修復、預防） |
| `user_patterns` | 分析你的工作模式——時間表、工具、優勢、學習領域 |
| `verify_agent_work` | 保留背景代理工作的驗證報告；以 `git diff` 對所聲稱的檔案變更做現實檢查 |

---

## 架構

```
                    ┌─────────────────┐
                    │   核心引擎      │
                    │  （8 項操作）  │
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

## 貢獻

```bash
git clone https://github.com/PCIRCLE-AI/memesh-llm-memory
cd memesh-llm-memory && npm install && npm run build
npm test             # 630 項測試
npm run test:e2e-dashboard
```

儀表板：`cd dashboard && npm install && npm run dev`

---

<p align="center">
  <strong>MIT</strong> — 由 <a href="https://pcircle.ai">PCIRCLE AI</a> 製作
</p>
