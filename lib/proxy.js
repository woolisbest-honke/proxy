'use strict';

/**
 * リバースプロキシ本体（HTTP / HTTPS 専用）
 *
 * TARGET_URL に指定したオリジンへ、リクエストをそのまま転送する。
 * サーバー (server.js) とサーバーレス関数 (api/[...path].mjs) の両方から使う。
 */

const httpProxy = require('http-proxy');

// hop-by-hop ヘッダー（プロキシが消費すべきもの。RFC 7230 準拠）
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

function stripHopByHop(headers) {
  const connectionTokens = String(headers.connection || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  const out = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower) || connectionTokens.includes(lower)) continue;
    out[key] = value;
  }
  return out;
}

/**
 * プロキシインスタンスを生成する。
 *
 * @param {object} options
 * @param {string}   options.targetUrl        転送先 URL（必須。http:// or https://。パス付き可）
 * @param {boolean}  [options.tlsVerify]      転送先 TLS 証明書を検証するか（既定: true）
 * @param {boolean}  [options.forwardClientIp] X-Forwarded-* を転送先へ付与するか（既定: false）
 * @param {number}   [options.proxyTimeoutMs] 転送先の応答待ちタイムアウト ms（既定: 0 = 無効）
 * @param {function} [options.log]            ログ関数（既定: 何もしない）
 * @returns {object} http-proxy のインスタンス
 */
function createProxy(options = {}) {
  const {
    targetUrl,
    tlsVerify = true,
    forwardClientIp = false,
    proxyTimeoutMs = 0,
    log = () => {},
  } = options;

  const target = new URL(String(targetUrl || '').trim());
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    throw new Error('TARGET_URL は http:// または https:// で始まる URL を指定してください。');
  }

  const targetOrigin = target.origin; // 例: https://example.com
  const targetBasePath = target.pathname.replace(/\/+$/, ''); // 例: '' または '/blog'

  // 転送先 URL が /base のようなパス付きの場合、Location からその部分を剥がす
  const stripBasePath = (pathname) => {
    if (!targetBasePath) return pathname;
    if (pathname === targetBasePath) return '/';
    if (pathname.startsWith(targetBasePath + '/')) return pathname.slice(targetBasePath.length);
    return pathname;
  };

  const proxy = httpProxy.createProxyServer({
    target: {
      protocol: target.protocol,
      host: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
    },
    changeOrigin: true, // Host ヘッダーを転送先のものに書き換える
    secure: tlsVerify, // 転送先の TLS 証明書を検証する
    xfwd: forwardClientIp, // true なら X-Forwarded-* を付与（既定では付けない）
    selfHandleResponse: true, // Location / Set-Cookie を書き換えるため自前で処理
    preserveHeaderKeyCase: true,
    ...(proxyTimeoutMs > 0 ? { proxyTimeout: proxyTimeoutMs } : {}),
  });

  // --- リクエスト転送時 ---
  proxy.on('proxyReq', (proxyReq, req) => {
    // TARGET_URL にパスが含まれる場合は先頭に付与する（/foo -> /base/foo）
    if (targetBasePath && req.url && req.url.startsWith('/')) {
      proxyReq.path = targetBasePath + req.url;
    }
  });

  // --- レスポンス返却時 ---
  proxy.on('proxyRes', (proxyRes, req, res) => {
    const headers = stripHopByHop(proxyRes.headers);

    // 3xx リダイレクトの Location が転送先の絶対 URL なら、
    // プロキシ経由の相対パスに書き換えてブラウザが直接オリジンへ飛ばないようにする
    if (headers.location) {
      try {
        const loc = new URL(headers.location, targetOrigin);
        if (loc.origin === targetOrigin) {
          headers.location = stripBasePath(loc.pathname) + loc.search + loc.hash;
        }
      } catch {
        // 不正な Location はそのまま通す
      }
    }

    // Set-Cookie の Domain / Secure 属性を除去し、プロキシのドメインで Cookie が効くようにする。
    // TARGET_URL がパス付き（例: https://example.com/blob）の場合は Cookie の Path からも
    // そのベースパスを剥がす（Path=/blob/main -> Path=/main）。
    if (Array.isArray(headers['set-cookie'])) {
      headers['set-cookie'] = headers['set-cookie'].map((cookie) => {
        let c = cookie
          .replace(/;\s*domain=[^;]*/gi, '')
          .replace(/;\s*secure/gi, '');
        if (targetBasePath) {
          c = c.replace(/;\s*path=([^;]*)/gi, (_m, pathValue) => `; Path=${stripBasePath(pathValue)}`);
        }
        return c;
      });
    }

    res.writeHead(proxyRes.statusCode, headers);
    proxyRes.on('error', () => res.destroy());
    proxyRes.pipe(res); // ボディは種類・サイズによらずストリームのまま転送（SSE 等の逐次配信も可）
  });

  // --- エラー処理 ---
  proxy.on('error', (err, req, res) => {
    log(`ERROR ${req.method} ${req.url} -> ${err.code || err.message}`);
    if (res && typeof res.writeHead === 'function' && !res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('502 Bad Gateway');
    } else if (res && res.destroy) {
      res.destroy();
    }
  });

  return proxy;
}

module.exports = { createProxy, stripHopByHop, HOP_BY_HOP_HEADERS };
