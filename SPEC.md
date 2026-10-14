# CV Plugin —— 浏览器简历投递辅助插件 实现规格说明书（SPEC）

版本：v1.0（实现基准）
形态：Chrome / Edge 浏览器扩展（Manifest V3，纯 JS 实现，零构建依赖、零第三方运行时依赖）
代码位置：仓库根目录（`extension/` 为可直接装载的扩展）

---

## 1. 目标与需求映射

| # | 需求（用户原话摘要） | 对应能力 | 实现模块 |
|---|---|---|---|
| 1 | 给出简历常见关键字段和内容供用户填写，长期留存、可持续更新 | 简历档案（Profile）：内置 40+ 常见中英字段模板，分类编辑、按字段记录更新时间、支持自定义字段、JSON 导入导出、从已填页面回读学习；**多套简历（按公司/场景切换，导入可合并或独立成套）**；**PDF/图片简历导入识别（已有/同类字段映射，未知字段新建）** | `core/schema.js`、`core/store.js`、`core/pdf.js`、`core/resume-parse.js`、`ui/options.*` |
| 2 | 在线填写简历时，自动识别相同语义字段，自动填充 | 语义字段识别 + 自动填充：扫描页面表单 → 抽取字段描述信号 → 与档案字段做语义匹配 → 高置信度自动填充，低置信度列入待确认 | `core/matcher.js`、`core/fill.js`、`content/content.js` |
| 3 | 对填写完成的简历，自动总结提炼未见字段内容补充、相似字段表达、优化已有内容 | **样例学习（核心）**：扫描**已填写完成**的投递页面，把用户手写内容当样例——未见字段→学习建档/内容总结补充；相似字段→识别归并（记为别名）；内容更优→改进档案；全部手写回答→存为样例，供后续生成复用与匹配改进（越用越准） | `core/optimizer.js`、`content.js#doStudy`、`core/store.js#learning` |
| 4 | 先写可实现的 spec + 推荐实现方法 | 本文档 | `SPEC.md` |
| 5 | 工作区编码实现，测试验证通过才交付，问题持续修正 | 单元测试（node:test）+ 端到端测试（真 Chrome + CDP 驱动） | `test/` |
| 6 | 本机浏览器真实部署测试 | 以 unpacked 扩展装载进本机 Chrome，真实页面全流程验证，输出截图与报告 | `test/e2e/`、`docs/DEPLOY_TEST_REPORT.md` |

非目标（本期不做）：简历 PDF/Word 解析导入、多份简历版本管理、自动点击"提交"按钮（避免误投递，只填不投）、跨设备云同步。

---

## 2. 推荐实现方案（及备选对比）

### 2.1 方案选型

| 方案 | 说明 | 结论 |
|---|---|---|
| **A. Chrome/Edge MV3 扩展（选用）** | content script 注入目标招聘页做扫描/填充；popup/options 管理档案；chrome.storage.local 长期留存 | ✅ 需求 2"在线填写时自动填充"只有内容脚本方案能满足；需求 6"本机浏览器真实部署"直接对应装载扩展 |
| B. 纯 Web 应用 + 手动复制粘贴 | 无法触达第三方页面表单 | ❌ 不满足需求 2 |
| C. 油猴脚本（Tampermonkey） | 依赖用户另装管理器，权限与分发弱 | ❌ 体验差、不可控 |
| D. Puppeteer/RPA 桌面机器人 | 需常驻进程、脱离用户浏览器、易被站点风控 | ❌ 过重 |

### 2.2 关键技术决策

1. **零依赖纯 JS**：核心逻辑为普通脚本文件（IIFE 挂到 `globalThis.CVCore`），同一份文件可同时被扩展（classic script）与 Node 测试（ESM import）加载。不需要打包器，交付即可用、可测。
2. **语义匹配不用"重型 NLP/向量模型"，而用"多信号加权打分 + 同义词典"**：
   - 确定性、可离线、可单测、毫秒级；
   - 词典覆盖中英简历域高频同义（姓名/name/full name/your name…），并支持 autocomplete 属性、input type、占位符、aria-label、邻近文本、select 选项等多路信号；
   - LLM 仅作为**可选增强**（低置信度兜底 + 文案生成），不阻塞主流程。
