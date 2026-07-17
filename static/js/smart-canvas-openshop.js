(function bootstrapSmartOpenShopAdapter(root){
    if(root.HstarSmartOpenShopAdapter) return;
    const appliedOutputRequests = new Set();

    function hooks(){
        return root.HstarSmartCanvasOpenShopHooks || {};
    }

    function clean(value){
        return String(value || '').trim();
    }

    function translate(key, fallback){
        const value = hooks().t?.(key);
        return value && value !== key ? value : fallback;
    }

    function safeHtml(value){
        return String(value || '').replace(/[&<>"']/g, character => ({
            '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;',
        })[character]);
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
            projectName:translate('smart.openshopProjectName', '图文分层项目'),
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
            inputNodeIds:[],
            created_at:Date.now(),
        };
    }

    function nodeFor(id){
        return hooks().getNode?.(id) || null;
    }

    function nodeImages(node){
        const fromHook = hooks().imagesForNode?.(node);
        const images = Array.isArray(fromHook) ? fromHook : (node?.images || []);
        return images.filter(image => {
            const kind = clean(image?.kind || image?.mediaKind || 'image');
            return clean(image?.url || image?.imageUrl) && kind === 'image';
        });
    }

    function canConnect(from, to){
        if(!from || !to || from.id === to.id) return false;
        if(to.type === 'openshop-layered') return from.type !== 'openshop-layered' && nodeImages(from).length > 0;
        if(from.type === 'openshop-layered') return ['smart-image', 'smart-group', 'output'].includes(to.type);
        return false;
    }

    function connectionId(connection, index){
        return clean(connection?.id) || `smart-input-${index}`;
    }

    function sourcesForNode(node){
        if(!node || node.type !== 'openshop-layered') return [];
        const allInputs = hooks().inputImagesForNode?.(node) || [];
        const connections = (hooks().getConnections?.() || [])
            .map((connection, index) => ({connection, index}))
            .filter(item => item.connection?.to === node.id && (item.connection.kind || 'flow') === 'input')
            .sort((left, right) => left.index - right.index || connectionId(left.connection, left.index).localeCompare(connectionId(right.connection, right.index)));
        const usedInputs = new Set();
        const sources = [];
        connections.forEach(({connection, index}) => {
            const sourceNode = nodeFor(connection.from);
            const matching = allInputs
                .map((image, inputIndex) => ({image, inputIndex}))
                .filter(item => !usedInputs.has(item.inputIndex)
                    && clean(item.image?.sourceNodeId || item.image?.nodeId) === clean(connection.from));
            const candidates = matching.length
                ? matching
                : nodeImages(sourceNode).map((image, inputIndex) => ({image, inputIndex}));
            candidates.forEach(({image, inputIndex}, localIndex) => {
                usedInputs.add(inputIndex);
                const imageIndex = Number.isFinite(Number(image?.imageIndex)) ? Number(image.imageIndex) : localIndex;
                const rawUrl = clean(image?.url || image?.imageUrl);
                const name = clean(image?.name) || `source-${sources.length + 1}.png`;
                sources.push({
                    edgeId:`${connectionId(connection, index)}:${imageIndex}`,
                    sourceNodeId:clean(connection.from),
                    assetVersion:clean(image?.assetVersion || sourceNode?.assetVersion || sourceNode?.updated_at || rawUrl),
                    name,
                    url:hooks().displayMediaUrl?.(rawUrl, name) || rawUrl,
                    sequence:sources.length,
                });
            });
        });
        return sources;
    }

    function saveStateLabel(node){
        if(node.saveState === 'saving') return translate('smart.openshopSaving', '正在保存');
        if(node.saveState === 'saved') return translate('smart.openshopSaved', '已保存');
        if(node.saveState === 'error') return translate('smart.openshopSaveFailed', '保存失败');
        return translate('smart.openshopUnsaved', '未保存');
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
        const preview = clean(node.previewUrl);
        const previewMarkup = preview
            ? `<img loading="lazy" decoding="async" src="${safeHtml(preview)}" alt="${safeHtml(node.projectName)}">`
            : '<div class="openshop-layered-placeholder"><i data-lucide="layers-3"></i></div>';
        const updates = Math.max(0, Number(node.sourceUpdateCount || 0));
        const aiProgress = aiProgressLabel(node);
        return `<div class="openshop-layered-card">
            <div class="openshop-layered-preview">${previewMarkup}</div>
            <div class="openshop-layered-meta">
                <span>${Math.max(1, Number(node.documentWidth || 1920))} x ${Math.max(1, Number(node.documentHeight || 1080))}</span>
                <span>${Math.max(0, Number(node.layerCount || 0))} ${safeHtml(translate('smart.openshopLayers', '图层'))}</span>
                <span class="openshop-layered-save" data-state="${safeHtml(node.saveState || 'new')}">${safeHtml(saveStateLabel(node))}</span>
                ${aiProgress ? `<span class="openshop-layered-ai" data-state="${safeHtml(node.aiStatus)}">${safeHtml(aiProgress)}</span>` : ''}
                <span class="openshop-layered-updates ${updates ? 'has-updates' : ''}">${safeHtml(translate('smart.openshopSourceUpdates', '来源更新'))} ${updates}</span>
            </div>
            <button class="openshop-layered-open" type="button" data-openshop-open="${safeHtml(node.id)}">
                <i data-lucide="panel-top-open"></i><span>${safeHtml(translate('smart.openshopOpen', '打开编辑器'))}</span>
            </button>
        </div>`;
    }

    function currentCanvasId(){
        return clean(hooks().getCanvasId?.());
    }

    function openNode(nodeId){
        const node = nodeFor(nodeId);
        if(!node || node.type !== 'openshop-layered') return false;
        const host = root.parent?.HstarOpenShopHost || root.HstarOpenShopHost;
        if(!host?.openNodeSession) return false;
        host.openNodeSession({
            canvasType:'smart',
            canvasId:currentCanvasId(),
            nodeId:node.id,
            projectId:node.projectId,
            projectName:node.projectName || translate('smart.openshopProjectName', '图文分层项目'),
            frameId:root.frameElement?.id || 'frame-smart-canvas',
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

    function captureCloneSource(source, clipboardCopy){
        const existing = {
            cloneSourceProjectId:clean(source?.cloneSourceProjectId),
            cloneSourceCanvasType:clean(source?.cloneSourceCanvasType),
            cloneSourceCanvasId:clean(source?.cloneSourceCanvasId),
            cloneSourceNodeId:clean(source?.cloneSourceNodeId),
        };
        Object.assign(clipboardCopy, Object.values(existing).every(Boolean) ? existing : {
            cloneSourceProjectId:clean(source?.projectId),
            cloneSourceCanvasType:'smart',
            cloneSourceCanvasId:currentCanvasId(),
            cloneSourceNodeId:clean(source?.id),
        });
        return clipboardCopy;
    }

    function prepareClone(source, copy){
        copy.projectId = newProjectId();
        copy.cloneSourceProjectId = clean(source?.cloneSourceProjectId) || clean(source?.projectId);
        copy.cloneSourceCanvasType = clean(source?.cloneSourceCanvasType) || 'smart';
        copy.cloneSourceCanvasId = clean(source?.cloneSourceCanvasId) || currentCanvasId();
        copy.cloneSourceNodeId = clean(source?.cloneSourceNodeId) || clean(source?.id);
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
            canvasType:'smart',
            canvasId:currentCanvasId(),
            nodeId:node.id,
            projectId:node.projectId,
        });
        return true;
    }

    function matchingContext(context, node){
        return Boolean(
            context
            && context.canvasType === 'smart'
            && clean(context.canvasId) === currentCanvasId()
            && clean(context.nodeId) === clean(node?.id)
            && clean(context.projectId) === clean(node?.projectId)
        );
    }

    function applyNodeMeta(data){
        const node = nodeFor(data?.context?.nodeId);
        if(!node || node.type !== 'openshop-layered' || !matchingContext(data.context, node)) return false;
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
        const source = nodeFor(data?.context?.nodeId);
        if(!source || source.type !== 'openshop-layered' || !matchingContext(data.context, source)) return null;
        const requestId = clean(data.requestId);
        if(requestId && appliedOutputRequests.has(requestId)) return null;
        const output = data.output || {};
        const url = clean(output.url);
        if(!clean(output.assetId) || !url || /^(?:data:image\/|blob:)/i.test(url)) return null;
        if(requestId) appliedOutputRequests.add(requestId);
        hooks().pushUndo?.();
        const created = hooks().createImageOutput?.({sourceNode:source, output:{...output, url}, requestId});
        if(!created) return null;
        hooks().selectOnly?.(created.id);
        hooks().render?.();
        hooks().scheduleSave?.();
        await hooks().saveCanvas?.();
        return created;
    }

    function handleMessage(event){
        if(event.origin && event.origin !== root.location.origin) return;
        if(root.parent && root.parent !== root && event.source !== root.parent) return;
        const data = event.data || {};
        if(data.type === 'hstar-openshop-node-meta') applyNodeMeta(data);
        if(data.type === 'hstar-openshop-output'){
            void importOutput(data).catch(error => {
                console.error('[HstarSmartOpenShopAdapter] output import failed', error);
                hooks().toast?.(error?.message || '图文分层输出导入失败');
            });
        }
    }

    root.addEventListener('message', handleMessage);
    root.HstarSmartOpenShopAdapter = Object.freeze({
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
