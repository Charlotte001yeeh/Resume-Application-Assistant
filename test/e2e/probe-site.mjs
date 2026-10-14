/* Probe: dump the DOM structure of form controls on a real site (label-chain diagnostics) */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { launchChrome, loadUnpacked, Cdp, evaluate, waitFor, navigate } from './cdp.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const url = process.argv[2] || 'https://www.wenjuan.com/s/yUFNriL/';
const userDataDir = mkdtempSync(join(tmpdir(), 'cv-probe-'));
const { proc, endpoint } = await launchChrome({ extensionPath: join(ROOT, 'extension'), userDataDir });
const cdp = new Cdp(endpoint.webSocketDebuggerUrl);
await cdp.connect();
await loadUnpacked(cdp, join(ROOT, 'extension'));
const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
await cdp.send('Page.enable', {}, sessionId);
await cdp.send('Runtime.enable', {}, sessionId);
await navigate(cdp, sessionId, url, { timeoutMs: 30000 });
await waitFor(cdp, sessionId, `document.documentElement.dataset.cvReady === '1'`, { timeoutMs: 15000 });
await sleep(1500);
const info = await evaluate(cdp, sessionId, `JSON.stringify((() => {
  const inputs = [...document.querySelectorAll('textarea, input[type=text]')].slice(0, 2);
  return inputs.map((el) => {
    let n = el;
    for (let i = 0; i < 6 && n; i++) n = n.parentElement;
    return {
      tag: el.tagName.toLowerCase(),
      up6text: n ? n.textContent.replace(/\\s+/g, ' ').trim().slice(0, 160) : 'none',
      up6html: n ? n.outerHTML.replace(/\\s+/g, ' ').slice(0, 600) : 'none',
      prevSibs: (() => {
        const out = [];
        let p = el;
        for (let i = 0; i < 3 && p; i++) {
          const pv = p.previousSibling;
          out.push(pv ? ('#' + pv.nodeType + ':' + (pv.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 30)) : 'null');
          p = p.parentElement;
        }
        return out.join(' | ');
      })()
    };
  });
})())`);
const arr = JSON.parse(info);
for (const a of arr) {
  console.log(`--- ${a.tag}`);
  console.log(`  prevSibs: ${a.prevSibs}`);
  console.log(`  up6text: ${a.up6text}`);
  console.log(`  up6html: ${a.up6html}`);
}
process.exit(0);
