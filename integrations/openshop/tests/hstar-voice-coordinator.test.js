import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const testDir = dirname(fileURLToPath(import.meta.url));
const coordinatorPath = resolve(
  testDir,
  '..',
  '..',
  '..',
  'static',
  'js',
  'voice-assistant-coordinator.js',
);
const workletPath = resolve(
  testDir,
  '..',
  '..',
  '..',
  'static',
  'js',
  'voice-audio-worklet.js',
);
const stylesheetPath = resolve(
  testDir,
  '..',
  '..',
  '..',
  'static',
  'css',
  'voice-assistant.css',
);

class FakeSocket {
  static OPEN = 1;

  constructor() {
    this.readyState = 0;
    this.sent = [];
    this.close = vi.fn(() => {
      this.readyState = 3;
      this.onclose?.({code: 1000});
    });
  }

  open() {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }

  emit(payload) {
    this.onmessage?.({data: JSON.stringify(payload)});
  }

  send(payload) {
    this.sent.push(payload);
  }
}

function response(payload, ok = true) {
  return {
    ok,
    status: ok ? 200 : 503,
    json: vi.fn(async () => payload),
  };
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return {promise, resolve};
}

function readyStatus() {
  return {
    ok: true,
    status: {
      settings: {
        enabled: true,
        language: 'auto',
        input_device_id: 'default',
        shortcut: 'Shift+Q',
      },
      runtime: {ready: true, profile: 'cuda'},
      model: {ready: true},
      service: {process_state: 'stopped', model_state: 'unloaded'},
      task: null,
    },
  };
}

function makeTransaction() {
  return {
    update: vi.fn(),
    commit: vi.fn(),
    cancel: vi.fn(),
  };
}

