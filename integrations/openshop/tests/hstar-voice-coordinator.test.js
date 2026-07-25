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

    harness.socket.emit({type: 'stopped', reason: 'silence-timeout', sequence: 6});
    await harness.coordinator.whenIdle();

    expect(harness.track.stop).toHaveBeenCalledOnce();
    expect(harness.source.disconnect).toHaveBeenCalledOnce();
    expect(harness.worklet.disconnect).toHaveBeenCalledOnce();
    expect(harness.context.close).toHaveBeenCalledOnce();
    expect(harness.coordinator.state).toBe('ready');
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
    const fetchOverride = vi.fn(async (url) => {
      if (String(url).endsWith('/status')) return response(status);
      if (String(url).endsWith('/service/start')) {
        return response({
          detail: {code: 'VOICE_RUNTIME_MISSING', message: 'Runtime is not installed'},
        }, false);
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const harness = makeHarness({status, fetchOverride});
    harness.coordinator.activateTarget(document.createElement('textarea'));

    await expect(harness.coordinator.start()).resolves.toBe(false);

    expect(harness.coordinator.state).toBe('missing');
    expect(harness.mediaDevices.getUserMedia).not.toHaveBeenCalled();
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

  it('does not request the microphone when stopped during model loading', async () => {
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
    await harness.coordinator.stop('user');
    service.resolve(response({ok: true, service: {process_state: 'running'}}));
    await start;

    expect(harness.mediaDevices.getUserMedia).not.toHaveBeenCalled();
    expect(harness.coordinator.state).toBe('ready');
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
