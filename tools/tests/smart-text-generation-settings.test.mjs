import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../../static/js/smart-canvas.js', import.meta.url), 'utf8');

function functionSource(name) {
  const match = source.match(new RegExp(`^function ${name}\\([^]*?^}`, 'm'));
  assert.ok(match, `smart-canvas.js should define ${name}`);
  return match[0];
}

const names = [
  'cloneSmartTextGenerationSettings',
  'smartTextGenerationSession',
  'cancelSmartTextGenerationSession',
  'confirmSmartTextGenerationSession',
  'smartTextResolutionOptions',
  'normalizeSmartTextResolution',
  'validateSmartTextGenerationSettings',
  'smartTextGenerationSummaryParts',
  'gcdInt',
  'imageSizeForRatio',
  'reducedRatioForImage',
  'smartTextSourceRatioForState',
  'applySmartTextSourceRatioToSettings',
  'applySmartTextSourceRatioToDraft',
  'sizeForRun',
  'explicitRequestOutputSizeForPending',
];

let smartTextSubject = null;
const context = {
  settings: {},
  cloneSmartSettings(value) {
    return JSON.parse(JSON.stringify(value || {}));
  },
  settingsForStorage(value) {
    return JSON.parse(JSON.stringify(value || {}));
  },
  apiProviderById(id) {
    return id === 'runninghub' ? { id, name: 'RunningHub API' } : { id, name: id };
  },
  selectedRunningHubRef(value) {
    if (!value?.rhConfigKey) return null;
    return { kind: 'workflow', id: value.rhConfigKey, label: '海报工作流' };
  },
  runningHubEntryLabel(entry) {
    return entry?.label || entry?.id || '';
  },
  msModelLabel(key) {
    return key === 'zimage' ? 'Z-Image' : key;
  },
  defaultSmartApiResolution() {
    return '1k';
  },
  isGptImageAutoSizeModel() {
    return false;
  },
  isApiLikeEngine(engine) {
    return engine === 'api' || engine === 'volcengine';
  },
  apiImageSize(ratio, resolution, customRatio) {
    const ratios = {
      square: [1, 1], portrait43: [3, 4], wide: [16, 9], source: String(customRatio || '').split(':').map(Number),
    };
    const [w, h] = ratios[ratio] || [1, 1];
    const longEdge = resolution === '4k' ? 4096 : 1024;
    return w <= h
      ? `${Math.round(longEdge * w / h)}x${longEdge}`
      : `${longEdge}x${Math.round(longEdge * h / w)}`;
  },
  parseSizeValue(value) {
    const match = String(value || '').match(/^(\d+)x(\d+)$/);
    return match ? { width: Number(match[1]), height: Number(match[2]) } : null;
  },
  smartTextEditSubject(nodeId, imageIndex) {
    return smartTextSubject && smartTextSubject.nodeId === nodeId && smartTextSubject.imageIndex === imageIndex
      ? smartTextSubject.subject
      : null;
  },
};
vm.createContext(context);
vm.runInContext(
  `${names.map(functionSource).join('\n')}\nthis.helpers = { ${names.join(', ')} };`,
  context,
);

const {
  cancelSmartTextGenerationSession,
  confirmSmartTextGenerationSession,
  normalizeSmartTextResolution,
  smartTextGenerationSession,
  smartTextGenerationSummaryParts,
  smartTextResolutionOptions,
  smartTextSourceRatioForState,
  applySmartTextSourceRatioToSettings,
  applySmartTextSourceRatioToDraft,
  explicitRequestOutputSizeForPending,
  validateSmartTextGenerationSettings,
} = context.helpers;

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

test('prefills a draft without implicitly confirming it', () => {
  const state = { generationSettingsConfirmed: false };
  smartTextGenerationSession(state, {
    engine: 'api', provider_id: 'runninghub', model: 'seedream-v4',
    ratio: 'story', resolution: '4k', quality: 'auto', count: 1,
  });
  assert.equal(state.generationSettingsConfirmed, false);
  assert.equal(state.generationSettingsDraft.model, 'seedream-v4');
  assert.equal(state.generationSettings, undefined);
  assert.equal(state.generationSettingsDraft.apiKind, 'image');
  assert.equal(state.generationSelectorOpen, true);
});

