#!/usr/bin/env node
// ============================================================
// TopCat Screener — versão estática (GitHub Pages)
//
//   node tools/build-web.js            → cria dist-web/
//   GRAPH_API_KEY=xxxx node tools/build-web.js   (a chave fica em dist-web/config.js)
//
// O mesmo server.js corre dentro do navegador: os pedidos da página a "api/…"
// são respondidos ali mesmo (sem servidor), e as pesquisas vão diretamente da
// máquina de cada visitante para a The Graph, o GeckoTerminal, o GoPlus e o
// CoinGecko. Assim os limites (ex. 30 pedidos/min do GeckoTerminal) são de cada
// visitante e não partilhados.
//
// A chave da The Graph fica visível no config.js publicado. Protege-a no
// Subgraph Studio (thegraph.com/studio → API Keys → Authorized domains):
// autoriza só o domínio do site (ex. topcatmasterinvestor.github.io).
// ============================================================
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'dist-web');
const PUB = path.join(ROOT, 'public');

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

// 1) motor: server.js embrulhado com substitutos das partes de Node
let server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8').replace(/^#!.*\n/, '');
const engine = `/* TopCat Screener — motor no navegador (gerado por tools/build-web.js; não editar) */
(function () {
  const CFG = window.TOPCAT_CONFIG || {};
  const process = { env: Object.assign({}, CFG.env || {}, CFG.GRAPH_API_KEY ? { GRAPH_API_KEY: CFG.GRAPH_API_KEY } : {}) };
  let HANDLER = null;
  const require = (m) => ({
    http: { createServer: (h) => { HANDLER = h; return { listen() {}, on() {} }; } },
    fs: { readFileSync() { throw new Error('sem ficheiros no navegador'); } },
    path: { join: (...a) => a.join('/') },
    crypto: { createHash: () => ({ update() { return this; }, digest: () => new Uint8Array(32) }), timingSafeEqual: () => false },
  })[m];
  require.main = null;
  const module = { exports: {} };
  const __dirname = '';
  const Buffer = { from: (s) => ({ toString: () => { try { return atob(s); } catch (_) { return ''; } } }) };
  const _setInterval = window.setInterval.bind(window);
  const setInterval = (f, t) => { const id = _setInterval(f, t); return { unref() {}, id }; };

  // Pedidos às APIs: diretos do navegador; se uma API recusar pedidos de outro site (CORS) ou não responder,
  // passa a ir por topcatlabs.com (CFG.PROXY), que só reencaminha para as APIs da lista. Fica memorizado por API.
  const PROXY = CFG.PROXY || '';
  const directFetch = window.fetch.bind(window);
  const viaProxy = new Set();
  const fetch = async (url, init) => {
    const u = String(url); let host = ''; try { host = new URL(u).host; } catch (_) {}
    if (PROXY && host && viaProxy.has(host)) return directFetch(PROXY + encodeURIComponent(u), init);
    try { return await directFetch(u, init); }
    catch (e) {
      if (!PROXY || !host || (e && (e.name === 'AbortError' || e.name === 'TimeoutError'))) throw e;
      viaProxy.add(host);
      return directFetch(PROXY + encodeURIComponent(u), init);
    }
  };
  window.TOPCAT_VIA_PROXY = viaProxy;

  // ───────────── server.js ─────────────
${server}
  // ─────────────────────────────────────

  // Pedidos "api/…" da página → handler do server.js, com req/res a imitar os do Node.
  const enc = new TextEncoder();
  function local(url, init) {
    init = init || {};
    const body = typeof init.body === 'string' ? init.body : '';
    const req = { method: (init.method || 'GET').toUpperCase(), url, headers: {}, socket: { remoteAddress: 'browser' },
      async *[Symbol.asyncIterator]() { if (body) yield body; } };
    let ctrl; let closed = false;
    const stream = new ReadableStream({ start(c) { ctrl = c; } });
    let status = 200; let headers = {}; let headDone; const head = new Promise((r) => { headDone = r; });
    const listeners = {};
    const res = {
      writableFinished: false, headersSent: false,
      writeHead(s, h) { status = s; headers = h || {}; this.headersSent = true; headDone(); return this; },
      setHeader(k, v) { headers[k] = v; },
      write(chunk) { if (!this.headersSent) this.writeHead(200); if (!closed) ctrl.enqueue(typeof chunk === 'string' ? enc.encode(chunk) : chunk); return true; },
      end(chunk) { if (chunk != null) this.write(chunk); else if (!this.headersSent) this.writeHead(200); this.writableFinished = true; if (!closed) { closed = true; try { ctrl.close(); } catch (_) {} } },
      on(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); return this; },
    };
    if (init.signal) init.signal.addEventListener('abort', () => {
      (listeners.close || []).forEach((f) => { try { f(); } catch (_) {} });
      if (!closed) { closed = true; try { ctrl.error(new DOMException('Aborted', 'AbortError')); } catch (_) {} }
    });
    Promise.resolve(HANDLER(req, res)).catch((e) => { try { res.writeHead(500); res.end(String(e && e.message || e)); } catch (_) {} });
    return head.then(() => new Response(stream, { status, headers }));
  }
  const nativeFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const u = typeof input === 'string' ? input : (input && input.url) || '';
    const m = u.match(/(?:^|\\/)api\\/(scan|token|config|networks)(?:\\?.*)?$/);
    if (m && HANDLER && !/^[a-z]+:\\/\\//i.test(u)) return local('/api/' + m[1], init);   // só os caminhos relativos da própria página
    return nativeFetch(input, init);
  };
  window.TOPCAT_STATIC = true;
})();
`;
fs.writeFileSync(path.join(OUT, 'engine.js'), engine);

// 2) configuração (a chave entra aqui no build do GitHub Actions, a partir de um "secret")
// sem GRAPH_API_KEY no build, fica a chave de testes incluída no server.js
// reencaminhamento de reserva (APIs sem CORS): o servidor do topcatlabs.com; SCREENER_PROXY= vazio desliga
const proxy = process.env.SCREENER_PROXY != null ? String(process.env.SCREENER_PROXY) : 'https://topcatlabs.com/screener/api/proxy?u=';
const key = String(process.env.GRAPH_API_KEY || (server.match(/DEFAULT_GRAPH_KEY = '([^']+)'/) || [])[1] || '').trim();
fs.writeFileSync(path.join(OUT, 'config.js'),
  `// Gerado por tools/build-web.js. Chave da The Graph (de testes, ou a do secret GRAPH_API_KEY).\n` +
  `window.TOPCAT_CONFIG = { GRAPH_API_KEY: ${JSON.stringify(key)}, PROXY: ${JSON.stringify(proxy)} };\n`);

// 3) página: carrega config.js e engine.js antes do resto
let html = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
if (!html.includes('<script src="i18n.js"></script>')) throw new Error('index.html: não encontrei <script src="i18n.js">');
html = html.replace('<script src="i18n.js"></script>', '<script src="config.js"></script>\n<script src="engine.js"></script>\n<script src="i18n.js"></script>');
fs.writeFileSync(path.join(OUT, 'index.html'), html);
for (const f of ['i18n.js', 'logo.png', 'apple-touch-icon.png']) fs.copyFileSync(path.join(PUB, f), path.join(OUT, f));
fs.writeFileSync(path.join(OUT, '.nojekyll'), '');

console.log('dist-web/ criado' + (key ? ' (com chave da The Graph)' : ' (sem chave: os visitantes colam a sua)'));
