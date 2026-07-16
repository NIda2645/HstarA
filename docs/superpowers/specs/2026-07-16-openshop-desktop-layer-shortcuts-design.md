# OpenShop Desktop Layer Selection and Photoshop Shortcuts Design

## Goal

Make OpenShop's desktop editing controls understandable and keyboard-efficient:

- Every left-toolbar tool exposes its current Simplified Chinese name and shortcut on hover or keyboard focus.
- The layer panel supports Photoshop-style single, additive, and range selection.
- Layer actions operate consistently on all selected layers.
- Keyboard shortcuts follow Photoshop 2023 for functionality that OpenShop already implements.
- `Delete` acts on layers after layer-panel interaction and on pixels or canvas objects after canvas interaction.

This work does not add Photoshop features that OpenShop does not already implement.

## Current Problems

1. Tool buttons already have localized `data-tip` values, but their CSS pseudo-element tooltips are descendants of the vertically scrolling toolbar. Browser overflow rules clip the tooltip outside the 46-pixel toolbar.
2. Layer state has only `activeLayerIdx`. There is no representation for multiple selected layers or a range-selection anchor.
3. The global `Delete` handler only checks selection pixels and Fabric active objects. It cannot tell that the user last selected a layer row.
4. Shortcut declarations are duplicated between the key handler, shortcut dialog, command palette, and toolbar labels. Several current keys conflict with Photoshop conventions.

## Non-Goals

- Persisting selected layer rows in an OpenShop project.
- Adding unsupported Photoshop tools or commands.
- Replacing Fabric object selection with layer selection.
- Changing mobile touch behavior; tooltips remain disabled in the mobile bottom toolbar.
- Reworking the visual structure or width of the left toolbar.

## Architecture

### 1. Body-Level Tool Tooltip

Create one reusable `#tool-tooltip` element under `document.body`.

- Listen for `pointerenter`, `pointerleave`, `focusin`, and `focusout` on `.tool-btn[data-tip]`.
- Read the translated value from `button.dataset.tip` when the tooltip opens. This keeps locale changes authoritative.
- Open after 250 ms to avoid noise while the pointer crosses the toolbar.
- Position to the right of the hovered button with fixed positioning and clamp the top edge to the viewport.
- Hide on pointer leave, blur, tool activation, flyout close, locale change, window resize, or toolbar scroll.
- Render the full localized name and shortcut, for example `矩形选框工具（M）`.
- Use the same tooltip for flyout tools, including the shortcut of the currently represented tool.
- Keep `aria-label` synchronized with the translated `data-tip` value.

The clipped `::after` tooltip is removed or disabled on desktop. Mobile keeps tooltips hidden.

### 2. Ephemeral Layer Selection State

Keep the existing `activeLayerIdx` as the primary layer for compatibility. Add:

- `_selectedLayers`: a `Set` of layer object references.
- `_layerSelectionAnchor`: the layer object used for Shift range selection.
- `_keyboardContext`: either `layers` or `canvas`.

Layer object references are stable across array reorder, insertion, and deletion. Selection is reset when a document or serialized project rebuild replaces all layer objects.

At least one layer remains selected whenever layers exist. The primary layer is always a member of `_selectedLayers`.

### 3. Layer Selection Semantics

- Plain click: select only the clicked layer and make it primary and the new anchor.
- Ctrl+click: add or remove the clicked layer. The final remaining layer cannot be deselected. Adding makes the clicked layer primary. Removing the primary chooses the nearest remaining selected layer as primary.
- Shift+click: select the inclusive range between the anchor and clicked layer. Existing selections outside the range are replaced, matching normal Photoshop range selection.
- Ctrl+Shift+click: add the inclusive anchor range to the existing selection.
- The last clicked selected layer is primary and drives fields that need one source value.
- Selected rows receive a shared selected style. The primary row also receives a stronger primary indicator.
- `aria-selected` and the hidden accessibility layer list expose selected and primary states.

Clicking the layer panel sets `_keyboardContext` to `layers`. Pointer or keyboard interaction with the canvas sets it to `canvas`.

