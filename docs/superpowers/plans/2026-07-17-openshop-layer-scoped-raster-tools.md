# OpenShop Layer-Scoped Raster Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 OpenShop 高频栅格工具限定到当前图层，修复字体家族/字型归类，并为图像缩放加入画板四边吸附。

**Architecture:** 新增无每笔全局监听器的栅格会话控制器，直接修改活动图层图像的内存像素并保持 Fabric 对象身份。字体服务输出家族与真实字型两级结构，文字属性面板按真实字面应用；吸附引擎新增纯缩放几何计算，由主编辑器在 `object:scaling` 中应用。

**Tech Stack:** JavaScript、Fabric.js 5.3、Python ctypes/GDI、Vitest、unittest、Playwright。

---

## Task 1: 建立栅格会话失败测试

**Files:**
- Create: `integrations/openshop/tests/hstar-raster-tools.test.js`
- Modify: `integrations/openshop/tests/os-unit.test.js`

- [ ] 测试活动图层选择：两层各含一张图时，目标只能来自 `activeLayerIdx`。
- [ ] 测试画笔和橡皮擦线段直接写入目标内存画布，不调用 `canvas.add`，结束时只调用一次历史提交。
- [ ] 测试橡皮擦使用目标上下文的 `destination-out`，其他图层元素和像素上下文零调用。
- [ ] 测试仿制图章设置源点和绘制不会调用复制、粘贴、重复或对象替换命令。
- [ ] 运行：

```powershell
npm.cmd --prefix integrations\openshop test -- tests/hstar-raster-tools.test.js tests/os-unit.test.js
```

Expected: 新控制器不存在，RED。

## Task 2: 实现活动图层栅格会话

**Files:**
- Create: `integrations/openshop/host/openshop-raster-tools.js`
- Modify: `integrations/openshop/index.html`
- Delete: `integrations/openshop/host/openshop-live-eraser.js`
- Delete: `integrations/openshop/tests/hstar-live-eraser.test.js`

- [ ] 实现 `createController({editor,fabricRef,documentRef,requestFrame})`，公开 `begin/move/end/cancel/setCloneSource/getState`。
- [ ] 用逆变换把文档指针映射到图像像素；画笔使用 `source-over`，橡皮擦使用目标局部 `destination-out`。
- [ ] 仿制图章从笔画开始时冻结的源画布取样，原位更新同一 Fabric 图像对象。
- [ ] 将 `brush`、`eraser`、`clone` 的主鼠标入口改为控制器调用，关闭 Fabric `isDrawingMode`，移除三种工具的 `path:created` 依赖。
- [ ] `setTool` 切换前取消未完成会话，`mouse:up` 和窗口 `pointerup` 复用同一个结束函数。
- [ ] 运行聚焦测试，Expected: GREEN。

## Task 3: 统一栅格目标与原位替换

**Files:**
- Modify: `integrations/openshop/index.html`
- Modify: `integrations/openshop/tests/os-unit.test.js`

- [ ] 先写测试：修复画笔、润饰、填充、删除选区在多图层下不能选中其他图层图像。
- [ ] 实现 `_activeLayerRasterTarget(pointer)`，只返回可见、未锁定活动图层中的图像。
- [ ] 替换 clone/healing/retouch/fill/delete 的全画布图像回退。
- [ ] 修复 `_replaceActiveImage`：复制业务元数据，以原 canvas 索引插回，并保持活动图层数组位置。
- [ ] 运行 `os-unit.test.js`，Expected: GREEN。

## Task 4: 字体家族与字型

**Files:**
- Modify: `openshop_fonts.py`
- Modify: `tests/test_openshop_fonts.py`
- Modify: `integrations/openshop/host/openshop-font-catalog.js`
- Modify: `integrations/openshop/host/openshop-text-properties.js`
- Modify: `integrations/openshop/tests/hstar-font-catalog.test.js`
- Modify: `integrations/openshop/tests/hstar-text-properties.test.js`

- [ ] Python RED：`DengXian` 与 `DengXian Light` 输出一个家族、两个带真实 `family` 的字型。
- [ ] 前端 RED：已有 Light 文本显示基础家族，字型选项选中 Light；选 Regular 写入基础真实字面。
- [ ] 后端按受控后缀和权重归类，保留不能识别的名称为独立家族。
- [ ] 字体管理器新增 `resolveFamily`、`defaultStyleFor`、`styleForFace`，克隆时保留字型真实 family。
- [ ] 文字属性面板用字型 id 作为选项值，切换时同时应用真实 family、weight、style。
- [ ] 运行：

```powershell
python -m unittest tests.test_openshop_fonts
npm.cmd --prefix integrations\openshop test -- tests/hstar-font-catalog.test.js tests/hstar-text-properties.test.js
```

Expected: GREEN。

## Task 5: 缩放四边吸附

**Files:**
- Modify: `integrations/openshop/host/openshop-snap-engine.js`
- Modify: `integrations/openshop/index.html`
- Modify: `integrations/openshop/tests/openshop-snap-engine.test.js`
- Modify: `integrations/openshop/tests/os-unit.test.js`

- [ ] RED：参数化测试左、右、上、下和四角控制点只调整对应可移动边。
- [ ] 实现 `resolveScale({objectRect,documentRect,corner,tolerance})` 返回目标矩形和命中来源。
- [ ] 监听 `object:scaling`，仅对无旋转、无倾斜、未锁定对象应用缩放与位置补偿。
- [ ] 验证超出容差后不保留吸附，移动吸附行为不回归。
- [ ] 运行聚焦测试，Expected: GREEN。

## Task 6: 发布与浏览器回归

**Files:**
- Modify: `integrations/openshop/scripts/build-hstar.mjs`
- Modify: `tools/tests/openshop-localization-build.test.mjs`
- Modify: `integrations/openshop/tests/hstar-editor-interaction-reliability.e2e.spec.js`

- [ ] 将 `host/openshop-raster-tools.js` 加入严格白名单，移除旧实时橡皮擦文件。
- [ ] E2E 覆盖双图层擦除隔离、对象数稳定、画笔随图层移动、图章堆叠稳定、字体字型和缩放四边吸附。
- [ ] 重建 `static/openshop`，不创建 HstarA 工程测试画布。
- [ ] 运行完整 Vitest、关键 Playwright、汉化审计、编码健康和构建白名单测试。
- [ ] `git diff --check` 后只提交本轮文件，保留用户原有素材和顶层页面改动。

