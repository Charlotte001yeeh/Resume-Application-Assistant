/* Demo deployment: static server for the local mock application pages (fixed port 8765, for manual try-out) */
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './server.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const { baseUrl } = await startServer(join(HERE, 'fixtures'), 8765);
console.log(`Demo pages are up: ${baseUrl}/cn-form.html  (Chinese application form)`);
console.log(`                     ${baseUrl}/en-form.html  (English application form)`);
console.log(`                     ${baseUrl}/prefilled.html (open questions / resume review)`);
