# OpenShop Horizontal and Vertical Text Tool Design

## Scope

OpenShop's left text tool becomes a two-option tool group:

- Horizontal Type Tool (`横排文字工具`)
- Vertical Type Tool (`直排文字工具`)

Horizontal and vertical type-mask tools are explicitly out of scope. The selected
mode must drive real text creation and editing behavior, not only change the menu
label or icon.

This is an incremental part of the current typography/OCR work. It reuses the
existing OpenShop visual language, font catalog, text properties panel, layer
model, history, project serialization, and tool-flyout infrastructure.

## Alternatives Considered

1. Rotate a horizontal text object by 90 degrees. Rejected because glyphs rotate,
   cursor movement is wrong, and OCR positions cannot be reconstructed faithfully.
2. Insert newline characters between every glyph. Rejected because stored content
   is corrupted, copy/paste is wrong, editing adds duplicate line breaks, and Latin
   words and punctuation cannot be handled consistently.
3. Add an explicit writing-mode property and a vertical text implementation.
   Selected because it preserves the user's real text while allowing separate
   horizontal and vertical layout, editing, serialization, OCR conversion, and
   future punctuation rules.

## Tool Flyout

The existing standalone text button becomes a `tool-group` with two visible menu
rows. Each row contains an orientation icon, a Simplified Chinese label, and the
`T` shortcut hint. The menu contains no mask entries.

- Clicking the current face button opens the two-item menu.
- Clicking `横排文字工具` selects horizontal mode and closes the menu.
- Clicking `直排文字工具` selects vertical mode and closes the menu.
- Clicking outside closes the menu.
- The group face adopts the last selected mode's icon, label, and tooltip.
- The selected menu row has a clear active state.
- Pressing `T` activates the last selected text orientation without opening the
  menu, matching grouped-tool behavior.
- The menu remains within the OpenShop viewport and is not clipped by the toolbar.

The default mode for new and legacy documents is horizontal.

## Typography State

One canonical writing mode is used by the left tool group, top text options,
right text properties panel, manual text creation, OCR conversion, and selected
text objects:

```text
hstarWritingMode: "horizontal" | "vertical"
```

Selecting an existing text object updates the tool group and text controls to the
object's stored mode. Changing mode while a text object is selected converts its
layout without changing its textual content, font family, face, size, color,
weight, spacing, rotation, or effects. New objects inherit the active mode.

Legacy text objects without `hstarWritingMode` are normalized to `horizontal`.

## Horizontal Text

Horizontal mode keeps the existing left-to-right editable text behavior. Clicking
outside an existing text object creates a new text layer; clicking inside an
existing text object enters editing for that object. Each new text object belongs
to its own text layer.

## Vertical Text

Vertical mode stores the original text unchanged and lays glyphs from top to
bottom. New columns progress from right to left. Enter starts a new vertical
column. Editing, selection, copy/paste, delete, undo/redo, layer selection, and
project reload must preserve the original text and writing mode.

The first implementation must correctly handle Chinese characters, Latin letters,
digits, whitespace, line breaks, and common punctuation. It must not implement
vertical mode by rotating the whole object or mutating the stored text with
synthetic newlines. Bounds, controls, hit testing, and export must use the rendered
vertical geometry.

## OCR Integration

OCR blocks gain a normalized writing-mode field. Explicit model output is used
when valid; otherwise geometry and line order infer the mode. A vertical OCR block
creates a vertical editable text layer at its source quad. A horizontal block
continues to create horizontal text.

Orientation is independent of rotation. Rotation describes the text block's angle
within the image, while writing mode describes glyph flow. OCR conversion keeps
the recognized content, position, size, font match, face/weight, color, tracking,
line spacing, alignment, rotation, stroke, and shadow metadata.

## Persistence

`hstarWritingMode` and any vertical-layout metadata are included in OpenShop's
Fabric serialization and the durable per-node project file. Reloading a canvas or
reopening the same layered node must restore editable vertical text without
flattening or changing direction.

## Accessibility and Localization

The two menu rows expose Simplified Chinese accessible names and tooltips:

- `横排文字工具`
- `直排文字工具`

The artistic-font action remains separate. Its hover and state messages are also
Simplified Chinese, including `艺术字体处理`, `没有原图参考`, and
`艺术字体处理中`.

## Testing

Automated coverage must prove:

- the text group contains exactly two options and no mask tools;
- open, outside-click close, selection, active state, and last-mode `T` behavior;
- horizontal and vertical creation produce separate text layers;
- vertical storage keeps raw text unchanged and renders top-to-bottom;
- Enter creates a right-to-left next column;
- selecting and converting existing text synchronizes all controls;
- undo/redo and project serialization preserve writing mode;
- OCR horizontal/vertical normalization maps to the correct object mode;
- exported output contains the rendered vertical text;
- Chromium viewport checks show a visible, unclipped flyout at desktop and compact
  editor sizes.

Tests are written and observed failing before production changes. The built
`static/openshop` copy receives the same verified source revision before the
engineering service is restarted.
