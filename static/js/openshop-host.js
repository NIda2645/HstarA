(function bootstrapOpenShopHost(){
    if(window.HstarOpenShopHost) return;
    const Protocol = window.HstarOpenShopProtocol;
    if(!Protocol) throw new Error('OpenShop protocol must load before the host');

    const HIDDEN_SESSION_IDLE_MS = 15 * 60 * 1000;
    const MAX_IDLE_SESSIONS = 3;
    const state = {
        sessions:new Map(),
        activeScope:'',
        overlay:null,
        status:'idle',
        error:'',
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

    function ui(selector){
        return getOverlay().querySelector?.(selector) || document.querySelector?.(selector) || null;
    }

    function activeSession(){
        return state.sessions.get(state.activeScope) || null;
    }

    function ownerFor(context){
        return {
            canvasType:clean(context?.canvasType),
            canvasId:clean(context?.canvasId),
            nodeId:clean(context?.nodeId),
        };
    }

    function sameContext(left, right){
        try { return Protocol.createProjectScope(left) === Protocol.createProjectScope(right); }
        catch(error) { return false; }
    }

    function normalizedContext(value){
        const context = Protocol.normalizeContext(value);
        if(!Object.values(context).every(Boolean)) throw new Error('OpenShop 节点上下文不完整');
        return {
            ...context,
            frameId:clean(value.frameId) || 'frame-canvas',
            cloneSourceProjectId:clean(value.cloneSourceProjectId),
            projectName:clean(value.projectName) || '图文分层',
            documentWidth:Math.max(1, Number(value.documentWidth || value.width || 1920)),
            documentHeight:Math.max(1, Number(value.documentHeight || value.height || 1080)),
        };
    }

    function setStatus(session, status, message=''){
        if(!session) return;
        session.status = status;
        session.error = status === 'error' ? clean(message) : '';
        session.savePending = status === 'saving';
        if(session.scope !== state.activeScope) return;
        state.status = status;
        state.error = session.error;
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

    function sessionSnapshot(session){
        return {scope:session.scope, sessionId:session.sessionId, context:{...session.context}};
    }

    function stillSession(session, snapshot){
        return Boolean(
            state.sessions.get(snapshot.scope) === session
            && session.sessionId === snapshot.sessionId
            && sameContext(session.context, snapshot.context)
        );
    }

    function postToEditor(session, type, payload={}, requestId=uuid('openshop-host')){
        if(!session?.frame?.contentWindow) return null;
        const envelope = Protocol.createEnvelope({
            type,
            sessionId:session.sessionId,
            requestId,
            context:session.context,
            payload,
        });
        session.frame.contentWindow.postMessage(envelope, window.location.origin);
        return envelope;
    }

    async function responseJson(response){
        let value = {};
        try { value = await response.json(); } catch(error) {}
        if(!response.ok){
            const detail = typeof value?.detail === 'string' ? value.detail : value?.detail?.message;
            throw Object.assign(new Error(detail || `OpenShop 请求失败 (${response.status})`), {
                status:response.status,
                response:value,
            });
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

    async function loadOrCreateProject(session, snapshot){
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
        const initialized = await fetch(`/api/openshop/projects/${encodeURIComponent(projectId)}/initialize`, {
            method:'POST',
            headers:{'Content-Type':'application/json'},
            body:JSON.stringify({
                owner,
                document:{width:context.documentWidth, height:context.documentHeight},
            }),
        });
        return (await responseJson(initialized)).project;
    }

    function sourceVersion(source){
        return clean(source?.assetVersion) || clean(source?.assetId) || clean(source?.url);
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

    async function uploadSource(session, source, snapshot){
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
        const response = await fetch(`/api/openshop/projects/${encodeURIComponent(session.context.projectId)}/assets`, {
            method:'POST', body:form,
        });
        const asset = (await responseJson(response)).asset;
        return {...source, assetId:asset.assetId, url:asset.url, name:source.name || asset.name};
    }

    async function refreshSessionSources(session, sources=session.sources){
        if(Array.isArray(sources)) session.sources = normalizeSources(sources);
        if(!session.editorReady || !session.project) return [];
        const snapshot = sessionSnapshot(session);
        setStatus(session, 'syncing');
        const synchronized = [];
        for(const source of session.sources){
            const existing = projectBindingForSource(session.project, source);
            synchronized.push(existing
                ? {...source, assetId:existing.assetId, assetVersion:existing.assetVersion, url:`/api/openshop/assets/${encodeURIComponent(existing.assetId)}`}
                : await uploadSource(session, source, snapshot));
            if(!stillSession(session, snapshot)) return [];
        }
        postToEditor(session, Protocol.TYPES.SYNC_SOURCES, {sources:synchronized});
        setStatus(session, 'saved');
        return synchronized;
    }

    async function refreshSources(sources, context=null){
        const session = context
            ? state.sessions.get(Protocol.createProjectScope(context))
            : activeSession();
        if(!session) return [];
        return refreshSessionSources(session, Array.isArray(sources) ? sources : session.sources);
    }

    async function bootstrapEditorSession(session){
        if(session.bootstrapping || !session.editorReady) return;
        session.bootstrapping = true;
        const snapshot = sessionSnapshot(session);
        setStatus(session, 'loading');
        try {
            const project = await loadOrCreateProject(session, snapshot);
            if(!stillSession(session, snapshot)) return;
            session.project = project;
            updateTaskSummary(session, project);
            postToEditor(session, Protocol.TYPES.LOAD_PROJECT, {project});
            if(session.scope === state.activeScope) renderSourcePanel(session, project);
            await refreshSessionSources(session);
        } catch(error){
            if(stillSession(session, snapshot)) setStatus(session, 'error', safeError(error));
        } finally {
            if(stillSession(session, snapshot)) session.bootstrapping = false;
        }
    }

    function sendOpenSession(session){
        if(!session.frameLoaded || session.openSent) return;
        session.editorReady = false;
        session.openSent = true;
        postToEditor(session, Protocol.TYPES.OPEN_SESSION, {
            document:{width:session.context.documentWidth, height:session.context.documentHeight},
        }, uuid('openshop-open'));
    }

    function createSession(context, sources){
        const scope = Protocol.createProjectScope(context);
        const frame = document.createElement('iframe');
        frame.className = 'openshop-session-frame';
        frame.dataset.projectScope = scope;
        frame.dataset.projectId = context.projectId;
        frame.title = `图文分层：${clean(context.projectName) || context.projectId}`;
        frame.hidden = true;
        const session = {
            scope,
            frame,
            sessionId:uuid('openshop-session'),
            context:{...context},
            project:null,
            sources:normalizeSources(sources),
            frameLoaded:false,
            editorReady:false,
            openSent:false,
            appliedRequests:new Set(),
            bootstrapping:false,
            status:'loading',
            error:'',
            activeTaskCount:0,
            savePending:false,
            idleSince:0,
        };
        frame.addEventListener?.('load', () => {
            session.frameLoaded = true;
            session.openSent = false;
            sendOpenSession(session);
        });
        state.sessions.set(scope, session);
        getOverlay().appendChild(frame);
        frame.src = '/static/openshop/index.html';
        return session;
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
        const session = activeSession();
        if(session) session.idleSince = Date.now();
    }

    function openNodeSession(contextValue, sources=[]){
        const context = normalizedContext(contextValue);
        const scope = Protocol.createProjectScope(context);
        const previous = activeSession();
        const normalized = normalizeSources(sources);
        let session = state.sessions.get(scope);
        const sourcesChanged = session && JSON.stringify(session.sources) !== JSON.stringify(normalized);
        if(!session) session = createSession(context, normalized);
        else {
            session.context = {...session.context, ...context};
            session.sources = normalized;
            session.frame.title = `图文分层：${context.projectName}`;
        }
        if(previous && previous !== session) previous.idleSince = Date.now();
        state.activeScope = scope;
        state.sessions.forEach(item => { item.frame.hidden = item !== session; });
        session.idleSince = 0;
        ui('[data-openshop-title]').textContent = context.projectName;
        renderSourcePanel(session, session.project);
        showOverlay();
        setStatus(session, session.status || 'loading', session.error);
        if(sourcesChanged && session.editorReady && session.project) void refreshSessionSources(session);
        collectIdleSessions();
        window.lucide?.createIcons?.();
        return getState();
    }

    function pendingSourceUpdates(project){
        return (project?.sourceBindings || []).filter(binding => (
            binding?.state === 'update-available' && clean(binding.pendingAssetId)
        ));
    }

    function sendSourceResolution(session, edgeId, mode, button){
        if(!session || !['replace', 'add', 'ignore'].includes(mode)) return;
        button.disabled = true;
        button.closest?.('.openshop-source-item')?.classList?.add('is-processing');
        postToEditor(session, Protocol.TYPES.RESOLVE_SOURCE_UPDATE, {edgeId, mode});
        setStatus(session, 'dirty');
    }

    function renderSourcePanel(session=activeSession(), project=session?.project){
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
            [
                {label:'替换图层', mode:'replace'},
                {label:'作为新图层加入', mode:'add'},
                {label:'忽略', mode:'ignore'},
            ].forEach(command => {
                const button = document.createElement('button');
                button.type = 'button';
                button.textContent = command.label;
                button.addEventListener('click', () => sendSourceResolution(session, binding.edgeId, command.mode, button));
                actions.appendChild(button);
            });
            item.appendChild(name);
            item.appendChild(meta);
            item.appendChild(actions);
            panel.appendChild(item);
        });
    }

    function generationSummary(project){
        const tasks = Array.isArray(project?.aiTaskRecords) ? project.aiTaskRecords : [];
        const task = [...tasks].reverse().find(item => item?.kind === 'parent');
        return task ? {
            aiStatus:clean(task.status),
            aiTargetCount:Math.max(0, Number(task.targetCount || 0)),
            aiCompletedCount:Math.max(0, Number(task.completedCount || 0)),
            aiFailedCount:Math.max(0, Number(task.failedCount || 0)),
        } : {aiStatus:'', aiTargetCount:0, aiCompletedCount:0, aiFailedCount:0};
    }

    function updateTaskSummary(session, project){
        const tasks = Array.isArray(project?.aiTaskRecords) ? project.aiTaskRecords : [];
        session.activeTaskCount = tasks.filter(task => (
            task?.kind === 'parent' && ['queued', 'running'].includes(clean(task.status))
        )).length;
    }

    function nodeMeta(session, project, saveState=session.status || 'saved'){
        const pending = pendingSourceUpdates(project);
        return {
            projectId:clean(project?.projectId || session.context.projectId),
            projectName:clean(session.context.projectName) || '图文分层',
            previewAssetId:clean(project?.previewAssetId),
            previewUrl:project?.previewAssetId ? `/api/openshop/assets/${encodeURIComponent(project.previewAssetId)}` : '',
            layerCount:Array.isArray(project?.layers) ? project.layers.length : 0,
            sourceUpdateCount:pending.length,
            autosaveVersion:Number(project?.autosaveVersion || 0),
            saveState,
            ...generationSummary(project),
        };
    }

    function originFrame(session){
        return document.getElementById(clean(session?.context?.frameId) || 'frame-canvas');
    }

    function postToOrigin(session, message){
        originFrame(session)?.contentWindow?.postMessage(message, window.location.origin);
    }

    function publishNodeMeta(session, requestId, saveState=session.status){
        if(!session?.project) return;
        postToOrigin(session, {
            type:'hstar-openshop-node-meta',
            requestId,
            context:{
                canvasType:session.context.canvasType,
                canvasId:session.context.canvasId,
                nodeId:session.context.nodeId,
                projectId:session.context.projectId,
            },
            meta:nodeMeta(session, session.project, saveState),
        });
    }

    function openApiSettings(){
        hideOverlay();
        const trigger = document.querySelector?.(`[onclick*="'api-settings'"],[onclick*='"api-settings"']`);
        if(typeof window.switchUI === 'function'){
            window.switchUI(trigger || null, 'api-settings');
            return;
        }
        window.location.href = '/static/api-settings.html';
    }

    async function persistProject(session, envelope){
        const snapshot = sessionSnapshot(session);
        const project = envelope.payload?.project;
        if(!project || clean(project.projectId) !== snapshot.context.projectId){
            throw new Error('保存项目与当前节点不匹配');
        }
        setStatus(session, 'saving');
        const baseVersion = Number(project.autosaveVersion ?? session.project?.autosaveVersion ?? 0);
        const response = await fetch(`/api/openshop/projects/${encodeURIComponent(snapshot.context.projectId)}`, {
            method:'PUT',
            headers:{'Content-Type':'application/json'},
            body:JSON.stringify({owner:ownerFor(snapshot.context), project, base_version:baseVersion}),
        });
        const saved = (await responseJson(response)).project;
        if(!stillSession(session, snapshot)) return null;
        session.project = saved;
        updateTaskSummary(session, saved);
        if(session.scope === state.activeScope) renderSourcePanel(session, saved);
        setStatus(session, 'saved');
        postToEditor(session, Protocol.TYPES.SAVE_CONFIRMED, {project:saved}, envelope.requestId);
        publishNodeMeta(session, envelope.requestId, 'saved');
        if(envelope.payload?.closeAfter && session.scope === state.activeScope) hideOverlay();
        collectIdleSessions();
        return saved;
    }

    function validEditorEvent(event){
        if(event.origin !== window.location.origin) return null;
        const session = [...state.sessions.values()].find(item => event.source === item.frame.contentWindow);
        if(!session) return null;
        const envelope = event.data;
        if(!Protocol.validateEnvelope(envelope).ok) return null;
        if(envelope.sessionId !== session.sessionId) return null;
        if(!sameContext(envelope.context, session.context)) return null;
        return {session, envelope};
    }

    function validOutput(payload){
        const output = {
            assetId:clean(payload?.assetId),
            url:clean(payload?.url),
            name:clean(payload?.name),
            width:Number(payload?.width || 0),
            height:Number(payload?.height || 0),
        };
        if(!output.assetId || !output.url || /^(?:data:image\/|blob:)/i.test(output.url)) return null;
        return output;
    }

    async function onMessage(event){
        const valid = validEditorEvent(event);
        if(!valid) return;
        const {session, envelope} = valid;
        if(envelope.type === Protocol.TYPES.READY){
            session.editorReady = true;
            await bootstrapEditorSession(session);
            return;
        }
        if(session.appliedRequests.has(envelope.requestId)) return;
        session.appliedRequests.add(envelope.requestId);
        try {
            if(envelope.type === Protocol.TYPES.SAVE_PROJECT){
                await persistProject(session, envelope);
            } else if(envelope.type === Protocol.TYPES.PROJECT_CHANGED){
                session.project = envelope.payload?.project || session.project;
                updateTaskSummary(session, session.project);
                if(session.scope === state.activeScope) renderSourcePanel(session, session.project);
                setStatus(session, 'dirty');
                publishNodeMeta(session, envelope.requestId, 'dirty');
            } else if(envelope.type === Protocol.TYPES.SEND_TO_CANVAS){
                const output = validOutput(envelope.payload);
                if(!output) throw new Error('OpenShop 输出资源无效');
                postToOrigin(session, {
                    type:'hstar-openshop-output',
                    requestId:envelope.requestId,
                    context:{...session.context},
                    output,
                });
            } else if(envelope.type === Protocol.TYPES.OPEN_API_SETTINGS){
                if(session.scope === state.activeScope) openApiSettings();
            } else if(envelope.type === Protocol.TYPES.ERROR){
                setStatus(session, 'error', envelope.payload?.message || 'OpenShop 编辑器发生错误');
            }
        } catch(error){
            const message = safeError(error);
            setStatus(session, 'error', message);
            if(envelope.type === Protocol.TYPES.SAVE_PROJECT){
                postToEditor(session, Protocol.TYPES.ERROR, {
                    code:error?.status === 409 ? 'SAVE_CONFLICT' : 'SAVE_FAILED',
                    requestId:envelope.requestId,
                    message,
                }, envelope.requestId);
            }
        }
    }

    function requestSave(options={}){
        const session = activeSession();
        if(!session?.editorReady) return null;
        setStatus(session, 'saving');
        return postToEditor(session, Protocol.TYPES.REQUEST_SAVE, {
            reason:clean(options.reason) || 'manual',
            closeAfter:Boolean(options.closeAfter),
        });
    }

    function requestSendToCanvas(){
        const session = activeSession();
        if(!session?.editorReady) return null;
        return postToEditor(session, Protocol.TYPES.REQUEST_SEND_TO_CANVAS, {});
    }

    function close(){
        hideOverlay();
        collectIdleSessions();
        return null;
    }

    function releaseSession(session, reason='idle-reclaimed'){
        if(!session || !state.sessions.has(session.scope)) return false;
        postToEditor(session, Protocol.TYPES.CLOSE, {reason});
        session.frame.remove?.();
        state.sessions.delete(session.scope);
        if(state.activeScope === session.scope) state.activeScope = '';
        return true;
    }

    function collectIdleSessions(now=Date.now()){
        const overlayOpen = getOverlay().classList.contains('is-open');
        const candidates = [...state.sessions.values()]
            .filter(session => {
                const hidden = session.scope !== state.activeScope || session.frame.hidden || !overlayOpen;
                return hidden
                    && session.activeTaskCount === 0
                    && session.savePending === false
                    && session.status === 'saved'
                    && session.idleSince > 0
                    && now - session.idleSince >= HIDDEN_SESSION_IDLE_MS;
            })
            .sort((left, right) => left.idleSince - right.idleSince);
        const hiddenCount = [...state.sessions.values()].filter(session => session.scope !== state.activeScope || !overlayOpen).length;
        const releaseCount = Math.max(candidates.length, hiddenCount - MAX_IDLE_SESSIONS);
        candidates.slice(0, releaseCount).forEach(session => releaseSession(session));
    }

    async function disposeProject(projectId, contextValue){
        const context = normalizedContext({...contextValue, projectId:clean(projectId) || contextValue?.projectId});
        const scope = Protocol.createProjectScope(context);
        const session = state.sessions.get(scope);
        if(!session) return false;
        await fetch(projectUrl(context.projectId, context), {method:'DELETE'}).catch(() => null);
        const wasActive = state.activeScope === scope;
        releaseSession(session, 'project-deleted');
        if(wasActive) hideOverlay();
        return true;
    }

    function getState(){
        const session = activeSession();
        return {
            activeSession:session ? {sessionId:session.sessionId, context:{...session.context}} : null,
            editorReady:Boolean(session?.editorReady),
            frameLoaded:Boolean(session?.frameLoaded),
            status:session?.status || state.status,
            error:session?.error || state.error,
            autosaveVersion:Number(session?.project?.autosaveVersion || 0),
            sourceUpdateCount:pendingSourceUpdates(session?.project).length,
            sessionCount:state.sessions.size,
            sessions:[...state.sessions.values()].map(item => ({
                scope:item.scope,
                projectId:item.context.projectId,
                status:item.status,
                hidden:Boolean(item.frame.hidden || !getOverlay().classList.contains('is-open')),
                activeTaskCount:item.activeTaskCount,
                savePending:item.savePending,
            })),
        };
    }

    function bindUi(){
        getOverlay();
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
        disposeProject,
        requestSave,
        requestSendToCanvas,
        refreshSources,
        close,
        getState,
    });
})();
