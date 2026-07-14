# OpenShop 简体中文汉化与离线运行时 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将托管的 OpenShop 0.19.1 改造成默认简体中文、术语遵循中文版 Photoshop、基础编辑完全不依赖 CDN 的 HstarA 同源编辑器运行时，同时保留可测试的 `en-US` 回退模式。

**Architecture:** 保留 OpenShop 单文件核心和 Fabric.js 行为，在其外侧增加小型浏览器国际化运行时、显式语言包、Photoshop 术语表和确定性本地依赖目录。静态及动态界面只翻译显式标注的应用 UI，不扫描或替换画布文字、图层名和用户输入；构建脚本只复制审核过的运行文件，并通过禁止外部脚本请求的 Playwright 门槛证明基础编辑可离线运行。

**Tech Stack:** OpenShop 0.19.1、原生 JavaScript、Fabric.js 5.3.1、Vitest 4、JSDOM、Playwright、Node.js 构建脚本、HstarA FastAPI 静态服务。

---

## Scope gate

本计划只实施总体设计的阶段 2：汉化与本地化。

本阶段包含：

- 将 Fabric.js、ag-psd、jsPDF、Photon、gif.js 和 Transformers 浏览器运行文件固定到本地目录；
- 删除 Google Fonts 和 CDN 运行依赖，保留模型文件或用户 API 请求所需的业务联网能力；
- 建立默认 `zh-CN`、回退 `en-US` 的国际化运行时；
- 使用中文版 Photoshop 通用术语翻译全部应用界面、提示、错误、工具提示和无障碍文本；
- 增加语言设置和 `?lang=en-US` 可复现回归入口；
- 增加翻译完整性、乱码、离线加载、桌面/移动视觉和原始功能回归测试。

本阶段不包含：

- 普通画布或智能画布正式“图文分层”节点；
- 节点项目数据库、素材后端和节点删除生命周期；
- HstarA 全局 API 选择器；
- 文字提取、去除文字、生成式填充、局部重绘或 AI 生成图层；
- 新 PSD 可编辑文字写入器。阶段 1 已记录 `REJECT_AG_PSD_TEXT_WRITER`，本阶段只保留现有 PSD 导入并明确禁用不合格的可编辑文字导出路径。

退出条件：默认页面无未说明英文或乱码；基础编辑在阻断所有非本机请求时可启动和操作；`en-US` 回归模式、上游测试和 HstarA 全量测试保持通过。

## File structure

- Create: `integrations/openshop/host/openshop-i18n.js`，浏览器语言注册、插值、显式 DOM 翻译、语言持久化和动态节点观察。
- Create: `integrations/openshop/locales/zh-CN.js`，以稳定英文消息键为索引的完整简体中文语言包。
- Create: `integrations/openshop/locales/photoshop-zh-CN-glossary.json`，受测试约束的 Photoshop 术语表。
- Create: `integrations/openshop/vendor/`，提交审核后的本地浏览器运行文件和许可证。
- Create: `integrations/openshop/vendor/runtime-manifest.json`，记录来源、版本、许可证、目标路径和 SHA-256。
- Create: `integrations/openshop/scripts/vendor-runtime.mjs`，从锁定的 `node_modules` 复制并校验可再生运行文件。
- Create: `integrations/openshop/scripts/audit-i18n.mjs`，抽取显式消息键并检查语言包、术语、未包装动态字符串和乱码。
- Modify: `integrations/openshop/index.html`，改用本地依赖、严格 CSP、默认中文、显式国际化键和语言设置。
- Modify: `integrations/openshop/package.json`、`package-lock.json`，固定本地运行依赖并增加审计/浏览器命令。
- Modify: `integrations/openshop/scripts/build-hstar.mjs`，确定性复制 `host/`、`locales/`、`vendor/` 和许可证。
- Create: `integrations/openshop/tests/hstar-i18n.test.js`，国际化运行时和语言包单元测试。
- Create: `integrations/openshop/tests/hstar-offline-runtime.test.js`，依赖清单、路径和 CSP 单元测试。
- Create: `integrations/openshop/tests/hstar-localization.e2e.spec.js`，中文界面、动态文本、语言切换和断网运行测试。
- Create: `tools/tests/openshop-localization-build.test.mjs`，HstarA 静态产物、翻译和远程依赖审计镜像。
- Create: `docs/validation/2026-07-14-openshop-localization-validation.md`，记录本阶段实际证据。

