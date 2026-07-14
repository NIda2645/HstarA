(function bootstrapOpenShopHost(){
    if(window.HstarOpenShopHost) return;
    const Protocol = window.HstarOpenShopProtocol;
    if(!Protocol) throw new Error('OpenShop protocol must load before the host');

    const state = {
        activeSession: null,
        frame: null,
        overlay: null,
        frameLoaded: false,
        editorReady: false,
        project: null,
        sources: [],
        appliedRequests: new Set(),
        bootstrapping: false,
        status: 'idle',
        error: '',
    };

    function uuid(prefix){
        if(window.crypto && typeof window.crypto.randomUUID === 'function'){
            try { return `${prefix}-${window.crypto.randomUUID()}`; } catch(error) {}
        }
        return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    }

    function clean(value){
        return String(value || '').trim();
    }

    function safeError(error){
        return clean(error?.message || error || 'OpenShop 请求失败')
            .replace(/[\u0000-\u001f\u007f]/g, ' ')
            .replace(/\s+/g, ' ')
            .slice(0, 300) || 'OpenShop 请求失败';
    }

    function createHostMarkup(){
        const section = document.createElement('section');
        section.id = 'openshop-host';
        section.className = 'openshop-host';
        section.setAttribute('aria-hidden', 'true');
        section.innerHTML = `
            <header class="openshop-host-bar">
                <button class="openshop-host-command" data-openshop-back type="button" title="返回画布">
                    <i data-lucide="arrow-left"></i><span>返回画布</span>
                </button>
                <strong class="openshop-host-title" data-openshop-title>图文分层</strong>
                <span class="openshop-host-state" data-openshop-state>未保存</span>
                <span class="openshop-host-spacer"></span>
                <button class="openshop-host-command" data-openshop-sources type="button" disabled>来源更新</button>
                <button class="openshop-host-command" data-openshop-save type="button">
                    <i data-lucide="save"></i><span>保存</span>
                </button>
                <button class="openshop-host-command openshop-host-primary" data-openshop-send type="button">
                    <i data-lucide="send"></i><span>发送到画布</span>
                </button>
            </header>
            <iframe id="frame-openshop" title="图文分层编辑器" data-src="/static/openshop/index.html"></iframe>
            <aside class="openshop-source-panel" data-openshop-source-panel aria-hidden="true"></aside>`;
        const stage = document.querySelector?.('.stage');
        (stage || document.body).appendChild(section);
        return section;
    }

    function getOverlay(){
        if(state.overlay && document.contains?.(state.overlay)) return state.overlay;
        state.overlay = document.getElementById('openshop-host') || createHostMarkup();
        return state.overlay;
    }

    function getFrame(){
        if(state.frame && document.contains?.(state.frame)) return state.frame;
        state.frame = document.getElementById('frame-openshop') || getOverlay().querySelector?.('#frame-openshop');
        return state.frame;
    }

    function ui(selector){
        return getOverlay().querySelector?.(selector) || document.querySelector?.(selector) || null;
    }

    function setStatus(status, message = ''){
        state.status = status;
        state.error = status === 'error' ? clean(message) : '';
        const label = ui('[data-openshop-state]');
        if(!label) return;
        const labels = {
            loading:'正在加载', syncing:'正在同步来源', dirty:'未保存',
            saving:'正在保存', saved:'已保存', error:message || '保存失败', idle:'未保存',
        };
        label.textContent = labels[status] || message || status;
        label.dataset.state = status;
        label.title = status === 'error' ? clean(message) : '';
    }

    function ownerFor(context = state.activeSession?.context){
        return {
            canvasType:clean(context?.canvasType),
            canvasId:clean(context?.canvasId),
            nodeId:clean(context?.nodeId),
        };
    }

    function sameContext(left, right){
        try {
            return Protocol.createProjectScope(left) === Protocol.createProjectScope(right);
        } catch(error) {
            return false;
        }
    }

    function activeSnapshot(){
        if(!state.activeSession) throw new Error('OpenShop 会话尚未打开');
        return {
            sessionId:state.activeSession.sessionId,
            context:{...state.activeSession.context},
        };
    }

    function stillActive(snapshot){
        return Boolean(
            state.activeSession
            && state.activeSession.sessionId === snapshot.sessionId
            && sameContext(state.activeSession.context, snapshot.context)
        );
    }

    function postToEditor(type, payload = {}, requestId = uuid('openshop-host')){
        if(!state.activeSession) return null;
        const frameWindow = getFrame()?.contentWindow;
        if(!frameWindow) return null;
        const envelope = Protocol.createEnvelope({
            type,
            sessionId:state.activeSession.sessionId,
            requestId,
            context:state.activeSession.context,
            payload,
        });
        frameWindow.postMessage(envelope, window.location.origin);
        return envelope;
    }

    async function responseJson(response){
        let value = {};
        try { value = await response.json(); } catch(error) {}
        if(!response.ok){
            const detail = typeof value?.detail === 'string' ? value.detail : value?.detail?.message;
            throw Object.assign(new Error(detail || `OpenShop 请求失败 (${response.status})`), {status:response.status, response:value});
        }
        return value;
    }

    function projectUrl(projectId, context){
        const params = new URLSearchParams({
            canvas_type:context.canvasType,
            canvas_id:context.canvasId,
            node_id:context.nodeId,
        });
        return `/api/openshop/projects/${encodeURIComponent(projectId)}?${params}`;
    }

    async function loadOrCreateProject(snapshot){
        const context = snapshot.context;
        const owner = ownerFor(context);
        const projectId = context.projectId;
        if(context.cloneSourceProjectId){
            const cloned = await fetch(`/api/openshop/projects/${encodeURIComponent(projectId)}/clone`, {
                method:'POST',
                headers:{'Content-Type':'application/json'},
                body:JSON.stringify({source_project_id:context.cloneSourceProjectId, owner}),
            });
            return (await responseJson(cloned)).project;
        }
        const loaded = await fetch(projectUrl(projectId, context));
        if(loaded.status !== 404) return (await responseJson(loaded)).project;
        const width = Math.max(1, Math.round(Number(context.documentWidth || context.width || 1920)));
        const height = Math.max(1, Math.round(Number(context.documentHeight || context.height || 1080)));
        const initialized = await fetch(`/api/openshop/projects/${encodeURIComponent(projectId)}/initialize`, {
            method:'POST',
            headers:{'Content-Type':'application/json'},
            body:JSON.stringify({owner, document:{width, height}}),
        });
        return (await responseJson(initialized)).project;
    }

    function sourceVersion(source){
        return clean(source?.assetVersion) || clean(source?.assetId) || clean(source?.url);
    }

    function projectBindingForSource(project, source){
        const matching = (project?.sourceBindings || []).filter(binding => clean(binding?.edgeId) === source.edgeId);
        const active = matching.find(binding => binding.state !== 'detached') || matching.at(-1);
        if(!active) return null;
        const version = sourceVersion(source);
        if(clean(active.pendingAssetId) && clean(active.pendingAssetVersion) === version){
            return {assetId:clean(active.pendingAssetId), assetVersion:version};
        }
        if(clean(active.assetId) && sourceVersion(active) === version){
            return {assetId:clean(active.assetId), assetVersion:version};
        }
        return null;
    }

    async function uploadSource(source, snapshot){
        if(source.assetId && /^\/api\/openshop\/assets\//.test(source.url)){
            return {...source, assetId:clean(source.assetId)};
        }
        const imageResponse = await fetch(source.url);
        if(!imageResponse.ok) throw new Error(`无法读取来源图片：${source.name}`);
        const blob = await imageResponse.blob();
        if(!blob?.size || !clean(blob.type).startsWith('image/')) throw new Error(`来源图片格式无效：${source.name}`);
        const form = new FormData();
        const owner = ownerFor(snapshot.context);
        form.append('canvas_type', owner.canvasType);
        form.append('canvas_id', owner.canvasId);
        form.append('node_id', owner.nodeId);
        form.append('role', 'source');
        form.append('file', blob, source.name || `source-${source.sequence + 1}.png`);
        const response = await fetch(`/api/openshop/projects/${encodeURIComponent(snapshot.context.projectId)}/assets`, {
            method:'POST', body:form,
        });
        const asset = (await responseJson(response)).asset;
        return {...source, assetId:asset.assetId, url:asset.url, name:source.name || asset.name};
    }

    function normalizeSources(sources){
        return (Array.isArray(sources) ? sources : []).map((source, index) => ({
            edgeId:clean(source?.edgeId),
            sourceNodeId:clean(source?.sourceNodeId),
            assetId:clean(source?.assetId),
            assetVersion:sourceVersion(source),
            name:clean(source?.name) || `来源图片 ${index + 1}`,
            url:clean(source?.url),
            sequence:Number.isInteger(Number(source?.sequence)) ? Number(source.sequence) : index,
        })).filter(source => source.edgeId && source.sourceNodeId && source.url)
            .sort((left, right) => left.sequence - right.sequence || left.edgeId.localeCompare(right.edgeId));
    }

    async function refreshSources(sources = state.sources){
        if(Array.isArray(sources)) state.sources = normalizeSources(sources);
        if(!state.activeSession || !state.editorReady || !state.project) return [];
        const snapshot = activeSnapshot();
        setStatus('syncing');
        const synchronized = [];
        for(const source of state.sources){
            const existing = projectBindingForSource(state.project, source);
            synchronized.push(existing
                ? {...source, assetId:existing.assetId, assetVersion:existing.assetVersion, url:`/api/openshop/assets/${encodeURIComponent(existing.assetId)}`}
                : await uploadSource(source, snapshot));
            if(!stillActive(snapshot)) return [];
        }
        postToEditor(Protocol.TYPES.SYNC_SOURCES, {sources:synchronized});
        setStatus('saved');
        return synchronized;
    }

    async function bootstrapEditorSession(){
        if(state.bootstrapping || !state.activeSession || !state.editorReady) return;
        state.bootstrapping = true;
        const snapshot = activeSnapshot();
        setStatus('loading');
        try {
            const project = await loadOrCreateProject(snapshot);
            if(!stillActive(snapshot)) return;
            state.project = project;
            postToEditor(Protocol.TYPES.LOAD_PROJECT, {project});
            renderSourcePanel(project);
            await refreshSources();
        } catch(error){
            if(stillActive(snapshot)) setStatus('error', safeError(error));
        } finally {
            if(stillActive(snapshot)) state.bootstrapping = false;
        }
    }

    function sendOpenSession(){
        if(!state.activeSession || !state.frameLoaded) return;
        state.editorReady = false;
        postToEditor(Protocol.TYPES.OPEN_SESSION, {
            document:{
                width:Number(state.activeSession.context.documentWidth || 1920),
                height:Number(state.activeSession.context.documentHeight || 1080),
            },
        }, uuid('openshop-open'));
    }

    function onFrameLoad(){
        state.frameLoaded = true;
        sendOpenSession();
    }

    function showOverlay(){
        const overlay = getOverlay();
        overlay.classList.add('is-open');
        overlay.setAttribute('aria-hidden', 'false');
    }

    function hideOverlay(){
        const overlay = getOverlay();
        overlay.classList.remove('is-open');
        overlay.setAttribute('aria-hidden', 'true');
        ui('[data-openshop-source-panel]')?.classList?.remove('is-open');
    }

    function openNodeSession(context, sources = []){
        const normalized = Protocol.normalizeContext(context);
        if(!Object.values(normalized).every(Boolean)) throw new Error('OpenShop 节点上下文不完整');
        normalized.frameId = clean(context.frameId) || 'frame-canvas';
        normalized.cloneSourceProjectId = clean(context.cloneSourceProjectId);
        normalized.projectName = clean(context.projectName) || '图文分层';
        normalized.documentWidth = Number(context.documentWidth || context.width || 1920);
        normalized.documentHeight = Number(context.documentHeight || context.height || 1080);
        state.activeSession = {sessionId:uuid('openshop-session'), context:normalized};
        state.sources = normalizeSources(sources);
        state.project = null;
        state.editorReady = false;
        state.appliedRequests.clear();
        state.bootstrapping = false;
        ui('[data-openshop-title]').textContent = normalized.projectName;
        renderSourcePanel(null);
        showOverlay();
        setStatus('loading');
        const frame = getFrame();
        const source = frame?.dataset?.src || '/static/openshop/index.html';
        if(frame && !frame.src){
            state.frameLoaded = false;
            frame.src = source;
        } else if(state.frameLoaded){
            sendOpenSession();
        }
        window.lucide?.createIcons?.();
        return getState();
    }

    function pendingSourceUpdates(project = state.project){
        return (project?.sourceBindings || []).filter(binding => (
            binding?.state === 'update-available' && clean(binding.pendingAssetId)
        ));
    }

    function sendSourceResolution(edgeId, mode, button){
        if(!['replace', 'add', 'ignore'].includes(mode)) return;
        button.disabled = true;
        button.closest?.('.openshop-source-item')?.classList?.add('is-processing');
        postToEditor(Protocol.TYPES.RESOLVE_SOURCE_UPDATE, {edgeId, mode});
        setStatus('dirty');
    }

    function renderSourcePanel(project = state.project){
        const panel = ui('[data-openshop-source-panel]');
        const trigger = ui('[data-openshop-sources]');
        if(!panel || !trigger) return;
        const pending = pendingSourceUpdates(project);
        trigger.disabled = pending.length === 0;
        trigger.textContent = pending.length ? `来源更新 ${pending.length}` : '来源更新';
        panel.innerHTML = '';
        if(!pending.length){
            const empty = document.createElement('p');
            empty.className = 'openshop-source-empty';
            empty.textContent = '当前没有待处理的来源更新';
            panel.appendChild(empty);
            return;
        }
        const heading = document.createElement('div');
        heading.className = 'openshop-source-panel-head';
        heading.textContent = '来源更新';
        panel.appendChild(heading);
        pending.forEach(binding => {
            const item = document.createElement('article');
            item.className = 'openshop-source-item';
            const name = document.createElement('strong');
            name.textContent = `来源 ${clean(binding.sourceNodeId) || clean(binding.edgeId)}`;
            const meta = document.createElement('span');
            meta.textContent = `${clean(binding.assetVersion) || '旧版本'} → ${clean(binding.pendingAssetVersion) || '新版本'}`;
            const actions = document.createElement('div');
            actions.className = 'openshop-source-actions';
            const commands = [
                {label:'替换图层', mode:'replace'},
                {label:'作为新图层加入', mode:'add'},
                {label:'忽略', mode:'ignore'},
            ];
            commands.forEach(command => {
                const button = document.createElement('button');
                button.type = 'button';
                button.textContent = command.label;
                button.addEventListener('click', () => sendSourceResolution(binding.edgeId, command.mode, button));
                actions.appendChild(button);
            });
            item.appendChild(name); item.appendChild(meta); item.appendChild(actions);
            panel.appendChild(item);
        });
    }

    function nodeMeta(project, saveState = 'saved'){
        const pending = pendingSourceUpdates(project);
        return {
            projectId:clean(project?.projectId),
            projectName:clean(state.activeSession?.context?.projectName) || '图文分层',
            previewAssetId:clean(project?.previewAssetId),
            previewUrl:project?.previewAssetId ? `/api/openshop/assets/${encodeURIComponent(project.previewAssetId)}` : '',
            layerCount:Array.isArray(project?.layers) ? project.layers.length : 0,
            sourceUpdateCount:pending.length,
            autosaveVersion:Number(project?.autosaveVersion || 0),
            saveState,
        };
    }

    function originFrame(){
        const frameId = clean(state.activeSession?.context?.frameId) || 'frame-canvas';
        return document.getElementById(frameId);
    }

    function postToOrigin(message){
        originFrame()?.contentWindow?.postMessage(message, window.location.origin);
    }

    async function persistProject(envelope){
        const snapshot = activeSnapshot();
        const project = envelope.payload?.project;
        if(!project || clean(project.projectId) !== snapshot.context.projectId) throw new Error('保存项目与当前节点不匹配');
        setStatus('saving');
        const baseVersion = Number(project.autosaveVersion ?? state.project?.autosaveVersion ?? 0);
        const response = await fetch(`/api/openshop/projects/${encodeURIComponent(snapshot.context.projectId)}`, {
            method:'PUT',
            headers:{'Content-Type':'application/json'},
            body:JSON.stringify({owner:ownerFor(snapshot.context), project, base_version:baseVersion}),
        });
        if(response.status === 409){
            const conflict = await responseJson(response).catch(error => { throw error; });
            return conflict;
        }
        const saved = (await responseJson(response)).project;
        if(!stillActive(snapshot)) return null;
        state.project = saved;
        renderSourcePanel(saved);
        setStatus('saved');
        postToEditor(Protocol.TYPES.SAVE_CONFIRMED, {project:saved}, envelope.requestId);
        postToOrigin({
            type:'hstar-openshop-node-meta',
            requestId:envelope.requestId,
            context:{...snapshot.context},
            meta:nodeMeta(saved),
        });
        if(envelope.payload?.closeAfter) hideOverlay();
        return saved;
    }

    function validEditorEvent(event){
        if(event.origin !== window.location.origin) return null;
        if(event.source !== getFrame()?.contentWindow) return null;
        const envelope = event.data;
        if(!Protocol.validateEnvelope(envelope).ok) return null;
        if(!state.activeSession) return null;
        if(envelope.sessionId !== state.activeSession.sessionId) return null;
        if(!sameContext(envelope.context, state.activeSession.context)) return null;
        return envelope;
    }

    function validOutput(payload){
        const output = {
            assetId:clean(payload?.assetId), url:clean(payload?.url), name:clean(payload?.name),
            width:Number(payload?.width || 0), height:Number(payload?.height || 0),
        };
        if(!output.assetId || !output.url || /^(?:data:image\/|blob:)/i.test(output.url)) return null;
        return output;
    }

    async function onMessage(event){
        const envelope = validEditorEvent(event);
        if(!envelope) return;
        if(envelope.type === Protocol.TYPES.READY){
            state.editorReady = true;
            await bootstrapEditorSession();
            return;
        }
        if(state.appliedRequests.has(envelope.requestId)) return;
        state.appliedRequests.add(envelope.requestId);
        try {
            if(envelope.type === Protocol.TYPES.SAVE_PROJECT){
                await persistProject(envelope);
            } else if(envelope.type === Protocol.TYPES.PROJECT_CHANGED){
                state.project = envelope.payload?.project || state.project;
                renderSourcePanel(state.project);
                setStatus('dirty');
            } else if(envelope.type === Protocol.TYPES.SEND_TO_CANVAS){
                const output = validOutput(envelope.payload);
                if(!output) throw new Error('OpenShop 输出资源无效');
                postToOrigin({
                    type:'hstar-openshop-output', requestId:envelope.requestId,
                    context:{...state.activeSession.context}, output,
                });
            } else if(envelope.type === Protocol.TYPES.ERROR){
                setStatus('error', envelope.payload?.message || 'OpenShop 编辑器发生错误');
            }
        } catch(error){
            const message = safeError(error);
            setStatus('error', message);
            if(envelope.type === Protocol.TYPES.SAVE_PROJECT){
                postToEditor(Protocol.TYPES.ERROR, {
                    code:error?.status === 409 ? 'SAVE_CONFLICT' : 'SAVE_FAILED',
                    requestId:envelope.requestId,
                    message,
                }, envelope.requestId);
            }
        }
    }

    function requestSave(options = {}){
        if(!state.activeSession || !state.editorReady) return null;
        setStatus('saving');
        return postToEditor(Protocol.TYPES.REQUEST_SAVE, {
            reason:clean(options.reason) || 'manual',
            closeAfter:Boolean(options.closeAfter),
        });
    }

    function requestSendToCanvas(){
        if(!state.activeSession || !state.editorReady) return null;
        return postToEditor(Protocol.TYPES.REQUEST_SEND_TO_CANVAS, {});
    }

    function close(options = {}){
        if(options.force){ hideOverlay(); return null; }
        return requestSave({reason:'close', closeAfter:true});
    }

    function getState(){
        return {
            activeSession:state.activeSession ? {
                sessionId:state.activeSession.sessionId,
                context:{...state.activeSession.context},
            } : null,
            editorReady:state.editorReady,
            frameLoaded:state.frameLoaded,
            status:state.status,
            error:state.error,
            autosaveVersion:Number(state.project?.autosaveVersion || 0),
            sourceUpdateCount:pendingSourceUpdates().length,
        };
    }

    function bindUi(){
        getOverlay();
        const frame = getFrame();
        frame?.addEventListener?.('load', onFrameLoad);
        ui('[data-openshop-back]')?.addEventListener?.('click', () => close());
        ui('[data-openshop-save]')?.addEventListener?.('click', () => requestSave());
        ui('[data-openshop-send]')?.addEventListener?.('click', requestSendToCanvas);
        ui('[data-openshop-sources]')?.addEventListener?.('click', () => {
            const panel = ui('[data-openshop-source-panel]');
            const opened = !panel?.classList?.contains('is-open');
            panel?.classList?.toggle('is-open', opened);
            panel?.setAttribute?.('aria-hidden', String(!opened));
        });
        window.lucide?.createIcons?.();
    }

    window.addEventListener('message', event => { void onMessage(event); });
    if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bindUi, {once:true});
    else bindUi();

    window.HstarOpenShopHost = Object.freeze({
        openNodeSession,
        requestSave,
        requestSendToCanvas,
        refreshSources,
        close,
        getState,
    });
})();
