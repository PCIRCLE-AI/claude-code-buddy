<div align="center">

<img src="https://img.shields.io/badge/%F0%9F%A7%A0-MeMesh-blueviolet?style=for-the-badge" alt="MeMesh" />

# MeMesh

### あなたの AI コーディングセッションにはメモリが必要です。

MeMesh は Claude Code に永続的で検索可能なメモリを提供し、すべてのセッションが前回の続きから始まります。

[![npm version](https://img.shields.io/npm/v/@pcircle/memesh?style=flat-square&color=cb3837)](https://www.npmjs.com/package/@pcircle/memesh)
[![Downloads](https://img.shields.io/npm/dm/@pcircle/memesh?style=flat-square&color=blue)](https://www.npmjs.com/package/@pcircle/memesh)
[![License](https://img.shields.io/badge/license-MIT-green?style=flat-square)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen?style=flat-square)](https://nodejs.org)
[![MCP](https://img.shields.io/badge/MCP-compatible-purple?style=flat-square)](https://modelcontextprotocol.io)

```bash
npm install -g @pcircle/memesh
```

[はじめに](#はじめに) · [仕組み](#仕組み) · [コマンド](#コマンド) · [ドキュメント](docs/USER_GUIDE.md)

[English](README.md) · [繁體中文](README.zh-TW.md) · [简体中文](README.zh-CN.md) · **日本語** · [한국어](README.ko.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [Español](README.es.md) · [Tiếng Việt](README.vi.md) · [ภาษาไทย](README.th.md) · [Bahasa Indonesia](README.id.md)

</div>

> **注意**：このプロジェクトは元々「Claude Code Buddy」という名前でしたが、商標上の問題を避けるため MeMesh Plugin に改名されました。

---

## 問題

Claude Code でプロジェクトに深く取り組んでいるとき、3 セッション前に重要な決定をしたはずです — どの認証ライブラリを使うか、なぜそのデータベーススキーマを選んだか、どのパターンに従うか。しかし Claude は覚えていません。同じ説明を繰り返し、コンテキストを失い、時間を無駄にします。

**MeMesh がこれを解決します。** プロジェクトと共に成長する、永続的で検索可能なメモリを Claude に提供します。

---

## 仕組み

<table>
<tr>
<td width="50%">

### MeMesh 導入前
```
セッション 1: 「認証には JWT を使おう」
セッション 2: 「なぜ JWT にしたんだっけ？」
セッション 3: 「え、どの認証ライブラリ使ってるの？」
```
決定を繰り返す。Claude はコンテキストを忘れる。進捗が止まる。

</td>
<td width="50%">

### MeMesh 導入後
```
セッション 1: 「認証には JWT を使おう」→ 保存済み
セッション 2: buddy-remember "auth" → 即座に呼び出し
セッション 3: 開始時にコンテキスト自動読み込み
```
すべてのセッションが前回の続きから始まります。

</td>
</tr>
</table>

---

## できること

**検索可能なプロジェクトメモリ** — 「認証についてどう決めた？」と聞けば、意味に基づいて即座にマッチした回答が返ります。キーワード検索ではなく、ローカル ONNX 埋め込みによる*意味*検索です。

**スマートタスク分析** — `buddy-do "ユーザー認証を追加"` はただ実行するだけではありません。過去のセッションから関連コンテキストを引き出し、確立されたパターンを確認し、一行のコードを書く前に充実したプランを構築します。

**プロアクティブな呼び出し** — MeMesh はセッション開始時、テスト失敗時、エラー発生時に関連するメモリを自動的に表示します。手動検索は不要です。

**ワークフロー自動化** — 起動時のセッション要約。ファイル変更の追跡。コミット前のコードレビューリマインダー。すべてバックグラウンドで静かに動作します。

**ミスから学ぶ** — エラーと修正を記録してナレッジベースを構築。同じミスを二度と繰り返しません。

---

## はじめに

**必要なもの**: [Claude Code](https://docs.anthropic.com/en/docs/claude-code) + Node.js 20+

```bash
npm install -g @pcircle/memesh
```

Claude Code を再起動すれば完了です。

**動作確認** — Claude Code で以下を入力：

```
buddy-help
```

利用可能なコマンドの一覧が表示されます。

<details>
<summary><strong>ソースからインストール</strong>（コントリビューター向け）</summary>

```bash
git clone https://github.com/PCIRCLE-AI/claude-code-buddy.git
cd claude-code-buddy
npm install && npm run build
```

</details>

---

## コマンド

| コマンド | 機能 |
|---------|------|
| `buddy-do "タスク"` | メモリコンテキスト付きでタスクを実行 |
| `buddy-remember "トピック"` | 過去の決定やコンテキストを検索 |
| `buddy-help` | 利用可能なコマンドを表示 |

**実際の例：**

```bash
# 初めてのコードベースを理解する
buddy-do "explain this codebase"

# 過去の作業のコンテキストを活用して機能を構築
buddy-do "add user authentication"

# なぜその決定をしたか思い出す
buddy-remember "API design decisions"
buddy-remember "why we chose PostgreSQL"
```

すべてのデータはローカルマシンに保存されます。決定事項は 90 日間、セッションノートは 30 日間保持されます。

---

## CLAUDE.md との違いは？

| | CLAUDE.md | MeMesh |
|---|-----------|--------|
| **目的** | Claude への静的な指示 | プロジェクトと共に成長する生きたメモリ |
| **検索** | 手動テキスト検索 | 意味に基づくセマンティック検索 |
| **更新** | 手動で編集 | 作業中に決定事項を自動キャプチャ |
| **呼び出し** | 常に読み込み（長くなりがち） | 必要に応じて関連コンテキストを表示 |
| **範囲** | 一般的な設定 | プロジェクト固有のナレッジグラフ |

**両方を併用できます。** CLAUDE.md は Claude に*どう*作業するかを伝えます。MeMesh は*何を*構築したかを記憶します。

---

## 対応環境

| プラットフォーム | 状態 |
|----------------|------|
| macOS | ✅ |
| Linux | ✅ |
| Windows | ✅（WSL2 推奨） |

**対応ツール：** Claude Code CLI · VS Code 拡張機能 · Cursor（MCP 経由） · その他 MCP 互換エディタ

---

## アーキテクチャ

MeMesh は Claude Code と並行してローカル MCP サーバーとして動作します：

- **ナレッジグラフ** — FTS5 全文検索を備えた SQLite ベースのエンティティストア
- **ベクトル埋め込み** — セマンティック類似性のための ONNX ランタイム（100% ローカルで動作）
- **コンテンツ重複排除** — SHA-256 ハッシュで冗長な埋め込み計算をスキップ
- **バッチ処理** — 大規模ナレッジベース向けの効率的な一括操作
- **フックシステム** — セッション開始時、テスト失敗時、エラー発生時のプロアクティブな呼び出し

すべてローカルで動作します。クラウドなし。API コールなし。データがマシンの外に出ることはありません。

---

## ドキュメント

| ドキュメント | 説明 |
|------------|------|
| [はじめに](docs/GETTING_STARTED.md) | ステップバイステップのセットアップガイド |
| [ユーザーガイド](docs/USER_GUIDE.md) | 例付きの完全な使い方ガイド |
| [コマンド](docs/COMMANDS.md) | コマンドリファレンス |
| [アーキテクチャ](docs/ARCHITECTURE.md) | 技術的な詳細解説 |
| [コントリビュート](CONTRIBUTING.md) | 貢献ガイドライン |
| [開発ガイド](docs/DEVELOPMENT.md) | コントリビューター向けの開発環境構築 |

---

## コントリビュート

コントリビューションを歓迎します！[CONTRIBUTING.md](CONTRIBUTING.md) をご覧ください。

---

## ライセンス

MIT — [LICENSE](LICENSE) を参照

---

<div align="center">

**Claude Code で作られた、Claude Code のためのツール。**

[バグ報告](https://github.com/PCIRCLE-AI/claude-code-buddy/issues/new?labels=bug&template=bug_report.yml) · [機能リクエスト](https://github.com/PCIRCLE-AI/claude-code-buddy/discussions) · [ヘルプ](https://github.com/PCIRCLE-AI/claude-code-buddy/issues/new)

</div>
