# 完整实现方案：表格型网申页增强 + 低置信度批量确认面板 + 降幻觉

状态：设计定稿（可直接进入开发）
兼容性总原则：**只增不改**——新模块 + 现有钩子点扩展；descriptor / matchResult / 报告结构只增字段不删改；回归门禁 = 现有单测 118 项 + E2E 96 项必须保持全绿；零新增 npm 依赖。

---

## 〇、与现有基础的冲突检查（先答"不冲突"）

| 现有模块 | 接口（现状） | 本方案触点 | 冲突分析 |
|---|---|---|---|
| `core/matcher.js` | `decideMatches(descriptors, ctx)` → {decisions[{descriptorId,desc,fieldKey,score,confidence,reasons,candidates}], unmatched} | ① `SIGNAL_WEIGHTS` 增 `cellLabel: 0.95`；② 可选读 `ctx.learning.ignored` 施加 -30 惩罚 | 只增信号/可选惩罚；旧信号权重、阈值（auto45/review30）、唯一性/歧义保护不动 → 旧断言（含分数比较）全部成立 |
| `src/content/content.js` | `scan()` → descriptors；`labelText(el)` 标签链 | label 解析前置"表格上下文"分支（未命中表格**原样回退**原链路） | 非表格页面行为逐字节不变 |
| `core/fill.js` | `fillMany/fillDescriptor` 签名不变 | 不改 | 批量面板只是"批量产出 decisions"再走 fillMany |
| `core/optimizer.js` | `analyze()`；已有 `sanitizeGenerated` | 采纳 LLM 输出前嵌入事实校验（ctx 无 llm 时路径等同旧版） | 纯内嵌护栏 |
| `core/llm.js` | 3 个结构化方法 + `filterVlmItems` | 只增 `askField` 与一致性比对 | 纯新增 |
| `core/store.js` | `learning: {aliases, samples}` | 增 `learning.ignored: {}`（normalizeProfile 自愈补空） | 旧数据/旧备份恢复不丢；导出格式向前兼容 |
| 报告/UI | renderPanel 各分支 | fill 报告增 `batch` 组；导入预览增"模型改动"标注 | 只增渲染分组 |
| manifest | content_scripts 列表 | 增 2 个 core 文件 | 纯新增 |

---

## 一、表格型网申页增强（51job / 北森布局）

### 1.1 现状与差距
现有 `labelText(el)` 链：`label[for]` → `closest('label')` → `aria-labelledby` → `aria-label` → **同行前一单元格**（td/th）→ 前置兄弟短文本。对表格布局只有"前一个单元格"这一雏形。51job/北森布局的真实特征：
- **一行多组**：`<tr><td>姓名</td><td><input></td><td>手机</td><td><input></td></tr>`（现有"前一单元格"可应付单组，但多组时噪声文本/提示单元格会插队）
- **分组行/表头**：`<td colspan=4>基本信息</td>`
- **标签噪声**：`姓名 *`、`请填写身份证号码`、`（元/月）` 与标签混排
- **同格混排**：标签+控件+错误红字在同一 td
- **嵌套 table**、rowspan/colspan 不规则网格、div 模拟表格（display:table / role=grid）

### 1.2 技术路径
**新增 `core/table-layout.js`（纯逻辑，可单测）**：
```
buildCellGrid(tableEl)          → cells[{row,col,rowSpan,colSpan,text,el,controls[]}]（rowspan/colspan 占位展开）
pairLabelsAndControls(grid)     → Map<controlEl, {label, confidence, source}>
   标签取值优先级：① 同行左侧最近"纯标签格"（无控件、短文本）
                 ② 同列上方最近标签格（含 rowspan 表头）
                 ③ 同行右侧（倒序布局）④ 同格内 <label> 元素 ⑤ 行首 row header
cleanLabelText(t)               → 去 *、去冒号、去括号提示、去单位后缀，保留语义词
contextOf(el)                   → el.closest('table') 或 [role=grid] / display:table 容器；非表格返回 null
```
**content.js 集成**：`scan()` 内构造 signals 时——`tableCtx = tableLayout.contextOf(el)`；命中则 `signals.cellLabel = 配对标签`（原有 label 链结果保留在 `signals.label`）。**matcher** 对 `cellLabel` 与 `label` 同权打分（cellLabel 权重 0.95，label 优先仲裁：label[for] 明确关联时 cellLabel 降为 nearby）。

