/* Minimal CDP client (zero dependencies): Node's built-in WebSocket + Chrome DevTools Protocol */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { platform, homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const OS = platform(); // 'win32' | 'darwin' | 'linux'
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  // macOS
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  // Windows
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  // Per-user install: resolved from the environment, never from a hardcoded user name
  process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe') : null,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  // Linux
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
].filter(Boolean);

export function findChrome() {
  for (const p of CHROME_CANDIDATES) {
    if (existsSync(p)) return p;
  }
  throw new Error('No Chrome/Edge executable found (set the CHROME_PATH environment variable)');
}

/** Find a port not taken by any debugging endpoint (so we never attach to a browser the user already runs). */
async function pickSafePort() {
  for (let i = 0; i < 25; i++) {
    const port = 9200 + Math.floor(Math.random() * 700);
    let busy = false;
    try {
      await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(300) });
      busy = true;
    } catch {
      busy = false;
    }
    if (!busy) return port;
  }
  throw new Error('No free debugging port found');
}

export async function launchChrome({ headless = false, extensionPath, userDataDir, port, width = 1440, height = 940 } = {}) {
  const chromePath = findChrome();
  let debugPort = port;
  if (!debugPort) {
    debugPort = await pickSafePort();
  } else {
    let busy = false;
    try {
      await fetch(`http://127.0.0.1:${debugPort}/json/version`, { signal: AbortSignal.timeout(300) });
      busy = true;
    } catch {
      busy = false;
    }
    if (busy) throw new Error(`Debug port ${debugPort} is already used by another browser instance; refusing to connect (to avoid acting on the wrong browser)`);
  }
  const args = [
    `--remote-debugging-port=${debugPort}`,
    `--remote-allow-origins=*`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--no-proxy-server',
    '--disable-default-apps',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-features=Translate,OptimizationHints',
    // Chrome 137+ removed --load-extension; 153+ needs extension debugging enabled to use CDP Extensions.loadUnpacked
    '--enable-unsafe-extension-debugging',
    `--window-size=${width},${height}`,
    'about:blank',
  ];
  if (extensionPath) args.unshift(`--load-extension=${extensionPath}`); // for older Chrome/Edge
  if (headless) args.unshift('--headless=new');
  const proc = spawn(chromePath, args, { stdio: 'ignore' });
  const endpoint = await waitForEndpoint(debugPort);
  return { proc, endpoint, chromePath, port: debugPort };
}

/** Load an unpacked extension over CDP (equivalent to "Load unpacked" on chrome://extensions). */
export async function loadUnpacked(cdp, extensionPath) {
  const res = await cdp.send('Extensions.loadUnpacked', { path: extensionPath });
  return res.id;
}

async function waitForEndpoint(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return await res.json();
    } catch (e) {
      lastErr = e;
    }
    await sleep(300);
  }
  throw new Error(`Chrome debug port ${port} not ready: ${lastErr && lastErr.message}`);
}

export class Cdp {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.seq = 0;
    this.pending = new Map();
    this.listeners = new Map();
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.wsUrl);
      this.ws.onopen = () => resolve();
      this.ws.onerror = (e) => reject(new Error(`CDP WebSocket error: ${e.message || 'unknown'}`));
      this.ws.onmessage = (ev) => {
        let msg;
        try {
          msg = JSON.parse(ev.data);
        } catch {
          return;
        }
        if (msg.id && this.pending.has(msg.id)) {
          const { resolve: res, reject: rej } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) rej(new Error(`${msg.error.message} (${msg.method || ''})`));
          else res(msg.result || {});
        } else if (msg.method) {
          const key = msg.sessionId ? `${msg.sessionId}:${msg.method}` : msg.method;
          for (const cb of this.listeners.get(key) || []) cb(msg.params || {});
          for (const cb of this.listeners.get('*') || []) cb(msg);
        }
      };
    });
  }

  on(method, cb, sessionId) {
    const key = sessionId ? `${sessionId}:${method}` : method;
    if (!this.listeners.has(key)) this.listeners.set(key, []);
    this.listeners.get(key).push(cb);
  }

  send(method, params = {}, sessionId) {
    const id = ++this.seq;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, 60000);
    });
  }

  close() {
    try {
      this.ws && this.ws.close();
    } catch {}
  }
}

/** Evaluate JS in a page session (can await Promises) */
export async function evaluate(cdp, sessionId, expression, { awaitPromise = true } = {}) {
  const res = await cdp.send(
    'Runtime.evaluate',
    { expression, awaitPromise, returnByValue: true, allowUnsafeEvalBlockedByCSP: true },
    sessionId
  );
  if (res.exceptionDetails) {
    const detail = res.exceptionDetails;
    throw new Error(`Page evaluation failed: ${detail.exception ? detail.exception.description || detail.text : detail.text}`);
  }
  return res.result ? res.result.value : undefined;
}

/** Call the content-script test bridge (window.postMessage) */
export async function bridge(cdp, sessionId, action, payload, timeoutMs = 20000) {
  const expr = `new Promise((resolve, reject) => {
    const id = 'cv-' + Math.random().toString(36).slice(2);
    const timer = setTimeout(() => reject(new Error('bridge timeout: ${action}')), ${timeoutMs});
    window.addEventListener('message', function handler(ev) {
      if (ev.source !== window || !ev.data || ev.data.source !== 'cv-test-result' || ev.data.id !== id) return;
      clearTimeout(timer);
      window.removeEventListener('message', handler);
      if (ev.data.ok) resolve(ev.data.data);
      else reject(new Error(ev.data.error || 'bridge error'));
    });
    window.postMessage({ source: 'cv-test', id, action: ${JSON.stringify(action)}, payload: ${JSON.stringify(payload || {})} }, '*');
  })`;
  return evaluate(cdp, sessionId, expr);
}

export async function waitFor(cdp, sessionId, expression, { timeoutMs = 15000, intervalMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const v = await evaluate(cdp, sessionId, expression, { awaitPromise: false });
      if (v) return v;
    } catch {}
    await sleep(intervalMs);
  }
  throw new Error(`Timed out waiting for condition: ${expression.slice(0, 80)}`);
}

export async function navigate(cdp, sessionId, url, { timeoutMs = 20000 } = {}) {
  const loaded = new Promise((resolve) => {
    const cb = () => {
      resolve();
    };
    cdp.on('Page.loadEventFired', cb, sessionId);
  });
  await cdp.send('Page.navigate', { url }, sessionId);
  await Promise.race([loaded, sleep(timeoutMs)]);
}
