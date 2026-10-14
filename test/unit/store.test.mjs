/* Unit tests: store profile persistence */
import test from 'node:test';
import assert from 'node:assert/strict';
import '../../extension/src/core/schema.js';
import '../../extension/src/core/store.js';

const CV = globalThis.CVCore;
const { store } = CV;

function newStore() {
  return store.createStore(store.memoryAdapter());
}

test('empty profile self-healing: invalid input returns an empty structure', async () => {
  const s = newStore();
  const p = await s.load();
  assert.deepEqual(p.fields, {});
  assert.deepEqual(p.customFields, []);
  const p2 = store.normalizeProfile('not-json');
  assert.deepEqual(p2.fields, {});
});

test('field write / read / update timestamp', async () => {
  const s = newStore();
  const changed = await s.updateFields({ fullName: '张三', phone: '13800000000' });
  assert.equal(changed.length, 2);
  assert.equal(await s.getField('fullName'), '张三');
  const p = await s.load();
  assert.ok(p.fields.fullName.updatedAt);
  // An identical value produces no change
  const changed2 = await s.updateFields({ fullName: '张三' });
  assert.equal(changed2.length, 0);
});

test('empty values are not written; removeField deletes', async () => {
  const s = newStore();
  await s.updateFields({ email: 'a@b.com', empty1: '' });
  let p = await s.load();
  assert.equal(p.fields.empty1, undefined);
  assert.equal(p.fields.email.value, 'a@b.com');
  await s.removeField('email');
  p = await s.load();
  assert.equal(p.fields.email, undefined);
});

test('custom fields: add / update / delete', async () => {
  const s = newStore();
  const item = await s.addCustomField({ key: '竞赛成绩', label: '竞赛成绩', category: 'other', value: 'ACM 金牌' });
  assert.equal(item.key, 'custom:竞赛成绩');
  await s.addCustomField({ key: 'custom:竞赛成绩', label: '竞赛成绩', value: 'ACM 金牌 ×2' });
  const flat = await s.flatValues();
  assert.equal(flat['custom:竞赛成绩'], 'ACM 金牌 ×2');
  await s.removeField('custom:竞赛成绩');
  const flat2 = await s.flatValues();
  assert.equal(flat2['custom:竞赛成绩'], undefined);
});

test('import/export: merge vs overwrite, masking', async () => {
  const s1 = newStore();
  await s1.save(store.sampleProfile());
  const json = await s1.exportJson({ maskSensitive: false });
  assert.ok(json.includes('张三'));

  const s2 = newStore();
  await s2.updateFields({ fullName: '李四' });
  await s2.importJson(json, { merge: true });
  assert.equal(await s2.getField('fullName'), '张三'); // merging overwrites the same name
  assert.equal(await s2.getField('school'), '示例大学');

  const masked = await s1.exportJson({ maskSensitive: true, schema: CV.schema });
  assert.ok(!masked.includes('000000000000000000'), 'the ID number should be masked');
  assert.ok(masked.includes('13****0000') || masked.includes('138****8000') || /\*{4}/.test(masked));

  await assert.rejects(() => s2.importJson('{bad json'), /invalid JSON/);
});

test('corrupted data self-healing: wrongly typed fields are fixed', () => {
  const p = store.normalizeProfile({
    fields: { a: { value: 123 }, b: 'raw-string', c: null, d: { value: '' } },
    customFields: [{ key: 'x', value: 'y' }, null],
  });
  assert.equal(p.fields.a.value, '123');
  assert.equal(p.fields.b.value, 'raw-string');
  assert.equal(p.fields.c, undefined);
  assert.equal(p.fields.d, undefined);
  assert.equal(p.customFields.length, 1);
  assert.equal(p.customFields[0].key, 'custom:x');
});

test('sample learning: alias/sample recording, de-duplication, clearing, preserved by import/export', async () => {
  const s = newStore();
  assert.equal(await s.addLearnedAlias('fullName', '怎么称呼你'), true);
  assert.equal(await s.addLearnedAlias('fullName', '怎么称呼你'), false, 'a repeated alias should be skipped');
  const sample = await s.addSample({ label: '为什么想加入我们公司', intent: 'reason', content: '贵司方向与我的规划契合。', source: 'http://x/apply' });
  assert.ok(sample.learnedAt);
  assert.equal((await s.addSample({ label: '为什么想加入我们公司', intent: 'reason', content: '贵司方向与我的规划契合。' })).content, sample.content, 'a repeated sample should be de-duplicated');

  const learning = await s.getLearning();
  assert.deepEqual(learning.aliases.fullName, ['怎么称呼你']);
  assert.equal(learning.samples.length, 1);

  // Export/import preserves the learning records
  const json = await s.exportJson({ maskSensitive: false });
  const s2 = newStore();
  await s2.importJson(json, { merge: true });
  const l2 = await s2.getLearning();
  assert.deepEqual(l2.aliases.fullName, ['怎么称呼你']);
  assert.equal(l2.samples.length, 1);

  await s2.clearLearning();
  assert.deepEqual((await s2.getLearning()).aliases, {});
  assert.equal((await s2.getLearning()).samples.length, 0);
});

