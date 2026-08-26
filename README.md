# reverse-proxy

環境変数 `TARGET_URL` に設定した URL へ、**すべてのリクエストをそのまま転送**するシンプルなリバースプロキシです。訪問者から見えるのはプロキシのアドレスだけで、元サイトの IP アドレスなどを隠すことができます。

- HTTP / HTTPS の転送に特化（WebSocket は非対応）
- パス・クエリ・ヘッダー・ボディをそのまま透過
- 主要 PaaS 用の設定ファイル同梱で、リポジトリを接続するだけでデプロイ可能

## できること

- すべての HTTP メソッド（GET / POST / PUT / PATCH / DELETE / OPTIONS / HEAD）を転送
- **API も丸ごと転送** — `/v1/models`、`/api/v1/stream/{id}` のようなパスはすべてそのまま転送されます
- **ストリーミング対応** — ボディをバッファせず流すので SSE（`text/event-stream`）やチャンク転送も逐次届きます
- リダイレクト（`Location` ヘッダー）をプロキシ経由の URL に自動書き換え → ブラウザがオリジンへ直接飛ぶのを防止
- `Set-Cookie` の `Domain` / `Secure` 属性を除去して、プロキシのドメインで Cookie が機能するように調整
- hop-by-hop ヘッダーの除去など RFC 準拠の基本処理
- ボディの中身（JSON / フォーム / SSE 等）は解釈・書き換えせずバイト列のまま転送

> [!NOTE]
> WASM やバイナリも特別な処理はしていません（ストリーム転送なので、必要になればそのまま流れます）。

## クイックスタート（ローカル）

```bash
cp .env.example .env   # .env を作成し TARGET_URL を編集
npm install
npm start              # http://localhost:3000 で待受
```

`.env` で `TARGET_URL=https://example.com` と設定すれば、`http://localhost:3000/v1/models?x=1` へのアクセスが `https://example.com/v1/models?x=1` にそのまま転送されます。

テスト: `npm test`（ローカル完結・外部ネットワーク不要）

### `TARGET_URL` のバリエーション

ポート付き・パス付きの URL もそのまま設定できます。パスを付けた場合は、リクエストのパスの先頭へ付与され、
リダイレクト（`Location`）と `Set-Cookie` の `Path` からは自動で剥がされます。

| `TARGET_URL` の設定値 | プロキシで `/main` を開いたときの転送先 |
|---|---|
| `https://example.com` | `https://example.com/main` |
| `http://example.com:8080` | `http://example.com:8080/main` |
| `https://example.com/blob` | `https://example.com/blob/main` |
| `https://example.com/blob/` （末尾スラッシュ） | `https://example.com/blob/main` |
| `https://example.com/blob/deep` （多段パス） | `https://example.com/blob/deep/main` |

パス付き設定時の自動調整の例（`TARGET_URL=https://example.com/blob` の場合）:

- オリジンの `Location: https://example.com/blob/hello` → プロキシは `/hello` を返す（ブラウザがオリジンへ直接飛ばない）
- オリジンの `Set-Cookie: session=x; Path=/blob; Secure` → `session=x; Path=/` として返す

## 設定（環境変数 / .env）

| 変数 | 既定値 | 説明 |
|---|---|---|
| `TARGET_URL` | （必須） | 転送先の URL。`http://` / `https://`。ポート付き・パス付きも可（下記参照）。クエリ文字列（`?a=b`）は無視されます |
| `HOST` | `0.0.0.0` | 待ち受けアドレス |
| `PORT` | `3000` | 待ち受けポート（大半の PaaS は自動で `PORT` を渡します） |
| `TLS_VERIFY` | `true` | `false` にすると転送先の自己署名証明書を許可 |
| `PROXY_TIMEOUT_MS` | `30000` | 転送先の応答待ちタイムアウト（ms）。`0` で無効 |
| `FORWARD_CLIENT_IP` | `false` | `true` にすると転送先へ `X-Forwarded-For` などを送信（既定ではクライアント IP を通知しません） |
| `LOG` | `true` | アクセスログの表示 |

## デプロイ

共通の手順は **「リポジトリを接続 → 環境変数 `TARGET_URL` を設定 → デプロイ」** だけです。
すべてのプラットフォームで `PORT` は自動割り当てに対応しています。

