# OpenShop Font Catalog And Artistic Text Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make OpenShop's 2,500-plus-font workflow responsive and correctly grouped, preserve each OCR block's visual properties with free-commercial local-font matching, and add a durable AI artistic-font restoration action for edited OCR text layers.

**Architecture:** The Python font catalog remains the authority for installed family/face normalization and free-commercial classification; the browser font manager owns section ordering, OCR matching, and nearest-face selection; the text-properties controller renders a fixed-row virtual list. OCR records retain a validated visual profile and source provenance, while `art-font-restore` uses the existing project-scoped AI registry so work continues outside the visible editor and is reconciled into a transparent raster layer when the same node project returns.

**Tech Stack:** Python 3, FastAPI/Pydantic, Pillow, vanilla JavaScript, Fabric.js, Vitest/JSDOM, Node contract harnesses, Playwright.

---

## File Map

- Modify `openshop_fonts.py`: resolve registry files, discard stale entries, canonicalize installer aliases, classify `01免`/`02免`/`03免`, and emit stable sort metadata.
- Modify `tests/test_openshop_fonts.py`: server catalog classification, alias, stale-file, and fallback-family tests.
- Modify `integrations/openshop/host/openshop-font-catalog.js`: retain server metadata, build ordered row sections, restrict OCR matching to the correct free-commercial pool, and choose the nearest real face.
- Modify `integrations/openshop/tests/hstar-font-catalog.test.js`: section ordering, category isolation, alias collapse, fallback, and nearest-face tests.
- Modify `integrations/openshop/host/openshop-text-properties.js`: fixed-row virtual font viewport, delegated selection, and dropdown-local scrolling.
- Modify `integrations/openshop/host/openshop-text-properties.css`: stable viewport geometry, spacers, headers, rows, and containment.
- Modify `integrations/openshop/tests/hstar-text-properties.test.js`: bounded DOM, no `scrollIntoView`, delegated selection, outside close, and stable parent scroll tests.
- Modify `integrations/openshop/tests/hstar-editor-interaction-reliability.e2e.spec.js`: 2,500-font responsiveness and panel-geometry browser test.
- Modify `openshop_ai.py`: richer OCR schema, `art-font-restore` catalog/record contract, and request snapshot validation.
- Modify `openshop_image_ops.py`: crop the OCR style reference and validate/pad transparent artistic-font output without stretching glyphs.
- Modify `main.py`: validate and run artistic-font image tasks, persist normalized PNG output, and expose result geometry.
- Modify `tools/tests/openshop-ai-contract.test.mjs`: OCR visual-profile and artistic-task normalization tests.
- Modify `tools/tests/openshop-ai-api.test.mjs`: artistic image request, exact edited text, transparent result, and failure behavior.
- Modify `integrations/openshop/host/openshop-text-tools.js`: apply full OCR typography, persist provenance, render the independent artistic model selector, start/restore artistic tasks, and insert output layers.
- Modify `integrations/openshop/host/openshop-project-adapter.js`: serialize and restore OCR source asset, quad, visual profile, and artistic task metadata.
- Modify `integrations/openshop/index.html`: add the enabled/disabled artistic-font refresh action to every text-layer row and dispatch it to the text-tools controller.
- Modify `integrations/openshop/tests/hstar-text-tools.test.js`: non-distorting OCR application, model preference, eligibility, current-text request, layer insertion, failure, deduplication, and restore tests.
- Modify `integrations/openshop/tests/hstar-project-adapter.test.js`: source provenance and artistic task persistence tests.
- Modify `integrations/openshop/tests/hstar-text-tools.e2e.spec.js`: end-to-end OCR matching, edited artistic text, close/reopen reconciliation, Undo, and node isolation.
- Modify `integrations/openshop/scripts/build-hstar.mjs` only if a new runtime file is introduced; the implementation below keeps the existing runtime file set unchanged.
- Regenerate `static/openshop/**` only through `npm.cmd --prefix integrations\openshop run build:hstar`.

### Task 1: Normalize And Classify The Windows Font Catalog

**Files:**
- Modify: `openshop_fonts.py`
- Modify: `tests/test_openshop_fonts.py`
- Test: `tests/test_openshop_fonts.py`

- [ ] **Step 1: Write failing server catalog tests**

Add these cases to `OpenShopFontCatalogTests`:

```python
def test_emits_authoritative_free_commercial_metadata(self):
    from openshop_fonts import OpenShopFontCatalog

    catalog = OpenShopFontCatalog(
        enumerator=lambda: [
            {"family": "思源黑体", "weight": 400, "italic": False},
            {"family": "01免霞鹜文楷", "weight": 400, "italic": False},
            {"family": "02免源云明体", "weight": 400, "italic": False},
            {"family": "03免Libre Baskerville", "weight": 400, "italic": False},
        ],
        platform="win32",
    )

    fonts = {item["family"]: item for item in catalog.get_catalog()["fonts"]}
    self.assertEqual(fonts["思源黑体"]["languageGroup"], "zh-hans")
    self.assertEqual(fonts["思源黑体"]["freeCommercialCategory"], "")
    self.assertEqual(fonts["01免霞鹜文楷"]["languageGroup"], "zh-hans")
    self.assertEqual(fonts["01免霞鹜文楷"]["freeCommercialCategory"], "01")
    self.assertEqual(fonts["02免源云明体"]["languageGroup"], "zh-hant")
    self.assertEqual(fonts["02免源云明体"]["freeCommercialCategory"], "02")
    self.assertEqual(fonts["03免Libre Baskerville"]["languageGroup"], "en")
    self.assertEqual(fonts["03免Libre Baskerville"]["freeCommercialCategory"], "03")
    self.assertEqual(fonts["03免Libre Baskerville"]["sortName"], "Libre Baskerville")

def test_collapses_installer_aliases_without_merging_removed_fallback(self):
    from openshop_fonts import OpenShopFontCatalog

    catalog = OpenShopFontCatalog(
        enumerator=lambda: [
            {"family": "01免Example Sans", "weight": 400, "italic": False},
            {"family": "01免Example Sans Regular [123]", "weight": 400, "italic": False},
            {"family": "01免Example Sans Bold [other-12]", "weight": 700, "italic": False},
            {"family": "阿里巴巴普惠体 3.0", "weight": 400, "italic": False},
        ],
        platform="win32",
    )

    fonts = {item["family"]: item for item in catalog.get_catalog()["fonts"]}
    self.assertEqual(set(fonts), {"01免Example Sans", "阿里巴巴普惠体 3.0"})
    self.assertEqual(
        [(item["weight"], item["label"]) for item in fonts["01免Example Sans"]["styles"]],
        [(400, "Regular"), (700, "Bold")],
    )
    self.assertNotIn("阿里巴巴普惠体 3", fonts)

def test_registry_refresh_excludes_missing_backing_files(self):
    from openshop_fonts import _enumerate_windows_registry_faces

    entries = [
        ("01免Available (TrueType)", r"C:\Fonts\available.ttf", 1),
        ("01免Removed (TrueType)", r"C:\Fonts\removed.ttf", 1),
    ]
    fake_winreg = self._fake_registry(entries)
    with patch.dict(sys.modules, {"winreg": fake_winreg}), patch(
        "openshop_fonts.os.path.isfile",
        side_effect=lambda path: path.casefold().endswith("available.ttf"),
    ):
        faces = _enumerate_windows_registry_faces()

    self.assertEqual([face["family"] for face in faces], ["01免Available"])

@staticmethod
def _fake_registry(entries):
    local_machine = object()
    current_user = object()

    class RegistryKey:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

    def open_key(hive, _path):
        if hive is current_user:
            raise OSError("missing user font key")
        return RegistryKey()

    return SimpleNamespace(
        HKEY_LOCAL_MACHINE=local_machine,
        HKEY_CURRENT_USER=current_user,
        OpenKey=open_key,
        QueryInfoKey=lambda _key: (0, len(entries), 0),
        EnumValue=lambda _key, index: entries[index],
    )
```

Use `_fake_registry(entries)` in both registry tests. Wrap the existing collection-name test's registry call in `patch("openshop_fonts.os.path.isfile", return_value=True)` so its synthetic `.ttc` and `.ttf` records remain available after stale-file filtering is introduced.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```powershell
python -m unittest tests.test_openshop_fonts.OpenShopFontCatalogTests -v
```

Expected: FAIL because catalog records do not contain `languageGroup`, `freeCommercialCategory`, or `sortName`, installer disambiguators remain separate, and registry entries are not checked against their backing files.

- [ ] **Step 3: Implement canonical metadata and stale-file filtering**

Add these constants and helpers near the existing suffix expressions in `openshop_fonts.py`:

```python
import os