## Task 1: 固定阶段基线与本地依赖契约

**Files:**
- Modify: `integrations/openshop/package.json`
- Modify: `integrations/openshop/package-lock.json`
- Create: `integrations/openshop/tests/hstar-offline-runtime.test.js`

- [ ] **Step 1: 写入本地依赖失败测试**

Create `integrations/openshop/tests/hstar-offline-runtime.test.js` and assert the final document contract before changing production files:

```js
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('../vendor/runtime-manifest.json', import.meta.url), 'utf8'));

describe('Hstar OpenShop offline runtime', () => {
  it('uses only local browser runtime dependencies', () => {
    expect(html).toContain('./vendor/fabric-5.3.1.min.js');
    expect(html).toContain('./vendor/ag-psd-22.0.2.bundle.js');
    expect(html).toContain('./vendor/jspdf-4.2.1.umd.min.js');
    expect(html).not.toMatch(/<script[^>]+https?:\/\//i);
    expect(html).not.toMatch(/fonts\.googleapis\.com|fonts\.gstatic\.com/i);
  });

  it('records every shipped dependency with a digest and license', () => {
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.files.length).toBeGreaterThanOrEqual(9);
    for (const file of manifest.files) {
      expect(file.path).toMatch(/^vendor\//);
      expect(file.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(file.version).toBeTruthy();
      expect(file.license).toBeTruthy();
    }
  });
});
```

- [ ] **Step 2: 运行测试并观察正确失败**

Run:

```powershell
npm.cmd test -- tests/hstar-offline-runtime.test.js
```

Expected: FAIL because `vendor/runtime-manifest.json` does not exist and `index.html` still references CDN assets.

- [ ] **Step 3: 固定可从 npm 再生的版本**

Run from `integrations/openshop/`:

```powershell
npm.cmd install --save-exact jspdf@4.2.1 @silvia-odwyer/photon@0.3.3 gif.js@0.2.0 @huggingface/transformers@4.0.0
```

Keep the existing exact `ag-psd@22.0.2`. Do not replace Fabric.js with npm `5.3.0`; the tested upstream runtime is `5.3.1` and must be retained as the separately verified vendored file.

- [ ] **Step 4: 确认锁文件与漏洞结果**

Run:

```powershell
npm.cmd ci
npm.cmd audit --omit=dev
```

Expected: installation succeeds; audit output is recorded. Any production vulnerability blocks the phase and is not waived with `--force`.

- [ ] **Step 5: Commit**

```powershell
git add integrations/openshop/package.json integrations/openshop/package-lock.json integrations/openshop/tests/hstar-offline-runtime.test.js
git commit -m "test: define OpenShop offline runtime contract"
```

## Task 2: 构建可审计的本地浏览器依赖目录

**Files:**
- Create: `integrations/openshop/vendor/fabric-5.3.1.min.js`
- Create: `integrations/openshop/vendor/ag-psd-22.0.2.bundle.js`
- Create: `integrations/openshop/vendor/jspdf-4.2.1.umd.min.js`
- Create: `integrations/openshop/vendor/photon/photon_rs.js`
- Create: `integrations/openshop/vendor/photon/photon_rs_bg.wasm`
- Create: `integrations/openshop/vendor/gif/gif.js`
- Create: `integrations/openshop/vendor/gif/gif.worker.js`
- Create: `integrations/openshop/vendor/transformers/transformers.web.min.js`
- Create: `integrations/openshop/vendor/transformers/ort-wasm-simd-threaded.jsep.mjs`
- Create: `integrations/openshop/vendor/licenses/`
- Create: `integrations/openshop/vendor/runtime-manifest.json`
- Create: `integrations/openshop/scripts/vendor-runtime.mjs`

