/* Debug: dump the matching decisions for table-form */
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { startServer } from './server.mjs';
import { launchChrome, loadUnpacked, Cdp, evaluate, bridge, waitFor, navigate } from './cdp.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const { baseUrl, server } = await startServer(join(HERE, 'fixtures'));
const userDataDir = mkdtempSync(join(tmpdir(), 'cv-dbg-'));
const { proc, endpoint } = await launchChrome({ extensionPath: join(ROOT, 'extension'), userDataDir });
const cdp = new Cdp(endpoint.webSocketDebuggerUrl);
await cdp.connect();
await loadUnpacked(cdp, join(ROOT, 'extension'));
const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
await cdp.send('Page.enable', {}, sessionId);
await cdp.send('Runtime.enable', {}, sessionId);
await navigate(cdp, sessionId, `${baseUrl}/table-form.html`);
await waitFor(cdp, sessionId, `document.documentElement.dataset.cvReady === '1'`);
const scan0 = await bridge(cdp, sessionId, 'scan');
console.log('SCAN:');
for (const f of scan0.fields) console.log(`  ${f.id.padEnd(12)} label="${f.label}"  cellLabel="${f.cellLabel}"  nearby="${f.nearby}"`);
const report = await bridge(cdp, sessionId, 'fill');
for (const d of report.decisions) {
  console.log(`DEC ${d.confidence.padEnd(6)} ${String(d.score).padStart(3)} ${d.fieldKey.padEnd(18)} label="${d.label}" | ${d.reasons.join('; ')}`);
}
console.log('BATCH:', JSON.stringify((report.batch || []).map((b) => [b.label, b.suggestedField, b.score ?? '', b.duplicateOf]), null, 1));
const scan = await bridge(cdp, sessionId, 'scan');
console.log('SCAN:', JSON.stringify(scan.fields.map((f) => [f.id, f.label]), null, 0));
cdp.close();
proc.kill();
server.close();
process.exit(0);