function makeHarness({status = readyStatus(), fetchOverride = null, renderUi = false} = {}) {
  const socket = new FakeSocket();
  const track = {stop: vi.fn()};
  const stream = {getTracks: vi.fn(() => [track])};
  const source = {connect: vi.fn(), disconnect: vi.fn()};
  const worklet = {
    connect: vi.fn(),
    disconnect: vi.fn(),
    port: {postMessage: vi.fn(), close: vi.fn(), onmessage: null},
  };
  const gain = {
    connect: vi.fn(),
    disconnect: vi.fn(),
    gain: {value: 1},
  };
  const context = {
    sampleRate: 48000,
    destination: {},
    audioWorklet: {addModule: vi.fn(async () => {})},
    createMediaStreamSource: vi.fn(() => source),
    createGain: vi.fn(() => gain),
    close: vi.fn(async () => {}),
  };
  const mediaDevices = {
    getUserMedia: vi.fn(async () => stream),
  };
  const transactions = [];
  const adapter = {
    begin: vi.fn(() => {
      const transaction = makeTransaction();
      transactions.push(transaction);
      return transaction;
    }),
    isEligible: vi.fn(() => true),
    getActiveTarget: vi.fn(() => null),
    setShortcut: vi.fn(),
  };
  const fetchImpl = fetchOverride || vi.fn(async (url) => {
    if (String(url).endsWith('/status')) return response(status);
    if (String(url).endsWith('/service/start')) {
      return response({ok: true, service: {process_state: 'running', model_state: 'loaded'}});
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  const coordinator = new window.HstarVoiceAssistantCoordinator.VoiceCoordinator({
    adapter,
    fetch: fetchImpl,
    mediaDevices,
    createAudioContext: () => context,
    createAudioWorkletNode: () => worklet,
    createWebSocket: () => {
      queueMicrotask(() => socket.open());
      return socket;
    },
    createSessionId: () => 'session-test',
    renderUi,
  });
  return {
    adapter,
    context,
    coordinator,
    fetchImpl,
    mediaDevices,
    socket,
    source,
    status,
    stream,
    track,
    transactions,
    worklet,
  };
}

describe('Hstar global voice coordinator', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    delete window.HstarVoiceAssistantCoordinator;
    expect(existsSync(coordinatorPath), `${coordinatorPath} should exist`).toBe(true);
    window.eval(`${readFileSync(coordinatorPath, 'utf8')}\n//# sourceURL=voice-assistant-coordinator.js`);
  });

  it('replaces partial text in one transaction and commits final text', async () => {
    const harness = makeHarness();
    const target = document.createElement('textarea');
    harness.coordinator.activateTarget(target);

    await harness.coordinator.start();
    harness.socket.emit({type: 'partial', text: '测', sequence: 1});
    harness.socket.emit({type: 'partial', text: '测试', sequence: 2});
    harness.socket.emit({type: 'final', text: '测试完成。', sequence: 3});

    expect(harness.transactions).toHaveLength(1);
    expect(harness.transactions[0].update).toHaveBeenNthCalledWith(1, '测');
    expect(harness.transactions[0].update).toHaveBeenNthCalledWith(2, '测试');
    expect(harness.transactions[0].commit).toHaveBeenCalledWith('测试完成。');
  });

  it('ignores stale recognition sequence events', async () => {
    const harness = makeHarness();
    harness.coordinator.activateTarget(document.createElement('textarea'));
    await harness.coordinator.start();

    harness.socket.emit({type: 'partial', text: '新', sequence: 5});
    harness.socket.emit({type: 'partial', text: '旧', sequence: 4});

    expect(harness.transactions[0].update).toHaveBeenCalledTimes(1);
    expect(harness.transactions[0].update).toHaveBeenCalledWith('新');
  });

  it('releases every media resource after the service silence timeout', async () => {
    const harness = makeHarness();
    harness.coordinator.activateTarget(document.createElement('textarea'));
    await harness.coordinator.start();

    expect(harness.coordinator.debugState()).toMatchObject({
      state: 'listening',
      trackCount: 1,
      hasAudioContext: true,
      hasSocket: true,
    });

    harness.socket.emit({type: 'stopped', reason: 'silence-timeout', sequence: 6});
    await harness.coordinator.whenIdle();

    expect(harness.track.stop).toHaveBeenCalledOnce();
    expect(harness.source.disconnect).toHaveBeenCalledOnce();
    expect(harness.worklet.disconnect).toHaveBeenCalledOnce();
    expect(harness.context.close).toHaveBeenCalledOnce();
    expect(harness.coordinator.state).toBe('ready');
    expect(harness.coordinator.debugState()).toMatchObject({
      state: 'ready',
      trackCount: 0,
      hasAudioContext: false,
      hasSocket: false,
    });
  });

  it('never requests microphone permission while the model is missing', async () => {
    const status = readyStatus();
    status.status.model = {ready: false, missing: ['model.pt']};
    const harness = makeHarness({status});
    harness.coordinator.activateTarget(document.createElement('textarea'));

    await expect(harness.coordinator.start()).resolves.toBe(false);

    expect(harness.coordinator.state).toBe('missing');
    expect(harness.mediaDevices.getUserMedia).not.toHaveBeenCalled();
    expect(harness.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('never requests microphone permission while the runtime is missing', async () => {
    const status = readyStatus();
    status.status.runtime = {ready: false, profile: ''};
    const fetchOverride = vi.fn(async (url) => {
      if (String(url).endsWith('/status')) return response(status);
      throw new Error(`Unexpected request: ${url}`);
    });
    const harness = makeHarness({status, fetchOverride});
    harness.coordinator.activateTarget(document.createElement('textarea'));

    await expect(harness.coordinator.start()).resolves.toBe(false);

    expect(harness.coordinator.state).toBe('missing');
    expect(harness.mediaDevices.getUserMedia).not.toHaveBeenCalled();
    expect(fetchOverride).toHaveBeenCalledTimes(1);
  });

  it('makes stop idempotent and cancels uncommitted partial text', async () => {
    const harness = makeHarness();
    harness.coordinator.activateTarget(document.createElement('textarea'));
    await harness.coordinator.start();
    harness.socket.emit({type: 'partial', text: '未完成', sequence: 1});

    const first = harness.coordinator.stop('user');
    const second = harness.coordinator.stop('user');
    await Promise.all([first, second]);

    expect(harness.transactions[0].cancel).toHaveBeenCalledOnce();
    expect(harness.track.stop).toHaveBeenCalledOnce();
    expect(harness.context.close).toHaveBeenCalledOnce();
    expect(harness.socket.close).toHaveBeenCalledOnce();
    expect(harness.coordinator.state).toBe('ready');
  });

  it('requests microphone permission while the model service is cold-starting', async () => {
    const status = readyStatus();
    const service = deferred();
    const fetchOverride = vi.fn(async (url) => {
      if (String(url).endsWith('/status')) return response(status);
      if (String(url).endsWith('/service/start')) return service.promise;
      throw new Error(`Unexpected request: ${url}`);
    });
    const harness = makeHarness({status, fetchOverride});
    harness.coordinator.activateTarget(document.createElement('textarea'));

    const start = harness.coordinator.start();
    await vi.waitFor(() => expect(fetchOverride).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(harness.mediaDevices.getUserMedia).toHaveBeenCalledOnce());
    expect(harness.coordinator.state).toBe('loading');
    service.resolve(response({ok: true, service: {process_state: 'running'}}));
    await expect(start).resolves.toBe(true);

    expect(harness.coordinator.state).toBe('listening');
  });

  it('captures and flushes microphone audio while the model service is cold-starting', async () => {
    const status = readyStatus();
    const service = deferred();
    const fetchOverride = vi.fn(async (url) => {
      if (String(url).endsWith('/status')) return response(status);
      if (String(url).endsWith('/service/start')) return service.promise;
      throw new Error(`Unexpected request: ${url}`);
    });
    const harness = makeHarness({status, fetchOverride});
    harness.coordinator.activateTarget(document.createElement('textarea'));

    const start = harness.coordinator.start();
    await vi.waitFor(() => expect(harness.source.connect).toHaveBeenCalledOnce());
    const earlyAudio = new ArrayBuffer(640);
    harness.worklet.port.onmessage({data: earlyAudio});
    expect(harness.socket.sent).toEqual([]);

    service.resolve(response({ok: true, service: {process_state: 'running'}}));
    await expect(start).resolves.toBe(true);

    expect(harness.socket.sent[0]).toBe(JSON.stringify({
      type: 'start',
      session_id: 'session-test',
      language: 'auto',
      sample_rate: 16000,
    }));
    expect(harness.socket.sent[1]).toBe(earlyAudio);
  });

  it('releases an acquired microphone when stopped during model loading', async () => {
    const status = readyStatus();
    const service = deferred();
    const fetchOverride = vi.fn(async (url) => {
      if (String(url).endsWith('/status')) return response(status);
      if (String(url).endsWith('/service/start')) return service.promise;
      throw new Error(`Unexpected request: ${url}`);
    });
    const harness = makeHarness({status, fetchOverride});
    harness.coordinator.activateTarget(document.createElement('textarea'));

    const start = harness.coordinator.start();
    await vi.waitFor(() => expect(harness.mediaDevices.getUserMedia).toHaveBeenCalledOnce());
    await harness.coordinator.stop('user');
    expect(harness.track.stop).toHaveBeenCalledOnce();
    service.resolve(response({ok: true, service: {process_state: 'running'}}));
    await expect(start).resolves.toBe(false);

    expect(harness.track.stop).toHaveBeenCalledOnce();
    expect(harness.coordinator.state).toBe('ready');
  });

  it('cancels a cold start so the next click creates a fresh session', async () => {
    const status = readyStatus();
    const firstService = deferred();
    let firstServiceSignal = null;
    let serviceStarts = 0;
    const fetchOverride = vi.fn(async (url, options = {}) => {
      if (String(url).endsWith('/status')) return response(status);
      if (String(url).endsWith('/service/start')) {
        serviceStarts += 1;
        if (serviceStarts === 1) {
          firstServiceSignal = options.signal || null;
          return firstService.promise;
        }
        return response({ok: true, service: {process_state: 'running'}});
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const harness = makeHarness({status, fetchOverride});
    harness.coordinator.activateTarget(document.createElement('textarea'));

    const firstStart = harness.coordinator.start();
    await vi.waitFor(() => expect(serviceStarts).toBe(1));
    await harness.coordinator.stop('user');
    const secondStart = harness.coordinator.start();

    try {
      await vi.waitFor(() => expect(serviceStarts).toBe(2));
      expect(firstServiceSignal?.aborted).toBe(true);
    } finally {
      firstService.resolve(response({ok: true, service: {process_state: 'running'}}));
    }
    await expect(firstStart).resolves.toBe(false);
    await expect(secondStart).resolves.toBe(true);
    expect(harness.coordinator.state).toBe('listening');
  });

  it('keeps the original target locked until the listening session ends', async () => {
    const harness = makeHarness();
    const firstTarget = document.createElement('textarea');
    const secondTarget = document.createElement('textarea');
    harness.coordinator.activateTarget(firstTarget);
    await harness.coordinator.start();

    harness.coordinator.activateTarget(secondTarget);
    harness.socket.emit({type: 'partial', text: '仍写入原目标', sequence: 1});

    expect(harness.adapter.begin).toHaveBeenCalledOnce();
    expect(harness.adapter.begin).toHaveBeenCalledWith(firstTarget);
    expect(harness.coordinator.lockedTarget).toBe(firstTarget);
  });

  it('stops and releases resources when audio arrives after the target is removed', async () => {
    const harness = makeHarness();
    const target = document.createElement('textarea');
    document.body.append(target);
    harness.adapter.isEligible.mockImplementation(value => value?.isConnected === true);
    harness.coordinator.activateTarget(target);
    await harness.coordinator.start();

    target.remove();
    harness.worklet.port.onmessage({data: new ArrayBuffer(640)});
    await harness.coordinator.whenIdle();

    expect(harness.socket.sent.some(value => String(value).includes('target-removed'))).toBe(true);
    expect(harness.track.stop).toHaveBeenCalledOnce();
    expect(harness.context.close).toHaveBeenCalledOnce();
    expect(harness.coordinator.state).toBe('ready');
  });

  it('routes an attached iframe target through the child adapter', async () => {
    const harness = makeHarness();
    const frame = document.createElement('iframe');
    document.body.append(frame);
    const childTarget = frame.contentDocument.createElement('textarea');
    frame.contentDocument.body.append(childTarget);
    const childTransaction = makeTransaction();
    const childAdapter = {
      getTargetById: vi.fn(id => id === 'child-prompt' ? childTarget : null),
      isEligible: vi.fn(target => target === childTarget),
      begin: vi.fn(() => childTransaction),
    };
    frame.contentWindow.HstarVoiceInputAdapter = childAdapter;

    harness.coordinator.attachFrame(frame);
    window.dispatchEvent(new MessageEvent('message', {
      origin: window.location.origin,
      source: frame.contentWindow,
      data: {
        type: 'hstar-voice-target-active',
        targetId: 'child-prompt',
        label: '子页面提示词',
        framePath: [],
      },
    }));
    await harness.coordinator.start();
    harness.socket.emit({type: 'partial', text: '子页面听写', sequence: 1});

    expect(childAdapter.getTargetById).toHaveBeenCalledWith('child-prompt');
    expect(childAdapter.begin).toHaveBeenCalledWith(childTarget);
    expect(childTransaction.update).toHaveBeenCalledWith('子页面听写');
  });

  it('clears a matching iframe target when it reports focus lost', async () => {
    const harness = makeHarness();
    const frame = document.createElement('iframe');
    document.body.append(frame);
    const childTarget = frame.contentDocument.createElement('textarea');
    frame.contentDocument.body.append(childTarget);
    frame.contentWindow.HstarVoiceInputAdapter = {
      getTargetById: vi.fn(id => id === 'child-prompt' ? childTarget : null),
      isEligible: vi.fn(target => target === childTarget),
      begin: vi.fn(() => makeTransaction()),
    };
    harness.coordinator.attachFrame(frame);

    for (const type of ['hstar-voice-target-active', 'hstar-voice-target-lost']) {
      window.dispatchEvent(new MessageEvent('message', {
        origin: window.location.origin,
        source: frame.contentWindow,
        data: {type, targetId: 'child-prompt', label: '子页面提示词', framePath: []},
      }));
    }

    await expect(harness.coordinator.start()).resolves.toBe(false);
    expect(harness.mediaDevices.getUserMedia).not.toHaveBeenCalled();
    expect(harness.coordinator.state).toBe('error');
  });

  it('clears an iframe target when the application switches to another page frame', async () => {
    const harness = makeHarness({renderUi: true});
    const activeFrame = document.createElement('iframe');
    const nextFrame = document.createElement('iframe');
    document.body.append(activeFrame, nextFrame);
    const childTarget = activeFrame.contentDocument.createElement('textarea');
    activeFrame.contentDocument.body.append(childTarget);
    activeFrame.contentWindow.HstarVoiceInputAdapter = {
      getTargetById: vi.fn(id => id === 'child-prompt' ? childTarget : null),
      isEligible: vi.fn(target => target === childTarget),
      begin: vi.fn(() => makeTransaction()),
    };
    harness.coordinator.attachFrame(activeFrame);
    harness.coordinator.attachFrame(nextFrame);
    window.dispatchEvent(new MessageEvent('message', {
      origin: window.location.origin,
      source: activeFrame.contentWindow,
      data: {
        type: 'hstar-voice-target-active',
        targetId: 'child-prompt',
        label: '子页面提示词',
        framePath: [],
      },
    }));

    harness.coordinator.onPageSwitch(nextFrame);

    await expect(harness.coordinator.start()).resolves.toBe(false);
    expect(document.querySelector('.hstar-voice-entry').hidden).toBe(true);
    expect(harness.mediaDevices.getUserMedia).not.toHaveBeenCalled();
  });

  it('repositions an iframe target after a child geometry signal', async () => {
    const harness = makeHarness({renderUi: true});
    const frame = document.createElement('iframe');
    document.body.append(frame);
    Object.defineProperties(frame, {
      clientWidth: {value: 500, configurable: true},
      clientHeight: {value: 400, configurable: true},
    });
    frame.getBoundingClientRect = () => ({
      left: 100, top: 50, right: 600, bottom: 450, width: 500, height: 400,
    });
    const childTarget = frame.contentDocument.createElement('textarea');
    frame.contentDocument.body.append(childTarget);
    let targetRight = 220;
    childTarget.getBoundingClientRect = () => ({
      left: 20, top: 30, right: targetRight, bottom: 90,
      width: targetRight - 20, height: 60,
    });
    frame.contentWindow.HstarVoiceInputAdapter = {
      getTargetById: vi.fn(id => id === 'child-prompt' ? childTarget : null),
      isEligible: vi.fn(target => target === childTarget),
      begin: vi.fn(() => makeTransaction()),
    };
    harness.coordinator.attachFrame(frame);
    const dispatch = type => window.dispatchEvent(new MessageEvent('message', {
      origin: window.location.origin,
      source: frame.contentWindow,
      data: {type, targetId: 'child-prompt', label: '子页面提示词', framePath: []},
    }));

    dispatch('hstar-voice-target-active');
    await vi.waitFor(() => {
      expect(document.querySelector('.hstar-voice-entry').style.left).toBe('286px');
    });
    targetRight = 300;
    dispatch('hstar-voice-target-geometry');

    await vi.waitFor(() => {
      expect(document.querySelector('.hstar-voice-entry').style.left).toBe('366px');
    });
  });

  it('tracks transform-driven target movement without geometry events', async () => {
    const harness = makeHarness({renderUi: true});
    const target = document.createElement('textarea');
    document.body.append(target);
    let right = 340;
    target.getBoundingClientRect = () => ({
      left: 100, top: 100, right, bottom: 180, width: right - 100, height: 80,
    });
    harness.adapter.isEligible.mockImplementation(value => value === target);

    harness.coordinator.activateTarget(target);
    await vi.waitFor(() => {
      expect(document.querySelector('.hstar-voice-entry').style.left).toBe('306px');
    });
    right = 520;

    await vi.waitFor(() => {
      expect(document.querySelector('.hstar-voice-entry').style.left).toBe('486px');
    });
  });

  it('restores the target focus and selection when the microphone is pressed', async () => {
    const harness = makeHarness({renderUi: true});
    const target = document.createElement('textarea');
    target.value = '前后';
    target.getBoundingClientRect = () => ({
      left: 100, top: 100, right: 340, bottom: 180, width: 240, height: 80,
    });
    document.body.append(target);
    harness.adapter.isEligible.mockImplementation(value => value === target);
    target.focus();
    target.setSelectionRange(1, 1);
    harness.coordinator.activateTarget(target);
    const button = document.querySelector('.hstar-voice-button');
    button.focus();

    button.dispatchEvent(new MouseEvent('pointerdown', {bubbles: true, cancelable: true}));

    expect(document.activeElement).toBe(target);
    expect([target.selectionStart, target.selectionEnd]).toEqual([1, 1]);
  });

  it('lets first use choose a folder and activate an existing model', async () => {
    const status = readyStatus();
    status.status.model = {ready: false, missing: ['model.pt']};
    const fetchOverride = vi.fn(async (url) => {
      if (String(url).endsWith('/status')) return response(status);
      if (String(url).endsWith('/choose-folder')) return response({ok: true, path: 'D:/Voice'});
      if (String(url).endsWith('/detect-model')) {
        return response({ok: true, model: {ready: true, model_path: 'D:/Voice/model'}});
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const harness = makeHarness({status, fetchOverride, renderUi: true});
    const target = document.createElement('textarea');
    document.body.append(target);
    harness.coordinator.activateTarget(target);
    await harness.coordinator.start();
    const dialog = document.querySelector('.hstar-voice-first-use');
    const path = dialog.querySelector('[data-role="voice-path"]');

    dialog.querySelector('[data-action="choose-folder"]').click();
    await vi.waitFor(() => expect(path.value).toBe('D:/Voice'));
    dialog.querySelector('[data-action="detect-model"]').click();
    await vi.waitFor(() => expect(harness.coordinator.state).toBe('ready'));

    expect(dialog.hasAttribute('open')).toBe(false);
    expect(harness.mediaDevices.getUserMedia).not.toHaveBeenCalled();
  });

  it('ships styles for every coordinator state', () => {
    expect(existsSync(stylesheetPath), `${stylesheetPath} should exist`).toBe(true);
    const stylesheet = readFileSync(stylesheetPath, 'utf8');
    for (const state of Object.values(window.HstarVoiceAssistantCoordinator.STATES)) {
      expect(stylesheet).toContain(`[data-state="${state}"]`);
    }
  });

  it('uses app themes for a contrasting microphone and rainbow recognition ring', () => {
    const stylesheet = readFileSync(stylesheetPath, 'utf8');

    expect(stylesheet).toMatch(/--hstar-voice-button-bg:\s*#111111/i);
    expect(stylesheet).toMatch(/(?:html|body)\.theme-dark[^{]*\{/i);
    expect(stylesheet).toContain('conic-gradient');
    expect(stylesheet).toContain('[data-state="recognizing"] .hstar-voice-level');
    expect(stylesheet).toMatch(/\.hstar-voice-status\s*\{[^}]*background:/si);
    expect(stylesheet).toMatch(/^\.hstar-voice-status\s*\{[^}]*opacity:\s*1\s*;/sim);
  });
});

describe('Hstar voice audio worklet', () => {
  let Processor;

  beforeEach(() => {
    Processor = null;
    class FakeAudioWorkletProcessor {
      constructor() {
        this.port = {postMessage: vi.fn()};
      }
    }
    vi.stubGlobal('AudioWorkletProcessor', FakeAudioWorkletProcessor);
    vi.stubGlobal('registerProcessor', vi.fn((name, value) => {
      expect(name).toBe('hstar-voice-processor');
      Processor = value;
    }));
    expect(existsSync(workletPath), `${workletPath} should exist`).toBe(true);
    window.eval(`${readFileSync(workletPath, 'utf8')}\n//# sourceURL=voice-audio-worklet.js`);
  });

  it('averages channels, clamps PCM16, and transfers one exact 20ms frame', () => {
    const processor = new Processor({processorOptions: {sourceRate: 16000}});
    const left = new Float32Array(320).fill(2);
    const right = new Float32Array(320).fill(0.5);

    expect(processor.process([[left, right]])).toBe(true);

    expect(processor.port.postMessage).toHaveBeenCalledOnce();
    const [frame, transfer] = processor.port.postMessage.mock.calls[0];
    expect(frame).toBeInstanceOf(Int16Array);
    expect(frame).toHaveLength(320);
    expect(frame.byteLength).toBe(640);
    expect(frame[0]).toBe(32767);
    expect(transfer).toEqual([frame.buffer]);
  });

  it('keeps fractional 44.1kHz resampling position across uneven callbacks', () => {
    const processor = new Processor({processorOptions: {sourceRate: 44100}});
    const input = new Float32Array(882).fill(-0.25);
    let offset = 0;
    for (const size of [113, 17, 259, 493]) {
      processor.process([[input.subarray(offset, offset + size)]]);
      offset += size;
    }

    expect(processor.port.postMessage).toHaveBeenCalledOnce();
    const [frame] = processor.port.postMessage.mock.calls[0];
    expect(frame).toHaveLength(320);
    expect(frame.byteLength).toBe(640);
    expect(frame[0]).toBe(-8192);
    expect(frame[319]).toBe(-8192);
  });
});
