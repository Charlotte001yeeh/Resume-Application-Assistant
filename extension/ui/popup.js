/* CV Plugin — popup.js */
(function () {
  'use strict';
  const CV = globalThis.CVCore;
  const store = CV.store.createStore(CV.store.chromeAdapter());
  const result = document.getElementById('result');
  let T = (k) => k; // i18n translator (refreshed in refresh())

  function toast(msg) {
    result.textContent = msg;
  }

  async function activeTab() {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return tabs && tabs[0] ? tabs[0] : null;
  }

  async function sendToPage(action, payload) {
    const tab = await activeTab();
    if (!tab) return { ok: false, error: T('popup.noTab') };
    try {
      return await chrome.tabs.sendMessage(tab.id, { action, payload });
    } catch (e) {
      return { ok: false, error: T('popup.unsupported') };
    }
  }

  /** Broadcast execution across frames (fills forms inside iframes too); returns the SW-aggregated result */
  async function broadcastToFrames(execAction, payload) {
    const tab = await activeTab();
    if (!tab) return { ok: false, error: 'No active tab found' };
    try {
      return await chrome.runtime.sendMessage({ action: 'broadcast', tabId: tab.id, execAction, payload: payload || {} });
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  /** Push language / floating-ball settings to the active page so the widget updates immediately. */
  async function pushSettingsToPage() {
    const tab = await activeTab();
    if (!tab) return;
    try {
      await chrome.tabs.sendMessage(tab.id, { action: 'applySettings', payload: {} });
    } catch (e) {
      /* page without a content script */
    }
  }

  async function refresh() {    const [values, settings, tab, profs] = await Promise.all([
      store.flatValues(),
      store.getSettings(),
      activeTab(),
      store.listProfiles().catch(() => null),
    ]);
    if (profs) {
      const active = profs.profiles.find((p) => p.id === profs.activeId);
      document.getElementById('profileName').textContent = active ? active.name : '-';
    }
    const I = CV.i18n.create(settings.lang);
    T = I.t;
    I.applyDom(document);
    const langSel = document.getElementById('langSelect');
    if (langSel) langSel.value = settings.lang === 'zh' ? 'zh' : 'en';
    document.getElementById('fieldCount').textContent = T('popup.fieldCount', { n: Object.keys(values).length });
    document.getElementById('autoFillState').textContent = settings.autoFill ? T('popup.autoFillOn') : T('popup.autoFillOff');
    const fabToggle = document.getElementById('fabToggle');
    if (fabToggle) fabToggle.checked = settings.showFloatingButton !== false;
    document.getElementById('siteInfo').textContent = T('popup.siteInfo', { title: tab && tab.title ? tab.title.slice(0, 28) : '-' });
    const state = await sendToPage('state');
    if (state && state.ok && state.data) {
      toast(T('popup.ready', { v: state.data.version }));
    }
  }

  document.getElementById('btnFill').addEventListener('click', async () => {
    toast(T('popup.fillStart'));
    const agg = await broadcastToFrames('fill', {});
    if (!agg || !agg.ok || !Array.isArray(agg.frames) || !agg.frames.length) {
      const res = await sendToPage('fill'); // fallback to the single frame
      if (!res.ok) return toast(res.error || T('popup.fillFailed'));
      const d = res.data;
      return toast(T('popup.fillDone', { scanned: d.scanned, auto: d.auto, review: d.needReview }));
    }
    const frames = agg.frames.filter((f) => f && f.data);
    const totals = frames.reduce(
      (acc, f) => {
        acc.scanned += f.data.scanned || 0;
        acc.auto += f.data.auto || 0;
        acc.review += f.data.needReview || 0;
        return acc;
      },
      { scanned: 0, auto: 0, review: 0 }
    );
    toast(T('popup.fillDoneMulti', { frames: frames.length, scanned: totals.scanned, auto: totals.auto, review: totals.review }));
  });

  document.getElementById('btnReview').addEventListener('click', async () => {
    toast(T('popup.reviewStart'));
    const res = await sendToPage('review');
    if (!res.ok) return toast(res.error || T('popup.reviewFailed'));
    const s = res.data.stats;
    toast(T('popup.reviewDone', { gen: s.generated, sim: s.similar, opt: s.optimized }));
  });

  document.getElementById('btnStudy').addEventListener('click', async () => {
    toast(T('popup.studyStart'));
    const res = await sendToPage('study', { apply: true });
    if (!res.ok) return toast(res.error || T('popup.learnFailed'));
    const s = res.data.stats;
    toast(T('popup.studyDone', { similar: s.similar, created: s.created, updated: s.updated, aliases: s.aliases, samples: s.samples }));
  });

  document.getElementById('btnLearn').addEventListener('click', async () => {
    toast(T('popup.learnStart'));
    const res = await sendToPage('learn', { apply: true });
    if (!res.ok) return toast(res.error || T('popup.learnFailed'));
    toast(T('popup.learnDone', { n: res.data.applied.length }));
  });

  document.getElementById('btnBackup').addEventListener('click', async () => {
    toast(T('popup.backupStart'));
    try {
      const mgr = CV.backup.createBackupManager();
      const handle = await mgr.getDirHandle();
      if (!handle) {
        toast(T('popup.backupOff'));
        return;
      }
      const res = await mgr.backup(await store.exportAllJson());
      toast(T('popup.backupDone', { n: res.files.length, dir: handle.name }));
    } catch (e) {
      toast(T('popup.backupFailed', { err: e.message || e }));
    }
  });

  document.getElementById('btnOptions').addEventListener('click', () => chrome.runtime.openOptionsPage());

  document.getElementById('langSelect').addEventListener('change', async (e) => {
    await store.patchSettings({ lang: e.target.value });
    await pushSettingsToPage();
    await refresh();
  });

  document.getElementById('fabToggle').addEventListener('change', async (e) => {
    await store.patchSettings({ showFloatingButton: e.target.checked });
    await pushSettingsToPage();
    await refresh();
  });

  refresh();
})();
