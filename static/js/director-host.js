(function bootstrapDirectorHost(){
    if(window.HstarDirectorHost) return;
    const Protocol = window.HstarDirectorProtocol;
    if(!Protocol) {
        window.addEventListener?.('hstar-director-protocol-ready', bootstrapDirectorHost, { once:true });
        return;
    }

    const state = {
        activeSession: null,
        frame: null,
        ready: false,
        pendingMessages: [],
        originSnapshot: null,
        appliedRequests: new Set(),
        pendingStandaloneBatch: null
    };

    function uuid(prefix){
        if(window.crypto && typeof window.crypto.randomUUID === 'function'){
            try { return `${prefix}-${window.crypto.randomUUID()}`; } catch(e) {}
        }
        return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    }

    function getFrame(){
        if(state.frame && document.contains(state.frame)) return state.frame;
        state.frame = document.getElementById('frame-director-desk');
        return state.frame;
    }

    function directorWindow(){
        const frame = getFrame();
        return frame?.contentWindow || null;
    }

    function sceneInstanceIdForContext(context){
        const fallback = Protocol.createStandaloneSceneKey();
        const value = context?.sceneKey || context?.instanceId || fallback;
        return String(value || fallback).trim() || fallback;
    }

    function directorFrameUrlForContext(context){
        const frame = getFrame();
        const base = frame?.dataset?.src || '/static/3d-director/index.html';
        const instanceId = sceneInstanceIdForContext(context);
        try {
            const url = new URL(base, window.location.origin);
            url.searchParams.set('instanceId', instanceId);
            return `${url.pathname}${url.search}${url.hash}`;
        } catch(e) {
            const separator = base.includes('?') ? '&' : '?';
            return `${base}${separator}instanceId=${encodeURIComponent(instanceId)}`;
        }
    }

    function ensureDirectorFrameForContext(context){
        const frame = getFrame();
        if(!frame) return null;
        const instanceId = sceneInstanceIdForContext(context);
        const nextSrc = directorFrameUrlForContext({...context, sceneKey: instanceId, instanceId});
        if(frame.dataset.directorInstanceId !== instanceId || !frame.src){
            frame.dataset.directorInstanceId = instanceId;
            frame.src = nextSrc;
            state.ready = false;
            state.pendingMessages = [];
        }
        return frame;
    }

    function postToDirector(envelope){
        const frame = ensureDirectorFrameForContext(envelope?.context);
        if(!frame) return;
        const targetWindow = directorWindow();
        if(!targetWindow || !state.ready){
            state.pendingMessages.push(envelope);
            return;
        }
        targetWindow.postMessage(envelope, window.location.origin);
    }

    function flushPending(){
        const targetWindow = directorWindow();
        if(!targetWindow || !state.ready) return;
        const messages = state.pendingMessages.splice(0);
        messages.forEach(message => targetWindow.postMessage(message, window.location.origin));
    }

    function createSession(context, payload){
        const sessionId = uuid('director-session');
        const normalizedContext = {
            mode: context.mode || 'standalone',
            canvasType: context.canvasType,
            canvasId: context.canvasId,
            nodeId: context.nodeId,
            instanceId: context.instanceId,
            sceneKey: context.sceneKey || Protocol.createStandaloneSceneKey()
        };
        state.activeSession = {
            sessionId,
            context: normalizedContext,
            origin: context.origin || null
        };
        state.appliedRequests.clear();
        postToDirector(Protocol.createEnvelope({
            type: Protocol.TYPES.SESSION,
            sessionId,
            requestId: uuid('director-session-open'),
            context: normalizedContext,
            payload: payload || {}
        }));
        return state.activeSession;
    }

    function sendPanorama(panorama){
        if(!state.activeSession || !panorama || !panorama.imageUrl) return;
        postToDirector(Protocol.createEnvelope({
            type: Protocol.TYPES.PANORAMA,
            sessionId: state.activeSession.sessionId,
            requestId: uuid('director-panorama'),
            context: state.activeSession.context,
            payload: panorama
        }));
    }

    function sendRenderState(paused){
        if(!state.activeSession) return;
        postToDirector(Protocol.createEnvelope({
            type: Protocol.TYPES.RENDER_STATE,
            sessionId: state.activeSession.sessionId,
            requestId: uuid('director-render'),
            context: state.activeSession.context,
            payload: { paused: Boolean(paused) }
        }));
    }

    function activeTheme(){
        try {
            return window.StudioTheme ? window.StudioTheme.get() : (localStorage.getItem('studio_theme') || 'light');
        } catch(e) {
            return 'light';
        }
    }

    function switchToDirector(){
        const trigger = document.querySelector(`[onclick*="'director-desk'"],[onclick*='"director-desk"']`);
        if(typeof window.switchUI === 'function') {
            window.switchUI(trigger, 'director-desk', { directorHostSession:true });
        }
    }

    function openStandalone(){
        state.originSnapshot = { pageId: localStorage.getItem('studio_active_page') || 'zimage' };
        createSession({
            mode: 'standalone',
            sceneKey: Protocol.createStandaloneSceneKey()
        }, {
            instanceId: Protocol.createStandaloneSceneKey(),
            theme: activeTheme()
        });
        switchToDirector();
    }

    function openNodeSession(context, panorama){
        const sceneKey = context.sceneKey || Protocol.createSceneKey(context.canvasType, context.canvasId, context.nodeId);
        state.originSnapshot = {
            pageId: 'canvas',
            canvasType: context.canvasType,
            canvasId: context.canvasId,
            nodeId: context.nodeId,
            frameId: context.frameId || null
        };
        createSession({
            ...context,
            mode: 'node',
            sceneKey,
            instanceId: sceneKey
        }, {
            instanceId: sceneKey,
            theme: activeTheme()
        });
        sendPanorama(panorama);
        switchToDirector();
    }

    function returnToOrigin(){
        const origin = state.originSnapshot;
        if(!origin) return;
        const trigger = document.querySelector(`[onclick*="'${origin.pageId}'"],[onclick*='"${origin.pageId}"']`);
        if(typeof window.switchUI === 'function') window.switchUI(trigger, origin.pageId || 'canvas');
    }

    function validDirectorEvent(event){
        if(event.origin !== window.location.origin) return null;
        if(event.source !== directorWindow()) return null;
        const validation = Protocol.validateEnvelope(event.data);
        if(!validation.ok) return null;
        if(state.activeSession && event.data.sessionId !== state.activeSession.sessionId){
            const isBootstrapReady = event.data.type === Protocol.TYPES.READY && event.data.context?.mode === 'standalone';
            if(!isBootstrapReady) return null;
        }
        return event.data;
    }

    async function uploadCapture(capture){
        const dataUrl = String(capture?.dataUrl || '');
        if(!dataUrl.startsWith('data:image/')) throw new Error('Invalid Director capture image');
        const mime = (dataUrl.match(/^data:([^;,]+)/)?.[1] || 'image/png').trim();
        const name = capture.fileName || capture.name || `director-capture-${Date.now()}.png`;
        const res = await fetch('/api/ai/upload-base64', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                data: dataUrl,
                name,
                content_type: mime
            })
        });
        if(!res.ok) throw new Error(`Capture upload failed: ${res.status}`);
        const json = await res.json();
        const file = Array.isArray(json?.files) ? json.files[0] : (json?.file && typeof json.file === 'object' ? json.file : null);
        const url = json.url || json.path || json.assetUrl || json.asset_url || json.fileUrl || json.file_url
            || file?.url || file?.path || file?.assetUrl || file?.asset_url || file?.fileUrl || file?.file_url;
        if(!url) throw new Error('Capture upload missing url');
        return {
            url,
            name: file?.name || name,
            kind: file?.kind || 'image',
            mime: file?.mime || mime
        };
    }

    async function persistCaptures(captures){
        const uploaded = [];
        for(const capture of captures || []){
            const uploadedFile = await uploadCapture(capture);
            uploaded.push({
                ...capture,
                url: uploadedFile.url,
                imageUrl: uploadedFile.url,
                name: capture.name || capture.fileName || uploadedFile.name,
                kind: uploadedFile.kind || capture.kind || 'image',
                mime: uploadedFile.mime || capture.mime || 'image/png',
                dataUrl: undefined
            });
        }
        return uploaded;
    }

    async function handleCapturesSent(envelope){
        if(!state.appliedRequests.has(envelope.requestId)){
            state.appliedRequests.add(envelope.requestId);
        } else {
            return;
        }
        const captures = envelope.payload?.captures || [];
        const sessionContext = state.activeSession?.context || envelope.context || {};
        if(!state.activeSession || sessionContext.mode === 'standalone'){
            state.pendingStandaloneBatch = { envelope, captures };
            await openTargetPicker();
            return;
        }
        const uploaded = await persistCaptures(captures);
        const origin = state.originSnapshot;
        const targetFrame = origin?.frameId ? document.getElementById(origin.frameId) : document.getElementById('frame-canvas');
        targetFrame?.contentWindow?.postMessage({
            type: 'hstar-director-captures',
            requestId: envelope.requestId,
            context: state.activeSession.context,
            captures: uploaded
        }, window.location.origin);
        returnToOrigin();
    }

    function closeTargetPicker(){
        document.getElementById('director-target-picker')?.classList.remove('is-open');
    }

    function normalizeApiList(json, key){
        if(Array.isArray(json)) return json;
        if(Array.isArray(json?.[key])) return json[key];
        if(Array.isArray(json?.data)) return json.data;
        if(Array.isArray(json?.items)) return json.items;
        return [];
    }

    function currentProjectId(){
        try {
            return localStorage.getItem('canvasListCurrentProjectId') || localStorage.getItem('current_project_id') || 'default';
        } catch(e) {
            return 'default';
        }
    }

    function normalizeCanvasType(value){
        const text = String(value || '').trim().toLowerCase();
        return text.includes('smart') ? 'smart' : 'classic';
    }

    function canvasTypeForTarget(canvas){
        return normalizeCanvasType(canvas?.type || canvas?.canvasType || canvas?.kind || canvas?.canvas_type);
    }

    function directorStandaloneHandoffKey(canvasId, canvasType){
        return `hstar-director-standalone-handoff:${normalizeCanvasType(canvasType)}:${String(canvasId || '').trim()}`;
    }

    function storeDirectorStandaloneHandoff(canvasId, canvasType, message){
        const id = String(canvasId || '').trim();
        if(!id || !message) return;
        try {
            const normalizedType = normalizeCanvasType(canvasType);
            sessionStorage.setItem(directorStandaloneHandoffKey(id, normalizedType), JSON.stringify({
                ...message,
                targetCanvasId:id,
                targetCanvasType:normalizedType,
                storedAt:Date.now()
            }));
        } catch(e) {}
    }

    function canvasTargetUrl(canvasId, canvasType, projectId=currentProjectId()){
        const id = encodeURIComponent(canvasId || '');
        const project = encodeURIComponent(projectId || 'default');
        const bust = Date.now();
        return normalizeCanvasType(canvasType) === 'smart'
            ? `/static/smart-canvas.html?id=${id}&project=${project}&v=${bust}`
            : `/static/canvas.html?id=${id}&project=${project}&v=${bust}`;
    }

    function switchToCanvasPage(){
        const trigger = document.querySelector(`[onclick*="'canvas'"],[onclick*='"canvas"']`);
        if(typeof window.switchUI === 'function') window.switchUI(trigger, 'canvas');
    }

    function openCanvasTarget(canvasId, canvasType, message){
        const frame = document.getElementById('frame-canvas');
        if(!frame) throw new Error('无法打开画布窗口');
        const normalizedType = normalizeCanvasType(canvasType);
        storeDirectorStandaloneHandoff(canvasId, normalizedType, message);
        const postImportMessage = () => {
            frame.contentWindow?.postMessage(message, window.location.origin);
        };
        frame.addEventListener('load', postImportMessage, { once:true });
        frame.src = canvasTargetUrl(canvasId, normalizedType);
        switchToCanvasPage();
    }

    async function openTargetPicker(){
        const picker = document.getElementById('director-target-picker');
        const list = document.getElementById('director-target-list');
        if(!picker || !list) return;
        picker.classList.add('is-open');
        list.textContent = '加载中...';
        try {
            const [projectsRes, canvasesRes] = await Promise.all([
                fetch('/api/projects'),
                fetch('/api/canvases')
            ]);
            const projectsJson = projectsRes.ok ? await projectsRes.json() : {};
            const canvasesJson = canvasesRes.ok ? await canvasesRes.json() : {};
            const projects = normalizeApiList(projectsJson, 'projects');
            const items = normalizeApiList(canvasesJson, 'canvases');
            const projectById = new Map(projects.map(project => [project.id, project]));
            list.innerHTML = '';
            items.forEach(canvas => {
                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'director-target-row';
                button.dataset.canvasId = canvas.id;
                button.dataset.canvasType = canvasTypeForTarget(canvas);
                const project = projectById.get(canvas.projectId || canvas.project_id);
                button.innerHTML = `<span class="director-target-row-title"></span><span class="director-target-row-meta"></span>`;
                button.querySelector('.director-target-row-title').textContent = canvas.name || canvas.title || '未命名画布';
                button.querySelector('.director-target-row-meta').textContent = `${project?.name || '当前项目'} · ${button.dataset.canvasType === 'smart' ? '智能画布' : '普通画布'}`;
                button.addEventListener('click', () => importStandaloneBatchToCanvas(button.dataset.canvasId, button.dataset.canvasType));
                list.appendChild(button);
            });
            if(!items.length) list.textContent = '暂无已有画布';
        } catch(error) {
            list.textContent = error instanceof Error ? error.message : '加载画布列表失败';
        }
    }

    async function createStandaloneTargetCanvas(){
        const input = document.getElementById('director-target-new-name');
        const select = document.getElementById('director-target-new-type');
        const name = String(input?.value || '').trim() || `3D导演台 ${new Date().toLocaleString()}`;
        const kind = select?.value === 'smart' ? 'smart' : 'classic';
        const res = await fetch('/api/canvases', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                title: name,
                icon: '🎬',
                kind,
                project: currentProjectId()
            })
        });
        if(!res.ok) throw new Error(`新建画布失败：${res.status}`);
        const json = await res.json();
        const created = json.canvas || json.detail?.canvas || json;
        if(!created?.id) throw new Error('新建画布失败：未返回画布 ID');
        await importStandaloneBatchToCanvas(created.id, created.kind || created.type || kind);
    }

    async function importStandaloneBatchToCanvas(canvasId, canvasType){
        if(!state.pendingStandaloneBatch) return;
        const uploaded = await persistCaptures(state.pendingStandaloneBatch.captures);
        closeTargetPicker();
        const message = {
            type: 'hstar-director-standalone-captures',
            requestId: state.pendingStandaloneBatch.envelope.requestId,
            targetCanvasId: canvasId,
            targetCanvasType: canvasType,
            captures: uploaded
        };
        openCanvasTarget(canvasId, canvasType, message);
        state.pendingStandaloneBatch = null;
    }

    function onMessage(event){
        const envelope = validDirectorEvent(event);
        if(!envelope) return;
        if(envelope.type === Protocol.TYPES.READY){
            state.ready = true;
            flushPending();
            return;
        }
        if(envelope.type === Protocol.TYPES.CLOSE){
            sendRenderState(true);
            returnToOrigin();
            return;
        }
        if(envelope.type === Protocol.TYPES.CAPTURES_SENT){
            handleCapturesSent(envelope).catch(error => {
                console.error('[HstarDirectorHost] capture import failed', error);
            });
            return;
        }
        if(envelope.type === Protocol.TYPES.PICK_TARGET){
            openTargetPicker();
        }
    }

    function onPageSwitch(pageId, _target, options={}){
        if(pageId === 'director-desk'){
            if(options?.directorHostSession){
                if(!state.activeSession) openStandalone();
                else sendRenderState(false);
            } else {
                openStandalone();
            }
            return;
        }
        if(state.activeSession) sendRenderState(true);
    }

    function initPicker(){
        if(document.getElementById('director-target-picker')) return;
        const picker = document.createElement('div');
        picker.id = 'director-target-picker';
        picker.className = 'director-target-picker';
        picker.innerHTML = `
            <div class="director-target-panel" role="dialog" aria-label="发送到画布">
                <div class="director-target-head">
                    <h2 class="director-target-title">发送到画布</h2>
                    <button class="director-target-close" type="button" aria-label="关闭">×</button>
                </div>
                <div class="director-target-new">
                    <input class="director-target-input" id="director-target-new-name" placeholder="新建画布名称" />
                    <select class="director-target-select" id="director-target-new-type">
                        <option value="classic">普通画布</option>
                        <option value="smart">智能画布</option>
                    </select>
                    <button class="director-target-button" id="director-target-create" type="button">新建画布</button>
                </div>
                <div class="director-target-list" id="director-target-list"></div>
            </div>`;
        picker.querySelector('.director-target-close')?.addEventListener('click', closeTargetPicker);
        picker.addEventListener('click', event => {
            if(event.target === picker) closeTargetPicker();
        });
        picker.querySelector('#director-target-create')?.addEventListener('click', event => {
            event.preventDefault();
            createStandaloneTargetCanvas().catch(error => {
                const list = document.getElementById('director-target-list');
                if(list) list.textContent = error instanceof Error ? error.message : '新建画布失败';
            });
        });
        document.body.appendChild(picker);
    }

    window.addEventListener('message', onMessage);
    document.addEventListener('DOMContentLoaded', initPicker, { once:true });

    window.HstarDirectorHost = {
        openStandalone,
        openNodeSession,
        onPageSwitch,
        sendPanorama,
        openTargetPicker,
        closeTargetPicker
    };
})();
