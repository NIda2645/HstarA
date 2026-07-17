import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function exactCanvasId(canvasOrId) {
  const value = typeof canvasOrId === 'string' ? canvasOrId : canvasOrId?.id;
  const id = typeof value === 'string' ? value.trim() : '';
  if(!id) throw new TypeError('A created canvas ID is required');
  return id;
}

export function createTestCanvasCleanup(baseUrl, options = {}) {
  const endpoint = String(baseUrl || '').replace(/\/+$/, '');
  if(!endpoint) throw new TypeError('HSTAR_BASE_URL is required');
  const ids = new Set();
  const retries = Math.max(0, Number.parseInt(options.retries ?? 3, 10) || 0);
  const retryDelayMs = Math.max(0, Number(options.retryDelayMs ?? 120) || 0);
  const sleep = typeof options.sleep === 'function'
    ? options.sleep
    : delay => new Promise(resolveSleep => setTimeout(resolveSleep, delay));

  return {
    async assertStorageIsolated(request) {
      const response = await request.get(`${endpoint}/api/software-settings`);
      const payload = await response.json().catch(() => ({}));
      if(!response.ok()) {
        throw new Error(`Unable to verify HstarA E2E storage: HTTP ${response.status()}`);
      }
      const storageRoot = String(payload?.settings?.active_storage_root || '').trim();
      const relativePath = storageRoot ? relative(workspaceRoot, resolve(storageRoot)) : '..';
      const isInside = relativePath === '' || (
        relativePath !== '..'
        && !relativePath.startsWith(`..${sep}`)
        && !isAbsolute(relativePath)
      );
      if(!isInside) {
        throw new Error(
          `Refusing to create E2E canvases: storage root is outside the current HstarA worktree (${storageRoot || 'missing'})`
        );
      }
      return storageRoot;
    },

    track(canvasOrId) {
      ids.add(exactCanvasId(canvasOrId));
      return canvasOrId;
    },

    pendingIds() {
      return [...ids];
    },

    async purgeAll(request) {
      const failures = [];
      for(const id of [...ids]) {
        let failure = '';
        for(let attempt = 0; attempt <= retries; attempt += 1) {
          try {
            const result = await request.delete(
              `${endpoint}/api/canvases/${encodeURIComponent(id)}/purge`
            );
            if(result.ok() || result.status() === 404) {
              ids.delete(id);
              failure = '';
              break;
            }
            const detail = await result.text().catch(() => '');
            failure = `${id}: HTTP ${result.status()}${detail ? ` ${detail}` : ''}`;
            const transient = result.status() >= 500;
            if(!transient || attempt === retries) break;
          } catch(error) {
            failure = `${id}: ${error instanceof Error ? error.message : String(error)}`;
            if(attempt === retries) break;
          }
          await sleep(retryDelayMs * (attempt + 1));
        }
        if(failure) failures.push(failure);
      }
      if(failures.length) {
        throw new Error(`Failed to purge HstarA E2E canvases:\n${failures.join('\n')}`);
      }
    },
  };
}