test('cancel discards only the draft', () => {
  const confirmed = { engine: 'modelscope', msgenModel: 'zimage', count: 2 };
  const state = {
    generationSettingsConfirmed: true,
    generationSettings: confirmed,
    generationSettingsDraft: { engine: 'api', model: 'other' },
    generationSelectorOpen: true,
    generationSettingsError: '错误',
  };
  cancelSmartTextGenerationSession(state);
  assert.equal(state.generationSettings, confirmed);
  assert.equal(state.generationSettingsDraft, null);
  assert.equal(state.generationSelectorOpen, false);
  assert.equal(state.generationSettingsError, '');
});

test('confirm clones the draft into durable settings', () => {
  const state = {
    generationSettingsDraft: {
      engine: 'api', apiKind: 'image', provider_id: 'runninghub',
      model: 'seedream-v4', ratio: 'wide', resolution: '2k', quality: 'high', count: 3,
    },
    generationSelectorOpen: true,
  };
  const confirmed = confirmSmartTextGenerationSession(state);
  assert.equal(state.generationSettingsConfirmed, true);
  assert.notEqual(confirmed, state.generationSettingsDraft);
  assert.equal(state.generationSettingsDraft, null);
  assert.equal(state.generationSelectorOpen, false);
  assert.equal(state.generationSettings.model, 'seedream-v4');
});

test('validation identifies incomplete engine settings', () => {
  assert.match(validateSmartTextGenerationSettings({ engine: 'api', provider_id: '', model: '' }), /平台|模型/);
  assert.match(validateSmartTextGenerationSettings({ engine: 'api', provider_id: 'p', model: 'm', resolution: 'custom', customWidth: 1024 }), /宽度|高度|尺寸/);
  assert.match(validateSmartTextGenerationSettings({ engine: 'modelscope', msgenModel: 'custom', msCustomModel: '' }), /ModelScope|模型/);
  assert.match(validateSmartTextGenerationSettings({ engine: 'comfy', comfyMode: 'custom', comfyWorkflow: '' }), /ComfyUI|工作流/);
  assert.match(validateSmartTextGenerationSettings({ engine: 'runninghub', rhConfigKey: '' }), /RunningHub|模型|应用|工作流/);
  assert.match(validateSmartTextGenerationSettings({ engine: 'api', provider_id: 'p', model: 'poster-model-2k', resolution: '4k' }), /分辨率|模型/);
  assert.equal(validateSmartTextGenerationSettings({ engine: 'api', provider_id: 'p', model: 'm', ratio: 'wide', resolution: '2k' }), '');
});

test('resolution choices always expose 1K 2K and 4K', () => {
  assert.deepEqual(plain(smartTextResolutionOptions({ model: 'seedream-v5-pro' })), [
    { value: '1k', disabled: false },
    { value: '2k', disabled: false },
    { value: '4k', disabled: false },
  ]);
});

test('model names with an explicit resolution disable unsupported choices', () => {
  assert.deepEqual(plain(smartTextResolutionOptions({ model: 'gpt-image2-4k' })), [
    { value: '1k', disabled: true },
    { value: '2k', disabled: true },
    { value: '4k', disabled: false },
  ]);
});

test('resolution normalization replaces a stale unsupported draft value', () => {
  const draft = { model: 'gpt-image2-2k', resolution: '4k' };
  assert.equal(normalizeSmartTextResolution(draft), '2k');
  assert.equal(draft.resolution, '2k');
});

test('ModelScope custom models use the prefixed resolution field', () => {
  const draft = { msgenModel: 'custom', msCustomModel: 'poster-model-4k', msResolution: '1k' };
  assert.equal(normalizeSmartTextResolution(draft, 'ms'), '4k');
  assert.equal(draft.msResolution, '4k');
});

