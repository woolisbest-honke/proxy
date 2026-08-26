// Vercel Serverless Function（キャッチオール）
//
// vercel.json のリライトにより、すべてのパス（/v1/models など）が
// この関数（/api/...）に集約され、TARGET_URL へそのまま転送される。
//
// デプロイ前に環境変数 TARGET_URL を設定する:
//   vercel env add TARGET_URL
//   vercel env add TARGET_URL production
//
// 注意: サーバーレスのため実行時間に上限がある（config.maxDuration）。
//       長時間のストリーミングには Render / Railway / Fly 等の
//       常駐型プラットフォームを推奨。

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createProxy } = require('../lib/proxy.js');

const TARGET_URL = (process.env.TARGET_URL || '').trim();

// ウォーム起動間でプロキシを再利用する
let proxyPromise = null;
function getProxy() {
  if (!proxyPromise) {
    proxyPromise = Promise.resolve()
      .then(() =>
        createProxy({
          targetUrl: TARGET_URL,
          tlsVerify: process.env.TLS_VERIFY !== 'false',
          forwardClientIp: process.env.FORWARD_CLIENT_IP === 'true',
          proxyTimeoutMs: parseInt(process.env.PROXY_TIMEOUT_MS, 10) || 0,
          log: () => {},
        })
      )
      .catch((err) => {
        proxyPromise = null; // 設定を直した次回リクエストで再試行できるように
        throw err;
      });
  }
  return proxyPromise;
}

export default async function handler(req, res) {
  let proxy;
  try {
    proxy = await getProxy();
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(`Proxy configuration error: ${err.message}`);
    return;
  }

  // /api/v1/models -> /v1/models （リライトで付与された /api を剥がす）
  // 直接 /api/... に来たリクエストも同様に扱う
  req.url = String(req.url || '/').replace(/^\/api(?=\/|$)/, '') || '/';

  proxy.web(req, res);
}

export const config = {
  // bodyParser を無効にしないとリクエストボディのストリームが消費されてしまう
  api: { bodyParser: false },
  // 実行時間の上限（秒）。プランによって上限が異なる場合は調整すること
  maxDuration: 60,
};