- [ ] **Step 1: 获取并验证 Fabric.js 5.3.1 一次性源文件**

Run:

```powershell
$target = 'integrations\openshop\vendor\fabric-5.3.1.min.js'
New-Item -ItemType Directory -Force (Split-Path $target) | Out-Null
Invoke-WebRequest 'https://cdnjs.cloudflare.com/ajax/libs/fabric.js/5.3.1/fabric.min.js' -OutFile $target
$sha384 = [Convert]::ToBase64String([Security.Cryptography.SHA384]::HashData([IO.File]::ReadAllBytes((Resolve-Path $target))))
if ($sha384 -ne 'sLpuECXYCB5TUyTbC06pftm/rgurDambREZmV4eRHwEqJzCQtU6lxI2Ve00z4XW5') { throw "Fabric digest mismatch: $sha384" }
```

Expected: the digest exactly matches the SRI already pinned by upstream.

- [ ] **Step 2: 实现确定性 vendor 脚本**

Create `scripts/vendor-runtime.mjs` with a fixed source table. It must copy only these files from exact packages:

```js
const sources = [
  ['node_modules/ag-psd/dist/bundle.js', 'vendor/ag-psd-22.0.2.bundle.js', '22.0.2', 'MIT'],
  ['node_modules/jspdf/dist/jspdf.umd.min.js', 'vendor/jspdf-4.2.1.umd.min.js', '4.2.1', 'MIT'],
  ['node_modules/@silvia-odwyer/photon/photon_rs.js', 'vendor/photon/photon_rs.js', '0.3.3', 'Apache-2.0'],
  ['node_modules/@silvia-odwyer/photon/photon_rs_bg.wasm', 'vendor/photon/photon_rs_bg.wasm', '0.3.3', 'Apache-2.0'],
  ['node_modules/gif.js/dist/gif.js', 'vendor/gif/gif.js', '0.2.0', 'MIT'],
  ['node_modules/gif.js/dist/gif.worker.js', 'vendor/gif/gif.worker.js', '0.2.0', 'MIT'],
  ['node_modules/@huggingface/transformers/dist/transformers.web.min.js', 'vendor/transformers/transformers.web.min.js', '4.0.0', 'Apache-2.0'],
  ['node_modules/@huggingface/transformers/dist/ort-wasm-simd-threaded.jsep.mjs', 'vendor/transformers/ort-wasm-simd-threaded.jsep.mjs', '4.0.0', 'Apache-2.0'],
];
```

For each target, calculate SHA-256 after copying. Include the separately verified Fabric file in `runtime-manifest.json`. Sort manifest entries by target path and write JSON with a trailing newline. Copy each package license to `vendor/licenses/`; reject missing sources, paths outside `integrations/openshop`, or a Fabric SHA-384 mismatch.

- [ ] **Step 3: 增加 vendor 命令并生成产物**

Add:

```json
"vendor:runtime": "node scripts/vendor-runtime.mjs"
```

Run:

```powershell
npm.cmd run vendor:runtime
```

Expected: all local files and `runtime-manifest.json` are generated; no network request occurs in this command.

- [ ] **Step 4: 运行离线契约测试**

Run:

```powershell
npm.cmd test -- tests/hstar-offline-runtime.test.js
```

Expected: the manifest assertion passes; the HTML path assertion still fails until Task 3.

- [ ] **Step 5: Commit**

```powershell
git add integrations/openshop/package.json integrations/openshop/package-lock.json integrations/openshop/scripts/vendor-runtime.mjs integrations/openshop/vendor integrations/openshop/tests/hstar-offline-runtime.test.js
git commit -m "build: vendor OpenShop browser runtime"
```

## Task 3: 切换到本地依赖并收紧 CSP

**Files:**
- Modify: `integrations/openshop/index.html`
- Modify: `integrations/openshop/tests/hstar-offline-runtime.test.js`

