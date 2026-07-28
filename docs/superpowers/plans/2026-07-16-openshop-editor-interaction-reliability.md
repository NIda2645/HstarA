# OpenShop Editor Interaction Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 OpenShop 字体下拉、中文字体排序、文字重复创建、画板四边吸附、橡皮擦延迟和颜色面板吸管六项高频交互问题。

**Architecture:** 保留 OpenShop 主编辑器作为 Fabric 工具生命周期协调者，将纯排序、纯吸附、实时橡皮擦和颜色面板状态分别封装在现有或新增的 `host/` 模块中。所有行为先通过 Vitest 单元测试复现，再由 Playwright 在独立 OpenShop 页面验证；构建仅同步明确白名单文件到 `static/openshop`。

**Tech Stack:** 原生 JavaScript、Fabric.js 5.3、Vitest、Playwright、HstarA OpenShop 构建与汉化审计脚本。

---

## 文件结构

- 修改 `integrations/openshop/host/openshop-font-catalog.js`：中文字体识别和稳定排序。
- 修改 `integrations/openshop/host/openshop-text-properties.js`：字体列表打开、关闭和销毁状态。
- 修改 `integrations/openshop/host/openshop-text-properties.css`：保证 `[hidden]` 真正不可见。
- 修改 `integrations/openshop/host/openshop-snap-engine.js`：显式计算四条画板边线候选。
- 新建 `integrations/openshop/host/openshop-live-eraser.js`：Fabric 橡皮擦逐帧预览和最终路径配置。
- 新建 `integrations/openshop/host/openshop-color-panel.js`：颜色草稿、RGB/HSV 转换、弹窗和一次性画布取色状态。
- 新建 `integrations/openshop/host/openshop-color-panel.css`：紧凑颜色弹窗布局。
- 修改 `integrations/openshop/index.html`：接入文字命中、橡皮擦、颜色面板和按帧状态更新。
- 修改 `integrations/openshop/scripts/build-hstar.mjs`：发布新增运行时模块。
- 修改 `tools/tests/openshop-localization-build.test.mjs`：批准新增运行时文件。
- 修改或新增 `integrations/openshop/tests/*.test.js`：纯逻辑和主编辑器单元回归。
- 新建 `integrations/openshop/tests/hstar-editor-interaction-reliability.e2e.spec.js`：六项浏览器行为回归。

## Task 1: 字体下拉关闭与中文优先排序

**Files:**
- Modify: `integrations/openshop/host/openshop-font-catalog.js`
- Modify: `integrations/openshop/host/openshop-text-properties.js`
- Modify: `integrations/openshop/host/openshop-text-properties.css`
- Test: `integrations/openshop/tests/hstar-font-catalog.test.js`
- Test: `integrations/openshop/tests/hstar-text-properties.test.js`

- [ ] **Step 1: 写中文字体优先的失败测试**

在 `hstar-font-catalog.test.js` 加入包含数字开头、英文、中文显示名和 `language:'zh'` 的系统字体响应：

```js
it('sorts Chinese fonts before every non-Chinese family', async () => {
  const manager = window.HstarOpenShopFontCatalog.createManager({
    fontProbe:() => true,
    fetchImpl:async () => ({ok:true, json:async () => ({fonts:[
      {family:'04b', label:'04b'},
      {family:'Arial', label:'Arial'},
      {family:'Alibaba PuHuiTi', label:'阿里巴巴普惠体', language:'zh'},
      {family:'FZHei', label:'方正黑体'},
    ]})}),
  });
  await manager.loadSystemFonts();
  const fonts = manager.searchFonts('');
  const chinese = fonts.filter(font => /[\u3400-\u9fff]/u.test(font.label) || font.language === 'zh');
  const firstOther = fonts.findIndex(font => !chinese.includes(font));
  expect(chinese.length).toBeGreaterThan(0);
  expect(fonts.slice(0, chinese.length)).toEqual(chinese);
  expect(firstOther).toBe(chinese.length);
});
```

