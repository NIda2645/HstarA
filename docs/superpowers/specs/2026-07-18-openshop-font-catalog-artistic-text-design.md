# OpenShop Font Catalog And Artistic Text Design

## Purpose

This design covers two connected improvements to OpenShop's text workflow:

1. Make the installed-font dropdown fast and stable with thousands of fonts while preserving the user's free-commercial naming convention.
2. Extend text extraction so editable OCR text can be revised and then rendered by an image model in the original artistic lettering style.

The existing OpenShop UI shell remains unchanged. The implementation may change font catalog, text properties, OCR, AI task, persistence, and layer integration code where required.

## Confirmed User Rules

- `01免` means a free-commercial Simplified Chinese font.
- `02免` means a free-commercial Traditional Chinese font.
- `03免` means a free-commercial English font.
- These are the only free-commercial categories. The `免` marker remains visible in the dropdown.
- The Chinese dropdown section orders ordinary Chinese fonts first, then `01免`, then `02免`.
- The English dropdown section orders `03免` first, then other English fonts.
- A font family appears once. Thin, Light, Regular, Medium, Bold, and other faces are selected through the separate style control.
- Automatic OCR font matching may only choose from the matching `01免`, `02免`, or `03免` pool.
- If no free-commercial font is a reliable match, use the installed `阿里巴巴普惠体 3.0` family.
- Artistic OCR text also starts as editable `阿里巴巴普惠体 3.0` text.
- Font fallback changes only the family. It must not flatten every block to Regular or discard the source block's visual properties.
- Artistic rendering uses the user's current edited text, not the original OCR text.
- A successful artistic render creates a raster layer immediately above the editable text layer and hides the editable layer.
- Only OCR-derived text layers with a valid original-image reference can execute artistic font processing.

## Current Problems And Evidence

### Font dropdown

The current dropdown rebuilds every font row on each open, sets the real font family on every row, attaches one listener per row, and calls `scrollIntoView` on the selected item. The current machine exposes more than 2,500 catalog entries. Opening the dropdown therefore causes a large synchronous DOM insertion, font resolution, layout, and parent-panel scrolling in one interaction. This explains both the delayed open and the vertical panel jump.

The Windows registry contains approximately 405 `01免`, 191 `02免`, and 915 `03免` installed face records under the `CodexFreeCommercial` user-font directory. The catalog also contains duplicate registry/GDI forms such as a base family plus a `Regular [number]` record. The client currently treats the `免` character as Chinese text, which incorrectly classifies `03免` English fonts as Chinese.

### OCR text

OCR currently records position, language, confidence, a short font candidate list, size, weight, style, color, alignment, and rotation. The client then independently scales the resulting Fabric text object in X and Y to force it into the OCR quad. That can visibly compress or stretch glyphs.

The existing OCR result does not contain enough structured data for accurate local font matching or artistic reconstruction. It also does not retain all source information needed to render an edited string in the original artistic style later.

## Architecture

The work is split into four bounded components:

1. **Windows font catalog normalization** in `openshop_fonts.py` produces canonical families, style faces, availability, free-commercial category, language group, and stable sort metadata.
2. **Font catalog manager and virtual dropdown** in the OpenShop host files merge project references with the system catalog, expose sections, and render only visible rows.
3. **Extended OCR and local font matching** add a richer visual profile and apply it without non-uniform glyph distortion.
4. **Artistic text AI task** adds a dedicated persisted image-edit tool that uses current edited text plus the original OCR image region and applies the result as a new raster layer.

Each OpenShop node continues to own its project preferences, task records, source assets, and generated assets through the existing `(canvasType, canvasId, nodeId, projectId)` scope.

## Font Catalog Design

### Canonical server records

The server returns one record per actual family:

```json
{
  "family": "01免 Example Sans",
  "label": "01免 Example Sans",
  "languageGroup": "zh-hans",
  "freeCommercialCategory": "01",
  "sortName": "Example Sans",
  "styles": [
    {
      "id": "01-example-sans-400-normal",
      "family": "01免 Example Sans",
      "label": "Regular",
      "weight": 400,
      "italic": false,
      "localNames": ["01免 Example Sans"]
    }
  ]
}
```

Exact prefix rules are authoritative:

- `^01免` -> `zh-hans`, free category `01`
- `^02免` -> `zh-hant`, free category `02`
- `^03免` -> `en`, free category `03`

The classifier strips the prefix before any CJK-character test, so `03免` is not misclassified because of the marker itself. Unprefixed fonts continue to use their catalog metadata and normalized name for Chinese/English grouping.

Normalization removes installer-only disambiguators such as `[123]` and `[other-12]`, repeated style suffixes, registry format suffixes, and duplicate GDI/registry records. It preserves the real usable face name in each style. Registry entries whose backing file no longer exists are excluded during a refresh, so uninstalled fonts disappear instead of remaining as stale candidates.

