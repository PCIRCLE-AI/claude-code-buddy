🌐 [English](README.md) | [繁體中文](README.zh-TW.md) | [简体中文](README.zh-CN.md) | [日本語](README.ja.md) | [한국어](README.ko.md) | [Português](README.pt.md) | [Français](README.fr.md) | [Deutsch](README.de.md) | [Tiếng Việt](README.vi.md) | [Español](README.es.md) | [ภาษาไทย](README.th.md)

<p align="center">
  <h1 align="center">MeMesh LLM Memory</h1>
  <p align="center">
    <strong>給 Claude Code 與 MCP coding agents 的本地記憶層。</strong><br />
    一個 SQLite 檔案。不需要 Docker。不需要雲端。
  </p>
</p>

> 這份繁體中文 README 是精簡導覽版。若要查看最新、最完整的內容，請以 [English README](README.md) 為準。

## 問題是什麼？

coding agent 在每次 session 之間都很容易失去上下文。架構決策、除錯過程、踩過的坑、專案限制，常常要一講再講。

**MeMesh 讓這些知識留在本機、可搜尋、可檢視，也能在之後的工作裡再次被召回。**

這個 npm package 是 MeMesh 的本地 plugin / package 版本，重點是本地記憶，不是雲端工作台，也不是企業平台。

## 60 秒快速開始

### 1. 安裝

```bash
npm install -g @pcircle/memesh
```

### 2. 記下一個決策

```bash
memesh remember --name "auth-decision" --type "decision" --obs "Use OAuth 2.0 with PKCE"
```

### 3. 之後再找回來

```bash
memesh recall "login security"
# → 即使換了說法，也能找回 "OAuth 2.0 with PKCE"
```

打開 dashboard：

```bash
memesh
```

## 這個工具適合誰？

- 使用 Claude Code、希望跨 session 保留專案脈絡的開發者
- 使用 MCP coding agents、想共用同一份本地記憶的進階使用者
- 小型 AI-native 開發團隊，想透過 export / import 共用專案知識
- 想用 CLI、HTTP 或 MCP 把本地記憶接進工具流程的 agent 開發者

## 為什麼用 MeMesh？

- 本地優先：資料存在你自己的 SQLite 檔案裡
- 安裝輕量：`npm install -g` 後即可使用
- 整合直接：同時支援 CLI、HTTP、MCP
- 對 Claude Code 友善：有 hooks，可在工作流中自動帶入相關記憶
- 可檢視可清理：內建 dashboard，不是黑盒子
- 較安全的匯入邊界：匯入記憶預設可搜尋，但不會直接自動注入到 Claude hooks，除非你重新檢閱或本地重存

## 在 Claude Code 會自動做什麼？

MeMesh 目前會在 5 個時機點協助你：

- session 開始時，載入專案相關記憶與已知教訓
- 編輯檔案前，先查回與該檔案或專案相關的記憶
- `git commit` 後，記錄你做了什麼變更
- session 結束時，整理本次修復、錯誤與 lesson learned
- context compact 前，先把重要內容寫回本地記憶

## Dashboard 有什麼？

Dashboard 目前提供 7 個分頁，並支援 11 種語言：

- Search：搜尋記憶
- Browse：瀏覽全部記憶
- Analytics：看健康度、趨勢與使用情況
- Graph：看知識關聯圖
- Lessons：看過去的教訓
- Manage：封存或還原記憶
- Settings：設定 LLM provider 與語言

## Smart Mode 是什麼？

MeMesh 預設就能離線使用。若你額外設定 LLM API key，可以啟用更智慧的能力，例如：

- query expansion
- 更好的自動萃取
- 更聰明的記憶整理與壓縮

不設定也可以正常使用核心功能。

## 更多資訊

- 完整功能、比較、API 與 release 細節：請看 [English README](README.md)
- 平台整合方式：請看 [docs/platforms/README.md](docs/platforms/README.md)
- API 參考：請看 [docs/api/API_REFERENCE.md](docs/api/API_REFERENCE.md)

## 開發與驗證

```bash
git clone https://github.com/PCIRCLE-AI/memesh-llm-memory
cd memesh-llm-memory
npm install
npm run build
npm test
```