- [ ] **Step 2: 写字体列表视觉隐藏的失败测试**

在 `hstar-text-properties.test.js` 读取 CSS，并断言隐藏规则存在；现有 DOM 测试继续验证外部 `mousedown`、字体选择和 `Esc` 会同步 `hidden=true` 与 `aria-expanded=false`：

```js
const cssPath = resolve(testDir, '..', 'host', 'openshop-text-properties.css');
expect(readFileSync(cssPath, 'utf8')).toMatch(/\.hstar-font-list\[hidden\]\s*\{\s*display\s*:\s*none\s*!important/);
```

- [ ] **Step 3: 运行聚焦测试并确认 RED**

Run:

```powershell
npm.cmd --prefix integrations\openshop test -- tests/hstar-font-catalog.test.js tests/hstar-text-properties.test.js
```

Expected: 中文排序断言失败；CSS 隐藏规则断言失败。

- [ ] **Step 4: 实现稳定字体分组排序**

在 `openshop-font-catalog.js` 增加纯函数并用于 `rebuildFonts()`：

```js
const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u;
const fontCollator = new Intl.Collator('zh-CN', {numeric:true, sensitivity:'base'});

function isChineseFont(font){
  return cleanFamily(font?.language).toLowerCase().startsWith('zh')
    || CJK_RE.test(`${cleanFamily(font?.label)} ${cleanFamily(font?.family)}`);
}

function compareFonts(left, right){
  const group = Number(isChineseFont(right)) - Number(isChineseFont(left));
  return group || fontCollator.compare(left.label || left.family, right.label || right.family)
    || fontCollator.compare(left.family, right.family);
}
```

将 `state.fonts` 的排序改为 `.sort(compareFonts)`。

- [ ] **Step 5: 修复隐藏样式和关闭状态**

在 `openshop-text-properties.css` 加入：

```css
.hstar-font-list[hidden]{display:none!important}
```

在 `closeFontList()` 中同时设置 `list.hidden=true` 与 `aria-expanded=false`；在 `activateTextTab` 之外的面板切换、`destroy()` 和目标失效时调用关闭函数。将关闭函数保存在控制器状态中，避免只存在于 `bindPanelControls()` 局部作用域。

- [ ] **Step 6: 运行聚焦测试并确认 GREEN**

Run:

```powershell
npm.cmd --prefix integrations\openshop test -- tests/hstar-font-catalog.test.js tests/hstar-text-properties.test.js
```

Expected: 两个测试文件全部通过。

- [ ] **Step 7: 提交字体修复**

```powershell
git add integrations/openshop/host/openshop-font-catalog.js integrations/openshop/host/openshop-text-properties.js integrations/openshop/host/openshop-text-properties.css integrations/openshop/tests/hstar-font-catalog.test.js integrations/openshop/tests/hstar-text-properties.test.js
git commit -m "fix: stabilize OpenShop font selection"
```

## Task 2: 文字工具命中已有文本

**Files:**
- Modify: `integrations/openshop/index.html`
- Modify: `integrations/openshop/tests/os-harness.js`
- Test: `integrations/openshop/tests/os-unit.test.js`

- [ ] **Step 1: 为 Fabric 测试桩增加可编辑文本**

在 `os-harness.js` 的 `installFabricMock()` 中加入最小 `IText`：

```js
class IText {
  constructor(text, options = {}) {
    this.type = 'i-text';
    this.text = text;
    this.isEditing = false;
    Object.assign(this, options);
    this.enterEditing = vi.fn(() => { this.isEditing = true; });
  }
}
```

并导出到 `globalThis.fabric.IText`。

- [ ] **Step 2: 写文字点击状态的失败测试**

在 `os-unit.test.js` 新增两个断言：