### 4. Batch Layer Operations

The following actions operate on `_selectedLayers`:

- Delete
- Duplicate
- Visibility
- Lock state
- Reorder by drag
- Opacity
- Blend mode

Behavior details:

- Delete removes every selected unlocked layer in one history entry. Locked layers are skipped and reported. If all selected layers are locked, nothing changes.
- The locked background boundary layer is never deleted.
- Duplicate preserves selected layer order, inserts all copies as one contiguous block immediately above the highest selected layer, and selects only the copies.
- Visibility and lock buttons apply the clicked target state to all selected layers when the clicked row is selected. Clicking an unselected row affects only that row.
- Opacity and blend controls apply one value to every selected layer. The primary layer remains the value shown in mixed-state controls until the user changes it.
- Dragging a selected row moves all selected unlocked layers as one contiguous block while preserving their current z-order. Locked selected layers stay in place and are reported.
- Dragging an unselected row first reduces selection to that row.
- Single-layer behavior remains identical to the current implementation.
- `Ctrl+E` merges selected layers when two or more are selected; with one selected layer it keeps the existing Merge Down behavior. `Ctrl+Shift+E` retains Merge Visible.

All batch operations write one history snapshot and trigger one canvas render and one layer-panel rebuild.

### 5. Context-Aware Delete

The key dispatcher resolves `Delete` and `Backspace` in this order:

1. Editable input, select, textarea, contenteditable, or active Fabric text editing: do not intercept.
2. Layer keyboard context with selected layers: delete selected layers and stop.
3. Active pixel selection: delete selected pixels and stop.
4. Active Fabric object or object selection: delete the object selection and stop.
5. Otherwise do nothing and do not prevent the browser default.

Layer context does not silently fall through to canvas deletion when all selected layers are locked.

### 6. Shortcut Registry

Replace scattered shortcut conditionals and display-only lists with one registry used by:

- The global key dispatcher.
- Toolbar tooltip shortcut suffixes.
- The keyboard shortcuts dialog.
- Command-palette shortcut labels.

The dispatcher normalizes Ctrl, Alt, Shift, key values, editable targets, Fabric text editing, and active interaction context. Browser defaults are prevented only when OpenShop executes a matching command.

Core Photoshop-compatible mappings for current OpenShop functionality:

| Keys | OpenShop action |
| --- | --- |
| Ctrl+Alt+K | Command palette (custom, non-conflicting) |
| Ctrl+K | Preferences |
| Ctrl+N | New document |
| Ctrl+O | Open image |
| Ctrl+S | Save project |
| Ctrl+Alt+Shift+W | Export settings / Export As |
| Ctrl+Z | Undo |
| Ctrl+Shift+Z | Redo |
| Ctrl+X / Ctrl+C / Ctrl+V | Cut / Copy / Paste |
| Ctrl+J | Duplicate selected layers in layer context; duplicate selected objects in canvas context |
| Ctrl+T | Free transform |
| Ctrl+A / Ctrl+D | Select all / Deselect |
| Ctrl+Shift+D / Ctrl+Shift+I | Reselect / Invert selection |
| Ctrl+I | Invert image |
| Ctrl+Alt+C | Resize canvas |
| Ctrl+L / Ctrl+M / Ctrl+B | Levels / Curves / Color Balance |
| Ctrl+Shift+N | New layer |
| Ctrl+E / Ctrl+Shift+E | Merge selected or down / Merge visible |
| Alt+[ / Alt+] | Select adjacent lower / upper layer |
| Ctrl+[ / Ctrl+] | Move selected layers down / up |
| Ctrl+Shift+[ / Ctrl+Shift+] | Move selected layers to bottom / top |
| Ctrl+R | Toggle rulers |
| Ctrl+' | Toggle grid |
| Ctrl+0 / Ctrl+1 | Fit view / 100% zoom |
| Ctrl++ / Ctrl+- | Zoom in / out |
| Tab | Toggle panels |
| F | Cycle fullscreen editing view |
| Delete / Backspace | Context-aware layer, pixel, or object deletion |
| Enter / Escape | Commit or cancel the active operation |
| Space (hold) | Temporary hand tool |
| [ / ] | Brush size down / up |
| D / X | Default colors / Swap colors |

