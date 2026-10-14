/* CV Plugin — options.js (profile manager page) */
(function () {
  'use strict';
  const CV = globalThis.CVCore;
  const store = CV.store.createStore(CV.store.chromeAdapter());
  // Build marker: lets you verify which copy of the file Chrome actually loaded
  // (unpacked extensions are NOT hot-reloaded — check with: document.documentElement.dataset.cvBuild)
  const BUILD = 'options-i18n-hardened-3';
  // UI display language (declared first so every renderer can rely on it, whatever the init order)
  let UI = CV.i18n.create('en');
  const T = (k, p) => UI.t(k, p);
  // Defensive DOM helpers: a missing element must never throw (it used to: "Cannot set properties of null (setting 'value')")
  const $ = (id) => document.getElementById(id);
  const setVal = (id, v) => {
    const n = $(id);
    if (n) n.value = v;
  };
  const setChk = (id, v) => {
    const n = $(id);
    if (n) n.checked = !!v;
  };
  const getVal = (id) => {
    const n = $(id);
    return n ? String(n.value == null ? '' : n.value) : '';
  };
  const isChk = (id) => {
    const n = $(id);
    return !!(n && n.checked);
  };
  const toastEl = document.getElementById('toast');
  let toastTimer = null;

  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2600);
  }

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else node.setAttribute(k, v);
    }
    for (const c of children || []) node.appendChild(c);
    return node;
  }

  function fieldInput(field) {
    const wrap = el('div', { class: 'field', 'data-key': field.key });
    const label = el('label', {});
    const primary = UI.lang === 'zh' ? field.labelZh : field.labelEn || field.labelZh;
    const secondary = UI.lang === 'zh' ? field.labelEn : field.labelZh;
    label.innerHTML = `${primary}<span class="en"> · ${secondary || ''}</span>${field.sensitive ? '<span class="sensitive">' + UI.t('badge.sensitive') + '</span>' : ''}`;
    wrap.appendChild(label);
    let input;
    if (field.type === 'enum') {
      input = el('select', { 'data-cv-field': field.key });
      input.appendChild(el('option', { value: '', text: '(Not set)' }));
      for (const opt of field.enumOptions || []) {
        input.appendChild(el('option', { value: opt.value, text: `${opt.zh} / ${opt.en}` }));
      }
    } else if (field.type === 'longtext') {
      input = el('textarea', { 'data-cv-field': field.key, rows: '3' });
    } else {
      input = el('input', { type: 'text', 'data-cv-field': field.key });
    }
    wrap.appendChild(input);
    return wrap;
  }

  async function renderProfile() {
    const profile = await store.load();
    const host = document.getElementById('profileEditor');
    host.innerHTML = '';
    for (const cat of CV.schema.categories) {
      const fields = CV.schema.fieldsByCategory(cat.id);
      if (!fields.length) continue;
      const card = el('div', { class: 'card' });
      card.appendChild(el('h2', { class: '', text: UI.lang === 'zh' ? `${cat.zh} · ${cat.en}` : `${cat.en} · ${cat.zh}`, style: 'margin-top:0' }));
      const grid = el('div', { class: 'grid' });
      for (const f of fields) {
        const wrap = fieldInput(f);
        const input = wrap.querySelector('[data-cv-field]');
        const entry = profile.fields[f.key];
        if (input) input.value = entry ? entry.value : '';
        grid.appendChild(wrap);
      }
      card.appendChild(grid);
      host.appendChild(card);
    }
    // Custom field values also go into the editor
    for (const c of profile.customFields) {
      const input = document.querySelector(`[data-cv-field="${CSS.escape(c.key)}"]`);
      if (input) input.value = c.value;
    }
    document.getElementById('fieldBadge').textContent = `${Object.keys(profile.fields).length + profile.customFields.length}`;
  }

  function collectValues() {
    const map = {};
    document.querySelectorAll('[data-cv-field]').forEach((input) => {
      const key = input.getAttribute('data-cv-field');
      const v = String(input.value == null ? '' : input.value).trim();
      if (v) map[key] = v;
    });
    return map;
  }

  async function saveAll() {
    const map = collectValues();
    const changed = await store.updateFields(map);
    // Remove fields that were cleared
    const profile = await store.load();
    for (const key of Object.keys(profile.fields)) {
      const input = document.querySelector(`[data-cv-field="${CSS.escape(key)}"]`);
      if (input && !String(input.value).trim()) await store.removeField(key);
    }
    document.getElementById('fieldBadge').textContent = `${Object.keys(map).length}`;
    toast(T('opt.savedFields', { n: changed.length }));
    return changed;
  }

  async function renderCustomFields() {
    const profile = await store.load();
    const host = document.getElementById('customList');
    host.innerHTML = '';
    if (!profile.customFields.length) {
      host.innerHTML = '<div class="muted">No custom fields yet</div>';
      return;
    }
    const table = el('table', {});
    for (const c of profile.customFields) {
      const tr = el('tr', {});
      tr.appendChild(el('td', { text: c.label }));
      tr.appendChild(el('td', { text: c.category }));
      tr.appendChild(el('td', { text: c.value.length > 60 ? `${c.value.slice(0, 60)}…` : c.value }));
      const td = el('td', {});
      const btn = el('button', { class: 'small danger', text: 'Delete', 'data-remove': c.key });
      td.appendChild(btn);
      tr.appendChild(td);
      table.appendChild(tr);
    }
    host.appendChild(table);
    host.querySelectorAll('[data-remove]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        await store.removeField(btn.getAttribute('data-remove'));
        await renderCustomFields();
        await renderProfile();
        toast(T('opt.customDeleted'));
      });
    });
  }

  async function renderLearning() {
    const learning = await store.getLearning();
    const aliasHost = document.getElementById('learningAliases');
    const sampleHost = document.getElementById('learningSamples');
    aliasHost.innerHTML = '';
    sampleHost.innerHTML = '';
    const entries = Object.entries(learning.aliases || {});
    if (!entries.length) {
      aliasHost.innerHTML = '<div class="muted">None yet. Click "Sample Learning" on a filled application page to start collecting.</div>';
    } else {
      for (const [fieldKey, labels] of entries) {
        const field = CV.schema.getField(fieldKey);
        const wrap = el('div', {});
        wrap.appendChild(el('div', { class: 'muted', text: `${field ? field.labelZh : fieldKey} (${fieldKey})` }));
        for (const label of labels) {
          const chip = el('span', { class: 'chip', text: label });
          wrap.appendChild(chip);
        }
        aliasHost.appendChild(wrap);
      }
    }
    const samples = (learning.samples || []).slice(-20).reverse();
    if (!samples.length) {
      sampleHost.innerHTML = '<div class="muted">No samples yet.</div>';
    } else {
      const table = el('table', {});
      for (const s of samples) {
        const tr = el('tr', {});
        tr.appendChild(el('td', { text: s.label }));
        tr.appendChild(el('td', { text: s.content.length > 50 ? `${s.content.slice(0, 50)}…` : s.content }));
        tr.appendChild(el('td', { text: s.intent }));
        table.appendChild(tr);
      }
      sampleHost.appendChild(table);
    }
  }

  /** Multiple-profile list */
  async function renderProfiles() {
    const { activeId, profiles } = await store.listProfiles();
    const host = document.getElementById('profileList');
    host.innerHTML = '';
    const table = el('table', {});
    for (const p of profiles) {
      const isActive = p.id === activeId;
      const tr = el('tr', { 'data-profile-id': p.id });
      const nameTd = el('td', {});
      nameTd.appendChild(el('b', { text: p.name }));
      if (isActive) nameTd.appendChild(el('span', { class: 'badge', text: 'In use' }));
      tr.appendChild(nameTd);
      tr.appendChild(el('td', { class: 'muted', text: new Date(p.updatedAt || Date.now()).toLocaleString() }));
      const td = el('td', {});
      if (!isActive) {
        const btnUse = el('button', { class: 'small primary', text: 'Use' });
        btnUse.addEventListener('click', async () => {
          await store.activateProfile(p.id);
          await refreshAll();
          toast(T('opt.switchedTo', { name: p.name }));
        });
        td.appendChild(btnUse);
      }
      const btnRename = el('button', { class: 'small', text: 'Rename' });
      btnRename.addEventListener('click', async () => {
        const name = prompt('New profile name:', p.name);
        if (name == null) return;
        await store.renameProfile(p.id, name);
        await refreshAll();
        toast(T('opt.renamed'));
      });
      td.appendChild(btnRename);
      const btnDup = el('button', { class: 'small', text: 'Duplicate' });
      btnDup.addEventListener('click', async () => {
        const cur = await store.listProfiles();
        if (p.id !== cur.activeId) await store.activateProfile(p.id);
        await store.createProfile({ name: `${p.name} Copy`, cloneActive: true });
        await refreshAll();
        toast(T('opt.duplicatedAs'));
      });
      td.appendChild(btnDup);
      const btnExp = el('button', { class: 'small', text: 'Export this profile' });
      btnExp.addEventListener('click', async () => {
        download(`cv-profile-${p.name}.json`, await store.exportProfileJson(p.id, { maskSensitive: false }));
        toast(T('opt.exportedProfile', { name: p.name }));
      });
      td.appendChild(btnExp);
      if (profiles.length > 1) {
        const btnDel = el('button', { class: 'small danger', text: 'Delete' });
        btnDel.addEventListener('click', async () => {
          if (!confirm(`Delete profile "${p.name}"? This cannot be undone.`)) return;
          await store.deleteProfile(p.id);
          await refreshAll();
          toast(T('opt.deleted'));
        });
        td.appendChild(btnDel);
      }
      tr.appendChild(td);
      table.appendChild(tr);
    }
    host.appendChild(table);
  }

  /** Re-render every view that depends on the active profile */
  async function refreshAll() {
    await renderProfile();
    await renderCustomFields();
    await renderLearning();
    await renderProfiles();
    await refreshBackupStatus(); // dynamic status line follows the UI language
    UI.applyDom(document); // static texts of freshly rendered rows (buttons, empty states)
    const p = await store.load();
    const count = Object.keys(p.fields).length + p.customFields.length;
    document.getElementById('fieldBadge').textContent = `${count}`;
  }

  // ── UI display language (frontend-only switch) ────────────────
  function applyUiLang(lang) {
    UI = CV.i18n.create(lang);
    UI.applyDom(document);
    document.documentElement.lang = UI.lang;
  }

  /** Push language / floating-ball settings to the active page so the widget updates immediately. */
  async function pushSettingsToPage() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (tab && tab.id) await chrome.tabs.sendMessage(tab.id, { action: 'applySettings', payload: {} });
    } catch (e) {
      /* page without a content script */
    }
  }

  async function renderSettings() {
    const s = await store.getSettings();
    const langSel = document.getElementById('setLang');
    if (langSel) langSel.value = s.lang || 'en';
    applyUiLang(s.lang);
    setChk('setAutoFill', s.autoFill);
    setChk('setFab', s.showFloatingButton !== false);
    setVal('setSiteMode', s.siteMode || 'all');
    setVal('setAllowed', (s.allowedSites || []).join(', '));
    setVal('setBlocked', (s.blockedSites || []).join(', '));
    setChk('setLlmEnabled', s.llm && s.llm.enabled);
    setChk('setVlmEnabled', s.llm && s.llm.vlmEnabled);
    setChk('setVlmStudy', s.llm && s.llm.vlmStudy);
    setVal('setLlmBase', (s.llm && s.llm.baseUrl) || '');
    setVal('setLlmKey', (s.llm && s.llm.apiKey) || '');
    setVal('setLlmModel', (s.llm && s.llm.model) || '');
  }

  async function saveSettings() {
    const list = (id) => getVal(id).split(/[,，\s]+/).map((x) => x.trim()).filter(Boolean);
    await store.patchSettings({
      autoFill: isChk('setAutoFill'),
      showFloatingButton: isChk('setFab'),
      lang: getVal('setLang') || 'en',
      siteMode: getVal('setSiteMode') || 'all',
      allowedSites: list('setAllowed'),
      blockedSites: list('setBlocked'),
      llm: {
        enabled: isChk('setLlmEnabled'),
        vlmEnabled: isChk('setVlmEnabled'),
        vlmStudy: isChk('setVlmStudy'),
        baseUrl: getVal('setLlmBase').trim(),
        apiKey: getVal('setLlmKey').trim(),
        model: getVal('setLlmModel').trim(),
      },
    });
    toast(T('opt.settingsSaved'));
    await pushSettingsToPage();
  }

  // ── Import / Export ──────────────────────────────────────────
  function download(filename, text) {
    const blob = new Blob([text], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: filename });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  document.getElementById('btnSave').addEventListener('click', saveAll);
  document.getElementById('btnSample').addEventListener('click', async () => {
    await store.save(CV.store.sampleProfile());
    await renderProfile();
    await renderCustomFields();
    toast(T('opt.sampleLoaded'));
  });
  document.getElementById('btnExport').addEventListener('click', async () => {
    download('cv-profile.json', await store.exportJson({ maskSensitive: false }));
    toast(T('opt.exported'));
  });
  document.getElementById('btnExportMasked').addEventListener('click', async () => {
    download('cv-profile-masked.json', await store.exportJson({ maskSensitive: true, schema: CV.schema }));
    toast(T('opt.exportedMasked'));
  });
  document.getElementById('btnImport').addEventListener('click', () => document.getElementById('fileImport').click());
  // ── Import (PDF / image / text / JSON) ─────────────────────
  let pendingImport = null; // { parsed, fileName, source, warnings }

  function renderImportPreview() {
    const host = document.getElementById('importPreview');
    if (!pendingImport) {
      host.innerHTML = '';
      return;
    }
    const { parsed, fileName, source, warnings } = pendingImport;
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const rows = [];
    const changeMap = new Map((pendingImport.modelChanges || []).map((c) => [c.key, c]));
    for (const [key, value] of Object.entries(parsed.values || {})) {
      const field = CV.schema.getField(key);
      const change = changeMap.get(key);
      rows.push(
        `<tr><td><b>${esc(field ? (UI.lang === 'zh' ? field.labelZh : field.labelEn || field.labelZh) : key)}</b><div class="muted">${esc(key)}</div>${change ? '<span class="chip">' + T('opt.modelChange') + '</span>' : ''}</td><td>${esc(String(value).slice(0, 120))}${change ? `<div class="muted">${T('opt.localValue', { v: esc(change.localValue || '(empty)') })}</div>` : ''}</td></tr>`
      );
    }
    for (const c of parsed.customFields || []) {
      rows.push(`<tr><td><b>${esc(c.label)}</b><div class="muted">Custom field (new)</div></td><td>${esc(String(c.value).slice(0, 120))}</td></tr>`);
    }
    host.innerHTML = `
      <div class="card" style="margin-top:12px">
        <h3 style="margin-top:0">${T('opt.previewTitle', { file: esc(fileName), source: source === 'pdf' ? T('opt.previewPdf') : source === 'image' ? T('opt.previewImage') : T('opt.previewText') })}</h3>
        <div class="muted">${T('opt.detected', { f: Object.keys(parsed.values || {}).length, c: (parsed.customFields || []).length })}
        ${(warnings && warnings.length) ? T('opt.previewNote', { w: esc(warnings.join('; ')) }) : ''}</div>
        <table>${rows.join('')}</table>
        <div class="toolbar">
          <button class="primary" id="btnApplyImport">${T('opt.applyImportHint')}</button>
          <button id="btnCancelImport">${T('opt.cancelImport')}</button>
        </div>
      </div>`;
    document.getElementById('btnApplyImport').addEventListener('click', applyImport);
    document.getElementById('btnCancelImport').addEventListener('click', () => {
      pendingImport = null;
      renderImportPreview();
    });
  }

  /** Parse an imported file: JSON imports directly; PDF/text uses local extraction; images go through VLM (must be enabled). */
  async function parseImportFile(file) {
    const name = String(file.name || '').toLowerCase();
    const settings = await store.getSettings();
    const llm = CV.llm.clientFromSettings(settings);
    const useVlm = settings.llm.enabled && settings.llm.vlmEnabled;
    if (name.endsWith('.pdf')) {
      const buf = await file.arrayBuffer();
      const extracted = await CV.pdf.extractPdfText(buf);
      let parsed = CV.resumeParse.parseResumeText(extracted.text);
      let modelChanges = [];
      if (useVlm && llm && llm.enabled) {
        try {
          const corrected = await llm.reviewResumeParse({ text: extracted.text, parsed }, { timeoutMs: 30000 });
          if (corrected && corrected.values) {
            // Anti-hallucination layer 3: per-field diff annotation of model corrections (no silent overwrite)
            for (const [k, v] of Object.entries(corrected.values)) {
              const local = (parsed.values || {})[k];
              if (String(local || '') !== String(v || '')) {
                modelChanges.push({ key: k, localValue: String(local || ''), modelValue: String(v || '') });
              }
            }
            parsed = { values: corrected.values, customFields: corrected.customFields || [], sections: parsed.sections, warnings: parsed.warnings };
          }
        } catch (e) {
          toast(T('opt.vlmCheckFailed'));
        }
      }
      return { parsed, source: 'pdf', warnings: extracted.warnings, modelChanges };
    }
    if (name.endsWith('.txt')) {
      const text = await file.text();
      return { parsed: CV.resumeParse.parseResumeText(text), source: 'text', warnings: [] };
    }
    // Image resume (scanned copy): VLM must be enabled
    if (!useVlm || !llm || !llm.enabled) throw new Error('Enable LLM + VLM multimodal in Settings first to recognize image resumes');
    const dataUrl = await new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = () => reject(new Error('Failed to read image'));
      r.readAsDataURL(file);
    });
    const keys = CV.schema.allFields().map((f) => f.key).join(',');
    const parsed = await llm.parseResumeImage({ image: dataUrl, hint: { keys } }, { timeoutMs: 60000 });
    return { parsed: { values: parsed.values || {}, customFields: parsed.customFields || [] }, source: 'image', warnings: [] };
  }

  async function applyImport() {
    if (!pendingImport) return;
    const mode = document.getElementById('importMode').value;
    const profile = CV.resumeParse.parsedToProfile(pendingImport.parsed);
    const json = JSON.stringify(profile);
    const fileName = pendingImport.fileName.replace(/\.(pdf|png|jpe?g|txt|json)$/i, '');
    if (mode === 'new') {
      const entry = await store.importJson(json, { mode: 'new', name: fileName || 'Imported Resume' });
      toast(T('opt.importedNew', { name: entry.name }));
    } else {
      await store.importJson(json, { merge: true });
      toast(T('opt.importedMerged'));
    }
    pendingImport = null;
    renderImportPreview();
    await refreshAll();
  }

  document.getElementById('fileImport').addEventListener('change', async (ev) => {
    const file = ev.target.files && ev.target.files[0];
    if (!file) return;
    try {
      const name = String(file.name || '').toLowerCase();
      if (name.endsWith('.json')) {
        const text = await file.text();
        const mode = document.getElementById('importMode').value;
        if (mode === 'new') {
          const entry = await store.importJson(text, { mode: 'new', name: file.name.replace(/\.json$/i, '') });
          await refreshAll();
          toast(T('opt.importedNew', { name: entry.name }));
        } else {
          await store.importJson(text, { merge: true });
          await refreshAll();
          toast(T('opt.importedMerged'));
        }
      } else {
        if (file.size > 20 * 1024 * 1024) throw new Error('File exceeds the 20MB limit; split it or use a text/JSON version');
        toast(T('opt.importReading'));
        const result = await parseImportFile(file);
        pendingImport = { ...result, fileName: file.name };
        renderImportPreview();
        toast(T('opt.importDone'));
      }
    } catch (e) {
      toast(T('opt.importFailed', { err: e.message || e }));
    }
    ev.target.value = '';
  });
  document.getElementById('btnAddCustom').addEventListener('click', async () => {
    const label = getVal('customLabel').trim();
    const value = getVal('customValue').trim();
    const category = getVal('customCategory');
    if (!label) return toast(T('opt.enterFieldName'));
    await store.addCustomField({ key: `custom:${label}`, label, category, value });
    setVal('customLabel', '');
    setVal('customValue', '');
    await renderCustomFields();
    toast(T('opt.customAdded'));
  });
  document.getElementById('btnSaveSettings').addEventListener('click', saveSettings);  document.getElementById('btnClearLearning').addEventListener('click', async () => {
    await store.clearLearning();
    await renderLearning();
    toast(T('opt.learningCleared'));
  });
  document.getElementById('btnNewProfile').addEventListener('click', async () => {
    const name = prompt('New profile name (e.g. Company A):', `Resume ${Date.now() % 1000}`);
    if (name == null) return;
    const entry = await store.createProfile({ name: name || undefined, cloneActive: false });
    await refreshAll();
    toast(T('opt.createdBlank', { name: entry.name }));
  });
  document.getElementById('btnCloneProfile').addEventListener('click', async () => {
    const cur = await store.listProfiles();
    const active = cur.profiles.find((p) => p.id === cur.activeId);
    const name = prompt('Copy name:', `${active ? active.name : 'Resume'} Copy`);
    if (name == null) return;
    const entry = await store.createProfile({ name: name || undefined, cloneActive: true });
    await refreshAll();
    toast(T('opt.copiedTo', { name: entry.name }));
  });

  // ── Data safety & backup ─────────────────────────────────
  const backupMgr = CV.backup.createBackupManager();

  async function refreshBackupStatus() {
    const el2 = document.getElementById('backupStatus');
    try {
      const handle = await backupMgr.getDirHandle();
      if (handle) {
        el2.textContent = T('opt.backupStatusOn', { dir: handle.name }) + (backupMgr.lastBackupAt ? T('opt.backupStatusLast', { t: new Date(backupMgr.lastBackupAt).toLocaleString() }) : '');
      } else {
        el2.textContent = T('opt.backupStatusOff');
      }
    } catch (e) {
      el2.textContent = T('opt.backupStatusError', { err: e.message || e });
    }
  }

  async function runBackup(silent) {
    const json = await store.exportAllJson();
    const res = await backupMgr.backup(json);
    if (!silent) toast(T('opt.backedUp', { n: res.files.length }));
    return res;
  }

  document.getElementById('btnAutoBackup').addEventListener('click', async () => {
    try {
      await backupMgr.enable();
      await runBackup(true);
      await refreshBackupStatus();
      toast(T('opt.backupEnabled'));
    } catch (e) {
      toast(T('opt.backupEnableFailed', { err: e.message || e }));
    }
  });
  document.getElementById('btnBackupNow').addEventListener('click', async () => {
    try {
      await runBackup(false);
      await refreshBackupStatus();
    } catch (e) {
      toast(T('opt.backupFailed', { err: e.message || e }));
    }
  });
  document.getElementById('btnAutoBackupOff').addEventListener('click', async () => {
    await backupMgr.disable();
    await refreshBackupStatus();
    toast(T('opt.backupDisabled'));
  });
  document.getElementById('btnExportAll').addEventListener('click', async () => {
    download('cv-plugin-full-backup.json', await store.exportAllJson());
    toast(T('opt.exportedAll'));
  });
  document.getElementById('btnRestoreAll').addEventListener('click', () => document.getElementById('fileRestore').click());
  document.getElementById('fileRestore').addEventListener('change', async (ev) => {
    const file = ev.target.files && ev.target.files[0];
    if (!file) return;
    try {
      const res = await store.importAllJson(await file.text());
      await refreshAll();
      toast(T('opt.restored', { n: res.profiles }));
    } catch (e) {
      toast(T('opt.restoreFailed', { err: e.message || e }));
    }
    ev.target.value = '';
  });

  // Whenever any context (content-script sample learning / write-back, etc.) writes to storage,
  // automatically append a backup (5s debounce)
  let backupTimer = null;
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (!Object.keys(changes).some((k) => k.startsWith('cvProfile'))) return;
      clearTimeout(backupTimer);
      backupTimer = setTimeout(() => {
        runBackup(true).catch(() => {});
      }, 5000);
    });
  }

  // Category dropdown
  const catSelect = document.getElementById('customCategory');
  for (const c of CV.schema.categories) {
    const opt = document.createElement('option');
    opt.value = c.id;
    opt.textContent = UI.lang === 'zh' ? c.zh : c.en || c.zh;
    catSelect.appendChild(opt);
  }

  // Auto-save: write 800ms after an edit
  let autoSaveTimer = null;
  document.addEventListener('input', (ev) => {
    if (ev.target && ev.target.hasAttribute && ev.target.hasAttribute('data-cv-field')) {
      clearTimeout(autoSaveTimer);
      autoSaveTimer = setTimeout(() => saveAll().catch(() => {}), 800);
    }
  });

  // test / automation hooks
  window.CVOptions = {
    saveAll,
    build: BUILD,
    /** Switch the UI display language immediately ('en' | 'zh' | 'auto') */
    async setLang(lang) {
      await store.patchSettings({ lang });
      const sel = document.getElementById('setLang');
      if (sel) sel.value = lang;
      applyUiLang(lang);
      await refreshAll(); // re-render dynamic parts (field labels, headings, status line) in the new language
      await pushSettingsToPage();
      return lang;
    },
    /** Toggle the floating ball / assistant button on pages */
    async setFloatingButton(enabled) {
      await store.patchSettings({ showFloatingButton: !!enabled });
      const box = document.getElementById('setFab');
      if (box) box.checked = !!enabled;
      await pushSettingsToPage();
      return !!enabled;
    },
    getLearning: () => store.getLearning(),
    /** Multi-set API (automation/tests; UI buttons use DOM events instead) */
    profiles: {
      list: () => store.listProfiles(),
      async create({ name, clone } = {}) {
        const entry = await store.createProfile({ name, cloneActive: !!clone });
        await refreshAll();
        return entry;
      },
      async activate(id) {
        const entry = await store.activateProfile(id);
        await refreshAll();
        return entry;
      },
      async rename(id, name) {
        const entry = await store.renameProfile(id, name);
        await refreshAll();
        return entry;
      },
      async remove(id) {
        const ok = await store.deleteProfile(id);
        await refreshAll();
        return ok;
      },
    },
    async setField(key, value) {
      const input = document.querySelector(`[data-cv-field="${CSS.escape(key)}"]`);
      if (!input) throw new Error(`Field not found: ${key}`);
      input.value = value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await saveAll();
      return true;
    },
    getImportPreview: () =>
      pendingImport
        ? { fileName: pendingImport.fileName, source: pendingImport.source, values: pendingImport.parsed.values, customFields: pendingImport.parsed.customFields }
        : null,
    applyImport,
    exportAllJson: () => store.exportAllJson(),
    restoreAll: async (json) => {
      const res = await store.importAllJson(json);
      await refreshAll();
      return res;
    },
    cancelImport: () => {
      pendingImport = null;
      renderImportPreview();
    },
    async getField(key) {
      const input = document.querySelector(`[data-cv-field="${CSS.escape(key)}"]`);
      return input ? input.value : undefined;
    },
    collectValues,
  };

  (async function init() {
    document.documentElement.dataset.cvBuild = BUILD;
    await renderProfile();
    await renderCustomFields();
    await renderLearning();
    await renderProfiles();
    await renderSettings();
    await refreshBackupStatus();
  })();
})();
