(function bootstrapClassicOpenShopAdapter(root){
    if(root.HstarClassicOpenShopAdapter) return;
    const appliedOutputRequests = new Set();

    function hooks(){
        return root.HstarClassicOpenShopHooks || {};
    }

    function clean(value){
        return String(value || '').trim();
    }

    function translate(key, fallback){
        const value = hooks().t?.(key);
        return value && value !== key ? value : fallback;
    }

    function safeHtml(value){
        if(typeof root.escapeHtml === 'function') return root.escapeHtml(String(value || ''));
        return String(value || '').replace(/[&<>"']/g, character => ({
            '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;',
        })[character]);
    }

    function safeAttr(value){
        if(typeof root.escapeAttr === 'function') return root.escapeAttr(String(value || ''));
        return safeHtml(value);
    }

    function newProjectId(){
        let value = '';
        try { value = root.crypto?.randomUUID?.() || ''; } catch(error) {}
        if(!value) value = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
        return `osp_${String(value).replaceAll('-', '_')}`;
    }

    function createNode({x = 0, y = 0} = {}){
        return {
            id:hooks().uid?.('openshop') || `openshop_${Date.now()}`,
            type:'openshop-layered',
            projectId:newProjectId(),
            projectName:translate('canvas.openshopProjectName', '图文分层项目'),
            x:Number(x || 0),
            y:Number(y || 0),
            w:340,
            h:260,
            previewUrl:'',
            documentWidth:1920,
            documentHeight:1080,
            layerCount:0,
            sourceUpdateCount:0,
            autosaveVersion:0,
            saveState:'new',
            saveError:'',
            aiStatus:'',
            aiTargetCount:0,
            aiCompletedCount:0,
            aiFailedCount:0,
            cloneSourceProjectId:'',
            cloneSourceCanvasType:'',
            cloneSourceCanvasId:'',
            cloneSourceNodeId:'',
            created_at:Date.now(),
        };
    }

    function nodeList(){
        return hooks().getNodes?.() || [];
    }

    function connectionList(){
        return hooks().getConnections?.() || [];
    }

    function imageRefs(node){
        const refs = hooks().mediaRefsFromNode?.(node) || [];
        return refs.filter(ref => {
            if(!clean(ref?.url)) return false;
            const kind = hooks().mediaKindForRef?.(ref) || ref.kind || ref.mediaKind || 'image';
            return kind === 'image';
        });
    }

    function sourceCanProvideImage(node){
        if(!node || node.type === 'openshop-layered') return false;
        if(['image', 'group', 'output'].includes(node.type)) return imageRefs(node).length > 0;
        return imageRefs(node).length > 0;
    }

    function canConnect(from, to){
        if(!from || !to || from.id === to.id) return false;
        if(to.type === 'openshop-layered') return sourceCanProvideImage(from);
        if(from.type === 'openshop-layered') return ['image', 'group', 'output'].includes(to.type);
        return false;
    }

    function sourceVersion(sourceNode, ref){
        return clean(
            ref?.assetVersion
            || sourceNode?.assetVersion
            || sourceNode?.updated_at
            || sourceNode?.updatedAt
            || ref?.url
        );
    }

    function sourcesForNode(node){
        if(!node || node.type !== 'openshop-layered') return [];
        const nodes = nodeList();
        return connectionList().map((connection, connectionIndex) => ({connection, connectionIndex}))
            .filter(item => item.connection?.to === node.id)
            .sort((left, right) => left.connectionIndex - right.connectionIndex
                || clean(left.connection.id).localeCompare(clean(right.connection.id)))
            .map(item => {
                const sourceNode = nodes.find(candidate => candidate.id === item.connection.from);
                const ref = imageRefs(sourceNode)[0];
                if(!sourceNode || !ref) return null;
                const name = clean(ref.name || sourceNode.name) || `source-${item.connectionIndex + 1}.png`;
                const rawUrl = clean(ref.url);
                return {
                    edgeId:clean(item.connection.id) || `edge-${item.connectionIndex}`,
                    sourceNodeId:sourceNode.id,
                    assetVersion:sourceVersion(sourceNode, ref),
                    name,
                    url:hooks().displayMediaUrl?.(rawUrl, name) || rawUrl,
                    sequence:item.connectionIndex,
                };
            })
            .filter(Boolean)
            .map((source, sequence) => ({...source, sequence}));
    }

    function saveStateLabel(node){
        if(node.saveState === 'saving') return translate('canvas.openshopSaving', '正在保存');
        if(node.saveState === 'saved') return translate('canvas.openshopSaved', '已保存');
        if(node.saveState === 'error') return translate('canvas.openshopSaveFailed', '保存失败');
        return translate('canvas.openshopUnsaved', '未保存');
    }

    function aiProgressLabel(node){
        const target = Math.max(0, Number(node.aiTargetCount || 0));
        const completed = Math.max(0, Number(node.aiCompletedCount || 0));
        if(!target) return '';
        if(['queued', 'running'].includes(clean(node.aiStatus))) return `生成中 ${completed}/${target}`;
        if(['partial', 'failed'].includes(clean(node.aiStatus)) && completed > 0) return `已完成 ${completed}/${target}`;
        return '';
    }

    function renderNode(node){
        const wrap = document.createElement('div');
        wrap.className = 'openshop-layered-card';
        const preview = clean(node.previewUrl);
        const previewMarkup = preview
            ? `<img loading="lazy" decoding="async" src="${safeAttr(preview)}" alt="${safeAttr(node.projectName)}">`
            : '<div class="openshop-layered-placeholder"><i data-lucide="layers-3"></i></div>';
        const updates = Math.max(0, Number(node.sourceUpdateCount || 0));
        const aiProgress = aiProgressLabel(node);
        wrap.innerHTML = `
            <div class="openshop-layered-preview">${previewMarkup}</div>
            <div class="openshop-layered-meta">
                <span>${Math.max(1, Number(node.documentWidth || 1920))} x ${Math.max(1, Number(node.documentHeight || 1080))}</span>
                <span>${Math.max(0, Number(node.layerCount || 0))} ${safeHtml(translate('canvas.openshopLayers', '图层'))}</span>
                <span class="openshop-layered-save" data-state="${safeAttr(node.saveState || 'new')}">${safeHtml(saveStateLabel(node))}</span>
                ${aiProgress ? `<span class="openshop-layered-ai" data-state="${safeAttr(node.aiStatus)}">${safeHtml(aiProgress)}</span>` : ''}
                <span class="openshop-layered-updates ${updates ? 'has-updates' : ''}">${safeHtml(translate('canvas.openshopSourceUpdates', '来源更新'))} ${updates}</span>
            </div>
            <button class="openshop-layered-open" type="button" data-open-openshop="${safeAttr(node.id)}">
                <i data-lucide="panel-top-open"></i><span>${safeHtml(translate('canvas.openshopOpen', '打开编辑器'))}</span>
            </button>`;
        const button = wrap.querySelector?.('[data-open-openshop]');
        if(button) button.onclick = event => {
            event.preventDefault();
            event.stopPropagation();
            openNode(node.id);
        };
        return wrap;
    }

    function currentCanvasId(){
        return clean(hooks().getCanvasId?.());
    }

    function openNode(nodeId){
        const node = nodeList().find(candidate => candidate.id === nodeId && candidate.type === 'openshop-layered');
        if(!node) return false;
        const host = root.parent?.HstarOpenShopHost || root.HstarOpenShopHost;
        if(!host?.openNodeSession) return false;
        host.openNodeSession({
            canvasType:'classic',
            canvasId:currentCanvasId(),
            nodeId:node.id,
            projectId:node.projectId,
            projectName:node.projectName || translate('canvas.openshopProjectName', '图文分层项目'),
            frameId:root.frameElement?.id || 'frame-canvas',
            cloneSourceProjectId:clean(node.cloneSourceProjectId),
            cloneSourceCanvasType:clean(node.cloneSourceCanvasType),
            cloneSourceCanvasId:clean(node.cloneSourceCanvasId),
            cloneSourceNodeId:clean(node.cloneSourceNodeId),
            documentWidth:Number(node.documentWidth || 1920),
            documentHeight:Number(node.documentHeight || 1080),
        }, sourcesForNode(node));
        hooks().scheduleSave?.();
        return true;
    }

    function completeCloneSource(source){
        const existing = {
            cloneSourceProjectId:clean(source?.cloneSourceProjectId),
            cloneSourceCanvasType:clean(source?.cloneSourceCanvasType),
            cloneSourceCanvasId:clean(source?.cloneSourceCanvasId),
            cloneSourceNodeId:clean(source?.cloneSourceNodeId),
        };
        return Object.values(existing).every(Boolean) ? existing : null;
    }

    function cloneSourceFor(source){
        return completeCloneSource(source) || {
            cloneSourceProjectId:clean(source?.projectId),
            cloneSourceCanvasType:'classic',
            cloneSourceCanvasId:currentCanvasId(),
            cloneSourceNodeId:clean(source?.id),
        };
    }

    function captureCloneSource(source, clipboardCopy){
        Object.assign(clipboardCopy, cloneSourceFor(source));
        return clipboardCopy;
    }

    function prepareClone(source, copy){
        copy.projectId = newProjectId();
        Object.assign(copy, cloneSourceFor(source));
        copy.autosaveVersion = 0;
        copy.saveState = 'new';
        copy.saveError = '';
        copy.sourceUpdateCount = 0;
        copy.aiStatus = '';
        copy.aiTargetCount = 0;
        copy.aiCompletedCount = 0;
        copy.aiFailedCount = 0;
        copy.created_at = Date.now();
        return copy;
    }

    function disposeNode(node){
        if(!node || node.type !== 'openshop-layered' || !clean(node.projectId)) return false;
        const host = root.parent?.HstarOpenShopHost || root.HstarOpenShopHost;
        if(!host?.disposeProject) return false;
        void host.disposeProject(node.projectId, {
            canvasType:'classic',
            canvasId:currentCanvasId(),
            nodeId:node.id,
            projectId:node.projectId,
        });
        return true;
    }

    function matchingContext(context, node){
        return Boolean(
            context
            && context.canvasType === 'classic'
            && clean(context.canvasId) === currentCanvasId()
            && clean(context.nodeId) === clean(node?.id)
            && clean(context.projectId) === clean(node?.projectId)
        );
    }

    function acknowledgeOutput(data, status, details={}){
        const source = nodeList().find(candidate => (
            candidate.id === data?.context?.nodeId && candidate.type === 'openshop-layered'
        ));
        if(!clean(data?.requestId) || !source || !matchingContext(data?.context, source)) return false;
        root.parent?.postMessage?.({
            type:'hstar-openshop-output-applied',
            requestId:clean(data.requestId),
            context:{...data.context},
            status,
            ...(details.nodeId ? {nodeId:clean(details.nodeId)} : {}),
            ...(details.message ? {message:clean(details.message).slice(0, 180)} : {}),
        }, root.location.origin);
        return true;
    }

    function applyNodeMeta(data){
        const node = nodeList().find(candidate => candidate.id === data?.context?.nodeId && candidate.type === 'openshop-layered');
        if(!node || !matchingContext(data.context, node)) return false;
        const meta = data.meta || {};
        node.projectName = clean(meta.projectName) || node.projectName;
        node.previewUrl = clean(meta.previewUrl);
        node.documentWidth = Math.max(1, Number(meta.documentWidth || node.documentWidth || 1920));
        node.documentHeight = Math.max(1, Number(meta.documentHeight || node.documentHeight || 1080));
        node.layerCount = Math.max(0, Number(meta.layerCount || 0));
        node.sourceUpdateCount = Math.max(0, Number(meta.sourceUpdateCount || 0));
        node.autosaveVersion = Math.max(0, Number(meta.autosaveVersion || 0));
        node.saveState = clean(meta.saveState) || 'saved';
        node.saveError = clean(meta.error);
        node.aiStatus = clean(meta.aiStatus);
        node.aiTargetCount = Math.max(0, Number(meta.aiTargetCount || 0));
        node.aiCompletedCount = Math.max(0, Number(meta.aiCompletedCount || 0));
        node.aiFailedCount = Math.max(0, Number(meta.aiFailedCount || 0));
        node.cloneSourceProjectId = '';
        node.cloneSourceCanvasType = '';
        node.cloneSourceCanvasId = '';
        node.cloneSourceNodeId = '';
        hooks().render?.();
        hooks().scheduleSave?.();
        return true;
    }

    async function importOutput(data){
        const source = nodeList().find(candidate => candidate.id === data?.context?.nodeId && candidate.type === 'openshop-layered');
        if(!source || !matchingContext(data.context, source)) return null;
        const requestId = clean(data.requestId);
        if(requestId && appliedOutputRequests.has(requestId)) return null;
        const output = data.output || {};
        const url = clean(output.url);
        if(!clean(output.assetId) || !url || /^(?:data:image\/|blob:)/i.test(url)) return null;
        if(requestId) appliedOutputRequests.add(requestId);
        try {
            hooks().pushUndo?.();
            const existingCount = nodeList().filter(node => node.openshopSourceNodeId === source.id).length;
            const naturalWidth = Math.max(0, Number(output.width || 0));
            const naturalHeight = Math.max(0, Number(output.height || 0));
            const image = {
                id:hooks().uid?.('img') || `img_${Date.now()}`,
                type:'image',
                x:Number(source.x || 0) + Number(source.w || 340) + 90,
                y:Number(source.y || 0) + existingCount * 34,
                w:260,
                h:336,
                url,
                name:clean(output.name) || '图文分层输出.png',
                mediaKind:'image',
                ...(naturalWidth && naturalHeight ? {natural_w:naturalWidth, natural_h:naturalHeight} : {}),
                openshopAssetId:clean(output.assetId),
                openshopSourceNodeId:source.id,
                openshopProjectId:source.projectId,
                openshopRequestId:requestId,
                sourceType:'openshop-layered',
            };
            hooks().addNode?.(image);
            hooks().addConnection?.({
                id:hooks().uid?.('c') || `c_${Date.now()}`,
                from:source.id,
                to:image.id,
            });
            hooks().selectOnly?.(image.id);
            hooks().render?.();
            hooks().scheduleSave?.();
            await hooks().saveCanvas?.();
            acknowledgeOutput(data, 'success', {nodeId:image.id});
            return image;
        } catch(error){
            acknowledgeOutput(data, 'error', {message:error?.message || '图文分层输出导入失败'});
            throw error;
        }
    }

    function handleMessage(event){
        if(event.origin && event.origin !== root.location.origin) return;
        if(root.parent && root.parent !== root && event.source !== root.parent) return;
        const data = event.data || {};
        if(data.type === 'hstar-openshop-node-meta') applyNodeMeta(data);
        if(data.type === 'hstar-openshop-output'){
            void importOutput(data).catch(error => console.error('[HstarClassicOpenShopAdapter] output import failed', error));
        }
    }

    root.addEventListener('message', handleMessage);
    root.HstarClassicOpenShopAdapter = Object.freeze({
        createNode,
        renderNode,
        canConnect,
        sourcesForNode,
        openNode,
        captureCloneSource,
        prepareClone,
        disposeNode,
        applyNodeMeta,
        importOutput,
    });
})(window);