3. **填充引擎做框架兼容**：用原生 setter 写值后派发 `input`/`change` 事件，兼容 React/Vue 受控组件；select/radio/checkbox/textarea/contenteditable/date/number 全覆盖。
4. **隐私设计**：全部数据留在本机 `chrome.storage.local`；权限最小化说明见 §8；敏感字段（身份证号）标注，导出时可选脱敏；LLM 增强默认关闭，开启时只发送当前页面字段问答所需的最小上下文。
5. **不做自动提交**：只填充与建议，提交按钮永远留给用户。

---

## 3. 系统架构

```
┌────────────────────────────── 浏览器扩展 ──────────────────────────────┐
│                                                                       │
│  ui/popup.* ──快捷操作────┐                                           │
│  ui/options.* ──档案管理──┤                                           │
│                            ▼                                          │
│                 background/service-worker.js                          │
│                  （消息路由 / 存储读写 / 设置）                          │
│                            ▲ chrome.runtime 消息                      │
│                            │                                          │
│  content/content.js（注入招聘页）                                      │
│   ├─ 扫描 scan：抽取页面字段描述（descriptor）                          │
│   ├─ 匹配 matcher：descriptor ↔ 档案字段 语义打分                       │
│   ├─ 填充 fill：高置信度自动填 + 框架安全事件                            │
│   ├─ 体检 optimizer：未见字段生成 / 相似表达 / 内容优化                   │
│   └─ 浮动面板：填充、体检、学习、逐项采纳                                │
│                                                                       │
│  core/：schema（字段模板）· store（持久化）· lexicon（同义词典）          │
│         matcher（打分）· fill（DOM 填充）· optimizer（建议生成）· llm    │
└───────────────────────────────────────────────────────────────────────┘
        存储：chrome.storage.local（profile / settings / logs）
        可选 LLM：OpenAI 兼容 chat/completions（用户自配 baseUrl/key/model）
```

模块依赖方向：`content/ui → core`；`core` 内部 `matcher → lexicon`、`optimizer → schema/lexicon`；`core` 不依赖 chrome API（存储通过注入的 adapter），保证 Node 可测。

---

## 4. 数据模型

### 4.1 档案 Profile

```jsonc
{
  "version": 1,
  "updatedAt": "2026-09-27T00:00:00.000Z",
  "fields": {
    "fullName": { "value": "张三", "updatedAt": "..." },
    "phone":    { "value": "13800000000", "updatedAt": "..." }
    // ……键为 schema 中的 canonical field key；自定义字段键以 custom: 开头
  },
  "customFields": [
    { "key": "custom:awards", "label": "获奖经历", "category": "other", "value": "...", "updatedAt": "..." }
  ],
  "learning": {                       // 样例学习（需求 3）
    "aliases": { "fullName": ["怎么称呼你"] },   // 从样例页面学到的 页面标签→档案字段 别名
    "samples": [                               // 用户手写样例（生成参考）
      { "label": "为什么想加入我们公司", "intent": "reason", "content": "...", "source": "https://...", "learnedAt": "..." }
    ]
  }
}
```

多套简历索引（`cvProfileIndex`；非激活套数据存 `cvProfile:<id>`，激活套数据始终在 `cvProfile`）：

```jsonc
{
  "version": 1,
  "activeId": "p1a2b3",
  "profiles": [
    { "id": "default", "name": "默认简历", "updatedAt": "..." },
    { "id": "p1a2b3", "name": "投递公司A", "updatedAt": "..." }
  ]
}
```

### 4.2 字段模板（schema.js 内置，30+ 项）

每个字段：`{ key, labelZh, labelEn, category, type, sensitive?, enumOptions?, aliases: [...], autocomplete? }`
分类：`basic` 基本信息 / `contact` 联系方式 / `education` 教育经历 / `work` 工作经历 / `intention` 求职期望 / `about` 自我介绍 / `other` 其他。

内置字段（节选）：姓名、手机、邮箱、性别、出生日期、身份证号、现居城市、通讯地址、邮编、政治面貌、婚姻状况、最高学历、学位、毕业院校、专业、毕业时间、工作年限、当前公司、当前职位、当前薪资、工作经历、项目经历、技能特长、语言能力、证书、自我评价、个人优势、兴趣爱好、期望职位、期望城市、期望薪资、到岗时间、工作性质、求职原因。

