# OpenShop Photoshop 2023 Behavior Baseline Design

## Product boundary

OpenShop keeps its current compact page layout, visual hierarchy, toolbar placement, panels, and dark UI. Its original editing implementation is not a compatibility constraint. Tool algorithms, selection semantics, raster mutation, keyboard and pointer interaction, snapping, document coordinates, and layer ownership may be replaced whenever necessary to reproduce Photoshop 2023 behavior.

## Behavioral rules

1. Raster tools mutate only the selected editable raster layer. They never create movable stroke objects and never affect sibling layers.
2. Brush opacity is deposited per stroke. Eraser opacity reduces alpha progressively instead of switching pixels directly between opaque and transparent. Soft presets use a radial falloff so the edge is weaker than the center.
3. Brush-family tools expose a live cursor outline at the exact on-document diameter after viewport zoom. The outline follows the pointer without triggering a canvas render.
4. Font family is the typographic family. Installed faces that belong to that family appear under the style selector using their real face names, such as `B`, `H`, `Light`, or `Regular`; no synthetic Regular/Light pair is invented.
5. Scale snapping evaluates the raw pointer-proposed geometry for every event. A moving edge snaps immediately inside tolerance and releases immediately outside tolerance. Previously snapped geometry is never reused as the next raw proposal.
6. `Ctrl+mouse wheel` zooms the document around the pointer. An unmodified wheel is left available for normal page or panel scrolling and must not silently zoom the document.
7. The lasso is a press-drag-release freehand selection. The magic wand uses color distance, contiguous mode, and modifier-based new/add/subtract/intersect selection modes. Both produce pixel masks and marching-ants boundaries, not a bounding-box-only approximation.
8. Selection modifiers follow Photoshop conventions: plain creates a new selection, Shift adds, Alt subtracts, and Shift+Alt intersects.

## Module boundaries

- `host/openshop-raster-tools.js`: layer-scoped raster stroke sessions and brush dab compositing.
- `host/openshop-brush-cursor.js`: DOM cursor outline, viewport-aware sizing, and tool visibility.
- `host/openshop-selection-engine.js`: mask creation, polygon rasterization, magic-wand flood fill, mask composition, and bounds.
- `host/openshop-snap-engine.js`: stateless geometry resolution.
- `openshop_fonts.py`: installed face discovery and family/style normalization.
- `index.html`: UI state, event routing, and rendering orchestration only.

## Non-goals for this iteration

This iteration does not clone every Photoshop lasso variant, anti-alias/feather dialog, pressure-sensitive tablet dynamics, or Select and Mask workspace. The architecture must leave those additions possible without another editor-wide rewrite.
