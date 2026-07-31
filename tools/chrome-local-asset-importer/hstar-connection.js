(function attachHstarExtensionConnection(root, factory){
  const api = factory();
  if(typeof module === 'object' && module.exports) module.exports = api;
  root.HstarExtensionConnection = api;
})(typeof globalThis === 'object' ? globalThis : this, function createHstarExtensionConnection(){
  const DEFAULT_ADDRESSES = [
    'http://127.0.0.1:5000',
    'http://127.0.0.1:3000',
  ];

  function normalizeApiBase(value){
    let address = String(value || '').trim();
    if(!address) address = DEFAULT_ADDRESSES[0];
    if(!/^https?:\/\//i.test(address)) address = `http://${address}`;
    try {
      const parsed = new URL(address);
      if(!/^https?:$/.test(parsed.protocol) || !parsed.host) return '';
      return `${parsed.protocol}//${parsed.host}`;
    } catch {
      return '';
    }
  }

  function displayAddress(base){
    try {
      return new URL(base).host;
    } catch {
      return String(base || '').replace(/^https?:\/\//i, '');
    }
  }

  function buildServerCandidates(configuredAddress){
    const candidates = [normalizeApiBase(configuredAddress), ...DEFAULT_ADDRESSES]
      .filter(Boolean);
    return [...new Set(candidates)];
  }

  async function readResponseBody(response){
    const text = await response.text().catch(() => '');
    if(!text) return {text: '', data: null};
    try {
      return {text, data: JSON.parse(text)};
    } catch {
      return {text, data: null};
    }
  }

  function failureMessage(base, kind, status){
    const address = displayAddress(base);
    if(kind === 'unsupported'){
      return `${address} 正在运行，但当前 Hstar 版本不支持浏览器插件连接。`;
    }
    if(kind === 'missing-api'){
      return `${address} 正在运行，但缺少浏览器插件接口。`;
    }
    if(kind === 'unreachable'){
      return `无法访问 ${address}，请确认 Hstar 已启动。`;
    }
    return `${address} 连接失败${status ? `（HTTP ${status}）` : ''}。`;
  }

  async function probeHstarServer(base, fetchImpl = fetch){
    const normalizedBase = normalizeApiBase(base);
    if(!normalizedBase){
      return {
        ok: false,
        base: '',
        kind: 'invalid-address',
        status: 0,
        message: '服务地址格式不正确。',
      };
    }

    let response;
    try {
      response = await fetchImpl(`${normalizedBase}/api/providers`, {cache: 'no-store'});
    } catch (error) {
      return {
        ok: false,
        base: normalizedBase,
        kind: 'unreachable',
        status: 0,
        cause: error,
        message: failureMessage(normalizedBase, 'unreachable', 0),
      };
    }

    const body = await readResponseBody(response);
    if(!response.ok){
      const kind = response.status === 401 || response.status === 403
        ? 'unsupported'
        : (response.status === 404 ? 'missing-api' : 'rejected');
      return {
        ok: false,
        base: normalizedBase,
        kind,
        status: response.status,
        detail: body.data?.detail || body.text,
        message: failureMessage(normalizedBase, kind, response.status),
      };
    }

    if(!body.data || !Array.isArray(body.data.providers)){
      return {
        ok: false,
        base: normalizedBase,
        kind: 'invalid-response',
        status: response.status,
        message: `${displayAddress(normalizedBase)} 返回了无效的 Hstar 服务响应。`,
      };
    }

    return {
      ok: true,
      base: normalizedBase,
      kind: 'connected',
      status: response.status,
      providers: body.data.providers,
      message: `已连接 ${displayAddress(normalizedBase)}。`,
    };
  }

  async function discoverHstarServer({configuredAddress, fetchImpl = fetch} = {}){
    const attempts = [];
    for(const base of buildServerCandidates(configuredAddress)){
      const result = await probeHstarServer(base, fetchImpl);
      if(result.ok) return {...result, attempts};
      attempts.push(result);
    }

    const oldVersion = attempts.find(attempt => attempt.kind === 'unsupported');
    const missingApi = attempts.find(attempt => attempt.kind === 'missing-api');
    let message = '未找到可连接的 Hstar，请先启动 Hstar 后重试。';
    if(oldVersion){
      message = `${displayAddress(oldVersion.base)} 是不支持插件连接的旧版 Hstar。请启动最新版 Hstar，或启动 HstarA 工程版（默认 127.0.0.1:3000）。`;
    } else if(missingApi){
      message = `${displayAddress(missingApi.base)} 缺少浏览器插件接口。请更新 Hstar，或启动 HstarA 工程版（默认 127.0.0.1:3000）。`;
    } else if(attempts.length){
      message = `${attempts.map(attempt => attempt.message).join(' ')} 可先启动 HstarA 工程版（默认 127.0.0.1:3000）后重试。`;
    }

    const error = new Error(message);
    error.code = 'HSTAR_SERVICE_NOT_FOUND';
    error.attempts = attempts;
    throw error;
  }

  return {
    DEFAULT_ADDRESSES,
    buildServerCandidates,
    discoverHstarServer,
    displayAddress,
    normalizeApiBase,
    probeHstarServer,
  };
});
