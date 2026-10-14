/* Unit tests: resume text parsing → profile fields (incl. creating unknown fields) */
import test from 'node:test';
import assert from 'node:assert/strict';
import '../../extension/src/core/util.js';
import '../../extension/src/core/schema.js';
import '../../extension/src/core/lexicon.js';
import '../../extension/src/core/store.js';
import '../../extension/src/core/matcher.js';
import '../../extension/src/core/resume-parse.js';

const CV = globalThis.CVCore;
const { resumeParse } = CV;

const RESUME_TEXT = [
  '张三',
  '13800000000',
  'demo.user@example.com',
  '求职目标：前端架构师',
  '教育经历',
  '毕业院校：示例大学',
  '专业：Computer Science',
  '最高学历：硕士',
  '工作经历',
  '2020.07-至今 示例科技有限公司 高级前端工程师',
  '负责数据平台前端架构，性能提升 40%，支撑 20+ 内部系统。',
  '专业技能',
  'JavaScript / React / Node.js / 性能优化',
  '开源作品',
  'GitHub 万星项目核心维护者',
].join('\n');

test('parseResumeText: quick capture of header name/phone/email', () => {
  const parsed = resumeParse.parseResumeText(RESUME_TEXT);
  assert.equal(parsed.values.fullName, '张三');
  assert.equal(parsed.values.phone, '13800000000');
  assert.equal(parsed.values.email, 'demo.user@example.com');
});

test('parseResumeText: same-line "label: content" maps to profile fields', () => {
  const parsed = resumeParse.parseResumeText(RESUME_TEXT);
  assert.equal(parsed.values.desiredPosition, '前端架构师');
  assert.equal(parsed.values.school, '示例大学');
  assert.equal(parsed.values.major, 'Computer Science');
  assert.equal(parsed.values.highestEducation, '硕士');
});

test('parseResumeText: paragraph content goes to long-text fields (work experience/skills)', () => {
  const parsed = resumeParse.parseResumeText(RESUME_TEXT);
  assert.ok(String(parsed.values.workExperience).includes('示例科技'), `actual: ${parsed.values.workExperience}`);
  assert.ok(String(parsed.values.workExperience).includes('40%'));
  assert.ok(String(parsed.values.skills).includes('React'));
});

test('parseResumeText: unknown fields become custom fields (content kept)', () => {
  const parsed = resumeParse.parseResumeText(RESUME_TEXT);
  const custom = parsed.customFields.find((c) => c.label.includes('开源'));
  assert.ok(custom, `customFields=${JSON.stringify(parsed.customFields)}`);
  assert.ok(custom.value.includes('万星项目'));
});

test('parsedToProfile: converts to a profile structure (incl. custom fields)', () => {
  const parsed = resumeParse.parseResumeText(RESUME_TEXT);
  const profile = resumeParse.parsedToProfile(parsed);
  assert.equal(profile.fields.fullName.value, '张三');
  assert.ok(profile.customFields.some((c) => c.key.startsWith('custom:')));
  assert.ok(profile.learning && Array.isArray(profile.learning.samples));
});

test('parseResumeText: empty text yields warnings', () => {
  const parsed = resumeParse.parseResumeText('');
  assert.equal(Object.keys(parsed.values).length, 0);
  assert.ok(parsed.warnings.length >= 1);
});

test('parseResumeText: a URL is not mistaken for a label', () => {
  const parsed = resumeParse.parseResumeText(['张三', 'https://github.com/zhangsan', '工作经历', '某厂 高级工程师'].join('\n'));
  assert.equal(parsed.values.personalSite, 'https://github.com/zhangsan');
  assert.ok(String(parsed.values.workExperience).includes('某厂'));
});
