/* CV Plugin core — i18n.js
 * Frontend display language switch (EN <-> ZH). Code/docs stay English; Chinese is a display option.
 * - t(key, params): dynamic strings (toasts / stat lines); catalog entries are [en, zh].
 * - applyDom(root): swaps STATIC UI text via the inverted catalog (exact EN text -> ZH text)
 *   and restores EN text when switching back. No per-element attributes required.
 * - resolveLang(pref): 'en' | 'zh' | 'auto' (auto follows navigator.language).
 * Pure module — shared by content scripts, popup and options.
 * Attached to globalThis.CVCore.i18n.
 */
(function (root) {
  'use strict';
  const core = (root.CVCore = root.CVCore || {});

  /** Dynamic strings: key -> [english, chinese]; {name} placeholders. */
  const MESSAGES = {
    // ── popup ──
    'popup.fieldCount': ['{n} fields', '{n} 个'],
    'popup.autoFillOn': ['On', '开'],
    'popup.autoFillOff': ['Off', '关'],
    'popup.siteInfo': ['Current page: {title}', '当前页面：{title}'],
    'popup.ready': ['Extension ready (v{v}), page recognized', '扩展就绪（v{v}），页面已识别'],
    'popup.fillStart': ['Scanning and filling (including forms inside iframes)…', '正在扫描并填充（含 iframe 内表单）…'],
    'popup.fillDone': ['Scanned {scanned} fields, auto-filled {auto}, {review} pending review', '扫描 {scanned} 个字段，自动填充 {auto} 个，待确认 {review} 个'],
    'popup.fillDoneMulti': ['Filled {frames} frames: scanned {scanned}, auto-filled {auto}, {review} pending review', '{frames} 个 frame 已填充：扫描 {scanned}，自动填充 {auto}，待确认 {review}'],
    'popup.fillFailed': ['Fill failed', '填充失败'],
    'popup.reviewStart': ['Running resume check…', '正在体检…'],
    'popup.reviewFailed': ['Resume check failed', '体检失败'],
    'popup.reviewDone': ['Resume check done: {gen} generated, {sim} similar phrasings, {opt} optimizations', '体检完成：生成补充 {gen} 条，相似表达 {sim} 条，优化建议 {opt} 条'],
    'popup.studyStart': ['Scanning the filled page and learning…', '正在扫描已填写页面并学习…'],
    'popup.learnFailed': ['Learning failed', '学习失败'],
    'popup.studyDone': ['Sample learning: {similar} merged, {created} new fields, {updated} profile updates, {aliases} aliases, {samples} samples', '样例学习：相似归并 {similar}，新建字段 {created}，改进档案 {updated}，学到别名 {aliases}，样例 {samples}'],
    'popup.learnStart': ['Learning from this page…', '正在学习本页…'],
    'popup.learnDone': ['Wrote {n} fields from this page back to your profile', '从本页回写 {n} 个字段到档案'],
    'popup.backupStart': ['Backing up to folder…', '正在备份到文件夹…'],
    'popup.backupOff': ['Folder backup is not enabled yet: open "Profile Manager" → Data Safety & Backup → choose a backup folder', '尚未开启文件夹备份：请打开「档案管理」→ 数据安全与备份 → 选择备份文件夹'],
    'popup.backupDone': ['Backup complete: {n} files written to "{dir}"', '备份完成：{n} 个文件已写入「{dir}」'],
    'popup.backupFailed': ['Backup failed: {err}', '备份失败：{err}'],
    'popup.noTab': ['No active tab found', '未找到活动标签页'],

    // ── floating panel ──
    'app.title': ['Resume Application Assistant', '简历投递助手'],
    'widget.ballTitle': ['Resume Assistant — click to open', '简历投递助手 — 点击展开'],
    'widget.back': ['Back', '返回'],
    'widget.close': ['Close', '关闭'],
    'chip.fill': ['Fill', '填充'],
    'chip.check': ['Check', '体检'],
    'chip.learn': ['Learn', '学习'],
    'chip.save': ['Save', '回写'],
    'panel.title.fill': ['One-click fill', '一键填充'],
    'panel.title.review': ['Resume check', '简历体检'],
    'panel.title.study': ['Sample learning', '样例学习'],
    'panel.title.learn': ['Learn from this page', '从本页学习'],
    'panel.savedToProfile': ['Saved to profile', '已写入档案'],
    'panel.empty': ['(empty)', '（空）'],
    'panel.reviewFinding': ['Needs review', '待人工确认'],
    'panel.btnFill': ['One-click Fill', '一键填充'],
    'panel.btnReview': ['Resume Check', '简历体检'],
    'panel.btnStudy': ['Sample Learning', '样例学习'],
    'panel.btnLearn': ['Learn from This Page', '从本页学习'],
    'panel.tag.optimize': ['Optimized', '优化'],
    'panel.processing': ['Processing…', '处理中…'],
    'panel.execFailed': ['Execution failed: {err}', '执行失败：{err}'],
    'panel.fillStat': ['Scanned {scanned} fields · Matched {matched} · Auto-filled {auto} · Needs Review {needReview} · Unrecognized {unmatched}', '扫描 {scanned} 个字段 · 匹配 {matched} · 自动填充 {auto} · 待确认 {needReview} · 未识别 {unmatched}'],
    'panel.reviewStat': ['Fields {total} · Auto-matched {autoFilled} · Needs Review {needReview} · Unseen {unmatched} · Suggestions {suggestions}', '字段 {total} · 自动匹配 {autoFilled} · 待确认 {needReview} · 未见 {unmatched} · 建议 {suggestions}'],
    'panel.studyStat': ['Filled {filled} items · Aliases learned {aliases} · Similar merged {similar} · Fields created {created} · Profile improved {updated} · Samples {samples}', '已填 {filled} 项 · 学到别名 {aliases} · 相似归并 {similar} · 新建字段 {created} · 改进档案 {updated} · 样例 {samples}'],
    'panel.learnStat': ['Found {n} fields to write back{written}', '发现 {n} 个可回写字段{written}', ],
    'panel.learnWritten': [' · {n} written', ' · 已回写 {n} 个'],
    'panel.batchTitle': ['{n} low-confidence fields (confirm or ignore in batch)', '{n} 个低置信度字段（可批量确认/忽略）'],
    'panel.batchWhy': ['Page value: {page} → Suggested: {sug}{dup}', '页面值：{page} → 建议填入：{sug}{dup}'],
    'panel.batchDup': [' · duplicate of same field', ' · 同字段重复'],
    'panel.ignoreOption': ['— Ignore this item (do not suggest again) —', '— 忽略此项（不再建议） —'],
    'panel.batchApply': ['Apply Selected', '应用所选项'],
    'panel.batchIgnoreAll': ['Ignore All', '全部忽略'],
    'panel.applying': ['Applying…', '应用中…'],
    'panel.appliedN': ['Applied {n} items', '已应用 {n} 项'],
    'panel.applyFailed': ['Apply failed: {err}', '应用失败：{err}'],
    'panel.allIgnored': ['All Ignored', '已全部忽略'],
    'panel.applied': ['Applied', '已采纳'],
    'panel.profileUpdated': ['Profile Updated', '档案已更新'],
    'panel.failedCount': [' ({n} failed)', ' （{n} 项失败）'],

    // ── options page: dynamic messages ──
    'opt.savedFields': ['Saved ({n} fields updated)', '已保存（更新 {n} 个字段）'],
    'opt.customDeleted': ['Custom field deleted', '自定义字段已删除'],
    'opt.switchedTo': ['Switched to "{name}"', '已切换到「{name}」'],
    'opt.renamed': ['Renamed', '已重命名'],
    'opt.duplicatedAs': ['Duplicated as a new profile', '已复制为新简历套'],
    'opt.exportedProfile': ['Exported "{name}"', '已导出「{name}」'],
    'opt.deleted': ['Deleted', '已删除'],
    'opt.settingsSaved': ['Settings saved', '设置已保存'],
    'opt.sampleLoaded': ['Sample profile loaded (feel free to edit)', '已载入示例档案（可直接修改）'],
    'opt.exported': ['Exported cv-profile.json', '已导出 cv-profile.json'],
    'opt.exportedMasked': ['Exported masked profile', '已导出脱敏档案'],
    'opt.vlmCheckFailed': ['VLM proofread failed; using local parse results', 'VLM 校对失败，已使用本地解析结果'],
    'opt.importedNew': ['Imported as a separate profile "{name}" (current profile unchanged)', '已导入为独立简历套「{name}」（当前套未受影响）'],
    'opt.importedMerged': ['Merged into the current profile', '已合并到当前简历套'],
    'opt.importReading': ['Parsing resume content…', '正在识别简历内容…'],
    'opt.importDone': ['Parsing done; review the preview and click "Apply Import"', '识别完成，请在预览中确认后点击「应用导入」'],
    'opt.importFailed': ['Import failed: {err}', '导入失败：{err}'],
    'opt.enterFieldName': ['Please enter a field name', '请填写字段名称'],
    'opt.customAdded': ['Custom field added', '已添加自定义字段'],
    'opt.learningCleared': ['Learning data cleared', '学习记录已清空'],
    'opt.createdBlank': ['Created and switched to new blank profile "{name}"', '已新建空白简历套「{name}」并切换'],
    'opt.copiedTo': ['Copied to "{name}" and switched', '已复制为「{name}」并切换'],
    'opt.backupStatusOn': ['Auto backup: On → folder "{dir}"', '自动备份：已开启 → 文件夹「{dir}」'],
    'opt.backupStatusLast': [' · Last backup {t}', ' · 上次备份 {t}'],
    'opt.backupStatusOff': ['Auto backup: Off (recommended to avoid data loss when the extension is uninstalled or profiles are wiped)', '自动备份：未开启（推荐开启，避免卸载扩展/清空配置导致丢失）'],
    'opt.backupStatusError': ['Auto backup: failed to read status ({err})', '自动备份：状态读取失败（{err}）'],
    'opt.backedUp': ['Backed up {n} files to the backup folder', '已备份 {n} 个文件到备份文件夹'],
    'opt.backupEnabled': ['Auto backup enabled; first backup written', '自动备份已开启，已写入第一份备份'],
    'opt.backupEnableFailed': ['Failed to enable: {err}', '开启失败：{err}'],
    'opt.backupFailed': ['Backup failed: {err}', '备份失败：{err}'],
    'opt.backupDisabled': ['Auto backup disabled', '已关闭自动备份'],
    'opt.exportedAll': ['Full backup downloaded (all profiles / learning data / settings)', '完整备份已下载（全部简历套 / 学习记录 / 设置）'],
    'opt.restored': ['Restore complete: {n} profiles restored (including learning data and settings)', '恢复完成：已还原 {n} 套简历（含学习记录与设置）'],
    'opt.restoreFailed': ['Restore failed: {err}', '恢复失败：{err}'],
    'opt.currentValueLabel': ['Current profile value:', '当前档案值：'],
    'opt.localValue': ['Local value: {v}', '本地原值：{v}'],
    'opt.modelChange': ['Model change (verify before applying)', '模型改动（应用前请核对）'],
    'opt.previewTitle': ['Import preview: {file} ({source})', '导入预览：{file}（{source}）'],
    'opt.previewPdf': ['PDF extraction', 'PDF 抽取'],
    'opt.previewImage': ['VLM image recognition', 'VLM 图片识别'],
    'opt.previewText': ['text parsing', '文本解析'],
    'opt.previewNote': ['Note: {w}', '提示：{w}'],
    'opt.applyImport': ['Apply Import', '应用导入'],
    'opt.applyImportHint': ['Apply Import (per the import mode above)', '应用导入（按上方导入方式）'],
    'opt.cancelImport': ['Cancel', '取消'],
    'opt.detected': ['Detected {f} fields and {c} custom fields.', '识别到 {f} 个字段、{c} 个自定义字段。'],
    'badge.sensitive': ['Sensitive', '敏感'],
  };

  /**
   * Static UI strings: exact English element text -> Chinese text.
   * applyDom swaps them for zh and restores English text for en.
   */
  const DOM_STRINGS = {
    // ── popup.html ──
    'Resume Application Assistant': '简历投递助手',
    'Current page: loading…': '当前页面：加载中…',
    'Active profile': '当前简历套',
    'Profile fields': '档案字段',
    'Auto-fill': '自动填充',
    'Storage': '存储',
    'chrome.storage.local (this device)': '本地（chrome.storage）',
    'Fill This Page': '一键填充本页',
    'Resume Check': '简历体检',
    'Sample Learning (filled page)': '样例学习（已填页面）',
    'Learn from This Page': '从本页学习',
    'Backup to Folder': '备份到文件夹',
    'Open Profile Manager': '打开档案管理',
    'UI language': '界面语言',
    'Floating ball': '悬浮球',
    // ── floating panel (static parts) ──
    'One-click Fill': '一键填充',
    'Sample Learning': '样例学习',
    'Learn from This Page': '从本页学习',
    'Click "One-click Fill" to start; "Sample Learning" scans filled pages and treats your handwritten content as samples: unseen fields are learned and created, similar fields are merged, and generation and matching keep improving.': '点击“一键填充”开始；“样例学习”扫描已填写页面，把你的手写内容当样例：未见字段学习建档、相似字段归并、生成与匹配持续改进。',
    'Filled': '已填充',
    'Skipped': '跳过',
    'Failed': '失败',
    'Needs Review': '待确认',
    'Generated': '补充生成',
    'Similar wording': '相似表达',
    '— Ignore this item (do not suggest again) —': '— 忽略此项（不再建议） —',
    'Apply Selected': '应用所选项',
    'Ignore All': '全部忽略',
    'Apply & Fill': '采纳填入',
    'Alias Learned': '别名学习',
    '(merged from similar field)': '（相似字段归并）',
    'New Field': '新建字段',
    'Profile Improved': '档案改进',
    'Better Content (Needs Review)': '更优内容（待确认）',
    'Current profile value:': '当前档案值：',
    'Update Profile With Page Content': '用页面内容更新档案',
    // ── options.html ──
    'Resume Profile Manager': '简历档案管理',
    'Your profile is stored locally in the browser (chrome.storage.local) and can be edited anytime; it powers semantic auto-fill on online application forms and resume checks.': '你的简历档案保存在本机浏览器（chrome.storage.local），可随时编辑；用于在线申请表单的语义自动填充与简历体检。',
    'Save All Changes': '保存全部修改',
    'Load Sample Profile': '载入示例档案',
    'Export JSON': '导出 JSON',
    'Export (Masked)': '导出（脱敏）',
    'Import (PDF / Image / JSON)': '导入（PDF / 图片 / JSON）',
    'How to Use': '使用说明',
    'Fill in / update key resume fields here (auto-saved).': '在此填写/更新常用简历字段（自动保存）。',
    'Open any job application page and click the CV button at the bottom right → "One-click Fill"; the plugin detects semantically matching fields and fills them in.': '打开任意求职申请页面，点击右下角 CV 按钮 →「一键填充」，插件会语义识别字段并填写。',
    'Click "Resume Check": auto-generate summaries for unseen fields, suggest similar field phrasings, and optimize the content you already filled in.': '点击「简历体检」：为未见字段自动总结生成、相似字段措辞建议、并优化已填内容。',
    'Click "Learn from This Page": write back what you typed on the page into your profile to keep it up to date.': '点击「从本页学习」：把你在页面上填写的内容回写到档案，保持档案最新。',
    'Multiple Profiles (for different companies / scenarios)': '多套简历（针对不同公司 / 场景）',
    'New Blank Profile': '新建空白简历',
    'Copy from Current': '从当前复制一份',
    'Import mode': '导入方式',
    'Merge into current profile': '合并到当前简历套',
    'Create as a separate profile': '新建为独立简历套',
    'Data Safety & Backup (prevent data loss)': '数据安全与备份（防丢失）',
    'Choose Backup Folder & Enable Auto Backup': '选择备份文件夹并开启自动备份',
    'Backup Now': '立即备份',
    'Disable Auto Backup': '关闭自动备份',
    'Auto backup: Off': '自动备份：关闭',
    'Download Full Backup (all profiles + learning data + settings)': '完整备份下载（全部简历套 + 学习记录 + 设置）',
    'Restore from Full Backup': '从完整备份恢复',
    'Custom Fields': '自定义字段',
    'Add Field': '添加字段',
    'Learning Data (sample learning)': '学习记录（样例学习）',
    'Clear Learning Data': '清空学习记录',
    'Learned Field Aliases': '已学到的字段别名',
    'Hand-Written Samples (generation reference)': '手写样例（生成参考）',
    'Settings': '设置',
    'Site Scope': '站点范围',
    'All websites': '所有网站',
    'Whitelist sites only': '仅白名单网站',
    'Optional: LLM content enhancement (OpenAI-compatible API, off by default)': '可选：LLM 内容增强（OpenAI 兼容接口，默认关闭）',
    'Base URL': '接口地址',
    'API Key': 'API 密钥',
    'Model': '模型',
    'Save Settings': '保存设置',
    'Sensitive': '敏感',
    'Auto (follow browser)': '自动（跟随浏览器）',
    'No custom fields yet': '暂无自定义字段',
    'None yet. Click "Sample Learning" on a filled application page to start collecting.': '暂无。在已填写的申请页面点「样例学习」即可积累。',
    'In use': '使用中',
    'Use': '启用',
    'Duplicate': '复制',
    'Export this profile': '导出此简历套',
    'Model change (verify before applying)': '模型改动（应用前请核对）',
    'Custom field (new)': '自定义字段（新增）',
    'Apply Import': '应用导入',
    'Cancel import': '取消导入',
  };

  /**
   * Runtime messages produced by the core engine (English source text -> Chinese display).
   * The core stays language-neutral; the UI translates these on render.
   */
  const DYNAMIC_RULES = [
    // fill engine
    [/^No matching radio option found$/, '未找到匹配的单选项'],
    [/^Radio option missing element reference$/, '单选项缺少元素引用'],
    [/^Checked (\d+) option\(s\)$/, '已勾选 $1 项'],
    [/^No matching checkbox options found$/, '未找到匹配的复选项'],
    [/^Select missing element reference$/, '下拉框缺少元素引用'],
    [/^Matched directly by option text$/, '按选项文本直接匹配'],
    [/^No matching dropdown option found$/, '未找到匹配的下拉选项'],
    [/^Missing element reference$/, '缺少元素引用'],
    [/^Date value "(.+)" could not be parsed$/, '日期值「$1」无法解析'],
    [/^Date filled as a whole ISO value$/, '日期已整体填入（ISO 格式）'],
    [/^Date component "(.+)" → option "(.+)"$/, '日期分量「$1」→ 选项「$2」'],
    [/^No option for "(.+)"; filled bare value$/, '「$1」无对应选项，已填裸值'],
    [/^Date-split fill failed for component "(.+)"$/, '日期分量「$1」填写失败'],
    [/^No dropdown options appeared; value assigned directly$/, '未出现下拉选项，已直接赋值'],
    [/^No matching dropdown option; value assigned directly$/, '下拉中无匹配选项，已直接赋值'],
    [/^Dropdown interaction failed; fell back: (.*)$/, '下拉交互异常，已回退：$1'],
    [/^Profile has no value for this field$/, '档案中该字段为空'],
    [/^exceeds (\d+) chars, truncated$/, '超出 $1 字上限，已截断'],
    // option matching reasons
    [/^value (.+) falls in range "(.+)"$/, '数值 $1 落在区间「$2」'],
    [/^option text "(.+)" matches the value exactly$/, '选项文本「$1」与值完全一致'],
    [/^option text "(.+)" contains the target value$/, '选项文本「$1」包含目标值'],
    [/^option "(.+)" is a synonym of canonical value "(.+)"$/, '选项「$1」与规范值「$2」同义'],
    [/^option "(.+)" overlaps with the target tokens$/, '选项「$1」与目标词面重叠'],
    // field matching reasons
    [/^alias "(.+)" hit on signal (.+)$/, '别名「$1」命中信号 $2'],
    [/^multiple signals agree$/, '多信号一致'],
    [/^input-shape match (.+)$/, '输入形态匹配 $1'],
    [/^input-shape conflict$/, '输入形态冲突'],
    [/^option semantics match$/, '选项语义吻合'],
    [/^penalized by conflict word "(.+)"$/, '触发冲突词「$1」降权'],
    [/^previously ignored suggestion$/, '此前已忽略该建议'],
    [/^score gap to "(.+)" is too small \((.+)\); needs manual confirmation$/, '与「$1」分差过小（$2），需人工确认'],
    [/^already occupied by a higher-score field.*$/, '已被本页更高分字段占用，需人工确认'],
    // review advice / rationale
    [/^Exceeds the (\d+)-character limit \(currently (\d+) chars\); a trimmed version is provided$/, '超出 $1 字限制（当前 $2 字），已给出精简版本'],
    [/^The original text lacks quantified metrics; quantified results from the profile were appended$/, '原文缺少量化数据，已追加档案中的量化成果'],
    [/^The original text lacks quantified metrics; add result indicators such as numbers\/percentages\/scale$/, '原文缺少量化数据，建议补充数字/百分比/规模等结果指标'],
    [/^Compared against job-description keywords; consider adding: (.+)$/, '与职位描述关键词比对，建议补充：$1'],
    [/^Suspected sensitive information detected \((.+)\); masking is recommended$/, '检测到疑似敏感信息（$1），建议脱敏'],
    [/^For form fields, drop the self-introduction opener and state the key points directly$/, '表单场景建议去掉自我介绍式开头，直接给结论'],
    [/^Page field "(.+)" is semantically similar to profile field "(.+)"; several wordings are offered$/, '页面字段「$1」与档案字段「$2」语义相近，已给出多个措辞'],
    [/^No direct match for "(.+)" in the profile; content auto-generated from profile facts \(experience\/skills\/achievements\)$/, '档案中未找到「$1」的对应字段，已依据档案事实（经历/技能/成果）自动生成'],
    [/^Unnamed field$/, '未命名字段'],
  ];

  /** Translate a runtime engine message for display (returns the input when no rule matches). */
  function translateDynamic(text, lang) {
    const s = String(text == null ? '' : text);
    if (lang !== 'zh' || !s) return s;
    for (const [re, repl] of DYNAMIC_RULES) {
      if (re.test(s)) return s.replace(re, repl);
    }
    return s;
  }

  function resolveLang(pref) {
    if (pref === 'zh' || pref === 'en') return pref;
    const nav = (typeof navigator !== 'undefined' && navigator.language) || 'en';
    return nav.toLowerCase().startsWith('zh') ? 'zh' : 'en';
  }

  /** Create a translator for a language ('en'|'zh'|'auto'). */
  function create(pref) {
    const lang = resolveLang(pref);
    const t = (key, params) => {
      const entry = MESSAGES[key];
      let s;
      if (entry) {
        s = entry[lang === 'zh' ? 1 : 0];
      } else {
        // never surface a raw catalog key: fall back to a readable segment ("chip.fill" -> "Fill")
        const seg = String(key).split('.').pop() || String(key);
        s = seg.charAt(0).toUpperCase() + seg.slice(1);
      }
      if (params) {
        s = s.replace(/\{(\w+)\}/g, (m, name) => (params[name] != null ? String(params[name]) : m));
      }
      return s;
    };
    /** Swap static UI texts under root (EN <-> ZH). Only exact catalog matches are touched. */
    const applyDom = (rootEl) => {
      if (!rootEl || !rootEl.querySelectorAll) return 0;
      let changed = 0;
      try {
        for (const el of rootEl.querySelectorAll('*')) {
          // NEVER rewrite an element that contains interactive controls — it would destroy them
          // (e.g. <label><input type="checkbox">Floating ball</label>)
          if (el.querySelector && el.querySelector('input, select, textarea, button, a, [role="button"], [contenteditable="true"]')) continue;
          // Normalized full text: works for leaf nodes and for nodes whose markup can be collapsed
          const text = String(el.textContent || '').replace(/\s+/g, ' ').trim();
          if (!text || text.length > 260) continue;
          if (lang === 'zh' && DOM_STRINGS[text]) {
            el.textContent = DOM_STRINGS[text];
            changed++;
          } else if (lang === 'en') {
            // restore: map zh back to en
            const en = Object.keys(DOM_STRINGS).find((enKey) => DOM_STRINGS[enKey] === text);
            if (en) {
              el.textContent = en;
              changed++;
            }
          }
        }
      } catch (e) {
        /* defensive: never break the host page */
      }
      return changed;
    };
    return { lang, t, applyDom, dyn: (text) => translateDynamic(text, lang) };
  }

  core.i18n = { MESSAGES, DOM_STRINGS, DYNAMIC_RULES, resolveLang, create, translateDynamic };
})(typeof globalThis !== 'undefined' ? globalThis : this);