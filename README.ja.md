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
  </p>
</p>

---

## 問題の本質

AI はセッションをまたぐたびにすべてを忘れます。すべての決断、すべてのバグ修正、すべての学び——消えてしまいます。同じコンテキストを何度も説明し直し、Claude は同じパターンを再発見し、チームの AI 知識は毎回ゼロにリセットされます。

**MeMesh はすべての AI に、永続的で検索可能な、進化し続けるメモリを与えます。**

---

## 60 秒で始める

### ステップ 1: インストール

```bash
npm install -g @pcircle/memesh
```

### ステップ 2: AI が記憶する

```bash
memesh remember --name "auth-decision" --type "decision" --obs "Use OAuth 2.0 with PKCE"
```

### ステップ 3: AI が思い出す

```bash
memesh recall "login security"
# → 別の言葉で検索しても「OAuth 2.0 with PKCE」が見つかります
```

**以上です。** MeMesh はセッションをまたいで記憶・想起を始めています。

ダッシュボードを開いてメモリを探索してみましょう：

```bash
memesh
```

<p align="center">
  <img src="docs/images/dashboard-search.png" alt="MeMesh Search — 任意のメモリを瞬時に検索" width="100%" />
</p>

<p align="center">
  <img src="docs/images/dashboard-analytics.png" alt="MeMesh Analytics — AI の知識を可視化" width="100%" />
</p>

<p align="center">
  <img src="docs/images/dashboard-graph.png" alt="MeMesh Graph — タイプフィルターとエゴモード付きインタラクティブ知識グラフ" width="100%" />
</p>

---

## 誰のためのツールか？

| あなたが…なら | MeMesh はこう役立てます |
|---------------|---------------------|
| **Claude Code を使う開発者** | 決断・パターン・学びをセッションをまたいで自動的に記憶 |
| **LLM でプロダクトを作るチーム** | エクスポート/インポートでチーム知識を共有し、全員の AI コンテキストを統一 |
| **AI エージェント開発者** | MCP・HTTP API・Python SDK 経由でエージェントに永続メモリを付与 |
| **複数の AI ツールを使うパワーユーザー** | Claude・GPT・LLaMA・Ollama または任意の MCP クライアントで使える共通メモリ層 |

---

## あらゆるものと連携

<table>
<tr>
<td width="33%" align="center">

**Claude Code / Desktop**
```bash
memesh-mcp
```
MCP プロトコル（自動設定済み）

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

**任意の LLM（OpenAI 形式）**
```bash
memesh export-schema \
  --format openai
```
任意の API 呼び出しに貼り付け

</td>
</tr>
</table>

---

## なぜ Mem0 / Zep ではないのか？

| | **MeMesh** | Mem0 | Zep |
|---|---|---|---|
| **セットアップ時間** | 5 秒 | 30〜60 分 | 30 分以上 |
| **設定方法** | `npm i-g` — 完了 | Neo4j + VectorDB + API キー | Neo4j + 設定 |
| **ストレージ** | SQLite ファイル 1 つ | Neo4j + Qdrant | Neo4j |
| **オフライン利用** | 常時対応 | 非対応 | 非対応 |
| **ダッシュボード** | 組み込み（7 タブ + アナリティクス） | なし | なし |
| **依存関係** | 6 | 20+ | 10+ |
| **価格** | 永久無料 | 無料枠 / 有料 | 無料枠 / 有料 |

**MeMesh のトレードオフ：** エンタープライズ向けマルチテナント機能を省き、**即時セットアップ・インフラ不要・完全プライバシー**を実現しています。

---

## 自動で動く仕組み

すべてを手動で記憶する必要はありません。MeMesh には **4 つのフック**があり、何もしなくても知識を自動的にキャプチャします：

| タイミング | MeMesh が行うこと |
|------|------------------|
| **セッション開始時** | 最も関連性の高いメモリを読み込み + 過去の教訓からのプロアクティブな警告 |
| **`git commit` 後** | 変更内容と差分統計を記録する |
| **Claude 終了時** | 編集したファイル・修正したエラーをキャプチャし、失敗から構造化された教訓を自動生成 |
| **コンテキスト圧縮前** | コンテキスト上限で失われる前に知識を保存する |