### 1.3 修改点清单
| 文件 | 改动 | 性质 |
|---|---|---|
| `core/table-layout.js` | 新增（~200 行） | 纯新增 |
| `src/content/content.js` | scan/signals 增 cellLabel；labelText 保持 | 增分支，未命中回退 |
| `core/matcher.js` | `SIGNAL_WEIGHTS` 增 cellLabel | 只增 |
| `manifest.json` | content_scripts 增 table-layout.js | 只增 |

### 1.4 实现难点
1. **rowspan/colspan 网格展开**（标准表格占位算法）；嵌套 table 取最近层隔离父表干扰。
2. **一行多组就近配对**：必须"水平最近标签格"，防止错位（张冠李戴是本功能最大风险，E2E 重点断言）。
3. **噪声清洗的度**：保留"最高学历"这类语义词，去掉"（请填写）/单位/星号"；错字容错（全角空格、换行）。
4. **div 模拟表格**的单元格边界：`display:table-cell` / `role=gridcell` / 直接子元素网格 三种识别。
5. **与 label[for] 仲裁**：显式关联优先于推断，防双标签打架。

### 1.5 边界
- 一格多控件（年/月/日 三输入、省市区级联）→ 共用标签 + name 后缀区分；radio/checkbox 组沿用现有分组逻辑（组内取组标签）。
- 纯展示表格（无控件）→ 不产出 descriptor（现状一致）。
- iframe 内表格：`all_frames` 已开，自然支持。
- 超大表格：新增 descriptor 总量上限 1000（防冻结）。
- 错误红字/占位提示（`class=error`、aria-invalid 邻接文本）→ 不作标签候选。

### 1.6 异常
- 非法嵌套/残缺标签 → 配对失败逐项回退原 label 链 → 最终 unmatched（进批量确认面板，不静默丢）。
- 扫描中 SPA 重绘（节点失联）→ 沿用 `isConnected` 与填充前复检；填充失败已有 ok:false 回报。
- `getComputedStyle` 不可用（极老内核）→ contextOf 保守返回 null。

### 1.7 测试验证
- **单测** `test/unit/table-layout.test.mjs`（≥15 例）：网格展开（含 rowspan/colspan）、一行多组就近配对、噪声清洗、嵌套隔离、div 模拟表格、无标签回退。
- **语料**：`real-web-labels.json` 增 `table` 源（51job/北森典型布局标签 + 期望映射），`real-web.test.mjs` 保持 100% 门槛。
- **E2E** 新 fixture `table-form.html`（51job 式一行多组 + 北森式分组行 + colspan 表头 + 噪声标签）：断言 20+ 字段填充正确且**相邻字段不错位**（姓名≠手机、学历≠学校）、复选/单选组正确、超大表格 1000 上限生效。
- **回归门禁**：118+96 全绿。

---

## 二、低置信度批量确认面板

### 2.1 现状与差距
`decideMatches` 已产出 `confidence: review` + `reasons` + `candidates`（top3）；现状 review 项散在面板中逐条"采纳填入"，没有：批量勾选、候选改派、跨页记忆（拒绝不再建议）、popup 入口。

