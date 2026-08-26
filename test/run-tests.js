'use strict';

/**
 * 自己完結型テスト。ローカルに擬似オリジンとプロキシを起動して検証する。
 *   node test/run-tests.js  /  npm test
 *
 * 外部ネットワーク不要。HTTP のみ（HTTPS の検証は手動で実施済み）。
 */

const assert = require('assert');
const http = require('http');
const { pathToFileURL } = require('url');
const { createProxy } = require('../lib/proxy');

const ORIGIN_PORT = 9971;
const PROXY_PORT = 9972;
const VERCEL_PORT = 9973;
const ORIGIN = `http://127.0.0.1:${ORIGIN_PORT}`;
const BASE = `http://127.0.0.1:${PROXY_PORT}`;

let passed = 0;
const failures = [];

async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures.push(name);
    console.error(`  FAIL ${name}\n      ${err && err.stack ? err.stack.split('\n').slice(0, 3).join('\n') : err}`);
  }
}

// ---------------------------------------------------------------------------
// 擬似オリジン
// ---------------------------------------------------------------------------
function startOrigin(port) {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const u = new URL(req.url, ORIGIN);
      const p = u.pathname;

      if (p === '/') {
        res.setHeader('set-cookie', [
          'session=abc123; Path=/; Domain=origin.test; Secure; HttpOnly',
          'theme=dark; Path=/; Domain=.origin.test',
        ]);
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'x-origin-header': 'kept' });
        res.end('<html><body>origin home</body></html>');
      } else if (p === '/redirect') {
        res.writeHead(302, { location: `${ORIGIN}/hello?from=redirect` });
        res.end();
      } else if (p === '/redirect-external') {
        res.writeHead(302, { location: 'https://elsewhere.example/x' });
        res.end();
      } else if (p === '/base/redirect') {
        // パス付き転送先でのリダイレクト: ベースパス付き絶対URL -> プロキシ側では / を起点に
        res.writeHead(302, { location: `${ORIGIN}/base/hello?from=base` });
        res.end();
      } else if (p === '/base/cookies') {
        res.setHeader('set-cookie', [
          's1=v1; Path=/base; HttpOnly',
          's2=v2; Path=/base/sub; Secure',
        ]);
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('ok');
      } else if (p.endsWith('/v1/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ path: p, object: 'list', data: [{ id: 'model-a' }, { id: 'model-b' }] }));
      } else if (p.startsWith('/api/v1/stream/')) {
        // SSE: 3 イベントを 150ms 間隔で送る（ストリーミング検証用）
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        res.flushHeaders();
        req.socket.setNoDelay(true);
        const id = p.split('/').pop();
        let i = 0;
        const timer = setInterval(() => {
          i++;
          res.write(`event: message\ndata: {"id":"${id}","n":${i}}\n\n`);
          if (i >= 3) {
            res.write('event: done\ndata: [DONE]\n\n');
            clearInterval(timer);
            res.end();
          }
        }, 150);
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            url: req.url,
            method: req.method,
            host: req.headers.host,
            body,
            xfwd: req.headers['x-forwarded-for'] || null,
          })
        );
      }
    });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

