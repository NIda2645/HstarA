(function bootstrapOpenShopExportService(root){
  const SUPPORTED_FORMATS = Object.freeze(['png', 'jpeg', 'webp', 'svg', 'pdf', 'psd']);

  function safeError(value){
    return String(value?.message || value || '导出失败')
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 180) || '导出失败';
  }

  function normalizeArtifact(value, expectedFormat){
    const format = String(value?.format || expectedFormat || '').toLowerCase();
    if(!SUPPORTED_FORMATS.includes(format)){
      throw new Error(`Unsupported export format: ${format}`);
    }
    if(!(value?.blob instanceof root.Blob)){
      throw new Error(`Export ${format} did not produce a Blob`);
    }
    const fallbackName = `openshop-export.${format === 'jpeg' ? 'jpg' : format}`;
    const filename = String(value.filename || fallbackName).trim() || fallbackName;
    const width = Math.max(1, Math.round(Number(value.width || 0)));
    const height = Math.max(1, Math.round(Number(value.height || 0)));
    return {
      ...value,
      format,
      filename,
      width,
      height,
      mimeType:String(value.mimeType || value.blob.type || 'application/octet-stream'),
    };
  }

  function readBlobBytes(blob){
    if(typeof blob.arrayBuffer === 'function') return blob.arrayBuffer();
    return new Promise((resolve, reject) => {
      const reader = new root.FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error || new Error('Blob read failed'));
      reader.readAsArrayBuffer(blob);
    });
  }

  async function blobToBase64(blob){
    const bytes = new Uint8Array(await readBlobBytes(blob));
    let binary = '';
    const chunkSize = 0x8000;
    for(let index = 0; index < bytes.length; index += chunkSize){
      binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
    }
    return root.btoa(binary);
  }

  async function responseJson(response){
    const body = await response.json().catch(() => ({}));
    if(!response.ok){
      const detail = typeof body?.detail === 'string' ? body.detail : '';
      throw new Error(detail || `保存失败 (${response.status})`);
    }
    return body;
  }

  function create({generators, fetchImpl = root.fetch?.bind(root), storage = root.localStorage} = {}){
    if(!generators || typeof generators !== 'object'){
      throw new Error('Export generators are required');
    }
    if(typeof fetchImpl !== 'function'){
      throw new Error('Fetch is unavailable');
    }

    async function initialFolder(){
      try {
        const cached = storage?.getItem?.('hstar.outputDownloadFolder') || '';
        if(cached) return cached;
      } catch(error) {}
      const response = await fetchImpl('/api/output-download-folder');
      const value = await responseJson(response);
      return String(value.folder || '');
    }

    async function createArtifact(format, options = {}){
      const normalized = String(format || '').toLowerCase();
      const generator = generators[normalized];
      if(typeof generator !== 'function'){
        throw new Error(`Unsupported export format: ${normalized}`);
      }
      return normalizeArtifact(await generator(options), normalized);
    }

    async function saveArtifact(artifact){
      const value = normalizeArtifact(artifact, artifact?.format);
      const response = await fetchImpl('/api/native/save-output-as', {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({
          name:value.filename,
          initial_dir:await initialFolder(),
          content_base64:await blobToBase64(value.blob),
        }),
      });
      const result = await responseJson(response);
      if(!result.cancelled && result.folder){
        try { storage?.setItem?.('hstar.outputDownloadFolder', result.folder); } catch(error) {}
      }
      return result;
    }

    async function saveFormat(format, options = {}){
      return saveArtifact(await createArtifact(format, options));
    }

    async function saveBatch(formats, optionsByFormat = {}){
      const artifacts = [];
      for(const format of formats){
        artifacts.push(await createArtifact(format, optionsByFormat[format] || {}));
      }
      const items = [];
      for(const artifact of artifacts){
        items.push({
          name:artifact.filename,
          content_base64:await blobToBase64(artifact.blob),
        });
      }
      const response = await fetchImpl('/api/native/save-output-batch', {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({items, initial_dir:await initialFolder()}),
      });
      const result = await responseJson(response);
      if(!result.cancelled && result.folder){
        try { storage?.setItem?.('hstar.outputDownloadFolder', result.folder); } catch(error) {}
      }
      return result;
    }

    return Object.freeze({createArtifact, saveArtifact, saveFormat, saveBatch});
  }

  root.HstarOpenShopExportService = Object.freeze({
    SUPPORTED_FORMATS,
    create,
    blobToBase64,
    normalizeArtifact,
    safeError,
  });
})(window);
