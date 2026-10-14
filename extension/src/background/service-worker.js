/* CV Plugin — service-worker.js (MV3 background)
 * Responsibilities: initialize default settings / sample profile on install; open the options page (profile management) when the extension icon is clicked.
 */
import '../core/util.js';
import '../core/schema.js';
import '../core/lexicon.js';
import '../core/store.js';
import '../core/matcher.js';
import '../core/fill.js';
import '../core/optimizer.js';
import '../core/llm.js';

const CV = globalThis.CVCore;

chrome.runtime.onInstalled.addListener(async (details) => {
  const adapter = CV.store.chromeAdapter();
  const store = CV.store.createStore(adapter);
  const existing = await adapter.get(CV.store.PROFILE_KEY);
  if (!existing) {
    // Write a sample profile on first install for an instant trial; the user may overwrite it entirely.
    await store.save(CV.store.sampleProfile());
  }
  const settings = await adapter.get(CV.store.SETTINGS_KEY);
  if (!settings) await store.patchSettings({});
});

chrome.action.onClicked.addListener(() => {
  chrome.runtime.openOptionsPage();
});

// VLM page verification: the content script requests a screenshot of the currently visible tab (JPEG dataURL)
// Cross-frame fill broadcast: aggregate each frame's result, then respond to the initiator as a whole (iframe wrap-up)
const broadcastAgg = new Map(); // reqId → {results:[], respond, silence, hard}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.action === 'captureTab') {
    try {
      chrome.tabs.captureVisibleTab(sender.tab ? sender.tab.windowId : undefined, { format: 'jpeg', quality: 60 }, (dataUrl) => {
        sendResponse({ dataUrl: dataUrl || null });
      });
    } catch (e) {
      sendResponse({ dataUrl: null, error: String((e && e.message) || e) });
    }
    return true; // async response
  }

  if (msg && msg.action === 'broadcast') {
    const tabId = msg.tabId || (sender.tab && sender.tab.id);
    if (!tabId) {
      sendResponse({ ok: false, error: 'No target tab' });
      return false;
    }
    const reqId = `r${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
    const finish = () => {
      if (!broadcastAgg.has(reqId)) return;
      const e = broadcastAgg.get(reqId);
      broadcastAgg.delete(reqId);
      clearTimeout(e.silence);
      clearTimeout(e.hard);
      try {
        e.respond({ ok: true, frames: e.results });
      } catch (err) {
        /* initiator has already left */
      }
    };
    const entry = { results: [], respond: sendResponse, silence: null, hard: setTimeout(finish, 3000) };
    broadcastAgg.set(reqId, entry);
    // Broadcast to every frame of the tab (including cross-origin iframes; the content script runs per frame under all_frames)
    chrome.tabs.sendMessage(tabId, { action: 'frameExec', reqId, execAction: msg.execAction, payload: msg.payload || {} }, () => {
      void chrome.runtime.lastError; // ignore errors from frames without a script
    });
    return true; // async reply (after aggregation)
  }

  if (msg && msg.action === 'frameResult') {
    const e = broadcastAgg.get(msg.reqId);
    if (e) {
      e.results.push(msg);
      clearTimeout(e.silence);
      // Silence window: close 400ms after the last result
      e.silence = setTimeout(finish_of(e, msg.reqId), 400);
    }
    sendResponse({ ok: true });
    return false;
  }

  function finish_of(entry, reqId) {
    return () => {
      if (!broadcastAgg.has(reqId)) return;
      const en = broadcastAgg.get(reqId);
      broadcastAgg.delete(reqId);
      clearTimeout(en.hard);
      try {
        en.respond({ ok: true, frames: en.results });
      } catch (err) {
        /* ignore */
      }
    };
  }
});
