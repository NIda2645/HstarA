(function bootstrapOpenShopHost(){
    if(window.HstarOpenShopHost) return;
    const Protocol = window.HstarOpenShopProtocol;
    if(!Protocol) throw new Error('OpenShop protocol must load before the host');

    const HIDDEN_SESSION_IDLE_MS = 15 * 60 * 1000;
    const MAX_IDLE_SESSIONS = 3;
    const OPENSHOP_RUNTIME_REVISION = '2026.07.25.1245000000003';
    const AI_LOG_TOOL_IDS = new Set(['art-font-restore', 'generative-fill', 'local-redraw']);
    const state = {
        sessions:new Map(),
        activeScope:'',
        overlay:null,
        status:'idle',
        error:'',
    };
    let noticeTimer = 0;

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
        const message = clean(error?.message || error || 'OpenShop 请求失败')
            .replace(/[\u0000-\u001f\u007f]/g, ' ')
            .replace(/\s+/g, ' ')
            .slice(0, 300) || 'OpenShop 请求失败';
        if(/OCR model did not return reliable text positions|OCR block has no reliable position/i.test(message)){
            return 'OCR 模型没有返回可靠的文字位置，请重新执行文字提取';
        }
        if(/^OpenShop request failed$/i.test(message)) return 'OpenShop 请求失败';
        if(/^OpenShop save was rejected$/i.test(message)) return 'OpenShop 保存被拒绝';
        return message;
    }

    function isOcrToolError(error){
        return /OCR model did not return reliable text positions|OCR block has no reliable position|OCR 模型没有返回可靠的文字位置|OCR 文字块没有可靠位置/i
            .test(clean(error?.message || error));
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
                <button class="openshop-host-command" data-openshop-download type="button" disabled>
                    <i data-lucide="download"></i><span>下载到本地</span>
                </button>
                <button class="openshop-host-command openshop-host-primary" data-openshop-send type="button">
                    <i data-lucide="send"></i><span>发送到画布</span>
                </button>
            </header>
            <div class="openshop-host-notice" data-openshop-notice role="status" aria-live="polite" hidden></div>
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

    function canvasPageIsActive(){
        const canvasFrame = document.getElementById('frame-canvas');
        return !canvasFrame || canvasFrame.classList.contains('active');
    }

    function syncPageVisibility(){
        const overlay = state.overlay || document.getElementById('openshop-host');
        if(!overlay) return;
        const pageHidden = !canvasPageIsActive();
        const overlayOpen = overlay.classList.contains('is-open');
        const overlayHidden = pageHidden || !overlayOpen;
        overlay.hidden = overlayHidden;
        overlay.setAttribute('aria-hidden', String(overlayHidden));
        state.sessions.forEach(session => {
            if(!session.frameLoaded || !session.openSent) return;
            const visible = Boolean(
                !pageHidden
                && overlayOpen
                && session.scope === state.activeScope
                && !session.frame.hidden
            );
            if(session.pollingVisible === visible) return;
            session.pollingVisible = visible;
            postToEditor(session, Protocol.TYPES.SESSION_VISIBILITY, {visible}, uuid('openshop-visibility'));
        });
    }

    function hookPageSwitch(){
        const current = window.switchUI;
        if(typeof current !== 'function' || current.__hstarOpenShopVisibilityHook){
            syncPageVisibility();
            return;
        }
        const wrapped = function hstarOpenShopPageSwitch(...args){
            try {
                return current.apply(this, args);
            } finally {
                syncPageVisibility();
            }
        };
        Object.defineProperty(wrapped, '__hstarOpenShopVisibilityHook', {value:true});
        window.switchUI = wrapped;
        syncPageVisibility();
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
        const cloneSourceProjectId = clean(value.cloneSourceProjectId);
        const cloneSourceCanvasType = clean(value.cloneSourceCanvasType);
        const cloneSourceCanvasId = clean(value.cloneSourceCanvasId);
        const cloneSourceNodeId = clean(value.cloneSourceNodeId);
        const cloneSourceContext = [
            cloneSourceProjectId,
            cloneSourceCanvasType,
            cloneSourceCanvasId,
            cloneSourceNodeId,
        ];
        if(cloneSourceContext.some(Boolean) && !cloneSourceContext.every(Boolean)){
            throw new Error('OpenShop clone source context is incomplete');
        }
        return {
            ...context,
            frameId:clean(value.frameId) || 'frame-canvas',
            cloneSourceProjectId,
            cloneSourceCanvasType,
            cloneSourceCanvasId,
            cloneSourceNodeId,
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

    function showNotice(message, kind='success'){
        const notice = ui('[data-openshop-notice]');
        if(!notice) return;
        window.clearTimeout(noticeTimer);
        notice.textContent = clean(message);
        notice.dataset.kind = kind;
        notice.hidden = !notice.textContent;
        noticeTimer = window.setTimeout(() => {
            notice.hidden = true;
            notice.textContent = '';
        }, 2200);
    }

    function syncDownloadButton(session=activeSession()){
        const button = ui('[data-openshop-download]');
        if(button) button.disabled = !session?.editorReady || Boolean(session.downloadRequestId);
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
                body:JSON.stringify({
                    source_project_id:context.cloneSourceProjectId,
                    source_owner:{
                        canvasType:context.cloneSourceCanvasType,
                        canvasId:context.cloneSourceCanvasId,
                        nodeId:context.cloneSourceNodeId,
                    },
                    owner,
                }),
            });
            const project = (await responseJson(cloned)).project;
            session.context.cloneSourceProjectId = '';
            session.context.cloneSourceCanvasType = '';
            session.context.cloneSourceCanvasId = '';
            session.context.cloneSourceNodeId = '';
            return project;
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
            entryMode:session.entryMode,
        }, uuid('openshop-open'));
    }

    function createSession(context, sources){
        const scope = Protocol.createProjectScope(context);
        const sessionSources = normalizeSources(sources);
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
            sources:sessionSources,
            entryMode:sessionSources.length ? 'workspace' : 'welcome',
            viewReady:false,
            frameLoaded:false,
            editorReady:false,
            openSent:false,
            appliedRequests:new Set(),
            bootstrapping:false,
            status:'loading',
            error:'',
            activeTaskCount:0,
            pollingVisible:null,
            savePending:false,
            downloadRequestId:'',
            pendingCanvasOutputs:new Map(),
            publishedAiTaskLogs:new Set(),
            idleSince:0,
        };
        frame.addEventListener?.('load', () => {
            session.frameLoaded = true;
            session.openSent = false;
            sendOpenSession(session);
            syncPageVisibility();
        });
        state.sessions.set(scope, session);
        getOverlay().appendChild(frame);
        frame.src = `/static/openshop/index.html?v=${OPENSHOP_RUNTIME_REVISION}`;
        return session;
    }

    function fitRevealedWorkspace(session){
        window.setTimeout(() => {
            if(
                session.scope !== state.activeScope
                || session.frame.hidden
                || !getOverlay().classList.contains('is-open')
            ) return;
            postToEditor(session, Protocol.TYPES.FIT_WORKSPACE, {}, uuid('openshop-fit'));
        }, 0);
    }

    function revealSessionFrame(session, reason){
        const readyReason = session.entryMode === 'workspace' ? 'sources-synchronized' : 'project-loaded';
        if(reason !== readyReason) return false;
        session.viewReady = true;
        if(session.scope === state.activeScope && getOverlay().classList.contains('is-open')){
            session.frame.hidden = false;
            syncPageVisibility();
            fitRevealedWorkspace(session);
        }
        return true;
    }

    function showOverlay({forceVisibility = false} = {}){
        const overlay = getOverlay();
        overlay.classList.add('is-open');
        if(forceVisibility){
            const session = activeSession();
            if(session) session.pollingVisible = null;
        }
        syncPageVisibility();
    }

    function hideOverlay(){
        const overlay = getOverlay();
        overlay.classList.remove('is-open');
        overlay.setAttribute('aria-hidden', 'true');
        ui('[data-openshop-source-panel]')?.classList?.remove('is-open');
        const session = activeSession();
        if(session){
            session.idleSince = Date.now();
            session.pollingVisible = null;
        }
        syncPageVisibility();
    }

    function openNodeSession(contextValue, sources=[]){
        const context = normalizedContext(contextValue);
        const scope = Protocol.createProjectScope(context);
        const previous = activeSession();
        const normalized = normalizeSources(sources);
        const entryMode = normalized.length ? 'workspace' : 'welcome';
        let session = state.sessions.get(scope);
        const sourcesChanged = session && JSON.stringify(session.sources) !== JSON.stringify(normalized);
        if(!session) session = createSession(context, normalized);
        else {
            if(sourcesChanged && session.entryMode !== 'workspace' && entryMode === 'workspace'){
                session.viewReady = false;
            }
            session.context = {...session.context, ...context};
            session.sources = normalized;
            session.entryMode = entryMode;
            session.frame.title = `图文分层：${context.projectName}`;
        }
        if(previous && previous !== session) previous.idleSince = Date.now();
        state.activeScope = scope;
        state.sessions.forEach(item => { item.frame.hidden = item !== session || !item.viewReady; });
        session.idleSince = 0;
        ui('[data-openshop-title]').textContent = context.projectName;
        renderSourcePanel(session, session.project);
        showOverlay({forceVisibility:true});
        setStatus(session, session.status || 'loading', session.error);
        syncDownloadButton(session);
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
            ['queued', 'running'].includes(clean(task?.status))
        )).length;
        publishAiTaskLogs(session, tasks);
    }

    function artTaskLog(record){
        if(clean(record?.toolId) !== 'art-font-restore' || !clean(record?.taskId)) return null;
        const reconcileState = clean(record.reconcileState);
        const success = reconcileState === 'applied';
        const failed = ['discarded', 'stale'].includes(reconcileState)
            || ['failed', 'cancelled'].includes(clean(record.status));
        if(!success && !failed) return null;
        const result = record.result && typeof record.result === 'object' ? record.result : {};
        const outputAssetId = clean(record.outputAssetId || result.assetId);
        const terminalAt = Number(record.appliedAt || record.discardedAt || record.staleAt || record.completedAt || record.updatedAt || 0);
        const createdAt = Number(record.createdAt || 0);
        return {
            taskId:clean(record.taskId),
            toolId:'art-font-restore',
            status:success ? 'success' : 'failed',
            apiConfigId:clean(record.apiConfigId),
            modelId:clean(record.modelId),
            prompt:clean(record.snapshot?.currentText),
            textLayerId:clean(record.snapshot?.textLayerId),
            generatedLayerId:clean(record.generatedLayerId),
            runMs:terminalAt > createdAt ? terminalAt - createdAt : 0,
            error:success ? '' : safeError(record.error || record.reconcileReason || '艺术字体处理失败'),
            output:success && outputAssetId ? {
                assetId:outputAssetId,
                url:clean(result.url) || `/api/openshop/assets/${encodeURIComponent(outputAssetId)}`,
                name:clean(result.name) || 'artistic-font.png',
                width:Math.max(0, Number(result.width || 0)),
                height:Math.max(0, Number(result.height || 0)),
                kind:'image',
            } : null,
        };
    }

    function generativeTaskLog(record){
        const toolId = clean(record?.toolId);
        const taskId = clean(record?.taskId);
        const status = clean(record?.status);
        if(!['generative-fill', 'local-redraw'].includes(toolId) || !taskId
            || !['succeeded', 'partial', 'failed', 'cancelled'].includes(status)) return null;
        const children = Array.isArray(record.children) ? record.children : [];
        const outputs = children
            .filter(child => child?.status === 'succeeded' && clean(child.outputAssetId || child.result?.assetId))
            .sort((left, right) => Number(left.index || 0) - Number(right.index || 0))
            .map(child => {
                const result = child.result && typeof child.result === 'object' ? child.result : {};
                const assetId = clean(child.outputAssetId || result.assetId);
                return {
                    assetId,
                    url:clean(result.url) || `/api/openshop/assets/${encodeURIComponent(assetId)}`,
                    name:clean(result.name) || `${toolId}-${Number(child.index || 0) + 1}.png`,
                    width:Math.max(0, Number(result.width || 0)),
                    height:Math.max(0, Number(result.height || 0)),
                    kind:'image',
                };
            });
        const childError = children.find(child => (
            ['failed', 'cancelled'].includes(clean(child?.status)) && clean(child?.error)
        ))?.error;
        const failed = ['failed', 'cancelled'].includes(status);
        const terminalAt = Number(record.completedAt || record.updatedAt || 0);
        const createdAt = Number(record.createdAt || 0);
        return {
            taskId,
            toolId,
            status:status === 'succeeded' ? 'success' : (status === 'partial' ? 'partial' : 'failed'),
            apiConfigId:clean(record.apiConfigId),
            modelId:clean(record.modelId),
            prompt:clean(record.snapshot?.prompt),
            generatedLayerId:'',
            runMs:terminalAt > createdAt ? terminalAt - createdAt : 0,
            error:status === 'succeeded' ? '' : safeError(
                record.error || childError || (failed ? 'OpenShop 图片生成失败' : '部分图片生成失败')
            ),
            output:outputs[0] || null,
            outputs,
        };
    }

    function aiTaskLog(record){
        if(!AI_LOG_TOOL_IDS.has(clean(record?.toolId))) return null;
        return artTaskLog(record) || generativeTaskLog(record);
    }

    function publishAiTaskLogs(session, tasks){
        if(!session) return;
        session.publishedAiTaskLogs = session.publishedAiTaskLogs || new Set();
        tasks.forEach(record => {
            const log = aiTaskLog(record);
            if(!log) return;
            const outputKey = (log.outputs || [log.output]).filter(Boolean)
                .map(output => clean(output.assetId || output.url)).join(',');
            const key = `${log.taskId}:${log.status}:${log.generatedLayerId}:${outputKey}`;
            if(session.publishedAiTaskLogs.has(key)) return;
            session.publishedAiTaskLogs.add(key);
            postToOrigin(session, {
                type:'hstar-openshop-ai-task-log',
                requestId:`openshop-ai-log-${log.taskId}`,
                context:{
                    canvasType:session.context.canvasType,
                    canvasId:session.context.canvasId,
                    nodeId:session.context.nodeId,
                    projectId:session.context.projectId,
                },
                log,
            });
        });
    }

    function nodeMeta(session, project, saveState=session.status || 'saved'){
        const pending = pendingSourceUpdates(project);
        return {
            projectId:clean(project?.projectId || session.context.projectId),
            projectName:clean(session.context.projectName) || '图文分层',
            previewAssetId:clean(project?.previewAssetId),
            previewUrl:project?.previewAssetId ? `/api/openshop/assets/${encodeURIComponent(project.previewAssetId)}` : '',
            documentWidth:Math.max(1, Number(project?.document?.width || session.context.documentWidth || 1920)),
            documentHeight:Math.max(1, Number(project?.document?.height || session.context.documentHeight || 1080)),
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

    function validCanvasAcknowledgement(event){
        if(event.origin !== window.location.origin) return null;
        const data = event.data || {};
        if(data.type !== 'hstar-openshop-output-applied') return null;
        const session = [...state.sessions.values()].find(item => (
            event.source === originFrame(item)?.contentWindow
            && sameContext(data.context, item.context)
        ));
        const requestId = clean(data.requestId);
        if(!session || !requestId || !session.pendingCanvasOutputs.has(requestId)) return null;
        return {session, data, requestId};
    }

    function applyCanvasAcknowledgement({session, data, requestId}){
        session.pendingCanvasOutputs.delete(requestId);
        if(session.scope !== state.activeScope) return;
        if(data.status === 'success') showNotice('已发送到画布');
        else showNotice(safeError(data.message || '发送到画布失败'), 'error');
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
        const canvasAcknowledgement = validCanvasAcknowledgement(event);
        if(canvasAcknowledgement){
            applyCanvasAcknowledgement(canvasAcknowledgement);
            return;
        }
        const valid = validEditorEvent(event);
        if(!valid) return;
        const {session, envelope} = valid;
        if(envelope.type === Protocol.TYPES.READY){
            session.editorReady = true;
            syncDownloadButton(session);
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
                revealSessionFrame(session, clean(envelope.payload?.reason));
                setStatus(session, 'dirty');
                publishNodeMeta(session, envelope.requestId, 'dirty');
            } else if(envelope.type === Protocol.TYPES.SEND_TO_CANVAS){
                const output = validOutput(envelope.payload);
                if(!output) throw new Error('OpenShop 输出资源无效');
                session.pendingCanvasOutputs.set(envelope.requestId, {createdAt:Date.now()});
                postToOrigin(session, {
                    type:'hstar-openshop-output',
                    requestId:envelope.requestId,
                    context:{...session.context},
                    output,
                });
            } else if(envelope.type === Protocol.TYPES.DOWNLOAD_LOCAL_RESULT){
                if(session.downloadRequestId !== envelope.requestId) return;
                session.downloadRequestId = '';
                if(session.scope === state.activeScope){
                    syncDownloadButton(session);
                    const status = clean(envelope.payload?.status);
                    if(status === 'success'){
                        showNotice(`已保存：${clean(envelope.payload?.filename) || 'openshop-export.png'}`);
                    } else if(status === 'error'){
                        showNotice(safeError(envelope.payload?.message), 'error');
                    }
                }
            } else if(envelope.type === Protocol.TYPES.OPEN_API_SETTINGS){
                if(session.scope === state.activeScope) openApiSettings();
            } else if(envelope.type === Protocol.TYPES.ERROR){
                if(isOcrToolError(envelope.payload?.message)){
                    setStatus(session, session.project ? 'saved' : 'idle');
                } else {
                    setStatus(session, 'error', safeError(envelope.payload?.message || 'OpenShop 编辑器发生错误'));
                }
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

    function requestDownloadLocal(){
        const session = activeSession();
        if(!session?.editorReady || session.downloadRequestId) return null;
        const requestId = uuid('openshop-download');
        session.downloadRequestId = requestId;
        syncDownloadButton(session);
        return postToEditor(session, Protocol.TYPES.REQUEST_DOWNLOAD_LOCAL, {format:'png'}, requestId);
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
        hookPageSwitch();
        ui('[data-openshop-back]')?.addEventListener?.('click', () => close());
        ui('[data-openshop-save]')?.addEventListener?.('click', () => requestSave());
        ui('[data-openshop-download]')?.addEventListener?.('click', requestDownloadLocal);
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
        requestDownloadLocal,
        requestSendToCanvas,
        refreshSources,
        close,
        getState,
    });
})();