| プラットフォーム | 設定ファイル | 手順の要点 |
|---|---|---|
| [Render](https://render.com) | `render.yaml` | New > Blueprint でリポジトリを選択。`TARGET_URL` は入力を求められる |
| [Railway](https://railway.app) | `railway.json` | `railway up` または GitHub 連携。変数 `TARGET_URL` を設定 |
| [Vercel](https://vercel.com) | `vercel.json` + `api/[...path].mjs` | `vercel env add TARGET_URL`（※サーバーレス。詳細は下記） |
| [Koyeb](https://koyeb.com) | `Procfile` / `Dockerfile` | CLI 例は下記。変数 `TARGET_URL` を設定 |
| [Heroku](https://heroku.com) | `Procfile` / `app.json` / `heroku.yml` | Deploy to Heroku ボタン（下記）または CLI |
| [Fly.io](https://fly.io) | `fly.toml` | `fly launch` → `fly secrets set TARGET_URL=...` → `fly deploy` |
| [DigitalOcean](https://www.digitalocean.com) | `.do/app.yaml` | repo と `TARGET_URL` を書き換えて `doctl apps create --spec .do/app.yaml` |
| [Netlify](https://netlify.com) | `netlify.toml` | 環境変数 `TARGET_URL` を設定（エッジリライト方式。詳細は下記） |
| Docker（自前サーバー等） | `Dockerfile` / `docker-compose.yml` | `docker compose up --build -d` |

> Coolify / Zeabur / Northflank など、Dockerfile や Procfile を認識するプラットフォームでもそのまま動作します。

### Render

1. ダッシュボードで **New > Blueprint** → このリポジトリを選択
2. `TARGET_URL` を入力して Apply（`render.yaml` の Blueprint を利用）

### Railway

```bash
railway init
railway variables set TARGET_URL=https://example.com
railway up
```

### Vercel

```bash
npm i -g vercel
vercel env add TARGET_URL          # 本番にも: vercel env add TARGET_URL production
vercel deploy --prod
```

- すべてのパスが `vercel.json` のリライトで `api/[...path].mjs` に集約され、そこから `TARGET_URL` へ転送されます
- **サーバーレスのため実行時間上限**（`maxDuration: 60`）があります。長時間のストリーミング（`/api/v1/stream/{id}` など）を安定して流すには、Render / Railway / Fly / Koyeb などの常駐型を推奨します
- プランの上限が 60 秒未満の場合は `api/[...path].mjs` 内の `maxDuration` を下げてください

### Koyeb

```bash
koyeb app init reverse-proxy \
  --git github.com/<user>/proxy \
  --git-branch main \
  --git-buildpack-run-command "npm start" \
  --ports 8000:http \
  --routes /:8000 \
  --env PORT=8000 \
  --env TARGET_URL=https://example.com
```

（Dockerfile ビルドも利用可能: `--git-builder docker`）

### Heroku

Deploy to Heroku ボタン用の `app.json` あり:

[![Deploy](https://www.herokucdn.com/deploy/button.svg)](https://heroku.com/deploy?template=https://github.com/woolisbest-honke/proxy)

```bash
heroku create your-app-name
heroku config:set TARGET_URL=https://example.com
git push heroku main
# container スタック（heroku.yml / Dockerfile）を使う場合:
#   heroku stack:set container
```

### Fly.io

```bash
fly launch          # fly.toml を検出。app 名は一意のものへ変更
fly secrets set TARGET_URL=https://example.com
fly deploy
```

### DigitalOcean App Platform

`.do/app.yaml` の `repo` と `TARGET_URL` の `value` を書き換えて:

```bash
doctl apps create --spec .do/app.yaml
```

### Netlify（エッジリライト方式）

Netlify のリダイレクトは環境変数を直接展開できないため、公式ワークアラウンドどおり
ビルド時に `sed` で `netlify.toml` の `__TARGET_URL__` を差し替えます。

1. ダッシュボードで環境変数 `TARGET_URL` を設定（Builds スコープ）
2. Git からデプロイ

※ この方式は Netlify エッジの透過転送のため、`Location` や `Set-Cookie` の書き換えは行われません。それらが必要なら他プラットフォームを使ってください。

## 注意点・限界

- **HTML / JS 内の絶対 URL は書き換えません。** ページ内に `https://元サイト.com/...` が埋め込まれていると、そこへは直接アクセスされます。
- `Origin` / `Referer` を厳密に検証するサイト、HTTP/2 が必須のサイトでは正しく動かない場合があります。
- 元サイトの IP を本当に隠すには、オリジン側のファイアウォールで「プロキシの IP からのアクセスのみ」を許可してください（DNS 履歴から元 IP が判明しているケースもあるため）。
- 同一ドメインでの運用を想定しています。Cookie まわり（`__Secure-` / `__Host-` 接頭辞など）で一部制限が出るサイトがあります。

詳細は [SECURITY.md](SECURITY.md) を参照してください。

## ファイル構成

```
server.js               プロキシサーバー本体（常駐型プラットフォーム用）
lib/proxy.js            転送ロジック（server.js と Vercel 関数の共通部品）
api/[...path].mjs       Vercel Serverless Function
test/run-tests.js       自動テスト（npm test）
.env.example            環境変数テンプレート
Dockerfile              Docker 用
docker-compose.yml      Docker Compose 用
render.yaml             Render
railway.json            Railway
vercel.json             Vercel
Procfile                Heroku / Koyeb / Render 等
app.json                Heroku Deploy ボタン
heroku.yml              Heroku（container スタック）
fly.toml                Fly.io
.do/app.yaml            DigitalOcean App Platform
netlify.toml            Netlify
SECURITY.md             セキュリティポリシー
LICENSE                 MIT License
```

## ライセンス

[MIT](LICENSE)