```js
it('edits an existing text target without creating another object', () => {
  const OS = loadOpenShop();
  const text = new fabric.IText('Existing', {left:20, top:30});
  OS.canvas = createCanvasMock([text]);
  OS.canvas.getPointer = vi.fn(() => ({x:25, y:35}));
  OS.layers = [{locked:false, objects:[text]}];
  OS.activeLayerIdx = 0;
  quietUiMethods(OS);
  OS.setTool('text');

  OS.onMouseDown({e:{}, target:text});

  expect(OS.canvas.getObjects()).toHaveLength(1);
  expect(OS.canvas.setActiveObject).toHaveBeenCalledWith(text);
  expect(text.enterEditing).toHaveBeenCalledOnce();
});

it('creates one text object only when the text tool hits empty canvas', () => {
  const OS = loadOpenShop();
  OS.canvas = createCanvasMock([]);
  OS.canvas.getPointer = vi.fn(() => ({x:120, y:80}));
  OS.layers = [{locked:false, objects:[]}];
  OS.activeLayerIdx = 0;
  quietUiMethods(OS);
  OS.setTool('text');

  OS.onMouseDown({e:{}, target:null});

  expect(OS.canvas.getObjects()).toHaveLength(1);
  expect(OS.layers[0].objects).toHaveLength(1);
  expect(OS.saveHistory).toHaveBeenCalledWith('Add Text');
});
```

- [ ] **Step 3: 运行测试并确认 RED**

Run:

```powershell
npm.cmd --prefix integrations\openshop test -- tests/os-unit.test.js
```

Expected: 点击已有文本后对象数量变为 2，失败原因与重复创建一致。

- [ ] **Step 4: 实现文字专用交互配置**

在 `index.html` 增加文本类型判断：

```js
_isEditableTextObject(object) {
  return ['text','i-text','textbox'].includes(String(object?.type || '').toLowerCase());
},
```

令 `_toolInteractionProfile('text')` 返回 `text`。在 `_applyToolInteractionState()` 中，`text` 配置只将未锁定文本设为 `selectable=true,evented=true`，其他对象保持不可命中。

在 `onMouseDown()` 的文字分支先处理 `opt.target`：

```js
if (this._isEditableTextObject(opt.target)) {
  this.canvas.setActiveObject(opt.target);
  if (!opt.target.isEditing) opt.target.enterEditing?.(opt.e);
  this.canvas.requestRenderAll?.();
  return;
}
```

仅在未命中文本时执行现有新建逻辑。

- [ ] **Step 5: 运行测试并确认 GREEN**

Run:

```powershell
npm.cmd --prefix integrations\openshop test -- tests/os-unit.test.js
```

Expected: `os-unit.test.js` 全部通过。

- [ ] **Step 6: 提交文字命中修复**

```powershell
git add integrations/openshop/index.html integrations/openshop/tests/os-harness.js integrations/openshop/tests/os-unit.test.js
git commit -m "fix: edit existing OpenShop text in place"
```

## Task 3: 显式覆盖画板四边吸附

**Files:**
- Modify: `integrations/openshop/host/openshop-snap-engine.js`
- Test: `integrations/openshop/tests/openshop-snap-engine.test.js`
- Test: `integrations/openshop/tests/os-unit.test.js`

- [ ] **Step 1: 写四边独立失败回归**

在 `openshop-snap-engine.test.js` 使用参数化用例分别验证左、右、上、下；每个用例只让一个边线进入容差：

```js
it.each([
  ['left', {left:3, top:143}, {left:0, top:143, sourceX:'document-left', sourceY:'none'}],
  ['right', {left:797, top:143}, {left:800, top:143, sourceX:'document-right', sourceY:'none'}],
  ['top', {left:137, top:-4}, {left:137, top:0, sourceX:'none', sourceY:'document-top'}],
  ['bottom', {left:137, top:603}, {left:137, top:600, sourceX:'none', sourceY:'document-bottom'}],
])('snaps the %s document boundary independently', (_edge, position, expected) => {
  const result = window.HstarOpenShopSnapEngine.resolveMovement({
    position,
    objectRect:{...position, width:200, height:200},
    documentRect:{left:0, top:0, width:1000, height:800},
    tolerance:5,
    grid:{enabled:false, size:20},
  });
  expect(result).toEqual(expected);
});
```

