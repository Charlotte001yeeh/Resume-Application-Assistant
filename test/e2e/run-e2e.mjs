/* E2E end-to-end test: real Chrome loads the unpacked extension (--load-extension),
 * full-flow verification on local mock application pages: scan / semantic fill / resume checkup / profile persistence / learn from this page.
 * Zero third-party dependencies (Node built-in WebSocket drives CDP). Usage: node run-e2e.mjs [--headless]
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { startServer } from './server.mjs';
import { launchChrome, loadUnpacked, Cdp, evaluate, bridge, waitFor, navigate } from './cdp.mjs';
import { buildPdf, enResumeContent, cnResumeFixture } from '../_pdfgen.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const EXT_PATH = join(ROOT, 'extension');
const ARTIFACTS = join(ROOT, 'test', 'artifacts');
const HEADLESS = process.argv.includes('--headless') || process.env.CV_E2E_HEADLESS === '1';

mkdirSync(ARTIFACTS, { recursive: true });

const results = [];
function check(name, cond, detail = '') {
  results.push({ name, pass: !!cond, detail: String(detail) });
  console.log(`${cond ? '✅ PASS' : '❌ FAIL'}  ${name}${detail ? `  —— ${detail}` : ''}`);
}

function section(title) {
  console.log(`\n───── ${title} ─────`);
}

async function shot(cdp, sessionId, filename) {
  try {
    const res = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }, sessionId);
    writeFileSync(join(ARTIFACTS, filename), Buffer.from(res.data, 'base64'));
    console.log(`   📸 ${filename}`);
    return filename;
  } catch (e) {
    console.log(`   ⚠️ screenshot failed: ${e.message}`);
    return null;
  }
}

async function main() {
  const { server, baseUrl } = await startServer(join(HERE, 'fixtures'));
  const serverB = await startServer(join(HERE, 'fixtures')); // second port: for cross-origin iframes
  const baseUrlB = serverB.baseUrl;
  const userDataDir = mkdtempSync(join(tmpdir(), 'cv-plugin-e2e-'));
  let chromeProc = null;
  let cdp = null;
  const screenshots = [];

  try {
    section('Launch local Chrome and load the extension (real deployment form)');
    const { proc, endpoint, chromePath } = await launchChrome({
      headless: HEADLESS,
      extensionPath: EXT_PATH,
      userDataDir,
    });
    chromeProc = proc;
    console.log(`   Chrome: ${chromePath}${HEADLESS ? ' (headless)' : ' (real window)'}`);
    console.log(`   debug endpoint: ${endpoint.webSocketDebuggerUrl}`);
    cdp = new Cdp(endpoint.webSocketDebuggerUrl);
    await cdp.connect();

    // Chrome 137+ removed --load-extension: use CDP Extensions.loadUnpacked instead (equivalent to "Load unpacked" on chrome://extensions)
    let extensionId = null;
    try {
      extensionId = await loadUnpacked(cdp, EXT_PATH);
      console.log(`   extension loaded (loadUnpacked): ${extensionId}`);
    } catch (e) {
      console.log(`   loadUnpacked unavailable (${e.message}); falling back to --load-extension`);
    }

    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Runtime.enable', {}, sessionId);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 940, deviceScaleFactor: 1, mobile: false }, sessionId);

    // ── 1. Extension injection & profile ready ────────────────────────────────
    section('1. Extension injection / profile initialization (requirement 1: long-term retention)');
    await navigate(cdp, sessionId, `${baseUrl}/cn-form.html`);
    await waitFor(cdp, sessionId, `document.documentElement.dataset.cvReady === '1'`);
    let state = await bridge(cdp, sessionId, 'state');
    check('extension content script injected', !!state.extensionId && (!extensionId || state.extensionId === extensionId), `extensionId=${state.extensionId}`);
    check('sample profile auto-written on first install', state.fieldCount > 40, `${state.fieldCount} profile fields`);
    let prof = await bridge(cdp, sessionId, 'profile');
    check('key profile fields complete (name/phone/email/education/skills…)',
      prof.fullName === '张三' && prof.phone === '13800000000' && prof.highestEducation === 'master' && !!prof.skills,
      `fullName=${prof.fullName}`);

    // ── 2. Options profile management: edit + persistence ─────────────────────
    section('2. Profile management page: edit and keep long-term (requirement 1)');
    await navigate(cdp, sessionId, `chrome-extension://${state.extensionId}/ui/options.html`);
    await waitFor(cdp, sessionId, `!!(window.CVOptions && window.CVOptions.getField)`);
    await evaluate(cdp, sessionId, `window.CVOptions.setField('desiredPosition', '资深前端架构师')`);
    await sleep(400);
    await navigate(cdp, sessionId, `chrome-extension://${state.extensionId}/ui/options.html`);
    await waitFor(cdp, sessionId, `!!(window.CVOptions && window.CVOptions.getField)`);
    const persisted = await evaluate(cdp, sessionId, `window.CVOptions.getField('desiredPosition')`);
    check('edits on the options page survive reload (chrome.storage.local persistence)', persisted === '资深前端架构师', `desiredPosition=${persisted}`);
    const badge = await evaluate(cdp, sessionId, `document.getElementById('fieldBadge').textContent`);
    check('options page shows the profile field count', Number(badge) > 40, `badge=${badge}`);

    // i18n: frontend display language switch (English default <-> Chinese)
    const enText = await evaluate(cdp, sessionId, `document.getElementById('btnSave').textContent.trim()`);
    check('i18n: options page defaults to English', enText === 'Save All Changes', enText);
    const zhText = await evaluate(cdp, sessionId, `window.CVOptions.setLang('zh').then(() => document.getElementById('btnSave').textContent.trim())`);
    check('i18n: switching to Chinese localizes the page', zhText === '保存全部修改', zhText);
    const zhSaved = await evaluate(cdp, sessionId, `chrome.storage.local.get('cvSettings').then((o) => (o.cvSettings || {}).lang)`);
    check('i18n: language choice persists in settings', zhSaved === 'zh', `lang=${zhSaved}`);
    const enBack = await evaluate(cdp, sessionId, `window.CVOptions.setLang('en').then(() => document.getElementById('btnSave').textContent.trim())`);
    check('i18n: switching back restores English', enBack === 'Save All Changes', enBack);
    // dynamic (JS-generated) options text must follow the language too
    const zhStatus = await evaluate(cdp, sessionId, `window.CVOptions.setLang('zh').then(() => document.getElementById('backupStatus').textContent.trim())`);
    check('i18n: options page dynamic status text is Chinese', /自动备份/.test(zhStatus), zhStatus.slice(0, 30));
    const optSwitches = await evaluate(
      cdp,
      sessionId,
      `JSON.stringify({
        fab: (document.getElementById('setFab') || {}).type || '',
        auto: (document.getElementById('setAutoFill') || {}).type || '',
        lang: (document.getElementById('setLang') || {}).tagName || '',
        switches: document.querySelectorAll('.switch input[type="checkbox"]').length
      })`
    );
    const os = JSON.parse(optSwitches);
    check('options switches survive the language switch (controls intact)', os.fab === 'checkbox' && os.auto === 'checkbox' && os.lang === 'SELECT' && os.switches >= 3, optSwitches);
    const zhFieldLabel = await evaluate(cdp, sessionId, `(document.querySelector('#profileEditor label') || {}).textContent || ''`);
    const zhCat = await evaluate(cdp, sessionId, `(document.querySelector('#profileEditor h2') || {}).textContent || ''`);
    check('i18n: field labels / category headings lead with Chinese', /[\u4e00-\u9fff]/.test(zhFieldLabel) && /^[\u4e00-\u9fff]/.test(zhCat.trim()), `${zhFieldLabel} | ${zhCat}`);
    await evaluate(cdp, sessionId, `window.CVOptions.setLang('en')`);
    const enStatus = await evaluate(cdp, sessionId, `document.getElementById('backupStatus').textContent.trim()`);
    const enCat = await evaluate(cdp, sessionId, `(document.querySelector('#profileEditor h2') || {}).textContent || ''`);
    check('i18n: English mode leads with English (no Chinese in headings/status)', /^Auto backup/.test(enStatus) && /^[A-Za-z]/.test(enCat.trim()), `${enStatus.slice(0, 24)} | ${enCat}`);

    // Multiple resume sets (different phrasings for different companies)
    const created = await evaluate(cdp, sessionId, `window.CVOptions.profiles.create({ name: '投递公司A（测试）', clone: false })`);
    check('creates an independent resume set', !!created && !!created.id && String(created.name).includes('公司A'), JSON.stringify(created));
    const list1 = await evaluate(cdp, sessionId, `window.CVOptions.profiles.list()`);
    check('two resume sets in total and the new one is active', list1.profiles.length === 2 && list1.activeId === created.id, `active=${list1.activeId}`);
    const emptyName = await evaluate(cdp, sessionId, `window.CVOptions.getField('fullName')`);
    check('the new set is blank and the original set is unaffected', !emptyName, `fullName=${JSON.stringify(emptyName)}`);
    const defaultId = list1.profiles.find((p) => p.id !== created.id).id;
    await evaluate(cdp, sessionId, `window.CVOptions.profiles.activate(${JSON.stringify(defaultId)})`);
    const backName = await evaluate(cdp, sessionId, `window.CVOptions.getField('fullName')`);
    check('switching back to the original set restores its fields', backName === '张三', backName);
    const renamed = await evaluate(cdp, sessionId, `window.CVOptions.profiles.rename(${JSON.stringify(created.id)}, '投递公司B')`);
    check('renames the resume set', renamed && renamed.name === '投递公司B', JSON.stringify(renamed));
    await evaluate(cdp, sessionId, `window.CVOptions.profiles.remove(${JSON.stringify(created.id)})`);
    const list2 = await evaluate(cdp, sessionId, `window.CVOptions.profiles.list()`);
    check('after deletion falls back to a single set (at least one set remains)', list2.profiles.length === 1 && list2.activeId === defaultId, JSON.stringify(list2.profiles));

    // PDF resume import (recognizes existing/similar fields, creates unknown fields; supports importing as an independent set)
    const cnFx = cnResumeFixture();
    const pdfBuf = buildPdf({ contents: [enResumeContent(), cnFx.content], cmaps: [cnFx.cmap], flate: true });
    const pdfB64 = pdfBuf.toString('base64');
    await evaluate(cdp, sessionId, `(() => {
      const b64 = ${JSON.stringify(pdfB64)};
      const bin = atob(b64); const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      const file = new File([arr], 'john-doe-resume.pdf', { type: 'application/pdf' });
      const dt = new DataTransfer(); dt.items.add(file);
      const input = document.getElementById('fileImport');
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return 'sent';
    })()`);
    await waitFor(cdp, sessionId, `!!(window.CVOptions && window.CVOptions.getImportPreview && window.CVOptions.getImportPreview())`, { timeoutMs: 20000 });
    const preview = await evaluate(cdp, sessionId, `window.CVOptions.getImportPreview()`);
    check('PDF resume extracted and fields recognized (fullName)', preview && preview.values && preview.values.fullName === 'John Doe', JSON.stringify(preview && preview.values));
    check('PDF field mapping (University → school)', preview.values.school === 'MIT', String(preview.values.school));
    check('PDF Chinese recognition (ToUnicode CMap: education = master)', preview.values.highestEducation === '硕士', String(preview.values.highestEducation));
    check('unknown PDF fields become custom fields', Array.isArray(preview.customFields) && preview.customFields.some((c) => c.label === 'Extra'), JSON.stringify(preview.customFields));
    await evaluate(cdp, sessionId, `document.getElementById('importMode').value = 'new'; window.CVOptions.applyImport();`);
    await sleep(500);
    const list3 = await evaluate(cdp, sessionId, `window.CVOptions.profiles.list()`);
    check('PDF imported as an independent resume set (multiple resume sets)', list3.profiles.length === 2, `profiles=${list3.profiles.length}`);
    const pdfProfileId = list3.profiles.find((p) => p.id !== list3.activeId).id;
    await evaluate(cdp, sessionId, `window.CVOptions.profiles.activate(${JSON.stringify(pdfProfileId)})`);
    const pdfFullName = await evaluate(cdp, sessionId, `window.CVOptions.getField('fullName')`);
    const pdfEmail = await evaluate(cdp, sessionId, `window.CVOptions.getField('email')`);
    check('imported set content complete (name/email)', pdfFullName === 'John Doe' && pdfEmail === 'john.doe@example.com', `${pdfFullName} / ${pdfEmail}`);
    await evaluate(cdp, sessionId, `window.CVOptions.profiles.activate(${JSON.stringify(defaultId)})`);
    await evaluate(cdp, sessionId, `window.CVOptions.profiles.remove(${JSON.stringify(pdfProfileId)})`);
    const backName2 = await evaluate(cdp, sessionId, `window.CVOptions.getField('fullName')`);
    check('original profile unaffected after cleaning up the imported set', backName2 === '张三', backName2);

    // Full backup / disaster recovery (data safety)
    const bundle = await evaluate(cdp, sessionId, `window.CVOptions.exportAllJson()`);
    const parsedBundle = JSON.parse(bundle);
    check('full backup contains all resume sets and settings', parsedBundle.type === 'full-backup' && Object.keys(parsedBundle.profiles).length === 1 && !!parsedBundle.settings, `${parsedBundle.type} / ${Object.keys(parsedBundle.profiles).length} set(s)`);
    const restored = await evaluate(cdp, sessionId, `window.CVOptions.restoreAll(${JSON.stringify(bundle)})`);
    check('restores from a full backup (simulated post-reinstall recovery)', restored && restored.profiles === 1, JSON.stringify(restored));
    const afterRestore = await evaluate(cdp, sessionId, `window.CVOptions.getField('fullName')`);
    check('data complete after restore', afterRestore === '张三', afterRestore);
    const backupUi = await evaluate(cdp, sessionId, `!!(document.getElementById('btnAutoBackup') && document.getElementById('btnBackupNow') && document.getElementById('btnRestoreAll'))`);
    check('data safety & backup UI ready', backupUi);
    screenshots.push(await shot(cdp, sessionId, '01-options-profile.png'));

    // ── 3. Chinese form: scan + semantic auto-fill (requirement 2) ─────────────
    section('3. Chinese application form: semantic recognition + auto-fill (requirement 2)');
    await navigate(cdp, sessionId, `${baseUrl}/cn-form.html`);
    await waitFor(cdp, sessionId, `document.documentElement.dataset.cvReady === '1'`);
    const scan = await bridge(cdp, sessionId, 'scan');
    check('form fields scanned', scan.count >= 20, `${scan.count} fields scanned`);
    const fillReport = await bridge(cdp, sessionId, 'fill');
    check('high-confidence fields auto-filled', fillReport.auto >= 15, `auto=${fillReport.auto} review=${fillReport.needReview} unmatched=${fillReport.unmatched}`);

    const vals = await evaluate(cdp, sessionId, `JSON.stringify({
      realname: document.getElementById('realname').value,
      mobile: document.getElementById('mobile').value,
      mail: document.getElementById('mail').value,
      sex: document.getElementById('sex').selectedOptions[0].text,
      birthday: document.getElementById('birthday').value,
      idcard: document.getElementById('idcard').value,
      political: document.getElementById('political').selectedOptions[0].text,
      livecity: document.getElementById('livecity').value,
      homeaddr: document.getElementById('homeaddr').value.slice(0, 10),
      zipcode: document.getElementById('zipcode').value,
      edu: document.getElementById('edu').selectedOptions[0].text,
      school: document.getElementById('school').value,
      major: document.getElementById('major').value,
      gradtime: document.getElementById('gradtime').value,
      workyears: document.getElementById('workyears').value,
      company: document.getElementById('company').value,
      jobtitle: document.getElementById('jobtitle').value,
      wantjob: document.getElementById('wantjob').value,
      wantcity: document.getElementById('wantcity').value,
      salary: document.getElementById('salary').value,
      arrive: document.getElementById('arrive').selectedOptions[0].text,
      jobtype: document.querySelector('input[name=jobtype]:checked') ? document.querySelector('input[name=jobtype]:checked').parentElement.textContent.trim() : '',
      langs: [...document.querySelectorAll('input[name=langs]:checked')].map(x => x.parentElement.textContent.trim()),
      selfeval: document.getElementById('selfeval').value.slice(0, 7),
      hobby: document.getElementById('hobby').value,
      companytel: document.getElementById('companytel').value
    })`);
    const v = JSON.parse(vals);
    check('name recognized and filled', v.realname === '张三', v.realname);
    check('mobile phone recognized and filled', v.mobile === '13800000000', v.mobile);
    check('email recognized and filled', v.mail === 'demo.user@example.com', v.mail);
    check('gender dropdown (semantic synonym: male)', v.sex === '男', v.sex);
    check('birth date (date format normalized)', v.birthday === '1995-06-18', v.birthday);
    check('ID number filled', v.idcard === '000000000000000000', v.idcard);
    check('political status dropdown (semantic synonym: party member)', v.political === '中共党员', v.political);
    check('current city (city of residence)', v.livecity === '北京市', v.livecity);
    check('mailing address (textarea)', String(v.homeaddr).trim() === '北京市海淀区示例路', v.homeaddr);
    check('zip code (autocomplete=postal-code)', v.zipcode === '100080', v.zipcode);
    check('highest education dropdown (semantic synonym: master)', v.edu === '硕士', v.edu);
    check('university', v.school === '示例大学', v.school);
    check('major', v.major === 'Computer Science', v.major);
    check('graduation date', v.gradtime === '2020-06-30', v.gradtime);
    check('years of experience (number)', v.workyears === '5', v.workyears);
    check('current company', v.company === '示例科技有限公司', v.company);
    check('current job title', v.jobtitle === '高级前端工程师', v.jobtitle);
    check('desired position (new options-page value takes effect across pages)', v.wantjob === '资深前端架构师', v.wantjob);
    check('desired city', v.wantcity === '北京', v.wantcity);
    check('expected salary', v.salary === '30k-40k', v.salary);
    check('start date dropdown (semantic synonym: within1month)', v.arrive === '一个月内', v.arrive);
    check('job type radio (semantic synonym: fullTime)', v.jobtype === '全职', v.jobtype);
    check('language skills checkboxes (English + Mandarin)', v.langs.includes('英语') && v.langs.includes('普通话') && !v.langs.includes('日语'), JSON.stringify(v.langs));
    check('self evaluation (long text)', v.selfeval === '五年企业级前端', v.selfeval);
    check('hobbies', v.hobby === '跑步、开源贡献、摄影', v.hobby);
    check('conflicting field (company phone) not wrongly filled', v.companytel === '', `companytel="${v.companytel}"`);

    const events = await evaluate(cdp, sessionId, `JSON.stringify(window.__cvEvents)`);
    const ev = JSON.parse(events);
    check('input/change events dispatched (React/Vue controlled-component compatibility)',
      (ev['realname:input'] || 0) >= 1 && (ev['realname:change'] || 0) >= 1 && (ev['edu:change'] || 0) >= 1,
      `realname:input=${ev['realname:input']} edu:change=${ev['edu:change']}`);
    const stateCount = await evaluate(cdp, sessionId, `window.__cvRerender()`);
    check('values survive controlled-component "re-render" (events reach framework state)', Number(stateCount) > 10, `state keys=${stateCount}`);
    screenshots.push(await shot(cdp, sessionId, '02-cn-form-filled.png'));

    // ── 4. English form (multilingual semantics) ──────────────────────────────
    section('4. English application form: cross-language semantic matching (requirement 2)');
    await navigate(cdp, sessionId, `${baseUrl}/en-form.html`);
    await waitFor(cdp, sessionId, `document.documentElement.dataset.cvReady === '1'`);
    const fillEn = await bridge(cdp, sessionId, 'fill');
    check('English form auto-filled', fillEn.auto >= 10, `auto=${fillEn.auto} matched=${fillEn.matched}`);
    const evVals = await evaluate(cdp, sessionId, `JSON.stringify({
      fname: document.getElementById('fname').value,
      tel: document.getElementById('tel').value,
      email: document.getElementById('email').value,
      gender: document.getElementById('gender').selectedOptions[0].text,
      dob: document.getElementById('dob').value,
      edu: document.getElementById('edu').selectedOptions[0].text,
      uni: document.getElementById('uni').value,
      years: document.getElementById('years').value,
      position: document.getElementById('position').value,
      salary: document.getElementById('salary').value,
      start: document.getElementById('start').selectedOptions[0].text,
      selfeval: document.getElementById('selfeval').value.length,
      zip: document.getElementById('zip').value
    })`);
    const e = JSON.parse(evVals);
    check('Full name (Chinese names fill too)', e.fname === '张三', e.fname);
    check('Contact number', e.tel === '13800000000', e.tel);
    check('Email address', e.email === 'demo.user@example.com', e.email);
    check('Gender select (Male↔male)', e.gender === 'Male', e.gender);
    check('Date of birth', e.dob === '1995-06-18', e.dob);
    check('Highest education (Master↔master)', e.edu === 'Master', e.edu);
    check('University', e.uni === '示例大学', e.uni);
    check('Years of experience', e.years === '5', e.years);
    check('Desired position', e.position === '资深前端架构师', e.position);
    check('Expected salary', e.salary === '30k-40k', e.salary);
    check('Available to start (Within a month↔within1month)', e.start === 'Within a month', e.start);
    check('Self evaluation long text', e.selfeval > 20, `length=${e.selfeval}`);
    check('Zip code', e.zip === '100080', e.zip);
    screenshots.push(await shot(cdp, sessionId, '03-en-form-filled.png'));

    // ── Table-style application page enhancements (51job-style multiple groups per row + noise labels + batch-confirm material) ──
    section('Table-style application page: 51job-style multiple groups per row / group rows / unit-noise labels');
    await navigate(cdp, sessionId, `${baseUrl}/table-form.html`);
    await waitFor(cdp, sessionId, `document.documentElement.dataset.cvReady === '1'`);
    const tableFill = await bridge(cdp, sessionId, 'fill');
    check('table page auto-filled (proximity pairing of multiple groups per row)', tableFill.auto >= 8, `auto=${tableFill.auto}`);
    const tv = await evaluate(cdp, sessionId, `JSON.stringify({
      t_name: document.getElementById('t_name').value,
      t_phone: document.getElementById('t_phone').value,
      t_email: document.getElementById('t_email').value,
      t_edu: document.getElementById('t_edu').selectedOptions[0].text,
      t_school: document.getElementById('t_school').value,
      t_major: document.getElementById('t_major').value,
      t_salary: document.getElementById('t_salary').value,
      t_selfeval: document.getElementById('t_selfeval').value.slice(0, 6)
    })`);
    const t = JSON.parse(tv);
    check('adjacent fields not misaligned (name/phone/email)', t.t_name === '张三' && t.t_phone === '13800000000' && t.t_email === 'demo.user@example.com', JSON.stringify([t.t_name, t.t_phone, t.t_email]));
    check('group rows do not interfere (education/school/major)', t.t_edu === '硕士' && t.t_school === '示例大学' && t.t_major === 'Computer Science', `${t.t_edu}/${t.t_school}/${t.t_major}`);
    check('unit/noise label recognized (expected salary (yuan/month))', t.t_salary === '30k-40k', t.t_salary);
    check('low-confidence fields go to batch review (no wild filling)', (tableFill.batch || []).length >= 2, `batch=${(tableFill.batch || []).length}`);
    screenshots.push(await shot(cdp, sessionId, '09-table-form.png'));

    // ── Low-confidence batch confirmation panel ──────────────────────────────────
    section('Low-confidence batch confirmation: accept / reassign / ignore memory');
    const batchItems = tableFill.batch || [];
    const acceptItem = batchItems.find((x) => x.label.includes('家庭'));
    const ignoreItem = batchItems.find((x) => x.label.includes('备用'));
    const applyRes = await bridge(cdp, sessionId, 'applyBatch', {
      accepted: [[acceptItem.descriptorId, 'alternatePhone'], [ignoreItem.descriptorId, null]],
    });
    check('batch confirm: accepted item filled successfully (reassigned to alternate phone)', applyRes.results.some((r) => r.ok && r.fieldKey === 'alternatePhone'), JSON.stringify(applyRes.results));
    const afterApply = await evaluate(cdp, sessionId, `document.getElementById('t_homephone').value`);
    check('batch confirm: accepted value written to the page', afterApply === '010-00000000', afterApply);
    check('batch confirm: ignored item recorded in learning memory', applyRes.learnOps.some((o) => o.ignore && o.ignore.label.includes('备用')), JSON.stringify(applyRes.learnOps));
    const refill = await bridge(cdp, sessionId, 'fill');
    check('ignore memory takes effect: no longer suggested on re-scan', !(refill.batch || []).some((x) => x.label.includes('备用')), JSON.stringify((refill.batch || []).map((x) => x.label)));
    screenshots.push(await shot(cdp, sessionId, '10-batch-confirm.png'));

    // ── Beisen-layout real form replica (application form fields and table layout) ──────
    section('Beisen platform: real application-form replica verification (table layout/rowspan/compound fields)');
    await navigate(cdp, sessionId, `${baseUrl}/beisen-form.html`);
    await waitFor(cdp, sessionId, `document.documentElement.dataset.cvReady === '1'`);
    const beiFill = await bridge(cdp, sessionId, 'fill');
    check('Beisen form: field recognition (incl. rowspan label cells)', beiFill.matched >= 8, `matched=${beiFill.matched}`);
    const bv = await evaluate(cdp, sessionId, `JSON.stringify({
      name: document.getElementById('b_name').value,
      gender: document.querySelector('input[name=b_gender]:checked') ? document.querySelector('input[name=b_gender]:checked').parentElement.textContent.trim() : '',
      phone: document.getElementById('b_phone').value,
      email: document.getElementById('b_email').value,
      edu: document.getElementById('b_edu').selectedOptions[0].text,
      addr: document.getElementById('b_addr').value.slice(0, 6),
      resume: document.getElementById('b_resume').value,
      year: document.getElementById('b_year').selectedOptions[0].text,
      month: document.getElementById('b_month').selectedOptions[0].text,
      day: document.getElementById('b_day').selectedOptions[0].text
    })`);
    const b = JSON.parse(bv);
    check('Beisen form: name/gender/phone/email', b.name === '张三' && b.gender === '男' && b.phone === '13800000000' && b.email === 'demo.user@example.com', JSON.stringify(b));
    check('Beisen form: split date controls filled in coordination (year/month/day)', b.year === '1995年' && b.month === '6月' && b.day === '18日', `${b.year}/${b.month}/${b.day}`);
    check('Beisen form: non-standard education options (semantic synonym: master)', b.edu === '硕士及以上', b.edu);
    check('Beisen form: address (with sensitive-hint noise)', b.addr === '北京市海淀区', b.addr);
    check('Beisen form: compound field (school and major) goes to review instead of being filled wildly', (beiFill.batch || []).some((x) => x.label.includes('毕业院校')), JSON.stringify((beiFill.batch || []).map((x) => x.label)));
    check('Beisen form: file-upload field not wrongly filled', b.resume === '', `resume="${b.resume}"`);
    screenshots.push(await shot(cdp, sessionId, '11-beisen-form.png'));

    // ── Custom controls with click-to-open dropdowns (Beisen/element-ui style) ────────
    section('Custom dropdown controls: click to pop up options, then click to pick (not native select)');
    await navigate(cdp, sessionId, `${baseUrl}/dropdown-form.html`);
    await waitFor(cdp, sessionId, `document.documentElement.dataset.cvReady === '1'`);
    const dropFill = await bridge(cdp, sessionId, 'fill');
    check('custom dropdown page recognized (custom-select controls)', dropFill.auto >= 4, `auto=${dropFill.auto}`);
    const dv = await evaluate(cdp, sessionId, `JSON.stringify({
      city: document.getElementById('c_city').value,
      jobtype: document.getElementById('c_jobtype').value,
      arrive: document.getElementById('c_arrive').value,
      position: document.getElementById('c_position').textContent.trim(),
      idtype: document.getElementById('c_idtype').value
    })`);
    const dvv = JSON.parse(dv);
    check('Click dropdown: desired work city (semantic synonym -> desiredCity)', dvv.city === '北京', dvv.city);
    check('Click dropdown: employment type (semantic synonym -> fullTime, option semantics match)', dvv.jobtype === '全职', dvv.jobtype);
    check('Click dropdown: delayed-render dropdown (start date filled)', dvv.arrive === '一个月内', dvv.arrive);
    check('Click dropdown: div-based combobox (desired position filled)', dvv.position === '资深前端架构师', dvv.position);
    check('Click dropdown: unseen field (ID type) is not guessed', dvv.idtype === '', `idtype="${dvv.idtype}"`);
    screenshots.push(await shot(cdp, sessionId, '12-dropdown-form.png'));

    // ── Cascading selects: province -> city -> district (async options + click-to-open last level) ──
    section('Cascading selects: province->city->district (async options + click-to-open last level)');
    await navigate(cdp, sessionId, `${baseUrl}/cascade-form.html`);
    await waitFor(cdp, sessionId, `document.documentElement.dataset.cvReady === '1'`);
    await bridge(cdp, sessionId, 'fill');
    const cv = await evaluate(cdp, sessionId, `JSON.stringify({
      province: document.getElementById('ca_province').value,
      city: document.getElementById('ca_city').value,
      district: document.getElementById('ca_district').value
    })`);
    const cvv = JSON.parse(cv);
    check('Cascade: province/city/district filled coherently across three levels', cvv.province === '北京市' && cvv.city === '北京市' && cvv.district === '海淀区', JSON.stringify(cvv));
    screenshots.push(await shot(cdp, sessionId, '13-cascade-form.png'));

    // ── Shadow DOM encapsulated controls ──────────────────────────────────
    section('Shadow DOM: open shadow roots are fillable, closed ones are not mis-filled');
    await navigate(cdp, sessionId, `${baseUrl}/shadow-form.html`);
    await waitFor(cdp, sessionId, `document.documentElement.dataset.cvReady === '1'`);
    const shadowFill = await bridge(cdp, sessionId, 'fill');
    const sv = await evaluate(cdp, sessionId, `JSON.stringify({
      email: document.getElementById('open-host').shadowRoot.querySelector('#s_email').value,
      city: document.getElementById('open-host').shadowRoot.querySelector('#s_city').value
    })`);
    const svv = JSON.parse(sv);
    check('Open shadow root: input recognized and filled (email)', svv.email === 'demo.user@example.com', svv.email);
    check('Open shadow root: click dropdown filled (desired work city)', svv.city === '北京', svv.city);
    check('Closed shadow root: unreadable so not mis-filled (only 2 visible fields scanned)', shadowFill.scanned === 2 && !(shadowFill.decisions || []).some((d) => String(d.label || '').includes('保密')), `scanned=${shadowFill.scanned}`);
    screenshots.push(await shot(cdp, sessionId, '14-shadow-form.png'));

    // ── iframe multi-frame broadcast fill ─────────────────────────────
    section('iframe multi-frame: one-click broadcast fill (same-origin / cross-origin / srcdoc)');
    await navigate(cdp, sessionId, `${baseUrl}/iframe-host.html`);
    await waitFor(cdp, sessionId, `document.documentElement.dataset.cvReady === '1'`);
    await evaluate(cdp, sessionId, `(() => { document.getElementById('f2').src = ${JSON.stringify(`${baseUrlB}/frame-form.html`)}; return 'ok'; })()`);
    await sleep(1200);
    const fillAll = await bridge(cdp, sessionId, 'fillAll', {}, 30000);
    const frameInfos = fillAll.frames || [];
    check('Broadcast aggregation: all 4 frames executed (main / same-origin / cross-origin / srcdoc)', frameInfos.length >= 4, `frames=${frameInfos.length}`);
    const topName = await evaluate(cdp, sessionId, `document.getElementById('top_name').value`);
    check('Main page field filled', topName === '张三', topName);
    const f1Name = await evaluate(cdp, sessionId, `document.getElementById('f1').contentDocument ? document.getElementById('f1').contentDocument.getElementById('fr_name').value : ''`);
    check('Form inside the same-origin iframe filled', f1Name === '张三', f1Name);
    const cross = frameInfos.find((f) => f.href && baseUrlB && f.href.includes(baseUrlB.replace('http://', '')));
    check('Form inside the cross-origin iframe filled (cross-origin is not restricted)', !!(cross && cross.data && (cross.data.results || []).some((r) => r.fieldKey === 'fullName' && r.ok)), cross ? `auto=${cross.data.auto}` : 'cross-origin frame not found');
    const srcdoc = frameInfos.find((f) => (f.href || '').includes('srcdoc'));
    check('srcdoc iframe injected and filled (match_about_blank)', !!(srcdoc && srcdoc.data && srcdoc.data.auto >= 1), srcdoc ? `auto=${srcdoc.data.auto}` : 'srcdoc frame not found');
    screenshots.push(await shot(cdp, sessionId, '15-iframe-host.png'));

    // ── Survey-style layout (div headings + generic placeholders, wenjuan/jinshuju style) ──
    section('Survey-style layout: div heading recognition (real-site shape regression)');
    await navigate(cdp, sessionId, `${baseUrl}/survey-form.html`);
    await waitFor(cdp, sessionId, `document.documentElement.dataset.cvReady === '1'`);
    const surveyFill = await bridge(cdp, sessionId, 'fill');
    check('Survey-style layout auto-filled', surveyFill.auto >= 5, `auto=${surveyFill.auto}`);
    const qv = await evaluate(cdp, sessionId, `JSON.stringify({
      name: document.querySelectorAll('.field-input input')[0].value,
      phone: document.querySelectorAll('.field-input input')[1].value,
      email: document.querySelectorAll('.field-input input')[2].value,
      edu: document.querySelector('.field-input select').selectedOptions[0].text,
      self: document.querySelector('.field-input textarea').value.slice(0, 6),
      school: document.querySelectorAll('.field-input input')[3].value
    })`);
    const q = JSON.parse(qv);
    check('All div-heading fields are correct (name / phone / email / school)', q.name === '张三' && q.phone === '13800000000' && q.email === 'demo.user@example.com' && q.school === '示例大学', JSON.stringify(q));
    check('Survey-style select/textarea filled (education / self evaluation)', q.edu === '硕士' && q.self === '五年企业级前', `${q.edu}/${q.self}`);
    const radioChecked = await evaluate(cdp, sessionId, `(() => {
      const checked = document.querySelector('.radio-box input:checked');
      return checked ? checked.parentElement.parentElement.textContent.trim() : '';
    })()`);
    check('Name-less custom radio widget filled (employment type)', radioChecked === '全职', radioChecked);
    screenshots.push(await shot(cdp, sessionId, '16-survey-form.png'));

    // ── 5. Resume review (requirement 3) ──────────────────────────────────
    section('5. Resume review: unseen-field generation / similar wording / content optimization (requirement 3)');
    await evaluate(cdp, sessionId, `window.CVOptions ? null : null`);
    await navigate(cdp, sessionId, `chrome-extension://${state.extensionId}/ui/options.html`);
    await waitFor(cdp, sessionId, `!!(window.CVOptions && window.CVOptions.setField)`);
    await evaluate(cdp, sessionId, `window.CVOptions.setField('jobReason', '')`);
    await sleep(300);

    await navigate(cdp, sessionId, `${baseUrl}/prefilled.html`);
    await waitFor(cdp, sessionId, `document.documentElement.dataset.cvReady === '1'`);
    const review = await bridge(cdp, sessionId, 'review', {}, 30000);
    const gen = review.suggestions.find((s) => s.type === 'generate' && s.label.includes('加入'));
    check('Unseen field gets generated content (why do you want to join us)', !!gen && gen.content.length >= 30, gen ? `length ${gen.content.length}` : 'no generate');
    check('Generated content is grounded in the profile (contains experience/skill keywords)', !!gen && /经验|前端|React|数据|技能/.test(gen.content), gen ? gen.content.slice(0, 40) + '…' : '');
    const sim = review.suggestions.find((s) => s.type === 'similar');
    check('Similar-field wording suggestions (personal highlights <-> personal strengths)', !!sim && sim.variants && sim.variants.length >= 2, sim ? sim.label : 'no similar');
    check('Similar-wording suggestions offer several variants', !!sim && sim.variants.every((x) => x.content && x.content.length > 4));
    const trunc = review.suggestions.find((s) => s.rule === 'truncate');
    check('Optimize: overlong content truncation suggestion (self evaluation capped at 60 chars)', !!trunc && trunc.content.length <= 60, trunc ? `truncated to ${trunc.content.length} chars` : 'no truncate');
    const kw = review.suggestions.find((s) => s.rule === 'keywords');
    check('Optimize: JD keyword coverage suggestion', !!kw && kw.content.includes('数据可视化') && !kw.advice.includes('程师'), kw ? kw.advice : 'no keywords');
    check('Review statistics are complete', review.stats && review.stats.suggestions >= 3, JSON.stringify(review.stats));
    screenshots.push(await shot(cdp, sessionId, '04-review-panel.png'));

    // apply a suggestion -> write it back into the page input
    if (gen) {
      await evaluate(cdp, sessionId, `window.postMessage({source:'cv-test', id:'apply-1', action:'applySuggestion', payload:${JSON.stringify({ descriptorId: gen.descriptorId, content: gen.content })}}, '*')`);
      await sleep(500);
      const why = await evaluate(cdp, sessionId, `document.getElementById('why').value.length`);
      check('A suggestion can be applied back into the form in one click', Number(why) >= 30, `why length=${why}`);
      screenshots.push(await shot(cdp, sessionId, '05-suggestion-applied.png'));
    }

    // ── 6. Sample learning (core of requirement 3: scan already-submitted application pages) ──
    section('6. Sample learning: scan filled pages -> learn unseen fields / merge similar fields / accumulate samples (requirement 3)');
    await navigate(cdp, sessionId, `${baseUrl}/sample-filled.html`);
    await waitFor(cdp, sessionId, `document.documentElement.dataset.cvReady === '1'`);
    const study = await bridge(cdp, sessionId, 'study', { apply: true }, 30000);
    check('Filled-in content was scanned', study.filled >= 3, `${study.filled} items already filled`);
    check('Similar-field labels are recognized and merged into one field',
      study.stats.similar >= 1 && study.similarMapped.some((x) => x.fieldKey === 'jobReason'),
      JSON.stringify(study.similarMapped));
    check('Unknown labels are learned as field aliases',
      study.aliasesLearned.some((x) => x.label === '怎么称呼你' && x.fieldKey === 'fullName'),
      JSON.stringify(study.aliasesLearned));
    check('Unseen fields are learned and created as custom fields',
      study.fieldsCreated.some((x) => x.label.includes('技术攻坚')),
      JSON.stringify(study.fieldsCreated.map((x) => x.label)));
    check('Handwritten answers are saved as samples (for later generation)', study.stats.samples >= 3, `${study.stats.samples} samples`);
    check('Profile content improved (job reason: empty -> handwritten sample)',
      study.fieldsUpdated.some((x) => x.fieldKey === 'jobReason' && x.applied),
      JSON.stringify(study.fieldsUpdated));
    const profAfter = await bridge(cdp, sessionId, 'profile');
    check('Learning result stored in the profile (jobReason = handwritten sample)', (profAfter.jobReason || '').includes('数据智能'), (profAfter.jobReason || '').slice(0, 16));
    check('Custom fields stored in the profile', Object.keys(profAfter).some((k) => k.includes('技术攻坚')));
    check('Learning records persisted (learning.aliases)',
      Array.isArray((study.learning.aliases || {}).fullName) && study.learning.aliases.fullName.includes('怎么称呼你'));
    screenshots.push(await shot(cdp, sessionId, '07-study-learned.png'));

    // ── 7. Learning loop: new pages get more accurate with use ────────────────────────────
    section('7. Learning loop: auto-recognition on new application pages + sample reuse');
    await navigate(cdp, sessionId, `${baseUrl}/learned.html`);
    await waitFor(cdp, sessionId, `document.documentElement.dataset.cvReady === '1'`);
    const fillLearned = await bridge(cdp, sessionId, 'fill');
    check('Learned unknown labels are auto-recognized and filled', fillLearned.auto >= 3, `auto=${fillLearned.auto} matched=${fillLearned.matched}`);
    const lv = await evaluate(cdp, sessionId, `JSON.stringify({
      callname: document.getElementById('callname').value,
      joinreason: document.getElementById('joinreason').value,
      proudstory: document.getElementById('proudstory').value
    })`);
    const l = JSON.parse(lv);
    check('The learned alias auto-fills the name (alias learning works)', l.callname === '张三', l.callname);
    check('The learned content is filled into the matching question', l.joinreason.includes('数据智能'), l.joinreason.slice(0, 16));
    check('The custom-field content is filled into the matching question', l.proudstory.includes('大屏可视化'), l.proudstory.slice(0, 16));
    const reviewLearned = await bridge(cdp, sessionId, 'review', {}, 30000);
    const sampleGen = reviewLearned.suggestions.find((s) => s.type === 'generate' && s.fromSample);
    check('A brand-new unseen field reuses a handwritten sample (fromSample)', !!sampleGen && sampleGen.content.includes('数据智能'),
      sampleGen ? sampleGen.content.slice(0, 20) : 'no sample-based generation');
    check('The review report marks the sample source', !!sampleGen && /(样例|sample)/i.test(sampleGen.rationale), sampleGen ? sampleGen.rationale.slice(0, 30) : '');
    screenshots.push(await shot(cdp, sessionId, '08-learned-loop.png'));

    // ── 8. Learn from this page (requirement 1: continuous updates) ────────────────────
    section('8. Learn from this page: write back to the profile for continuous updates (requirement 1)');
    await navigate(cdp, sessionId, `${baseUrl}/cn-form.html`);
    await waitFor(cdp, sessionId, `document.documentElement.dataset.cvReady === '1'`);
    await bridge(cdp, sessionId, 'fill');
    await evaluate(cdp, sessionId, `(() => {
      const el = document.getElementById('wantcity');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(el, '上海');
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return el.value;
    })()`);
    const learn = await bridge(cdp, sessionId, 'learn', { apply: true });
    check('Filled content that disagrees with the profile is detected', learn.candidates.length >= 1, `${learn.candidates.length} candidates`);
    check('Learning result written back to the profile', learn.applied.includes('desiredCity'), JSON.stringify(learn.applied));
    await navigate(cdp, sessionId, `chrome-extension://${state.extensionId}/ui/options.html`);
    await waitFor(cdp, sessionId, `!!(window.CVOptions && window.CVOptions.getField)`);
    const cityNow = await evaluate(cdp, sessionId, `window.CVOptions.getField('desiredCity')`);
    check('Profile updated to the page value', cityNow === '上海', `desiredCity=${cityNow}`);

    // ── 9. Popup panel ─────────────────────────────────────────
    section('9. Popup quick panel');
    await navigate(cdp, sessionId, `chrome-extension://${state.extensionId}/ui/popup.html`);
    await waitFor(cdp, sessionId, `document.getElementById('fieldCount').textContent !== '-'`);
    const popupCount = await evaluate(cdp, sessionId, `document.getElementById('fieldCount').textContent`);
    check('Popup shows the profile field count', /\d+ fields?/.test(popupCount), popupCount);
    const popupProfile = await evaluate(cdp, sessionId, `document.getElementById('profileName').textContent`);
    check('Popup shows the resume set currently in use', String(popupProfile).trim() === 'Default Resume', popupProfile);
    check('Popup offers fill / review / learn entry points', await evaluate(cdp, sessionId, `!!(document.getElementById('btnFill') && document.getElementById('btnReview') && document.getElementById('btnLearn'))`));
    check('Popup offers a one-click backup entry point', await evaluate(cdp, sessionId, `!!document.getElementById('btnBackup')`));
    // the floating-ball switch must survive language switching (regression: applyDom used to delete the checkbox)
    const fabCtl = await evaluate(
      cdp,
      sessionId,
      `JSON.stringify({
        checkbox: !!document.querySelector('#fabToggle'),
        type: (document.querySelector('#fabToggle') || {}).type || '',
        label: (document.querySelector('#fabToggle') && document.querySelector('#fabToggle').closest('label')) ? document.querySelector('#fabToggle').closest('label').textContent.trim() : '',
        rows: document.querySelectorAll('.stat-line').length
      })`
    );
    const fc = JSON.parse(fabCtl);
    check('Popup floating-ball switch is a real checkbox (not replaced by text)', fc.checkbox && fc.type === 'checkbox', fabCtl);
    check('Popup language switch keeps the control label intact', /Floating ball|悬浮球/.test(fc.label), fc.label);
    screenshots.push(await shot(cdp, sessionId, '06-popup.png'));

    // ── 10. Floating widget: ball → 2×2 grid → white panel (design ①), draggable, localized ──
    section('10. Floating widget (ball → function grid → white panel) + drag + language');
    await navigate(cdp, sessionId, `${baseUrl}/cn-form.html`);
    await waitFor(cdp, sessionId, `document.documentElement.dataset.cvReady === '1'`);
    const ballState = await evaluate(
      cdp,
      sessionId,
      `JSON.stringify({
        ball: !!document.getElementById('cv-fab'),
        gridOpen: !!(document.querySelector('#cv-grid') || {}).classList && document.querySelector('#cv-grid').classList.contains('open'),
        panelOpen: document.querySelector('#cv-panel').classList.contains('open'),
        title: document.getElementById('cv-fab').title
      })`
    );
    const bs = JSON.parse(ballState);
    check('widget defaults to the ball only (no grid, no panel)', bs.ball && !bs.gridOpen && !bs.panelOpen, ballState);
    check('i18n: ball tooltip is English by default', /Resume Assistant/.test(bs.title || ''), bs.title);

    // open the function grid
    await evaluate(cdp, sessionId, `document.getElementById('cv-fab').click()`);
    await sleep(250);
    const gridGeo = await evaluate(
      cdp,
      sessionId,
      `(() => {
        const vw = innerWidth, vh = innerHeight;
        const ball = document.getElementById('cv-fab').getBoundingClientRect();
        const chips = [...document.querySelectorAll('#cv-grid [data-act]')];
        const rects = chips.map((c) => ({ label: c.textContent.trim(), r: c.getBoundingClientRect() }));
        const inside = rects.every(({ r }) => r.left >= 0 && r.top >= 0 && r.right <= vw && r.bottom <= vh && r.width > 0);
        let overlaps = 0;
        for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
          const a = rects[i].r, b = rects[j].r;
          if (!(a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom)) overlaps++;
        }
        const ballOverlap = rects.filter(({ r }) => !(r.right <= ball.left || r.left >= ball.right || r.bottom <= ball.top || r.top >= ball.bottom)).length;
        return JSON.stringify({ open: document.getElementById('cv-grid').classList.contains('open'), labels: rects.map((x) => x.label), inside, overlaps, ballOverlap });
      })()`
    );
    const gg = JSON.parse(gridGeo);
    check('clicking the ball reveals the 4 function buttons', gg.open && gg.labels.length === 4, JSON.stringify(gg.labels));
    check('function buttons: no clipping, no overlap, ball clear', gg.inside && gg.overlaps === 0 && gg.ballOverlap === 0, gridGeo);
    screenshots.push(await shot(cdp, sessionId, '18-widget-grid.png'));

    // choose a function → opaque white panel replaces the grid
    await evaluate(cdp, sessionId, `document.querySelector('#cv-grid [data-act="fill"]').click()`);
    // wait for the async fill to finish (the panel renders its items when done)
    await waitFor(cdp, sessionId, `document.querySelectorAll('#cv-panel .cv-item').length > 0`, { timeoutMs: 30000 });
    await sleep(200);
    const panelState = await evaluate(
      cdp,
      sessionId,
      `JSON.stringify({
        panelOpen: document.getElementById('cv-panel').classList.contains('open'),
        gridOpen: document.getElementById('cv-grid').classList.contains('open'),
        bg: getComputedStyle(document.getElementById('cv-panel')).backgroundColor,
        title: document.querySelector('#cv-panel h3').textContent.trim(),
        stat: document.querySelector('#cv-panel .cv-stat').textContent.trim().slice(0, 30),
        items: document.querySelectorAll('#cv-panel .cv-item').length
      })`
    );
    const ps = JSON.parse(panelState);
    check('function button opens the white content panel (grid closes)', ps.panelOpen && !ps.gridOpen && ps.bg === 'rgb(255, 255, 255)', JSON.stringify(ps));
    check('panel shows the function title + content', /One-click fill/i.test(ps.title) && ps.items > 0, `${ps.title} | items=${ps.items}`);
    const enInner = await evaluate(
      cdp,
      sessionId,
      `JSON.stringify({
        tags: [...document.querySelectorAll('#cv-panel .tag')].map((t) => t.textContent.trim()).slice(0, 4),
        batch: (document.querySelector('#cv-panel .cv-item b') || {}).textContent || ''
      })`
    );
    const enI = JSON.parse(enInner);
    check('i18n: English panel content (tags + labels)', enI.tags.includes('Filled') && !/[\u4e00-\u9fff]/.test(enI.tags.join('')), JSON.stringify(enI.tags));
    screenshots.push(await shot(cdp, sessionId, '19-widget-panel.png'));

    // close → back to the ball (tolerant of a late async render)
    await evaluate(cdp, sessionId, `document.querySelector('#cv-panel .cv-close').click()`);
    let closedOk = false;
    try {
      await waitFor(cdp, sessionId, `!document.getElementById('cv-panel').classList.contains('open') && !document.getElementById('cv-grid').classList.contains('open')`, { timeoutMs: 5000 });
      closedOk = true;
    } catch (e) {
      closedOk = false;
    }
    check('close returns to the ball-only state', closedOk === true, String(closedOk));

    // drag the ball → position changes and is persisted
    const drag = await evaluate(
      cdp,
      sessionId,
      `(async () => {
        const root = document.getElementById('cv-root');
        const fab = document.getElementById('cv-fab');
        const before = { right: root.style.right, bottom: root.style.bottom };
        const r = fab.getBoundingClientRect();
        const opts = (x, y) => ({ bubbles: true, clientX: x, clientY: y, pointerId: 1, pointerType: 'mouse', isPrimary: true });
        fab.dispatchEvent(new PointerEvent('pointerdown', opts(r.left + 28, r.top + 28)));
        fab.dispatchEvent(new PointerEvent('pointermove', opts(r.left + 8, r.top - 72)));
        fab.dispatchEvent(new PointerEvent('pointerup', opts(r.left + 8, r.top - 72)));
        await new Promise((res) => setTimeout(res, 400));
        return JSON.stringify({ before, after: { right: root.style.right, bottom: root.style.bottom } });
      })()`
    );
    const dr = JSON.parse(drag);
    check('ball is draggable (position changes)', dr.before.right !== dr.after.right || dr.before.bottom !== dr.after.bottom, drag);
    const fabPersisted = await bridge(cdp, sessionId, 'applySettings', {});
    check('dragged position is persisted in settings', !!(fabPersisted && fabPersisted.fabPos && Number.isFinite(fabPersisted.fabPos.rx)), JSON.stringify(fabPersisted && fabPersisted.fabPos));

    // language: Chinese applies to the whole widget (ball tooltip + buttons + panel title)
    await navigate(cdp, sessionId, `chrome-extension://${state.extensionId}/ui/options.html`);
    await waitFor(cdp, sessionId, `!!(window.CVOptions && window.CVOptions.setLang)`);
    await evaluate(cdp, sessionId, `window.CVOptions.setLang('zh')`);
    await navigate(cdp, sessionId, `${baseUrl}/cn-form.html`);
    await waitFor(cdp, sessionId, `document.documentElement.dataset.cvReady === '1'`);
    await evaluate(cdp, sessionId, `document.getElementById('cv-fab').click()`);
    await sleep(250);
    const zhWidget = await evaluate(
      cdp,
      sessionId,
      `JSON.stringify({
        title: document.getElementById('cv-fab').title,
        labels: [...document.querySelectorAll('#cv-grid [data-act] span')].map((s) => s.textContent.trim())
      })`
    );
    const zw = JSON.parse(zhWidget);
    check('i18n: Chinese applies to the ball tooltip', /简历投递助手/.test(zw.title || ''), zw.title);
    check('i18n: Chinese applies to all 4 function buttons', JSON.stringify(zw.labels) === JSON.stringify(['填充', '体检', '学习', '回写']), JSON.stringify(zw.labels));
    await evaluate(cdp, sessionId, `document.querySelector('#cv-grid [data-act="fill"]').click()`);
    await waitFor(cdp, sessionId, `document.querySelectorAll('#cv-panel .cv-item').length > 0`, { timeoutMs: 30000 });
    await sleep(200);
    const zhPanelTitle = await evaluate(cdp, sessionId, `document.querySelector('#cv-panel h3').textContent.trim()`);
    check('i18n: Chinese applies to the panel title', zhPanelTitle === '一键填充', zhPanelTitle);
    const zhInner = await evaluate(
      cdp,
      sessionId,
      `JSON.stringify({
        tags: [...document.querySelectorAll('#cv-panel .tag')].map((t) => t.textContent.trim()).slice(0, 4),
        stat: document.querySelector('#cv-panel .cv-stat').textContent.trim().slice(0, 26),
        why: [...document.querySelectorAll('#cv-panel .why')].map((w) => w.textContent.trim()).slice(0, 8)
      })`
    );
    const zhI = JSON.parse(zhInner);
    check('i18n: Chinese applies to the panel content (tags + stat line)', zhI.tags.includes('已填充') && /扫描/.test(zhI.stat), zhInner);
    check(
      'i18n: runtime engine messages are localized too',
      zhI.why.length > 0 && !/(option |Date filled|Date component|exceeds |could not be parsed|falls in range|is a synonym|Profile has no value)/.test(zhI.why.join(' ')),
      JSON.stringify(zhI.why).slice(0, 140)
    );
    screenshots.push(await shot(cdp, sessionId, '20-widget-zh.png'));

    // floating-ball switch: off removes the widget from the page immediately
    await navigate(cdp, sessionId, `chrome-extension://${state.extensionId}/ui/options.html`);
    await waitFor(cdp, sessionId, `!!(window.CVOptions && window.CVOptions.setFloatingButton)`);
    await evaluate(cdp, sessionId, `window.CVOptions.setFloatingButton(false)`);
    await navigate(cdp, sessionId, `${baseUrl}/cn-form.html`);
    await waitFor(cdp, sessionId, `document.documentElement.dataset.cvReady === '1'`);
    const offState = await evaluate(cdp, sessionId, `!!document.getElementById('cv-root')`);
    check('floating-ball switch off renders nothing on the page', offState === false, `cv-root=${offState}`);

    // restore defaults for later runs
    await navigate(cdp, sessionId, `chrome-extension://${state.extensionId}/ui/options.html`);
    await waitFor(cdp, sessionId, `!!(window.CVOptions && window.CVOptions.setFloatingButton)`);
    await evaluate(cdp, sessionId, `window.CVOptions.setFloatingButton(true)`);
    await evaluate(cdp, sessionId, `window.CVOptions.setLang('en')`);

    // ── Summary ──────────────────────────────────────────────────
    const passed = results.filter((r) => r.pass).length;
    const report = {
      generatedAt: new Date().toISOString(),
      mode: HEADLESS ? 'headless' : 'headful (real window)',
      chrome: chromePathSafe(),
      extensionId: state.extensionId,
      total: results.length,
      passed,
      failed: results.length - passed,
      screenshots,
      results,
    };
    writeFileSync(join(ARTIFACTS, 'e2e-report.json'), JSON.stringify(report, null, 2));
    console.log(`\n════════════════════════════════════`);
    console.log(`E2E result: ${passed}/${results.length} passed${report.failed ? `, ${report.failed} failed` : ''}`);
    console.log(`Report: test/artifacts/e2e-report.json`);
    console.log(`Screenshots: test/artifacts/*.png`);
    if (report.failed) {
      for (const r of results.filter((x) => !x.pass)) console.log(`  ❌ ${r.name} —— ${r.detail}`);
    }
    return report.failed === 0 ? 0 : 1;
  } finally {
    try {
      cdp && cdp.close();
    } catch {}
    try {
      chromeProc && chromeProc.kill();
    } catch {}
    server.close();
    try {
      serverB.close();
    } catch (e) {
      /* ignore */
    }
    try {
      rmSync(userDataDir, { recursive: true, force: true });
    } catch {}
  }
}

function chromePathSafe() {
  try {
    return process.env.CHROME_PATH || 'Google Chrome (auto-detect)';
  } catch {
    return 'unknown';
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error('E2E run crashed:', err);
    process.exit(1);
  }
);