The canonical resolver treats spelling/version aliases as the same display family only when an actually installed face confirms that relationship. For this machine, `阿里巴巴普惠体 3.0` is the required fallback and is not replaced by an uninstalled `3` alias.

### Section and ordering rules

The catalog manager exposes two top-level sections:

1. **Chinese fonts**
   - Unprefixed Chinese fonts
   - `01免` Simplified Chinese fonts
   - `02免` Traditional Chinese fonts
2. **English fonts**
   - `03免` English fonts
   - Unprefixed English fonts

Within each subgroup, names use a numeric-aware `zh-CN` collator over `sortName`, followed by the canonical family as a deterministic tie breaker. Missing project fonts remain visible only as project references with a missing badge; they are not eligible for automatic matching.

### Virtual dropdown

The dropdown uses a fixed-height scroll viewport and a flattened row model containing section headers, subgroup headers, and font rows. Only the visible range plus a small overscan is mounted. A top and bottom spacer preserve the full scroll height.

The row model is rebuilt only when the catalog changes, not on every open. Opening the dropdown:

- reveals the existing viewport;
- sets the viewport's own `scrollTop` to the selected row offset;
- renders the visible range;
- never calls `scrollIntoView`;
- never scrolls the parent properties panel.

One delegated click listener handles all font rows. Real font previews are applied only to mounted visible rows. Scroll rendering is coalesced through `requestAnimationFrame`. The dropdown has stable dimensions and layout containment so loading, hover, and selection states cannot resize the surrounding panel.

## Extended OCR Visual Profile

Each OCR block adds a script classification and richer font/effect data:

```json
{
  "script": "zh-hans",
  "font": {
    "familyCandidates": ["Candidate A", "Candidate B"],
    "size": 72,
    "weight": 650,
    "style": "normal",
    "artistic": false,
    "styleDescription": "geometric sans with square terminals",
    "letterSpacing": 12,
    "lineHeight": 1.1,
    "strokeColor": "#000000",
    "strokeWidth": 2,
    "shadow": {
      "color": "#00000080",
      "blur": 6,
      "offsetX": 4,
      "offsetY": 5
    }
  }
}
```

The server validates and bounds every numeric field. Unknown or invalid values fall back independently; one bad effect field cannot invalidate otherwise reliable text and geometry.

## Local Font Matching

Matching runs per OCR block and applies to every free-commercial candidate, not only the fallback family.

1. Select the eligible pool from `script`:
   - `zh-hans` -> `01免`
   - `zh-hant` -> `02免`
   - `en` -> `03免`
   - mixed text -> the pool for the dominant script reported by OCR
2. Normalize OCR candidate names and catalog aliases by removing free prefixes, installer numbers, punctuation differences, version spelling differences, and style suffixes.
3. Score family candidates using exact aliases first, then normalized name similarity and the OCR style description.
4. Reject a weak family score rather than silently selecting an unrelated font.
5. Within the selected family, choose the real face with the smallest distance from the OCR weight and the same italic state where available. Weight selection covers Thin, Light, Regular, Medium, SemiBold, Bold, ExtraBold, Heavy, and Black when the family provides them.
6. If no family is reliable, select `阿里巴巴普惠体 3.0` and still choose its closest real weight/style face.

Artistic blocks skip family matching and use `阿里巴巴普惠体 3.0` with the closest available weight/style as an editable carrier.

The text object receives the source size, weight, italic, fill, letter spacing, line height, alignment, rotation, stroke, and shadow. Position is anchored to the OCR quad. Width fitting first adjusts character spacing within bounded limits; if additional fitting is necessary, only a single uniform scale is allowed. Independent `scaleX` and `scaleY` fitting is forbidden.

## Artistic Text Processing

### Eligibility and layer control

Every text-layer row displays an artistic-text icon. It is enabled only when the text object has:

- an OCR block ID;
- an original source asset ID;
- the original normalized quad;
- a valid source layer/project scope.

Manual text layers show the disabled icon with the tooltip `没有原图参考`.

### Model selection

The text extraction panel contains two consecutive model sections:

1. language/vision OCR API and model;
2. artistic font image API and model.

The artistic selection uses its own `art-font-restore` preference. The first explicit selection is stored in the current OpenShop node project and remains selected across panel close, OpenShop close, canvas reload, and application restart until the user changes it. It does not overwrite the OCR model selection.

### Request input

When the user clicks the enabled layer icon, the request contains:

- the text object's current edited string;
- the original OCR source asset and tight quad;
- the original OCR size, weight, color, rotation, letter spacing, stroke, shadow, and style description;
- the current document dimensions and target layer identity;
- the separately saved image provider/model selection.

The original OCR text is retained only as provenance and is never substituted for the current edited string.

### Image generation and transparency

