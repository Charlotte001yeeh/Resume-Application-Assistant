/* CV Plugin core — llm.js
 * Optional LLM enhancement (OpenAI-compatible chat/completions). Off by default; callers fall back on failure/timeout.
 * Exposed as globalThis.CVCore.llm.
 */
(function (root) {
  'use strict';
  const core = (root.CVCore = root.CVCore || {});

  function normalizeBaseUrl(url) {
    let u = String(url || '').trim().replace(/\/+$/, '');
    if (!u) return '';
    if (/\/v\d+$/i.test(u)) return u;
    return `${u}/v1`;
  }

  /** Tolerant JSON extraction from model output (special tokens / truncation tolerant). */
  function extractJson(text) {
    let s = String(text || '').trim();
    const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/);
    let body = fenced ? fenced[1] : s;
    const attempts = [
      body,
      body.replace(/<\|[^|]*\|>/g, 'null'), // real-model special tokens (e.g. <|TOOL_CALL...|>) → null placeholder
      body.replace(/<\|[^|]*\|>/g, ''), // or strip them entirely
    ];
    let lastErr = null;
    for (const candidate of attempts) {
      try {
        return extractJsonOnce(candidate);
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr || new Error('Model returned no JSON');
  }

  function extractJsonOnce(body) {
    const start = body.indexOf('{');
    const startArr = body.indexOf('[');
    const begin = start === -1 ? startArr : startArr === -1 ? start : Math.min(start, startArr);
    if (begin === -1) throw new Error('Model returned no JSON');
    const open = body[begin];
    const close = open === '{' ? '}' : ']';
    let depth = 0;
    for (let i = begin; i < body.length; i++) {
      if (body[i] === open) depth++;
      else if (body[i] === close) {
        depth--;
        if (depth === 0) return JSON.parse(body.slice(begin, i + 1));
      }
    }
    throw new Error('Model returned incomplete JSON');
  }

  /** Attach images to an OpenAI-compatible multimodal user message. */
  function withImages(userContent, images) {
    const arr = [{ type: 'text', text: String(userContent) }];
    for (const img of images || []) {
      if (img) arr.push({ type: 'image_url', image_url: { url: img } });
    }
    return arr;
  }

  /**
   * @param {{baseUrl:string, apiKey:string, model:string, fetchImpl?:Function}} config
   * @returns {{complete(messages, opts):Promise<string>, enabled:boolean,
   *   parseResumeImage(opts):Promise<Object>, reviewResumeParse(opts):Promise<Object>,
   *   describeFilledPage(opts):Promise<Array>}}
   */
  function createClient(config) {
    const cfg = config || {};
    const fetchImpl = cfg.fetchImpl || (typeof fetch === 'function' ? fetch.bind(typeof window !== 'undefined' ? window : globalThis) : null);
    return {
      enabled: !!cfg.baseUrl && !!cfg.model && !!fetchImpl,
      async complete(messages, opts) {
        if (!fetchImpl) throw new Error('fetch is unavailable');
        const base = normalizeBaseUrl(cfg.baseUrl);
        if (!base) throw new Error('LLM baseUrl is not configured');
        const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
        const timeoutMs = (opts && opts.timeoutMs) || 10000;
        const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;

        const send = (payload) =>
          fetchImpl(`${base}/chat/completions`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
            },
            body: JSON.stringify(payload),
            signal: controller ? controller.signal : undefined,
          });

        try {
          const payload = { model: cfg.model, messages, temperature: 0.4 };
          if (opts && opts.json) payload.response_format = { type: 'json_object' }; // structured output (supported by most OpenAI-compatible APIs)
          let res = await send(payload);
          if (!res.ok && payload.response_format && (res.status === 400 || res.status === 422)) {
            // Some endpoints reject response_format: retry once without it
            delete payload.response_format;
            res = await send(payload);
          }
          if (!res.ok) throw new Error(`LLM HTTP ${res.status}`);
          const data = await res.json();
          const text = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
          return String(Array.isArray(text) ? text.map((t) => (t && t.text) || '').join('') : text || '');
        } finally {
          if (timer) clearTimeout(timer);
        }
      },

      /** VLM: recognize resume fields from an image/screenshot (returns {values, customFields}). */
      async parseResumeImage({ image, hint } = {}, opts) {
        const out = await this.complete(
          [
            {
              role: 'system',
              content:
                '你是简历信息抽取助手。从图片中识别简历内容，输出 JSON：{"values":{"fullName":"...","phone":"...","email":"...","school":"...","workExperience":"..."},"customFields":[{"label":"...","value":"..."}]}。values 的键必须从给定字段键列表中选择，语义相近即映射（如"姓名"→fullName、"求职目标"→desiredPosition）；无法映射的成段内容放入 customFields。只输出 JSON。',
            },
            { role: 'user', content: withImages(`字段键列表：${(hint && hint.keys) || ''}\n请识别图中简历。`, [image]) },
          ],
          { ...(opts || {}), json: true }
        );
        return extractJson(out);
      },

      /** VLM: review a heuristic parse (returns corrected {values, customFields}). */
      async reviewResumeParse({ text, parsed } = {}, opts) {
        const out = await this.complete(
          [
            {
              role: 'system',
              content:
                '你是简历字段校对助手。给定简历原文与初步解析结果，检查字段映射错误、内容截断、张冠李戴并修正，补充遗漏字段。输出 JSON（同结构）：{"values":{...},"customFields":[{"label":"...","value":"..."}]}。只输出 JSON。',
            },
            { role: 'user', content: `简历原文：\n${String(text || '').slice(0, 6000)}\n\n初步解析：\n${JSON.stringify(parsed || {})}` },
          ],
          { ...(opts || {}), json: true }
        );
        return extractJson(out);
      },

      /** VLM: read filled fields from a page screenshot (for study corrections); returns [{label, value}]. */
      async describeFilledPage({ image, values } = {}, opts) {
        const out = await this.complete(
          [
            {
              role: 'system',
              content:
                '你是在线简历填写页面的核对助手。从截图中读出每个已填写字段的标签与内容，与给定的已读取数据比对，补充 DOM 读取遗漏的字段、纠正明显不一致的内容。输出 JSON 数组：[{"label":"页面字段标签","value":"填写内容"}]。只输出 JSON 数组。',
            },
            {
              role: 'user',
              content: withImages(
                `DOM 已读取的字段数据：\n${JSON.stringify(values || {}).slice(0, 4000)}\n\n请核对截图并输出字段清单。`,
                [image]
              ),
            },
          ],
          { ...(opts || {}), json: true }
        );
        const data = extractJson(out);
        return Array.isArray(data) ? data.filter((x) => x && x.label && x.value) : [];
      },

      /** VLM per-field Q&A (anti-hallucination layer 2): ask about one field; returns plain text. */
      async askField({ image, label } = {}, opts) {
        const out = await this.complete(
          [
            {
              role: 'system',
              content: '你是表单核对助手。根据截图回答指定字段的填写内容，只输出该字段的内容本身，不要解释；看不到就输出 看不到。',
            },
            { role: 'user', content: withImages(`截图中「${label}」字段填写的是什么？`, [image]) },
          ],
          { ...(opts || {}), timeoutMs: (opts && opts.timeoutMs) || 8000 }
        );
        return String(out || '').trim();
      },
    };
  }

  /** Two-channel agreement check (equal or containing after normalization). */
  function agrees(a, b) {
    const u = typeof core.util !== 'undefined' ? core.util : null;
    const na = u ? u.stripAll(a) : String(a || '').replace(/\s+/g, '');
    const nb = u ? u.stripAll(b) : String(b || '').replace(/\s+/g, '');
    if (!na || !nb) return false;
    if (na === nb) return true;
    return (na.length >= 2 && nb.includes(na)) || (nb.length >= 2 && na.includes(nb));
  }

  /** Build a client from settings; returns null when disabled. */
  function clientFromSettings(settings) {
    const llm = (settings && settings.llm) || {};
    if (!llm.enabled) return null;
    return createClient({ baseUrl: llm.baseUrl, apiKey: llm.apiKey, model: llm.model });
  }

  /**
   * Filter VLM page-check results (adversarial-test driven): keep only labels that truly appear in page text,
   * sane lengths, non-empty values, no angle brackets in labels (anti-hallucination & anti-injection).
   */
  function filterVlmItems(items, { pageText = '', maxLabel = 24, maxValue = 2000 } = {}) {
    const out = [];
    const seen = new Set();
    for (const it of Array.isArray(items) ? items : []) {
      const label = String((it && it.label) || '').trim();
      const value = String((it && it.value) || '').trim();
      if (!label || !value) continue;
      if (label.length > maxLabel || value.length > maxValue) continue;
      if (/[<>]/.test(label)) continue;
      if (pageText && !String(pageText).includes(label)) continue;
      const k = `${label}::${value.slice(0, 50)}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ label, value });
    }
    return out;
  }

  core.llm = { createClient, clientFromSettings, normalizeBaseUrl, extractJson, withImages, filterVlmItems, agrees };
})(typeof globalThis !== 'undefined' ? globalThis : this);