### 4.3 页面字段描述 Descriptor（扫描产物）

```jsonc
{
  "id": "idx-13",
  "kind": "input|textarea|select|radio-group|checkbox-group|contenteditable",
  "inputType": "text|tel|email|date|number|radio|...",
  "signals": {
    "label": "你的姓名", "name": "username", "id": "user_name",
    "placeholder": "请输入真实姓名", "ariaLabel": "", "autocomplete": "name",
    "nearby": "基本信息 你的姓名 *", "options": [], "maxLength": 20
  },
  "required": true, "filled": false, "value": ""
}
```

### 4.4 匹配结果 / 体检报告

```jsonc
// match: { descriptorId, fieldKey, score, confidence: "auto|review|none", reasons: [...] }
// review: {
//   matches: [...],
//   unmatched: [{ descriptorId, label, kind }],
//   suggestions: [{
//     descriptorId, label, type: "generate|similar|optimize",
//     content: "生成/建议文本", rationale: "依据", applyable: true
//   }],
//   stats: { total, autoFilled, needReview, unmatched, optimized }
// }
```

---

## 5. 语义匹配算法（核心）

对每个 Descriptor 与每个候选档案字段计算 `score = Σ 权重 × 信号分`，并做冲突惩罚：

| 信号 | 权重 | 判定 |
|---|---|---|
| 别名词典命中（label/placeholder/name 等归一化文本） | 48（完全等于别名）/ 28（包含别名且别名长度≥2）/ 24（别名包含信号，要求信号是"词"：中文≥2字、拉丁≥4字符） | 中文按字符 n-gram、英文按词干归一；同义词典含中英互译与口语变体 |
| autocomplete 属性映射 | 30 | `name→fullName`、`tel→phone`、`email→email`、`postal-code→zip`、`street-address→address`、`bday→birthDate`… |
| input type / 形态兼容 | 12 | `type=email↔email`、`tel↔phone`、`date↔birthDate/graduationDate`、`number↔workYears/salary`、`select/radio↔enum 字段` |
| 选项文本匹配（select/radio） | 10 | 选项集合与字段 enumOptions 语义吻合（如 本科/硕士 ↔ education） |
| 邻近文本/容器文本弱信号 | 8 | 上方标题、legend、单元格文本 |
| 冲突惩罚 | −18 | 出现互斥别名（如 "公司电话" 之于 personal phone；"最高学历" 之于 "毕业院校"） |

规则：
- 阈值 `auto ≥ 45` 自动填充；`30 ≤ score < 45` 标记待确认（面板一键采纳）；`< 30` 视为"未见字段"。
- 唯一性保护：同页面同一 canonical 字段被多个 descriptor 命中时，最高分者自动填充，其余降为 review。
- 歧义保护：top1 与 top2 分差 < 6 且都 ≥30 时降级为 review。
- enum 填充值解析：`"本科" ↔ "bachelor"`、`"全职" ↔ "fullTime"`、`"男/男性/男士" ↔ "male"` 等由词典解决；select 优先匹配 option 的 text/value。

## 6. 体检与内容优化（需求 3）

输入：页面 Descriptor 列表 + 匹配结果 + 档案全文（工作经历/项目/技能等长文本）。

1. **未见字段内容生成（generate）**：按字段意图分类（求职原因 / 个人优势 / 自我评价 / 期望理由 / 加班意愿 / 到岗说明 / 开放问题…），用"抽取式摘要 + 模板槽位"生成：
   - 从档案长文本抽取：工龄、技能关键词 Top N、最近公司/职位、量化结果（正则抓数字+%）、教育亮点；
   - 模板按意图组合成 60–200 字中文（或英文页面生成英文），并在报告中注明依据（rationale）。
   - LLM 开启时先调 LLM，失败/超时回退模板（保证确定性可测）。
2. **相似字段表达建议（similar）**：页面字段与档案字段语义相近但侧重点不同（如"个人优势" vs "自我评价"），给出 2–3 种表达改写（精简版/关键词版/STAR 版），并说明差异。
3. **已有内容优化（optimize）**：对已填值做规则体检——超长截断建议（对照 maxlength）、量化缺失提示、关键词覆盖（提取 JD/页面职位描述关键词，比对已填内容，提示补充缺失关键词）、称谓与时态清理（去第一人称、口语）、敏感信息提示。
4. 报告可逐项"采纳"写回页面输入框（复用 fill 引擎）或"存入档案"（写回 profile）。

