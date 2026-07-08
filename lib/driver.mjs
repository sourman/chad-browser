// chad-browser driver — the daemon spawned by `chad-browser up`.
//
// One WebSocket to Chromium's browser endpoint, one Unix socket for the bash
// tool to send JS over. The JS runs in a context where `session` is a Proxy
// that forwards session.Page.navigate(...) -> CDP "Page.navigate", auto-routing
// to the active page target. No vendored protocol bindings: the surface is
// generated at runtime from method names, so it's always in sync with CDP.
//
// Lifecycle:
//   up   → chad-browser spawns `node driver.mjs <wsUrl> <socketPath>`
//   eval → bash opens the socket, sends {eval:"<js>"}, reads one response
//   down → bash kills the driver PID (and the browser + profile)

import { createServer } from 'node:net';
import { unlinkSync } from 'node:fs';

const wsUrl = process.argv[2];
const socketPath = process.argv[3];
if (!wsUrl || !socketPath) {
  console.error('usage: driver.mjs <wsUrl> <socketPath>');
  process.exit(2);
}

const READ_DOMAINS = ['Page', 'Runtime', 'DOM', 'Network'];
// Intentionally narrow: framework skeleton/placeholder selectors + generic
// role-based spinners. Do NOT use [class*="loading"] / [class*="spinner"] —
// those match far too much real content (e.g. "preloading", "downloading").
const SKELETON_SELECTORS =
  '.MuiSkeleton, [role="progressbar"], .ant-skeleton, .chakra-skeleton, ' +
  '.skeleton, [data-skeleton="true"], [aria-busy="true"]';

class CdpSession {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.activeSessionId = undefined;
    this.eventListeners = [];
  }

  async connect() {
    await this.openWs();
    await this.enableReadDomains();
    await this.attachToFirstPage();
  }

  openWs() {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('WS connect timeout')), 10000);
      this.ws.addEventListener('open', () => { clearTimeout(timer); resolve(); });
      this.ws.addEventListener('error', (e) => {
        clearTimeout(timer);
        reject(new Error(`WS error: ${e.message ?? 'connect failed'}`));
      });
      this.ws.addEventListener('message', (e) => this.onMessage(String(e.data)));
      this.ws.addEventListener('close', () => {
        for (const [, p] of this.pending) p.reject(new Error('CDP socket closed'));
        this.pending.clear();
      });
    });
  }

  onMessage(raw) {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (typeof m.id === 'number') {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.error) p.reject(new Error(`CDP ${m.error.code}: ${m.error.message}`));
      else p.resolve(m.result);
    } else if (m.method) {
      for (const fn of this.eventListeners) {
        try { fn(m.method, m.params, m.sessionId); } catch { /* ignore */ }
      }
    }
  }

  call(method, params = {}, timeoutMs = 30_000) {
    if (this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('Not connected'));
    }
    const id = this.nextId++;
    const msg = { id, method, params: params ?? {} };
    if (this.activeSessionId && !isBrowserLevel(method)) {
      msg.sessionId = this.activeSessionId;
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP ${method} timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.ws.send(JSON.stringify(msg));
    });
  }

  async enableReadDomains() {
    for (const d of READ_DOMAINS) {
      try { await this.call(`${d}.enable`); } catch { /* some domains fail on some targets */ }
    }
  }

  async attachToFirstPage() {
    const { targetInfos } = await this.call('Target.getTargets');
    const pages = targetInfos.filter(
      (t) => t.type === 'page' && !t.url.startsWith('chrome://') && !t.url.startsWith('devtools://'),
    );
    if (pages.length === 0) throw new Error('No page target to attach to');
    const { sessionId } = await this.call('Target.attachToTarget', {
      targetId: pages[0].targetId,
      flatten: true,
    });
    this.activeSessionId = sessionId;
  }

  async listPageTargets() {
    const { targetInfos } = await this.call('Target.getTargets');
    return targetInfos.filter(
      (t) => t.type === 'page' && !t.url.startsWith('chrome://') && !t.url.startsWith('devtools://'),
    );
  }

  async use(targetId) {
    const { sessionId } = await this.call('Target.attachToTarget', { targetId, flatten: true });
    this.activeSessionId = sessionId;
    return sessionId;
  }
}

function isBrowserLevel(method) {
  return method.startsWith('Browser.') || method.startsWith('Target.');
}

// session.Page.navigate({...}) -> cdp.call("Page.navigate", {...})
// The Proxy generates the domain.method surface at runtime; no vendored bindings.
function buildSessionProxy(cdp) {
  return new Proxy({}, {
    get(_t, domain) {
      return new Proxy({}, {
        get(_t2, method) {
          return (params) => cdp.call(`${String(domain)}.${String(method)}`, params);
        },
      });
    },
  });
}

