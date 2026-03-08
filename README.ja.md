<div align="center">

# 🧠 MeMesh Plugin

### Claude Code の生産性プラグイン

メモリ、スマートタスク分析、ワークフロー自動化 — ひとつのプラグインで。

[![npm version](https://img.shields.io/npm/v/@pcircle/memesh)](https://www.npmjs.com/package/@pcircle/memesh)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![MCP](https://img.shields.io/badge/MCP-compatible-purple.svg)](https://modelcontextprotocol.io)

[インストール](#インストール) • [使い方](#使い方) • [トラブルシューティング](#トラブルシューティング)

[English](README.md) • [繁體中文](README.zh-TW.md) • [简体中文](README.zh-CN.md) • **日本語** • [한국어](README.ko.md) • [Français](README.fr.md) • [Deutsch](README.de.md) • [Español](README.es.md) • [Tiếng Việt](README.vi.md) • [ภาษาไทย](README.th.md) • [Bahasa Indonesia](README.id.md)

</div>

---

## なぜこのプロジェクトを作ったのか

このプロジェクトは、もっと多くの人 — 特にコーディング初心者の方々 — が Claude Code を使った vibe coding をもっと楽しめるようにしたいと思って始めました。プロジェクトが大きくなると、セッションをまたいだ決定事項を追跡するのが難しくなります。そこで（もちろん Claude Code と一緒に）記憶してくれるプラグインを作りました。

> **注**: このプロジェクトは元々「Claude Code Buddy」という名前でしたが、商標問題を避けるため MeMesh Plugin に改名しました。

## 何ができるの？

MeMesh Plugin は Claude Code をよりスマートで生産的にします。メモリだけではなく、フルツールキットです：

**検索可能なプロジェクトメモリ** — 作業中に決定、パターン、教訓を自動保存。意味で検索できます。「認証についてどう決めたっけ？」と聞けば即座に回答。

**スマートタスク分析** — `buddy-do "ユーザー認証を追加"` と言うと、MeMesh がタスクを分析し、過去の作業からコンテキストを引き出し、実行前に充実したプランを提供します。

**ワークフロー自動化** — MeMesh がバックグラウンドで自動的に：
- セッション開始時に前回の作業サマリーを表示
- 変更・テストしたファイルを追跡
- コミット前にコードレビューをリマインド
- タスクを最適なモデルに振り分け

**ミスから学ぶ** — エラーと修正を記録し、同じ失敗を繰り返さないナレッジベースを構築。

**Claude の内蔵メモリとの違いは？**

Claude Code には auto memory と CLAUDE.md がすでにあります — 一般的な設定や指示には最適です。MeMesh はそれに加えてプロジェクトレベルの**専用ツール**を追加します：意味で検索できるメモリ、過去のコンテキストを活用するタスク分析、毎セッションをより生産的にする自動化ワークフロー。

こう考えてください：
- **CLAUDE.md** = Claude への取扱説明書
- **MeMesh** = 検索可能なノートブック + プロジェクトと共に成長するスマートアシスタント

---

## インストール

**必要なもの**: [Claude Code](https://docs.anthropic.com/en/docs/claude-code) と Node.js 20+

```bash
npm install -g @pcircle/memesh
```

Claude Code を再起動すれば完了です。

**動作確認** — Claude Code で以下を入力：

```
buddy-help
```

コマンド一覧が表示されれば成功です。

<details>
<summary>ソースからインストール（コントリビューター向け）</summary>

```bash
git clone https://github.com/PCIRCLE-AI/claude-code-buddy.git
cd claude-code-buddy
npm install && npm run build
```

</details>

---

## 使い方

MeMesh は Claude Code に 3 つのコマンドを追加します：

| コマンド | 機能 |
|---------|------|
| `buddy-do "タスク"` | メモリコンテキスト付きでタスクを実行 |
| `buddy-remember "トピック"` | 過去の決定やコンテキストを検索 |
| `buddy-help` | 利用可能なコマンドを表示 |

**例：**

```bash
buddy-do "このコードベースを説明して"
buddy-do "ユーザー認証を追加して"
buddy-remember "API 設計の決定事項"
buddy-remember "なぜ PostgreSQL を選んだのか"
```

すべてのデータはローカルマシンに保存されます。決定事項は 90 日間、セッションノートは 30 日間保持されます。

---

## 対応環境

| プラットフォーム | 状態 |
|----------------|------|
| **macOS** | ✅ 対応 |
| **Linux** | ✅ 対応 |
| **Windows** | ✅ 対応（WSL2 推奨）|

**対応ツール：**
- Claude Code CLI（ターミナル）
- Claude Code VS Code 拡張機能
- Cursor（MCP 経由）
- その他 MCP 互換エディタ

**Claude Desktop (Cowork)**: 基本コマンドは動作しますが、メモリ機能には CLI 版が必要です。[Cowork 詳細](docs/COWORK_SUPPORT.md)をご覧ください。

---

## トラブルシューティング

**MeMesh が表示されない？**

```bash
# インストール確認
npm list -g @pcircle/memesh

# Node.js バージョン確認（20+ が必要）
node --version

# セットアップ再実行
memesh setup
```

その後、Claude Code を完全に再起動してください。

詳細：[トラブルシューティングガイド](docs/TROUBLESHOOTING.md)

---

## もっと詳しく

- **[はじめに](docs/GETTING_STARTED.md)** — ステップバイステップのセットアップ
- **[ユーザーガイド](docs/USER_GUIDE.md)** — 例付きの完全ガイド
- **[コマンド](docs/COMMANDS.md)** — すべてのコマンド
- **[アーキテクチャ](docs/ARCHITECTURE.md)** — 内部の仕組み
- **[コントリビュート](CONTRIBUTING.md)** — 手伝いたい方はこちら
- **[開発ガイド](docs/DEVELOPMENT.md)** — コントリビューター向け

---

## ライセンス

MIT — [LICENSE](LICENSE) を参照

---

<div align="center">

うまくいかない？ [Issue を開く](https://github.com/PCIRCLE-AI/claude-code-buddy/issues/new) — 迅速に対応します。

[バグ報告](https://github.com/PCIRCLE-AI/claude-code-buddy/issues/new?labels=bug&template=bug_report.yml) • [機能リクエスト](https://github.com/PCIRCLE-AI/claude-code-buddy/discussions)

</div>
