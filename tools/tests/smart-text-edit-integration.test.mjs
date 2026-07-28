import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const js = readFileSync(new URL('../../static/js/smart-canvas.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../../static/css/smart-canvas.css', import.meta.url), 'utf8');
const main = readFileSync(new URL('../../main.py', import.meta.url), 'utf8');

const toolbarPreviewIndex = js.indexOf("{key:'preview', icon:'eye', label:'预览'");
const toolbarMarkerIndex = js.indexOf("{key:'marker', icon:'map-pin', label:'标记'");
const toolbarTextEditIndex = js.indexOf("{key:'textEdit', icon:'type', label:'编辑文字'");
const toolbarCropIndex = js.indexOf("{key:'crop', icon:'crop', label:'裁剪'");

assert.ok(toolbarPreviewIndex >= 0, 'smart image toolbar should keep preview action');
assert.ok(toolbarMarkerIndex > toolbarPreviewIndex, 'smart image toolbar should keep marker after preview');
assert.ok(toolbarTextEditIndex > toolbarMarkerIndex, 'smart image toolbar should place text edit after marker');
assert.ok(toolbarCropIndex > toolbarTextEditIndex, 'smart image toolbar should place crop after text edit');
assert.match(js, /key:'textEdit'[\s\S]*dropdown:true/, 'text edit toolbar action should declare a dropdown indicator');
assert.match(js, /smart-node-action-caret[\s\S]*chevron-down/, 'text edit toolbar button should render a small dropdown chevron');
assert.match(css, /\.smart-node-action-caret/, 'text edit dropdown chevron should have dedicated compact styling');
assert.match(js, /smartTextEditMenuState\?\.nodeId === nodeId[\s\S]*menu\.classList\.contains\('open'\)[\s\S]*closeSmartTextEditMenu\(\);[\s\S]*return;/, 'clicking the same text edit button again should close the dropdown menu');
assert.match(js, /world\.appendChild\(menu\);/, 'text edit dropdown should be mounted in the smart canvas world so it stays attached to the toolbar button while zooming');
assert.match(js, /function positionSmartTextEditMenu\(\)/, 'text edit dropdown should have a dedicated world-space positioning function');
assert.match(js, /const buttonLeft = \(rect\.left - shellRect\.left - viewport\.x\) \/ safeScale;/, 'text edit dropdown should convert the toolbar button screen rect into world coordinates');
assert.match(css, /\.smart-text-edit-menu \{[^}]*position:absolute;/, 'text edit dropdown should be positioned in canvas-world coordinates');
assert.match(js, /const SMART_TEXT_EDIT_PANEL_WIDTH = 280;/, 'text edit panel should use a fixed width constant');
assert.match(js, /const SMART_TEXT_EDIT_PANEL_HEIGHT = 420;/, 'text edit panel should use a fixed height constant');
assert.doesNotMatch(js, /SMART_TEXT_GENERATION_PANEL_HEIGHT/, 'generation selector should not use a different height from the text edit panel');
assert.doesNotMatch(js, /smartTextOverlayHost/, 'text edit panel should not resolve or call a top-level overlay host');
assert.doesNotMatch(js, /function ensureSmartTextOverlayStyles\(/, 'text edit panel should not inject duplicate top-page overlay styles');
assert.match(js, /const width = SMART_TEXT_EDIT_PANEL_WIDTH;/, 'text edit panel should keep a stable canvas-world width independent of node resizing');
assert.match(js, /const targetHeight = SMART_TEXT_EDIT_PANEL_HEIGHT;/, 'generation selector and text edit views should use the same canvas-world height');
assert.match(js, /world\.appendChild\(panel\);/, 'text edit panel should stay mounted in the smart canvas world so it follows and scales with its source node');
assert.match(js, /panel\.addEventListener\('pointerdown',\s*e => e\.stopPropagation\(\)\);[\s\S]*panel\.addEventListener\('click',\s*e => e\.stopPropagation\(\)\);/, 'text edit panel should keep internal clicks from closing the panel');
assert.match(js, /function moveNodeElementsDuringDrag\(\)[\s\S]*positionSmartTextEditPanel\(\);[\s\S]*scheduleInteractionLayerRefresh\(\);/, 'text edit panel should reposition while its node is dragged');
assert.match(js, /function updateNodeElementDuringResize\(node\)[\s\S]*positionSmartTextEditPanel\(\);[\s\S]*scheduleInteractionLayerRefresh\(\);/, 'text edit panel should reposition when its node is resized');
assert.doesNotMatch(js, /const uiScale = 1 \/ scale;|scale\(\$\{uiScale\}\)/, 'text edit and generation panels should not counter-scale against canvas zoom');
assert.match(js, /const worldWidth = width;[\s\S]*const worldHeight = height;/, 'panel clamping should use the same canvas-world footprint that scales with the node');
assert.match(js, /const viewLeft = -viewport\.x \/ scale;[\s\S]*const viewRight = viewLeft \+ viewWidth;/, 'text edit panel should clamp position using world-space viewport bounds');
assert.match(js, /panel\.style\.transform = '';/, 'panel should clear legacy inverse scaling and inherit the canvas world transform');
assert.match(css, /\.smart-text-edit-panel \{[^}]*position:absolute;/, 'text edit panel should be positioned in canvas-world coordinates');
assert.match(css, /\.smart-text-edit-panel \*,\.smart-text-edit-panel button,.smart-text-edit-panel textarea \{[^}]*font-size:10px !important;/, 'all text inside the text edit panel should match the smart toolbar text size');
assert.match(js, /data-smart-text-panel-action="mode"[\s\S]*data-smart-text-mode="modify"[\s\S]*修改文字[\s\S]*data-smart-text-mode="erase"[\s\S]*消除文字/, 'text edit panel should use clickable modify/erase mode tabs instead of a static title');
assert.match(js, /function renderSmartTextRecognitionControls\(/, 'text edit panel should render text recognition API controls');
assert.match(js, /id="smartTextProviderSelect"[\s\S]*id="smartTextModelSelect"/, 'modify mode should expose provider and model selects for text recognition');assert.match(js, /data-smart-text-panel-action="recognize"[\s\S]*识别文字/, 'modify mode should expose a manual recognize text button under the text API controls');
assert.match(css, /\.smart-text-recognize-row[\s\S]*\.smart-text-recognize-row button/, 'manual recognize text button should have compact panel styling');
assert.match(js, /if\(action === 'recognize' && smartTextEditPanelState\) reloadSmartTextRecognition\(\);/, 'manual recognize text button should trigger OCR with the selected API settings');
assert.match(js, /data-smart-text-panel-action="cancelRecognize"[\s\S]*取消识别/, 'modify mode should expose a cancel recognition button beside recognize text');
assert.match(js, /if\(action === 'cancelRecognize' && smartTextEditPanelState\) cancelSmartTextRecognition\(\);/, 'cancel recognition button should abort the current OCR request');
assert.match(js, /function cancelSmartTextRecognition\(\)/, 'smart text recognition should define a cancel function');
assert.match(js, /state\.recognitionRequestId = \(state\.recognitionRequestId \|\| 0\) \+ 1;/, 'cancel recognition should invalidate any in-flight OCR response');
assert.match(js, /new AbortController\(\)/, 'smart text recognition should create an AbortController for each OCR request');
assert.match(js, /recognizeSmartImageText\(state\.nodeId,\s*state\.imageIndex,\s*\{provider,\s*model,\s*signal:controller\.signal\}\)/, 'smart text recognition should pass the abort signal to the OCR request');
assert.match(js, /signal:options\.signal/, 'smart text OCR fetch should use the passed abort signal');
assert.match(css, /\.smart-text-recognize-row button \{[^}]*background:var\(--strong\);[^}]*color:var\(--strong-text\)/, 'recognize and cancel recognition buttons should use the same filled style as the active modify tab');
assert.match(js, /smartTextEditPanelState = \{nodeId, imageIndex, mode:mode === 'erase' \? 'erase' : 'modify',[\s\S]*status:'idle'/, 'opening modify text panel should wait for the user to click recognize text');
assert.doesNotMatch(js, /if\(mode === 'modify' && smartTextEditPanelState\.status === 'idle'\) reloadSmartTextRecognition\(\);/, 'switching back to modify mode after cancellation should not auto-restart OCR');
assert.match(js, /function smartTextNodeStateKey\(imageIndex=0\)/, 'text edit should store OCR state by source image index');
assert.match(js, /function smartTextStoredState\(node, imageIndex=0\)/, 'text edit should read persisted OCR state from the source node');
assert.match(js, /function saveSmartTextPanelStateToNode\(\)/, 'text edit should persist recognized rows and edits back to the source node');
assert.match(js, /if\(item\) item\.next = field\.value;[\s\S]*saveSmartTextPanelStateToNode\(\);/, 'typing in recognized text fields should keep node-backed state alive after the panel closes');
assert.match(js, /Object\.assign\(smartTextEditPanelState, hydrateSmartTextPanelState\(node, imageIndex, mode\)\)/, 'opening the panel should hydrate from stored OCR state for the same image');
assert.doesNotMatch(js, /function closeSmartTextModifyPanel\(\)[\s\S]{0,220}smartTextEditPanelState = null;/, 'closing the text edit panel should hide it without deleting recognized text state');
assert.doesNotMatch(js, /if\(smartTextEditPanelState\.mode === 'modify'\) await reloadSmartTextRecognition\(\);/, 'opening modify text panel should not auto-run text recognition');
assert.doesNotMatch(js, /saveMarkerApiPreference\(smartTextEditPanelState\.textProvider, smartTextEditPanelState\.textModel\);\s*reloadSmartTextRecognition\(\);/, 'changing text API settings should not auto-run text recognition');
assert.match(js, /function renderSmartTextEraseControls\(/, 'erase mode should render image generation API controls');
assert.match(js, /data-smart-text-erase-param="provider_id"[\s\S]*data-smart-text-erase-param="model"[\s\S]*data-smart-text-erase-param="ratio"[\s\S]*data-smart-text-erase-param="resolution"[\s\S]*data-smart-text-erase-param="quality"[\s\S]*data-smart-text-erase-param="count"/, 'erase mode should expose image API platform, model, ratio, resolution, quality, and count settings');
assert.match(js, /const smartTextEraseRatioOptions = \[/, 'erase mode should use explicit ratio options like the image node generation size control');
assert.match(js, /data-smart-text-erase-param="ratio"[\s\S]*16:9[\s\S]*data-smart-text-erase-param="resolution"[\s\S]*4K/, 'erase mode size display should show ratio plus resolution like the image node footer API settings');
assert.doesNotMatch(js, /function smartTextSourceRatioSettings\(/, 'text erase generation should not lock to the source image aspect ratio');
assert.doesNotMatch(js, /customRatio:\`\$\{size\.w\}:\$\{size\.h\}\`/, 'text erase generation should not inject source image ratio into generation settings');
assert.doesNotMatch(js, /smartTextEraseRunSettings[\s\S]{0,260}smartTextSourceRatioSettings/, 'text erase settings should come only from the user-selected image API controls');
assert.match(js, /runSmartImageTextGeneration\(state\.nodeId,\s*state\.imageIndex,\s*smartTextErasePrompt\(\),\s*'消除文字',\s*runSettings\)/, 'apply erase should reuse the downstream text generation path');
const smartTextErasePromptSource = js.slice(
  js.indexOf('function smartTextErasePrompt()'),
  js.indexOf('async function runSmartImageTextGeneration')
);
const smartTextErasePromptValue = Function(`"use strict"; ${smartTextErasePromptSource}; return smartTextErasePrompt();`)();
assert.match(smartTextErasePromptValue, /Remove every visible textual element/i, 'erase prompt should explicitly remove every visible textual element');
assert.match(smartTextErasePromptValue, /letters, numbers, punctuation/i, 'erase prompt should cover letters, numbers, and punctuation');
assert.match(smartTextErasePromptValue, /text-based logos/i, 'erase prompt should remove logos made from text without targeting graphical logos');
assert.match(smartTextErasePromptValue, /people, faces, facial expressions, hands, objects, icons, stickers, illustrations, shapes, lines/i, 'erase prompt should enumerate protected non-text subjects and design elements');
assert.match(smartTextErasePromptValue, /colors, gradients, lighting, shadows, textures, patterns, composition, perspective/i, 'erase prompt should protect visual styling and composition');
assert.match(smartTextErasePromptValue, /only inside the areas previously covered by text/i, 'erase prompt should confine background reconstruction to text-covered areas');
assert.match(smartTextErasePromptValue, /Do not remove, redraw, replace, restyle, move, resize, or alter any non-text visual element/i, 'erase prompt should forbid every common non-text mutation');
assert.match(smartTextErasePromptValue, /Honor the user-requested output dimensions and aspect ratio/i, 'erase prompt should respect the user-selected target size instead of locking source dimensions');
assert.match(smartTextErasePromptValue, /Do not generate, preserve, or introduce any readable text/i, 'erase prompt should prevent residual or newly hallucinated text');
assert.doesNotMatch(smartTextErasePromptValue, /typographic decorations/i, 'erase prompt should not use an ambiguous phrase that can erase independent decorative graphics');
assert.match(smartTextErasePromptValue, /Remove glyph outlines, strokes, shadows, glows, and highlights only where they follow the contours of readable glyphs/i, 'erase prompt should limit removable effects to glyph-shaped effects');
assert.match(smartTextErasePromptValue, /Preserve outlines, strokes, shadows, and highlights that belong to a container or independent graphic/i, 'erase prompt should protect effects owned by non-text containers');
assert.match(smartTextErasePromptValue, /background plates, colored blocks, panels, banners, ribbons, badges, buttons, tickets, speech bubbles, frames, borders, dividers, underlines, curves, shapes, patterns, and decorations/i, 'erase prompt should protect generic text-supporting and decorative graphics');
assert.match(smartTextErasePromptValue, /If a colored, outlined, or shaped area extends beyond the glyph contours, treat the entire area as a protected non-text element/i, 'erase prompt should classify graphics extending beyond glyphs as protected containers');
assert.match(smartTextErasePromptValue, /Fill only the holes left by the removed glyph pixels/i, 'erase prompt should repair glyph holes instead of replacing whole containers');
assert.match(smartTextErasePromptValue, /Never erase, flatten, enlarge, shrink, simplify, or replace an entire container/i, 'erase prompt should forbid deleting or redesigning text-supporting containers');
assert.match(smartTextErasePromptValue, /A non-text element remains protected even when text touches, overlaps, sits inside, or is fully surrounded by it/i, 'erase prompt should preserve overlapping and enclosing graphics');
assert.match(smartTextErasePromptValue, /restore any non-text feature that was removed or changed/i, 'erase prompt should require a final non-text consistency check');
assert.match(js, /data-smart-text-panel-action="selectGeneration"[\s\S]*选择生图模型/, 'modify mode should expose a generation model selector before the cancel action');
assert.match(js, /smart-text-generation-summary/, 'modify mode should render a dedicated generation settings summary');
assert.match(js, /未选择生图模型/, 'modify mode should show an explicit default generation settings summary');
assert.match(js, /data-smart-text-panel-action="confirmGeneration"/, 'the secondary generation settings layer should expose an explicit confirmation action');
assert.match(js, /data-smart-text-generation-engine/, 'the secondary generation settings layer should expose an image engine selector');
assert.match(js, /data-smart-text-panel-action="cancelGeneration"[\s\S]*data-lucide="arrow-left"/, 'the secondary generation settings layer should use a return icon instead of a second close icon');
assert.match(js, /function renderSmartTextResolutionControl\(prefix=''\)/, 'smart text generation should render resolution separately from size');
assert.match(js, /renderRatioControl\(prefix, includeSource\)[\s\S]*renderSmartTextResolutionControl\(prefix\)/, 'the smart text selector should replace the combined size picker with separate controls');
assert.match(css, /\.smart-text-generation-head \{[^}]*flex:0 0 34px;/, 'generation selector header should be compact enough to fit the text edit panel height');
assert.match(css, /\.smart-text-generation-layer \{[^}]*inset:0;/, 'generation selector should cover the full text edit panel so both views have the same height');
assert.match(css, /\.smart-text-generation-content \{[^}]*padding:6px 10px;[^}]*gap:8px;/, 'generation selector content should preserve even compact spacing');
assert.match(css, /\.smart-text-generation-fields \{[^}]*flex-direction:column;[^}]*gap:6px;/, 'generation settings should form an evenly spaced compact vertical list');
assert.match(css, /\.smart-text-generation-fields \.smart-pill \{[^}]*width:100%;[^}]*height:32px;[^}]*border-radius:8px;/, 'every generation setting row should share one compact full-width button box');
assert.match(css, /\.smart-text-generation-fields \.model-control \.smart-pill \{[^}]*max-width:none;/, 'the model selector should override the compact canvas footer width');
assert.match(css, /content:attr\(data-smart-text-field-label\)/, 'each full-width row should expose a left-aligned field label');
assert.match(css, /\.smart-text-generation-fields \.smart-control:not\(\.pinned\) \.smart-popover \{[^}]*opacity:0;[^}]*visibility:hidden;[^}]*pointer-events:none;/, 'generation setting popovers should stay closed until clicked');
assert.match(css, /\.smart-text-generation-fields \.smart-control\.pinned \.smart-popover \{[^}]*opacity:1;[^}]*visibility:visible;[^}]*pointer-events:auto;/, 'a clicked generation setting should be the only open popover state');
assert.doesNotMatch(css, /\.smart-text-generation-fields \.smart-control:hover \.smart-popover/, 'hover should not open generation setting popovers');
assert.doesNotMatch(css, /\.smart-text-generation-fields \.smart-control:focus-within \.smart-popover/, 'focus alone should not open generation setting popovers');
assert.doesNotMatch(css, /\.smart-text-generation-fields \.smart-control\.interacting \.smart-popover/, 'generation setting popovers should not retain the legacy hover interaction state');
assert.match(js, /const closePopovers = \(\) => container\.querySelectorAll\('\.smart-control\.pinned'\)/, 'generation popover toggle should close only explicitly pinned controls');
assert.doesNotMatch(js, /function bindSmartTextGenerationFields\([\s\S]*?control\.onmouseleave = \(\) => control\.classList\.remove\('interacting'\);/, 'generation popover binding should not depend on mouse leave');
assert.match(js, /class="seg-row smart-text-resolution-options"/, 'resolution options should have their own three-column layout hook');
assert.match(css, /\.smart-text-generation-fields \.smart-text-resolution-options \{[^}]*grid-template-columns:repeat\(3,minmax\(0,1fr\)\);/, '1K, 2K, and 4K should use three equal columns');
assert.match(css, /\.smart-text-generation-fields \.seg-row button,\s*\.smart-text-generation-fields \.count-cell \{[^}]*height:30px;[^}]*min-height:30px;/, 'resolution, quality, and count choices should use comfortable click targets');
assert.match(css, /\.smart-text-edit-actions \.smart-text-generation-trigger \{[^}]*background:var\(--strong\);[^}]*color:var\(--strong-text\);[^}]*border-color:var\(--strong\);/, 'generation selector trigger should share the filled theme-aware recognition button style');
assert.match(js, /left = Math\.max\(viewLeft \+ inset, Math\.min\(left, viewRight - worldWidth - inset\)\);/, 'the text edit panel should remain horizontally visible when its node leaves the viewport during zoom');
assert.match(js, /generationSettingsConfirmed/, 'text edit state should distinguish prefilled settings from confirmed settings');
assert.match(js, /runSmartImageTextGeneration\(state\.nodeId,\s*state\.imageIndex,\s*prompt,\s*'修改文字',\s*runSettings\)/, 'apply modification should pass the confirmed settings to the shared downstream image generation path');
assert.match(js, /applySmartTextSourceRatioToDraft\(state, prefix\);[\s\S]*splitSmartTextGenerationSizeControl\(state, container, prefix/, 'source ratio should be rebound to the image owned by the text edit panel before rendering the split size controls');
assert.match(js, /function confirmSmartTextGenerationSelector\(\)[\s\S]*applySmartTextSourceRatioToDraft\(state, prefix\);[\s\S]*confirmSmartTextGenerationSession\(state\);/, 'confirming the selector should refresh the source ratio before storing settings');
assert.match(js, /const runSettings = cloneSmartTextGenerationSettings\(state\.generationSettings\);[\s\S]*applySmartTextSourceRatioToSettings\(state, runSettings, prefix\);/, 'applying text changes should refresh source ratio immediately before building the request');
assert.match(js, /splitSmartTextGenerationSizeControl\(state, container, prefix[\s\S]*renderInlineCustomRatioFields\(prefix\)/, 'the split size selector should render editable ratio fields when custom is selected');
assert.match(css, /\.smart-text-generation-fields > \.inline-fields \{[^}]*width:100%;[^}]*border-radius:8px;/, 'custom ratio inputs should use a visible full-width row in the generation selector');
assert.match(js, /function explicitRequestOutputSizeForPending\(sourceSettings=settings\)/, 'pending preview sizing should accept the settings for the current run');
assert.match(js, /const requestSize = explicitRequestOutputSizeForPending\(options\.settings \|\| settings\);/, 'pending preview layout should prefer the current run settings over global canvas settings');
assert.doesNotMatch(js, /document\.body\.appendChild\(panel\);/, 'text edit panel should not be mounted under body because StudioScale can transform body');
assert.doesNotMatch(js, /document\.body\.appendChild\(menu\);/, 'text edit dropdown should not be mounted under body because it would drift away from the scaled canvas toolbar');
assert.doesNotMatch(js, /document\.documentElement\.appendChild\(panel\);|host\.doc\.documentElement\.appendChild\(panel\);/, 'text edit panel should not be mounted in a screen-space document overlay');
assert.doesNotMatch(js, /logicalRect \? logicalRect\.width|nodeRect\(node\)[\s\S]{0,120}const width/, 'text edit panel width should not depend on image node size');
assert.doesNotMatch(js, /Math\.max\(220,\s*rect \? rect\.width : 260\)/, 'text edit panel width should not use zoom-scaled screen rect width');
assert.doesNotMatch(js, /rect \? rect\.height|nodeRect\(node\)[\s\S]{0,160}const height/, 'text edit panel height should not depend on image node size');
assert.match(css, /\.smart-text-edit-head \{[^}]*height:44px;[^}]*padding:7px 9px 7px 10px;[^}]*align-items:center;/, 'text edit panel header should reserve the same top breathing room used by the erase-text layout');
assert.match(css, /\.smart-text-edit-head strong \{[^}]*font-size:10px/, 'text edit panel title should match the toolbar text size');
assert.match(css, /\.smart-text-edit-tabs button \{[^}]*flex:0 0 78px;[^}]*width:78px;[^}]*min-width:78px;[^}]*height:26px;[^}]*display:inline-flex;[^}]*align-items:center;[^}]*justify-content:center;[^}]*box-sizing:border-box;[^}]*padding:0 12px;[^}]*appearance:none;/, 'modify and erase text tabs should share the same fixed button box as the erase-text tab');
assert.doesNotMatch(css, /\.smart-text-edit-(?:head|body|field|empty|error|actions)[\s\S]{0,220}font-size:1[1-9]px/, 'text edit panel text should not exceed the toolbar text size');
assert.match(css, /\.smart-text-edit-menu button \{[^}]*height:24px;[^}]*gap:5px;[^}]*font-size:10px;[^}]*font-weight:400;/, 'text edit dropdown actions should match smart toolbar text sizing');
assert.match(css, /\.smart-text-edit-menu button i,\.smart-text-edit-menu button svg \{[^}]*width:12px;[^}]*height:12px;/, 'text edit dropdown icons should match smart toolbar icon sizing');

for (const fn of [
  'openSmartTextEditMenu',
  'closeSmartTextEditMenu',
  'openSmartTextModifyPanel',
  'openSmartTextErasePanel',
  'recognizeSmartImageText',
  'applySmartTextModification',
  'applySmartTextErase',
  'eraseSmartImageText',
  'runSmartImageTextGeneration'
]) {
  assert.match(js, new RegExp(`function ${fn}\\(`), `smart text edit should define ${fn}`);
}

assert.match(js, /data-smart-text-action="modify"[\s\S]*修改文字/, 'text edit menu should include modify text');
assert.match(js, /data-smart-text-action="erase"[\s\S]*消除文字/, 'text edit menu should include erase text');
assert.match(js, /fetch\('\/api\/smart-image\/text\/recognize'/, 'smart text recognition should call the backend OCR endpoint');
assert.match(js, /generateUrlsForCurrentSettings\([^)]*prompt[^)]*refs[^)]*runSettings/, 'text edit should reuse the smart canvas image generation chain');
assert.match(js, /createPendingOutputFromSource\(node,[\s\S]*runSettings\.count[\s\S]*meta,[\s\S]*selectOutput:true[\s\S]*refs[\s\S]*settings:runSettings/, 'text edit modification should create a downstream preview from the confirmed image generation settings');
assert.match(js, /generateUrlsForCurrentSettings\(outputNode,\s*prompt,\s*refs,\s*runSettings\)/, 'text edit modification should run generation on the new downstream node');
assert.match(js, /const sourceRef = smartRefWithMarkers\(imageForDisplay\(item\),[\s\S]*const refs = uniqueReferenceImages\(\[sourceRef\]\)\.filter\(ref => ref\?\.url\);/, 'text modification and erase should derive a real source-image reference');
assert.match(js, /replaceOutputsToNodeWithHistory\(outputNode,\s*additions/, 'text edit results should be written into the downstream node instead of the source image node');
assert.doesNotMatch(js, /runSettings\.count = 1;/, 'text edit image generation should not force count to 1 and should respect the source node setting');
assert.match(js, /if\(!refs\.length\) throw new Error\('修改文字需要原图参考，但当前节点没有可发送的图片'\);/, 'text edit generation should never fall back to a text-only image request');
assert.match(js, /runSettings\.requireReferenceImage = true;/, 'text edit generation should mark API requests as requiring a reference image');
assert.match(js, /const payload = \{prompt, provider_id:runSettings\.provider_id, model:runSettings\.model,[\s\S]*reference_images:imageRefs\};/, 'text edit generation should send the selected provider, exact model, and source image to the shared image task');
assert.match(js, /const runLog = \{\.\.\.smartRunSnapshot\(node, prompt, refs, 'image'\), settings:cloneSmartSettings\(runSettings\), size:sizeForRun\(runSettings\)\};[\s\S]*const runLogStart = nowMs\(\);/, 'text edit generation should prepare the same run log metadata as normal image runs');
assert.match(js, /addSmartGenerationLog\(\{run:runLog, outputs:result\.urls, runMs:nowMs\(\) - runLogStart\}\);/, 'successful text edit generation should enter the smart canvas run log');
assert.match(js, /delete outputNode\.pendingTasks;[\s\S]*outputNode\.runTimerHidden = true;[\s\S]*addSmartGenerationLog\(\{run:runLog, outputs:\[\], runMs:nowMs\(\) - runLogStart, error:err\?\.message \|\| String\(err\)\}\);/, 'failed text edit generation should stop pending state, hide the timer, and enter the smart canvas run log');
assert.match(js, /nodes = nodes\.filter\(n => n\.id !== outputNode\.id\);[\s\S]*canvas\.connections = \(canvas\.connections \|\| \[\]\)\.filter\(c => c\.from !== outputNode\.id && c\.to !== outputNode\.id\);/, 'failed text edit generation should remove the empty downstream pending node');

for (const cls of [
  'smart-text-edit-menu',
  'smart-text-edit-panel',
  'smart-text-edit-field',
  'smart-text-edit-actions',
  'smart-text-edit-action-row',
  'smart-text-generation-layer',
  'smart-text-generation-summary'
]) {
  assert.match(css, new RegExp(`\\.${cls}`), `smart text edit CSS should include ${cls}`);
}

assert.match(main, /class SmartImageTextRecognizeRequest\(BaseModel\)/, 'backend should define smart text recognition payload');
assert.match(main, /@app\.post\("\/api\/smart-image\/text\/recognize"\)/, 'backend should expose smart text recognition route');
assert.match(main, /text_from_chat_response\(raw\)/, 'backend route should read text model response');
const ocrRouteStart = main.indexOf('@app.post("/api/smart-image/text/recognize")');
const ocrRouteEnd = main.indexOf('@app.post("/api/local-assets/caption")', ocrRouteStart);
const ocrRoute = main.slice(ocrRouteStart, ocrRouteEnd);
assert.match(ocrRoute, /is_gemini_cli_provider\(/, 'text OCR should detect the Antigravity CLI provider');
assert.match(ocrRoute, /gemini_cli_chat_text\(/, 'text OCR should send the image through the Antigravity CLI adapter');

console.log('smart text edit integration tests passed');