### 2.2 技术路径
**新增 `core/confirm-batch.js`（纯逻辑）**：
```
buildBatch(decisions, values, ctx) → items[{
   descriptorId, label, pageValue, suggestedField, suggestedValue,
   candidates[3], reason, duplicateOf?（同字段重复标注）}]
applyBatch(items, {accepted: Map<descriptorId, fieldKey|null>}) → {
   fillDecisions（转 auto 后走 fillMany）,
   learnOps: [{addAlias} | {ignore: {label, fieldKey}}]   // 接受→别名学习；拒绝→ignored
}
```
**UI（renderPanel 'fill' 分支扩展）**：新增"待确认 (N)"分组——每项：页面标签 → 建议字段（下拉换 top3/自定义）＋页面值/档案值对照＋勾选框；顶部"全选/全不选"；底部`应用 N 项`（逐项结果回报，失败项可重试）。
**跨页记忆**：`profile.learning.ignored = {fieldKey: [label,...]}`；matcher 命中 ignored 施 -30 惩罚（自然落出 review/auto 档）；选项页"已忽略建议"管理 + 一键恢复。
**popup**：显示待确认计数，点击唤起页面面板。

### 2.3 修改点清单
| 文件 | 改动 | 性质 |
|---|---|---|
| `core/confirm-batch.js` | 新增（~150 行） | 纯新增 |
| `core/store.js` | learning 增 ignored + `addIgnored/restoreIgnored` | 只增（normalize 自愈） |
| `core/matcher.js` | ignored 惩罚（可选读取） | 可选路径 |
| `src/content/content.js` | renderPanel 批量分组 + `applyBatch` 动作 | 只增分支 |
| `ui/popup.*`、`ui/options.*` | 计数入口 / 已忽略管理 | 只增 |

### 2.4 实现难点
1. **候选改派联动**：改派字段后建议值预览重算（如改派到 enum 字段显示将选中的 option）。
2. **批量应用的原子性语义**：逐项独立应用（部分失败不回滚已成项），结果表标注成功/失败/跳过。
3. **ignored 泛化粒度**：label 粒度（"怎么称呼你"忽略即全局忽略）；站点粒度统计留给后续报表，避免过度设计。
4. **面板性能**：≥50 项分页（50/页）；DOM 渲染复用 esc() 转义（安全不变）。

### 2.5 边界
- 页面值为空的 review 项 → 建议值取档案值；档案也空 → 提示"新建字段"选项（走自定义字段）。
- 单选/复选组：预览"将勾选的选项"（复用 fill.pickOption）。
- 同字段重复输入（唯一性保护降级而来）→ 标注 `duplicateOf`，默认不勾选。
- 改派到"忽略此项"= 本次不填 + 可选不再建议。

### 2.6 异常
- 应用中元素失联/重绘 → fillDescriptor 现有失败回报 → 面板红标可重试（不动已成项）。
- 面板开着页面跳转 → 状态自然销毁（可接受）；回来重开重算。
- ignored 误伤 → 选项页恢复入口（防"拉黑后无法救回"）。

### 2.7 测试验证
- **单测** `test/unit/confirm-batch.test.mjs`（≥10 例）：buildBatch 结构与排序、候选改派、部分失败回报、ignored 生效/恢复、重复字段标注。
- **E2E**：在 cn-form 引入 3 个模糊标签（制造 review 档）→ 批量面板勾 2 忽略 1 → 断言 2 项 DOM 填充、1 项重扫后建议消失（ignored 生效）、popup 计数联动、恢复入口能找回。
- **回归门禁**：118+96 全绿。

---

## 三、降幻觉（三层防线）

### 3.1 现状与差距
已有：`sanitizeGenerated`（拒答/推脱/超短/超长拦截）、`extractJson` 三重容错、`filterVlmItems` 页面锚定。缺口：① **事实编造**（模型写"10 年经验/曾任职 Google"等档案没有的硬事实）；② VLM 整体读取一次到位、幻觉风险集中；③ `reviewResumeParse` 的修正**静默覆盖**本地解析。

### 3.2 技术路径
**第 1 层：事实一致性校验（新增 `core/fact-check.js`，纯函数）**
```
extractClaims(text) → 数字/百分比/金额/年限/学校/公司/职位（正则 + 档案实体词表）
verifyClaims(claims, profileValues, pageText) → violations[]
```
optimizer 采纳 LLM 输出前先校验：命中"档案与页面皆无来源"的硬事实 → **剥离该句**；剥离后 <10 字 → 整段回退模板/样例（复用 sanitizeGenerated 阈值语义）。基准原则：**用户档案优先**——只防模型新增编造，不质疑用户数据。

