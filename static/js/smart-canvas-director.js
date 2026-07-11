(function(){
    const NODE_TYPE = 'director-3d';
    const LABEL = '3D导演台';
    const importedRequests = new Set();

    function hooks(){
        return window.HstarSmartCanvasDirectorHooks || {};
    }

    function escapeHtml(value){
        return String(value ?? '').replace(/[&<>"']/g, ch => ({
            '&':'&amp;',
            '<':'&lt;',
            '>':'&gt;',
            '"':'&quot;',
            "'":'&#39;'
        }[ch]));
    }

    function nodeId(nodeOrId){
        return typeof nodeOrId === 'string' ? nodeOrId : nodeOrId?.id || '';
    }

    function getNode(nodeOrId){
        if(nodeOrId && typeof nodeOrId === 'object'){
            if(nodeOrId.type) return nodeOrId;
            const fromHooks = hooks().getNode?.(nodeOrId.id);
            return fromHooks || {...nodeOrId, type: NODE_TYPE};
        }
        return hooks().getNode?.(nodeOrId) || null;
    }

    function isDirectorNode(node){
        return Boolean(node && node.type === NODE_TYPE);
    }

    function isImageishNode(node){
        if(!node) return false;
        if(['smart-image', 'smart-group', 'image', 'group', 'output'].includes(node.type)) return true;
        if(node.type === 'smart-loop' && node.imageInput) return true;
        return Array.isArray(node.images) && node.images.some(img => img?.url || img?.imageUrl);
    }

    function canConnect(from, to, context={}){
        if(!from || !to || (from.id && to.id && from.id === to.id)) return false;
        if(isDirectorNode(to)){
            if(!isImageishNode(from)) return false;
            const existingInputs = Array.isArray(context.inputNodes) ? context.inputNodes : [];
            return !existingInputs.some(input => input?.id && input.id !== from.id);
        }
        if(isDirectorNode(from)){
            return ['smart-image', 'smart-group', 'output'].includes(to.type) || !to.type;
        }
        return false;
    }

    function resolveDirectorPanorama(nodeOrId){
        const node = getNode(nodeOrId);
        if(!isDirectorNode(node)) return null;
        const input = (hooks().inputImagesForNode?.(node) || []).find(item => item?.url || item?.imageUrl);
        if(!input) return null;
        const imageUrl = input.imageUrl || input.url || '';
        if(!imageUrl) return null;
        return {
            edgeId: input.edgeId || '',
            sourceNodeId: input.nodeId || input.sourceNodeId || '',
            imageIndex: input.imageIndex ?? 0,
            url: input.url || imageUrl,
            imageUrl,
            name: input.name || 'panorama.png',
            kind: 'image'
        };
    }

    function renderDirectorNode(node){
        const panorama = resolveDirectorPanorama(node);
        const status = panorama ? `全景：${panorama.name || '已连接图片'}` : '全景：未连接';
        return `<div class="director-node-card smart-director-node-card">
            <div class="director-node-kicker">Director Desk</div>
            <div class="director-node-title">${escapeHtml(LABEL)}</div>
            <div class="director-node-status">${escapeHtml(status)}</div>
            <div class="director-node-actions">
                <button class="director-node-open" type="button" data-director-open="${escapeHtml(nodeId(node))}">
                    <i data-lucide="box"></i><span>打开${escapeHtml(LABEL)}</span>
                </button>
            </div>
        </div>`;
    }

    function directorHost(){
        if(window.HstarDirectorHost) return window.HstarDirectorHost;
        try {
            return window.parent && window.parent !== window ? window.parent.HstarDirectorHost : null;
        } catch(e) {
            return null;
        }
    }

    function contextForNode(node){
        const fromHooks = hooks().contextForNode?.(node);
        if(fromHooks) return fromHooks;
        return {
            mode: 'node',
            canvasType: 'smart',
            canvasId: '',
            nodeId: node?.id || '',
            sceneKey: node?.sceneKey || '',
            instanceId: node?.sceneKey || node?.id || '',
            frameId: 'frame-canvas'
        };
    }

    function openDirectorNode(nodeOrId){
        const node = getNode(nodeOrId);
        if(!isDirectorNode(node)) return false;
        const host = directorHost();
        const context = contextForNode(node);
        const panorama = resolveDirectorPanorama(node);
        if(host?.openNodeSession){
            host.openNodeSession(context, panorama);
            return true;
        }
        try {
            window.parent?.postMessage({
                type: 'hstar-open-director-node',
                context,
                panorama
            }, window.location?.origin || '*');
        } catch(e) {}
        hooks().toast?.('无法打开3D导演台');
        return false;
    }

    function syncDirectorPanorama(nodeOrId){
        const node = getNode(nodeOrId);
        if(!isDirectorNode(node)) return false;
        const panorama = resolveDirectorPanorama(node);
        const host = directorHost();
        if(host?.sendPanorama && panorama){
            host.sendPanorama(panorama);
            return true;
        }
        return false;
    }

    function normalizeCapture(capture, index){
        const url = capture?.url || capture?.imageUrl || capture?.dataUrl || '';
        if(!url) return null;
        return {
            ...capture,
            url,
            name: capture?.name || capture?.fileName || `director-capture-${index + 1}.png`,
            kind: 'image'
        };
    }

    async function importDirectorCaptures({originNodeId, captures, requestId}={}){
        if(requestId && importedRequests.has(requestId)) return null;
        const normalized = (captures || []).map(normalizeCapture).filter(Boolean);
        if(!normalized.length){
            throw new Error('3D导演台截图数据为空');
        }
        const importer = hooks().importDirectorCapturesAsGroup;
        if(typeof importer !== 'function') throw new Error('智能画布尚未就绪，无法导入3D导演台截图');
        const result = await importer({originNodeId, captures: normalized, requestId});
        if(requestId) importedRequests.add(requestId);
        return result;
    }

    function removeDirectorPanorama(payload){
        return hooks().removeDirectorPanorama?.(payload) || false;
    }

    window.HstarSmartDirectorAdapter = Object.freeze({
        renderDirectorNode,
        openDirectorNode,
        resolveDirectorPanorama,
        importDirectorCaptures,
        removeDirectorPanorama,
        syncDirectorPanorama,
        canConnect
    });
})();
