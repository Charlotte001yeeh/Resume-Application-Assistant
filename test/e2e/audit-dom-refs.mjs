/* Audit: (1) every getElementById('x') referenced by UI scripts vs the ids actually present in the HTML,
 *        (2) every raw `.value =` / `.checked =` write with its element lookup, to spot unguarded setters.
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');

const pairs = [
  ['extension/ui/options.js', 'extension/ui/options.html'],
  ['extension/ui/popup.js', 'extension/ui/popup.html'],
];

for (const [jsPath, htmlPath] of pairs) {
  const js = readFileSync(join(ROOT, jsPath), 'utf8');
  const html = readFileSync(join(ROOT, htmlPath), 'utf8');
  const htmlIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  const jsIds = new Set([...js.matchAll(/getElementById\('([^']+)'\)/g)].map((m) => m[1]));
  const missing = [...jsIds].filter((id) => !htmlIds.has(id));
  console.log(`--- ${jsPath}`);
  console.log(`    ids referenced: ${jsIds.size} · ids in html: ${htmlIds.size}`);
  console.log(`    referenced but MISSING in html: ${missing.length ? missing.join(', ') : 'none'}`);
}

console.log('\n--- raw .value / .checked writes (potential null setters) ---');
for (const [jsPath] of pairs.concat([['extension/src/content/content.js', null]])) {
  const js = readFileSync(join(ROOT, jsPath), 'utf8').split('\n');
  js.forEach((line, i) => {
    if (/\.(value|checked)\s*=[^=]/.test(line) && !/^\s*(\/\/|\*)/.test(line)) {
      const guarded = /setVal|setChk|if \(/.test(line);
      console.log(`${jsPath}:${i + 1}${guarded ? ' [guarded?]' : ''}  ${line.trim().slice(0, 110)}`);
    }
  });
}
