# OpenShop Default Font Fallback Design

## Goal

Make manually created and OCR-extracted OpenShop text use predictable preferred fonts without assuming those fonts are installed on every Windows computer.

- Simplified and Traditional Chinese text prefers `阿里巴巴普惠体 3.0`.
- English, numbers, and other Latin text prefers `03免 阿里妈妈灵动体VF`.
- Horizontal and vertical text use the same script-based policy.
- Missing preferred fonts fall back to an installed font and finally to a generic system family.

## Central Font Resolution

The OpenShop font catalog remains the single source of truth for font availability and fallback selection. It exposes a script-aware default face resolver that returns a usable family, face family, weight, and italic state.

Resolution order is:

1. The preferred installed family for the script.
2. An installed common system font suitable for that script.
3. Another installed font from the same catalog category.
4. `system-ui` or `sans-serif` as a guaranteed browser and Fabric fallback.

The resolver must never throw only because either preferred family is absent.

## Manual Text Creation

Horizontal and vertical text objects share one automatic script-font policy. New objects are marked as using this policy and receive script-specific Fabric styles as their text changes:

- CJK runs use the resolved Chinese default face.
- Latin and numeric runs use the resolved English default face.
- Neutral punctuation and whitespace inherit the nearest meaningful run, with the Chinese default as the final fallback.

The policy applies only to newly created text that still uses automatic defaults. An explicit font choice from the text properties panel disables automatic substitution for the affected text scope, so later typing does not overwrite the user's choice.

The automatic-policy marker is serialized with the existing OpenShop Fabric custom properties so project reload preserves behavior.

## OCR Text Layers

OCR continues to use a reliable recognized font match when that font is installed. If a requested or preferred OCR font is unavailable, each recognized run uses the same script-aware default resolver as manual text.

Fallback must preserve the OCR run's weight, italic state, size, color, writing mode, position, rotation, spacing, stroke, shadow, and editable text. Font absence must not prevent creation of the remaining valid text layers.

## Compatibility

- Existing text objects and saved OCR layers keep their stored families and styles.
- Existing missing-font replacement controls remain available.
- No font files are bundled into the installer by this change.
- Font discovery continues to use the current OpenShop system-font API.
- Computers without either preferred font still create, edit, save, reload, and export text normally.

## Error Handling

Font catalog loading failure falls back to generic system families. A missing preferred font is normal fallback behavior and does not create a global error banner. Errors are reserved for malformed text or font metadata that prevents creation after generic fallback has also failed.

## Verification

Automated tests cover:

- preferred Chinese and English families when installed;
- system and generic fallback when one or both preferred families are absent;
- horizontal and vertical manual text creation;
- mixed CJK and Latin run styling;
- explicit user font selection disabling automatic replacement;
- OCR matched-font preservation and missing-font fallback;
- project serialization and reload of the automatic-policy marker;
- unchanged OCR geometry and writing-mode behavior.

Browser verification checks manual horizontal text, manual vertical text, mixed text, and OCR conversion in an OpenShop node with no preferred-font dependency.
