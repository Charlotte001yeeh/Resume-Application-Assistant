/* Real deployment demo: load the CV Plugin extension into a local Chrome plus the mock application page,
 * and keep running so a human can try it out. */
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { startServer } from './server.mjs';
import { launchChrome, loadUnpacked, Cdp, navigate } from './cdp.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const EXT_PATH = join(ROOT, 'extension');
// Cross-platform demo profile (Windows: ~\AppData\Local…; macOS/Linux: ~/.cv-plugin-demo-profile)
const DEMO_PROFILE =
  OS_LOCALAPPDATA() || join(homedir(), '.cv-plugin-demo-profile');
function OS_LOCALAPPDATA() {
  return process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'cv-plugin-demo-profile') : null;
}
mkdirSync(DEMO_PROFILE, { recursive: true });

const { baseUrl } = await startServer(join(HERE, 'fixtures'), 8765);
console.log(`[demo] Mock application page: ${baseUrl}/cn-form.html`);

const { proc, endpoint } = await launchChrome({
  extensionPath: EXT_PATH,
  userDataDir: DEMO_PROFILE,
  port: 9777,
  width: 1500,
  height: 1000,
});
console.log(`[demo] Chrome started (demo profile: ${DEMO_PROFILE})`);

const cdp = new Cdp(endpoint.webSocketDebuggerUrl);
await cdp.connect();
let extensionId = null;
try {
  extensionId = await loadUnpacked(cdp, EXT_PATH);
  console.log(`[demo] Extension loaded: ${extensionId}`);
} catch (e) {
  console.log(`[demo] loadUnpacked: ${e.message} (if the first load on the demo profile fails, reopen chrome://extensions and load the extension/ folder manually)`);
}
const { targetId } = await cdp.send('Target.createTarget', { url: `${baseUrl}/cn-form.html` });
const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
await cdp.send('Page.enable', {}, sessionId);
await cdp.send('Runtime.enable', {}, sessionId);
await navigate(cdp, sessionId, `${baseUrl}/cn-form.html`);
console.log(`[demo] Chinese application form is open: click the CV button at the bottom right -> "One-click Fill" / "Resume Review" / "Learn From This Page"`);
console.log(`[demo] Profile manager: chrome-extension://${extensionId}/ui/options.html`);
console.log('[demo] Still running... (to finish, close this Chrome window and stop the task)');

// Keep the process alive (server + Chrome session)
setInterval(() => {}, 60000);
process.on('SIGTERM', () => {
  try {
    proc.kill();
  } catch {}
  process.exit(0);
});