FREE_COMMERCIAL_PREFIX = re.compile(r"^(?P<category>0[123])免\s*")
INSTALLER_DISAMBIGUATOR = re.compile(r"\s*\[(?:\d+|other-\d+)\]\s*$", re.IGNORECASE)
CJK_TEXT = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]")


def _strip_installer_disambiguator(value):
    return INSTALLER_DISAMBIGUATOR.sub("", str(value or "")).strip()


def _font_metadata(family):
    display = _strip_installer_disambiguator(family)
    match = FREE_COMMERCIAL_PREFIX.match(display)
    category = match.group("category") if match else ""
    sort_name = display[match.end():].strip() if match else display
    if category == "01":
        language_group = "zh-hans"
    elif category == "02":
        language_group = "zh-hant"
    elif category == "03":
        language_group = "en"
    else:
        language_group = "zh-hans" if CJK_TEXT.search(sort_name) else "en"
    return {
        "languageGroup": language_group,
        "freeCommercialCategory": category,
        "sortName": sort_name or display,
    }
```

Call `_strip_installer_disambiguator()` before `_font_family_for_face()`. When emitting each normalized family, merge `_font_metadata(value["family"])` into the family record while leaving every real style's `family` and `localNames` usable.

Resolve registry values and skip stale files inside `_enumerate_windows_registry_faces()`:

```python
def _registry_font_path(hive, file_value, winreg_module):
    value = os.path.expandvars(str(file_value or "").strip())
    if not value:
        return ""
    if os.path.isabs(value):
        return os.path.normpath(value)
    if hive is winreg_module.HKEY_CURRENT_USER:
        root = os.path.join(os.environ.get("LOCALAPPDATA", ""), "Microsoft", "Windows", "Fonts")
    else:
        root = os.path.join(os.environ.get("WINDIR", r"C:\Windows"), "Fonts")
    return os.path.normpath(os.path.join(root, value))
```

Immediately after `EnumValue`, resolve the path and `continue` when it is empty or `os.path.isfile(path)` is false. Keep paths internal; the public catalog must continue to expose no path or binary data.

- [ ] **Step 4: Run all font server tests and verify GREEN**

Run:

```powershell
python -m unittest tests.test_openshop_fonts -v
```

Expected: all OpenShop font catalog and endpoint tests PASS.

- [ ] **Step 5: Commit the server catalog unit**

```powershell
git add openshop_fonts.py tests/test_openshop_fonts.py
git commit -m "feat: normalize openshop font catalog metadata"
```

### Task 2: Build Ordered Font Sections And Free-Commercial OCR Matching

**Files:**
- Modify: `integrations/openshop/host/openshop-font-catalog.js`
- Modify: `integrations/openshop/tests/hstar-font-catalog.test.js`
- Test: `integrations/openshop/tests/hstar-font-catalog.test.js`

- [ ] **Step 1: Write failing catalog-section and matcher tests**

Add a shared `loadCatalog(manager, fonts)` helper to the test file, then add:

```javascript
it('orders Chinese and English sections by the confirmed free prefixes', async () => {
  const manager = window.HstarOpenShopFontCatalog.createManager({
    fontProbe:() => true,
    fetchImpl:async () => ({ok:true, json:async () => ({fonts:[
      {family:'03免English Free', label:'03免English Free', languageGroup:'en', freeCommercialCategory:'03', sortName:'English Free'},
      {family:'Arial', label:'Arial', languageGroup:'en', freeCommercialCategory:'', sortName:'Arial'},
      {family:'02免繁體', label:'02免繁體', languageGroup:'zh-hant', freeCommercialCategory:'02', sortName:'繁體'},
      {family:'01免简体', label:'01免简体', languageGroup:'zh-hans', freeCommercialCategory:'01', sortName:'简体'},
      {family:'思源黑体', label:'思源黑体', languageGroup:'zh-hans', freeCommercialCategory:'', sortName:'思源黑体'},
    ]})}),
  });
  await manager.loadSystemFonts();

  expect(manager.catalogRows().map(row => [row.kind, row.key, row.family || ''])).toEqual([
    ['section', 'section-zh', ''],
    ['group', 'group-zh-unprefixed', ''],
    ['font', 'font:思源黑体', '思源黑体'],
    ['group', 'group-01', ''],
    ['font', 'font:01免简体', '01免简体'],
    ['group', 'group-02', ''],
    ['font', 'font:02免繁體', '02免繁體'],
    ['section', 'section-en', ''],
    ['group', 'group-03', ''],
    ['font', 'font:03免English Free', '03免English Free'],
    ['group', 'group-en-unprefixed', ''],
    ['font', 'font:Arial', 'Arial'],
  ]);
});

it('matches each OCR block only inside its free-commercial pool', async () => {
  const manager = window.HstarOpenShopFontCatalog.createManager({
    fontProbe:() => true,
    fetchImpl:async () => ({ok:true, json:async () => ({fonts:[
      {family:'01免Poster Sans', languageGroup:'zh-hans', freeCommercialCategory:'01', sortName:'Poster Sans', styles:[
        {id:'poster-light', family:'01免Poster Sans Light', label:'Light', weight:300, italic:false},
        {id:'poster-bold', family:'01免Poster Sans Bold', label:'Bold', weight:700, italic:false},
      ]},
      {family:'02免Poster Sans', languageGroup:'zh-hant', freeCommercialCategory:'02', sortName:'Poster Sans'},
      {family:'03免Poster Sans', languageGroup:'en', freeCommercialCategory:'03', sortName:'Poster Sans'},
      {family:'阿里巴巴普惠体 3.0', languageGroup:'zh-hans', freeCommercialCategory:'', sortName:'阿里巴巴普惠体 3.0', styles:[
        {id:'alibaba-light', family:'阿里巴巴普惠体 3.0 45 Light', label:'Light', weight:300, italic:false},
        {id:'alibaba-heavy', family:'阿里巴巴普惠体 3.0 85 Heavy', label:'Heavy', weight:850, italic:false},
      ]},
    ]})}),
  });
  await manager.loadSystemFonts();

  expect(manager.matchOcrFont({script:'zh-hans', font:{familyCandidates:['Poster Sans'], weight:680, style:'normal'}})).toMatchObject({
    family:'01免Poster Sans', faceFamily:'01免Poster Sans Bold', weight:700, italic:false,
  });
  expect(manager.matchOcrFont({script:'zh-hant', font:{familyCandidates:['Poster Sans'], weight:400, style:'normal'}}).family).toBe('02免Poster Sans');
  expect(manager.matchOcrFont({script:'en', font:{familyCandidates:['Poster Sans'], weight:400, style:'normal'}}).family).toBe('03免Poster Sans');
  expect(manager.matchOcrFont({script:'zh-hans', font:{artistic:true, weight:820, style:'normal'}})).toMatchObject({
    family:'阿里巴巴普惠体 3.0', faceFamily:'阿里巴巴普惠体 3.0 85 Heavy', weight:850,
  });
});

it('reports a missing Alibaba 3.0 fallback instead of choosing an unrelated font', async () => {
  const manager = window.HstarOpenShopFontCatalog.createManager({
    fontProbe:() => true,
    fetchImpl:async () => ({ok:true, json:async () => ({fonts:[
      {family:'01免Unrelated Serif', languageGroup:'zh-hans', freeCommercialCategory:'01', sortName:'Unrelated Serif'},
    ]})}),
  });
  await manager.loadSystemFonts();

  expect(() => manager.matchOcrFont({script:'zh-hans', font:{familyCandidates:['Unknown Sans'], weight:400}}))
    .toThrow('阿里巴巴普惠体 3.0');
});