> **いつでも無効化：** `export MEMESH_AUTO_CAPTURE=false`

---

## ダッシュボード

7 タブ、11 言語、外部依存ゼロ。サーバー起動中は `http://localhost:3737/dashboard` でアクセス。

| タブ | 内容 |
|------|------|
| **Search** | すべてのメモリに対する全文検索 + ベクトル類似度検索 |
| **Browse** | すべてのエンティティのページネーション一覧（アーカイブ/復元対応） |
| **Analytics** | メモリヘルススコア（0-100）、30日タイムライン、価値指標、知識カバレッジ、クリーンアップ提案、作業パターン |
| **Graph** | タイプフィルター、検索、エゴモード、最新性ヒートマップ付きインタラクティブ力学グラフ |
| **Lessons** | 過去の失敗から生成された構造化レッスン（エラー、根本原因、修正方法、予防策） |
| **Manage** | エンティティのアーカイブと復元 |
| **Settings** | LLM プロバイダー設定、言語セレクター |

---

## スマート機能

**🧠 スマート検索** — 「login security」で「OAuth PKCE」に関するメモリが見つかります。設定した LLM を使ってクエリを関連語に展開します。

**📊 スコアリングランキング** — 結果は関連性（35%）+ 最終使用日（25%）+ 使用頻度（20%）+ 信頼度（15%）+ 情報の有効期限（5%）で順位付けされます。

**🔄 知識の進化** — 決断は変わります。`forget` は古いメモリをアーカイブします（削除はしません）。`supersedes` の関係で古いものと新しいものをつなぎます。AI は常に最新版を参照します。

**⚠️ 矛盾検出** — 2 つのメモリが相互に矛盾している場合、MeMesh が警告を出します。

**📦 チーム共有** — `memesh export > team-knowledge.json` → チームと共有 → `memesh import team-knowledge.json`

---

## スマートモードを有効にする（任意）

MeMesh はデフォルトで完全にオフラインで動作します。LLM API キーを追加するとより賢い検索が使えます：

```bash
memesh config set llm.provider anthropic
memesh config set llm.api-key sk-ant-...
```

またはダッシュボードの設定タブで視覚的に設定：

```bash
memesh  # ダッシュボードを開く → 設定タブ
```

| | レベル 0（デフォルト） | レベル 1（スマートモード） |
|---|---|---|
| **検索** | FTS5 キーワードマッチング | + LLM クエリ展開（約 97% 再現率） |
| **自動キャプチャ** | ルールベースのパターン | + LLM が決断・学びを抽出 |
| **圧縮** | 利用不可 | `consolidate` で冗長なメモリを圧縮 |
| **コスト** | 無料・API キー不要 | 検索 1 回約 $0.0001（Haiku） |

---

## 全 8 つのメモリツール

| ツール | 機能 |
|------|-------------|
| `remember` | 観察記録・関係性・タグとともに知識を保存 |
| `recall` | 多因子スコアリングと LLM クエリ展開によるスマート検索 |
| `forget` | ソフトアーカイブ（完全削除なし）または特定の観察記録を削除 |
| `consolidate` | LLM を使って冗長なメモリを圧縮 |
| `export` | メモリを JSON でプロジェクトやチームメンバーと共有 |
| `import` | マージ戦略（スキップ / 上書き / 追加）を選んでメモリをインポート |
| `learn` | ミスから構造化されたレッスンを記録（エラー、根本原因、修正方法、予防策） |
| `user_patterns` | 作業パターンを分析 — スケジュール、ツール、強み、学習分野 |

---

## アーキテクチャ

```
                    ┌─────────────────┐
                    │   Core Engine   │
                    │  (8 operations) │
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

コアはフレームワーク非依存。ターミナル・HTTP・MCP のいずれから呼び出しても、同じロジックが実行されます。

---

## コントリビュート

```bash
git clone https://github.com/PCIRCLE-AI/memesh-llm-memory
cd memesh-llm-memory && npm install && npm run build
npm test -- --run    # 413 tests
```

ダッシュボード：`cd dashboard && npm install && npm run dev`

---

<p align="center">
  <strong>MIT</strong> — <a href="https://pcircle.ai">PCIRCLE AI</a> 制作
</p>