同时在 `os-unit.test.js` 加入右边和下边通过 `_applyObjectSnapping()` 写回 Fabric 对象原点的测试，覆盖引擎与编辑器之间的坐标边界。

- [ ] **Step 2: 运行聚焦测试并记录现状**

Run:

```powershell
npm.cmd --prefix integrations\openshop test -- tests/openshop-snap-engine.test.js tests/os-unit.test.js
```

Expected: 四个新用例因当前只返回笼统的 `document-geometry` 来源而失败；坐标断言同时记录当前每条边是否已正确写回 Fabric 对象。

- [ ] **Step 3: 将画板候选改为显式边线结构**

以具名边线替代依赖索引的通用数组，保持同边吸附：

```js
function addDocumentGeometry(xCandidates, yCandidates, objectRect, documentRect, tolerance){
  const pairs = [
    [xCandidates, objectRect.left, documentRect.left, 'document-left'],
    [xCandidates, objectRect.left + objectRect.width, documentRect.left + documentRect.width, 'document-right'],
    [yCandidates, objectRect.top, documentRect.top, 'document-top'],
    [yCandidates, objectRect.top + objectRect.height, documentRect.top + documentRect.height, 'document-bottom'],
    [xCandidates, objectRect.left + objectRect.width / 2, documentRect.left + documentRect.width / 2, 'document-center-x'],
    [yCandidates, objectRect.top + objectRect.height / 2, documentRect.top + documentRect.height / 2, 'document-center-y'],
  ];
  pairs.forEach(([list, current, target, source]) => {
    const delta = target - current;
    if(Math.abs(delta) <= tolerance) list.push({delta, priority:2, source});
  });
}
```

在 `_applyObjectSnapping()` 中继续只将候选 `delta` 加到对象 `left/top`，不得把边界坐标直接写成对象原点；右边和下边的编辑器测试必须证明变换后边界与画板边界相等。

- [ ] **Step 4: 运行测试并确认 GREEN**

Run:

```powershell
npm.cmd --prefix integrations\openshop test -- tests/openshop-snap-engine.test.js tests/os-unit.test.js
```

Expected: 四边、中心、整图、局部选区和网格用例全部通过。

- [ ] **Step 5: 提交四边吸附修复**

```powershell
git add integrations/openshop/host/openshop-snap-engine.js integrations/openshop/tests/openshop-snap-engine.test.js integrations/openshop/tests/os-unit.test.js
git commit -m "fix: cover all OpenShop document snap edges"
```

## Task 4: 橡皮擦逐帧反馈

**Files:**
- Create: `integrations/openshop/host/openshop-live-eraser.js`
- Modify: `integrations/openshop/index.html`
- Modify: `integrations/openshop/tests/os-harness.js`
- Create: `integrations/openshop/tests/hstar-live-eraser.test.js`
- Test: `integrations/openshop/tests/hstar-editor-performance.test.js`

- [ ] **Step 1: 写实时擦除画笔失败测试**

新测试加载 `openshop-live-eraser.js`，使用记录 `save/restore/transform/beginPath/moveTo/lineTo/stroke` 的假 `contextContainer`，断言：

```js
const brush = window.HstarOpenShopLiveEraser.createBrush({fabricRef:fabric, canvas});
brush.onMouseDown({x:10,y:20}, {e:{}});
brush.onMouseMove({x:18,y:28}, {e:{}});
expect(context.globalCompositeOperationAssignments).toContain('destination-out');
expect(context.stroke).toHaveBeenCalled();
expect(brush.color).toMatch(/^rgba\(0,0,0,0(?:\.0+1)?\)$/);
```

再断言 `configureFinalPath(path)` 设置不透明笔触和 `destination-out`，且不会写历史。

- [ ] **Step 2: 写编辑器生命周期失败测试**

在 `hstar-editor-performance.test.js` 断言重复切换橡皮擦复用同一画笔；`path:created` 只调用一次 `saveHistory('Draw')` 和一次 `updateLayersPanel()`，移动事件不调用这两者。

