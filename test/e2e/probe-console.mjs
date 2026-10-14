/* Probe: open every extension page in a real Chrome and report console errors / uncaught exceptions. */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { launchChrome, loadUnpacked, Cdp, evaluate, waitFor, navigate } from './cdp.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const userDataDir = mkdtempSync(join(tmpdir(), 'cv-console-'));
const { proc, endpoint } = await launchChrome({ extensionPath: join(ROOT, 'extension'), userDataDir });
const cdp = new Cdp(endpoint.webSocketDebuggerUrl);
await cdp.connect();
const extensionId = await loadUnpacked(cdp, join(ROOT, 'extension'));
console.log('extensionId =', extensionId);

const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
await cdp.send('Page.enable', {}, sessionId);
await cdp.send('Runtime.enable', {}, sessionId);

const problems = [];
cdp.on('Runtime.exceptionThrown', (p) => problems.push(`EXCEPTION: ${p.exceptionDetails?.exception?.description || p.exceptionDetails?.text}`), sessionId);
cdp.on(
  'Runtime.consoleAPICalled',
  (p) => {
    if (p.type === 'error' || p.type === 'warning') {
      problems.push(`${p.type.toUpperCase()}: ${(p.args || []).map((a) => a.value || a.description || '').join(' ')}`);
    }
  },
  sessionId
);

for (const page of ['ui/options.html', 'ui/popup.html']) {
  problems.length = 0;
  await navigate(cdp, sessionId, `chrome-extension://${extensionId}/${page}`);
  await sleep(1500);
  const state = await evaluate(
    cdp,
    sessionId,
    `JSON.stringify({
      cvi18n: typeof (globalThis.CVCore || {}).i18n,
      cvOptions: typeof window.CVOptions,
      lang: document.documentElement.lang,
      controls: document.querySelectorAll('input, select, textarea, button').length,
      heading: (document.querySelector('h1') || {}).textContent || ''
    })`
  );
  console.log(`--- ${page} (en)`);
  console.log('   state:', state);
  console.log('   console problems:', problems.length ? problems : 'none');
}

// ── Chinese phase: the failing path is applyDom + renderSettings in zh mode ──
await navigate(cdp, sessionId, `chrome-extension://${extensionId}/ui/options.html`);
await sleep(1200);
await evaluate(cdp, sessionId, `window.CVOptions.setLang('zh')`);
await sleep(600);

for (const page of ['ui/options.html', 'ui/popup.html']) {
  problems.length = 0;
  await navigate(cdp, sessionId, `chrome-extension://${extensionId}/${page}`);
  await sleep(1600);
  const state = await evaluate(
    cdp,
    sessionId,
    `JSON.stringify({
      lang: document.documentElement.lang,
      controls: document.querySelectorAll('input, select, textarea, button').length,
      criticalIds: ['setLang', 'setAutoFill', 'setFab', 'setSiteMode', 'setAllowed', 'setBlocked', 'setLlmEnabled', 'setVlmEnabled', 'setVlmStudy', 'setLlmBase', 'setLlmKey', 'setLlmModel', 'fabToggle', 'langSelect']
        .filter((id) => document.getElementById(id))
        .length,
      heading: (document.querySelector('h1') || {}).textContent || ''
    })`
  );
  console.log(`--- ${page} (zh)`);
  console.log('   state:', state);
  console.log('   console problems:', problems.length ? problems : 'none');
}

// trigger the settings render path again in zh (this is what threw before)
problems.length = 0;
await navigate(cdp, sessionId, `chrome-extension://${extensionId}/ui/options.html`);
await sleep(1200);
await evaluate(cdp, sessionId, `document.getElementById('btnSaveSettings').click()`);
await sleep(800);
await evaluate(cdp, sessionId, `window.CVOptions.saveAll()`).catch(() => {});
await sleep(800);
console.log('--- options (zh): after Save Settings + saveAll');
console.log('   console problems:', problems.length ? problems : 'none');
console.log('   backupStatus:', await evaluate(cdp, sessionId, `document.getElementById('backupStatus').textContent.trim()`));

cdp.close();
proc.kill();
process.exit(0);