test('sample learning: corrupted learning data self-healing', () => {
  const p = store.normalizeProfile({
    fields: {},
    learning: { aliases: { fullName: ['a', 'a', '', 'b'] }, samples: [{ label: 'x', content: 'y' }, { bad: 1 }, null] },
  });
  assert.deepEqual(p.learning.aliases.fullName, ['a', 'b']);
  assert.equal(p.learning.samples.length, 1);
});

test('multiple resumes: create/switch/data isolation/switch back restores', async () => {
  const adapter = store.memoryAdapter();
  const s = store.createStore(adapter);
  await s.updateFields({ fullName: '张三' });

  const p2 = await s.createProfile({ name: 'B公司版', cloneActive: false });
  const list = await s.listProfiles();
  assert.equal(list.profiles.length, 2);
  assert.equal(list.activeId, p2.id, 'the new one should be auto-activated');
  assert.equal(await s.getField('fullName'), undefined, 'the new set should be blank');

  await s.updateFields({ fullName: '李四（B公司表述）' });
  const first = list.profiles.find((x) => x.id !== p2.id);
  await s.activateProfile(first.id);
  assert.equal(await s.getField('fullName'), '张三', 'switching back restores the original set fields');

  await s.activateProfile(p2.id);
  assert.equal(await s.getField('fullName'), '李四（B公司表述）', 'switching to the new set restores its fields');
});

test('multiple resumes: clone inheritance, rename, cross-instance persistence, delete fallback', async () => {
  const adapter = store.memoryAdapter();
  const s = store.createStore(adapter);
  await s.updateFields({ fullName: '张三', school: '示例大学' });

  const clone = await s.createProfile({ name: '克隆版', cloneActive: true });
  assert.equal(await s.getField('school'), '示例大学', 'the clone set inherits fields');
  assert.equal((await s.getLearning()).samples.length, 0, 'the clone inherits learning records');
  await s.updateFields({ school: '清华大学（甲方版）' });

  const renamed = await s.renameProfile(clone.id, '甲方公司专用');
  assert.equal(renamed.name, '甲方公司专用');

  // Simulate a restart: a new store instance reads the same backend
  const s2 = store.createStore(adapter);
  const l2 = await s2.listProfiles();
  assert.equal(l2.profiles.length, 2);
  await s2.activateProfile(clone.id);
  assert.equal(await s2.getField('school'), '清华大学（甲方版）');

  // Deleting the active clone set → falls back to the default set
  await s2.deleteProfile(clone.id);
  const l3 = await s2.listProfiles();
  assert.equal(l3.profiles.length, 1);
  assert.equal(l3.activeId, l2.profiles.find((p) => p.id !== clone.id).id);
  assert.equal(await s2.getField('school'), '示例大学');
  await assert.rejects(() => s2.deleteProfile(l3.activeId), /At least one resume set/);
});

test('multiple resumes: importing creates an independent resume set (does not overwrite the current one)', async () => {
  const adapter = store.memoryAdapter();
  const s = store.createStore(adapter);
  await s.updateFields({ fullName: '当前用户' });
  const incoming = store.sampleProfile();

  const entry = await s.importJson(JSON.stringify(incoming), { mode: 'new', name: '甲方公司A' });
  assert.ok(entry.id && entry.name === '甲方公司A');
  const list = await s.listProfiles();
  assert.equal(list.profiles.length, 2);
  assert.notEqual(list.activeId, entry.id, 'importing as a new set does not switch the active one');
  assert.equal(await s.getField('fullName'), '当前用户', 'the current set is not overwritten');

  await s.activateProfile(entry.id);
  assert.equal(await s.getField('fullName'), '张三', 'the imported set holds independent complete content');

  // Export per set
  const list2 = await s.listProfiles();
  const otherId = list2.profiles.find((p) => p.id !== list2.activeId).id;
  const exported = await s.exportProfileJson(otherId, { maskSensitive: false });
  assert.equal(JSON.parse(exported).fields.fullName.value, '当前用户');
});

test('concurrency/multi-context: a stale cache must not be written back wholesale over other contexts writes (data-loss guard)', async () => {
  const adapter = store.memoryAdapter();
  const a = store.createStore(adapter); // simulates the options page
  const b = store.createStore(adapter); // simulates the content script (sample learning)
  await a.updateFields({ fullName: '张三' });
  await a.load(); // A holds an over-read result
  await b.updateFields({ jobReason: '样例学习写入的内容' }); // B writes
  await a.updateFields({ phone: '13800000000' }); // A keeps editing
  const p = await a.load();
  assert.equal(p.fields.jobReason.value, '样例学习写入的内容', "B's write must not be overwritten by A's stale-cache write-back");
  assert.equal(p.fields.fullName.value, '张三');
  assert.equal(p.fields.phone.value, '13800000000');
});

test('settings: defaults and patch merging', async () => {
  const s = newStore();
  const d = await s.getSettings();
  assert.equal(d.autoFill, true);
  assert.equal(d.llm.enabled, false);
  await s.patchSettings({ autoFill: false, llm: { enabled: true, model: 'm1' } });
  const s2 = await s.getSettings();
  assert.equal(s2.autoFill, false);
  assert.equal(s2.llm.enabled, true);
  assert.equal(s2.llm.model, 'm1');
  assert.equal(s2.siteMode, 'all');
});
