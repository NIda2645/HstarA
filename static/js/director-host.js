(function(){
    const Protocol = window.HstarDirectorProtocol;
    if(!Protocol) return;

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

    function postToDirector(envelope){
        const frame = getFrame();
        if(!frame) return;
        if(!frame.src) frame.src = frame.dataset.src;
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
            window.switchUI(trigger, 'director-desk');
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
        if(state.activeSession && event.data.sessionId !== state.activeSession.sessionId) return null;
        return event.data;
    }

    async function uploadCapture(capture){
        const dataUrl = String(capture?.dataUrl || '');
        if(!dataUrl.startsWith('data:image/')) throw new Error('Invalid Director capture image');
        const res = await fetch('/api/ai/upload-base64', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                data: dataUrl,
                filename: capture.fileName || `director-capture-${Date.now()}.png`
            })
        });
        if(!res.ok) throw new Error(`Capture upload failed: ${res.status}`);
        const json = await res.json();
        return json.url || json.path || json.file || json.assetUrl;
    }

    async function persistCaptures(captures){
        const uploaded = [];
        for(const capture of captures || []){
            const url = await uploadCapture(capture);
            uploaded.push({
                ...capture,
                url,
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
        if(state.activeSession?.context?.mode === 'standalone'){
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
            const projects = projectsRes.ok ? await projectsRes.json() : [];
            const canvases = canvasesRes.ok ? await canvasesRes.json() : [];
            const projectById = new Map((Array.isArray(projects) ? projects : []).map(project => [project.id, project]));
            const items = Array.isArray(canvases) ? canvases : [];
            list.innerHTML = '';
            items.forEach(canvas => {
                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'director-target-row';
                button.dataset.canvasId = canvas.id;
                button.dataset.canvasType = canvas.type || canvas.canvasType || 'classic';
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

    async function importStandaloneBatchToCanvas(canvasId, canvasType){
        if(!state.pendingStandaloneBatch) return;
        const uploaded = await persistCaptures(state.pendingStandaloneBatch.captures);
        closeTargetPicker();
        const targetFrame = document.getElementById('frame-canvas');
        targetFrame?.contentWindow?.postMessage({
            type: 'hstar-director-standalone-captures',
            requestId: state.pendingStandaloneBatch.envelope.requestId,
            targetCanvasId: canvasId,
            targetCanvasType: canvasType,
            captures: uploaded
        }, window.location.origin);
        state.pendingStandaloneBatch = null;
        const trigger = document.querySelector(`[onclick*="'canvas'"],[onclick*='"canvas"']`);
        if(typeof window.switchUI === 'function') window.switchUI(trigger, 'canvas');
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

    function onPageSwitch(pageId){
        if(pageId === 'director-desk'){
            if(!state.activeSession){
                openStandalone();
            } else {
                sendRenderState(false);
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