it('keeps a missing project font visible but excludes it from automatic matching', async () => {
  const manager = window.HstarOpenShopFontCatalog.createManager({
    fontProbe:family => family !== 'Missing Poster Font',
    fetchImpl:async () => ({ok:true, json:async () => ({fonts:[]})}),
  });
  await manager.loadSystemFonts();
  manager.scanEditor({
    __hstarFontRefs:[{family:'Missing Poster Font', status:'missing'}],
    canvas:{getObjects:() => []},
  });

  expect(manager.catalogRows().find(row => row.family === 'Missing Poster Font')?.font.status).toBe('missing');
  expect(() => manager.matchOcrFont({script:'en', font:{familyCandidates:['Missing Poster Font'], weight:400}}))
    .toThrow('阿里巴巴普惠体 3.0');
});
```

- [ ] **Step 2: Run the client catalog tests and verify RED**

Run:

```powershell
npm.cmd --prefix integrations\openshop test -- hstar-font-catalog.test.js
```

Expected: FAIL because `catalogRows()` and `matchOcrFont()` do not exist and server metadata is discarded by `normalizeFont()`.

- [ ] **Step 3: Retain metadata and implement deterministic row construction**

Extend `normalizeFont()` and `cloneFont()` with `languageGroup`, `freeCommercialCategory`, and `sortName`. Infer these fields for project-only references so missing fonts remain visible, stripping the free prefix before any CJK test:

```javascript
function inferredMetadata(value){
  const family = cleanFamily(value?.family);
  const match = /^(0[123])免\s*/u.exec(family);
  const category = cleanFamily(value?.freeCommercialCategory) || match?.[1] || '';
  const sortName = cleanFamily(value?.sortName) || family.slice(match?.[0]?.length || 0).trim() || family;
  const supplied = cleanFamily(value?.languageGroup).toLowerCase();
  const languageGroup = supplied
    || (category === '01' ? 'zh-hans' : category === '02' ? 'zh-hant' : category === '03' ? 'en' : CJK_RE.test(sortName) ? 'zh-hans' : 'en');
  return {languageGroup, freeCommercialCategory:category, sortName};
}
```

Merge `inferredMetadata(value)` into every `normalizeFont()` result. Replace the CJK-only sorter with category-aware row construction:

```javascript
const GROUPS = [
  {section:'zh', key:'zh-unprefixed', label:'常用中文', test:font => font.languageGroup.startsWith('zh') && !font.freeCommercialCategory},
  {section:'zh', key:'01', label:'01免 简体中文', test:font => font.freeCommercialCategory === '01'},
  {section:'zh', key:'02', label:'02免 繁体中文', test:font => font.freeCommercialCategory === '02'},
  {section:'en', key:'03', label:'03免 英文字体', test:font => font.freeCommercialCategory === '03'},
  {section:'en', key:'en-unprefixed', label:'其他英文字体', test:font => font.languageGroup === 'en' && !font.freeCommercialCategory},
];

function buildCatalogRows(fonts){
  const rows = [];
  for(const section of [{key:'zh', label:'中文字体'}, {key:'en', label:'英文字体'}]){
    const groups = GROUPS.filter(group => group.section === section.key)
      .map(group => ({...group, fonts:fonts.filter(group.test).sort(compareFonts)}))
      .filter(group => group.fonts.length);
    if(!groups.length) continue;
    rows.push({kind:'section', key:`section-${section.key}`, label:section.label});
    groups.forEach(group => {
      rows.push({kind:'group', key:`group-${group.key}`, label:group.label});
      group.fonts.forEach(font => rows.push({kind:'font', key:`font:${font.family}`, family:font.family, font}));
    });
  }
  return rows;
}
```

Cache the row array in manager state and rebuild it only inside `rebuildFonts()`. Return cloned rows from `catalogRows()`.

- [ ] **Step 4: Implement pool-restricted family and face matching**

Add these helpers and expose `matchOcrFont`:

```javascript
const FALLBACK_FAMILY = '阿里巴巴普惠体 3.0';
const SCRIPT_CATEGORY = {'zh-hans':'01', 'zh-hant':'02', en:'03'};

function normalizedMatchName(value){
  return cleanFamily(value)
    .replace(/^(?:01|02|03)免\s*/u, '')
    .replace(/\s*\[(?:\d+|other-\d+)\]\s*$/iu, '')
    .replace(/(?:thin|extra\s*light|light|regular|medium|semi\s*bold|bold|extra\s*bold|heavy|black|italic|oblique)$/iu, '')
    .replace(/[\s._-]+/gu, '')
    .toLocaleLowerCase('zh-CN');
}

function nearestStyle(styles, weight, italic){
  const targetWeight = Math.max(100, Math.min(900, Number(weight) || 400));
  return [...styles].sort((left, right) => (
    (Number(Boolean(left.italic) !== italic) * 1000 + Math.abs(left.weight - targetWeight))
    - (Number(Boolean(right.italic) !== italic) * 1000 + Math.abs(right.weight - targetWeight))
  ))[0] || null;
}

function nameScore(candidate, font){
  const expected = normalizedMatchName(candidate);
  if(!expected) return 0;
  const aliases = new Set([
    font.family, font.label, font.sortName,
    ...font.styles.flatMap(style => [style.family, ...(style.localNames || [])]),
  ].map(normalizedMatchName).filter(Boolean));
  if(aliases.has(expected)) return 1;
  let score = 0;
  aliases.forEach(alias => {
    if(alias.includes(expected) || expected.includes(alias)){
      score = Math.max(score, Math.min(alias.length, expected.length) / Math.max(alias.length, expected.length));
    }
  });
  return score;
}

function descriptorScore(description, font){
  const words = cleanFamily(description).toLocaleLowerCase('en-US').match(/[a-z0-9\u3400-\u9fff]+/gu) || [];
  if(!words.length) return 0;
  const haystack = `${font.family} ${font.label} ${font.sortName}`.toLocaleLowerCase('en-US');
  return words.filter(word => word.length > 2 && haystack.includes(word)).length / words.length;
}
```

Implement the manager method with the same threshold for every script:

```javascript
function matchOcrFont(block = {}){
  const profile = block.font && typeof block.font === 'object' ? block.font : {};
  const italic = profile.style === 'italic';
  const fallbackFont = state.fonts.find(font => font.family === FALLBACK_FAMILY && font.status !== 'missing');
  let selected = null;
  let fallback = Boolean(profile.artistic);
  if(!profile.artistic){
    const category = SCRIPT_CATEGORY[cleanFamily(block.script).toLowerCase()];
    const pool = state.fonts.filter(font => font.freeCommercialCategory === category && font.status !== 'missing');
    const candidates = Array.isArray(profile.familyCandidates) ? profile.familyCandidates : [];
    const ranked = pool.map(font => ({
      font,
      score:Math.max(0, ...candidates.map(candidate => nameScore(candidate, font))) * 0.9
        + descriptorScore(profile.styleDescription, font) * 0.1,
    })).sort((left, right) => right.score - left.score || compareFonts(left.font, right.font));
    if(ranked[0]?.score >= 0.72) selected = ranked[0].font;
    else fallback = true;
  }
  if(!selected) selected = fallbackFont;
  if(!selected) throw new Error('未安装必需的回退字体：阿里巴巴普惠体 3.0');
  const style = nearestStyle(selected.styles, profile.weight, italic);
  if(!style) throw new Error(`字体 ${selected.family} 没有可用字型`);
  return {
    family:selected.family,
    faceFamily:style.family,
    styleId:style.id,
    weight:style.weight,
    italic:style.italic,
    fallback,
  };
}
```

- [ ] **Step 5: Run the focused tests and verify GREEN**

Run:

```powershell
npm.cmd --prefix integrations\openshop test -- hstar-font-catalog.test.js
```

Expected: all font manager tests PASS, including legacy missing-project-font behavior.

- [ ] **Step 6: Commit the client catalog unit**

```powershell
git add integrations/openshop/host/openshop-font-catalog.js integrations/openshop/tests/hstar-font-catalog.test.js
git commit -m "feat: match ocr text with free commercial fonts"
```

### Task 3: Virtualize The Font Dropdown Without Moving The Parent Panel

**Files:**
- Modify: `integrations/openshop/host/openshop-text-properties.js`
- Modify: `integrations/openshop/host/openshop-text-properties.css`
- Modify: `integrations/openshop/tests/hstar-text-properties.test.js`
- Modify: `integrations/openshop/tests/hstar-editor-interaction-reliability.e2e.spec.js`
- Test: `integrations/openshop/tests/hstar-text-properties.test.js`

- [ ] **Step 1: Replace the bulk-render unit assertion with virtual-list assertions**

Change the existing complete-catalog test to use 2,500 font rows and assert:

```javascript
const fonts = Array.from({length:2500}, (_, index) => ({
  family:`03免Test Font ${String(index + 1).padStart(4, '0')}`,
  label:`03免Test Font ${String(index + 1).padStart(4, '0')}`,
  status:'available', styles:[],
}));
fontManager.catalogRows.mockReturnValue([
  {kind:'section', key:'section-en', label:'英文字体'},
  {kind:'group', key:'group-03', label:'03免 英文字体'},
  ...fonts.map(font => ({kind:'font', key:`font:${font.family}`, family:font.family, font})),
]);
const parent = document.querySelector('.right-panel-content');
parent.scrollTop = 137;
Element.prototype.scrollIntoView = vi.fn();

