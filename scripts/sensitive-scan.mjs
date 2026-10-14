/* Sensitive-data audit for the whole repository.
 *
 * Checks: personal identifiers, machine/user paths, credentials, binary metadata (PNG/PDF),
 *         suspicious file types, and the documented fictional demo data set.
 *
 * Usage: node scripts/sensitive-scan.mjs        (exit 1 when a HIGH finding exists)
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, dirname, relative, extname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const SKIP_DIRS = new Set(['.git', 'node_modules', '.dsh', 'dist', 'build']);
const TEXT_EXT = new Set(['.js', '.mjs', '.cjs', '.json', '.md', '.html', '.css', '.txt', '.yml', '.yaml', '.sh', '.ps1']);
const BIN_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.ico', '.pdf', '.zip', '.tgz', '.crx']);
const SUSPICIOUS_NAME = /(^|[._-])(env|log|bak|tmp|orig|save|swp|pem|key|p12|pfx|crt|credentials|secret|token|id_rsa)([._-]|$)/i;

// Values that are obviously placeholders, not real secrets/contacts.
const DUMMY_VALUE = /(dummy|fake|test|example|placeholder|sample|xxxx|abcd|your[-_ ]?key|<[^>]+>)/i;

/** Sensitive tokens are assembled from fragments so this scanner does not flag itself. */
const F = ['deep', 'seek', '-', 'harness'].join('');
const USER_DIR = ['Users'].join('');

const RULES = [
  ['windows-user-path', new RegExp(`[A-Za-z]:\\\\?${USER_DIR}\\\\?[^\\\\\\s"')]+`, 'g'), 'high'],
  ['harness-path', new RegExp(`D:\\\\DS\\\\|${F}|\\.dsh[\\\\/]`, 'g'), 'high'],
  ['mac-home-path', /\/Users\/[A-Za-z0-9._-]{2,}\//g, 'high'],
  ['linux-home-path', /\/home\/[A-Za-z0-9._-]{2,}\//g, 'high'],
  ['machine-name', /\b(DESKTOP|LAPTOP|WIN)-[A-Z0-9]{4,}\b/g, 'high'],
  ['api-key', /\b(sk-[A-Za-z0-9_-]{12,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{12,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g, 'high'],
  ['bearer-token', /\bBearer\s+[A-Za-z0-9._-]{16,}/g, 'high'],
  ['assigned-secret', /\b(api[_-]?key|secret|password|passwd|access[_-]?token)\b\s*[:=]\s*["']([^"']{6,})["']/gi, 'high'],
  ['private-key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/g, 'high'],
  ['url-credentials', /https?:\/\/[^\s"'/@]+:[^\s"'/@]+@/g, 'high'],
  ['email', /\b[A-Za-z0-9._%+-]+@(?!example\.(com|org|net)|localhost|b\.com|test\.com)[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, 'high'],
];

const DEMO_RULES = [
  ['cn-mobile-placeholder', /\b1[3-9]\d0{6,}\b/g],
  ['cn-id-placeholder', /\b0{17}[\dXx]\b/g],
  ['sample-name', /\b(张三|示例大学|示例科技|demo\.user@example\.com)\b/g],
];

const findings = [];
const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (!SKIP_DIRS.has(name)) walk(full);
    } else files.push(full);
  }
})(ROOT);

/** PNG ancillary text chunks (tEXt/iTXt/zTXt) and PDF metadata can carry paths/authors. */
function binaryMetadata(file) {
  const buf = readFileSync(file);
  const ext = extname(file).toLowerCase();
  if (ext === '.png') {
    const hits = [];
    let off = 8; // skip signature
    while (off + 8 <= buf.length) {
      const len = buf.readUInt32BE(off);
      const type = buf.toString('latin1', off + 4, off + 8);
      if (['tEXt', 'iTXt', 'zTXt', 'eXIf'].includes(type)) {
        hits.push(`${type}:${buf.toString('latin1', off + 8, Math.min(off + 8 + Math.min(len, 80), buf.length)).replace(/[^\x20-\x7e]/g, '.')}`);
      }
      if (type === 'IEND') break;
      off += 12 + len;
      if (len > buf.length) break;
    }
    return hits;
  }
  if (ext === '.pdf') {
    const text = buf.toString('latin1');
    const hits = [];
    for (const key of ['/Author', '/Creator', '/Producer', '/Title']) {
      const m = text.match(new RegExp(`${key}\\s*\\(([^)]{0,60})`));
      if (m) hits.push(`${key}=${m[1]}`);
    }
    return hits;
  }
  return [];
}

for (const file of files) {
  const rel = relative(ROOT, file).replace(/\\/g, '/');
  const ext = extname(file).toLowerCase();
  const name = basename(file);

  if (SUSPICIOUS_NAME.test(name)) {
    findings.push({ rel, line: 0, rule: 'suspicious-file', text: name, sev: 'high' });
  }

  if (BIN_EXT.has(ext)) {
    const meta = binaryMetadata(file);
    if (meta.length) findings.push({ rel, line: 0, rule: 'binary-metadata', text: meta.join(' | ').slice(0, 120), sev: 'high' });
    continue;
  }
  if (!TEXT_EXT.has(ext)) continue;

  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    if (line.length > 4000) return;
    for (const [rule, re, sev] of RULES) {
      re.lastIndex = 0;
      const m = line.match(re);
      if (!m) continue;
      const hit = m.join(' | ');
      if (DUMMY_VALUE.test(hit)) continue; // placeholder values are fine
      // "apiKey = apiKey" style self-assignments are not secrets
      if (rule === 'assigned-secret' && /^\s*["']?\w+["']?$/.test(hit.split(':').pop().trim())) continue;
      findings.push({ rel, line: i + 1, rule, text: hit.slice(0, 120), sev });
    }
    for (const [rule, re] of DEMO_RULES) {
      re.lastIndex = 0;
      const m = line.match(re);
      if (m) findings.push({ rel, line: i + 1, rule, text: m.slice(0, 3).join(' | '), sev: 'demo' });
    }
  });
}

const bySev = (s) => findings.filter((f) => f.sev === s);
const high = bySev('high');
const demo = bySev('demo');
console.log(`scanned ${files.length} files (${files.filter((f) => BIN_EXT.has(extname(f).toLowerCase())).length} binary)`);
console.log(`HIGH ${high.length} · DEMO-DATA ${demo.length}\n`);

if (high.length) {
  console.log('=== HIGH — must fix before publishing ===');
  for (const f of high) console.log(`${f.rel}:${f.line}  [${f.rule}]  ${f.text}`);
  console.log('');
}
if (demo.length) {
  const grouped = new Map();
  for (const f of demo) grouped.set(f.rule, (grouped.get(f.rule) || 0) + 1);
  console.log('=== DEMO-DATA — intentionally fictional, documented in README ===');
  for (const [rule, n] of grouped) console.log(`${rule}: ${n} occurrence(s)`);
  const filesWith = [...new Set(demo.map((f) => f.rel))];
  console.log(`files: ${filesWith.join(', ')}`);
}
process.exit(high.length ? 1 : 0);
