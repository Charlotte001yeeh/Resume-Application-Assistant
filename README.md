# CV Plugin — Resume Application Assistant

A Chrome / Edge extension (Manifest V3) that assists online job applications:
it keeps a persistent **resume profile**, **auto-fills application forms** by semantic field matching,
and **learns from completed applications** to improve itself over time.

Pure JavaScript. **Zero third-party dependencies. Zero build step.** All data stays on your machine.

**Contents:** [Purpose](#purpose) · [Requirements](#requirements) · [Installation](#installation) ·
[First run](#first-run-setup) · [Daily usage](#daily-usage) · [Profiles](#managing-resume-profiles) ·
[Backup & restore](#backup--restore) · [Updating](#updating-the-extension-after-code-changes) ·
[Troubleshooting](#troubleshooting) · [Uninstall](#uninstall--data-removal) · [Directory](#directory-structure) ·
[Testing](#development--testing) · [Boundaries](#boundaries--limitations) · [Privacy](#privacy) ·
[Language](#language-policy) · [License](#license)

---

## Purpose

Applying to many jobs means re-typing the same information into dozens of different forms
("Full name" / "Your name" / "Applicant name" / "姓名"…). CV Plugin removes that repetition:

1. **Resume profile** — 45+ common resume fields (CN/EN) with long-term local storage, custom fields,
   import/export, and **multiple resume sets** (different wording per company).
2. **Semantic auto-fill** — recognizes the same meaning across field label variants
   (synonyms, autocomplete attributes, input shapes, table layouts, custom dropdowns, shadow DOM,
   cascading selects) and fills confidently-matched fields only; ambiguous fields go to a
   **batch confirmation panel** (never guess).
3. **Learning from completed forms** — scan a finished application to merge similar fields,
   build new fields from unseen questions, and reuse your own handwritten answers for future drafts
   ("the more you use it, the better it gets").

---

## Requirements

| | Requirement |
|---|---|
| Browser | Chrome / Edge / Chromium **110+** (Manifest V3, `DecompressionStream`, File System Access) |
| Packages | **None.** No `npm install`, no build step — the extension is plain JS |
| Node.js (optional) | **≥ 20**, only if you want to run the test suites / helper scripts |
| Optional LLM | Your own OpenAI-compatible endpoint (off by default; the plugin works fully offline) |

---

## Installation

1. **Get the code** — clone or download this repository. The extension lives in the `extension/` folder.
2. **Open the extensions page** — Chrome: `chrome://extensions` · Edge: `edge://extensions`.
3. **Enable Developer mode** (toggle in the top-right corner).
4. **Load unpacked** → select the **`extension/`** folder (the one containing `manifest.json`).
5. **Pin it (recommended)** — click the puzzle-piece icon in the toolbar → pin *CV Plugin — Resume
   Application Assistant* so the popup is one click away.
6. **Verify the install** — open any web page, open DevTools console and run:
   ```js
   document.documentElement.dataset.cvVersion   // e.g. "1.1.0"
   document.documentElement.dataset.cvLang      // "en" or "zh"
   ```
   You should also see the **floating ball** at the bottom-right of the page.

> No page visible yet? Content scripts only run on pages loaded *after* installation — reload the tab (F5).

---

## First run (setup)

1. **Open the profile manager** — click the toolbar icon → **Open Profile Manager**
   (or `chrome://extensions` → *Details* → *Extension options*).
2. **Fill your resume** — enter the common fields (name, phone, email, education, experience…).
   Everything auto-saves; **Save All Changes** forces a save.
   - Or **Load Sample Profile** to explore the plugin with fictional demo data.
   - Or **Import (PDF / Image / JSON)** an existing resume: PDFs are parsed offline (Chinese CID
     fonts supported), images go through the optional VLM path, JSON merges or creates a new set.
3. **Pick your UI language** — *Settings → UI language*: `Auto (follow browser)` / `English` / `中文`.
   The whole interface (popup, options page, in-page widget) follows it.
4. **Decide about the floating ball** — *Settings* → the floating-button switch
   (or the **Floating ball** checkbox in the popup). When off, nothing is injected on pages.
5. *(Optional)* **Enable the LLM** — *Settings → Optional: LLM content enhancement*: set
   **Base URL / API Key / Model**, tick *Enable LLM* (and *VLM* for image resumes / screenshot
   cross-checks). Leave it off to stay fully offline; failures always fall back to offline templates.

---

## Daily usage

### The floating widget (on application pages)

| State | What you see | How to get there |
|---|---|---|
| **Ball** (default) | Only a translucent glass ball labelled `CV` at the bottom-right | Page load |
| **Function grid** | A frosted **2×2 grid**: `Fill` / `Check` / `Learn` / `Save` (中文: 填充 / 体检 / 学习 / 回写) — no description text | Click the ball |
| **Content panel** | An **opaque white panel** with that function's results, explanations and action buttons | Click one of the four buttons |

- **Drag** the ball anywhere (it stays inside the viewport and the position is remembered).
- **Close** with `×` (back to ball), `‹` (back to the grid), clicking outside the widget, or `Esc`.

### Fill (`Fill` / 填充)

1. Open the application page and click **Fill**.
2. High-confidence fields are filled with framework-safe events (React/Vue compatible).
3. The panel lists every result: `Filled` / `Skipped` / `Failed` plus the reason
   (e.g. *option "硕士" is a synonym of canonical value "master"*).
4. Low-confidence fields appear under **Needs Review**: tick the ones to apply, re-assign them to a
   different resume field from the dropdown, or choose *— Ignore this item (do not suggest again) —*;
   then **Apply Selected** / **Ignore All**. Ignored suggestions are remembered and de-prioritized.
5. Iframes (including cross-origin ones) are filled too: the popup's fill broadcasts across frames and
   reports an aggregate.

### Check (`Check` / 体检)

Generates answers for **unseen questions**, offers **similar-wording variants**, and flags
**optimizations** (length limits, missing quantified results, JD keyword gaps, sensitive data).
Each suggestion shows its rationale and an **Apply & Fill** button.

### Learn (`Learn` / 学习) and Save (`Save` / 回写)

- **Learn (Sample Learning)** — run it on a page you filled *by hand*: similar fields are merged into
  your profile, unseen questions become new fields, and your answers are stored as samples.
- **Save (Learn from this page)** — writes the values you typed on the current page back into the
  active resume set (per-field confirmation, nothing is overwritten silently).

### The popup (toolbar icon)

Resume-set name, field count, auto-fill state, storage location, and one-click entries:
**Fill This Page** (all frames) · **Resume Check** · **Sample Learning (filled page)** ·
**Learn from This Page** · **Backup to Folder** · **Open Profile Manager**, plus the
**UI language** selector and the **Floating ball** switch.

---

## Managing resume profiles

*Profile Manager → Multiple Profiles*

- **New Blank Profile** — start an empty set (e.g. a different role).
- **Copy from Current** — duplicate the active set and tune the wording per company.
- **Use / Rename / Duplicate / Export this profile / Delete** in the list; the active set drives
  fill / check / learning. Each set keeps its own fields, custom fields and learning data.
- **Custom Fields** — define fields beyond the built-in template (e.g. *Competition Award*); they
  participate in semantic matching like any other field.
- **Learning Data** — inspect the learned aliases and your handwritten samples, or clear them.
- **Import mode** — *Merge into current profile* or *Create as a separate profile* (applies to
  PDF / image / JSON imports).
- **Site Scope** — all sites or a whitelist, plus a blocked-sites list.

---

## Backup & restore

*Profile Manager → Data Safety & Backup*

- **Choose Backup Folder & Enable Auto Backup** — pick a local folder; from then on every profile
  change is written there (5 s debounce) as timestamped copies. **These files survive uninstalling
  the extension**, which plain extension storage does not.
- **Backup Now** — an immediate backup; **Disable Auto Backup** turns it off.
- **Download Full Backup (all profiles + learning data + settings)** — a single JSON with everything.
- **Restore from Full Backup** — restores all sets, learning records and settings.
- **Export (Masked)** — exports the profile with sensitive values (e.g. ID number) masked.

---

## Updating the extension after code changes

**Unpacked extensions are not hot-reloaded.** Chrome keeps the version it loaded in memory, so editing
files on disk changes nothing until you reload:

1. `chrome://extensions` → your extension → click **Reload ⟳** (and *Clear all* in the Errors panel if
   an old error is still listed).
2. **Refresh every tab** where you want the new behaviour — content scripts are injected at page load.
3. Close and reopen the popup / profile-manager tabs.
4. Verify which build is loaded:
   ```js
   document.documentElement.dataset.cvVersion   // extension version
   document.documentElement.dataset.cvLang      // current UI language of that page's widget
   document.documentElement.dataset.cvBuild     // profile-manager build marker (options page)
   ```

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| No ball on the page | Page opened before install/update, or the floating ball is switched off, or the site is blocked | Reload the page; check the popup's **Floating ball** checkbox / *Settings*; check *Site Scope* |
| Button labels look like `chip.fill` | Chrome is running an **older copy** of the extension | Reload ⟳ + refresh the page; the current build never shows raw keys (it falls back to readable words) |
| `Cannot set properties of null (setting 'value')` in the Errors panel | Stale build from an interrupted reload | Reload ⟳ again; the current code guards every DOM write |
| Popup shows only the words “Floating ball” with no checkbox | Old build (the language switch used to replace the control) | Reload ⟳ (fixed: localization never rewrites elements that contain form controls) |
| Toolbar icon shows an error | An exception from the loaded copy | Reload ⟳, then *Clear all*; if it persists, open DevTools on the page named in the error and report the first stack line |
| Nothing is filled | Empty profile, all fields below the confidence threshold, or the page is in an unsupported frame | Fill the profile, check the panel's `Needs Review` list, reload the page |
| Fill works but some fields are wrong | Field is genuinely ambiguous (rare) | Use the batch panel to re-assign, or teach it: fill by hand → **Learn** |
| “This page does not support injection” | The page was open before install/update or is a privileged page (`chrome://`, Web Store) | Refresh the page; browser-internal pages are intentionally unsupported |

---

## Uninstall & data removal

1. `chrome://extensions` → *Remove*. Profile, learning data and settings are deleted with it.
2. Before removing, use **Download Full Backup** (and enable folder auto-backup) if you want your data.
3. To wipe everything: remove the extension, delete the backup folder, and (optionally) clear the
   extension's storage via DevTools → Application → Storage.

---

## Directory Structure

```
CV_plugin/
├── extension/                  # ★ Load this folder as an unpacked extension
│   ├── manifest.json
│   ├── icons/
│   ├── src/
│   │   ├── core/               # Pure logic (unit-testable outside the browser)
│   │   │   ├── schema.js       #   45+ resume field templates (CN/EN aliases)
│   │   │   ├── lexicon.js      #   synonyms, autocomplete map, intent classifier
│   │   │   ├── matcher.js      #   semantic field scoring & decision engine
│   │   │   ├── fill.js         #   fill engine (date splits, custom dropdowns, name splitting)
│   │   │   ├── table-layout.js #   table-form pairing (51job/Beisen-style grids)
│   │   │   ├── cascade.js      #   cascading selects (province→city→district)
│   │   │   ├── optimizer.js    #   review: generate / similar wording / optimize
│   │   │   ├── fact-check.js   #   anti-hallucination fact verification
│   │   │   ├── confirm-batch.js#   low-confidence batch confirmation
│   │   │   ├── store.js        #   profile storage (multi-set, learning, backup bundle)
│   │   │   ├── backup.js       #   local folder auto-backup (File System Access)
│   │   │   ├── pdf.js          #   dependency-free PDF text extraction (incl. ToUnicode CMap)
│   │   │   ├── resume-parse.js #   resume text → field mapping
│   │   │   ├── llm.js          #   optional LLM/VLM adapter (OpenAI-compatible, user-configured)
│   │   │   └── i18n.js         #   UI display language switch (English / 中文 catalog + DOM swap)
│   │   ├── content/content.js  # page scanning, floating widget, test bridge
│   │   └── background/service-worker.js
│   └── ui/                     # popup + options (profile manager, backup, import)
├── test/
│   ├── unit/                   # 169 unit & integration tests (node:test)
│   ├── e2e/                    # end-to-end suite: real Chrome + CDP, live-site suite, diagnostics
│   └── artifacts/              # screenshots & JSON reports (generated)
├── scripts/gen-icons.mjs
├── requirements.txt            # dependency manifest (zero runtime deps)
├── LICENSE                     # MIT
└── docs/                       # design & test reports
```

---

## Development & testing

```bash
npm test           # 169 unit & integration tests (node:test)
npm run test:e2e   # 157 end-to-end checks in a real Chrome (loads the unpacked extension)
npm run test:all   # both
npm run test:live  # live resume-site verification (fills real forms, never submits)
npm run test:llm   # optional: smoke-test a real LLM endpoint via env vars
```

Diagnostics (read-only helpers, handy when something looks off in your own browser):

```bash
node test/e2e/probe-console.mjs    # opens the extension pages in a real Chrome, reports console errors (en + zh)
node test/e2e/probe-en-panel.mjs   # dumps what the widget panel shows in English mode
node test/e2e/audit-dom-refs.mjs   # cross-checks every element id / .value write against the HTML
node scripts/sensitive-scan.mjs    # full-repo sensitive-data audit (personal info / paths / credentials)
node scripts/serve-mock.mjs 8899   # serves docs/mockups UI prototypes on http://127.0.0.1:8899/
```

---

## Boundaries & Limitations

- **Never auto-submits** — filling only; the submit decision is always yours.
- Ambiguous/composite fields (e.g. "University & Major" combined) go to batch confirmation instead of guessing.
- Closed shadow roots and pure-canvas widgets are unreadable by design (browser security boundary);
  custom click-dropdowns, open shadow DOM, table layouts, cascading selects and date-split controls are supported.
- Login-walled sites (BOSS Zhipin / 51job / Liepin apply pages) cannot be verified anonymously;
  the same form patterns are covered by offline fixtures and the real-form test suite.
- GBK-encoded legacy PDFs may extract with garbled Chinese (CID/ToUnicode PDFs are fine);
  scanned/image-only PDFs can be imported via the optional VLM path.
- Optional LLM/VLM features require your own OpenAI-compatible endpoint and are **off by default**;
  offline templates and your own stored samples are always used as fallback.
- The plugin cannot translate the *page's* own text or the *page data* you filled; the UI language
  switch only affects the plugin's own interface.

---

## Privacy

- All data (profile, samples, settings) is stored locally (`chrome.storage.local`).
- No network traffic unless **you** enable LLM/VLM with **your own** endpoint.
- Demo/sample data in this repository is **fictional** (placeholder name, phone, ID).
- Sensitive fields (ID numbers) are masked in exports by request.

### Sensitive-data audit

The repository is verified clean by an automated, self-contained scan:

```bash
node scripts/sensitive-scan.mjs     # exits 1 if anything needs attention
# → scanned 138 files (45 binary)
# → HIGH 0   (DEMO-DATA: the fictional placeholders listed below; informational only)
```

What it checks (all files, including binaries):

| Category | Examples it looks for |
|---|---|
| Personal / machine paths | absolute user paths, home directories, machine names, harness/tool paths |
| Credentials | `sk-…`, `ghp_…`, `AKIA…`, bearer tokens, assigned `apiKey/secret/password`, private-key blocks, URLs with embedded credentials, session cookies |
| Non-placeholder contacts | e-mail addresses other than `example.com` / `localhost` / test domains |
| Binary metadata | PNG `tEXt`/`iTXt`/`zTXt`/`eXIf` chunks, PDF `/Author` `/Creator` `/Producer` `/Title` |
| Suspicious files | `.env`, `*.log`, `*.bak`, `*.pem`, `*.key`, `credentials*`, `*secret*` … |

**Intentionally fictional demo data** (the only "personal-looking" values present, used by the
sample profile, fixtures, UI prototypes and tests):

| Value | Meaning | Where |
|---|---|---|
| `张三` | Chinese equivalent of "John Doe" | `extension/src/core/store.js`, tests, mockups |
| `13800000000` / `13900000000` | all-zero placeholder phone numbers | sample profile, lexicon, fixtures, docs |
| `demo.user@example.com` | reserved `example.com` domain | sample profile, docs |
| `000000000000000000` | obviously-fake ID placeholder | sample profile, tests |
| `示例大学` / `示例科技有限公司` | "Example University / Example Tech Co." | sample profile, tests |

**Not published:** `test/artifacts/` (screenshots and JSON reports generated by the test runs, which
contain localhost URLs and the demo data) is listed in `.gitignore`, so it never leaves your machine.
The project directory contains **no VCS metadata** (no `.git/`, hence no stored git identity, remotes
or credentials) and **no `.env` / key / certificate files**.

---

## Language Policy

Code comments, wording and documentation are **English**. Chinese is intentionally retained only
where it is *functional data*: field-label dictionaries used to match Chinese application forms
(schema / lexicon), Chinese resume-output templates and prompts that instruct Chinese output,
and test fixtures. Generated resume content follows the template language
(Chinese templates produce Chinese answers).

### UI language switch (frontend display only)

The interface ships with an **English default** and a built-in **Chinese ⇄ English switch**:

- **Popup toolbar**: `UI language` → `English` / `中文`, plus a `Floating ball` on/off switch (instant).
- **Profile Manager → Settings**: `UI language` → `Auto (follow browser)` / `English` / `中文`, and the
  floating-button switch. The saved choice also drives the in-page widget.
- **In-page widget**: changed in the popup/options, it applies to the next page load (or immediately
  on the current page via the settings push).

**Everything visible follows the language**, including the floating ball (tooltip + the four function
buttons), the white result panels, low-confidence batch rows, **runtime messages produced by the
matching/fill engine** (e.g. `Date filled as a whole ISO value` → `日期已整体填入（ISO 格式）`),
the profile manager (static text *and* dynamically rendered labels / headings / status lines / toasts),
and the popup.

Implementation: `extension/src/core/i18n.js` — a zero-dependency module with
`t(key, params)` (UI strings), `applyDom(root)` (static text swap via an inverted catalog; it never
rewrites elements that contain form controls) and `dyn(text)` (rules that localize runtime engine
messages on render; the core itself stays language-neutral). Adding a language means adding one column.

---

## Future Optimization

- Fact-consistency hardening for generated content (cross-check every claim against the profile).
- Per-site learning statistics and portable alias dictionaries.
- Table-form adversarial corpus (extreme merged-cell layouts).
- MutationObserver-based re-scan for lazily rendered / modal forms.
- Calendar-popup date pickers (DOM-based) as an additional fill strategy.
- Firefox / Safari ports.

---

## License

[MIT](LICENSE)
