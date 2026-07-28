(function installVoiceSettingsPanel(global) {
  'use strict';

  if (!global?.document || global.HstarVoiceSettingsPanel) return;

  const POLL_INTERVAL_MS = 750;
  const DEFAULT_SHORTCUT = 'Shift+Q';
  const ACTIVE_TASK_STATES = new Set(['queued', 'running']);
  const TERMINAL_TASK_STATES = new Set(['completed', 'cancelled', 'failed']);
  const elements = {};
  let currentStatus = null;
  let pollTimer = 0;
  let busy = false;
  let confirmResolver = null;

  function byId(id) {
    return global.document.getElementById(id);
  }

  function cacheElements() {
    const ids = [
      'voiceAssistantCard', 'voiceState', 'voiceStorageMode', 'voiceStorageInput',
      'voiceBrowseBtn', 'voiceEffectivePath', 'voiceModelPath', 'voiceModelId',
      'voiceModelRevision', 'voiceModelSize', 'voiceOwnership', 'voiceRuntimeVersion',
      'voiceDeviceMode', 'voiceInputDevice', 'voiceLanguage', 'voiceShortcut',
      'voiceEnabled', 'voicePrewarm', 'voiceSaveSettingsBtn', 'voiceDetectBtn',
      'voiceMigrateBtn', 'voiceDownloadBtn', 'voiceCancelBtn', 'voiceRepairBtn',
      'voiceUpdateBtn', 'voiceUninstallBtn', 'voiceProgressWrap', 'voiceProgress',
      'voiceProgressStage', 'voiceProgressBytes', 'voiceStatus', 'voiceConfirmDialog',
      'voiceConfirmTitle', 'voiceConfirmMessage', 'voiceConfirmPath',
      'voiceConfirmOwnership', 'voiceDeleteExternalRow', 'voiceDeleteExternal',
      'voiceConfirmCancel', 'voiceConfirmAccept',
    ];
    for (const id of ids) elements[id] = byId(id);
    return Boolean(elements.voiceAssistantCard);
  }

  function errorMessage(body, fallback = '语音助手操作失败。') {
    const detail = body?.detail;
    if (typeof detail === 'string') return detail;
    if (detail && typeof detail === 'object') return detail.message || detail.code || fallback;
    return body?.message || body?.error || fallback;
  }

  async function api(path, options = {}) {
    const response = await global.fetch(path, {cache: 'no-store', ...options});
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body?.ok === false) {
      const error = new Error(errorMessage(body));
      error.code = body?.detail?.code || body?.code || 'VOICE_REQUEST_FAILED';
      throw error;
    }
    return body;
  }

  function jsonOptions(body) {
    return {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(body || {}),
    };
  }

  function setStatus(message, type = '') {
    elements.voiceStatus.textContent = String(message || '');
    elements.voiceStatus.className = `status ${type}`.trim();
  }

  function formatBytes(value) {
    let bytes = Math.max(0, Number(value || 0));
    if (!bytes) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let unit = 0;
    while (bytes >= 1024 && unit < units.length - 1) {
      bytes /= 1024;
      unit += 1;
    }
    return `${bytes >= 100 || unit === 0 ? bytes.toFixed(0) : bytes.toFixed(1)} ${units[unit]}`;
  }

  function taskActive(task) {
    return Boolean(task && ACTIVE_TASK_STATES.has(String(task.status || '')));
  }

  function taskStage(stage) {
    return {
      'checking-runtime': '正在检查运行时',
      'installing-runtime': '正在安装运行时',
      'resolving-manifest': '正在读取模型清单',
      'downloading-model': '正在下载模型',
      validating: '正在验证模型',
      ready: '已完成',
      cancelled: '已取消',
      failed: '任务失败',
    }[stage] || String(stage || '准备中');
  }

  function renderProgress(task) {
    elements.voiceProgressWrap.hidden = !task;
    if (!task) {
      elements.voiceProgress.removeAttribute('value');
      elements.voiceProgress.removeAttribute('aria-valuenow');
      elements.voiceProgressStage.textContent = '-';
      elements.voiceProgressBytes.textContent = '-';
      return;
    }
    const total = Math.max(0, Number(task.total_bytes || 0));
    const downloaded = Math.max(0, Number(task.downloaded_bytes || 0));
    if (total > 0) {
      const percentage = Math.min(100, (downloaded / total) * 100);
      elements.voiceProgress.value = percentage;
      elements.voiceProgress.setAttribute('aria-valuenow', String(Math.round(percentage)));
    } else {
      elements.voiceProgress.removeAttribute('value');
      elements.voiceProgress.removeAttribute('aria-valuenow');
    }
    elements.voiceProgressStage.textContent = taskStage(task.stage);
    elements.voiceProgressBytes.textContent = total
      ? `${formatBytes(downloaded)} / ${formatBytes(total)}`
      : formatBytes(downloaded);
  }

  function stateSummary(status) {
    const settings = status?.settings || {};
    const model = status?.model || {};
    const service = status?.service || {};
    const task = status?.task;
    if (settings.enabled === false) return {state: 'disabled', label: '已关闭'};
    if (taskActive(task)) return {state: 'installing', label: '任务执行中'};
    if (service.last_error) return {state: 'error', label: '需要修复'};
    if (!model.ready) return {state: 'missing', label: '未安装'};
    if (service.model_state === 'loading') return {state: 'loading', label: '加载中'};
    if (service.process_state === 'running') return {state: 'running', label: '运行中'};
    return {state: 'ready', label: '可用'};
  }

  function ownershipLabel(source) {
    return source === 'managed' ? 'Hstar 管理' : source === 'external' ? '用户外部模型' : '-';
  }

  function renderStatus(status) {
    currentStatus = status || {};
    const settings = currentStatus.settings || {};
    const model = currentStatus.model || {};
    const service = currentStatus.service || {};
    const task = currentStatus.task || null;
    const summary = stateSummary(currentStatus);

    elements.voiceAssistantCard.dataset.state = summary.state;
    elements.voiceState.textContent = summary.label;
    elements.voiceStorageMode.value = settings.storage_mode === 'custom' ? 'custom' : 'inherit';
    elements.voiceStorageInput.value = String(settings.configured_root || '');
    elements.voiceStorageInput.disabled = elements.voiceStorageMode.value !== 'custom';
    elements.voiceEffectivePath.textContent = String(settings.effective_root || '-');
    elements.voiceModelPath.textContent = String(model.model_path || settings.model_path || '-');
    elements.voiceModelId.textContent = String(settings.model_id || 'FunAudioLLM/Fun-ASR-Nano-2512');
    elements.voiceModelRevision.textContent = String(model.revision || settings.model_revision || '-');
    elements.voiceModelSize.textContent = model.size_bytes > 0 ? formatBytes(model.size_bytes) : '-';
    elements.voiceOwnership.textContent = ownershipLabel(model.source);
    elements.voiceRuntimeVersion.textContent = String(
      service.runtime_version || (task?.runtime_ready ? '已安装' : '未加载'),
    );
    elements.voiceDeviceMode.textContent = String(
      service.device || (service.process_state === 'running' ? '已自动选择' : '未启动'),
    );
    elements.voiceLanguage.value = ['auto', 'zh', 'en', 'ja'].includes(settings.language)
      ? settings.language
      : 'auto';
    elements.voiceShortcut.value = String(settings.shortcut || DEFAULT_SHORTCUT);
    elements.voiceEnabled.checked = settings.enabled !== false;
    elements.voicePrewarm.checked = Boolean(settings.prewarm_on_startup);
    selectMicrophone(settings.input_device_id || 'default');
    renderProgress(task);
    renderActionAvailability(task);

    if (task?.status === 'failed') setStatus(task.error_message || task.error_code || '语音任务失败。', 'err');
    else if (task?.status === 'cancelled') setStatus('任务已取消，下载数据可继续使用。');
    else if (task?.status === 'completed') setStatus('语音模型与运行时已就绪。', 'ok');
  }

  function renderActionAvailability(task) {
    const active = taskActive(task);
    const locked = busy || active;
    const managedModel = currentStatus?.model?.source === 'managed';
    const controls = [
      elements.voiceSaveSettingsBtn, elements.voiceDetectBtn, elements.voiceMigrateBtn,
      elements.voiceDownloadBtn, elements.voiceRepairBtn, elements.voiceUpdateBtn,
      elements.voiceUninstallBtn, elements.voiceBrowseBtn,
    ];
    for (const control of controls) control.disabled = locked;
    elements.voiceCancelBtn.hidden = !active;
    elements.voiceCancelBtn.disabled = busy || !active;
    elements.voiceUpdateBtn.disabled = locked || !managedModel;
  }

  function schedulePoll(task) {
    if (pollTimer) global.clearTimeout(pollTimer);
    pollTimer = 0;
    if (taskActive(task)) {
      pollTimer = global.setTimeout(() => {
        pollTimer = 0;
        void loadStatus();
      }, POLL_INTERVAL_MS);
    }
  }

  async function loadStatus() {
    try {
      const payload = await api('/api/voice-assistant/status');
      renderStatus(payload.status || {});
      schedulePoll(payload.status?.task);
      return payload.status || {};
    } catch (error) {
      elements.voiceState.textContent = '读取失败';
      elements.voiceAssistantCard.dataset.state = 'error';
      setStatus(error.message, 'err');
      return null;
    }
  }

  async function selectMicrophone(selected) {
    const select = elements.voiceInputDevice;
    if (!select || select.dataset.loading === 'true') return;
    select.dataset.loading = 'true';
    try {
      const devices = await global.navigator?.mediaDevices?.enumerateDevices?.();
      const microphones = (devices || []).filter(device => device.kind === 'audioinput');
      const seen = new Set(['default']);
      select.innerHTML = '<option value="default">系统默认</option>';
      microphones.forEach((device, index) => {
        const id = String(device.deviceId || '');
        if (!id || seen.has(id)) return;
        seen.add(id);
        const option = global.document.createElement('option');
        option.value = id;
        option.textContent = device.label || `麦克风 ${index + 1}`;
        select.append(option);
      });
      if (seen.has(String(selected))) select.value = String(selected);
    } catch {
      select.value = 'default';
    } finally {
      select.dataset.loading = 'false';
    }
  }

  function settingPayload() {
    return {
      enabled: elements.voiceEnabled.checked,
      storage_mode: elements.voiceStorageMode.value,
      storage_root: elements.voiceStorageMode.value === 'custom'
        ? elements.voiceStorageInput.value.trim()
        : '',
      language: elements.voiceLanguage.value,
      input_device_id: elements.voiceInputDevice.value || 'default',
      shortcut: elements.voiceShortcut.value.trim() || DEFAULT_SHORTCUT,
      prewarm_on_startup: elements.voicePrewarm.checked,
    };
  }

  async function runBusy(action, pendingMessage) {
    if (busy) return null;
    busy = true;
    renderActionAvailability(currentStatus?.task);
    setStatus(pendingMessage || '正在处理...');
    try {
      return await action();
    } finally {
      busy = false;
      renderActionAvailability(currentStatus?.task);
    }
  }

  async function saveSettings() {
    const previous = currentStatus;
    try {
      await runBusy(async () => {
        const payload = await api('/api/voice-assistant/settings', jsonOptions(settingPayload()));
        renderStatus(payload.status || {...(previous || {}), settings: payload.settings});
        schedulePoll(payload.status?.task);
        setStatus('语音助手设置已保存。', 'ok');
        broadcastUpdate();
      }, '正在验证并保存语音设置...');
    } catch (error) {
      if (previous) renderStatus(previous);
      setStatus(error.message, 'err');
    }
  }

  async function chooseFolder() {
    try {
      await runBusy(async () => {
        const payload = await api('/api/voice-assistant/choose-folder', jsonOptions({
          path: elements.voiceStorageInput.value.trim() || currentStatus?.settings?.effective_root || '',
        }));
        if (payload.path) {
          elements.voiceStorageMode.value = 'custom';
          elements.voiceStorageInput.disabled = false;
          elements.voiceStorageInput.value = String(payload.path);
          setStatus('已选择文件夹，保存设置后生效。');
        } else {
          setStatus('已取消选择。');
        }
      }, '正在打开文件夹选择器...');
    } catch (error) {
      setStatus(error.message, 'err');
    }
  }

  async function detectModel() {
    const path = elements.voiceStorageInput.value.trim()
      || currentStatus?.settings?.effective_root
      || '';
    try {
      await runBusy(async () => {
        const payload = await api('/api/voice-assistant/detect-model', jsonOptions({path}));
        if (!payload.model?.ready) {
          const missing = (payload.model?.missing || []).slice(0, 3).join(', ');
          throw new Error(missing ? `模型不完整：${missing}` : '未找到完整的语音模型。');
        }
        await loadStatus();
        setStatus('已检测并启用现有语音模型。', 'ok');
        broadcastUpdate();
      }, '正在检测语音模型...');
    } catch (error) {
      setStatus(error.message, 'err');
    }
  }

  async function startTask(endpoint, message) {
    try {
      await runBusy(async () => {
        const payload = await api(endpoint, jsonOptions({profile: 'auto', revision: 'master'}));
        currentStatus = {...(currentStatus || {}), task: payload.task || null};
        renderStatus(currentStatus);
        schedulePoll(payload.task);
        broadcastUpdate();
      }, message);
    } catch (error) {
      setStatus(error.message, 'err');
    }
  }

  async function cancelTask() {
    const taskId = String(currentStatus?.task?.task_id || '');
    if (!taskId || busy) return;
    try {
      await runBusy(async () => {
        const payload = await api('/api/voice-assistant/install/cancel', jsonOptions({task_id: taskId}));
        currentStatus = {...(currentStatus || {}), task: payload.task || null};
        renderStatus(currentStatus);
        schedulePoll(payload.task);
        setStatus('正在取消任务...');
      }, '正在取消任务...');
    } catch (error) {
      setStatus(error.message, 'err');
    }
  }

  function closeConfirmation(result) {
    const dialog = elements.voiceConfirmDialog;
    if (typeof dialog.close === 'function' && dialog.open) dialog.close();
    else dialog.removeAttribute('open');
    const resolve = confirmResolver;
    confirmResolver = null;
    resolve?.(result);
  }

  function confirmAction({title, message, path, ownership, allowExternalDelete = false}) {
    if (confirmResolver) closeConfirmation(false);
    elements.voiceConfirmTitle.textContent = title;
    elements.voiceConfirmMessage.textContent = message;
    elements.voiceConfirmPath.textContent = path || '-';
    elements.voiceConfirmOwnership.textContent = ownershipLabel(ownership);
    elements.voiceDeleteExternalRow.hidden = !allowExternalDelete;
    elements.voiceDeleteExternal.checked = false;
    if (typeof elements.voiceConfirmDialog.showModal === 'function') elements.voiceConfirmDialog.showModal();
    else elements.voiceConfirmDialog.setAttribute('open', '');
    return new Promise(resolve => { confirmResolver = resolve; });
  }

  async function migrateData() {
    const target = elements.voiceStorageInput.value.trim();
    if (elements.voiceStorageMode.value !== 'custom' || !target) {
      setStatus('请先选择自定义语音数据目录。', 'err');
      return;
    }
    const accepted = await confirmAction({
      title: '迁移语音数据',
      message: '运行时、模型与缓存将迁移到新目录。',
      path: target,
      ownership: currentStatus?.model?.source,
    });
    if (!accepted) return;
    try {
      await runBusy(async () => {
        await api('/api/voice-assistant/migrate', jsonOptions({storage_root: target}));
        await loadStatus();
        setStatus('语音数据已迁移。', 'ok');
        broadcastUpdate();
      }, '正在迁移语音数据...');
    } catch (error) {
      setStatus(error.message, 'err');
    }
  }

  async function uninstallData() {
    const model = currentStatus?.model || {};
    const external = model.source === 'external';
    const accepted = await confirmAction({
      title: '卸载语音数据',
      message: external
        ? '默认仅删除 Hstar 管理的运行时与缓存，外部模型保留。'
        : '将删除 Hstar 管理的语音运行时、模型与缓存。',
      path: model.model_path || currentStatus?.settings?.effective_root || '-',
      ownership: model.source,
      allowExternalDelete: external,
    });
    if (!accepted) return;
    const deleteExternal = external && elements.voiceDeleteExternal.checked;
    try {
      await runBusy(async () => {
        await api('/api/voice-assistant/uninstall', jsonOptions({
          delete_external_model: deleteExternal,
          confirmation_token: deleteExternal ? 'DELETE_EXTERNAL_VOICE_MODEL' : '',
        }));
        await loadStatus();
        setStatus('语音数据已卸载。', 'ok');
        broadcastUpdate();
      }, '正在卸载语音数据...');
    } catch (error) {
      setStatus(error.message, 'err');
    }
  }

  function normalizeShortcut(value) {
    const parts = String(value || '').split('+').map(part => part.trim()).filter(Boolean);
    const modifiers = {Ctrl: false, Alt: false, Shift: false, Meta: false};
    let key = '';
    for (const part of parts) {
      const lower = part.toLowerCase();
      if (lower === 'ctrl' || lower === 'control') modifiers.Ctrl = true;
      else if (lower === 'alt') modifiers.Alt = true;
      else if (lower === 'shift') modifiers.Shift = true;
      else if (lower === 'meta' || lower === 'win' || lower === 'cmd') modifiers.Meta = true;
      else key = part.length === 1 ? part.toUpperCase() : part;
    }
    if (!key) return '';
    return [...Object.keys(modifiers).filter(name => modifiers[name]), key].join('+');
  }

  function captureShortcut(event) {
    event.preventDefault();
    event.stopPropagation();
    const lower = String(event.key || '').toLowerCase();
    if (['control', 'shift', 'alt', 'meta'].includes(lower)) return;
    const parts = [];
    if (event.ctrlKey) parts.push('Ctrl');
    if (event.altKey) parts.push('Alt');
    if (event.shiftKey) parts.push('Shift');
    if (event.metaKey) parts.push('Meta');
    let key = event.key === ' ' ? 'Space' : String(event.key || '');
    if (key.length === 1) key = key.toUpperCase();
    if (!parts.length && !/^F\d+$/i.test(key)) return;
    elements.voiceShortcut.value = normalizeShortcut([...parts, key].join('+')) || DEFAULT_SHORTCUT;
    setStatus('快捷键已修改，保存设置后生效。');
  }

  function broadcastUpdate() {
    global.dispatchEvent(new global.CustomEvent('voice-assistant-updated', {detail: currentStatus}));
    if (global.parent && global.parent !== global) {
      global.parent.postMessage({type: 'voice-assistant-updated'}, global.location.origin);
    }
  }

  function bindEvents() {
    elements.voiceStorageMode.addEventListener('change', () => {
      elements.voiceStorageInput.disabled = elements.voiceStorageMode.value !== 'custom';
    });
    elements.voiceBrowseBtn.addEventListener('click', chooseFolder);
    elements.voiceSaveSettingsBtn.addEventListener('click', saveSettings);
    elements.voiceDetectBtn.addEventListener('click', detectModel);
    elements.voiceMigrateBtn.addEventListener('click', migrateData);
    elements.voiceDownloadBtn.addEventListener('click', () => (
      startTask('/api/voice-assistant/install', '正在创建下载任务...')
    ));
    elements.voiceRepairBtn.addEventListener('click', () => (
      startTask('/api/voice-assistant/repair', '正在创建修复任务...')
    ));
    elements.voiceUpdateBtn.addEventListener('click', () => (
      startTask('/api/voice-assistant/install', '正在检查模型更新...')
    ));
    elements.voiceCancelBtn.addEventListener('click', cancelTask);
    elements.voiceUninstallBtn.addEventListener('click', uninstallData);
    elements.voiceShortcut.addEventListener('keydown', captureShortcut);
    elements.voiceShortcut.addEventListener('focus', () => {
      setStatus('请按下新的语音助手快捷键。');
    });
    elements.voiceConfirmDialog.addEventListener('submit', event => event.preventDefault());
    elements.voiceConfirmCancel.addEventListener('click', () => closeConfirmation(false));
    elements.voiceConfirmAccept.addEventListener('click', () => closeConfirmation(true));
    elements.voiceConfirmDialog.addEventListener('cancel', event => {
      event.preventDefault();
      closeConfirmation(false);
    });
    global.addEventListener('message', event => {
      if (event.origin !== global.location.origin) return;
      if (event.data?.type === 'voice-assistant-updated') void loadStatus();
    });
  }

  function init() {
    if (!cacheElements()) return;
    bindEvents();
    void loadStatus();
  }

  global.HstarVoiceSettingsPanel = Object.freeze({
    refresh: loadStatus,
    renderProgress,
  });
  init();
})(typeof window !== 'undefined' ? window : null);
