/* CV Plugin core — table-layout.js
 * Table-form enhancement (51job/Beisen grids): build grid (rowspan/colspan expansion) -> nearest label-control pairing -> label cleanup.
 * Pure logic (pairing/cleanup) is unit-testable; labelFor(el) serves content.js (null outside tables, zero behavior change).
 * Exposed as globalThis.CVCore.tableLayout.
 */
(function (root) {
  'use strict';
  const core = (root.CVCore = root.CVCore || {});

  const MAX_CELLS = 4000;
  // Functional dictionaries: 请填写|请输入|… (hint phrases) and 元\/月|… (unit suffixes) below are Chinese
  // words matched against real page labels to spot noise hints and unit tails — keep as data, do not translate
  const NOISE_RE = /(请填写|请输入|请选择|选填|必填|格式不正确|填写错误|错误|不超过|至少|例如|^如[:：]|例[:：]|点击|上传|附件|涉及个人|谨慎填写|required|optional)/i;
  const UNIT_TAIL_RE = /[（(]\s*(元\/月|元|万元|k|K|kg|cm|mm|岁|年|个月|%)\s*[）)]\s*$/;

  // Reuse util.textOf (fallback keeps the module loadable standalone)
  const textOf = (el) =>
    core.util && core.util.textOf
      ? core.util.textOf(el)
      : String((el && el.textContent) || '').replace(/\s+/g, ' ').trim();

  /** Label cleanup: drop required stars/colons/parenthetical hints/unit suffixes, keep semantic words. */
  function cleanLabelText(t) {
    let s = String(t == null ? '' : t).replace(/\s+/g, ' ').trim();
    s = s.replace(/[＊*·・]+/g, ' ').replace(/\s+/g, ' ').trim();
    s = s.replace(/[\s:：]*[:：]\s*$/, '').trim();
    // Drop parenthetical hints (keep semantic parentheses: only when the content is a hint)
    // Functional data: 请填写|请输入|… are Chinese hint words — do not translate
    s = s.replace(/[（(][^（()）]*?(请填写|请输入|请选择|选填|必填|格式|例如|如[:：]|不超过|至少|单位|字以内|含单位)[^（()）]*?[）)]/g, ' ').trim();
    s = s.replace(UNIT_TAIL_RE, '').trim();
    s = s.replace(/[\s*＊]+$/, '').trim();
    return s;
  }

  function isNoiseLabel(t) {
    const s = String(t == null ? '' : t).trim();
    if (!s) return true;
    return NOISE_RE.test(s);
  }

  /** Pair labels and controls from a pure grid matrix (pure function for unit tests).
   * grid: rows[r][c] = {el, text, controls:[], rowSpan, colSpan} | null (placeholder)
   * returns Map<controlRef, {label, confidence, source}>
   */
  function pairLabelsAndControls(grid) {
    const out = new Map();
    const rows = grid.length;
    const colsOf = (r) => (grid[r] ? grid[r].length : 0);
    const at = (r, c) => {
      // Placeholder cells (rowspan/colspan) -> walk up the column to the source cell; empty slot returns null
      let row = r;
      while (row >= 0) {
        const cell = grid[row] && grid[row][c] ? grid[row][c] : null;
        if (!cell) return null;
        if (!cell.placeholder) return cell;
        row--;
      }
      return null;
    };

    const isPureLabelCell = (cell) => {
      if (!cell || cell.placeholder) return false;
      if (!cell.text) return false;
      if ((cell.controls || []).length) return false;
      const cleaned = cleanLabelText(cell.text);
      if (!cleaned || cleaned.length > 20) return false;
      return !isNoiseLabel(cleaned) && cleaned.length >= 1;
    };

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < colsOf(r); c++) {
        const cell = grid[r] && grid[r][c] ? grid[r][c] : null;
        if (!cell || cell.placeholder || !(cell.controls || []).length) continue;
        for (const ctrl of cell.controls) {
          if (out.has(ctrl)) continue; // pair each control once (placeholder revisits would overwrite with a worse label)
          // (1) nearest pure-label cell on the left of the same row
          let label = null;
          let confidence = 0;
          let source = '';
          for (let lc = c - 1; lc >= 0; lc--) {
            const cand = at(r, lc);
            if (cand && (cand.controls || []).length) break; // stop at the nearest control cell (multi-pair rows: nearest wins)
            if (isPureLabelCell(cand)) {
              label = cleanLabelText(cand.text);
              confidence = 1;
              source = 'row-left';
              break;
            }
          }
          // (2) nearest pure-label cell above in the same column (incl. rowspan headers)
          if (!label) {
            for (let lr = r - 1; lr >= 0; lr--) {
              const cand = at(lr, c);
              if (isPureLabelCell(cand)) {
                const t = cleanLabelText(cand.text);
                if (!label || confidence < 0.9) {
                  label = t;
                  confidence = 0.92;
                  source = 'col-up';
                }
                break;
              }
              if (cand && (cand.controls || []).length) break;
            }
          }
          // (3) right side of the same row (right-to-left layouts)
          if (!label) {
            for (let rc = c + 1; rc < colsOf(r); rc++) {
              const cand = at(r, rc);
              if (cand && (cand.controls || []).length) break;
              if (isPureLabelCell(cand)) {
                label = cleanLabelText(cand.text);
                confidence = 0.8;
                source = 'row-right';
                break;
              }
            }
          }
          // (4) short text inside the same cell (when nothing else labels it)
          if (!label && cell.text) {
            const self = cleanLabelText(cell.text);
            if (self && self.length <= 20 && !isNoiseLabel(self)) {
              label = self;
              confidence = 0.7;
              source = 'self';
            }
          }
          if (label) out.set(ctrl, { label, confidence, source });
        }
      }
    }
    return out;
  }

  // ── DOM side ────────────────────────────────────────────────
  const gridCache = new WeakMap();

  function buildTableGrid(tableEl) {
    const matrix = [];
    const rows = [...(tableEl.rows || [])];
    for (let r = 0; r < rows.length && r < 200; r++) {
      const tr = rows[r];
      let c = 0;
      for (const cellEl of tr.cells) {
        while (matrix[r] && matrix[r][c]) c++;
        const rs = cellEl.rowSpan || 1;
        const cs = cellEl.colSpan || 1;
        for (let dr = 0; dr < rs; dr++) {
          matrix[r + dr] = matrix[r + dr] || [];
          for (let dc = 0; dc < cs; dc++) {
            matrix[r + dr][c + dc] =
              dr === 0 && dc === 0
                ? { el: cellEl, text: textOf(cellEl), controls: controlsIn(cellEl, tableEl), rowSpan: rs, colSpan: cs }
                : { placeholder: true };
          }
        }
        c += cs;
      }
    }
    return matrix;
  }

  function controlsIn(cellEl, rootTable) {
    return [...cellEl.querySelectorAll('input, select, textarea, [contenteditable="true"]')].filter(
      (el) => !el.closest('table') || el.closest('table') === rootTable
    );
  }

  /** Detect a table/grid container: table -> [role=grid] -> display:table. */
  function detectGridContainer(el) {
    const table = el.closest && el.closest('table');
    if (table) return { kind: 'table', root: table };
    const roleGrid = el.closest && el.closest('[role="grid"], [role="table"]');
    if (roleGrid) return { kind: 'role', root: roleGrid };
    let node = el.parentElement;
    for (let i = 0; i < 6 && node; i++) {
      try {
        const disp = node.ownerDocument && node.ownerDocument.defaultView
          ? node.ownerDocument.defaultView.getComputedStyle(node).display
          : '';
        if (disp === 'table') return { kind: 'div', root: node };
      } catch (e) {
        break;
      }
      node = node.parentElement;
    }
    return null;
  }

  function buildGenericGrid(root, kind) {
    // Rows = [role=row] or display:table-row children; cells = row cell children
    const rowEls = [...root.children].filter((ch) => {
      const role = ch.getAttribute && ch.getAttribute('role');
      if (role === 'row') return true;
      if (role === 'rowgroup') return true;
      return false;
    });
    const rows = [];
    const collectRows = (parent) => {
      for (const ch of parent.children) {
        const role = ch.getAttribute && ch.getAttribute('role');
        if (role === 'rowgroup') collectRows(ch);
        else if (role === 'row' || (ch.children && ch.children.length && [...ch.children].every((x) => ['gridcell', 'cell', 'columnheader', 'rowheader'].includes((x.getAttribute && x.getAttribute('role')) || '')))) {
          rows.push(ch);
        }
      }
    };
    collectRows(root);
    const matrix = [];
    rows.slice(0, 200).forEach((tr, r) => {
      matrix[r] = [];
      const cells = [...tr.children];
      let c = 0;
      for (const cellEl of cells) {
        while (matrix[r][c]) c++;
        const cs = cellEl.colSpan || 1;
        const rs = cellEl.rowSpan || 1;
        for (let dr = 0; dr < rs; dr++) {
          matrix[r + dr] = matrix[r + dr] || [];
          for (let dc = 0; dc < cs; dc++) {
            matrix[r + dr][c + dc] =
              dr === 0 && dc === 0
                ? { el: cellEl, text: textOf(cellEl), controls: controlsIn(cellEl, null), rowSpan: rs, colSpan: cs }
                : { placeholder: true };
          }
        }
        c += cs;
      }
    });
    return matrix;
  }

  function gridFor(container) {
    if (gridCache.has(container.root)) return gridCache.get(container.root);
    let matrix;
    if (container.kind === 'table') matrix = buildTableGrid(container.root);
    else matrix = buildGenericGrid(container.root, container.kind);
    let count = 0;
    for (const row of matrix) for (const cell of row || []) if (cell && !cell.placeholder) count++;
    if (count > MAX_CELLS) matrix = [];
    gridCache.set(container.root, matrix);
    return matrix;
  }

  /** Infer a control’s label in table layouts; null outside tables / when unlabeled. */
  function labelFor(el) {
    try {
      const container = detectGridContainer(el);
      if (!container) return null;
      const matrix = gridFor(container);
      const pairs = pairLabelsAndControls(matrix);
      // Find the pairing for the cell owning el (cells may hold several controls)
      for (const [ctrl, info] of pairs) {
        if (ctrl === el) return info.label;
      }
      // Control not in the pairing set (unlabeled cell) -> fall back to null
      return null;
    } catch (e) {
      return null;
    }
  }

  core.tableLayout = { cleanLabelText, isNoiseLabel, pairLabelsAndControls, labelFor, detectGridContainer, buildTableGrid };
})(typeof globalThis !== 'undefined' ? globalThis : this);