// waitForReady({ check, timeout, hint }) — poll a JS expression until truthy.
// `check` is evaluated in the page via Runtime.evaluate. `hint` is a human label
// included in the timeout error so the caller knows what failed.
async function waitForReady(cdp, { check, timeout = 10000, hint = 'ready', interval = 300 }) {
  if (!check || typeof check !== 'string') {
    throw new Error('waitForReady needs { check: "<js expression>" }');
  }
  const deadline = Date.now() + timeout;
  let last = undefined;
  while (Date.now() < deadline) {
    const r = await cdp.call('Runtime.evaluate', {
      expression: check,
      returnByValue: true,
      awaitPromise: true,
    });
    last = r?.result?.value;
    if (last) return last;
    await sleep(interval);
  }
  throw new Error(`waitForReady timed out after ${timeout}ms — ${hint} (last value: ${JSON.stringify(last)})`);
}

// Default DOM-stable check: selector count unchanged across two polls AND no
// skeleton/spinner selectors present. Generalizes across frameworks.
async function waitForDomStable(cdp, { timeout = 10000, hint = 'DOM stable', interval = 400 } = {}) {
  let prev = -1;
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const r = await cdp.call('Runtime.evaluate', {
      expression:
        `(() => {` +
        `  const sk = document.querySelectorAll(\`${SKELETON_SELECTORS}\`).length;` +
        `  const n = document.querySelectorAll('*').length;` +
        `  return JSON.stringify({n, sk});` +
        `})()`,
      returnByValue: true,
    });
    let cur;
    try { cur = JSON.parse(r?.result?.value ?? '{}'); } catch { cur = {}; }
    if (cur.sk === 0 && cur.n === prev && cur.n > 0) return cur;
    prev = cur.n;
    await sleep(interval);
  }
  throw new Error(`waitForDomStable timed out after ${timeout}ms — ${hint}`);
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// --- main ---
const ws = new WebSocket(wsUrl);
const cdp = new CdpSession(ws);
const session = buildSessionProxy(cdp);

try {
  await cdp.connect();
} catch (e) {
  console.error(`driver: failed to connect/attach: ${e.message}`);
  process.exit(1);
}

// Build the eval context: `session`, `waitForReady`, `waitForDomStable`,
// `listPageTargets`, `use`, and convenience `evalInPage(expr)`.
async function evalInPage(expression, opts = {}) {
  const r = await cdp.call('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: opts.awaitPromise ?? true,
    ...opts,
  });
  if (r.exceptionDetails) {
    throw new Error(
      `page JS error: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`,
    );
  }
  return r.result?.value;
}

const ctx = {
  session,
  waitForReady: (opts) => waitForReady(cdp, opts),
  waitForDomStable: (opts) => waitForDomStable(cdp, opts),
  listPageTargets: () => cdp.listPageTargets(),
  use: (targetId) => cdp.use(targetId),
  evalInPage,
};

const server = createServer((conn) => {
  let buf = '';
  conn.on('data', (chunk) => {
    buf += chunk.toString();
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      handle(conn, line);
    }
  });
  conn.on('error', () => { /* client gone */ });
});

server.listen(socketPath, () => {
  // signal readiness on stdout (chad-browser up waits for this)
  console.log(`driver ready on ${socketPath}`);
});

const SHUTDOWN_GRACE_MS = 200;
let shuttingDown = false;
function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  setTimeout(() => {
    try { ws.close(); } catch { /* ignore */ }
    try { server.close(); } catch { /* ignore */ }
    try { unlinkSync(socketPath); } catch { /* ignore */ }
    process.exit(code);
  }, SHUTDOWN_GRACE_MS);
}
process.on('SIGTERM', () => shutdown(0));
process.on('SIGINT', () => shutdown(0));

async function handle(conn, line) {
  if (!line.trim()) return;
  let req;
  try { req = JSON.parse(line); }
  catch (e) {
    send(conn, { error: `bad JSON: ${e.message}` });
    return;
  }
  const code = req.eval ?? req.code ?? req.script;
  if (typeof code !== 'string') {
    send(conn, { error: 'request needs { eval: "<js>" }' });
    return;
  }
  const wrapped = `return (async () => {\n${code}\n})()`;
  const fn = new Function(
    'session', 'waitForReady', 'waitForDomStable', 'listPageTargets', 'use', 'evalInPage',
    'eval',
    wrapped,
  );
  try {
    const value = await fn(
      session, ctx.waitForReady, ctx.waitForDomStable, ctx.listPageTargets, ctx.use, ctx.evalInPage, eval,
    );
    send(conn, { value });
  } catch (e) {
    send(conn, { error: e?.message ?? String(e), stack: e?.stack });
  }
}

function send(conn, obj) {
  try { conn.write(JSON.stringify(obj) + '\n'); } catch { /* conn gone */ }
}
