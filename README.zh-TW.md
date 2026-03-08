<div align="center">

# 🧠 MeMesh Plugin

### Claude Code 的生產力插件

記憶、智慧任務分析、工作流自動化 — 一個插件搞定。

[![npm version](https://img.shields.io/npm/v/@pcircle/memesh)](https://www.npmjs.com/package/@pcircle/memesh)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![MCP](https://img.shields.io/badge/MCP-compatible-purple.svg)](https://modelcontextprotocol.io)

[安裝](#安裝) • [使用方式](#使用方式) • [疑難排解](#疑難排解) • [English](README.md)

[简体中文](README.zh-CN.md) • [日本語](README.ja.md) • [한국어](README.ko.md) • [Français](README.fr.md) • [Deutsch](README.de.md) • [Español](README.es.md) • [Tiếng Việt](README.vi.md) • [ภาษาไทย](README.th.md) • [Bahasa Indonesia](README.id.md)

</div>

---

## 為什麼做這個專案

這個專案的起點很簡單：我想幫助更多人 — 特別是剛接觸程式的新手 — 更好地用 Claude Code 來 vibe coding。我發現當專案越來越大，很難記住跨 session 做過的所有決策。所以我（跟 Claude Code 一起）做了一個插件，幫你記住。

> **備註**：本專案原名「Claude Code Buddy」，為避免潛在商標問題已更名為 MeMesh Plugin。

## 它能做什麼？

MeMesh Plugin 讓 Claude Code 更聰明、更有生產力。不只是記憶 — 它是一整套工具：

**可搜尋的專案記憶** — 工作時自動儲存決策、模式和經驗教訓。用語意搜尋，不只是關鍵字。問「我們之前怎麼決定 auth 的？」就能馬上得到答案。

**智慧任務分析** — 當你說 `buddy-do "加上使用者認證"`，MeMesh 會分析任務、從過去的工作中拉出相關脈絡，在執行前給你一個完整的計畫。

**工作流自動化** — MeMesh 在背後自動幫你：
- 開始新 session 時顯示上次工作摘要
- 追蹤你改了哪些檔案、測試了哪些
- 在 commit 前提醒你做 code review
- 把任務分配到最合適的模型（搜尋用快的、規劃用強的）

**從錯誤中學習** — 記錄錯誤和修復方式，避免重蹈覆轍。MeMesh 會建立一個什麼有效、什麼不行的知識庫。

**跟 Claude 內建記憶有什麼不同？**

Claude Code 已經有 auto memory 和 CLAUDE.md — 很適合存一般偏好和指令。MeMesh 在此基礎上增加了專案級的**專用工具**：可用語意搜尋的記憶、能拉取過去脈絡的任務分析、以及讓每個 session 都更有效率的自動化工作流。

簡單來說：
- **CLAUDE.md** = 你寫給 Claude 的使用手冊
- **MeMesh** = 可搜尋的筆記本 + 隨專案成長而學習的智慧助手

---

## 安裝

**你需要**：[Claude Code](https://docs.anthropic.com/en/docs/claude-code) 和 Node.js 20+

```bash
npm install -g @pcircle/memesh
```

重啟 Claude Code，完成。

**確認安裝成功** — 在 Claude Code 中輸入：

```
buddy-help
```

看到指令列表就代表安裝成功。

<details>
<summary>從原始碼安裝（給貢獻者）</summary>

```bash
git clone https://github.com/PCIRCLE-AI/claude-code-buddy.git
cd claude-code-buddy
npm install && npm run build
```

</details>

---

## 使用方式

MeMesh 在 Claude Code 中增加 3 個指令：

| 指令 | 功能 |
|------|------|
| `buddy-do "任務"` | 帶著記憶脈絡執行任務 |
| `buddy-remember "主題"` | 搜尋過去的決策和脈絡 |
| `buddy-help` | 顯示可用指令 |

**範例：**

```bash
buddy-do "解釋這個 codebase"
buddy-do "加上使用者認證"
buddy-remember "API 設計決策"
buddy-remember "為什麼選 PostgreSQL"
```

所有資料都存在你的電腦上。決策保留 90 天，session 筆記保留 30 天。

---

## 支援環境

| 平台 | 狀態 |
|------|------|
| **macOS** | ✅ 正常 |
| **Linux** | ✅ 正常 |
| **Windows** | ✅ 正常（建議 WSL2）|

**可搭配使用：**
- Claude Code CLI（終端機）
- Claude Code VS Code 擴充套件
- Cursor（透過 MCP）
- 其他相容 MCP 的編輯器

**Claude Desktop (Cowork)**：基本指令可用，記憶功能需使用 CLI 版本。詳見 [Cowork 說明](docs/COWORK_SUPPORT.md)。

---

## 疑難排解

**MeMesh 沒出現？**

```bash
# 確認已安裝
npm list -g @pcircle/memesh

# 確認 Node.js 版本（需要 20+）
node --version

# 重新設定
memesh setup
```

然後完全重啟 Claude Code。

更多說明：[疑難排解指南](docs/TROUBLESHOOTING.md)

---

## 了解更多

- **[快速開始](docs/GETTING_STARTED.md)** — 一步步安裝教學
- **[使用指南](docs/USER_GUIDE.md)** — 完整使用範例
- **[指令參考](docs/COMMANDS.md)** — 所有可用指令
- **[架構說明](docs/ARCHITECTURE.md)** — 內部運作原理
- **[貢獻指南](CONTRIBUTING.md)** — 想幫忙？從這裡開始
- **[開發指南](docs/DEVELOPMENT.md)** — 給貢獻者

---

## 授權

MIT — 詳見 [LICENSE](LICENSE)

---

<div align="center">

遇到問題？[回報 Issue](https://github.com/PCIRCLE-AI/claude-code-buddy/issues/new) — 我們會快速回應。

[回報 Bug](https://github.com/PCIRCLE-AI/claude-code-buddy/issues/new?labels=bug&template=bug_report.yml) • [功能請求](https://github.com/PCIRCLE-AI/claude-code-buddy/discussions)

</div>
