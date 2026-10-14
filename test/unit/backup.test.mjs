/* Unit tests: full backup/restore + local folder auto-backup (fake IndexedDB / directory handle) */
import test from 'node:test';
import assert from 'node:assert/strict';
import '../../extension/src/core/schema.js';
import '../../extension/src/core/store.js';
import '../../extension/src/core/backup.js';

const CV = globalThis.CVCore;
const { store, backup } = CV;

/** In-memory approximation of FileSystemDirectoryHandle */
function fakeDir() {
  const files = new Map();
  return {
    name: '备份文件夹',
    files,
    async queryPermission() {
      return 'granted';
    },
    async requestPermission() {
      return 'granted';
    },
    async getFileHandle(name, { create } = {}) {
      if (!files.has(name)) {
        if (!create) throw new Error('not found');
        files.set(name, { name, content: '' });
      }
      const f = files.get(name);
      return {
        name,
        async createWritable() {
          return {
            async write(x) {
              f.content = String(x);
            },
            async close() {},
          };
        },
      };
    },
    values() {
      return [...files.keys()].map((name) => ({ kind: 'file', name }))[Symbol.iterator]();
    },
    async removeEntry(name) {
      files.delete(name);
    },
  };
}

/** In-memory approximation of IndexedFactory (covers only the paths backup.js uses) */
function fakeIdb() {
  const map = new Map();
  return {
    map,
    open() {
      const req = {};
      queueMicrotask(() => {
        req.result = {
          objectStoreNames: { contains: () => true },
          transaction: () => {
            const tx = {
              objectStore: () => ({
                put: (v, k) => map.set(k, v),
                get: (k) => {
                  const r = {};
                  Object.defineProperty(r, 'result', { get: () => map.get(k) });
                  queueMicrotask(() => r.onsuccess && r.onsuccess());
                  return r;
                },
                delete: (k) => map.delete(k),
              }),
            };
            queueMicrotask(() => tx.oncomplete && tx.oncomplete());
            return tx;
          },
        };
        req.onsuccess && req.onsuccess();
      });
      return req;
    },
  };
}

test('full backup/restore: multiple resume sets + learning records + settings full round trip', async () => {
  const a = store.createStore(store.memoryAdapter());
  await a.updateFields({ fullName: '张三' });
  await a.addLearnedAlias('fullName', '怎么称呼你');
  await a.addSample({ label: '为什么想加入', intent: 'reason', content: '样例内容' });
  await a.createProfile({ name: 'B公司', cloneActive: false });
  await a.updateFields({ fullName: '李四' });
  await a.patchSettings({ autoFill: false });
  const backupJson = await a.exportAllJson();

  // Disaster recovery: a brand-new empty store
  const b = store.createStore(store.memoryAdapter());
  const res = await b.importAllJson(backupJson);
  assert.equal(res.profiles, 2);
  const list = await b.listProfiles();
  assert.equal(list.profiles.length, 2);
  const p1 = list.profiles.find((p) => p.name === 'B公司');
  await b.activateProfile(p1.id);
  assert.equal(await b.getField('fullName'), '李四');
  const other = list.profiles.find((p) => p.name === 'Default Resume');
  await b.activateProfile(other.id);
  assert.equal(await b.getField('fullName'), '张三');
  const learning = await b.getLearning();
  assert.deepEqual(learning.aliases.fullName, ['怎么称呼你']);
  assert.equal(learning.samples.length, 1);
  assert.equal((await b.getSettings()).autoFill, false);
});

test('full backup/restore: invalid file rejected (no corrupt data written)', async () => {
  const s = store.createStore(store.memoryAdapter());
  await s.updateFields({ fullName: '张三' });
  await assert.rejects(() => s.importAllJson('{"foo":1}'), /Not a valid/);
  await assert.rejects(() => s.importAllJson('bad json'), /invalid JSON/);
  assert.equal(await s.getField('fullName'), '张三', 'a failed restore does not damage existing data');
});

test('folder backup: latest + timestamped copies, old copies rotated', async () => {
  const dir = fakeDir();
  const written1 = await backup.writeBackup(dir, '{"v":1}');
  assert.deepEqual(written1, ['cv-plugin-full-backup.json', dir.files.size === 2 ? [...dir.files.keys()].find((n) => n.startsWith('cv-plugin-backup-')) : '']);
  assert.equal(JSON.parse(dir.files.get('cv-plugin-full-backup.json').content).v, 1);
  for (let i = 0; i < 12; i++) {
    await new Promise((r) => setTimeout(r, 5));
    await backup.writeBackup(dir, `{"v":${i + 2}}`);
  }
  const stamps = [...dir.files.keys()].filter((n) => /^cv-plugin-backup-\d{4}-/.test(n));
  assert.ok(stamps.length <= 10, `timestamped copies should rotate (got ${stamps.length})`);
  assert.ok(dir.files.has('cv-plugin-full-backup.json'));
});

test('backup manager: enable/persist/backup/disable', async () => {
  const dir = fakeDir();
  const idb = fakeIdb();
  const mgr = backup.createBackupManager({ idb, showDirectoryPicker: async () => dir });
  assert.equal(await mgr.isEnabled(), false);
  await mgr.enable();
  assert.equal(await mgr.isEnabled(), true, 'the handle should be persisted (recoverable across sessions)');

  // A new manager instance (simulating after a restart) can still read the handle and back up
  const mgr2 = backup.createBackupManager({ idb, showDirectoryPicker: async () => dir });
  const res = await mgr2.backup('{"type":"full-backup"}');
  assert.equal(res.files.length, 2);
  assert.ok(res.at);

  await mgr2.disable();
  assert.equal(await mgr2.isEnabled(), false);
  await assert.rejects(() => mgr2.backup('{}'), /not enabled/);
});

test('backup manager: enable errors in an unsupported environment when no directory is chosen', async () => {
  const mgr = backup.createBackupManager({ idb: fakeIdb(), showDirectoryPicker: null });
  await assert.rejects(() => mgr.enable(), /not supported|not enabled|failed/);
});