- [ ] **Step 3: 运行测试并确认 RED**

Run:

```powershell
npm.cmd --prefix integrations\openshop test -- tests/hstar-live-eraser.test.js tests/hstar-editor-performance.test.js
```

Expected: 新模块不存在或 `HstarOpenShopLiveEraser` 未定义。

- [ ] **Step 4: 实现专用橡皮擦画笔**

`createBrush()` 包装 `fabricRef.PencilBrush` 的 `onMouseDown/onMouseMove`，保留 Fabric 点收集与最终路径生成；新增点时仅把最新线段以 `destination-out` 绘制到 `canvas.contextContainer`。绘制前 `save()`，应用当前 `viewportTransform`，使用圆头圆角和当前画笔宽度，结束后 `restore()`。

导出：

```js
root.HstarOpenShopLiveEraser = Object.freeze({
  createBrush,
  configureFinalPath(path){
    path.globalCompositeOperation = 'destination-out';
    path.stroke = 'rgba(0,0,0,1)';
    path.dirty = true;
    return path;
  },
});
```

- [ ] **Step 5: 接入编辑器并按帧合并坐标状态**

在 `setTool('eraser')` 中通过 `_getCachedBrush('live:eraser', ...)` 创建专用画笔。`path:created` 调用 `configureFinalPath` 后只提交一次历史和图层更新。

将 `onMouseMove()` 的 `cursor-pos` 和 `info-cursor` DOM 写入合并为现有 `_scheduleUi('cursorUi', payload)` 或单独的 `requestAnimationFrame` 槽，Fabric 绘制逻辑不等待 DOM 更新。

- [ ] **Step 6: 运行聚焦测试并确认 GREEN**

Run:

```powershell
npm.cmd --prefix integrations\openshop test -- tests/hstar-live-eraser.test.js tests/hstar-editor-performance.test.js
```

Expected: 两个测试文件全部通过。

- [ ] **Step 7: 提交橡皮擦修复**

```powershell
git add integrations/openshop/host/openshop-live-eraser.js integrations/openshop/index.html integrations/openshop/tests/os-harness.js integrations/openshop/tests/hstar-live-eraser.test.js integrations/openshop/tests/hstar-editor-performance.test.js
git commit -m "perf: make OpenShop erasing responsive"
```

## Task 5: OpenShop 自有颜色面板和画布吸管

**Files:**
- Create: `integrations/openshop/host/openshop-color-panel.js`
- Create: `integrations/openshop/host/openshop-color-panel.css`
- Modify: `integrations/openshop/index.html`
- Create: `integrations/openshop/tests/hstar-color-panel.test.js`
- Test: `integrations/openshop/tests/os-unit.test.js`

- [ ] **Step 1: 写颜色转换和提交/取消失败测试**

在 `hstar-color-panel.test.js` 构造前景色、背景色色块和假编辑器，断言：

```js
controller.open('foreground');
controller.setDraft('#f43f46');
controller.cancel();
expect(editor.setFgColor).not.toHaveBeenCalled();

controller.open('background');
controller.setDraft('#123456');
controller.commit();
expect(editor.setBgColor).toHaveBeenCalledWith('#123456');
```

覆盖 RGB 限制、HSV 往返和点击外部取消。

- [ ] **Step 2: 写一次性画布吸管失败测试**

注入 `sampler.sample()` 返回 `#336699`，断言：

```js
controller.open('foreground');
controller.beginSampling();
expect(controller.getState().sampling).toBe(true);
expect(controller.handleCanvasSample({event:{}, documentPoint:{x:4,y:6}})).toBe(true);
expect(editor.setFgColor).toHaveBeenCalledWith('#336699');
expect(editor.setTool).toHaveBeenCalledWith('brush', {forceInteraction:true});
```

采样器抛错时颜色不变、状态继续可取消；`Esc` 恢复原工具。

- [ ] **Step 3: 运行测试并确认 RED**

Run:

```powershell
npm.cmd --prefix integrations\openshop test -- tests/hstar-color-panel.test.js tests/os-unit.test.js
```