- [ ] **Step 1: 扩展失败测试覆盖全部运行路径**

Add assertions for:

```js
expect(html).toContain("_psdLibUrl: './vendor/ag-psd-22.0.2.bundle.js'");
expect(html).toContain("_photonFilterUrl: './vendor/photon/photon_rs.js'");
expect(html).toContain("'./vendor/gif/gif.js'");
expect(html).toContain("workerScript: './vendor/gif/gif.worker.js'");
expect(html).toContain("import('./vendor/transformers/transformers.web.min.js')");
expect(html).not.toMatch(/cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com/i);
expect(html).toMatch(/script-src 'self' 'unsafe-inline' blob:/);
```

- [ ] **Step 2: 运行测试并确认仍因远程路径失败**

Run:

```powershell
npm.cmd test -- tests/hstar-offline-runtime.test.js
```

Expected: FAIL on the first remaining CDN or Google Fonts path.

- [ ] **Step 3: 修改入口和运行时路径**

In `index.html`:

- replace the three remote top-level scripts with local `./vendor/...` scripts;
- remove Google Fonts preconnect and stylesheet;
- use `"Microsoft YaHei UI", "Microsoft YaHei", "Segoe UI", Arial, sans-serif` and `Consolas, "Microsoft YaHei UI", monospace` system stacks;
- replace `_psdLibUrl`, `_photonFilterUrl`, gif.js, gif worker and Transformers imports with the local paths asserted above;
- replace `_precacheCDN()` with `_precacheRuntime()` and cache only local files from the manifest-controlled list;
- replace the remote Open Graph image with `./icon.png`;
- reduce CSP to self-hosted scripts/styles/fonts/images. Keep only the explicit `connect-src` hosts required for model files; do not allow remote executable scripts.

- [ ] **Step 4: 运行定向与上游测试**

Run:

```powershell
npm.cmd test -- tests/hstar-offline-runtime.test.js
npm.cmd test
npm.cmd run test:e2e
```

Expected: offline contract passes; all 32 existing unit tests and 6 upstream browser tests remain green.

- [ ] **Step 5: Commit**

```powershell
git add integrations/openshop/index.html integrations/openshop/tests/hstar-offline-runtime.test.js
git commit -m "feat: load OpenShop runtime locally"
```

## Task 4: 建立显式国际化运行时

**Files:**
- Create: `integrations/openshop/host/openshop-i18n.js`
- Create: `integrations/openshop/locales/zh-CN.js`
- Create: `integrations/openshop/tests/hstar-i18n.test.js`
- Modify: `integrations/openshop/index.html`

- [ ] **Step 1: 写国际化运行时失败测试**

The test must assert:

```js
expect(i18n.DEFAULT_LOCALE).toBe('zh-CN');
expect(i18n.t('Layer')).toBe('图层');
expect(i18n.t('Created {width} × {height} canvas', {width:1920, height:1080}))
  .toBe('已创建 1920 × 1080 画布');
expect(i18n.t('Unknown application key')).toBe('Unknown application key');
expect(document.documentElement.lang).toBe('zh-CN');
```

Also create DOM nodes carrying `data-i18n`, `data-i18n-title`, `data-i18n-placeholder`, `data-i18n-aria-label`, and `data-i18n-tip`, call `translateTree()`, and assert that text and attributes are translated without changing an unmarked text node containing `User layer English text`.

- [ ] **Step 2: 运行测试并观察缺少运行时的失败**

Run:

```powershell
npm.cmd test -- tests/hstar-i18n.test.js
```

Expected: FAIL because `HstarOpenShopI18n` is undefined.

- [ ] **Step 3: 实现浏览器国际化 API**

Expose this immutable public surface:

```js
window.HstarOpenShopI18n = Object.freeze({
  DEFAULT_LOCALE: 'zh-CN',
  FALLBACK_LOCALE: 'en-US',
  register,
  t,
  getLocale,
  setLocale,
  translateTree,
  startObserver,
  stopObserver,
});
```