### 6.5 样例学习闭环（需求 3 核心工作流）

入口：浮动面板 / Popup 的「样例学习」（`study` 动作）。输入：**已填写完成**的投递页面（用户手写内容 = 样例）。

1. **扫描已填内容**：读取每个已填字段的语义值（select/单选/复选取选项文本，枚举归一为档案规范值）。
2. **相似字段 → 识别归并**：命中的页面标签记为该档案字段的别名（`learning.aliases`）；页面内容比档案更丰富（档案为空 / 页面是超集）→ 直接改进档案；内容冲突 → 面板逐项确认（"用页面内容更新档案"）。
3. **未见字段 → 学习建档**：先按意图归并到语义相近的档案字段（求职原因/个人优势/自我评价…，同时记为别名）；无法归并 → 新建**自定义字段**（自动参与后续匹配）。
4. **样例积累**：全部手写回答存入 `learning.samples`（label / intent / content / source），随档案导出导入。
5. **改进生效（越用越准）**：
   - 匹配改进：学习到的别名进入匹配词典 —— 陌生标签第二次出现即可自动填（闭环验证：「怎么称呼你」学习后在新页面自动填出姓名）；
   - 生成改进：未见字段内容生成优先**复用手写样例**（`fromSample`，标注来源页面）＞ 相似字段多表达 ＞ 档案模板；开启 LLM 时按当前公司/岗位改写样例、保留你的风格与事实。

选项页提供学习记录查看（别名 / 样例）与一键清空。

### 6.6 简历导入（PDF/图片）与 VLM 校对

**PDF 导入（离线零依赖）**：`core/pdf.js` 直接解析 PDF 字节——扫描流对象 → FlateDecode 解压（DecompressionStream）→ 解析 ToUnicode CMap（bfchar/bfrange，中文 CID 字体）→ 抽取文本算子（Tj/TJ/转义）。`core/resume-parse.js` 把文本分节解析：同行「标签：内容」对与成段节内容 → 语义匹配到档案字段（复用 matcher，同类字段自动映射，如 University→毕业院校）；无法映射的成段内容 → **新建自定义字段**（不丢信息）；头部自动识别姓名/手机/邮箱/生日。识别结果先**预览**，再按导入方式「合并到当前」或「新建为独立简历套」（多套简历）。

**VLM 校对（可选，OpenAI 兼容多模态接口）**：
1. 导入 PDF 后：`llm.reviewResumeParse` 用 VLM 校对启发式解析（纠正张冠李戴/补漏），失败回退本地结果；
2. 导入图片/扫描版简历：`llm.parseResumeImage` 直接从截图识别字段（无文本层 PDF 的替代通道）；
3. 样例学习时：`llm.describeFilledPage` 读取当前页面截图，补充 DOM 遗漏的已填字段、纠正内容后再进入学习（样例更准）。截图经后台 `captureVisibleTab` 获取；失败自动跳过（学习照常）。

## 7. UI/UX

- **浮动面板（content script）**：右下角按钮 `CV 助手`；展开后 3 个动作：`一键填充`、`简历体检`、`从本页学习`；结果列表逐项显示 匹配分数/置信度/建议内容 + 单项采纳按钮。
- **Popup**：当前站点匹配摘要、快捷按钮（填充/体检/打开设置）、存储状态。
- **Options（选项页 = 完整档案管理）**：分类表单编辑全部字段、自定义字段增删、导入/导出 JSON、匹配阈值与自动填充开关、站点白名单/黑名单、LLM 配置（baseUrl/apiKey/model，可选）。
- 全部界面中文，字段标签中英并列。

## 8. 权限与隐私

| 权限 | 用途 |
|---|---|
| `storage` | 档案与设置本地留存 |
| `sidePanel`（可选，无则忽略） | 侧栏打开档案 |
| `host_permissions: <all_urls>` | content script 注入任意招聘站点（这是需求 2 的必要条件） |
| 不申请 `tabs`/`scripting`/`downloads` 等非必要权限 | 减小攻击面 |

数据不出本机；LLM 功能默认关闭；导出可对 `idNumber` 等敏感字段脱敏。