Expected: 新模块不存在或控制器未定义。

- [ ] **Step 4: 实现颜色控制器**

`openshop-color-panel.js` 暴露：

```js
root.HstarOpenShopColorPanel = Object.freeze({
  createController,
  normalizeHex,
  hexToRgb,
  rgbToHex,
  rgbToHsv,
  hsvToRgb,
});
```

控制器公开 `start/destroy/open/commit/cancel/setDraft/beginSampling/cancelSampling/handleCanvasSample/getState`。内部状态为：

```js
{
  started:false,
  target:null,
  original:'#000000',
  draft:'#000000',
  sampling:false,
  previousTool:'select',
}
```

面板 DOM 只创建一次，所有全局监听通过统一清理数组移除。

- [ ] **Step 5: 实现紧凑弹窗样式**

`openshop-color-panel.css` 使用固定最大宽度和视口约束：

```css
.hstar-color-panel{position:fixed;z-index:1200;width:min(332px,calc(100vw - 20px));border:1px solid var(--border-strong,var(--border));background:var(--bg-depth-1);box-shadow:0 14px 34px rgba(0,0,0,.42)}
.hstar-color-panel[hidden]{display:none!important}
.hstar-color-field{position:relative;aspect-ratio:332/150;cursor:crosshair}
.hstar-color-sample{display:inline-flex;align-items:center;gap:6px}
```

颜色域和色相允许功能性渐变；按钮、数字输入和状态文本不得溢出弹窗。

- [ ] **Step 6: 接入前景色/背景色和主鼠标入口**

移除 `#fg-color/#bg-color` 的原生 `input.click()` 内联处理，保留隐藏输入仅作兼容值镜像。启动控制器并存入 `window.HstarOpenShopColorPanelController`。

在 `OS.onMouseDown(opt)` 最前面加入：

```js
if (this._colorPanelController?.getState?.().sampling) {
  const handled = this._colorPanelController.handleCanvasSample({
    event:opt.e,
    documentPoint:this.canvas.getPointer(opt.e),
  });
  if (handled) return;
}
```

启动时令 `OS._colorPanelController` 指向控制器。前景/背景目标分别调用 `setFgColor` / `setBgColor`。

- [ ] **Step 7: 运行聚焦测试并确认 GREEN**

Run:

```powershell
npm.cmd --prefix integrations\openshop test -- tests/hstar-color-panel.test.js tests/os-unit.test.js
```

Expected: 颜色面板和主编辑器测试全部通过。

- [ ] **Step 8: 提交颜色面板**

```powershell
git add integrations/openshop/host/openshop-color-panel.js integrations/openshop/host/openshop-color-panel.css integrations/openshop/index.html integrations/openshop/tests/hstar-color-panel.test.js integrations/openshop/tests/os-unit.test.js
git commit -m "feat: add OpenShop canvas color picker"
```

## Task 6: 发布清单和浏览器回归

**Files:**
- Modify: `integrations/openshop/scripts/build-hstar.mjs`
- Modify: `tools/tests/openshop-localization-build.test.mjs`
- Create: `integrations/openshop/tests/hstar-editor-interaction-reliability.e2e.spec.js`
- Modify: `integrations/openshop/package.json` only if a focused E2E script is required by existing naming conventions.

- [ ] **Step 1: 写运行时清单失败测试**

先在 `tools/tests/openshop-localization-build.test.mjs` 的 `expectedFiles` 加入：

```js
'host/openshop-live-eraser.js',
'host/openshop-color-panel.js',
'host/openshop-color-panel.css',
```

Run:

```powershell
node --test tools/tests/openshop-localization-build.test.mjs
```

Expected: 构建目录缺少新增模块。

- [ ] **Step 2: 更新 OpenShop 发布白名单并重建**

将同样三个路径加入 `build-hstar.mjs` 的 `runtimeFiles`，然后运行：

```powershell
npm.cmd --prefix integrations\openshop run build:hstar
```

