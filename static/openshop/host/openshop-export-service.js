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

  function triggerUrlDownload(url, filename){
    const link = root.document.createElement('a');
    link.href = url;
    link.download = filename;
    root.document.body.appendChild(link);
    link.click();
    link.remove();
  }

  async function triggerBlobDownload(blob, filename){
    const url = root.URL.createObjectURL(blob);
    try {
      triggerUrlDownload(url, filename);
    } finally {
      root.setTimeout(() => root.URL.revokeObjectURL(url), 5000);
    }
  }

  async function triggerArtifactBatch(artifacts){
    const files = artifacts.map(artifact => ({
      url:root.URL.createObjectURL(artifact.blob),
      filename:artifact.filename,
    }));
    try {
      let bridge = null;
      try { bridge = root.top?.HstarDesktopDownloads; } catch(error) {}
      if(bridge?.saveBatch) return await bridge.saveBatch(files);
      files.forEach(file => triggerUrlDownload(file.url, file.filename));
      return {accepted:true, count:files.length};
    } finally {
      root.setTimeout(() => files.forEach(file => root.URL.revokeObjectURL(file.url)), 5000);
    }
  }

  function create({
    generators,
    downloadImpl = triggerBlobDownload,
    downloadBatchImpl = triggerArtifactBatch,
  } = {}){
    if(!generators || typeof generators !== 'object'){
      throw new Error('Export generators are required');
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
      await downloadImpl(value.blob, value.filename);
      return {ok:true, cancelled:false, filename:value.filename};
    }

    async function saveFormat(format, options = {}){
      return saveArtifact(await createArtifact(format, options));
    }

    async function saveBatch(formats, optionsByFormat = {}){
      const artifacts = [];
      for(const format of formats){
        artifacts.push(await createArtifact(format, optionsByFormat[format] || {}));
      }
      const result = await downloadBatchImpl(artifacts);
      return {
        ok:result?.accepted !== false,
        cancelled:result?.accepted === false,
        count:result?.count || artifacts.length,
      };
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