**第 2 层：VLM 逐字段问答（`llm.askField({image, label, knownValue})`）**
- `describeFilledPage` 保留为粗读；对其新发现的字段（vlmExtra 候选）逐个追问（"截图中『X』填的是什么？只答内容"），**双通道一致才入库**（归一化比对，复用 `util.normalizeText`）；不一致 → 丢弃该项。
- 成本/时延控制：每次 ≤5 问、8s 超时、失败逐项降级回粗读值；受现有 `vlmStudy` 开关控制。

**第 3 层：修正保守采纳**
- `reviewResumeParse` 结果与本地解析逐字段 diff → 导入预览中"模型改动"字段高亮标注（改了什么、两边原值），默认需人工确认后并入（不再静默覆盖）。

### 3.3 修改点清单
| 文件 | 改动 | 性质 |
|---|---|---|
| `core/fact-check.js` | 新增（~120 行） | 纯新增 |
| `core/optimizer.js` | 采纳点内嵌 verifyClaims（剥离违规句） | 护栏内嵌 |
| `core/llm.js` | `askField` + `agrees()` 一致性比对 | 纯新增 |
| `src/content/content.js` | vlmExtra 追问 + 双通道一致 | 仅 vlmStudy 路径 |
| `ui/options.js` | 导入预览"模型改动"标注 | 只增 UI |

### 3.4 实现难点
1. claim 抽取准确率（中文实体边界）→ 首版只管"硬事实"（数字/百分比/年限/学校/公司/职位词面），保守取向降误杀。
2. **误杀/漏检平衡**：只剥离违规句不整段丢；"五年↔5 年"数字归一后比对。
3. 逐字段问答时延（≤5×8s 串行）与 API 成本；失败降级不阻塞学习主流程。
4. 一致性模糊匹配（"张三" vs "张 伟"）→ normalizeText 归一。

### 3.5 边界
- 档案自身含错（用户填错数字）→ 以档案为基准（不越权纠正用户）。
- 页面 JD 里的数字（"3 年以上"）→ 计入 pageText 来源（生成 JD 相关回答时合法）。
- 模型正确改写（合并句子/换表达）→ 不受影响（只查硬事实）。

### 3.6 异常
- fact-check 自身抛错 → try/catch **回退"不剥离"**（宁可多留不可误删）。
- askField 全部超时 → 保持粗读值（filterVlmItems 兜底仍在）。
- response_format/接口不兼容 → 现有 400 自动去参重试链路不变。

### 3.7 测试验证
- **单测** `test/unit/fact-check.test.mjs`（≥8 例）：编造数字/公司被剥离、档案事实保留、"五年↔5 年"不误杀、异常回退。
- **模型对抗测试扩展**（model-sim，我继续扮演模型）：输出含编造"我曾在 Google 工作 10 年"→ 采纳结果不含该句；VLM 双通道不一致 → 丢弃；导入修正带 diff 标注。
- **E2E**：走本地降级路径（无 LLM）全链路不回归；带 mock 的双通道一致/不一致行为由单测覆盖。
- **回归门禁**：118+96 全绿。

---

## 四、实施顺序、规模与验收门禁

| 里程碑 | 内容 | 新增用例 | 门禁 |
|---|---|---|---|
| M1 | table-layout + content/matcher 集成 + fixture | 单测 +15、语料 +10、E2E +1 | 118+96 全绿 + 新用例全绿 |
| M2 | confirm-batch + 面板/popup/ignored | 单测 +10、E2E +1 | 同上 |
| M3 | fact-check + askField + 修正标注 | 单测 +8、对抗 +3 | 同上 |

预估总量：新增代码 ~700 行、单测 +33、E2E +2 个章节；零新增依赖；默认开关——表格增强/批量确认默认开（纯增益），逐字段问答跟随 `vlmStudy`。每步合并前跑 `npm run test:all`，全绿才进下一步（沿用本项目"测试不过不交付"的既定纪律）。
