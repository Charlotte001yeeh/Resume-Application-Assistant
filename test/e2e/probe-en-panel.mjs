/* Probe: what text does the widget panel actually show in ENGLISH mode? Flags CJK in UI chrome vs page data. */
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { startServer } from './server.mjs';
import { launchChrome, loadUnpacked, Cdp, evaluate, bridge, waitFor, navigate } from './cdp.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const OUT = join(ROOT, 'test', 'artifacts');
mkdirSync(OUT, { recursive: true });
const { baseUrl, server } = await startServer(join(HERE, 'fixtures'));
const userDataDir = mkdtempSync(join(tmpdir(), 'cv-probe-en-'));
const { proc, endpoint } = await launchChrome({ extensionPath: join(ROOT, 'extension'), userDataDir });
const cdp = new Cdp(endpoint.webSocketDebuggerUrl);
await cdp.connect();
await loadUnpacked(cdp, join(ROOT, 'extension'));
const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
await cdp.send('Page.enable', {}, sessionId);
await cdp.send('Runtime.enable', {}, sessionId);

// fresh profile defaults to English
await navigate(cdp, sessionId, `${baseUrl}/cn-form.html`);
await waitFor(cdp, sessionId, `document.documentElement.dataset.cvReady === '1'`, { timeoutMs: 20000 });
const lang = await evaluate(cdp, sessionId, `document.documentElement.dataset.cvLang`);
console.log('cvLang =', lang, '· cvVersion =', await evaluate(cdp, sessionId, `document.documentElement.dataset.cvVersion`));

await evaluate(cdp, sessionId, `document.getElementById('cv-fab').click()`);
await sleep(200);
const chips = await evaluate(cdp, sessionId, `JSON.stringify([...document.querySelectorAll('#cv-grid [data-act] span')].map((s) => s.textContent.trim()))`);
console.log('chips =', chips);

await evaluate(cdp, sessionId, `document.querySelector('#cv-grid [data-act="fill"]').click()`);
await waitFor(cdp, sessionId, `document.querySelectorAll('#cv-panel .cv-item').length > 0`, { timeoutMs: 30000 });
await sleep(300);

const dump = await evaluate(
  cdp,
  sessionId,
  `JSON.stringify({
    title: document.querySelector('#cv-panel h3').textContent.trim(),
    stat: document.querySelector('#cv-panel .cv-stat').textContent.trim(),
    tags: [...document.querySelectorAll('#cv-panel .tag')].map((t) => t.textContent.trim()).slice(0, 6),
    whys: [...document.querySelectorAll('#cv-panel .why')].map((w) => w.textContent.trim()).slice(0, 8),
    buttons: [...document.querySelectorAll('#cv-panel button')].map((b) => b.textContent.trim()).slice(0, 8),
    panelCJK: (document.querySelector('#cv-panel').textContent.match(/[\\u4e00-\\u9fff]+/g) || []).slice(0, 24)
  })`
);
console.log('PANEL(EN) =', dump);

// review panel too (generated content lives there)
await evaluate(cdp, sessionId, `document.getElementById('cv-fab').click()`);
await sleep(150);
await evaluate(cdp, sessionId, `document.querySelector('#cv-grid [data-act="review"]').click()`);
await sleep(2500);
const review = await evaluate(
  cdp,
  sessionId,
  `JSON.stringify({
    title: document.querySelector('#cv-panel h3').textContent.trim(),
    tags: [...document.querySelectorAll('#cv-panel .tag')].map((t) => t.textContent.trim()).slice(0, 6),
    whys: [...document.querySelectorAll('#cv-panel .why')].map((w) => w.textContent.trim()).slice(0, 6),
    buttons: [...document.querySelectorAll('#cv-panel button')].map((b) => b.textContent.trim()).slice(0, 6)
  })`
);
console.log('REVIEW(EN) =', review);
const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId);
writeFileSync(join(OUT, 'probe-en-panel.png'), Buffer.from(shot.data, 'base64'));

cdp.close();
proc.kill();
server.close();
process.exit(0);
