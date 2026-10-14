/* Live run against real resume sites: real Chrome opens real application form pages -> scan / recognize /
 * auto-fill (never submit) -> emit a report.
 * Targets: real application/registration forms hosted on wenjuan.com (including a real Beisen job application form).
 * Usage: node test/e2e/live-sites.mjs
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { launchChrome, loadUnpacked, Cdp, evaluate, bridge, waitFor, navigate } from './cdp.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const ARTIFACTS = join(ROOT, 'test', 'artifacts');
mkdirSync(ARTIFACTS, { recursive: true });

const SITES = [
  { name: 'Real application registration form (Beisen · Key Account Sales Director role)', url: 'https://www.wenjuan.com/s/yUFNriL/' },
  { name: 'Real job-seeker resume registration form', url: 'https://www.wenjuan.com/s/bm2Aryf/' },
  { name: 'Real application registration form (general)', url: 'https://www.wenjuan.com/s/ieEfaaR/' },
];

const results = [];
const userDataDir = mkdtempSync(join(tmpdir(), 'cv-live-'));
const { proc, endpoint } = await launchChrome({ extensionPath: join(ROOT, 'extension'), userDataDir });
const cdp = new Cdp(endpoint.webSocketDebuggerUrl);
await cdp.connect();
await loadUnpacked(cdp, join(ROOT, 'extension'));
const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
await cdp.send('Page.enable', {}, sessionId);
await cdp.send('Runtime.enable', {}, sessionId);
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false }, sessionId);

let idx = 0;
for (const site of SITES) {
  idx++;
  console.log(`\n───── ${site.name} ─────`);
  console.log(`URL: ${site.url}`);
  const entry = { name: site.name, url: site.url, ok: false };
  try {
    await navigate(cdp, sessionId, site.url, { timeoutMs: 30000 });
    await waitFor(cdp, sessionId, `document.documentElement.dataset.cvReady === '1'`, { timeoutMs: 15000 });
    // SPA renders dynamically: poll-scan until form controls show up (<=8s)
    let scan = null;
    for (let i = 0; i < 16; i++) {
      scan = await bridge(cdp, sessionId, 'scan');
      if (scan && scan.count > 0) break;
      await sleep(500);
    }
    entry.scanned = scan ? scan.count : 0;
    entry.labels = (scan ? scan.fields : []).map((f) => f.label || f.cellLabel).filter(Boolean);
    if (!entry.scanned) {
      entry.note = 'No scannable controls on the page (may require login, or JS never rendered)';
      console.log(`   ⚠️ ${entry.note}`);
    } else {
      const report = await bridge(cdp, sessionId, 'fill');
      entry.auto = report.auto;
      entry.review = report.needReview;
      entry.matched = report.matched;
      entry.unmatched = report.unmatched;
      entry.mappings = (report.decisions || []).map((d) => ({ label: d.label, fieldKey: d.fieldKey, score: d.score, confidence: d.confidence }));
      entry.filled = (report.results || []).filter((r) => r.ok).map((r) => ({ label: r.label, value: String(r.value).slice(0, 30) }));
      entry.batch = (report.batch || []).map((b) => b.label);
      entry.ok = true;
      console.log(`   Scanned ${entry.scanned} controls · matched ${entry.matched} · auto-filled ${entry.auto} · needs review ${entry.review} · unrecognized ${entry.unmatched}`);
      console.log(`   Filled fields: ${entry.filled.map((f) => `${f.label}=${f.value}`).slice(0, 8).join('；')}`);
      console.log(`   Needs review: ${(entry.batch || []).join('、') || 'none'}`);
    }
    const shotName = `live-${String(idx).padStart(2, '0')}.png`;
    try {
      const shotRes = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }, sessionId);
      writeFileSync(join(ARTIFACTS, shotName), Buffer.from(shotRes.data, 'base64'));
      entry.screenshot = shotName;
    } catch (e) {
      /* ignore screenshot failures */
    }
  } catch (e) {
    entry.note = `Failed to visit: ${String(e && e.message || e).slice(0, 80)}`;
    console.log(`   ❌ ${entry.note}`);
  }
  results.push(entry);
}

const summary = {
  generatedAt: new Date().toISOString(),
  note: 'Live-site run (fills only, never submits; data stays in page memory only)',
  total: results.length,
  reachable: results.filter((r) => r.ok).length,
  results,
};
writeFileSync(join(ARTIFACTS, 'live-sites-report.json'), JSON.stringify(summary, null, 2));
console.log(`\n═══ Live-site run: ${summary.reachable}/${summary.total} sites scanned and filled successfully ═══`);
console.log(`Report: test/artifacts/live-sites-report.json`);
cdp.close();
proc.kill();
process.exit(0);
