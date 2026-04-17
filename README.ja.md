🌐 [English](README.md) | [繁體中文](README.zh-TW.md) | [简体中文](README.zh-CN.md) | [日本語](README.ja.md) | [한국어](README.ko.md) | [Português](README.pt.md) | [Français](README.fr.md) | [Deutsch](README.de.md) | [Tiếng Việt](README.vi.md) | [Español](README.es.md) | [ภาษาไทย](README.th.md)

<p align="center">
  <h1 align="center">MeMesh LLM Memory</h1>
  <p align="center">
    <strong>最も軽量なユニバーサル AI メモリ層。</strong><br />
    SQLite ファイル 1 つ。あらゆる LLM に対応。クラウド不要。
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

AI はセッションをまたぐとすべてを忘れてしまいます。**MeMesh がその問題を解決します。**

一度インストールして 30 秒で設定すれば、あなたが使うすべての AI ツール — Claude、GPT、LLaMA、または任意の MCP クライアント — が永続的で検索可能な、進化し続けるメモリを持てます。クラウド不要。Neo4j 不要。ベクターデータベース不要。SQLite ファイル 1 つだけ。

```bash
npm install -g @pcircle/memesh
```

---

## ダッシュボード

<p align="center">
  <img src="docs/images/dashboard-search.png" alt="MeMesh Search" width="100%" />
</p>

<p align="center">
  <img src="docs/images/dashboard-analytics.png" alt="MeMesh Analytics" width="100%" />
</p>

<p align="center">
  <img src="docs/images/dashboard-browse.png" alt="MeMesh Browse" width="100%" />
</p>

`memesh` を実行してインタラクティブなダッシュボードを開きます。検索・ブラウズ・アナリティクス・管理・設定の 5 つのタブが利用できます。

---

## クイックスタート

```bash
# メモリを保存する
memesh remember --name "auth-decision" --type "decision" --obs "Use OAuth 2.0 with PKCE"

# メモリを検索する（スマートモードでは「login security」で「OAuth」も見つかります）
memesh recall "login security"

# 古いメモリをアーカイブする（ソフト削除で、データは永遠に失われません）
memesh forget --name "old-auth-design"

# ダッシュボードを開く
memesh

# HTTP API を起動する（Python SDK・外部連携向け）
memesh serve
```

### Python

```python
from memesh import MeMesh

m = MeMesh()  # connects to localhost:3737
m.remember("auth", "decision", observations=["Use OAuth 2.0 with PKCE"])
results = m.recall("auth")
```

### あらゆる LLM（OpenAI function calling 形式）

```bash
memesh export-schema --format openai
# → JSON array of tools, paste into your OpenAI/Claude/Gemini API call
```

---

## なぜ MeMesh なのか？

多くの AI メモリソリューションは Neo4j、ベクターデータベース、API キー、そして 30 分以上のセットアップ時間を必要とします。MeMesh は**コマンド 1 つ**で済みます。

| | **MeMesh** | Mem0 | Zep | Anthropic Memory |
|---|---|---|---|---|
| **インストール** | `npm i -g`（5 秒） | pip + Neo4j + VectorDB | pip + Neo4j | 組み込み（クラウド） |
| **ストレージ** | SQLite ファイル 1 つ | Neo4j + Qdrant | Neo4j | クラウド |
| **検索** | FTS5 + スコアリング + LLM クエリ拡張 | セマンティック + BM25 | 時系列グラフ | キー検索 |
| **プライバシー** | 常に 100% ローカル | クラウドオプションあり | セルフホスト | クラウド |
| **依存関係** | 6 | 20+ | 10+ | 0（ただしクラウド依存） |
| **オフライン** | 対応 | 非対応 | 非対応 | 非対応 |
| **ダッシュボード** | 組み込み（5 タブ） | なし | なし | なし |
| **価格** | 無料 | 無料/有料 | 無料/有料 | API に含む |

---

## 機能

### 6 つのメモリツール

| ツール | 機能 |
|------|-------------|
| **remember** | 観察記録・関係性・タグとともに知識を保存 |
| **recall** | 多因子スコアリングと LLM クエリ拡張によるスマート検索 |
| **forget** | ソフトアーカイブ（完全削除なし）または特定の観察記録を削除 |
| **consolidate** | LLM を使って冗長なメモリを圧縮 |
| **export** | メモリを JSON 形式でプロジェクトやチームメンバーと共有 |
| **import** | マージ戦略（スキップ / 上書き / 追加）を選んでメモリをインポート |

### 3 つのアクセス方法

| 方法 | コマンド | 最適な用途 |
|--------|---------|----------|
| **CLI** | `memesh` | ターミナル・スクリプト・CI/CD |
| **HTTP API** | `memesh serve` | Python SDK・ダッシュボード・外部連携 |
| **MCP** | `memesh-mcp` | Claude Code・Claude Desktop・任意の MCP クライアント |

### 4 つの自動キャプチャフック

| フック | トリガー | キャプチャ内容 |
|------|---------|-----------------|
| **Session Start** | セッション開始時 | 関連性上位のメモリを読み込む |
| **Post Commit** | `git commit` 後 | 差分統計付きでコミットを記録 |
| **Session Summary** | Claude 終了時 | 編集ファイル・修正エラー・下した決断 |
| **Pre-Compact** | コンパクション前 | コンテキスト消失前に知識を保存 |

### スマート機能

- **知識の進化** — `forget` はアーカイブであり削除ではありません。`supersedes` の関係で古い決断を新しいものに置き換えながら、履歴は完全に保持されます。
- **スマートリコール** — LLM が検索クエリを関連語に展開します。「login security」で「OAuth PKCE」が見つかります。
- **多因子スコアリング** — 結果は関連性（35%）・新鮮さ（25%）・使用頻度（20%）・信頼度（15%）・時間的有効性（5%）で順位付けされます。
- **矛盾検出** — メモリが互いに矛盾するときに警告を発します。
- **自動減衰** — 30 日以上使われていない古いメモリはランクが徐々に下がりますが、削除はされません。
- **ネームスペース** — `personal`・`team`・`global` のスコープで整理・共有が可能です。

---

## アーキテクチャ

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

**コアエンジン**はフレームワークに依存しません — `remember`/`recall`/`forget` のロジックは、ターミナル・HTTP・MCP のいずれから呼び出しても同一です。

**依存関係**：`better-sqlite3`、`sqlite-vec`、`@modelcontextprotocol/sdk`、`zod`、`express`、`commander`

---

## 開発

```bash
git clone https://github.com/PCIRCLE-AI/memesh-llm-memory
cd memesh-llm-memory
npm install
npm run build
npm test -- --run    # 289 tests
```

ダッシュボード開発：
```bash
cd dashboard
npm install
npm run dev          # Vite dev server with hot reload
npm run build        # Build to single HTML file
```

---

## ライセンス

MIT — [PCIRCLE AI](https://pcircle.ai)
