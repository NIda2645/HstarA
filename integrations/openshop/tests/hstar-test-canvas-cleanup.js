function exactCanvasId(canvasOrId) {
  const value = typeof canvasOrId === 'string' ? canvasOrId : canvasOrId?.id;
  const id = typeof value === 'string' ? value.trim() : '';
  if(!id) throw new TypeError('A created canvas ID is required');
  return id;
}

export function createTestCanvasCleanup(baseUrl) {
  const endpoint = String(baseUrl || '').replace(/\/+$/, '');
  if(!endpoint) throw new TypeError('HSTAR_BASE_URL is required');
  const ids = new Set();

  return {
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
        try {
          const result = await request.delete(
            `${endpoint}/api/canvases/${encodeURIComponent(id)}/purge`
          );
          if(result.ok() || result.status() === 404) {
            ids.delete(id);
            continue;
          }
          const detail = await result.text().catch(() => '');
          failures.push(`${id}: HTTP ${result.status()}${detail ? ` ${detail}` : ''}`);
        } catch(error) {
          failures.push(`${id}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if(failures.length) {
        throw new Error(`Failed to purge HstarA E2E canvases:\n${failures.join('\n')}`);
      }
    },
  };
}
