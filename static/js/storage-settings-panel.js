(function installStorageSettingsPanel(global) {
  'use strict';

  if (!global?.document || global.HstarStorageSettingsPanel) return;

  const POLL_INTERVAL_MS = 500;
  const ACTIVE_STATES = new Set(['preflight', 'copying', 'verifying', 'switching']);
  const elements = {};
  const completedTasks = new Set();
  let activeTask = null;
  let pollTimer = 0;
  let busy = false;

  function byId(id) {
    return global.document.getElementById(id);
  }

  function cacheElements() {
    const ids = [
      'currentPath', 'storageInput', 'status', 'saveBtn', 'browseBtn',
      'storageProgressWrap', 'storageProgress', 'storageProgressStage',
      'storageProgressBytes', 'storageCancelBtn',
    ];
    for (const id of ids) elements[id] = byId(id);
    return ids.every(id => Boolean(elements[id]));
  }

  function errorMessage(body, fallback) {
    const detail = body?.detail;
    if (typeof detail === 'string') return detail;
    if (detail && typeof detail === 'object') return detail.message || detail.error || fallback;
    return body?.message || body?.error || fallback;
  }

  async function request(path, options = {}) {
    const response = await global.fetch(path, {cache: 'no-store', ...options});
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body?.ok === false) {
      throw new Error(errorMessage(body, '存储操作失败。'));
    }
    return body;
  }

  function setStatus(message, type = '') {
    elements.status.textContent = String(message || '');
    elements.status.className = `status ${type}`.trim();
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

  function stageLabel(task) {
    const labels = {
      preflight: '正在检查目录与空间',
      copying: '正在复制数据',
      verifying: '正在校验数据',
      switching: '正在切换数据目录',
      completed: '迁移完成',
      cancelled: '迁移已取消',
      failed: '迁移失败',
    };
    const base = labels[String(task?.status || '')] || '准备中';
    return task?.current_path ? `${base}：${task.current_path}` : base;
  }

  function taskActive(task) {
    return Boolean(task && ACTIVE_STATES.has(String(task.status || '')));
  }

  function setControls() {
    const active = taskActive(activeTask);
    elements.saveBtn.disabled = busy || active;
    elements.browseBtn.disabled = busy || active;
    elements.storageInput.disabled = active;
    elements.storageCancelBtn.disabled = busy || !active;
    elements.storageCancelBtn.hidden = !active;
  }

  function renderTask(task) {
    activeTask = task || null;
    elements.storageProgressWrap.hidden = !task;
    if (!task) {
      elements.storageProgress.removeAttribute('value');
      elements.storageProgress.removeAttribute('aria-valuenow');
      elements.storageProgressStage.textContent = '准备中';
      elements.storageProgressBytes.textContent = '0 B';
      setControls();
      return;
    }

    const copied = Math.max(0, Number(task.copied_bytes || 0));
    const total = Math.max(0, Number(task.total_bytes || 0));
    if (total > 0) {
      const percent = Math.min(100, (copied / total) * 100);
      elements.storageProgress.value = percent;
      elements.storageProgress.setAttribute('aria-valuenow', String(Math.round(percent)));
      elements.storageProgressBytes.textContent = `${formatBytes(copied)} / ${formatBytes(total)}`;
    } else {
      elements.storageProgress.removeAttribute('value');
      elements.storageProgress.removeAttribute('aria-valuenow');
      elements.storageProgressBytes.textContent = formatBytes(copied);
    }
    elements.storageProgressStage.textContent = stageLabel(task);
    if (task.status === 'failed') setStatus(task.error || '迁移失败，请检查目标目录。', 'err');
    else if (task.status === 'cancelled') setStatus('迁移已取消，已复制数据可在下次继续使用。');
    else if (taskActive(task)) setStatus(stageLabel(task));
    setControls();
  }

  function schedulePoll(task) {
    if (pollTimer) global.clearTimeout(pollTimer);
    pollTimer = 0;
    if (!taskActive(task)) return;
    pollTimer = global.setTimeout(() => {
      pollTimer = 0;
      void pollTask(task.id);
    }, POLL_INTERVAL_MS);
  }

  async function handoffCompletedMigration(task) {
    if (!task?.id || completedTasks.has(task.id)) return;
    completedTasks.add(task.id);
    const dataRoot = String(task.target || elements.storageInput.value || '').trim();
    elements.currentPath.textContent = dataRoot || '已迁移';
    elements.storageInput.value = dataRoot;
    const webview = global.chrome?.webview;
    if (typeof webview?.postMessage === 'function') {
      setStatus('迁移完成，正在重新启动 Hstar。', 'ok');
      webview.postMessage({
        type: 'hstar-restart-with-data-root',
        dataRoot,
      });
      return;
    }
    setStatus('迁移完成，请重新启动 Hstar 以使用新位置。', 'ok');
  }

  async function pollTask(taskId) {
    try {
      const body = await request(`/api/storage-migrations/${encodeURIComponent(taskId)}`);
      const task = body.task || null;
      renderTask(task);
      if (task?.status === 'completed') await handoffCompletedMigration(task);
      else schedulePoll(task);
      return task;
    } catch (error) {
      setStatus(error.message || '无法读取迁移进度。', 'err');
      setControls();
      return null;
    }
  }

  async function startMigration(storageRoot) {
    const storage_root = String(storageRoot || '').trim();
    if (!storage_root) {
      setStatus('请输入储存文件夹路径。', 'err');
      return null;
    }
    if (busy || taskActive(activeTask)) return activeTask;
    busy = true;
    setControls();
    setStatus('正在创建数据迁移任务。');
    try {
      const body = await global.fetch('/api/storage-migrations', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({storage_root}),
      }).then(async response => {
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || payload?.ok === false) {
          throw new Error(errorMessage(payload, '无法创建数据迁移任务。'));
        }
        return payload;
      });
      renderTask(body.task || null);
      schedulePoll(body.task);
      return body.task || null;
    } catch (error) {
      setStatus(error.message || '无法创建数据迁移任务。', 'err');
      return null;
    } finally {
      busy = false;
      setControls();
    }
  }

  async function cancelMigration() {
    if (!taskActive(activeTask) || busy) return activeTask;
    busy = true;
    setControls();
    setStatus('正在取消迁移。');
    try {
      const body = await request(`/api/storage-migrations/${encodeURIComponent(activeTask.id)}`, {
        method: 'DELETE',
      });
      renderTask(body.task || activeTask);
      schedulePoll(body.task || activeTask);
      return body.task || activeTask;
    } catch (error) {
      setStatus(error.message || '取消迁移失败。', 'err');
      return activeTask;
    } finally {
      busy = false;
      setControls();
    }
  }

  function desktopApi() {
    return global.aiStudio || global.parent?.aiStudio || null;
  }

  async function chooseStorageFolder() {
    if (busy || taskActive(activeTask)) return;
    busy = true;
    setControls();
    setStatus('正在打开系统文件夹选择器。');
    try {
      const desktop = desktopApi();
      let selected = '';
      if (typeof desktop?.chooseStorageFolder === 'function') {
        selected = await desktop.chooseStorageFolder();
      } else {
        const body = await request('/api/native/choose-folder', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({
            initial_dir: elements.storageInput.value.trim(),
            purpose: 'storage',
          }),
        });
        selected = body.path || '';
      }
      if (selected) {
        elements.storageInput.value = selected;
        setStatus('已选择文件夹，点击“保存”开始迁移。');
      } else {
        setStatus('已取消选择。');
      }
    } catch (error) {
      setStatus(error.message || '无法打开系统文件夹选择器。', 'err');
    } finally {
      busy = false;
      setControls();
    }
  }

  async function loadSettings() {
    try {
      const body = await request('/api/software-settings');
      const settings = body.settings || {};
      const root = String(settings.active_storage_root || settings.storage_root || '');
      elements.currentPath.textContent = root || '默认目录';
      elements.storageInput.value = root;
      return settings;
    } catch (error) {
      elements.currentPath.textContent = '读取失败';
      setStatus(error.message || '无法读取软件设置。', 'err');
      return null;
    }
  }

  function install() {
    if (!cacheElements()) return false;
    elements.saveBtn.addEventListener('click', () => {
      void startMigration(elements.storageInput.value);
    });
    elements.browseBtn.addEventListener('click', () => {
      void chooseStorageFolder();
    });
    elements.storageCancelBtn.addEventListener('click', () => {
      void cancelMigration();
    });
    renderTask(null);
    void loadSettings();
    return true;
  }

  global.HstarStorageSettingsPanel = {
    cancelMigration,
    handoffCompletedMigration,
    loadSettings,
    pollTask,
    renderTask,
    startMigration,
  };
  install();
})(window);