Expected: 输出新增 JS/CSS 路径并以 `OPENSHOP_BUILD_SHA256=` 结束。

- [ ] **Step 3: 编写浏览器回归测试**

新 E2E 使用独立 `/static/openshop/index.html`，不创建 HstarA 画布项目。测试至少包含：

1. 文字属性面板展开字体列表，点击状态栏后 `list.hidden === true` 且 `getComputedStyle(list).display === 'none'`。
2. 字体选项前 20 项均属于中文组，首个非中文项之后不再出现中文组项。
3. 文字工具在同一 `IText` 内连续单击，画布文本对象数不增加；点击空白后只增加一个。
4. 以 28% 和 100% 缩放分别拖动对象靠近左、右、上、下边，最终变换后边界精确命中目标。
5. 橡皮擦按下并移动后，在抬笔前主画布采样像素已变化；抬笔后历史只增加一项，撤销一次恢复。
6. 前景色和背景色弹窗的“从画布取色”都能得到预设像素颜色，`Esc` 取消时颜色不变并恢复原工具。

- [ ] **Step 4: 运行 E2E 并修正仅由回归暴露的问题**

Run:

```powershell
npm.cmd --prefix integrations\openshop exec playwright test tests/hstar-editor-interaction-reliability.e2e.spec.js --workers=1
```

Expected: 6 项浏览器回归全部通过；测试结束不保留 HstarA 工程画布。

- [ ] **Step 5: 提交发布与 E2E**

```powershell
git add integrations/openshop/scripts/build-hstar.mjs tools/tests/openshop-localization-build.test.mjs integrations/openshop/tests/hstar-editor-interaction-reliability.e2e.spec.js static/openshop/host/openshop-live-eraser.js static/openshop/host/openshop-color-panel.js static/openshop/host/openshop-color-panel.css static/openshop/index.html
git commit -m "test: cover OpenShop interaction reliability"
```

## Task 7: 完整验证和工程版实测

**Files:**
- No production changes expected.

- [ ] **Step 1: 顺序运行构建与仓库级审计**

不得并行运行构建和编码审计：

```powershell
npm.cmd --prefix integrations\openshop run build:hstar
node --test tools/tests/openshop-localization-build.test.mjs
node --test tools/tests/text-encoding-health.test.mjs tools/tests/openshop-foundation-build.test.mjs
```

Expected: 三条命令均退出码 0。

- [ ] **Step 2: 运行完整 OpenShop 测试和汉化审计**

```powershell
npm.cmd --prefix integrations\openshop test
npm.cmd --prefix integrations\openshop run audit:i18n
```

Expected: 所有 Vitest 测试通过；汉化审计保持 `737/737` 或更高且无缺失键。

- [ ] **Step 3: 运行既有关键 E2E**

```powershell
npm.cmd --prefix integrations\openshop exec playwright test tests/hstar-foundation.e2e.spec.js tests/hstar-desktop-interactions.e2e.spec.js tests/hstar-text-properties.e2e.spec.js tests/hstar-import-eyedropper-performance.e2e.spec.js tests/hstar-editor-interaction-reliability.e2e.spec.js --workers=1
```

Expected: 全部通过，无工程画布残留。

- [ ] **Step 4: 核验差异边界**

```powershell
git diff --check
git status --short
git log --oneline -8
```

Expected: 本轮实现文件已提交；`data/asset_library.json`、顶层 `static/*.html` 和 `assets/` 仍保持用户原有未提交状态，未进入任何提交。

- [ ] **Step 5: 工程版浏览器手工验证**

确认 `http://127.0.0.1:3000/` 的活动存储根仍为 `E:\Hstar缓存`。重新加载 OpenShop 编辑器后逐项验证六项行为，只使用现有图文分层项目，不新建 HstarA 测试画布；不得清理或迁移稳定安装版数据。

- [ ] **Step 6: 保留分支供用户测试**

保持分支 `codex/openshop-inline-generative-editing` 和当前工作树，不合并 `main`、不推送，等待用户实际操作反馈。
