🌐 [English](README.md) | [繁體中文](README.zh-TW.md) | [简体中文](README.zh-CN.md) | [日本語](README.ja.md) | [한국어](README.ko.md) | [Português](README.pt.md) | [Français](README.fr.md) | [Deutsch](README.de.md) | [Tiếng Việt](README.vi.md) | [Español](README.es.md) | [ภาษาไทย](README.th.md)

<p align="center">
  <h1 align="center">MeMesh LLM Memory</h1>
  <p align="center">
    <strong>Claude Code と MCP コーディングエージェント向けのローカルメモリ</strong><br />
    SQLite ファイル 1 つ。Docker も クラウドも不要。
  </p>
  <p align="center">
    <a href="https://www.npmjs.com/package/@pcircle/memesh"><img src="https://img.shields.io/npm/v/@pcircle/memesh?style=flat-square&color=3b82f6&label=npm" alt="npm" /></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-22c55e?style=flat-square" alt="MIT" /></a>
    <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%3E%3D20-22c55e?style=flat-square" alt="Node" /></a>
    <a href="https://modelcontextprotocol.io"><img src="https://img.shields.io/badge/MCP-compatible-a855f7?style=flat-square" alt="MCP" /></a>
  </p>
</p>

---

> [!IMPORTANT]
> **活発に開発中のプロジェクト** — 機能は継続的に更新され、リリース間で変更される可能性があります。バグや機能要望がある場合は[issue を開いてください](https://github.com/PCIRCLE-AI/memesh-llm-memory/issues)。

## 課題

コーディングエージェントはセッション間で記憶を失います。アーキテクチャの決定、バグ修正、テスト失敗、苦労して得た教訓 — すべてを毎回説明し直さなければなりません。Claude Code はいつも初期状態から始まり、既に知っているはずの制約を再発見し、貴重なコンテキストを無駄にします。

**MeMesh は、コーディングエージェントに永続的で検索可能な進化するローカルメモリを与えます。**

このパッケージは MeMesh プロダクトファミリーのローカルメモリ層です。意図的にシンプルでオープンソース設計になっています。npm でインストール、メモリを `~/.memesh/knowledge-graph.db` に保存、Claude Code や MCP 互換クライアントに接続するだけ。ホステッドワークスペースやエンタープライズ向けのプロダクトは、このパッケージの README やロードマップとは分離して提供されます。

---

## エビデンス — LongMemEval-S で 95.40% R@5

MeMesh の検索エンジンは **FTS5 のみ**(LLM もホットパスのエンベディングも使用しない)で、公開されている [LongMemEval-S](https://huggingface.co/datasets/xiaowu0162/longmemeval) ベンチマーク(500 問、MIT ライセンス)で測定された結果です:

| システム | R@5 | ソース |
|---|---|---|
| **MeMesh (Mode A, FTS5)** | **95.40%** | [benchmarks/longmemeval/RESULTS.md](benchmarks/longmemeval/RESULTS.md) |
| MemPalace | 96.6% | ベンダー自社申告 |
| Supermemory | ~82% | ベンダー推定値 |
| Zep | 63.8% | LongMemEval 論文 |
| Mem0 | 49.0% | LongMemEval 論文 |

再現コマンド、データセット SHA256、問題ごとの生結果、既知失敗の分析はすべて [`benchmarks/longmemeval/`](benchmarks/longmemeval/) にあります。約 10 秒で再実行可能です。

---

## インストールパス早見表

MeMesh には**共存する 2 つのインストールパス**があります。ほとんどのユーザーは両方が必要です。両者は**同じメモリデータベース**（`~/.memesh/knowledge-graph.db`）に書き込むため、Claude Code チャットで捕捉した記憶がシェルにも反映され、逆も同様です。

```mermaid
flowchart TB
    classDef client fill:#1f2937,stroke:#4b5563,color:#f9fafb,stroke-width:1px
    classDef pathA  fill:#1e3a8a,stroke:#3b82f6,color:#eff6ff,stroke-width:2px
    classDef pathB  fill:#14532d,stroke:#22c55e,color:#f0fdf4,stroke-width:2px
    classDef db     fill:#7c2d12,stroke:#f97316,color:#fff7ed,stroke-width:2px

    subgraph clients["Where you use memesh from"]
      direction LR
      CC["Claude Code<br/>(chat + agent)"]:::client
      TERM["Terminal / other<br/>MCP clients<br/>(Cursor, Cline...)"]:::client
    end

    subgraph paths["Two install paths"]
      direction LR
      A["<b>Path A — /plugin install</b><br/>───────────────<br/>Lives in <code>~/.claude/plugins/</code><br/><br/>• MCP tools in chat<br/>• Auto-capture hooks<br/>• <code>/memesh</code> skill<br/>• Session-start banner"]:::pathA
      B["<b>Path B — npm install -g</b><br/>───────────────<br/>Lives in <code>$(npm prefix -g)/bin/</code><br/><br/>• <code>memesh</code> shell command<br/>• <code>memesh-mcp</code>, <code>-http</code>, <code>-view</code> bins<br/>• For Cursor / Cline / other MCP"]:::pathB
    end

    DB[("Shared memory DB<br/><code>~/.memesh/knowledge-graph.db</code><br/>Same data, both paths see it")]:::db

    CC -->|uses| A
    TERM -->|uses| B
    A --> DB
    B --> DB
```

**どちらが必要？**

| やりたいこと | インストールパス |
|---|---|
| Claude Code の会話で `/memesh` skill を使う | Path A（プラグイン）|
| Claude Code で自動キャプチャ（session → 学習 → 次回リコール） | Path A（プラグイン）|
| ターミナルで `memesh remember` / `memesh recall` / `memesh doctor` を実行 | Path B（npm-global）|
| `memesh` でダッシュボードを直接起動（`npx` 起動遅延なし） | Path B（npm-global）|
| `memesh-mcp` を Cursor、Cline、その他の MCP クライアントに接続 | Path B（npm-global）|
| すべて | **両方インストール** — 競合しません |

> **よくある誤解**：Claude Code のプラグインは **`memesh` をシェルの `PATH` には追加しません**。`/plugin install` だけを実行して、ターミナルで `memesh reindex` と打つと `command not found` が出ます。これは仕様です — シェルコマンドを使うには `npm install -g @pcircle/memesh` も必要です。

### ⚠️ プラグインのインストールでは CLI は入りません

最もよくある混乱です。一度読んでおけば、後で時間を節約できます：

- Claude Code 内で `/plugin install memesh@pcircle-memesh` → **Path A のみ**インストール。MCP ツール、hooks、`/memesh` skill が手に入ります。`memesh` はシェルの `PATH` には**入りません**。
- ターミナルで `memesh reindex` / `memesh update` / `memesh doctor` → **Path B**（npm-global）が必要。なければ `zsh: command not found: memesh`。
- **Claude Code ユーザーへの推奨セットアップ**：**両方インストール**。共存し、同じデータベースを共有し、競合しません。

```bash
# /plugin install ... の後、これも実行：
npm install -g @pcircle/memesh
```

Claude Code の会話だけで memesh を使う場合（ターミナルで `memesh` を打たない場合）、Path A だけで十分です。それ以外の方は両方インストールしてください。

---

## 60 秒で始める

### オプション A — Claude Code プラグイン(ワンライナーインストール)

Claude Code を使っている場合、CLI 内から MeMesh をプラグインとしてインストールできます:

```
/plugin marketplace add PCIRCLE-AI/memesh-llm-memory
/plugin install memesh@pcircle-memesh
```

Claude Code がフック、スキル、MCP サーバーを自動的にワイヤリングします。セッション内自動キャプチャ、プロアクティブリコール、Claude Code 会話内の `/memesh` スキル(remember / recall / learn / forget)、エージェント向け MCP ツールとしての `remember` / `recall` / `forget` / `learn` がすべて使えるようになります。CLI とローカルダッシュボードもグローバルインストールなしで完全にアクセス可能です — `npx @pcircle/memesh <command>` であらゆる CLI コマンドが実行でき、`npx @pcircle/memesh` で `localhost:3737` のダッシュボードが起動します。MCP サーバーはプラグイン同梱のコンパイル済みコードから直接起動します — `npx` ルックアップ、`npm install -g`、ビルド手順はいずれも不要です。最初の起動時に `better-sqlite3` のネイティブバインディングが見つからない場合(例: Node のメジャーバージョン更新後)、ランチャーがインプロセスで自動的にリビルドして処理を継続します。

### オプション B — npm グローバル(オプションの最適化)

シェルの `PATH` にバイナリを直接配置したい場合(`memesh`、`memesh-mcp` 等が任意のターミナルで `npx` ルックアップなしに動作)、または `memesh-mcp` を **Claude Code 以外の MCP クライアント**(Cursor、Cline、ターミナル専用フロー)に固定パスの stdio コマンドとして公開したい場合:

```bash
npm install -g @pcircle/memesh
```

> **初回インストールに関する注意(一度きり):**
> - **ネイティブモジュール** — `better-sqlite3` と `sqlite-vec` は macOS (arm64/x64)、Linux (x64/arm64)、Windows x64 でビルド済みバイナリ経由でインストールされます。珍しいプラットフォームやビルド済みバイナリが失敗した場合は、動作する C/C++ ツールチェインが必要です。
> - **エンベディングモデル** — ローカルエンベディングをトリガーする最初の呼び出し(例: セマンティックモードでの `recall`)で `Xenova/all-MiniLM-L6-v2`(~80 MB)が `~/.memesh/models/` にダウンロードされます。以降の呼び出しは即時です。デフォルトの検索パス(FTS5)はこのダウンロードを必要としません。

### ステップ 1.5: MeMesh を Claude Code に接続(npm パスのみ)

**オプション A**(`/plugin install memesh@pcircle-memesh`)でインストールした場合はこのステップをスキップしてください — Claude Code がプラグインフックを自動的にワイヤリングします。

**オプション B**(`npm install -g`)でインストールした場合、CLI は PATH に配置され MCP サーバーは登録されますが、Claude Code セッションフックは自動的にはワイヤリングされません。フックがないと `memesh remember` / `recall` は手動で使えますが、**自動キャプチャループ**(セッション → レッスン → 次のセッションで自発的にリコール)はサイレントになります。

```bash
memesh install-hooks         # ~/.claude/settings.json に memesh フックを追加
memesh doctor                # "Hooks wired into Claude Code" が PASS になることを確認
```

これらのフックは既存の `~/.claude/hooks/` カスタムフックと共存します — `install-hooks` は追加方式で書き込み、既存のものを上書きしません。削除する場合: `memesh uninstall-hooks`。

### ステップ 2: 決定を記録

> 以下の bash 例は `memesh` が `PATH` 上にあること(オプション B)を前提にしています。オプション A(プラグイン専用)のユーザーには等価な 2 つのパスがあります: Claude Code 会話内で尋ねる(`/memesh` スキル + MCP ツールが同じフローをカバー)か、任意のシェルで `memesh` を `npx @pcircle/memesh` に置き換える — フラグは同じで、グローバルインストール不要です。

```bash
memesh remember "Use OAuth 2.0 with PKCE for the new auth"
```

または、後でフィルタリングしたい場合に安定した名前と型を付ける明示形式:

```bash
memesh remember --name "auth-decision" --type "decision" --obs "Use OAuth 2.0 with PKCE"
```

### ステップ 3: あとで思い出す

```bash
memesh recall "login security"
# → 別の単語で検索しても「OAuth 2.0 with PKCE」が見つかります
```

**これだけです。** MeMesh がセッション間でメモリを保持・検索し始めます。

インストールと接続をエンドツーエンドで確認したい場合:

```bash
memesh doctor
```

ダッシュボードを開いてメモリを探索します:

```bash
memesh
```

<p align="center">
  <img src="docs/images/dashboard-search.png" alt="MeMesh Search — any memory instantly" width="100%" />
</p>

<p align="center">
  <img src="docs/images/dashboard-analytics.png" alt="MeMesh Analytics — health score, timeline, patterns, knowledge coverage" width="100%" />
</p>

<p align="center">
  <img src="docs/images/dashboard-graph.png" alt="MeMesh Graph — interactive knowledge graph with type filters and ego mode" width="100%" />
</p>

---

## こんな方向けです

| あなたが... | MeMesh でできること |
|-----------|-----------------|
| **Claude Code を使う開発者** | プロジェクト判断、ファイル固有の知見、過去の失敗が自動で呼び出される |
| **コーディングエージェントのパワーユーザー** | 1 つのローカルメモリレイヤーを MCP 互換ツール全体で共有 |
| **AI コーディングワークフローを実験中のチーム** | ホステッドインフラを導入せず、プロジェクト知識をエクスポート・インポート |
| **エージェント開発者** | MCP、HTTP、CLI、Python SDK 経由でローカルメモリを追加 |

---

## コーディングエージェント向けに設計

<table>
<tr>
<td width="33%" align="center">

**Claude Code / Desktop**
```bash
memesh-mcp
```
MCP ツール + Claude Code フック

</td>
<td width="33%" align="center">

**HTTP クライアント**
```bash
curl localhost:3737/v1/recall \
  -H "Content-Type: application/json" \
  -d '{"query":"auth"}'
```
`memesh serve` (REST API)

</td>
<td width="33%" align="center">

**任意の LLM (OpenAI 形式)**
```bash
memesh export-schema \
  --format openai
```
ツールを任意の API 呼び出しに貼り付け可能

</td>
</tr>
</table>

---

## OpenMemory、Cursor Memories、Mem0、Zep との違い

| | **MeMesh** | OpenMemory | Cursor Memories | Mem0 | Zep / Graphiti |
|---|---|---|---|---|---|
| **最適な用途** | コーディングエージェント向けローカルメモリ | ローカル・クロスクライアント MCP メモリ | Cursor ネイティブプロジェクトメモリ | 管理型アプリ・エージェントメモリ | テンポラル知識グラフ |
| **インストール形態** | `npm install -g @pcircle/memesh` | ローカルアプリ・サーバーフロー | Cursor ビルトイン | クラウド API / SDK / MCP | サービス・フレームワークセットアップ |
| **ストレージ** | 1 つのローカル SQLite ファイル | ローカルメモリスタック | Cursor 管理ルール・メモリ | ホステッド・セルフホスト型スタック | グラフデータベース |
| **クラウド必須** | いいえ | ローカルモードなら不要 | Cursor アカウント設定による | プラットフォーム利用時は必須 | 通常は必須・セルフホスト可能 |
| **Claude Code フック** | 第一級 | MCP ツール | いいえ | MCP ツール | Claude Code 専用ではない |
| **ダッシュボード** | ビルトイン | ビルトイン | Cursor 設定 | プラットフォームダッシュボード | プラットフォーム・グラフツール |
| **トレードオフ** | シンプルなローカル構成、エンタープライズスケールは非対応 | より広いローカルアプリフットプリント | Cursor に限定 | 強力な管理プラットフォーム、ローカルファースト性が低い | 強力なグラフモデル、セットアップが重い |

**MeMesh は、エンタープライズスケールの管理インフラストラクチャと引き換えに、即座のローカルセットアップ、検査可能なストレージ、コーディングエージェントワークフロー統合を選びました。**

---

## Claude Code での自動動作

すべてを手動で記録する必要はありません。MeMesh に **7 つのフック** があり、作業中に知識を自動キャプチャ・注入します:

| タイミング | MeMesh の動作 |
|---------|-----------|
| **セッション開始時** | 最も関連の高いメモリ + 過去の教訓から得た予防警告をロード |
| **ファイル編集前** | ファイルまたはプロジェクト関連のメモリをリコール (Claude がコード執筆前) |
| **bash コマンド実行前** | (オプトイン)高い検証性を持つコマンド(テスト、ビルド、lint、マイグレーション、デプロイ、ベンチマーク)をバックグラウンドエージェントとして実行するよう Claude を促す |
| **記憶を依頼したとき** | "remember this" / "guardar en memesh" / "sauvegarder dans memesh" / "記下來" の意図(5 言語)を検出し、Claude に memesh 使用をリマインド |
| **`git commit` 後** | 変更内容と diff 統計を記録 |
| **Claude 停止時** | 編集ファイル、修正エラー、失敗から自動生成した構造化教訓をキャプチャ |
| **コンテキスト圧縮前** | コンテキスト限界で失われる前に知識を保存 |

> **いつでも無効化可能:** `export MEMESH_AUTO_CAPTURE=false`

---

## 設定

すべての設定は環境変数経由です。デフォルトはローカル専用・ネットワークなしで、何も設定せずに動作するシステムが手に入ります。

| 変数 | デフォルト | 動作 |
|---|---|---|
| `MEMESH_DB_PATH` | `~/.memesh/knowledge-graph.db` | SQLite データベースの保存場所を上書き。 |
| `MEMESH_AUTO_CAPTURE` | `true` | 自動キャプチャフック(`Stop`、`PreCompact`)を完全に無効化。 |
| `MEMESH_AUTO_DETECT_LLM` | 未設定(自動検出**オン**) | `0` に設定すると、シェル環境で見つかった API キーを memesh が使用しなくなります。デフォルトでは、`ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `OLLAMA_HOST` が設定されていて `~/.memesh/config.json` にプロバイダを構成していない場合、memesh は書き込み側の LLM 機能(統合、レッスン抽出、自動タグ付け、dream)にそれを使用します。エンベディングは影響を受けません — `embedder.provider` を明示的に設定しない限りローカル ONNX(384 次元)のままです。 |
| `MEMESH_ENABLE_AGENTIC_ORCHESTRATION` | 未設定 | `1` に設定すると、実験的なワーキングモデルプロトコル(CTO / Orchestrator / Agents のフレーミング)が有効になります。セッション開始バナー、Bash コマンドの促し、`verify_agent_work` テレメトリが追加されます。プロトコルの有効性は計測中であり、まだ証明されていません — 参加したい場合のみオプトイン。**デフォルトは OFF**: コアメモリ機能はこのフラグなしで動作します。 |
| `MEMESH_AUTO_UPDATE` | `off` | 自動更新ポリシー。`off`(デフォルト)は自動更新を行いません。`patch` は `X.Y.Z → X.Y.Z+N` を許可、`minor` は `X.Y.Z → X.Y+1.0` を追加、`major` は任意のバンプを許可。許可されている場合、デタッチ実行された `npm install -g` がセッション終了時(Stop フック)に発火するため作業をブロックしません — 結果は `~/.memesh/auto-update.log` に記録されます。`~/.memesh/config.json` の `autoUpdate` でも設定可能(env が優先)。インストール済みバージョンがメンテナーによって非推奨化された場合(セキュリティアドバイザリ)、`off` でも `patch` は強制的に許可されます — minor / major バンプはサイレントな挙動変化を避けるため手動のままです。 |
| `OPENAI_API_KEY` | 未設定 | OpenAI のキー。`MEMESH_AUTO_DETECT_LLM=0` を設定するか、明示的にプロバイダを設定しない限り、LLM 機能で自動的に使用されます。 |
| `OLLAMA_HOST` | `http://localhost:11434` | ローカル Ollama プロバイダ使用時の Ollama エンドポイントを上書き。 |

`memesh doctor` は解決された設定を表示するため、何が有効かを確認できます。

npm がインストール済みバージョンを非推奨としてフラグした場合(典型的にはセキュリティアドバイザリ)、次のセッション開始時に強い `⚠️ MeMesh <ver> is DEPRECATED` バナーが先頭に表示され、`memesh update-status` がアップグレードまで同じ行を表示し続けます。チェックは `~/.memesh/update-check.<version>.json` にキャッシュされ、一時的なネットワーク障害で警告が薄まらないようになっています。

---

## ダッシュボード

8 つのタブ、11 言語対応、外部依存なし。サーバー実行中は `http://localhost:3737/dashboard` でアクセス可能。

| タブ | 表示内容 |
|-----|--------|
| **Insights** | メモリインサイト — dreamer エンジンによる週次サマリーとパターン提案。ワンクリックで承認・拒否 |
| **Search** | 全メモリ対象の全文検索 + ベクトル類似度検索 |
| **Browse** | ページネーション表示された全エンティティ、アーカイブ・復元機能 |
| **Analytics** | メモリ健全性スコア、30 日間タイムライン、PM ベロシティ + KG 接続性指標、作業パターン、クリーンアップ提案 |
| **Graph** | インタラクティブ力指向知識グラフ、型フィルタ、検索、エゴモード、再度ヒートマップ |
| **Lessons** | 過去の失敗から構造化された教訓 (エラー、根本原因、修正、予防) |
| **Manage** | エンティティのアーカイブ・復元 |
| **Settings** | LLM プロバイダ設定、言語セレクタ |

---

## スマート機能

**🧠 スマート検索** — 「login security」で検索すると「OAuth PKCE」についてのメモリが見つかります。MeMesh は設定された LLM を使い、クエリを関連用語で拡張します。

**📊 スコア付きランキング** — 関連性 (30%) + 新しさ (25%) + 頻度 (15%) + 信頼度 (15%) + リコール影響度 (10%) + 時間的有効性 (5%) でランク付け。

**🔄 知識の進化** — 判断は変わります。`forget` で古いメモリをアーカイブ (削除されない)。`supersedes` 関係で古い → 新しい をリンク。AI は常に最新版を参照します。

**⚠️ 矛盾検出** — 互いに矛盾するメモリが 2 つある場合、MeMesh が警告します。

**🕸️ ナレッジグラフ接続性** — `memesh kg backfill-relations --all-rules` はタグの共起・プロジェクトクラスタリング・セッションコンテキスト・名前類似度を使って孤立エンティティをリンク — LLM 不要。代表的なナレッジベースで孤立率を 89% から 12% 未満に削減。

**📦 チーム共有** — `memesh export > team-knowledge.json` → チームと共有 → `memesh import team-knowledge.json`。
インポートされたバンドルは検索可能ですが、MeMesh はレビュー・ローカル再保存まで Claude フックへの自動注入はしません。

---

## 使用例

> 「MeMesh が 3 週間前に PKCE と implicit フロー間で PKCE を選んだことを覚えていました。再び認証について Claude に聞いた時、すでに知っていました — 説明し直す必要がなかった。」
> — **SaaS 構築中のソロ開発者**

> 「毎週金曜日にチームのメモリをエクスポート、月曜日にインポートします。全員の Claude は先週チームが学んだことを知った状態で週を始めます。」
> — **3 人スタートアップ、共有知識ベース**

> 「ダッシュボードで、メモリの 90% が自動生成セッションログだったことに気づきました。アーキテクチャ判断向けに意図的に `remember` を使い始めました。ゲームチェンジャーです。」
> — **Analytics タブを発見した開発者**

---

## スマートモードをアンロック (オプション)

MeMesh はデフォルトでオフライン動作します — リコールは厳密に LLM フリーのまま(箱出し状態で LongMemEval-S 95.40% R@5)。LLM API キーを追加するのは、その上に LLM 拡張の分析フローを重ねたい場合のみです: より賢いセッション抽出、新規メモリの自動タグ付け、失敗からのレッスン生成、`consolidate` / `dream` 圧縮:

```bash
memesh config set llm.provider anthropic
memesh config set llm.api-key sk-ant-...
```

またはダッシュボード Settings タブで視覚的にセットアップ:

```bash
memesh  # ダッシュボード → Settings タブを開く
```

### 独自のエンベディングを使う(任意)

エンベディングはデフォルトでローカル ONNX モデル(`Xenova/all-MiniLM-L6-v2`、384 次元)を使用します — API キー不要、データは端末外に出ず、デフォルトの FTS5 リコールはそもそも不要です。ホスト型またはローカルサーバーのエンベダーを使うには:

```bash
memesh config set embedder.provider openai          # or: ollama
memesh config set embedder.model text-embedding-3-small
```

エンベダーは**チャット LLM とは独立して**構成されます — `llm.provider` を変更してもエンベディングが黙って変わることはありません。異なる次元(例: 384 → 1536)に切り替えると、MeMesh は次回の書き込み時にベクトルインデックスを自動的に再構築します。対応する `embedder.provider`: `onnx`(デフォルト、ローカル)、`openai`、`ollama`。

| | レベル 0 (デフォルト) | レベル 1 (スマートモード) |
|---|---|---|
| **検索** | FTS5 + sqlite-vec、95.40% R@5(~18ms/クエリ) | 変更なし — リコールはどのレベルでも LLM フリー |
| **自動キャプチャ** | ルールベースパターン | + LLM が判断・教訓を抽出 |
| **自動タグ付け** | 手動タグのみ | + LLM が新規メモリにタグを生成 |
| **失敗分析** | 利用不可 | + LLM がセッションエラーを構造化教訓に変換 |
| **圧縮** | 利用不可 | `consolidate` + `dream` が冗長メモリを圧縮 |
| **コスト** | 無料、API キー不要 | 分析呼び出しあたり ~$0.0001(Haiku) |

---

## 9 つのメモリツール全覧

| ツール | 機能 |
|------|------|
| `remember` | 観察、関係、タグ付きで知識を保存 |
| `recall` | FTS5 + sqlite-vec 検索、多要素スコアリング(関連性、新しさ、頻度、信頼度、時間的有効性) — ホットパスに LLM なし |
| `forget` | ソフトアーカイブ (削除されない) または特定の観察を削除 |
| `consolidate` | LLM が冗長メモリを圧縮 |
| `export` | メモリを JSON でシェア (プロジェクト・チーム間) |
| `import` | マージ戦略付きメモリインポート (スキップ / 上書き / 追記) |
| `learn` | ミスから構造化教訓を記録 (エラー、根本原因、修正、予防) |
| `user_patterns` | 作業パターンを分析 — スケジュール、ツール、強み、学習領域 |
| `verify_agent_work` | バックグラウンドエージェント作業の検証レポートを永続化、`git diff` で主張を現実チェック |

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

コアはフレームワーク非依存。ターミナル、HTTP、MCP から同じロジックで動作します。

---

## アップグレード

Claude Code の plugin marketplace はインストール時にバージョンを固定し、**自動更新しません**。新しいリリースを取得するには：

**オプション A — `/plugin` UI**：`memesh@pcircle-memesh` をアンインストールして再インストール。Claude Code が marketplace の最新バージョンを取得します。

**オプション B — ワンラインスクリプト**（UI クリック不要、冪等）：

```bash
# plugin が v4.2.5 以降なら、スクリプトは同梱済み：
bash ~/.claude/plugins/cache/pcircle-memesh/memesh/<current-version>/scripts/upgrade-plugin.sh

# v4.2.5 より前（つまり v4.2.4 または v4.2.3）のインストールの場合、
# スクリプトはまだ plugin に入っていません。npm-global の副本を使用：
bash "$(npm prefix -g)/lib/node_modules/@pcircle/memesh/scripts/upgrade-plugin.sh"

# （`npm install -g @pcircle/memesh` も実行済みであることを前提とします。
# まだなら、ちょうど良い機会です — 上の「インストールパス早見表」セクションで、
# 多くのユーザーが両方のパスを必要とする理由を確認してください。）
```

スクリプトは marketplace cache を fast-forward し、新バージョンを `~/.claude/plugins/cache/` に展開し、runtime deps をインストールし、`installed_plugins.json` を新バージョンに向け直します。完了後、MCP server が再接続するように Claude Code を再起動してください。

**npm-global インストール**（`npm install -g @pcircle/memesh`）は `memesh update` で自動更新できます。Source checkouts：`git pull && npm install && npm run build`。

セッション開始時、新しいリリースがあると 1 行のバナーが表示されます（バージョンごとに 24 時間スロットル）。`memesh doctor` はアップグレードターゲットとチャンネル固有のコマンドを報告します。

---

## コントリビュート

```bash
git clone https://github.com/PCIRCLE-AI/memesh-llm-memory
cd memesh-llm-memory && npm install && npm run build
npm test             # 630 tests
npm run test:e2e-dashboard
```

ダッシュボード: `cd dashboard && npm install && npm run dev`

---

<p align="center">
  <strong>MIT</strong> — Made by <a href="https://pcircle.ai">PCIRCLE AI</a>
</p>