trigger.click();
expect(list.hidden).toBe(false);
expect(list.querySelectorAll('.hstar-font-scroll-space')).toHaveLength(1);
expect(list.querySelectorAll('[data-family]').length).toBeLessThanOrEqual(16);
expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
expect(parent.scrollTop).toBe(137);

list.scrollTop = 1200;
list.dispatchEvent(new Event('scroll'));
await new Promise(resolve => requestAnimationFrame(resolve));
expect(list.querySelectorAll('[data-family]').length).toBeLessThanOrEqual(16);

const visible = list.querySelector('[data-family]');
visible.dispatchEvent(new MouseEvent('click', {bubbles:true}));
expect(textObject.set).toHaveBeenCalledWith({fontFamily:visible.dataset.family});
expect(list.hidden).toBe(true);
```

Also assert that outside `mousedown`, `Escape`, controller destroy, and font refresh cancel any pending animation frame and close the list.

- [ ] **Step 2: Run the text-properties unit test and verify RED**

Run:

```powershell
npm.cmd --prefix integrations\openshop test -- hstar-text-properties.test.js
```

Expected: FAIL because every font row is mounted, `scrollIntoView()` is called, and the parent panel scroll changes.

- [ ] **Step 3: Implement a fixed-row virtual viewport with delegated events**

Add controller constants/state:

```javascript
const FONT_ROW_HEIGHT = 30;
const FONT_VIEWPORT_HEIGHT = 210;
const FONT_OVERSCAN = 4;

state.fontRows = [];
state.fontRenderFrame = 0;
```

Add the local encoder used by the virtual-row template:

```javascript
function escapeHtml(value){
  return String(value ?? '').replace(/[&<>"']/g, character => ({
    '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;',
  })[character]);
}
```

Render only the calculated range:

```javascript
function visibleFontRange(total, scrollTop, viewportHeight = FONT_VIEWPORT_HEIGHT){
  const first = Math.max(0, Math.floor(scrollTop / FONT_ROW_HEIGHT) - FONT_OVERSCAN);
  const count = Math.ceil(viewportHeight / FONT_ROW_HEIGHT) + FONT_OVERSCAN * 2;
  return {first, last:Math.min(total, first + count)};
}

function renderVisibleFontRows(){
  const list = documentRef.querySelector('[data-text-font-list]');
  if(!list || list.hidden) return;
  const {first, last} = visibleFontRange(state.fontRows.length, list.scrollTop, list.clientHeight || FONT_VIEWPORT_HEIGHT);
  const rows = state.fontRows.slice(first, last).map((row, offset) => {
    const top = (first + offset) * FONT_ROW_HEIGHT;
    if(row.kind !== 'font') return `<div class="hstar-font-heading ${row.kind}" data-font-row style="top:${top}px">${escapeHtml(row.label)}</div>`;
    const selected = row.family === state.familyValue;
    const status = row.font.status === 'missing' ? '（缺失）' : '';
    return `<button type="button" class="hstar-font-option" data-family="${escapeHtml(row.family)}" aria-selected="${selected}" style="top:${top}px;font-family:'${escapeHtml(row.family)}'">${escapeHtml(row.font.label || row.family)}${status}</button>`;
  }).join('');
  list.innerHTML = `<div class="hstar-font-scroll-space" data-font-row style="height:${state.fontRows.length * FONT_ROW_HEIGHT}px">${rows}</div>`;
}

function scheduleFontRows(){
  if(state.fontRenderFrame) return;
  state.fontRenderFrame = root.requestAnimationFrame(() => {
    state.fontRenderFrame = 0;
    renderVisibleFontRows();
  });
}
```

On open, assign `state.fontRows = fontManager.catalogRows()`, set only `list.scrollTop` to the selected row offset, and render. Attach one `scroll` listener and one delegated `click` listener to the viewport in `bindPanelControls()`; remove the per-row listeners and every `scrollIntoView()` call.

Use these stable styles:

```css
.hstar-font-list{height:210px;max-height:210px;overflow-y:auto;overflow-x:hidden;contain:layout paint;overscroll-behavior:contain;scrollbar-gutter:stable}
.hstar-font-scroll-space{position:relative;width:100%}
.hstar-font-option,.hstar-font-heading{position:absolute;left:0;right:0;height:30px;box-sizing:border-box;letter-spacing:0}
.hstar-font-option{display:block;width:100%;border:0;border-radius:2px;padding:0 8px;text-align:left;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;background:transparent;color:var(--text-primary)}
.hstar-font-heading{padding:7px 8px 0;color:var(--text-muted);font-size:11px;font-weight:700;background:var(--bg-depth-1)}
```

- [ ] **Step 4: Add a browser performance and geometry test**

In `hstar-editor-interaction-reliability.e2e.spec.js`, intercept `/api/openshop/fonts` with 2,500 deterministic `03免` records, open the dropdown, and capture:

```javascript
const metrics = await page.evaluate(() => {
  const panel = document.querySelector('.right-panel-content');
  const trigger = document.querySelector('[data-text-family]');
  panel.scrollTop = 121;
  const before = panel.getBoundingClientRect();
  const started = performance.now();
  trigger.click();
  const elapsed = performance.now() - started;
  const after = panel.getBoundingClientRect();
  return {
    elapsed,
    mounted:document.querySelectorAll('[data-text-font-list] [data-family]').length,
    parentScrollTop:panel.scrollTop,
    geometry:[before.x, before.y, before.width, before.height, after.x, after.y, after.width, after.height],
  };
});
expect(metrics.elapsed).toBeLessThan(250);
expect(metrics.mounted).toBeLessThanOrEqual(16);
expect(metrics.parentScrollTop).toBe(121);
expect(metrics.geometry.slice(0, 4)).toEqual(metrics.geometry.slice(4));
```

- [ ] **Step 5: Run unit and focused Playwright tests and verify GREEN**

Run:

```powershell
npm.cmd --prefix integrations\openshop test -- hstar-text-properties.test.js
$env:HSTAR_BASE_URL='http://127.0.0.1:3000'; npm.cmd --prefix integrations\openshop exec playwright test tests/hstar-editor-interaction-reliability.e2e.spec.js --grep "font list"
```

Expected: unit tests PASS; with HstarA running on port 3000, the focused browser test PASSes without panel movement or bulk DOM creation.

- [ ] **Step 6: Commit the virtual dropdown unit**

```powershell
git add integrations/openshop/host/openshop-text-properties.js integrations/openshop/host/openshop-text-properties.css integrations/openshop/tests/hstar-text-properties.test.js integrations/openshop/tests/hstar-editor-interaction-reliability.e2e.spec.js
git commit -m "perf: virtualize openshop font dropdown"
```

### Task 4: Preserve The Full OCR Visual Profile Without Glyph Distortion

**Files:**
- Modify: `openshop_ai.py`
- Modify: `tools/tests/openshop-ai-contract.test.mjs`
- Modify: `integrations/openshop/host/openshop-text-tools.js`
- Modify: `integrations/openshop/host/openshop-project-adapter.js`
- Modify: `integrations/openshop/tests/hstar-text-tools.test.js`
- Modify: `integrations/openshop/tests/hstar-project-adapter.test.js`
- Test: `tools/tests/openshop-ai-contract.test.mjs`
- Test: `integrations/openshop/tests/hstar-text-tools.test.js`

- [ ] **Step 1: Write failing OCR contract tests**

Extend the valid OCR fixture in `tools/tests/openshop-ai-contract.test.mjs` with:

```python
"script": "zh-hans",
"font": {
    "familyCandidates": ["Poster Sans"],
    "size": 72,
    "weight": 760,
    "style": "italic",
    "artistic": False,
    "styleDescription": "wide geometric sans with square terminals",
    "letterSpacing": 35,
    "lineHeight": 1.15,
    "strokeColor": "#112233cc",
    "strokeWidth": 2.5,
    "shadow": {"color": "#00000080", "blur": 6, "offsetX": 4, "offsetY": 5},
},
```

Assert the normalized block keeps every field, clamps weight to `800`, and independently defaults only an invalid shadow field. Assert `build_ocr_prompt()` names `script`, `artistic`, `letterSpacing`, `lineHeight`, `strokeColor`, `strokeWidth`, and `shadow`.

- [ ] **Step 2: Run the OCR contract test and verify RED**

Run:

```powershell
node tools/tests/openshop-ai-contract.test.mjs
```

Expected: FAIL because the normalized OCR font contains only candidates, size, weight, and style.

- [ ] **Step 3: Extend and bound the OCR schema**

Update `build_ocr_prompt()` so the model reports script and all visual fields per independently styled block. Add bounded helpers and return this exact normalized shape from `_normalize_font()`:

```python
shadow = font.get("shadow") if isinstance(font.get("shadow"), dict) else {}
return {
    "familyCandidates": candidates,
    "size": max(0.0, min(2000.0, round(size, 2))),
    "weight": max(100, min(900, weight)),
    "style": "italic" if str(font.get("style") or "").lower() == "italic" else "normal",
    "artistic": bool(font.get("artistic")),
    "styleDescription": _clean_text(font.get("styleDescription"), 500),
    "letterSpacing": max(-1000.0, min(2000.0, round(_finite_number(font.get("letterSpacing", 0), "letter spacing"), 2))),
    "lineHeight": max(0.1, min(10.0, round(_finite_number(font.get("lineHeight", 1.16), "line height"), 3))),
    "strokeColor": _normalized_color(font.get("strokeColor"), "#00000000"),
    "strokeWidth": max(0.0, min(100.0, round(_finite_number(font.get("strokeWidth", 0), "stroke width"), 2))),
    "shadow": {
        "color": _normalized_color(shadow.get("color"), "#00000000"),
        "blur": max(0.0, min(200.0, round(_finite_number(shadow.get("blur", 0), "shadow blur"), 2))),
        "offsetX": max(-500.0, min(500.0, round(_finite_number(shadow.get("offsetX", 0), "shadow offsetX"), 2))),
        "offsetY": max(-500.0, min(500.0, round(_finite_number(shadow.get("offsetY", 0), "shadow offsetY"), 2))),
    },
}
```

Define the color helper used above:

```python
def _normalized_color(value: Any, fallback: str) -> str:
    color = str(value or "").strip()
    return color.lower() if _HEX_COLOR_PATTERN.fullmatch(color) else fallback