## 9. 测试与验收标准

### 9.1 单元测试（`npm test`，node:test，无外部依赖）
- store：写入/读取/合并/自定义字段/导入导出/更新时间/损坏数据自愈；**样例学习记录（别名/样例）增删查、去重、导入导出保留**；**多套简历（新建/克隆/切换/重命名/删除回落/导入为独立套/按套导出）**；
- matcher：中英别名、autocomplete、type、选项、歧义降级、唯一性、冲突惩罚、阈值边界；**学习到的别名让陌生标签后续自动命中**；
- fill 的纯逻辑部分：值解析（日期/数字/enum/超长截断）、枚举规范值回写；
- optimizer：未见字段生成非空且含档案关键词、相似表达 2–3 条、优化建议命中规则（超长/缺量化/缺关键词/敏感信息）、**手写样例优先复用（fromSample）**。

### 9.2 端到端测试（`npm run test:e2e`，真 Chrome + CDP，零第三方依赖）
- 以真实部署通道装载 unpacked 扩展（Chrome 137+ 等价「加载已解压的扩展程序」）；
- 起本地 HTTP 服务托管 5 张仿真招聘申请页：中文综合表单、英文表单、预填+开放问题表单、**已填写完成的样例页**、**学习后的新申请页**；
- 断言：① 扫描到的字段数达标；② 自动填充后 DOM 输入值与档案一致（含 select/radio/checkbox/date/textarea）；③ 体检报告含 generate/similar/optimize 三类建议且内容非空；④ Options 页编辑档案 → 刷新后仍在（长期留存）；⑤ 从本页学习回写档案成功；⑥ 页面对 React 式受控输入派发事件（监听 input 事件计数）；⑦ **样例学习：相似归并/别名学习/自定义字段建档/样例积累/档案改进**；⑧ **学习闭环：新页面陌生标签自动填、手写样例被生成复用（fromSample）**；⑨ **多套简历：新建独立套/切换/重命名/删除回落，Popup 显示当前套**。

### 9.3 真实部署测试（需求 6）
- headful 启动本机 Chrome 装载扩展，全流程跑一遍并截图（`test/artifacts/*.png`）；
- 输出 `docs/DEPLOY_TEST_REPORT.md`：环境、步骤、每条验收点 PASS/FAIL、截图引用、已知限制。

**交付门槛：9.1 + 9.2 全绿，9.3 有截图证据；任何失败持续修复直到通过。**

## 10. 风险与对策

| 风险 | 对策 |
|---|---|
| 站点表单结构千差万别（无 label、iframe、动态渲染） | 多信号打分 + 低置信度进 review 不误填；`all_frames: true`；MutationObserver 重扫 |
| 受控组件吃掉原生赋值 | 原生 setter + input/change 双事件；对 React 生产版兜底（textContent + 模拟输入） |
| 语义误匹配导致填错 | 歧义降级 + 唯一性保护 + 面板逐项确认 + 不自动提交 |
| 站点 CSP/反自动化 | content script 运行在隔离世界不依赖页面脚本；失败降级为"建议内容可复制" |
| LLM 不可用 | 模板兜底，主流程离线可用 |

## 11. 目录结构与交付物

```
CV_plugin/
├── SPEC.md                     # 本文档
├── README.md                   # 安装/使用/测试说明
├── package.json                # scripts: test / test:e2e / test:all / icons
├── extension/                  # 可直接 "加载已解压的扩展程序" 的成品
│   ├── manifest.json
│   ├── icons/
│   ├── src/core/{util,lexicon,schema,store,matcher,fill,optimizer,llm}.js
│   ├── src/content/content.js
│   ├── src/background/service-worker.js
│   └── ui/{popup.html,popup.js,options.html,options.js,styles.css}
├── test/
│   ├── unit/*.test.mjs
│   ├── e2e/{run-e2e.mjs,cdp.mjs,server.mjs,fixtures/*.html}
│   └── artifacts/              # 截图、e2e 报告
└── docs/DEPLOY_TEST_REPORT.md  # 真实部署测试报告
```

## 12. 里程碑

M1 SPEC（本文档）→ M2 核心逻辑 + 单测全绿 → M3 扩展 UI/内容脚本 + E2E 全绿 → M4 本机真实部署测试 + 报告 → M5 文档与可用版本交付。