function startProxyServer(port, targetUrl, extra = {}) {
  const proxy = createProxy({ targetUrl, log: () => {}, ...extra });
  const server = http.createServer((req, res) => proxy.web(req, res));
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

// ---------------------------------------------------------------------------
// テスト本体
// ---------------------------------------------------------------------------
(async () => {
  console.log('starting servers...');
  const origin = await startOrigin(ORIGIN_PORT);
  const proxyServer = await startProxyServer(PROXY_PORT, ORIGIN);
  const deadServer = await startProxyServer(9974, 'http://127.0.0.1:9979'); // 何も待ち受けていない
  const basePathServer = await startProxyServer(9975, `${ORIGIN}/base`);

  // Vercel 用アダプタ（api/[...path].mjs）を本物の http サーバで包む
  process.env.TARGET_URL = ORIGIN;
  const mod = await import(pathToFileURL(require.resolve('../api/[...path].mjs')).href);
  const vercelServer = http.createServer((req, res) => mod.default(req, res));
  await new Promise((resolve) => vercelServer.listen(VERCEL_PORT, '127.0.0.1', resolve));

  console.log(`\nproxy=${BASE} origin=${ORIGIN}\n`);

  await check('GET / : Set-Cookie の Domain/Secure 除去・ヘッダー透過', async () => {
    const res = await fetch(`${BASE}/`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('x-origin-header'), 'kept');
    const cookies = res.headers.getSetCookie();
    assert.ok(cookies.some((c) => c === 'session=abc123; Path=/; HttpOnly'), JSON.stringify(cookies));
    assert.ok(!cookies.some((c) => /domain=/i.test(c)), 'Domain属性が残っている');
    assert.ok(!cookies.some((c) => /secure/i.test(c)), 'Secure属性が残っている');
  });

  await check('GET /redirect : 転送先絶対URLのLocationを相対パスに書き換え', async () => {
    const res = await fetch(`${BASE}/redirect`, { redirect: 'manual' });
    assert.strictEqual(res.status, 302);
    assert.strictEqual(res.headers.get('location'), '/hello?from=redirect');
  });

  await check('GET /redirect-external : 外部URLのLocationはそのまま通す', async () => {
    const res = await fetch(`${BASE}/redirect-external`, { redirect: 'manual' });
    assert.strictEqual(res.headers.get('location'), 'https://elsewhere.example/x');
  });

  await check('POST /api/v1/chat/completions : JSONボディ透過・Host書き換え・IP非通知', async () => {
    const payload = JSON.stringify({ model: 'model-a', messages: [{ role: 'user', content: 'hi' }] });
    const res = await fetch(`${BASE}/api/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload,
    });
    const json = await res.json();
    assert.strictEqual(json.method, 'POST');
    assert.strictEqual(json.url, '/api/v1/chat/completions');
    assert.strictEqual(json.host, `127.0.0.1:${ORIGIN_PORT}`);
    assert.strictEqual(json.body, payload);
    assert.strictEqual(json.xfwd, null);
  });

  await check('GET /v1/models : APIパスをそのまま転送', async () => {
    const res = await fetch(`${BASE}/v1/models`);
    const json = await res.json();
    assert.strictEqual(json.path, '/v1/models');
    assert.strictEqual(json.object, 'list');
    assert.deepStrictEqual(json.data.map((d) => d.id), ['model-a', 'model-b']);
  });

  await check('GET /api/v1/stream/abc123 : SSEがバッファされず逐次届く', async () => {
    const res = await fetch(`${BASE}/api/v1/stream/abc123`);
    assert.strictEqual(res.headers.get('content-type'), 'text/event-stream');
    const text = await res.text();
    const events = text.split('\n\n').filter((s) => s.startsWith('event:'));
    assert.strictEqual(events.length, 4, `イベント数: ${events.length}`);
    assert.ok(events[3].includes('[DONE]'));
  });

  await check('SSE 到着タイミング: 逐次ストリーミングされている', async () => {
    const res = await fetch(`${BASE}/api/v1/stream/timing1`);
    assert.ok(res.body, 'response body stream がない');
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const times = [];
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        buf = buf.slice(idx + 2);
        times.push(performance.now());
      }
    }
    assert.strictEqual(times.length, 4, `チャンク到着回数: ${times.length}`);
    const spread = times[times.length - 1] - times[0];
    assert.ok(spread >= 250, `最初と最後の到着差が小さすぎる（${Math.round(spread)}ms）= バッファされている疑い`);
  });

  await check('転送先が落ちている場合は 502', async () => {
    const res = await fetch('http://127.0.0.1:9974/');
    assert.strictEqual(res.status, 502);
    assert.strictEqual((await res.text()).trim(), '502 Bad Gateway');
  });

  await check('TARGET_URL にパス付き (/base) : パスを付与して転送', async () => {
    const res = await fetch('http://127.0.0.1:9975/v1/models');
    const json = await res.json();
    assert.strictEqual(json.path, '/base/v1/models');
  });

  await check('TARGET_URL=https://example.com/blob 相当: /main -> /blob/main', async () => {
    const blobProxy = await startProxyServer(9980, `${ORIGIN}/blob`);
    try {
      const res = await fetch('http://127.0.0.1:9980/main?x=1');
      const json = await res.json();
      assert.strictEqual(json.url, '/blob/main?x=1');
    } finally {
      await close(blobProxy);
    }
  });

  await check('TARGET_URL=http://host:8080 相当: カスタムポートへ転送', async () => {
    const origin2 = await startOrigin(9981); // 既定ポートではない 9981 で起動
    const portProxy = await startProxyServer(9977, 'http://127.0.0.1:9981');
    try {
      const res = await fetch('http://127.0.0.1:9977/echo');
      const json = await res.json();
      // Host がポート付き (127.0.0.1:9981) になっている = 指定ポートに届いている
      assert.strictEqual(json.host, '127.0.0.1:9981');
    } finally {
      await close(portProxy);
      await close(origin2);
    }
  });

  await check('TARGET_URL の末尾スラッシュ (/base/) は /base と同じ扱い', async () => {
    const slashProxy = await startProxyServer(9978, `${ORIGIN}/base/`);
    try {
      const res = await fetch('http://127.0.0.1:9978/v1/models');
      const json = await res.json();
      assert.strictEqual(json.path, '/base/v1/models');
    } finally {
      await close(slashProxy);
    }
  });

  await check('TARGET_URL の多段パス (/a/b) も付与される', async () => {
    const deepProxy = await startProxyServer(9979, `${ORIGIN}/a/b`);
    try {
      const res = await fetch('http://127.0.0.1:9979/x?y=2');
      const json = await res.json();
      assert.strictEqual(json.url, '/a/b/x?y=2');
    } finally {
      await close(deepProxy);
    }
  });

  await check('パス付き転送時のリダイレクト: Location /base/hello -> /hello', async () => {
    const res = await fetch('http://127.0.0.1:9975/redirect', { redirect: 'manual' });
    assert.strictEqual(res.status, 302);
    assert.strictEqual(res.headers.get('location'), '/hello?from=base');
  });

  await check('パス付き転送時のSet-Cookie: Path=/base -> Path=/', async () => {
    const res = await fetch('http://127.0.0.1:9975/cookies');
    assert.strictEqual(await res.text(), 'ok');
    const cookies = res.headers.getSetCookie();
    assert.ok(cookies.includes('s1=v1; Path=/; HttpOnly'), JSON.stringify(cookies));
    assert.ok(cookies.includes('s2=v2; Path=/sub'), JSON.stringify(cookies)); // Secure も除去
  });

  await check('Vercel アダプタ: /api/v1/models -> /v1/models へ転送', async () => {
    const res = await fetch(`http://127.0.0.1:${VERCEL_PORT}/api/v1/models`);
    const json = await res.json();
    assert.strictEqual(json.path, '/v1/models');
  });

  await check('Vercel アダプタ: /api プレフィックスなしもそのまま転送', async () => {
    const res = await fetch(`http://127.0.0.1:${VERCEL_PORT}/v1/models`);
    const json = await res.json();
    assert.strictEqual(json.path, '/v1/models');
  });

  await check('FORWARD_CLIENT_IP=true : X-Forwarded-For を付与', async () => {
    const withXfwd = await startProxyServer(9976, ORIGIN, { forwardClientIp: true });
    try {
      const res = await fetch('http://127.0.0.1:9976/echo');
      const json = await res.json();
      assert.strictEqual(json.xfwd, '127.0.0.1');
    } finally {
      await close(withXfwd);
    }
  });

  // -------------------------------------------------------------------
  console.log(`\n${passed} passed, ${failures.length} failed`);
  await Promise.all([origin, proxyServer, deadServer, basePathServer, vercelServer].map(close));
  process.exit(failures.length ? 1 : 0);
})().catch(async (err) => {
  console.error('fatal:', err);
  process.exit(1);
});