```

Normalize `script` to `zh-hans`, `zh-hant`, `en`, or `mixed`; infer it from the legacy `language` only when absent. Increment OCR `schemaVersion` to `2` while continuing to accept stored version-1 blocks through the same independent defaults.

- [ ] **Step 4: Write failing client tests for matching and uniform fitting**

Update the rich OCR block fixture in `hstar-text-tools.test.js`, mock `fontManager.matchOcrFont()`, and assert:

```javascript
expect(fontManager.matchOcrFont).toHaveBeenCalledWith(block);
expect(text).toMatchObject({
  fontFamily:'01免Poster Sans Bold',
  fontWeight:700,
  fontStyle:'italic',
  fill:'#7b3f12',
  charSpacing:35,
  lineHeight:1.15,
  stroke:'#112233cc',
  strokeWidth:2.5,
  angle:geometry.angle,
  hstarOcrSourceAssetId:SOURCE_ASSET_ID,
  hstarOcrQuad:block.quad,
  hstarOcrVisualProfile:block.font,
});
expect(text.scaleX).toBeCloseTo(text.scaleY, 8);
expect(text.shadow).toMatchObject({color:'#00000080', blur:6, offsetX:4, offsetY:5});
```

Add a project-adapter round-trip assertion for `hstarOcrSourceAssetId`, `hstarOcrQuad`, and `hstarOcrVisualProfile`, including the source asset in `assetRefs`.

- [ ] **Step 5: Run client tests and verify RED**

Run:

```powershell
npm.cmd --prefix integrations\openshop test -- hstar-text-tools.test.js hstar-project-adapter.test.js
```

Expected: FAIL because OCR uses the first available family, applies separate `scaleX`/`scaleY`, and does not serialize source provenance or effects.

- [ ] **Step 6: Apply local matching, full properties, and uniform fitting**

Replace `fontFamilyForBlock()` with `fontManager.matchOcrFont(block)`. Add a fitting helper that changes spacing first and then uses one scale:

```javascript
function fitTextObjectToQuad(object, geometry){
  object.set?.({scaleX:1, scaleY:1});
  object.initDimensions?.();
  const characters = Math.max(1, [...String(object.text || '')].length - 1);
  const naturalWidth = Math.max(1, Number(object.width || geometry.width));
  const spacingDelta = (geometry.width - naturalWidth) * 1000 / (Math.max(1, object.fontSize) * characters);
  const adjustedSpacing = Math.max(-1000, Math.min(2000, Number(object.charSpacing || 0) + spacingDelta));
  object.set?.({charSpacing:adjustedSpacing});
  object.initDimensions?.();
  const width = Math.max(1, Number(object.width || geometry.width));
  const height = Math.max(1, Number(object.height || geometry.height));
  const uniformScale = Math.min(geometry.width / width, geometry.height / height);
  object.set?.({scaleX:uniformScale, scaleY:uniformScale});
  object.setCoords?.();
}
```

Create `fabricRef.Shadow` from the normalized profile, apply all properties, and persist these custom Fabric fields:

```javascript
hstarOcrSourceAssetId:clean(record?.sourceAssetId),
hstarOcrQuad:clone(block.quad),
hstarOcrVisualProfile:clone(block.font),
hstarOcrOriginalText:text,
```

Add the four names to the custom-property list in `serializeProject()`. Keep `hstarOcrSourceAssetId` discoverable by `collectAssetRefs()` so the original image remains owned by this node project.

- [ ] **Step 7: Run all focused OCR tests and verify GREEN**

Run:

```powershell
node tools/tests/openshop-ai-contract.test.mjs
npm.cmd --prefix integrations\openshop test -- hstar-font-catalog.test.js hstar-text-tools.test.js hstar-project-adapter.test.js
```

Expected: all contract and client tests PASS; every OCR text object has equal X/Y scale and its own nearest weight/style.

- [ ] **Step 8: Commit the OCR visual-profile unit**

```powershell
git add openshop_ai.py tools/tests/openshop-ai-contract.test.mjs integrations/openshop/host/openshop-text-tools.js integrations/openshop/host/openshop-project-adapter.js integrations/openshop/tests/hstar-text-tools.test.js integrations/openshop/tests/hstar-project-adapter.test.js
git commit -m "feat: preserve openshop ocr typography"
```

### Task 5: Add The `art-font-restore` Backend And Transparent Output Pipeline

**Files:**
- Modify: `openshop_ai.py`
- Modify: `openshop_image_ops.py`
- Modify: `main.py`
- Modify: `tools/tests/openshop-ai-contract.test.mjs`
- Modify: `tools/tests/openshop-ai-api.test.mjs`
- Test: `tools/tests/openshop-ai-contract.test.mjs`
- Test: `tools/tests/openshop-ai-api.test.mjs`

- [ ] **Step 1: Write failing artistic task and image-normalization tests**

Add contract assertions that `art-font-restore` appears in `OPENSHOP_AI_TOOL_IDS`, uses image-model providers in `build_capability_catalog()`, and accepts this task snapshot:

```python
snapshot = {
    "textLayerId": "hstar_text_layer_1",
    "ocrBlockId": "ocr-title",
    "originalText": "夏季限定",
    "currentText": "夏日新品",
    "requestGeneration": 3,
    "document": {"width": 1920, "height": 1080},
    "quad": [
        {"x": 0.1, "y": 0.2}, {"x": 0.4, "y": 0.2},
        {"x": 0.4, "y": 0.3}, {"x": 0.1, "y": 0.3},
    ],
    "visualProfile": {
        "size": 72, "weight": 800, "style": "normal", "artistic": True,
        "styleDescription": "inflated hand-painted lettering", "letterSpacing": 20,
        "lineHeight": 1.0, "strokeColor": "#ffffff", "strokeWidth": 4,
        "shadow": {"color": "#00000080", "blur": 8, "offsetX": 3, "offsetY": 5},
    },
}
```

Clone the fixture with `visualProfile.artistic = False` and assert it also normalizes successfully; OCR source provenance, not the classifier flag, is the action's eligibility boundary.

In the API harness, stub `generate_ai_image()` and assert its prompt contains the exact edited string `夏日新品`, not the original OCR string. Add Pillow fixtures for:

1. a valid RGBA glyph image, which remains transparent;
2. an opaque image with one uniform edge-connected matte, which is removed;
3. a multicolored opaque edge, which raises `OpenShopImageNormalizationError` and stores no project asset;
4. an output whose content aspect differs from the OCR quad, which is padded to the target aspect without resizing the glyph pixels non-uniformly.

- [ ] **Step 2: Run backend contract/API tests and verify RED**

Run:

```powershell
node tools/tests/openshop-ai-contract.test.mjs
node tools/tests/openshop-ai-api.test.mjs
```

Expected: FAIL because the tool ID, snapshot normalizer, image crop/alpha helpers, and task branch do not exist.

- [ ] **Step 3: Define the artistic task contract and catalog capability**

In `openshop_ai.py`, add `art-font-restore` to `OPENSHOP_AI_TOOL_IDS` and add a catalog entry using a deep copy of the image providers:

```python
"art-font-restore": {
    "id": "art-font-restore",
    "label": "艺术字体处理",
    "capability": "reference-image-generation-transparent",
    "providers": deepcopy(remove_providers),
},
```

Implement the snapshot normalizer. OCR source provenance controls eligibility; the `artistic` flag influences initial font matching but does not block a user from applying the action to another OCR-derived text layer:

```python
def normalize_art_font_snapshot(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise OpenShopAiValidationError("Art font snapshot must be an object")
    document = value.get("document") if isinstance(value.get("document"), dict) else {}
    width = _positive_dimension(document.get("width"), "art font document width")
    height = _positive_dimension(document.get("height"), "art font document height")
    current_text = _clean_text(value.get("currentText"), 4000)
    if not current_text:
        raise OpenShopAiValidationError("Art font currentText is empty")
    generation = _positive_int(value.get("requestGeneration"), "requestGeneration", 2147483647)
    profile = _normalize_font(value.get("visualProfile"))
    return {
        "textLayerId": _task_safe_id(value.get("textLayerId"), "textLayerId"),
        "ocrBlockId": _task_safe_id(value.get("ocrBlockId"), "ocrBlockId"),
        "originalText": _clean_text(value.get("originalText"), 4000),
        "currentText": current_text,
        "requestGeneration": generation,
        "document": {"width": width, "height": height},
        "quad": _normalize_points(value.get("quad"), width, height),
        "visualProfile": profile,
    }
```

Extend `OpenShopAiTaskRegistry.create()` with `source_layer_id=""` and `snapshot=None`; for this tool, store normalized `snapshot` and `sourceLayerId`. Extend `normalize_ai_task_record()` to retain the same snapshot only for `art-font-restore`. Existing task shapes remain unchanged.

- [ ] **Step 4: Implement safe crop and alpha normalization**

Add public helpers to `openshop_image_ops.py`:

```python
def crop_art_font_reference(source_bytes, quad, padding_ratio=0.15):
    source = _decode_image(source_bytes, "RGBA", "art font source")
    points = [(float(point["x"]) * source.width, float(point["y"]) * source.height) for point in quad]
    left, top = min(x for x, _ in points), min(y for _, y in points)
    right, bottom = max(x for x, _ in points), max(y for _, y in points)
    padding = max(right - left, bottom - top) * max(0.0, min(0.5, float(padding_ratio)))
    box = (
        max(0, int(left - padding)), max(0, int(top - padding)),
        min(source.width, int(right + padding + 0.999)),
        min(source.height, int(bottom + padding + 0.999)),
    )
    crop = source.crop(box)
    output = io.BytesIO()
    crop.save(output, format="PNG", compress_level=6)
    return output.getvalue()
```

Add `import math` plus `Counter` and `deque` from `collections`, then implement alpha validation, connected matte removal, and target-aspect padding without resizing glyph pixels:

```python
def _rgb_distance(left, right):
    return sum((int(left[index]) - int(right[index])) ** 2 for index in range(3)) ** 0.5


def normalize_art_font_output(generated_bytes, target_aspect):
    image = _decode_image(generated_bytes, "RGBA", "art font output")
    try:
        aspect = float(target_aspect)
    except (TypeError, ValueError) as exc:
        raise OpenShopImageNormalizationError("OpenShop art font aspect is invalid") from exc
    if not 0.01 <= aspect <= 100:
        raise OpenShopImageNormalizationError("OpenShop art font aspect is invalid")

    alpha = image.getchannel("A")
    transparent_count = sum(value < 250 for value in alpha.getdata())
    minimum_transparency = max(16, image.width * image.height // 1000)
    if transparent_count < minimum_transparency:
        rgb = image.convert("RGB")
        pixels = rgb.load()
        boundary = []
        boundary.extend(pixels[x, 0] for x in range(rgb.width))
        boundary.extend(pixels[x, rgb.height - 1] for x in range(rgb.width))
        boundary.extend(pixels[0, y] for y in range(1, rgb.height - 1))
        boundary.extend(pixels[rgb.width - 1, y] for y in range(1, rgb.height - 1))
        bins = Counter(tuple(channel // 8 for channel in color) for color in boundary)
        dominant_bin, count = bins.most_common(1)[0]
        if count / max(1, len(boundary)) < 0.85:
            raise OpenShopImageNormalizationError("OpenShop art font output has no safe transparent matte")
        matching = [color for color in boundary if tuple(channel // 8 for channel in color) == dominant_bin]
        matte = tuple(round(sum(color[index] for color in matching) / len(matching)) for index in range(3))
        queue = deque()
        visited = set()
        for x in range(rgb.width):
            queue.extend(((x, 0), (x, rgb.height - 1)))
        for y in range(rgb.height):
            queue.extend(((0, y), (rgb.width - 1, y)))
        rgba = image.load()
        while queue:
            point = queue.popleft()
            if point in visited:
                continue
            visited.add(point)
            x, y = point
            if _rgb_distance(pixels[x, y], matte) > 24:
                continue
            red, green, blue, _old_alpha = rgba[x, y]
            rgba[x, y] = (red, green, blue, 0)
            if x > 0: queue.append((x - 1, y))
            if x + 1 < rgb.width: queue.append((x + 1, y))
            if y > 0: queue.append((x, y - 1))
            if y + 1 < rgb.height: queue.append((x, y + 1))

    alpha = image.getchannel("A")
    content_box = alpha.getbbox()
    if not content_box:
        raise OpenShopImageNormalizationError("OpenShop art font output has no visible glyph pixels")
    content = image.crop(content_box)
    if content.width / content.height >= aspect:
        canvas_width = content.width
        canvas_height = max(content.height, int(math.ceil(content.width / aspect)))
    else:
        canvas_height = content.height
        canvas_width = max(content.width, int(math.ceil(content.height * aspect)))
    canvas = Image.new("RGBA", (canvas_width, canvas_height), (0, 0, 0, 0))
    offset = ((canvas_width - content.width) // 2, (canvas_height - content.height) // 2)
    canvas.alpha_composite(content, offset)
    output = io.BytesIO()
    canvas.save(output, format="PNG", compress_level=6)
    return output.getvalue(), {
        "contentBox": {"x": offset[0], "y": offset[1], "width": content.width, "height": content.height},
        "width": canvas.width,
        "height": canvas.height,
    }
```

- [ ] **Step 5: Run and persist the artistic image task**

Extend `OpenShopAiTaskRequest` only through its existing `options` field. In `create_openshop_ai_task()`, normalize `payload.options["artFont"]`, validate that the selected image model supports image input, verify the source asset, and pass the snapshot into `OPENSHOP_AI_TASKS.create()`.

Add the task branch before text removal in `run_openshop_ai_task()`:

```python
if payload.tool_id == "art-font-restore":
    snapshot = normalize_art_font_snapshot(payload.options.get("artFont"))
    with open(source_path, "rb") as handle:
        reference_png = crop_art_font_reference(handle.read(), snapshot["quad"])
    target_aspect = _art_font_quad_aspect(snapshot["quad"], snapshot["document"])
    reference_url = "data:image/png;base64," + base64.b64encode(reference_png).decode("ascii")
    prompt = build_art_font_prompt(snapshot)
    image_data, _raw = await generate_ai_image(
        prompt, "auto", "high", payload.model_id,
        [{"url": reference_url, "name": "original-lettering.png", "role": "style-reference", "kind": "image", "mime": "image/png"}],
        payload.provider_id,
    )
    generated_bytes = await materialize_openshop_ai_image(image_data)
    normalized_png, geometry = normalize_art_font_output(generated_bytes, target_aspect)
    if not OPENSHOP_AI_TASKS.can_complete(task_id):
        return
    asset = await store_openshop_ai_png(project_id, owner, normalized_png, "art-font-output")
    OPENSHOP_AI_TASKS.succeed(task_id, {**asset, **geometry})
    return
```

`build_art_font_prompt(snapshot)` must quote the exact `currentText`, require one rendering only, preserve the reference's size/weight/color/angle/stroke/shadow/artistic structure, require transparent background, and prohibit extra symbols or scene reconstruction. `materialize_openshop_ai_image()` must reuse `save_ai_image_to_output()` and always remove its temporary file in `finally`. `store_openshop_ai_png()` stores `image/png` directly through `OPENSHOP_STORE.store_image()` with role `art-font-output`.

Use these concrete helpers in `main.py`:

```python
def _art_font_quad_aspect(quad, document):
    width = int(document["width"])
    height = int(document["height"])
    points = [(float(point["x"]) * width, float(point["y"]) * height) for point in quad]
    top_width = math.hypot(points[1][0] - points[0][0], points[1][1] - points[0][1])
    side_height = math.hypot(points[3][0] - points[0][0], points[3][1] - points[0][1])
    if top_width <= 0 or side_height <= 0:
        raise OpenShopAiValidationError("Art font quad has no area")
    return top_width / side_height


def build_art_font_prompt(snapshot):
    profile = snapshot["visualProfile"]
    exact_text = json.dumps(snapshot["currentText"], ensure_ascii=False)
    return (
        f"Render exactly this edited text once: {exact_text}. Use the supplied original lettering crop only "
        f"as the artistic style reference. Preserve its apparent size, weight {profile['weight']}, color, "
        f"slant, spacing, stroke, shadow, and artistic structure. Return only the lettering on a fully "
        "transparent background. Do not add symbols, duplicate words, logos, scenery, texture panels, or "
        "background reconstruction. Keep glyph proportions natural and do not compress or stretch the text."
    )


async def materialize_openshop_ai_image(image_data):
    output_url = await save_ai_image_to_output(image_data, prefix="openshop_art_font_")
    output_path = output_file_from_url(output_url)
    if not output_path or not os.path.isfile(output_path):
        raise HTTPException(status_code=502, detail="艺术字体模型没有返回可读取的图片")
    temporary = os.path.basename(output_path).startswith("openshop_art_font_")
    try:
        with open(output_path, "rb") as handle:
            return handle.read()
    finally:
        if temporary:
            try:
                os.remove(output_path)
            except OSError:
                pass


async def store_openshop_ai_png(project_id, owner, content, role):
    asset = await asyncio.to_thread(
        OPENSHOP_STORE.store_image,
        project_id, owner, content, "image/png", f"{project_id}-art-font.png", role,
    )
    asset["url"] = f"/api/openshop/assets/{asset['assetId']}"
    return asset
```

Add this result normalizer in `openshop_ai.py`:

```python
def normalize_art_font_result(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise OpenShopAiValidationError("Art font result must be an object")
    width = _positive_dimension(value.get("width"), "art font result width")
    height = _positive_dimension(value.get("height"), "art font result height")
    raw_box = value.get("contentBox") if isinstance(value.get("contentBox"), dict) else {}
    try:
        box = {key: int(raw_box.get(key)) for key in ("x", "y", "width", "height")}
    except (TypeError, ValueError) as exc:
        raise OpenShopAiValidationError("Art font contentBox is invalid") from exc
    if (
        box["x"] < 0 or box["y"] < 0 or box["width"] < 1 or box["height"] < 1
        or box["x"] + box["width"] > width or box["y"] + box["height"] > height
    ):
        raise OpenShopAiValidationError("Art font contentBox is outside the image")
    mime = _clean_text(value.get("mime"), 80).lower()
    if mime != "image/png":
        raise OpenShopAiValidationError("Art font result must be PNG")
    return {
        "assetId": _task_asset_id(value.get("assetId"), "art font result assetId"),
        "url": _clean_text(value.get("url"), 500),
        "name": _clean_text(value.get("name"), 240, "art-font.png"),
        "mime": mime,
        "width": width,
        "height": height,
        "contentBox": box,
    }
```

In `normalize_ai_task_record()`, call `normalize_art_font_result(result)` when `tool_id == "art-font-restore"` so a completed result keeps enough geometry to reconcile after restart.

- [ ] **Step 6: Run backend tests and verify GREEN**

Run:

```powershell
node tools/tests/openshop-ai-contract.test.mjs
node tools/tests/openshop-ai-api.test.mjs
```

Expected: all AI contract/API tests PASS; unsafe opaque output fails once without retrying or creating an asset.

- [ ] **Step 7: Commit the artistic backend unit**

```powershell
git add openshop_ai.py openshop_image_ops.py main.py tools/tests/openshop-ai-contract.test.mjs tools/tests/openshop-ai-api.test.mjs
git commit -m "feat: add openshop artistic font image task"
```

### Task 6: Add The Layer Action, Independent Model Selector, And Durable Result Reconciliation

**Files:**
- Modify: `integrations/openshop/host/openshop-ai-client.js`
- Modify: `integrations/openshop/host/openshop-text-tools.js`
- Modify: `integrations/openshop/host/openshop-project-adapter.js`
- Modify: `integrations/openshop/index.html`
- Modify: `integrations/openshop/tests/hstar-ai-client.test.js`
- Modify: `integrations/openshop/tests/hstar-text-tools.test.js`
- Modify: `integrations/openshop/tests/hstar-project-adapter.test.js`
- Test: `integrations/openshop/tests/hstar-text-tools.test.js`

- [ ] **Step 1: Write failing client behavior tests**

Extend the fake catalog with `art-font-restore` and add tests that assert:

```javascript
controller.setPreference('art-font-restore', {
  mode:'project', apiConfigId:'image-custom', modelId:'art-image-model',
});
expect(editor.__hstarAiToolPreferences['art-font-restore']).toEqual({
  toolId:'art-font-restore', mode:'project', apiConfigId:'image-custom', modelId:'art-image-model',
});
expect(document.querySelector('[data-model-tool="art-font-restore"]')).not.toBeNull();

ocrText.text = '夏日新品';
await controller.runArtFontRestore(ocrLayer.layerId);
expect(aiClient.createTask).toHaveBeenCalledWith(context, expect.objectContaining({
  toolId:'art-font-restore',
  sourceAssetId:SOURCE_ASSET_ID,
  options:{artFont:expect.objectContaining({currentText:'夏日新品', textLayerId:ocrLayer.layerId})},
}));
expect(editor.layers[editor.layers.indexOf(ocrLayer) + 1]).toMatchObject({
  name:`${ocrLayer.name} - 艺术字体`, visible:true,
});
expect(ocrLayer.visible).toBe(false);
expect(editor.saveHistory).toHaveBeenCalledWith('艺术字体处理');
```

Add separate tests for manual text (`没有原图参考`, no request), double click while active (one request), failed/invalid result (carrier remains visible, no layer), text changed after request (stale result rejected), and a persisted running record restored after `openshop:project-loaded` (poll then apply once).

Add an `hstar-ai-client` assertion that `createTask()` forwards `source_layer_id` and the complete `options.artFont` object unchanged.

- [ ] **Step 2: Run focused client tests and verify RED**

Run:

```powershell
npm.cmd --prefix integrations\openshop test -- hstar-ai-client.test.js hstar-text-tools.test.js hstar-project-adapter.test.js
```

Expected: FAIL because the AI client drops `source_layer_id`, the preference whitelist excludes the new tool, and no layer action or restore path exists.

- [ ] **Step 3: Forward the complete artistic request and persist the preference**

In `openshop-ai-client.js`, include:

```javascript
source_layer_id:clean(input.sourceLayerId),
options:input.options && typeof input.options === 'object' ? input.options : {},
```

in the POST body. Permit `art-font-restore` in `setPreference()` and render its selector directly below OCR's selector:

```javascript
${modelSection(TOOL_EXTRACT, '文字识别模型')}
${modelSection(TOOL_ART_FONT, '艺术字体图像模型')}
```

Give each provider/model control `data-model-tool="${toolId}"`. In `handlePanelInput()`, read that dataset rather than `state.activeTool`, so changing the artistic model never changes OCR's model. Continue using `runtime.requestSave({reason:'ai-preference'})` so the first explicit selection survives panel close, editor close, canvas reload, and application restart.

- [ ] **Step 4: Add the text-layer row refresh action**

In `updateLayersPanel()`, identify a text layer with:

```javascript
const textObject = l.objects.find(object => ['text', 'i-text', 'textbox'].includes(String(object?.type || '').toLowerCase()));
const artEligible = Boolean(textObject?.hstarOcrBlockId && textObject?.hstarOcrSourceAssetId && textObject?.hstarOcrQuad);
const artTitle = artEligible ? this._t('艺术字体处理') : this._t('没有原图参考');
```

Append this icon button after `.layer-lock` for every text layer:

```html
<button class="layer-art-font" title="${this._esc(artTitle)}" aria-label="${this._esc(artTitle)}" ${artEligible ? '' : 'disabled'}>&#8635;</button>
```

Its click handler stops propagation and dispatches:

```javascript
window.dispatchEvent(new CustomEvent('openshop:art-font-restore', {
  detail:{layerId:l.layerId},
}));
```

Use a fixed 24-by-24 icon-button size so busy/disabled states do not resize the row. The text-tools controller listens for the event and exports `runArtFontRestore()` for unit/E2E control.

- [ ] **Step 5: Start tasks non-destructively and reconcile only matching results**

Implement `runArtFontRestore(layerId)` using the current `object.text`, persisted OCR metadata, and the separately resolved artistic preference. Before POST, create a monotonically increasing `requestGeneration` on the text object. Immediately after POST, append and save this record:

```javascript
{
  taskId, toolId:TOOL_ART_FONT, status:'running',
  apiConfigId:selected.apiConfigId, modelId:selected.modelId,
  sourceLayerId:clean(object.hstarOcrSourceLayerId),
  sourceAssetId:clean(object.hstarOcrSourceAssetId),
  outputAssetId:'', createdAt:Date.now(), updatedAt:Date.now(), completedAt:0, appliedAt:0, error:'',
  snapshot:{
    textLayerId:clean(layer.layerId), ocrBlockId:clean(object.hstarOcrBlockId),
    originalText:String(object.hstarOcrOriginalText || ''),
    currentText:String(object.text || ''), requestGeneration,
    document:{width:Number(editor.canvasW), height:Number(editor.canvasH)},
    quad:clone(object.hstarOcrQuad), visualProfile:clone(object.hstarOcrVisualProfile),
  },
}
```

Call `runtime.requestSave({reason:'art-font-task-started'})` before polling. If polling aborts only because the OpenShop session becomes hidden/stopped, leave the record `running`; do not cancel the server task or mark it failed. Explicit cancellation remains the only path that marks it cancelled.

`applyArtFontResult(record)` must verify owner/session scope through the active project, source layer presence, text layer presence, unchanged `requestGeneration`, unchanged current text, one matching task per output asset, and valid result dimensions. Load the image, create a pixel layer at `textLayerIndex + 1`, use one uniform scale against the saved quad aspect, hide the editable carrier layer only after successful insertion, select the result, call `saveHistory('艺术字体处理')` once, set `appliedAt`, mark dirty, and request a save. Any validation/load failure leaves the carrier visible and creates no layer.

Extend `restoreTaskRecords()` to poll queued/running artistic records and apply succeeded/unapplied records. Include artistic `snapshot` in project-adapter round-trip tests; the existing AI record/asset collection must retain both source and output assets.

- [ ] **Step 6: Run focused client tests and verify GREEN**

Run:

```powershell
npm.cmd --prefix integrations\openshop test -- hstar-ai-client.test.js hstar-text-tools.test.js hstar-project-adapter.test.js os-unit.test.js
```

Expected: all focused tests PASS; failed/stale tasks never hide the editable layer, and restored success is inserted once.

- [ ] **Step 7: Commit the artistic client unit**

```powershell
git add integrations/openshop/host/openshop-ai-client.js integrations/openshop/host/openshop-text-tools.js integrations/openshop/host/openshop-project-adapter.js integrations/openshop/index.html integrations/openshop/tests/hstar-ai-client.test.js integrations/openshop/tests/hstar-text-tools.test.js integrations/openshop/tests/hstar-project-adapter.test.js
git commit -m "feat: add artistic font layer workflow"
```

### Task 7: Verify End-To-End Persistence, Build Output, And Test-Data Cleanup

**Files:**
- Modify: `integrations/openshop/tests/hstar-text-tools.e2e.spec.js`
- Modify: `integrations/openshop/tests/hstar-editor-interaction-reliability.e2e.spec.js`
- Modify: `integrations/openshop/locales/zh-CN.js` only for strings routed through `_t()` by the layer row.
- Regenerate: `static/openshop/**`
- Test: `integrations/openshop/tests/hstar-text-tools.e2e.spec.js`

- [ ] **Step 1: Add deterministic end-to-end OCR and artistic-font coverage**

Extend `installAiRoutes()` with an `art-font-restore` image provider and a held task response. Add a test that:

1. creates two isolated OpenShop nodes in one engineering test canvas;
2. extracts Simplified Chinese, Traditional Chinese, English, and artistic blocks;
3. verifies each ordinary block uses only `01免`, `02免`, or `03免` respectively and has equal `scaleX`/`scaleY`;
4. verifies the artistic carrier uses `阿里巴巴普惠体 3.0` with the nearest real weight;
5. edits the artistic carrier text to `夏日新品`;
6. selects an artistic image model and starts the task;
7. hides/closes OpenShop before releasing the held task;
8. reopens the same node and verifies one transparent raster layer immediately above the hidden carrier;
9. invokes Undo and verifies the raster layer is removed and the editable carrier is visible again;
10. opens the second node and verifies no task, layer, preference, source asset, or text has crossed node scope.

Capture the intercepted POST and assert:

```javascript
expect(artRequest.options.artFont.currentText).toBe('夏日新品');
expect(artRequest.options.artFont.currentText).not.toBe(artRequest.options.artFont.originalText);
expect(artRequest.provider_id).toBe('art-image-api');
expect(artRequest.model_id).toBe('art-image-model');
```

Use a deterministic transparent PNG fixture; do not spend a real image-generation request for this regression test.

- [ ] **Step 2: Make engineering canvas cleanup explicit and isolated**

Generate test canvas IDs with the `codex-e2e-openshop-` prefix. Register each ID in the test and delete only those IDs in `test.afterEach`, then verify their engineering sidecar paths no longer exist through the engineering API/test fixture. Never enumerate, mutate, migrate, or delete any path under `E:\Hstar缓存`, and never delete canvases whose ID lacks the test prefix.

- [ ] **Step 3: Run the complete unit and contract suite**

Run:

```powershell
python -m unittest tests.test_openshop_fonts -v
node tools/tests/openshop-ai-contract.test.mjs
node tools/tests/openshop-ai-api.test.mjs
node tools/tests/openshop-project-storage.test.mjs
npm.cmd --prefix integrations\openshop test
```

Expected: every Python, Node harness, and Vitest test PASSes.

- [ ] **Step 4: Regenerate the runtime and verify source/build parity**

Run:

```powershell
npm.cmd --prefix integrations\openshop run build:hstar
node tools/tests/openshop-build-output.test.mjs
npm.cmd --prefix integrations\openshop run audit:i18n
```

Expected: the build prints `OPENSHOP_BUILD_SHA256=` followed by exactly 64 lowercase hexadecimal characters; build-output and localization audits PASS; generated files appear only under `static/openshop/**`.

- [ ] **Step 5: Start HstarA and run focused Playwright suites**

Start the engineering server on port 3000, verify it responds, then run the focused tests:

```powershell
$env:HSTAR_PORT='3000'
$server = Start-Process -FilePath python -ArgumentList 'main.py' -WorkingDirectory (Get-Location) -WindowStyle Hidden -PassThru
Invoke-WebRequest -UseBasicParsing http://127.0.0.1:3000/ | Select-Object StatusCode
$env:HSTAR_BASE_URL='http://127.0.0.1:3000'; npm.cmd --prefix integrations\openshop exec playwright test tests/hstar-editor-interaction-reliability.e2e.spec.js tests/hstar-text-tools.e2e.spec.js tests/hstar-canvas-integration.e2e.spec.js
Stop-Process -Id $server.Id
```

Expected: all focused browser tests PASS with no `pageerror`, blank canvas, parent-panel jump, duplicate artistic output, or cross-node data leakage.

- [ ] **Step 6: Inspect the engineering data boundary after Playwright**

Run a read-only listing of the engineering canvas store and assert no ID beginning with `codex-e2e-openshop-` remains. If a test-owned entry remains, delete that exact prefixed canvas through the engineering canvas API and repeat the listing. Do not touch unrelated canvas IDs or `E:\Hstar缓存`.

- [ ] **Step 7: Commit generated runtime and end-to-end coverage**

```powershell
git add integrations/openshop/tests/hstar-text-tools.e2e.spec.js integrations/openshop/tests/hstar-editor-interaction-reliability.e2e.spec.js integrations/openshop/locales/zh-CN.js static/openshop
git commit -m "test: verify openshop artistic text workflow"
```

- [ ] **Step 8: Review branch state without merging**

Run:

```powershell
git status --short --branch
git log --oneline --decorate -8
```

Expected: only the user's pre-existing unrelated `data/asset_library.json` and generated `static/*.html` changes remain outside the committed feature scope. Keep the branch unmerged and unpushed until the user explicitly requests integration into `main`.
