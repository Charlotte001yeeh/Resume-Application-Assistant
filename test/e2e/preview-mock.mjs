/* Dev tool: screenshot the floating-widget prototype in its three states (ball / ring / panel). */
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { launchChrome, Cdp, evaluate, waitFor, navigate } from './cdp.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const MOCK = join(ROOT, 'docs', 'mockups', 'fab-ui-review.html');
const OUT = join(ROOT, 'test', 'artifacts');
mkdirSync(OUT, { recursive: true });

const userDataDir = mkdtempSync(join(tmpdir(), 'cv-mock-'));
const { proc, endpoint } = await launchChrome({ extensionPath: join(ROOT, 'extension'), userDataDir });
const cdp = new Cdp(endpoint.webSocketDebuggerUrl);
await cdp.connect();
const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
await cdp.send('Page.enable', {}, sessionId);
await cdp.send('Runtime.enable', {}, sessionId);
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1180, height: 820, deviceScaleFactor: 1, mobile: false }, sessionId);

await navigate(cdp, sessionId, `file:///${MOCK.replace(/\\/g, '/')}`);
await waitFor(cdp, sessionId, `!!document.getElementById('fab')`);
await sleep(300);

async function shot(name) {
  const res = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId);
  const { writeFileSync } = await import('node:fs');
  writeFileSync(join(OUT, name), Buffer.from(res.data, 'base64'));
  console.log('shot:', name);
}

// geometry check: buttons must be visible, inside the viewport, non-overlapping (with each other and with the ball)
const geoCheck = `(() => {
  const vw = innerWidth, vh = innerHeight;
  const fab = document.getElementById('fab').getBoundingClientRect();
  const els = [...document.querySelectorAll('.cv-ring-btn')];
  const rects = els.map((b) => ({ act: b.dataset.act, r: b.getBoundingClientRect() }));
  const visible = rects.every(({ r }) => r.left >= 0 && r.top >= 0 && r.right <= vw && r.bottom <= vh && r.width > 0);
  const overlaps = [];
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i].r, b = rects[j].r;
      if (!(a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom)) {
        overlaps.push(rects[i].act + '×' + rects[j].act);
      }
    }
  }
  const ballOverlaps = rects
    .filter(({ r }) => !(r.right <= fab.left || r.left >= fab.right || r.bottom <= fab.top || r.top >= fab.bottom))
    .map((x) => x.act);
  return JSON.stringify({ vw, vh, layout: document.getElementById('widget').className, visible, overlaps, ballOverlaps });
})()`;

async function ringAndCheck(name) {
  // open the ring only when it is not open yet (clicking the ball toggles)
  await evaluate(cdp, sessionId, `(() => { const w = document.getElementById('widget'); if (!w.classList.contains('ring')) document.getElementById('fab').click(); return w.className; })()`);
  await sleep(300);
  const geo = await evaluate(cdp, sessionId, geoCheck);
  console.log(`${name} geometry:`, geo);
  await shot(name);
}

// state 1: default ball only
await shot('fab-1-ball.png');

// state 2: arc layout (orbit)
await ringAndCheck('fab-2-ring.png');

// state 2b: pill stack layout
await evaluate(cdp, sessionId, `document.getElementById('btnLayout').click()`);
await sleep(250);
await ringAndCheck('fab-2b-stack.png');
await evaluate(cdp, sessionId, `document.getElementById('btnLayout').click()`); // back to arc
await sleep(200);

// state 3: white content panel (fill)
await evaluate(cdp, sessionId, `document.querySelector('.cv-ring-btn[data-act="fill"]').click()`);
await sleep(350);
await shot('fab-3-panel.png');

// geometry check: every ring button must be fully inside the viewport and not overlapping the ball

// state 4: Chinese panel
await evaluate(cdp, sessionId, `document.getElementById('btnLang').click()`);
await sleep(250);
await shot('fab-4-zh-panel.png');
await evaluate(cdp, sessionId, `document.getElementById('fab').click(); document.querySelector('.cv-ring-btn[data-act="review"]').click()`);
await sleep(300);
await shot('fab-5-review-panel.png');

cdp.close();
proc.kill();
process.exit(0);
