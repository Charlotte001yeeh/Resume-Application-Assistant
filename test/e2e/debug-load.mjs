/* Quick diagnostic: is the extension loaded, and is the content script injected? */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { startServer } from './server.mjs';
import { launchChrome, Cdp, evaluate, navigate } from './cdp.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');

const { server, baseUrl } = await startServer(join(HERE, 'fixtures'));
const userDataDir = mkdtempSync(join(tmpdir(), 'cv-debug-'));
const { proc, endpoint } = await launchChrome({ extensionPath: join(ROOT, 'extension'), userDataDir, port: 9444 });
try {
  await sleep(1500);
  const list = await (await fetch(`http://127.0.0.1:9444/json/list`)).json();
  console.log('targets:');
  for (const t of list) console.log(' -', t.type, t.url);

  const ver = await (await fetch(`http://127.0.0.1:9444/json/version`)).json();
  console.log('browser:', ver.Browser);

  const cdp = new Cdp(endpoint.webSocketDebuggerUrl);
  await cdp.connect();
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Runtime.enable', {}, sessionId);
  const consoleMsgs = [];
  cdp.on('Runtime.consoleAPICalled', (p) => consoleMsgs.push(p.type + ': ' + (p.args || []).map((a) => a.value).join(' ')), sessionId);
  cdp.on('Runtime.exceptionThrown', (p) => consoleMsgs.push('EXC: ' + JSON.stringify(p.exceptionDetails && (p.exceptionDetails.exception && p.exceptionDetails.exception.description || p.exceptionDetails.text)).slice(0, 600)), sessionId);
  await navigate(cdp, sessionId, `${baseUrl}/cn-form.html`);
  await sleep(2500);
  const info = await evaluate(cdp, sessionId, `JSON.stringify({
    cvReady: document.documentElement.dataset.cvReady || null,
    cvVersion: document.documentElement.dataset.cvVersion || null,
    fab: !!document.getElementById('cv-fab'),
    scripts: [...document.scripts].length,
    href: location.href
  })`);
  console.log('page info:', info);
  await sleep(500);
  console.log('console:', consoleMsgs);
  cdp.close();
} finally {
  proc.kill();
  server.close();
}