Rules:

- message IDs are stable English source phrases;
- interpolation only replaces named `{token}` placeholders from own properties;
- missing Chinese entries fall back to the English key;
- locale resolution order is `?lang=` override, persisted `openshop_locale`, then `zh-CN`;
- only supported values `zh-CN` and `en-US` are accepted;
- `en-US` returns the English key unchanged;
- `translateTree()` only mutates explicit `data-i18n*` targets;
- the MutationObserver only handles newly inserted explicit targets and never scans arbitrary text nodes.

- [ ] **Step 4: 注册最小中文语言包并加载运行时**

Create `locales/zh-CN.js` with the tested seed messages and a `register('zh-CN', messages)` call. Load `openshop-i18n.js` and `zh-CN.js` before the core `const OS` script. Replace the existing `_locales`, `_lang`, `_t`, `_initI18n`, and `setLocale` implementation with delegation to `HstarOpenShopI18n`.

- [ ] **Step 5: 运行定向测试**

Run:

```powershell
npm.cmd test -- tests/hstar-i18n.test.js
```

Expected: PASS with no mutation of the unmarked user text.

- [ ] **Step 6: Commit**

```powershell
git add integrations/openshop/host/openshop-i18n.js integrations/openshop/locales/zh-CN.js integrations/openshop/tests/hstar-i18n.test.js integrations/openshop/index.html
git commit -m "feat: add OpenShop localization runtime"
```

## Task 5: 固定中文版 Photoshop 术语与翻译审计

**Files:**
- Create: `integrations/openshop/locales/photoshop-zh-CN-glossary.json`
- Create: `integrations/openshop/scripts/audit-i18n.mjs`
- Modify: `integrations/openshop/locales/zh-CN.js`
- Modify: `integrations/openshop/package.json`
- Modify: `integrations/openshop/tests/hstar-i18n.test.js`

- [ ] **Step 1: 创建受测试约束的术语表**

The JSON must contain at least these exact pairs:

```json
{
  "File": "文件",
  "Edit": "编辑",
  "Image": "图像",
  "Layer": "图层",
  "Select": "选择",
  "Filter": "滤镜",
  "View": "视图",
  "Move Tool": "移动工具",
  "Rectangular Marquee Tool": "矩形选框工具",
  "Lasso Tool": "套索工具",
  "Magic Wand Tool": "魔棒工具",
  "Crop Tool": "裁剪工具",
  "Eyedropper Tool": "吸管工具",
  "Brush Tool": "画笔工具",
  "Eraser Tool": "橡皮擦工具",
  "Clone Stamp Tool": "仿制图章工具",
  "Layers": "图层",
  "Properties": "属性",
  "History": "历史记录",
  "Navigator": "导航器",
  "Opacity": "不透明度",
  "Blend Mode": "混合模式"
}
```

- [ ] **Step 2: 写审计测试并观察失败**

Extend `hstar-i18n.test.js` to compare every glossary entry to the registered Chinese dictionary. Run the test and confirm it fails before populating the dictionary.

- [ ] **Step 3: 实现静态审计脚本**

`audit-i18n.mjs` must:

1. load the Chinese dictionary in a VM browser context;
2. extract keys from `_t('...')` and all `data-i18n*="..."` attributes;
3. fail on missing or empty Chinese values;
4. fail on duplicate keys with conflicting values;
5. fail on known mojibake patterns `锟斤拷`, `鐢`, `鍥`, `绗`, `Ã`, `â€` in shipped UI files;
6. fail on direct string literals in `toast()`, `window.alert()`, `window.confirm()` and application modal headings unless the value is wrapped by `_t()`;
7. print key count, translated count and glossary count.

Add:

```json
"audit:i18n": "node scripts/audit-i18n.mjs"
```

- [ ] **Step 4: 运行审计并记录完整缺口清单**

Run:

```powershell
npm.cmd run audit:i18n
```

