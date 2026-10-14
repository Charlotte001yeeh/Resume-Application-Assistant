/* CV Plugin core — store.js
 * Persistence for profile & settings: chrome.storage.local (extension) or a Map (Node tests) as backend.
 * Exposed as globalThis.CVCore.store.
 */
(function (root) {
  'use strict';
  const core = (root.CVCore = root.CVCore || {});

  const PROFILE_KEY = 'cvProfile';
  const SETTINGS_KEY = 'cvSettings';
  /** Multi-set index; inactive sets live in `cvProfile:<id>`, the active set always lives in cvProfile */
  const INDEX_KEY = 'cvProfileIndex';
  const PROFILE_PREFIX = 'cvProfile:';
  const PROFILE_VERSION = 1;

  function nowIso() {
    return new Date().toISOString();
  }

  function emptyProfile() {
    return {
      version: PROFILE_VERSION,
      updatedAt: nowIso(),
      fields: {},
      customFields: [],
      /** Sample learning: aliases & handwritten samples learned from filled pages (improve matching & generation) */
      learning: { aliases: {}, samples: [], ignored: {} },
    };
  }

  function defaultSettings() {
    return {
      autoFill: true,
      showFloatingButton: true,
      lang: 'en', // UI display language: 'en' | 'zh' | 'auto'
      fabPos: { rx: 24, ry: 24 }, // draggable floating-ball position (px offsets from the right/bottom viewport edges)
      siteMode: 'all', // 'all' | 'whitelist'
      allowedSites: [],
      blockedSites: [],
      llm: { enabled: false, baseUrl: '', apiKey: '', model: '', vlmEnabled: false, vlmStudy: false },
    };
  }

  /** Data self-healing: tolerate old versions / corruption / type errors. */
  function normalizeProfile(raw) {
    const profile = emptyProfile();
    if (!raw || typeof raw !== 'object') return profile;
    if (raw.fields && typeof raw.fields === 'object') {
      for (const [key, entry] of Object.entries(raw.fields)) {
        if (entry == null) continue;
        const value = typeof entry === 'object' && entry !== null && 'value' in entry ? entry.value : entry;
        if (value == null || value === '') continue;
        profile.fields[key] = {
          value: String(value),
          updatedAt: (typeof entry === 'object' && entry && entry.updatedAt) || raw.updatedAt || nowIso(),
        };
      }
    }
    if (Array.isArray(raw.customFields)) {
      for (const item of raw.customFields) {
        if (!item || typeof item !== 'object' || !item.key) continue;
        profile.customFields.push({
          key: String(item.key).startsWith('custom:') ? String(item.key) : `custom:${item.key}`,
          label: String(item.label || item.key),
          category: String(item.category || 'other'),
          value: String(item.value == null ? '' : item.value),
          updatedAt: item.updatedAt || nowIso(),
        });
      }
    }
    // self-heal learning data
    const learn = raw.learning;
    if (learn && typeof learn === 'object') {
      if (learn.aliases && typeof learn.aliases === 'object') {
        for (const [key, arr] of Object.entries(learn.aliases)) {
          const list = (Array.isArray(arr) ? arr : [arr]).map((x) => String(x == null ? '' : x).trim()).filter(Boolean);
          const uniqList = [...new Set(list)].slice(0, 40);
          if (uniqList.length) profile.learning.aliases[key] = uniqList;
        }
      }
      if (learn.ignored && typeof learn.ignored === 'object') {
        for (const [key, arr] of Object.entries(learn.ignored)) {
          const list = (Array.isArray(arr) ? arr : [arr]).map((x) => String(x == null ? '' : x).trim()).filter(Boolean);
          const uniqList = [...new Set(list)].slice(0, 40);
          if (uniqList.length) profile.learning.ignored[key] = uniqList;
        }
      }
      if (Array.isArray(learn.samples)) {
        for (const s of learn.samples) {
          if (!s || typeof s !== 'object' || !s.content) continue;
          profile.learning.samples.push({
            label: String(s.label || ''),
            intent: String(s.intent || 'open'),
            content: String(s.content),
            fieldKey: String(s.fieldKey || ''),
            source: String(s.source || ''),
            learnedAt: s.learnedAt || nowIso(),
          });
        }
        // de-duplicate (same label+content) and cap
        const seen = new Set();
        profile.learning.samples = profile.learning.samples
          .filter((s) => {
            const k = `${s.label}::${s.content}`;
            if (seen.has(k)) return false;
            seen.add(k);
            return true;
          })
          .slice(-200);
      }
    }
    profile.updatedAt = raw.updatedAt || profile.updatedAt;
    profile.version = PROFILE_VERSION;
    return profile;
  }

  function normalizeSettings(raw) {
    const s = defaultSettings();
    if (!raw || typeof raw !== 'object') return s;
    Object.assign(s, raw, { llm: Object.assign(s.llm, raw.llm || {}) });
    return s;
  }

  /** In-memory backend (tests). */
  function memoryAdapter() {
    const map = new Map();
    return {
      async get(key) {
        return map.has(key) ? JSON.parse(JSON.stringify(map.get(key))) : undefined;
      },
      async set(key, value) {
        map.set(key, JSON.parse(JSON.stringify(value)));
      },
      async remove(key) {
        map.delete(key);
      },
    };
  }

  /** chrome.storage.local backend. */
  function chromeAdapter(area) {
    const storageArea = area || (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local);
    if (!storageArea) throw new Error('chrome.storage.local is not available');
    return {
      async get(key) {
        const obj = await storageArea.get(key);
        return obj[key];
      },
      async set(key, value) {
        await storageArea.set({ [key]: value });
      },
      async remove(key) {
        await storageArea.remove(key);
      },
    };
  }

  function newProfileId() {
    return `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  }

  function defaultIndex() {
    return { version: 1, activeId: 'default', profiles: [{ id: 'default', name: 'Default Resume', updatedAt: nowIso() }] };
  }

  function createStore(adapter) {
    if (!adapter) throw new Error('createStore requires a storage adapter');
    let cache = null;

    /** Load & self-heal the multi-set index (first run adopts the existing cvProfile as "Default Resume"). */
    async function ensureIndex() {
      let idx = await adapter.get(INDEX_KEY);
      if (!idx || typeof idx !== 'object' || !Array.isArray(idx.profiles) || !idx.profiles.length) {
        idx = defaultIndex();
        await adapter.set(INDEX_KEY, idx);
      }
      idx.profiles = idx.profiles.filter((p) => p && p.id);
      if (!idx.profiles.some((p) => p.id === idx.activeId)) idx.activeId = idx.profiles[0].id;
      return idx;
    }

    const api = {
      async load() {
        // Always read from the backend (never trust cache): prevents stale-cache overwrites from concurrent writers
        const raw = await adapter.get(PROFILE_KEY);
        cache = normalizeProfile(raw);
        return cache;
      },
      async save(profile) {
        const normalized = normalizeProfile(profile);
        normalized.updatedAt = nowIso();
        await adapter.set(PROFILE_KEY, normalized);
        cache = normalized;
        return normalized;
      },
      async getSettings() {
        return normalizeSettings(await adapter.get(SETTINGS_KEY));
      },
      async patchSettings(patch) {
        const current = await api.getSettings();
        const next = normalizeSettings({ ...current, ...(patch || {}), llm: { ...current.llm, ...((patch && patch.llm) || {}) } });
        await adapter.set(SETTINGS_KEY, next);
        return next;
      },
      async getField(key) {
        const p = await api.load();
        if (p.fields[key]) return p.fields[key].value;
        const custom = p.customFields.find((c) => c.key === key);
        return custom ? custom.value : undefined;
      },
      /** Bulk update (skips empty values); returns the keys that actually changed. */
      async updateFields(map) {
        const p = await api.load();
        const changed = [];
        for (const [key, value] of Object.entries(map || {})) {
          if (value == null || String(value) === '') continue;
          const str = String(value);
          const existing = p.fields[key] ? p.fields[key].value : undefined;
          const customIdx = p.customFields.findIndex((c) => c.key === key);
          if (existing !== str) {
            p.fields[key] = { value: str, updatedAt: nowIso() };
            changed.push(key);
          } else if (customIdx === -1 && !p.fields[key]) {
            p.fields[key] = { value: str, updatedAt: nowIso() };
            changed.push(key);
          }
          if (customIdx !== -1 && p.customFields[customIdx].value !== str) {
            p.customFields[customIdx] = { ...p.customFields[customIdx], value: str, updatedAt: nowIso() };
            if (!changed.includes(key)) changed.push(key);
          }
        }
        if (changed.length) await api.save(p);
        return changed;
      },
      async updateField(key, value) {
        return api.updateFields({ [key]: value });
      },
      async removeField(key) {
        const p = await api.load();
        let touched = false;
        if (p.fields[key]) {
          delete p.fields[key];
          touched = true;
        }
        const idx = p.customFields.findIndex((c) => c.key === key);
        if (idx !== -1) {
          p.customFields.splice(idx, 1);
          touched = true;
        }
        if (touched) await api.save(p);
        return touched;
      },
      async addCustomField({ key, label, category, value } = {}) {
        const p = await api.load();
        const finalKey = key ? (String(key).startsWith('custom:') ? String(key) : `custom:${key}`) : `custom:${Math.random().toString(36).slice(2, 8)}`;
        const existing = p.customFields.find((c) => c.key === finalKey);
        const item = {
          key: finalKey,
          label: String(label || finalKey.replace(/^custom:/, '')),
          category: String(category || 'other'),
          value: String(value == null ? '' : value),
          updatedAt: nowIso(),
        };
        if (existing) Object.assign(existing, item);
        else p.customFields.push(item);
        await api.save(p);
        return item;
      },
      /** Record an alias learned from a sample page (page label -> profile field) for future matching. */
      async addLearnedAlias(fieldKey, label) {
        const key = String(fieldKey || '').trim();
        const lbl = String(label || '').trim();
        if (!key || !lbl) return false;
        const p = await api.load();
        const list = p.learning.aliases[key] || [];
        if (list.some((x) => x === lbl)) return false;
        list.push(lbl);
        p.learning.aliases[key] = list.slice(-40);
        await api.save(p);
        return true;
      },
      /** Record a handwritten sample (verbatim answer for unseen/similar fields) as a generation reference. */
      async addSample(sample) {
        const s = {
          label: String((sample && sample.label) || ''),
          intent: String((sample && sample.intent) || 'open'),
          content: String((sample && sample.content) || ''),
          fieldKey: String((sample && sample.fieldKey) || ''),
          source: String((sample && sample.source) || ''),
          learnedAt: nowIso(),
        };
        if (!s.content) return null;
        const p = await api.load();
        const dup = p.learning.samples.find((x) => x.label === s.label && x.content === s.content);
        if (dup) return dup;
        p.learning.samples.push(s);
        p.learning.samples = p.learning.samples.slice(-200);
        await api.save(p);
        return s;
      },
      async getLearning() {
        const p = await api.load();
        return p.learning;
      },
      /** Record an ignored suggestion (declined in batch confirm); down-rank it during matching. */
      async addIgnored(fieldKey, label) {
        const key = String(fieldKey || '').trim();
        const lbl = String(label || '').trim();
        if (!key || !lbl) return false;
        const p = await api.load();
        const list = p.learning.ignored[key] || [];
        if (list.some((x) => x === lbl)) return false;
        list.push(lbl);
        p.learning.ignored[key] = list.slice(-40);
        await api.save(p);
        return true;
      },
      /** Restore an ignored suggestion (options page management). */
      async restoreIgnored(fieldKey, label) {
        const p = await api.load();
        const list = p.learning.ignored[fieldKey] || [];
        const idx = label ? list.indexOf(String(label)) : 0;
        if (idx === -1) return false;
        if (label) list.splice(idx, 1);
        else list.length = 0;
        if (list.length) p.learning.ignored[fieldKey] = list;
        else delete p.learning.ignored[fieldKey];
        await api.save(p);
        return true;
      },
      async clearLearning() {
        const p = await api.load();
        p.learning = { aliases: {}, samples: [], ignored: {} };
        await api.save(p);
        return true;
      },
      // ── Multiple resume sets (different wording per company/scenario) ──────────────
      /** Resume set list: { activeId, profiles: [{id, name, updatedAt}] } */
      async listProfiles() {
        const idx = await ensureIndex();
        return { activeId: idx.activeId, profiles: idx.profiles.map((p) => ({ ...p })) };
      },
      /** Create and activate a set; cloneActive=true copies the current set (fields/custom/learning). */
      async createProfile({ name, cloneActive = true } = {}) {
        const idx = await ensureIndex();
        const id = newProfileId();
        const data = cloneActive ? JSON.parse(JSON.stringify(await api.load())) : emptyProfile();
        data.updatedAt = nowIso();
        await adapter.set(PROFILE_PREFIX + id, data);
        const entry = { id, name: String(name || `Resume ${idx.profiles.length + 1}`), updatedAt: data.updatedAt };
        idx.profiles.push(entry);
        await adapter.set(INDEX_KEY, idx);
        await api.activateProfile(id); // activate right after creation so the new set can be edited immediately
        return entry;
      },
      /** Switch sets: persist the current set to its key, load the target set into the main key. */
      async activateProfile(id) {
        const idx = await ensureIndex();
        const entry = idx.profiles.find((p) => p.id === id);
        if (!entry) throw new Error(`Resume set not found: ${id}`);
        if (id === idx.activeId) return { ...entry };
        const current = await api.load();
        await adapter.set(PROFILE_PREFIX + idx.activeId, current);
        const raw = await adapter.get(PROFILE_PREFIX + id);
        const data = normalizeProfile(raw || emptyProfile());
        await adapter.set(PROFILE_KEY, data);
        idx.activeId = id;
        idx.updatedAt = nowIso();
        await adapter.set(INDEX_KEY, idx);
        cache = null; // force the next load() to read the newly activated set
        return { ...entry };
      },
      async renameProfile(id, name) {
        const idx = await ensureIndex();
        const entry = idx.profiles.find((p) => p.id === id);
        if (!entry) throw new Error(`Resume set not found: ${id}`);
        entry.name = String(name || entry.name);
        entry.updatedAt = nowIso();
        await adapter.set(INDEX_KEY, idx);
        return { ...entry };
      },
      /** Delete a set; deleting the active one falls back to the first remaining. At least one set stays. */
      async deleteProfile(id) {
        const idx = await ensureIndex();
        if (idx.profiles.length <= 1) throw new Error('At least one resume set must remain');
        const pos = idx.profiles.findIndex((p) => p.id === id);
        if (pos === -1) return false;
        const wasActive = idx.activeId === id;
        idx.profiles.splice(pos, 1);
        if (wasActive) {
          const next = idx.profiles[0];
          const raw = await adapter.get(PROFILE_PREFIX + next.id);
          await adapter.set(PROFILE_KEY, normalizeProfile(raw || emptyProfile()));
          idx.activeId = next.id;
          cache = null;
        }
        idx.updatedAt = nowIso();
        await adapter.set(INDEX_KEY, idx);
        if (typeof adapter.remove === 'function') await adapter.remove(PROFILE_PREFIX + id);
        return true;
      },
      /** Flat view {key: value} (incl. custom fields) for matching/generation. */
      async flatValues() {
        const p = await api.load();
        const out = {};
        for (const [k, v] of Object.entries(p.fields)) out[k] = v.value;
        for (const c of p.customFields) out[c.key] = c.value;
        return out;
      },
      async exportJson({ maskSensitive = false, schema } = {}) {
        return serializeProfile(await api.load(), { maskSensitive, schema });
      },
      /** Export a specific set (the active id equals exportJson). */
      async exportProfileJson(id, opts = {}) {
        const idx = await ensureIndex();
        if (!id || id === idx.activeId) return api.exportJson(opts);
        const raw = await adapter.get(PROFILE_PREFIX + id);
        return serializeProfile(normalizeProfile(raw || emptyProfile()), opts);
      },
      /** Full backup: all sets + learning + settings -> one JSON string (keep it on disk long-term). */
      async exportAllJson() {
        const idx = await ensureIndex();
        const profiles = {};
        for (const p of idx.profiles) {
          profiles[p.id] =
            p.id === idx.activeId
              ? normalizeProfile(await api.load())
              : normalizeProfile((await adapter.get(PROFILE_PREFIX + p.id)) || emptyProfile());
        }
        return JSON.stringify(
          {
            app: 'cv-plugin',
            type: 'full-backup',
            version: 1,
            exportedAt: nowIso(),
            index: { activeId: idx.activeId, profiles: idx.profiles },
            profiles,
            settings: await api.getSettings(),
          },
          null,
          2
        );
      },
      /** Restore from a full backup (full replacement of sets, learning and settings). */
      async importAllJson(json) {
        let raw;
        try {
          raw = typeof json === 'string' ? JSON.parse(json) : json;
        } catch (e) {
          throw new Error('Restore failed: invalid JSON');
        }
        if (!raw || raw.type !== 'full-backup' || !raw.profiles || !raw.index || !Array.isArray(raw.index.profiles) || !raw.index.profiles.length) {
          throw new Error('Not a valid CV Plugin full-backup file');
        }
        const idx = {
          version: 1,
          activeId: String(raw.index.activeId || raw.index.profiles[0].id),
          profiles: raw.index.profiles.map((p) => ({
            id: String(p.id),
            name: String(p.name || 'Resume'),
            updatedAt: p.updatedAt || nowIso(),
          })),
        };
        if (!idx.profiles.some((p) => p.id === idx.activeId)) idx.activeId = idx.profiles[0].id;
        // Clear existing per-set keys, then write the backup content
        const old = await ensureIndex();
        for (const p of old.profiles) {
          if (typeof adapter.remove === 'function') await adapter.remove(PROFILE_PREFIX + p.id);
        }
        for (const entry of idx.profiles) {
          const data = normalizeProfile(raw.profiles[entry.id] || emptyProfile());
          if (entry.id === idx.activeId) await adapter.set(PROFILE_KEY, data);
          else await adapter.set(PROFILE_PREFIX + entry.id, data);
        }
        await adapter.set(INDEX_KEY, idx);
        if (raw.settings) await adapter.set(SETTINGS_KEY, normalizeSettings(raw.settings));
        cache = null;
        return { profiles: idx.profiles.length, activeId: idx.activeId };
      },
      async importJson(json, { merge = true, mode, name } = {}) {
        let raw;
        try {
          raw = typeof json === 'string' ? JSON.parse(json) : json;
        } catch (e) {
          throw new Error('Import failed: invalid JSON');
        }
        const incoming = normalizeProfile(raw);
        // Import as an independent set (the active set is untouched)
        if (mode === 'new') {
          const idx = await ensureIndex();
          const id = newProfileId();
          await adapter.set(PROFILE_PREFIX + id, incoming);
          const entry = {
            id,
            name: String(name || `Imported Resume ${idx.profiles.length + 1}`),
            updatedAt: incoming.updatedAt || nowIso(),
          };
          idx.profiles.push(entry);
          await adapter.set(INDEX_KEY, idx);
          return entry;
        }
        if (!merge) {
          return api.save(incoming);
        }
        const p = await api.load();
        for (const [k, v] of Object.entries(incoming.fields)) p.fields[k] = v;
        for (const c of incoming.customFields) {
          const idx = p.customFields.findIndex((x) => x.key === c.key);
          if (idx !== -1) p.customFields[idx] = c;
          else p.customFields.push(c);
        }
        // Merge learning records (alias union, sample de-dup)
        for (const [k, labels] of Object.entries(incoming.learning.aliases)) {
          p.learning.aliases[k] = [...new Set([...(p.learning.aliases[k] || []), ...labels])].slice(-40);
        }
        for (const [k, labels] of Object.entries(incoming.learning.ignored || {})) {
          p.learning.ignored[k] = [...new Set([...(p.learning.ignored[k] || []), ...labels])].slice(-40);
        }
        const seen = new Set(p.learning.samples.map((s) => `${s.label}::${s.content}`));
        for (const s of incoming.learning.samples) {
          const key = `${s.label}::${s.content}`;
          if (!seen.has(key)) {
            seen.add(key);
            p.learning.samples.push(s);
          }
        }
        p.learning.samples = p.learning.samples.slice(-200);
        return api.save(p);
      },
    };
    return api;
  }

  function maskValue(v) {
    const s = String(v);
    if (s.length <= 4) return '****';
    return s.slice(0, 2) + '****' + s.slice(-2);
  }

  /** Serialize one resume set to JSON (optional sensitive-field masking). */
  function serializeProfile(profile, { maskSensitive = false, schema } = {}) {
    const clone = JSON.parse(JSON.stringify(profile));
    if (maskSensitive) {
      for (const [key, entry] of Object.entries(clone.fields || {})) {
        const def = schema && schema.getField ? schema.getField(key) : null;
        if (def && def.sensitive && entry.value) entry.value = maskValue(entry.value);
      }
      for (const entry of clone.customFields || []) {
        const def = schema && schema.getField ? schema.getField(entry.key) : null;
        if (def && def.sensitive && entry.value) entry.value = maskValue(entry.value);
      }
    }
    return JSON.stringify(clone, null, 2);
  }

  /** Demo profile (for demos / tests). */
  function sampleProfile() {
    const p = emptyProfile();
    const t = nowIso();
    const set = (key, value) => {
      p.fields[key] = { value: String(value), updatedAt: t };
    };
    set('fullName', '张三');
    set('englishName', 'Demo User');
    set('gender', 'male');
    set('birthDate', '1995-06-18');
    set('age', '30');
    set('idNumber', '000000000000000000'); // fictional demo data
    set('nationality', '汉族');
    set('politicalStatus', 'party');
    set('maritalStatus', 'single');
    set('hukou', '北京市');
    set('currentCity', '北京市');
    set('phone', '13800000000');
    set('alternatePhone', '010-00000000');
    set('email', 'demo.user@example.com');
    set('address', '北京市海淀区示例路 1 号');
    set('zip', '100080');
    set('wechat', 'demo_user');
    set('qq', '123456789');
    set('personalSite', 'https://github.com/demo-user');
    set('emergencyContact', '示例联系人');
    set('emergencyPhone', '13900000000');
    set('highestEducation', 'master');
    set('degree', 'master');
    set('school', '示例大学');
    set('major', 'Computer Science');
    set('graduationDate', '2020-06-30');
    set('gpa', '3.7/4.0');
    set('workYears', '5');
    set('currentCompany', '示例科技有限公司');
    set('currentJobTitle', '高级前端工程师');
    set('workExperience', '2020.07-至今 示例科技有限公司 高级前端工程师：负责企业级数据平台前端架构，主导 React 组件库与微前端改造，页面性能提升 40%，支撑 20+ 内部系统复用。2018.06-2020.06 Previous Corp 前端工程师：参与电商中台建设，负责下单链路重构，转化率提升 12%。');
    set('projectExperience', '数据可视化平台：主导图表引擎与大屏搭建工具，日均服务 5 万次请求，渲染耗时下降 35%。低代码表单引擎：设计 schema 驱动的表单方案，字段配置效率提升 60%，覆盖 30+ 业务场景。');
    set('internshipExperience', '2017.07-2017.09 某互联网公司 Web 开发实习生');
    set('skills', 'JavaScript / TypeScript / React / Vue / Node.js / Webpack / 性能优化 / 微前端 / 数据可视化 / 单元测试');
    set('languages', '英语 CET-6（流利读写）；普通话二级甲等');
    set('certificates', 'PMP 项目管理认证；全国计算机技术与软件专业技术资格（中级）');
    set('awards', '2022 年度公司技术贡献奖；2021 集团创新大赛二等奖');
    set('desiredPosition', '前端架构师');
    set('desiredCity', '北京');
    set('expectedSalary', '30k-40k');
    set('currentSalary', '28k');
    set('jobType', 'fullTime');
    set('availableDate', 'within1month');
    set('industry', '互联网 / 人工智能');
    set('selfEvaluation', '五年企业级前端研发经验，擅长复杂交互与性能优化，具备架构设计与团队协作能力，注重工程质量与可维护性。');
    set('selfIntro', '我是张三，示例大学计算机硕士，现任示例科技高级前端工程师，专注企业级 Web 应用与数据可视化方向。');
    set('advantages', '技术全面且深入：React/Vue 双框架实战经验，性能优化方法论成熟；工程化能力强：主导组件库与微前端落地；结果导向：所有项目均有可量化业务收益。');
    set('jobReason', '贵司在数据智能方向的布局与我的技术积累高度契合，希望在更大规模的业务场景中继续深耕前端架构。');
    set('hobbies', '跑步、开源贡献、摄影');
    set('otherInfo', '可接受合理出差；GitHub: github.com/demo-user');
    return p;
  }

  core.store = {
    PROFILE_KEY,
    SETTINGS_KEY,
    INDEX_KEY,
    PROFILE_PREFIX,
    emptyProfile,
    defaultSettings,
    normalizeProfile,
    normalizeSettings,
    memoryAdapter,
    chromeAdapter,
    createStore,
    sampleProfile,
    maskValue,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
