/* Dev tool: screenshot prototype v2 (three designs × ball/ring/panel) + geometry self-check. */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { launchChrome, Cdp, evaluate, waitFor, navigate } from './cdp.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const MOCK = join(ROOT, 'docs', 'mockups', 'fab-ui-review-v2.html');
const OUT = join(ROOT, 'test', 'artifacts');
mkdirSync(OUT, { recursive: true });

const userDataDir = mkdtempSync(join(tmpdir(), 'cv-mock2-'));
const { proc, endpoint } = await launchChrome({ extensionPath: join(ROOT, 'extension'), userDataDir });
const cdp = new Cdp(endpoint.webSocketDebuggerUrl);
await cdp.connect();
const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
await cdp.send('Page.enable', {}, sessionId);
await cdp.send('Runtime.enable', {}, sessionId);
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 840, deviceScaleFactor: 1, mobile: false }, sessionId);

await navigate(cdp, sessionId, `file:///${MOCK.replace(/\\/g, '/')}`);
await waitFor(cdp, sessionId, `!!document.getElementById('fab')`);
await sleep(300);

async function shot(name) {
  const res = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId);
  writeFileSync(join(OUT, name), Buffer.from(res.data, 'base64'));
  console.log('shot:', name);
}

const SEL = { grid: '.grid-chip', dock: '.dock-chip', dial: '.dial-btn' };

async function geom(design) {
  const expr = `(() => {
    const vw = innerWidth, vh = innerHeight;
    const sel = ${JSON.stringify(SEL[design])};
    const els = [...document.querySelectorAll(sel)].filter((e) => {
      const s = getComputedStyle(e); return s.visibility !== 'hidden' && Number(s.opacity) > .05;
    });
    const fab = document.getElementById('fab').getBoundingClientRect();
    const rects = els.map((e) => ({ act: e.dataset.act, r: e.getBoundingClientRect() }));
    const inside = rects.every(({ r }) => r.left >= 0 && r.top >= 0 && r.right <= vw && r.bottom <= vh && r.width > 0);
    const overlaps = [];
    for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i].r, b = rects[j].r;
      if (!(a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom)) overlaps.push(rects[i].act + '×' + rects[j].act);
    }
    const ballOverlap = rects.filter(({ r }) => !(r.right <= fab.left || r.left >= fab.right || r.bottom <= fab.top || r.top >= fab.bottom)).map((x) => x.act);
    const panel = document.getElementById('panel').getBoundingClientRect();
    const panelInside = panel.width === 0 || (panel.left >= 0 && panel.top >= 0 && panel.right <= vw && panel.bottom <= vh);
    return JSON.stringify({ design: '${design}', count: rects.length, inside, overlaps, ballOverlap, panelInside });
  })()`;
  return evaluate(cdp, sessionId, expr);
}

async function clickFab() {
  await evaluate(cdp, sessionId, `(() => { const w = document.getElementById('widget'); if (w.dataset.state !== 'ring') document.getElementById('fab').click(); return w.dataset.state; })()`);
  await sleep(280);
}

for (const design of ['grid', 'dock', 'dial']) {
  await evaluate(cdp, sessionId, `document.getElementById('${'d' + design[0].toUpperCase() + design.slice(1)}').click()`);
  await sleep(200);
  await clickFab();
  console.log(`--- ${design}: ring`, await geom(design));
  await shot(`v2-${design}-ring.png`);

  await evaluate(cdp, sessionId, `document.querySelector(${JSON.stringify(SEL[design] + '[data-act="fill"]')}).click()`);
  await sleep(300);
  console.log(`--- ${design}: panel`, await geom(design));
  await shot(`v2-${design}-panel.png`);

  // back to ball for the next design
  await evaluate(cdp, sessionId, `document.getElementById('btnClose').click()`);
  await sleep(200);
}

// ball states: default / extra transparency / disabled
await evaluate(cdp, sessionId, `document.getElementById('reset') ? null : document.getElementById('btnReset').click()`);
await sleep(250);
await shot('v2-ball-default.png');
await evaluate(cdp, sessionId, `(() => { const a = document.getElementById('alpha'); a.value = 5; a.dispatchEvent(new Event('input')); return a.value; })()`);
await sleep(200);
await shot('v2-ball-faint.png');
await evaluate(cdp, sessionId, `(() => { const c = document.getElementById('setEnabled'); c.checked = false; c.dispatchEvent(new Event('change')); return c.checked; })()`);
await sleep(200);
await shot('v2-ball-disabled.png');

// Chinese variant (grid + panel)
await evaluate(cdp, sessionId, `(() => { const c = document.getElementById('setEnabled'); c.checked = true; c.dispatchEvent(new Event('change')); document.getElementById('dGrid').click(); document.getElementById('btnLang').click(); const a = document.getElementById('alpha'); a.value = 14; a.dispatchEvent(new Event('input')); return 1; })()`);
await sleep(250);
await evaluate(cdp, sessionId, `document.getElementById('fab').click()`);
await sleep(250);
await shot('v2-grid-ring-zh.png');
await evaluate(cdp, sessionId, `document.querySelector('.grid-chip[data-act="fill"]').click()`);
await sleep(300);
await shot('v2-grid-panel-zh.png');
await evaluate(cdp, sessionId, `document.querySelector('.grid-chip') ? document.getElementById('btnClose').click() : null`);
await sleep(200);
await evaluate(cdp, sessionId, `document.getElementById('btnLang').click()`);
await sleep(150);
await shot('v2-legend.png');

cdp.close();
proc.kill();
process.exit(0);