Expected: FAIL and list concrete missing keys/direct literals. Preserve this output as the work list for Tasks 6 and 7; do not weaken the scanner to make it pass.

- [ ] **Step 5: Commit**

```powershell
git add integrations/openshop/locales integrations/openshop/scripts/audit-i18n.mjs integrations/openshop/package.json integrations/openshop/tests/hstar-i18n.test.js
git commit -m "test: define OpenShop Chinese terminology"
```

## Task 6: 汉化静态工作区和无障碍文本

**Files:**
- Modify: `integrations/openshop/index.html`
- Modify: `integrations/openshop/locales/zh-CN.js`
- Modify: `integrations/openshop/tests/openshop.e2e.spec.js`
- Create: `integrations/openshop/tests/hstar-localization.e2e.spec.js`

- [ ] **Step 1: 写默认中文浏览器失败测试**

Navigate to the served OpenShop page without a language query and assert the visible/accessible names for:

```js
await expect(page.getByRole('menuitem', {name:'文件'})).toBeVisible();
await expect(page.getByRole('menuitem', {name:'编辑'})).toBeVisible();
await expect(page.getByRole('menuitem', {name:'图像'})).toBeVisible();
await expect(page.getByRole('menuitem', {name:'图层'})).toBeVisible();
await expect(page.getByRole('menuitem', {name:'选择'})).toBeVisible();
await expect(page.getByRole('menuitem', {name:'滤镜'})).toBeVisible();
await expect(page.getByRole('button', {name:/移动工具/})).toBeVisible();
await expect(page.getByRole('dialog', {name:'欢迎使用 OpenShop'})).toBeVisible();
await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
```

Also collect every visible `title`, `aria-label`, placeholder, menu item, panel tab, tool label and status label. Fail when a value contains ASCII words not present in a narrow technical allowlist: `OpenShop`, `RGB`, `CMYK`, `HSL`, `HEX`, `PNG`, `JPEG`, `WebP`, `PSD`, `PDF`, `SVG`, `GIF`, `AI`, `px`, `fps`.

- [ ] **Step 2: 运行测试并观察英文界面失败**

Run:

```powershell
npm.cmd run test:hstar:localization
```

Expected: FAIL on the first untranslated menu or accessible label.

- [ ] **Step 3: 标记并翻译静态界面**

Add explicit `data-i18n*` keys for all static application UI in `index.html`, including:

- top menus and menu dropdowns;
- toolbar labels and shortcuts;
- tool options;
- welcome dialog and templates;
- Layers/Properties/Align/Color/Swatches/History/Navigator/Info panels;
- timeline, macro panel, command palette, context menu and status bar;
- `title`, `aria-label`, `aria-roledescription`, placeholders and `data-tip`.

Populate every referenced key in `zh-CN.js` with Photoshop-consistent translations. Preserve shortcuts, numeric values, format names and user content.

- [ ] **Step 4: 保留上游英文回归模式**

Change only the upstream E2E URL to append `?lang=en-US`. Keep its six assertions and snapshot in English so the original suite remains comparable. The new Hstar localization suite tests default Chinese.

- [ ] **Step 5: 运行静态汉化和上游回归**

Run:

```powershell
npm.cmd run audit:i18n
npm.cmd run test:hstar:localization -- --grep "static shell"
npm.cmd run test:e2e
```

Expected: static shell test and original 6 tests pass; audit may still list dynamic messages handled in Task 7.

- [ ] **Step 6: Commit**

```powershell
git add integrations/openshop/index.html integrations/openshop/locales/zh-CN.js integrations/openshop/tests/openshop.e2e.spec.js integrations/openshop/tests/hstar-localization.e2e.spec.js integrations/openshop/package.json
git commit -m "feat: localize OpenShop workspace"
```

## Task 7: 汉化动态对话框、状态、错误和历史记录

**Files:**
- Modify: `integrations/openshop/index.html`
- Modify: `integrations/openshop/locales/zh-CN.js`
- Modify: `integrations/openshop/tests/hstar-localization.e2e.spec.js`

