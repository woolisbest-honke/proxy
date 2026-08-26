'use strict';

/**
 * リバースプロキシ・サーバー（Docker / Render / Railway / Koyeb / Heroku / Fly 等）
 *
 * .env（またはプラットフォームの環境変数）の TARGET_URL へ
 * すべての HTTP リクエストをそのまま転送する。HTTP / HTTPS 専用。
 *
 * 使い方:
 *   cp .env.example .env   # TARGET_URL を設定
 *   npm start
 */

require('dotenv').config();

const http = require('http');
const { createProxy } = require('./lib/proxy');

// ---------------------------------------------------------------------------
// 設定（環境変数 / .env）
// ---------------------------------------------------------------------------
const TARGET_URL = (process.env.TARGET_URL || '').trim();
const PORT = parseInt(process.env.PORT, 10) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const TLS_VERIFY = process.env.TLS_VERIFY !== 'false'; // false で自己署名証明書を許可
const LOG = process.env.LOG !== 'false';
const PROXY_TIMEOUT_MS = parseInt(process.env.PROXY_TIMEOUT_MS, 10) || 0;
const FORWARD_CLIENT_IP = process.env.FORWARD_CLIENT_IP === 'true';

if (!TARGET_URL) {
  console.error(
    '[proxy] TARGET_URL が設定されていません。`cp .env.example .env` で作成するか、\n' +
      '       プラットフォームの環境変数設定で TARGET_URL を指定してください。'
  );
  process.exit(1);
}

function log(msg) {
  if (LOG) console.log(`[proxy] ${new Date().toISOString()} ${msg}`);
}

let proxy;
try {
  proxy = createProxy({
    targetUrl: TARGET_URL,
    tlsVerify: TLS_VERIFY,
    forwardClientIp: FORWARD_CLIENT_IP,
    proxyTimeoutMs: PROXY_TIMEOUT_MS,
    log,
  });
} catch (err) {
  console.error(`[proxy] ${err.message}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// HTTP サーバー
// ---------------------------------------------------------------------------
const server = http.createServer((req, res) => {
  log(`${req.method} ${req.url}`);
  proxy.web(req, res);
});

server.keepAliveTimeout = 75_000; // ロードバランサー等のアイドルタイムアウトより長く
server.headersTimeout = 80_000;

server.listen(PORT, HOST, () => {
  const shown = new URL(TARGET_URL);
  console.log(`[proxy] Reverse proxy listening on http://${HOST}:${PORT}`);
  console.log(`[proxy] Forwarding all requests to ${shown.origin}${shown.pathname.replace(/\/+$/, '')}`);
  console.log(
    `[proxy] TLS verification: ${TLS_VERIFY ? 'on' : 'off'} / client IP forwarding: ${FORWARD_CLIENT_IP}`
  );
});

function shutdown() {
  console.log('[proxy] Shutting down...');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