test('summary reports the confirmed engine, model, size, quality, and count', () => {
  assert.deepEqual(plain(smartTextGenerationSummaryParts({
    engine: 'api', provider_id: 'runninghub', model: 'seedream-v4',
    ratio: 'wide', resolution: '2k', quality: 'high', count: 3,
  })), ['RunningHub API', 'seedream-v4', '16:9 / 2K', '高质量', '3 张']);
  assert.deepEqual(plain(smartTextGenerationSummaryParts({
    engine: 'runninghub', rhConfigKey: 'poster-flow', count: 1,
  })), ['RunningHub', '海报工作流', '1 张']);
});

test('source ratio is derived from the image bound to the text edit panel', () => {
  smartTextSubject = {
    nodeId: 'source-node',
    imageIndex: 2,
    subject: { image: { natural_w: 2448, natural_h: 3264 } },
  };
  const state = {
    nodeId: 'source-node',
    imageIndex: 2,
    generationSettingsDraft: {
      ratio: 'source', customRatio: '144:223', customRatioWidth: 144, customRatioHeight: 223,
    },
  };

  assert.deepEqual(plain(smartTextSourceRatioForState(state)), { w: 3, h: 4 });
  applySmartTextSourceRatioToDraft(state);
  assert.equal(state.generationSettingsDraft.customRatio, '3:4');
  assert.equal(state.generationSettingsDraft.customRatioWidth, 3);
  assert.equal(state.generationSettingsDraft.customRatioHeight, 4);
});

test('pending preview size uses the confirmed run settings instead of global canvas settings', () => {
  context.settings = {
    engine: 'api', apiKind: 'image', ratio: 'source', resolution: '4k', customRatio: '144:223',
  };
  assert.deepEqual(plain(explicitRequestOutputSizeForPending({
    engine: 'api', apiKind: 'image', ratio: 'portrait43', resolution: '4k', customRatio: '3:4',
  })), { w: 3072, h: 4096 });
});

const sizeMappingContext = {
  SIZE_MAP: {
    square: { '1k': '1024x1024', '2k': '2048x2048', '4k': '4096x4096' },
    portrait: { '1k': '1024x1536', '2k': '1360x2048', '4k': '2352x3520' },
    portrait43: { '1k': '1008x1344', '2k': '1536x2048', '4k': '2448x3264' },
    landscape43: { '1k': '1344x1008', '2k': '2048x1536', '4k': '3264x2448' },
    landscape: { '1k': '1536x1024', '2k': '2048x1360', '4k': '3520x2352' },
    story: { '1k': '720x1280', '2k': '1152x2048', '4k': '2160x3840' },
    wide: { '1k': '1280x720', '2k': '2048x1152', '4k': '3840x2160' },
    ultrawide: { '1k': '1280x544', '2k': '2048x880', '4k': '3840x1648' },
    ultratall: { '1k': '544x1280', '2k': '880x2048', '4k': '1648x3840' },
  },
  RES_LONG_SIDE: { '1k': 1536, '2k': 2048, '4k': 3840 },
  RES_PIXEL_LIMIT: { '1k': 1572864, '2k': 4194304, '4k': 8294400 },
};
vm.createContext(sizeMappingContext);
vm.runInContext(
  `${functionSource('parseRatioValue')}\n${functionSource('apiImageSize')}\nthis.apiImageSizeUnderTest = apiImageSize;`,
  sizeMappingContext,
);

test('source 3:4 maps to the same request size as the explicit 3:4 preset', () => {
  assert.equal(sizeMappingContext.apiImageSizeUnderTest('source', '4k', '3:4'), '2448x3264');
});

test('arbitrary custom ratios preserve their aspect while respecting the pixel limit', () => {
  const value = sizeMappingContext.apiImageSizeUnderTest('custom', '4k', '5:7');
  const [width, height] = value.split('x').map(Number);
  assert.ok(Math.abs(width / height - 5 / 7) < 0.01, `${value} should remain close to 5:7`);
  assert.ok(width * height <= sizeMappingContext.RES_PIXEL_LIMIT['4k']);
});