- [ ] **Step 1: 扩展动态界面失败测试**

Exercise and assert Chinese text for at least:

- new image, resize canvas and preferences dialogs;
- open/save/import/export success and validation errors using controlled mock files;
- add/duplicate/lock/unlock/delete layer actions;
- selection, crop, transform and filter panels;
- undo/redo limits and visible history action names;
- auto-save recovery, macro recording, GIF export fallback and AI progress/error states;
- tooltips and accessible canvas state after switching tools and layers.

The test must also create a text object named `User English Layer` containing `Do not translate me` and assert both strings remain unchanged after dialogs and locale changes.

- [ ] **Step 2: 运行动态测试并确认失败**

Run:

```powershell
npm.cmd run test:hstar:localization -- --grep "dynamic UI"
```

Expected: FAIL on untranslated runtime text.

- [ ] **Step 3: 将动态消息改为显式消息键**

Replace direct UI literals with `_t(key, params)` and add matching Chinese entries. For dynamic modal HTML, interpolate only already escaped translated labels. Keep internal action IDs stable in English, but translate them when rendering History, macros, accessibility summaries and toasts.

Use named parameters, for example:

```js
this.toast(this._t('Created {width} × {height} canvas', {width:w, height:h}), 'success');
this.toast(this._t('Selected {count} px', {count:count.toLocaleString()}), 'info');
```

Never call `_t()` on layer names, text object contents, filenames, prompts, user API errors containing arbitrary upstream text, or imported project data. Prefix sanitized upstream errors with a translated stable label instead.

- [ ] **Step 4: 使翻译审计归零**

Run:

```powershell
npm.cmd run audit:i18n
```

Expected: exit `0`; every extracted key translated; glossary count matches; no mojibake and no forbidden direct UI literal.

- [ ] **Step 5: 运行动态和单元回归**

Run:

```powershell
npm.cmd run test:hstar:localization
npm.cmd test
```

Expected: localization E2E passes; all unit tests pass.

- [ ] **Step 6: Commit**

```powershell
git add integrations/openshop/index.html integrations/openshop/locales/zh-CN.js integrations/openshop/tests/hstar-localization.e2e.spec.js
git commit -m "feat: localize OpenShop dynamic UI"
```

## Task 8: 语言设置、确定性构建与真正断网门槛

**Files:**
- Modify: `integrations/openshop/index.html`
- Modify: `integrations/openshop/scripts/build-hstar.mjs`
- Modify: `integrations/openshop/package.json`
- Modify: `integrations/openshop/package-lock.json`
- Modify: `integrations/openshop/tests/hstar-localization.e2e.spec.js`
- Modify: `tools/tests/openshop-foundation-build.test.mjs`
- Create: `tools/tests/openshop-localization-build.test.mjs`

- [ ] **Step 1: 增加语言设置失败测试**

Open Preferences, switch to English, and assert the menu changes to `File` and `localStorage.openshop_locale === 'en-US'`. Reload without a query and verify English persists. Navigate with `?lang=zh-CN` and verify the query overrides persistence without overwriting the stored preference.

- [ ] **Step 2: 实现语言设置**

Add an “界面语言” select in Preferences with `简体中文` and `English`. Call `HstarOpenShopI18n.setLocale()` and rerender application-owned UI. The default remains `zh-CN`; there is no locale-dependent project serialization.

- [ ] **Step 3: 扩展确定性静态构建**

Update `build-hstar.mjs` to copy exactly:

```text
index.html
icon.png
LICENSE
host/openshop-protocol.js
host/openshop-project-adapter.js
host/openshop-host-runtime.js
host/openshop-i18n.js
locales/zh-CN.js
vendor/runtime-manifest.json
vendor/** approved runtime files
vendor/licenses/**
```

The destination safety guard remains unchanged. The build must not copy `node_modules`, tests, source maps, reports, caches, model weights or Markdown research files.

- [ ] **Step 4: 建立 HstarA 构建镜像测试**

