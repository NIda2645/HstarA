(function installHstarVoiceAssistantCoordinator(global) {
  'use strict';

  if (!global || global.HstarVoiceAssistantCoordinator) return;

  const STATES = Object.freeze({
    DISABLED: 'disabled',
    MISSING: 'missing',
    READY: 'ready',
    LOADING: 'loading',
    LISTENING: 'listening',
    RECOGNIZING: 'recognizing',
    STOPPING: 'stopping',
    ERROR: 'error',
  });

  const ACTIVE_STATES = new Set([
    STATES.LOADING,
    STATES.LISTENING,
    STATES.RECOGNIZING,
    STATES.STOPPING,
  ]);
  const SEQUENCED_EVENTS = new Set(['partial', 'final', 'stopped', 'error']);

  class VoiceCoordinatorError extends Error {
    constructor(code, message) {
      super(message || code);
      this.name = 'VoiceCoordinatorError';
      this.code = code || 'VOICE_UNKNOWN_ERROR';
    }
  }

  function defaultSessionId() {
    if (global.crypto?.randomUUID) return global.crypto.randomUUID();
    return `voice-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  function websocketUrl() {
    const protocol = global.location?.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${global.location?.host || '127.0.0.1'}/ws/voice-assistant/transcribe`;
  }

  function errorPayload(payload, fallbackCode) {
    const detail = payload?.detail && typeof payload.detail === 'object'
      ? payload.detail
      : payload;
    return {
      code: String(detail?.code || fallbackCode || 'VOICE_REQUEST_FAILED'),
      message: String(detail?.message || detail?.detail || ''),
    };
  }

  class VoiceCoordinator {
    constructor(options = {}) {
      this.adapter = options.adapter || global.HstarVoiceInputAdapter;
      this.fetch = options.fetch || global.fetch?.bind(global);
      this.mediaDevices = options.mediaDevices || global.navigator?.mediaDevices;
      this.createAudioContext = options.createAudioContext || (() => {
        const AudioContextClass = global.AudioContext || global.webkitAudioContext;
        if (!AudioContextClass) throw new VoiceCoordinatorError('VOICE_AUDIO_UNAVAILABLE');
        return new AudioContextClass({latencyHint: 'interactive'});
      });
      this.createAudioWorkletNode = options.createAudioWorkletNode || ((context, settings) => (
        new global.AudioWorkletNode(context, 'hstar-voice-processor', settings)
      ));
      this.createWebSocket = options.createWebSocket || (url => new global.WebSocket(url));
      this.createSessionId = options.createSessionId || defaultSessionId;
      this.workletUrl = options.workletUrl || '/static/js/voice-audio-worklet.js';
      this.renderUi = options.renderUi !== false;

      this._state = STATES.READY;
      this._activeTarget = null;
      this._lockedTarget = null;
      this._transaction = null;
      this._hasPendingPartial = false;
      this._lastSequence = -1;
      this._settings = {};
      this._status = null;
      this._startPromise = null;
      this._startGeneration = 0;
      this._stopPromise = null;
      this._closing = false;
      this._stream = null;
      this._audioContext = null;
      this._sourceNode = null;
      this._workletNode = null;
      this._muteNode = null;
      this._socket = null;
      this._sessionId = '';
      this._positionFrame = 0;
      this._ui = null;
      this._attachedFrames = new Set();
      this._frameLoadHandlers = new WeakMap();

      this._onFocusIn = event => {
        if (this.adapter?.isEligible?.(event.target)) this.activateTarget(event.target);
      };
      this._onTargetCommand = event => {
        const target = event.detail?.target || this.adapter?.getActiveTarget?.();
        if (target) this.activateTarget(target);
        if (ACTIVE_STATES.has(this.state)) void this.stop('user');
        else void this.start();
      };
      this._onViewportChange = () => this._schedulePosition();
      this._onFrameMessage = event => this._handleFrameMessage(event);

      global.document?.addEventListener('focusin', this._onFocusIn, true);
      global.addEventListener?.('hstar-voice-target-command', this._onTargetCommand);
      global.addEventListener?.('resize', this._onViewportChange);
      global.addEventListener?.('scroll', this._onViewportChange, true);
      global.addEventListener?.('message', this._onFrameMessage);

      if (this.renderUi) this._ensureUi();
    }

    get state() {
      return this._state;
    }

    get lockedTarget() {
      return this._lockedTarget;
    }

    debugState() {
      return Object.freeze({
        state: this.state,
        trackCount: this._stream?.getTracks?.().length || 0,
        hasAudioContext: Boolean(this._audioContext),
        hasSocket: Boolean(this._socket),
      });
    }

    activateTarget(target) {
      if (!target || !this._targetEligible(target)) return false;
      this._activeTarget = target;
      this._schedulePosition();
      return true;
    }

    attachFrame(frame) {
      if (!frame?.contentWindow || this._attachedFrames.has(frame)) return false;
      this._attachedFrames.add(frame);
      const onLoad = () => {
        if (this._isFrameHandle(this._lockedTarget) && this._lockedTarget.frame === frame) {
          void this.stop('target-removed');
        }
        this._schedulePosition();
      };
      this._frameLoadHandlers.set(frame, onLoad);
      frame.addEventListener?.('load', onLoad);
      return true;
    }

    async start() {
      if (this._startPromise) return this._startPromise;
      if (this.state === STATES.LISTENING || this.state === STATES.RECOGNIZING) return true;
      if (this.state === STATES.STOPPING && this._stopPromise) await this._stopPromise;

      const target = this._activeTarget || this.adapter?.getActiveTarget?.();
      if (!target || !this._targetEligible(target)) {
        this._setState(STATES.ERROR, {code: 'VOICE_TARGET_LOST'});
        return false;
      }

      this._lockedTarget = target;
      const generation = ++this._startGeneration;
      const operation = this._startSession(generation);
      this._startPromise = operation.finally(() => {
        this._startPromise = null;
      });
      return this._startPromise;
    }

    stop(reason = 'user') {
      if (this._stopPromise) return this._stopPromise;
      this._startGeneration += 1;
      const operation = this._stopSession(reason, STATES.READY, true);
      this._stopPromise = operation.finally(() => {
        this._stopPromise = null;
      });
      return this._stopPromise;
    }

    whenIdle() {
      return this._stopPromise || Promise.resolve();
    }

    async destroy() {
      await this.stop('page-unload');
      global.document?.removeEventListener('focusin', this._onFocusIn, true);
      global.removeEventListener?.('hstar-voice-target-command', this._onTargetCommand);
      global.removeEventListener?.('resize', this._onViewportChange);
      global.removeEventListener?.('scroll', this._onViewportChange, true);
      global.removeEventListener?.('message', this._onFrameMessage);
      for (const frame of this._attachedFrames) {
        frame.removeEventListener?.('load', this._frameLoadHandlers.get(frame));
      }
      this._attachedFrames.clear();
      if (this._positionFrame) global.cancelAnimationFrame?.(this._positionFrame);
      this._ui?.root.remove();
      this._ui?.dialog.remove();
      this._ui = null;
    }

    async _startSession(generation) {
      this._lastSequence = -1;
      this._setState(STATES.LOADING);
      try {
        const payload = await this._requestJson('/api/voice-assistant/status');
        const status = payload?.status || {};
        if (generation !== this._startGeneration) return false;
        this._status = status;
        this._settings = status.settings || {};
        this.adapter?.setShortcut?.(this._settings.shortcut || 'Shift+Q');

        if (this._settings.enabled === false) {
          this._lockedTarget = null;
          this._setState(STATES.DISABLED);
          return false;
        }
        if (!status.model?.ready) {
          this._lockedTarget = null;
          this._setState(STATES.MISSING, {code: 'VOICE_MODEL_MISSING'});
          this._showFirstUse();
          return false;
        }

        await this._startService();
        if (generation !== this._startGeneration) return false;
        await this._openBrowserSession(generation);
        if (generation !== this._startGeneration) return false;
        this._setState(STATES.LISTENING);
        return true;
      } catch (error) {
        const code = String(error?.code || 'VOICE_START_FAILED');
        if (code === 'VOICE_START_CANCELLED') {
          await this._releaseResources();
          this._lockedTarget = null;
          return false;
        }
        const missing = code.includes('RUNTIME_MISSING') || code.includes('MODEL_MISSING');
        await this._releaseResources();
        this._lockedTarget = null;
        this._setState(missing ? STATES.MISSING : STATES.ERROR, {
          code,
          message: String(error?.message || ''),
        });
        if (missing) this._showFirstUse();
        return false;
      }
    }

    async _startService() {
      const response = await this.fetch('/api/voice-assistant/service/start', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({device: 'auto'}),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload?.ok === false) {
        const detail = errorPayload(payload, 'VOICE_SERVICE_START_FAILED');
        throw new VoiceCoordinatorError(detail.code, detail.message);
      }
    }

    async _openBrowserSession(generation) {
      if (!this.mediaDevices?.getUserMedia) {
        throw new VoiceCoordinatorError('VOICE_MIC_UNAVAILABLE');
      }
      const deviceId = String(this._settings.input_device_id || 'default');
      const audio = {
        channelCount: {ideal: 1},
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      };
      if (deviceId && deviceId !== 'default') audio.deviceId = {exact: deviceId};

      try {
        const stream = await this.mediaDevices.getUserMedia({audio, video: false});
        if (generation !== this._startGeneration) {
          for (const track of stream.getTracks?.() || []) track.stop();
          throw new VoiceCoordinatorError('VOICE_START_CANCELLED');
        }
        this._stream = stream;
      } catch (error) {
        const code = error?.name === 'NotAllowedError'
          ? 'VOICE_MIC_PERMISSION_DENIED'
          : error?.name === 'NotReadableError'
            ? 'VOICE_MIC_BUSY'
            : 'VOICE_MIC_UNAVAILABLE';
        throw new VoiceCoordinatorError(code, error?.message);
      }

      this._audioContext = this.createAudioContext();
      await this._audioContext.audioWorklet.addModule(this.workletUrl);
      if (generation !== this._startGeneration) {
        throw new VoiceCoordinatorError('VOICE_START_CANCELLED');
      }
      this._workletNode = this.createAudioWorkletNode(this._audioContext, {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        processorOptions: {sourceRate: this._audioContext.sampleRate},
      });
      this._sourceNode = this._audioContext.createMediaStreamSource(this._stream);
      this._muteNode = this._audioContext.createGain();
      this._muteNode.gain.value = 0;
      this._workletNode.port.onmessage = event => this._sendAudio(event.data);

      await this._openSocket();
      if (generation !== this._startGeneration) {
        throw new VoiceCoordinatorError('VOICE_START_CANCELLED');
      }
      this._sourceNode.connect(this._workletNode);
      this._workletNode.connect(this._muteNode);
      this._muteNode.connect(this._audioContext.destination);
    }

    _openSocket() {
      this._sessionId = this.createSessionId();
      const socket = this.createWebSocket(websocketUrl());
      this._socket = socket;
      socket.binaryType = 'arraybuffer';
      socket.onmessage = event => this._handleSocketMessage(event);
      socket.onclose = event => {
        if (!this._closing && ACTIVE_STATES.has(this.state)) {
          this._beginServerStop('service-disconnected', STATES.ERROR, {
            code: 'VOICE_SERVICE_DISCONNECTED',
            closeCode: event?.code,
          });
        }
      };
      socket.onerror = () => {
        if (!this._closing && ACTIVE_STATES.has(this.state)) {
          this._setState(STATES.ERROR, {code: 'VOICE_SERVICE_DISCONNECTED'});
        }
      };

      return new Promise((resolve, reject) => {
        const open = () => {
          try {
            socket.send(JSON.stringify({
              type: 'start',
              session_id: this._sessionId,
              language: this._settings.language || 'auto',
              sample_rate: 16000,
            }));
            resolve();
          } catch (error) {
            reject(error);
          }
        };
        socket.onopen = open;
        if (socket.readyState === 1) open();
        const previousClose = socket.onclose;
        socket.onclose = event => {
          previousClose?.(event);
          if (!this._closing && socket.readyState !== 1) {
            reject(new VoiceCoordinatorError('VOICE_SERVICE_DISCONNECTED'));
          }
        };
      });
    }

    _sendAudio(value) {
      if (this._lockedTarget && !this._targetEligible(this._lockedTarget)) {
        void this.stop('target-removed');
        return;
      }
      if (!this._socket || this._socket.readyState !== 1) return;
      let buffer = value;
      if (ArrayBuffer.isView(buffer)) {
        buffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
      }
      if (buffer instanceof ArrayBuffer) this._socket.send(buffer);
    }

    _handleSocketMessage(event) {
      let message;
      try {
        message = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
      } catch {
        this._beginServerStop('invalid-message', STATES.ERROR, {
          code: 'VOICE_SERVICE_DISCONNECTED',
        });
        return;
      }
      if (!message || typeof message !== 'object') return;
      if (SEQUENCED_EVENTS.has(message.type) && Number.isFinite(Number(message.sequence))) {
        const sequence = Number(message.sequence);
        if (sequence <= this._lastSequence) return;
        this._lastSequence = sequence;
      }

      if (message.type === 'partial') {
        this._ensureTransaction().update(String(message.text || ''));
        this._hasPendingPartial = true;
        this._setState(STATES.RECOGNIZING, message);
      } else if (message.type === 'final') {
        this._ensureTransaction().commit(String(message.text || ''));
        this._transaction = null;
        this._hasPendingPartial = false;
        this._setState(STATES.LISTENING, message);
      } else if (message.type === 'speech-state') {
        this._setState(message.active ? STATES.RECOGNIZING : STATES.LISTENING, message);
      } else if (message.type === 'ready') {
        this._setState(STATES.LISTENING, message);
      } else if (message.type === 'stopped') {
        this._beginServerStop(String(message.reason || 'service'), STATES.READY, message);
      } else if (message.type === 'error') {
        this._beginServerStop('service-error', STATES.ERROR, message);
      }
    }

    _ensureTransaction() {
      if (!this._lockedTarget) throw new VoiceCoordinatorError('VOICE_TARGET_LOST');
      if (!this._transaction) {
        if (this._isFrameHandle(this._lockedTarget)) {
          const resolved = this._resolveFrameTarget(this._lockedTarget);
          if (!resolved || resolved.adapter.isEligible?.(resolved.target) === false) {
            throw new VoiceCoordinatorError('VOICE_TARGET_LOST');
          }
          this._transaction = resolved.adapter.begin(resolved.target);
        } else {
          this._transaction = this.adapter.begin(this._lockedTarget);
        }
      }
      return this._transaction;
    }

    _isFrameHandle(target) {
      return Boolean(target?.hstarVoiceFrameTarget === true);
    }

    _targetEligible(target) {
      if (this._isFrameHandle(target)) {
        const resolved = this._resolveFrameTarget(target);
        return Boolean(resolved && resolved.adapter.isEligible?.(resolved.target) !== false);
      }
      return this.adapter?.isEligible?.(target) !== false;
    }

    _resolveFrameTarget(handle) {
      try {
        let frameWindow = handle.frame.contentWindow;
        const traversedFrames = [handle.frame];
        for (const routeId of handle.framePath || []) {
          const nestedFrame = Array.from(frameWindow.document.querySelectorAll('iframe'))
            .find(frame => frame.dataset.hstarVoiceFrameId === routeId);
          if (!nestedFrame?.contentWindow) return null;
          traversedFrames.push(nestedFrame);
          frameWindow = nestedFrame.contentWindow;
        }
        const adapter = frameWindow.HstarVoiceInputAdapter;
        const target = adapter?.getTargetById?.(handle.targetId);
        if (!adapter || !target) return null;
        return {adapter, target, frames: traversedFrames};
      } catch {
        return null;
      }
    }

    _handleFrameMessage(event) {
      if (event.origin !== global.location.origin) return;
      const frame = Array.from(this._attachedFrames)
        .find(candidate => candidate.contentWindow === event.source);
      if (!frame) return;
      const data = event.data;
      if (!data || ![
        'hstar-voice-target-active',
        'hstar-voice-target-lost',
        'hstar-voice-target-command',
      ].includes(data.type)) return;
      const framePath = (Array.isArray(data.framePath) ? data.framePath : [])
        .map(value => String(value || ''))
        .filter(Boolean)
        .slice(0, 8);
      const handle = {
        hstarVoiceFrameTarget: true,
        frame,
        framePath,
        targetId: String(data.targetId || ''),
        label: String(data.label || ''),
      };
      if (!handle.targetId) return;
      if (data.type === 'hstar-voice-target-active') {
        this.activateTarget(handle);
      } else if (data.type === 'hstar-voice-target-command') {
        if (!this.activateTarget(handle)) return;
        if (ACTIVE_STATES.has(this.state)) void this.stop('user');
        else void this.start();
      } else if (!this._targetEligible(handle)) {
        if (this._activeTarget?.targetId === handle.targetId) this._activeTarget = null;
        if (this._lockedTarget?.targetId === handle.targetId) void this.stop('target-removed');
      }
    }

    _beginServerStop(reason, nextState, detail) {
      if (this._stopPromise) return;
      this._startGeneration += 1;
      const operation = this._stopSession(reason, nextState, false, detail);
      this._stopPromise = operation.finally(() => {
        this._stopPromise = null;
      });
    }

    async _stopSession(reason, nextState, notifyServer, detail = null) {
      const hasResources = this._stream || this._audioContext || this._socket || this._lockedTarget;
      if (!hasResources) {
        if (this.state !== STATES.DISABLED && this.state !== STATES.MISSING) {
          this._setState(nextState, detail);
        }
        return;
      }

      this._setState(STATES.STOPPING, {reason});
      if (notifyServer && this._socket?.readyState === 1) {
        try {
          this._socket.send(JSON.stringify({
            type: 'stop',
            session_id: this._sessionId,
            reason,
          }));
        } catch {
          // Resource cleanup below is authoritative.
        }
      }
      if (this._transaction && this._hasPendingPartial) {
        try {
          this._transaction.cancel();
        } catch {
          // A removed target must not block microphone cleanup.
        }
      }
      this._transaction = null;
      this._hasPendingPartial = false;
      await this._releaseResources();
      this._lockedTarget = null;
      this._sessionId = '';
      this._lastSequence = -1;
      this._setState(nextState, detail);
    }

    async _releaseResources() {
      this._closing = true;
      const socket = this._socket;
      this._socket = null;
      if (socket) {
        socket.onopen = null;
        socket.onmessage = null;
        socket.onerror = null;
        try {
          if (socket.readyState < 2) socket.close(1000, 'voice-session-ended');
        } catch {
          // Continue releasing local media resources.
        }
        socket.onclose = null;
      }

      const nodes = [this._sourceNode, this._workletNode, this._muteNode];
      this._sourceNode = null;
      this._workletNode = null;
      this._muteNode = null;
      for (const node of nodes) {
        try {
          node?.disconnect?.();
        } catch {
          // Already disconnected.
        }
      }
      try {
        nodes[1]?.port?.close?.();
      } catch {
        // The browser may already have closed the worklet port.
      }

      const stream = this._stream;
      this._stream = null;
      for (const track of stream?.getTracks?.() || []) {
        try {
          track.stop();
        } catch {
          // Continue stopping any remaining tracks.
        }
      }

      const context = this._audioContext;
      this._audioContext = null;
      if (context) {
        try {
          await context.close();
        } catch {
          // A closed context is already released.
        }
      }
      this._closing = false;
    }

    async _requestJson(url, options) {
      if (!this.fetch) throw new VoiceCoordinatorError('VOICE_SERVICE_DISCONNECTED');
      const response = await this.fetch(url, options);
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload?.ok === false) {
        const detail = errorPayload(payload, 'VOICE_REQUEST_FAILED');
        throw new VoiceCoordinatorError(detail.code, detail.message);
      }
      return payload;
    }

    _setState(state, detail = null) {
      this._state = state;
      if (this._ui) {
        this._ui.root.dataset.state = state;
        this._ui.button.setAttribute('aria-pressed', ACTIVE_STATES.has(state) ? 'true' : 'false');
        this._ui.button.setAttribute('aria-label', this._stateLabel(state));
        this._ui.status.textContent = this._stateLabel(state);
        const remaining = Math.max(0, Math.ceil(Number(detail?.silence_remaining_ms || 0) / 1000));
        this._ui.countdown.textContent = remaining ? String(remaining) : '';
      }
      global.dispatchEvent?.(new global.CustomEvent('hstar-voice-state-change', {
        detail: {state, ...detail},
      }));
    }

    _stateLabel(state) {
      return {
        [STATES.DISABLED]: '语音助手已关闭',
        [STATES.MISSING]: '下载语音模型',
        [STATES.READY]: '开始语音输入',
        [STATES.LOADING]: '正在加载语音模型',
        [STATES.LISTENING]: '正在聆听',
        [STATES.RECOGNIZING]: '正在识别',
        [STATES.STOPPING]: '正在停止',
        [STATES.ERROR]: '语音输入出错',
      }[state] || '语音输入';
    }

    _ensureUi() {
      if (this._ui || !global.document?.body) return;
      const root = global.document.createElement('div');
      root.className = 'hstar-voice-entry';
      root.dataset.state = this.state;
      root.hidden = true;
      root.innerHTML = `
        <button class="hstar-voice-button" type="button" aria-label="开始语音输入" aria-pressed="false">
          <i data-lucide="mic" aria-hidden="true"></i>
          <span class="hstar-voice-level" aria-hidden="true"></span>
          <span class="hstar-voice-countdown" aria-hidden="true"></span>
        </button>
        <span class="hstar-voice-status" role="status" aria-live="polite"></span>
      `;
      const dialog = global.document.createElement('dialog');
      dialog.className = 'hstar-voice-first-use';
      dialog.innerHTML = `
        <form method="dialog" class="hstar-voice-first-use__panel">
          <header>
            <h2>语音模型</h2>
            <button type="submit" value="cancel" class="hstar-voice-icon-button" aria-label="关闭">
              <i data-lucide="x" aria-hidden="true"></i>
            </button>
          </header>
          <div class="hstar-voice-storage-options">
            <label><input type="radio" name="voice-storage" value="inherit" checked> 默认位置</label>
            <label><input type="radio" name="voice-storage" value="custom"> 自定义位置</label>
          </div>
          <div class="hstar-voice-path-row">
            <input type="text" data-role="voice-path" data-voice-input="off" readonly aria-label="语音模型存储位置">
            <button type="button" data-action="choose-folder">选择文件夹</button>
          </div>
          <progress data-role="voice-progress" value="0" max="100"></progress>
          <p data-role="voice-install-status" aria-live="polite"></p>
          <footer>
            <button type="button" data-action="detect-model">检测已有模型</button>
            <button type="button" data-action="download-model" class="primary">下载</button>
          </footer>
        </form>
      `;
      global.document.body.append(root, dialog);
      const button = root.querySelector('.hstar-voice-button');
      button.addEventListener('click', () => {
        if (ACTIVE_STATES.has(this.state)) void this.stop('user');
        else void this.start();
      });
      this._ui = {
        root,
        button,
        status: root.querySelector('.hstar-voice-status'),
        countdown: root.querySelector('.hstar-voice-countdown'),
        dialog,
      };
      this._bindFirstUseActions();
      global.lucide?.createIcons?.({root});
      global.lucide?.createIcons?.({root: dialog});
      this._setState(this.state);
    }

    _showFirstUse() {
      if (!this._ui?.dialog) return;
      const path = this._ui.dialog.querySelector('[data-role="voice-path"]');
      if (path && !path.value) path.value = String(this._settings.effective_root || '');
      if (typeof this._ui.dialog.showModal === 'function' && !this._ui.dialog.open) {
        this._ui.dialog.showModal();
      } else {
        this._ui.dialog.setAttribute('open', '');
      }
    }

    _bindFirstUseActions() {
      const dialog = this._ui?.dialog;
      if (!dialog) return;
      const path = dialog.querySelector('[data-role="voice-path"]');
      const progress = dialog.querySelector('[data-role="voice-progress"]');
      const status = dialog.querySelector('[data-role="voice-install-status"]');
      const choose = dialog.querySelector('[data-action="choose-folder"]');
      const detect = dialog.querySelector('[data-action="detect-model"]');
      const download = dialog.querySelector('[data-action="download-model"]');

      choose.addEventListener('click', async () => {
        this._setInstallControlsDisabled(true);
        try {
          const payload = await this._requestJson('/api/voice-assistant/choose-folder', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({path: path.value || ''}),
          });
          if (payload.path) {
            path.value = String(payload.path);
            const custom = dialog.querySelector('input[name="voice-storage"][value="custom"]');
            if (custom) custom.checked = true;
          }
          status.textContent = '';
        } catch (error) {
          status.textContent = error.message || '无法选择文件夹';
        } finally {
          this._setInstallControlsDisabled(false);
        }
      });

      detect.addEventListener('click', async () => {
        this._setInstallControlsDisabled(true);
        try {
          const payload = await this._requestJson('/api/voice-assistant/detect-model', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({path: path.value || ''}),
          });
          if (!payload.model?.ready) {
            throw new VoiceCoordinatorError('VOICE_MODEL_INCOMPLETE', '未找到完整的语音模型');
          }
          this._status = {...(this._status || {}), model: payload.model};
          status.textContent = '模型已就绪';
          this._closeFirstUse();
          this._setState(STATES.READY);
        } catch (error) {
          status.textContent = error.message || '模型检测失败';
        } finally {
          this._setInstallControlsDisabled(false);
        }
      });

      download.addEventListener('click', async () => {
        this._setInstallControlsDisabled(true);
        progress.value = 0;
        status.textContent = '正在准备下载';
        try {
          const mode = dialog.querySelector('input[name="voice-storage"]:checked')?.value || 'inherit';
          if (mode === 'custom') {
            await this._requestJson('/api/voice-assistant/settings', {
              method: 'POST',
              headers: {'Content-Type': 'application/json'},
              body: JSON.stringify({storage_mode: 'custom', storage_root: path.value || ''}),
            });
          }
          const started = await this._requestJson('/api/voice-assistant/install', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({profile: 'auto'}),
          });
          const completed = await this._pollInstallTask(started.task, progress, status);
          if (completed.status !== 'completed') {
            throw new VoiceCoordinatorError(
              completed.error_code || 'VOICE_RUNTIME_INSTALL_FAILED',
              completed.error_message || '语音模型安装失败',
            );
          }
          progress.value = 100;
          status.textContent = '安装完成';
          this._closeFirstUse();
          this._setState(STATES.READY);
        } catch (error) {
          status.textContent = error.message || '语音模型安装失败';
        } finally {
          this._setInstallControlsDisabled(false);
        }
      });
    }

    async _pollInstallTask(initial, progress, status) {
      let task = initial || {};
      while (task.status === 'queued' || task.status === 'running') {
        const total = Math.max(0, Number(task.total_bytes || 0));
        const downloaded = Math.max(0, Number(task.downloaded_bytes || 0));
        progress.value = total ? Math.min(99, (downloaded / total) * 100) : 0;
        status.textContent = String(task.stage || '正在安装');
        await new Promise(resolve => global.setTimeout(resolve, 500));
        const payload = await this._requestJson(
          `/api/voice-assistant/install/${encodeURIComponent(task.task_id)}`,
        );
        task = payload.task || {};
      }
      return task;
    }

    _setInstallControlsDisabled(disabled) {
      for (const control of this._ui?.dialog?.querySelectorAll('button[data-action]') || []) {
        control.disabled = Boolean(disabled);
      }
    }

    _closeFirstUse() {
      const dialog = this._ui?.dialog;
      if (!dialog) return;
      if (typeof dialog.close === 'function' && dialog.open) dialog.close();
      else dialog.removeAttribute('open');
    }

    _schedulePosition() {
      if (!this._ui || this._positionFrame) return;
      const run = () => {
        this._positionFrame = 0;
        this._positionEntry();
      };
      if (global.requestAnimationFrame) this._positionFrame = global.requestAnimationFrame(run);
      else run();
    }

    _positionEntry() {
      const target = this._activeTarget;
      const rect = this._targetRect(target);
      if (!this._ui || !rect) {
        if (this._ui) this._ui.root.hidden = true;
        return;
      }
      if (rect.width <= 0 || rect.height <= 0) {
        this._ui.root.hidden = true;
        return;
      }
      this._ui.root.hidden = false;
      this._ui.root.style.left = `${Math.max(8, rect.right - 34)}px`;
      this._ui.root.style.top = `${Math.max(8, rect.top + 6)}px`;
    }

    _targetRect(target) {
      if (!target) return null;
      if (!this._isFrameHandle(target)) {
        if (!target.isConnected || typeof target.getBoundingClientRect !== 'function') return null;
        return target.getBoundingClientRect();
      }
      const resolved = this._resolveFrameTarget(target);
      if (!resolved || typeof resolved.target.getBoundingClientRect !== 'function') return null;
      let left = 0;
      let top = 0;
      let scaleX = 1;
      let scaleY = 1;
      for (const frame of resolved.frames) {
        const frameRect = frame.getBoundingClientRect();
        left += frameRect.left * scaleX;
        top += frameRect.top * scaleY;
        scaleX *= frame.clientWidth > 0 ? frameRect.width / frame.clientWidth : 1;
        scaleY *= frame.clientHeight > 0 ? frameRect.height / frame.clientHeight : 1;
      }
      const inner = resolved.target.getBoundingClientRect();
      return {
        left: left + (inner.left * scaleX),
        right: left + (inner.right * scaleX),
        top: top + (inner.top * scaleY),
        bottom: top + (inner.bottom * scaleY),
        width: inner.width * scaleX,
        height: inner.height * scaleY,
      };
    }
  }

  global.HstarVoiceAssistantCoordinator = Object.freeze({
    STATES,
    VoiceCoordinator,
    create: options => new VoiceCoordinator(options),
  });
})(typeof window !== 'undefined' ? window : null);
