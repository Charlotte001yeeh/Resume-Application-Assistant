/* CV Plugin core — backup.js
 * Local folder backup (File System Access API): the directory handle persists in IndexedDB across sessions;
 * the full backup JSON is written automatically/manually to a user-chosen folder (timestamped copies + rotation).
 * A second copy outside browser storage: it survives extension uninstall / profile wipes.
 * Exposed as globalThis.CVCore.backup.
 */
(function (root) {
  'use strict';
  const core = (root.CVCore = root.CVCore || {});

  const DB_NAME = 'cv-plugin-backup';
  const STORE = 'handles';
  const KEY = 'backup-dir';
  const KEEP_COPIES = 10;

  function openDb(idb) {
    return new Promise((resolve, reject) => {
      const req = idb.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('IndexedDB open failed'));
    });
  }

  async function idbPut(value, idb) {
    const db = await openDb(idb);
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(value, KEY);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error || new Error('IndexedDB write failed'));
    });
  }

  async function idbGet(idb) {
    const db = await openDb(idb);
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(KEY);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error || new Error('IndexedDB read failed'));
    });
  }

  async function idbClear(idb) {
    const db = await openDb(idb);
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(KEY);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error || new Error('IndexedDB cleanup failed'));
    });
  }

  /** Check / request read-write permission on the directory. */
  async function ensurePermission(handle, { request = false } = {}) {
    if (!handle) return false;
    const opts = { mode: 'readwrite' };
    try {
      if ((await handle.queryPermission(opts)) === 'granted') return true;
      if (request && (await handle.requestPermission(opts)) === 'granted') return true;
    } catch (e) {
      /* permission API unavailable */
    }
    return false;
  }

  /** Write the full backup JSON to the folder: latest + timestamped copies (keep the newest KEEP_COPIES). */
  async function writeBackup(dirHandle, json) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const written = [];
    for (const name of ['cv-plugin-full-backup.json', `cv-plugin-backup-${stamp}.json`]) {
      const fh = await dirHandle.getFileHandle(name, { create: true });
      const w = await fh.createWritable();
      await w.write(String(json));
      await w.close();
      written.push(name);
    }
    try {
      const stamps = [];
      for await (const entry of dirHandle.values()) {
        if (entry && entry.kind === 'file' && /^cv-plugin-backup-\d{4}-/.test(entry.name)) stamps.push(entry.name);
      }
      stamps.sort();
      for (const old of stamps.slice(0, Math.max(0, stamps.length - KEEP_COPIES))) {
        await dirHandle.removeEntry(old);
      }
    } catch (e) {
      /* rotation failure must not break the backup */
    }
    return written;
  }

  /**
   * Backup manager.
   * @param {{idb?:IDBFactory, showDirectoryPicker?:Function}} env
   */
  function createBackupManager(env = {}) {
    const idb = env.idb || (typeof indexedDB !== 'undefined' ? indexedDB : null);
    const picker = env.showDirectoryPicker || (typeof showDirectoryPicker === 'function' ? showDirectoryPicker : null);
    let lastAt = null;

    return {
      /** Call from a user gesture: pick & authorize the backup folder (handle persists; no re-picking needed). */
      async enable() {
        if (!picker) throw new Error('Folder backup is not supported in this browser (requires Chrome/Edge 110+)');
        const handle = await picker({ mode: 'readwrite' });
        const ok = await ensurePermission(handle, { request: true });
        if (!ok) throw new Error('Folder read/write permission not granted');
        await idbPut(handle, idb);
        return handle;
      },
      async disable() {
        await idbClear(idb);
        return true;
      },
      async getDirHandle({ request = false } = {}) {
        const handle = await idbGet(idb);
        if (!handle) return null;
        return (await ensurePermission(handle, { request })) ? handle : null;
      },
      async isEnabled() {
        return !!(await this.getDirHandle());
      },
      /** Back up one full JSON now. Returns the written file names. */
      async backup(json) {
        const handle = await this.getDirHandle({ request: false });
        if (!handle) throw new Error('Folder backup is not enabled');
        const files = await writeBackup(handle, json);
        lastAt = new Date().toISOString();
        return { files, at: lastAt };
      },
      get lastBackupAt() {
        return lastAt;
      },
    };
  }

  core.backup = { createBackupManager, writeBackup, ensurePermission, idbPut, idbGet, idbClear };
})(typeof globalThis !== 'undefined' ? globalThis : this);