The backend crops the original source around the OCR quad with bounded transparent padding and sends that crop as the style reference. The prompt requires the exact current string, the original lettering style, transparent background, no additional symbols, and no scene/background reconstruction.

The output pipeline:

1. preserves a useful model-provided alpha channel;
2. if the result is opaque but has a uniform edge-connected background, removes only that connected matte;
3. rejects the result if transparency cannot be established reliably;
4. crops transparent margins without cropping visible glyph pixels;
5. stores the final PNG as an OpenShop project asset.

The client places the raster object at the original quad anchor and rotation. It uses one uniform scale and transparent padding to fit the original artistic bounds. It must not independently stretch width or height.

### Result application

On success:

- create `<editable layer name> - 艺术字体` directly above the editable layer;
- keep it visible and selected;
- hide the editable carrier layer;
- record one history entry so Undo removes the raster layer and restores carrier visibility;
- persist both layers and the applied task record in the node project.

On failure, cancellation, invalid alpha, stale session, or deleted source layer, no layer is inserted and the editable text layer remains visible.

## Background Task And Persistence Rules

`art-font-restore` is a dedicated OpenShop AI tool ID and uses the existing project-scoped task registry. The task continues when OpenShop is visually hidden, the user switches HstarA pages, or the OpenShop window closes. Task records and output assets remain scoped to one node project.

If a task finishes while the editor is closed, the pending result is reconciled on the next session open. The client applies it only when the owner scope, source layer, text layer, and request generation still match. Deleting the OpenShop node cancels its tasks and permanently removes only that node's project data and unreferenced assets.

Repeated clicks while one layer task is active are ignored. The row icon shows a stable busy state. Different OCR text layers may have independent tasks.

## Error Handling

- Font refresh failure keeps the last valid catalog and shows a non-blocking status.
- An unavailable saved model remains visible as unavailable; it is not silently replaced.
- Missing `阿里巴巴普惠体 3.0` is reported explicitly and does not fall back to an unrelated commercial font.
- OCR blocks with invalid geometry are skipped and reported; valid blocks still apply.
- Artistic image failures never hide or delete the editable text layer.
- A late result from another node, project, session, or superseded task is rejected.

## Testing Strategy

### Python

- Registry aliases are canonicalized and stale files are excluded.
- `01免/02免/03免` metadata and sort fields are correct.
- Duplicate installer/GDI styles collapse without losing usable face names.
- `阿里巴巴普惠体 3.0` remains distinct from removed aliases.
- OCR visual profile fields are validated and bounded.
- `art-font-restore` request snapshots contain current text and original style reference data.
- Transparent output validation and edge-matte removal reject unsafe results.

### OpenShop unit tests

- Catalog sections and subgroup ordering match the confirmed rules.
- Free-commercial matching never selects a font from the wrong category.
- Face selection chooses the nearest available weight/style for both matched and fallback families.
- Virtual dropdown mounts a bounded number of rows for a 2,500-font catalog.
- Opening the dropdown changes only its own scroll position and does not call `scrollIntoView`.
- Font refresh updates sections without moving the surrounding panel.
- OCR text applies full properties without non-uniform scaling.
- Artistic button eligibility, task request, pending restore, layer insertion, carrier hiding, and Undo behavior are covered.

### End-to-end

- Open a 2,500-entry font catalog and verify responsive open, scroll, selection, outside close, and stable panel geometry.
- Extract Simplified Chinese, Traditional Chinese, English, mixed, and artistic blocks with a deterministic fake OCR provider.
- Verify matched free-commercial family and nearest real face per block.
- Edit an artistic block's text, run a deterministic fake image task, and verify the request uses the edited text while the result preserves original geometry and hides the carrier layer.
- Close or hide OpenShop during the task, reopen the same node, and verify result reconciliation without cross-node data leakage.
- Run any real paid image request only when visual validation cannot be completed with deterministic fixtures and the user-provided test API remains explicitly authorized.

## Acceptance Criteria

- The font dropdown opens without perceptible bulk-render delay on the current 2,500-plus-font machine.
- Opening and selecting fonts does not move the surrounding properties panel.
- Chinese and English sections follow the confirmed `01免/02免/03免` ordering.
- Duplicate family/style rows no longer interfere with selection.
- Every OCR block preserves its own measured visual properties regardless of whether it uses a matched free-commercial family or `阿里巴巴普惠体 3.0`.
- No text block is independently stretched in X and Y.
- Artistic processing uses the current edited string and the original style reference.
- Artistic tasks survive OpenShop visibility/session changes and remain isolated per node.
- Failed artistic tasks leave the editable text visible and create no broken layer.

## Non-Goals

- Installing or downloading additional fonts from OpenShop.
- Creating a reusable system font file from an AI result.
- Automatically processing manual text layers that have no OCR source reference.
- Guaranteeing that an external image model succeeds; the application guarantees validated inputs, geometry preservation, safe result application, and non-destructive failure behavior.
