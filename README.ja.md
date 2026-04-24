🌐 [English](README.md) | [繁體中文](README.zh-TW.md) | [简体中文](README.zh-CN.md) | [日本語](README.ja.md) | [한국어](README.ko.md) | [Português](README.pt.md) | [Français](README.fr.md) | [Deutsch](README.de.md) | [Tiếng Việt](README.vi.md) | [Español](README.es.md) | [ภาษาไทย](README.th.md)

<p align="center">
  <h1 align="center">MeMesh LLM Memory</h1>
  <p align="center">
    <strong>Claude Code と MCP coding agents のためのローカルメモリレイヤー。</strong><br />
    SQLite ファイル 1 つ。Docker 不要。クラウド不要。
  </p>
</p>

> この日本語 README は要点をまとめた案内版です。最新かつ完全な内容は [English README](README.md) を参照してください。

## 何を解決するのか

coding agent はセッションをまたぐと文脈を失いやすくなります。設計判断、バグ修正の経緯、過去の失敗、プロジェクト固有の制約を何度も説明し直すことになります。

**MeMesh はそれらの知識をローカルに残し、検索できる状態で保持し、あとから再利用できるようにします。**

この npm package は MeMesh のローカル plugin / package 版です。クラウドのワークスペース製品や企業向け基盤を含むものではありません。

## 60 秒で始める

### 1. インストール

```bash
npm install -g @pcircle/memesh
```

### 2. 判断を記録する

```bash
memesh remember --name "auth-decision" --type "decision" --obs "Use OAuth 2.0 with PKCE"
```

### 3. あとで呼び戻す

```bash
memesh recall "login security"
# → 言い回しが違っても "OAuth 2.0 with PKCE" を見つけられます
```

ダッシュボードを開くには:

```bash
memesh
```

## 誰に向いているか

- Claude Code を使い、セッション間でもプロジェクトの文脈を残したい開発者
- 同じローカルメモリを MCP coding agents 間で使い回したい上級ユーザー
- export / import でチーム知識を共有したい小規模な AI-native 開発チーム
- CLI、HTTP、MCP にローカルメモリを組み込みたい agent 開発者

## MeMesh を選ぶ理由

- ローカルファースト: データは自分の SQLite に保存
- 導入が軽い: `npm install -g` ですぐ使える
- 接続方法が明快: CLI、HTTP、MCP をサポート
- Claude Code と相性がよい: hooks により作業中の記憶呼び出しがしやすい
- 見える・整理できる: dashboard があるので中身を確認しやすい
- import の安全境界: import した記憶は検索できても、レビューや再保存を行うまでは Claude hooks へ自動注入されません

## Claude Code で自動的に行うこと

MeMesh は現在、次の 5 つのタイミングで役立ちます。

- セッション開始時に、関連する記憶と既知の教訓を読み込む
- ファイル編集前に、そのファイルやプロジェクトに関係する記憶を呼び出す
- `git commit` 後に、変更内容を記録する
- セッション終了時に、今回の修正やエラー、lesson learned を整理する
- context compact 前に、重要な内容をローカルメモリへ保存する

## Dashboard でできること

Dashboard には 7 つのタブがあり、11 言語に対応しています。

- Search: メモリ検索
- Browse: メモリ一覧
- Analytics: 健全性や傾向の確認
- Graph: 関係グラフの確認
- Lessons: 過去の教訓の確認
- Manage: アーカイブと復元
- Settings: LLM provider と言語設定

## Smart Mode とは

MeMesh はデフォルトでオフライン利用できます。さらに LLM API key を設定すると、次のような機能を有効にできます。

- query expansion
- より良い自動抽出
- より賢い整理や圧縮

API key がなくてもコア機能は使えます。

## さらに読む

- 完全な機能一覧、比較、API、release 情報: [English README](README.md)
- プラットフォーム別ガイド: [docs/platforms/README.md](docs/platforms/README.md)
- API リファレンス: [docs/api/API_REFERENCE.md](docs/api/API_REFERENCE.md)

## 開発と検証

```bash
git clone https://github.com/PCIRCLE-AI/memesh-llm-memory
cd memesh-llm-memory
npm install
npm run build
npm test
```