`tools/tests/openshop-localization-build.test.mjs` must verify all required files exist under `static/openshop`, their SHA-256 values match the manifest, `index.html` contains no remote executable URL or Google Font, and the Chinese locale contains the glossary values.

- [ ] **Step 5: 增加断网浏览器测试**

In the Hstar localization suite, route every request. Abort any URL whose origin is not the current HstarA origin, record the URL, then load the editor, dismiss the welcome dialog, create a canvas, add a generated raster layer, run a built-in filter, undo/redo, open Preferences and export a PNG preview without invoking AI models.

Assert:

```js
expect(blockedExternalRequests).toEqual([]);
expect(pageErrors).toEqual([]);
expect(result.layerCount).toBeGreaterThan(0);
expect(result.previewBytes).toBeGreaterThan(100);
```

- [ ] **Step 6: 运行构建和断网门槛**

Run:

```powershell
npm.cmd run vendor:runtime
npm.cmd run build:hstar
node tools/tests/openshop-foundation-build.test.mjs
node tools/tests/openshop-localization-build.test.mjs
npm.cmd run test:hstar:localization
```

Expected: deterministic rebuild has no diff; root build tests and localization/offline E2E pass.

- [ ] **Step 7: Commit**

```powershell
git add integrations/openshop/index.html integrations/openshop/scripts/build-hstar.mjs integrations/openshop/package.json integrations/openshop/package-lock.json integrations/openshop/tests/hstar-localization.e2e.spec.js static/openshop tools/tests/openshop-foundation-build.test.mjs tools/tests/openshop-localization-build.test.mjs
git commit -m "build: ship localized OpenShop runtime"
```

## Task 9: 视觉检查、全量回归与阶段报告

**Files:**
- Create: `docs/validation/2026-07-14-openshop-localization-validation.md`

- [ ] **Step 1: 在桌面和移动视口执行视觉检查**

Use Playwright screenshots at `1440 x 1000`, `1920 x 1080`, `375 x 667`, and `430 x 932`. Inspect top menus, toolbar, options, panels, welcome, Preferences, New Image, filter dialog and command palette. Confirm no overlap, clipping, unreadable Chinese, inconsistent spacing or off-screen controls.

- [ ] **Step 2: 运行全部 OpenShop 测试**

Run:

```powershell
npm.cmd run audit:i18n
npm.cmd test
npm.cmd run test:e2e
npm.cmd run test:hstar:e2e
npm.cmd run test:hstar:localization
```

Expected: every command exits `0`; original six upstream tests remain separately reported.

- [ ] **Step 3: 运行 HstarA 全量检查**

Run from HstarA root:

```powershell
node --test tools/tests/*.test.mjs
node tools/tests/text-encoding-health.test.mjs
node tools/tests/hstarc-health-check.mjs
git diff --check
```

Expected: zero failures, zero encoding violations and no root runtime logs/caches.

- [ ] **Step 4: 编写阶段验证报告**

Record only observed values under these headings:

```markdown
# OpenShop Localization and Offline Runtime Validation

## Runtime dependencies
- Exact package versions, manifest file count, checksum result and production audit result.

## Localization
- Translation key count, translated count, glossary count, default locale and English fallback result.

## Offline gate
- Served URL, blocked external request list, editor operation results and page errors.

## Visual gate
- Viewports inspected and any corrected layout issues.

## Regression
- Unit, original Playwright, Hstar Playwright and HstarA root test counts.

## Decision
- `CONTINUE` only if localization audit, offline gate and all regressions pass.
```

- [ ] **Step 5: Commit report**

```powershell
git add docs/validation/2026-07-14-openshop-localization-validation.md
git commit -m "docs: validate localized OpenShop runtime"
```

- [ ] **Step 6: 确认阶段完成状态**

Run:

```powershell
git status --short
git log --oneline -12
```

Expected: clean worktree and a validation report decision of `CONTINUE`. Do not begin canvas node/project persistence work until this gate is green.