Tool mappings:

| Key | Tool or tool cycle |
| --- | --- |
| V | Move / Select |
| M / Shift+M | Rectangular / Elliptical Marquee |
| L | Lasso |
| W / Shift+W | Magic Wand / AI Segment Select |
| C | Crop |
| B / Shift+B | Brush / Pencil / Spray |
| J | Healing Brush |
| S | Clone Stamp |
| E | Eraser |
| G / Shift+G | Gradient / Fill Bucket / Pattern Fill |
| O / Shift+O | Dodge / Burn / Sponge |
| R | Smudge |
| P | Pen |
| T | Text |
| U / Shift+U | Rectangle / Ellipse / Triangle / Line / Arrow / Polygon / Star |
| I / Shift+I | Eyedropper / Measure / Sticky Note |
| H | Hand / Pan |
| Z | Zoom |

`Shift+tool key` cycles in the listed order and updates the group face, tooltip, and selected tool. Existing custom keys that conflict with Photoshop mappings are removed from the dispatcher and shortcut dialog.

## Data and Project Isolation

Layer selection, anchor, and keyboard context are editor-session UI state only. They are not serialized into project data, sent through the Hstar bridge, or shared between OpenShop nodes. Opening another OpenShop node receives its own state through its own iframe/editor instance.

Layer mutations continue through the existing project adapter and project-changed bridge, so batch operations persist exactly like current single-layer operations.

## Error Handling

- Invalid or stale selected layer references are normalized before every batch operation.
- If a project rebuild removes selected layers, selection resets to the current primary layer.
- Locked layers are skipped for destructive or positional operations with one concise toast.
- A batch operation that has no eligible layers does not create history.
- Shortcut handlers never run while a user is typing or editing Fabric text.
- Tooltip timers are cancelled on teardown-like transitions and never retain detached button references.

## Testing

### Unit tests

- Tooltip host reads translated `data-tip`, opens after the configured delay, clamps placement, and hides correctly.
- Plain, Ctrl, Shift, and Ctrl+Shift layer selection produce the expected selected set and primary layer.
- Delete uses layer context after a layer click and canvas context after canvas interaction.
- Locked layers are skipped without deleting canvas objects.
- Duplicate, visibility, lock, opacity, blend, and reorder apply to the selected layer set with one history entry.
- Shortcut normalization ignores editable targets and cycles Photoshop tool groups.
- Shortcut dialog and toolbar labels use the same registry values.

### Browser tests

- At a desktop viewport, hovering top, middle, bottom, and flyout tools displays visible Simplified Chinese labels with shortcuts outside the toolbar bounds.
- Ctrl and Shift clicks visibly select the correct layer rows.
- Delete removes selected layer rows without deleting unrelated canvas objects.
- Batch controls and drag reorder preserve order and project output.
- Canvas Delete behavior remains unchanged after returning focus to the canvas.
- No tooltip or panel content overlaps at standard desktop and 4K viewports.

### Regression suites

- OpenShop Vitest unit suite.
- Hstar foundation E2E.
- Hstar canvas integration E2E.
- Hstar generative and text-tool E2E.
- `build:hstar` followed by verification against `static/openshop/index.html`.

## Acceptance Criteria

1. Every visible desktop toolbar tool shows a readable Simplified Chinese name and shortcut on hover.
2. Tooltips are not clipped by toolbar scrolling or viewport edges.
3. Ctrl and Shift layer selection matches the specified Photoshop semantics.
4. All approved batch actions affect the selected layer set and preserve layer order.
5. Delete removes selected layers after layer interaction and keeps existing canvas deletion after canvas interaction.
6. Current OpenShop capabilities use the Photoshop-compatible shortcut registry without conflicting legacy keys.
7. Typing, layer renaming, and Fabric text editing never trigger editor shortcuts.
8. Selection state remains isolated per OpenShop node and is not serialized.
9. Relevant unit and browser regression suites pass after rebuilding the static runtime.
