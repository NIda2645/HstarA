(function(){
    const appliedRequests = new Set();

    function safeText(value, fallback=''){
        return String(value == null || value === '' ? fallback : value);
    }

    function currentCanvasId(){
        try {
            return canvas?.id || new URLSearchParams(window.location.search).get('id') || '';
        } catch(e) {
            return '';
        }
    }

    function sourceCanProvideImage(node){
        if(!node) return false;
        if(['image', 'group', 'output'].includes(node.type)) return true;
        return typeof CANVAS_MEDIA_OUTPUT_TYPES !== 'undefined' && CANVAS_MEDIA_OUTPUT_TYPES.includes(node.type);
    }

    function canConnect(from, to){
        if(!from || !to) return false;
        if(from.type === 'director-3d') return ['image', 'group'].includes(to.type);
        if(to.type !== 'director-3d') return false;
        if(!sourceCanProvideImage(from)) return false;
        const existing = (connections || []).find(conn => conn.to === to.id && conn.from !== from.id);
        return !existing;
    }

    function firstImageRefForNode(node){
        if(!node || typeof mediaRefsFromNode !== 'function') return null;
        const refs = mediaRefsFromNode(node)
            .filter(ref => {
                const url = ref?.url || '';
                if(!url) return false;
                if(typeof mediaKindForRef === 'function') return mediaKindForRef(ref) === 'image';
                return (ref.kind || 'image') === 'image';
            });
        return refs[0] || null;
    }

    function resolveDirectorPanorama(node){
        if(!node || node.type !== 'director-3d') return null;
        const incoming = (connections || [])
            .filter(conn => conn.to === node.id)
            .map(conn => ({ conn, source: nodes.find(n => n.id === conn.from) }))
            .filter(item => item.source && sourceCanProvideImage(item.source));
        const item = incoming[0];
        if(!item) return null;
        const ref = firstImageRefForNode(item.source);
        const rawUrl = ref?.url || '';
        if(!rawUrl) return null;
        const name = safeText(ref.name || item.source.name, 'panorama.png');
        const imageUrl = typeof canvasDisplayMediaUrl === 'function'
            ? canvasDisplayMediaUrl(rawUrl, name)
            : rawUrl;
        return {
            edgeId: item.conn.id,
            sourceNodeId: item.source.id,
            imageUrl,
            originalUrl: rawUrl,
            fileName: name,
            kind: 'image'
        };
    }

    function renderDirectorNode(node){
        const panorama = resolveDirectorPanorama(node);
        const wrap = document.createElement('div');
        wrap.className = 'director-node-body';
        wrap.innerHTML = `
            <div class="director-node-status">
                <strong>3D导演台</strong>
                <div class="director-node-panorama">
                    <i data-lucide="${panorama ? 'badge-check' : 'image-off'}"></i>
                    <span>${panorama ? escapeHtml(panorama.fileName || '已连接图片') : '未连接全景图片'}</span>
                </div>
                <div class="director-node-hint">连接一张图片作为场景背景，在导演台完成构图后发送截图回画布。</div>
            </div>
            <button class="director-node-action" type="button" data-open-director-node="${escapeAttr(node.id)}">
                <i data-lucide="box"></i>
                <span>打开3D导演台</span>
            </button>
        `;
        const openBtn = wrap.querySelector('[data-open-director-node]');
        if(openBtn) openBtn.onclick = event => {
            event.preventDefault();
            event.stopPropagation();
            openDirectorNode(node.id);
        };
        return wrap;
    }

    function openDirectorNode(nodeId){
        const node = (nodes || []).find(n => n.id === nodeId);
        if(!node || node.type !== 'director-3d') return false;
        const host = window.parent?.HstarDirectorHost || window.HstarDirectorHost;
        if(!host?.openNodeSession){
            alert('3D导演台入口尚未就绪');
            return false;
        }
        const protocol = window.HstarDirectorProtocol || window.parent?.HstarDirectorProtocol;
        const sceneKey = node.sceneKey || protocol?.createSceneKey?.('classic', currentCanvasId(), node.id) || `director:classic:${currentCanvasId()}:${node.id}`;
        node.sceneKey = sceneKey;
        host.openNodeSession({
            mode: 'node',
            canvasType: 'classic',
            canvasId: currentCanvasId(),
            nodeId: node.id,
            frameId: window.frameElement?.id || 'frame-canvas',
            sceneKey,
            instanceId: sceneKey
        }, resolveDirectorPanorama(node));
        scheduleSave();
        return true;
    }

    function normalizeCapture(capture, index){
        const url = capture?.url || capture?.imageUrl || capture?.dataUrl || '';
        if(!url) return null;
        return {
            url,
            name: safeText(capture.name || capture.fileName, `director-capture-${index + 1}.png`),
            kind: 'image',
            directorCapture: true,
            directorIndex: index
        };
    }

    function fallbackPoint(){
        return typeof defaultPoint === 'function' ? defaultPoint(160, 0) : { x: 80, y: 80 };
    }

    function directorImportPoint(source){
        if(!source) return fallbackPoint();
        const baseW = Number(source.w || 320);
        return {
            x: Number(source.x || 0) + baseW + 90,
            y: Number(source.y || 0)
        };
    }

    function createDirectorImageNode(image, point, meta={}){
        const p = point || fallbackPoint();
        const node = {
            id: uid('img'),
            type: 'image',
            x: p.x,
            y: p.y,
            w: 260,
            h: 336,
            url: image.url,
            name: image.name || (typeof outputImageName === 'function' ? outputImageName(image.url) : 'director-capture.png'),
            mediaKind: 'image',
            directorCapture: true,
            directorSourceNodeId: meta.sourceNodeId || '',
            directorRequestId: meta.requestId || '',
            sourceType: 'director-3d'
        };
        nodes.push(node);
        return node;
    }

    function createDirectorImageGroup(images, point, meta={}){
        const base = point || fallbackPoint();
        const cardW = 260;
        const cardH = 336;
        const gap = 24;
        const cols = Math.min(4, Math.max(1, Math.ceil(Math.sqrt(images.length))));
        const imageNodes = images.map((image, index) => {
            const col = index % cols;
            const row = Math.floor(index / cols);
            return createDirectorImageNode(image, {
                x: base.x + 24 + col * (cardW + gap),
                y: base.y + 58 + row * (cardH + gap)
            }, meta);
        });
        const rows = Math.ceil(images.length / cols);
        const group = {
            id: uid('grp'),
            type: 'group',
            x: base.x,
            y: base.y,
            w: cols * cardW + (cols - 1) * gap + 48,
            h: rows * cardH + (rows - 1) * gap + 90,
            items: imageNodes.map(img => img.id),
            directorCapture: true,
            directorSourceNodeId: meta.sourceNodeId || '',
            directorRequestId: meta.requestId || '',
            sourceType: 'director-3d'
        };
        nodes.push(group);
        return group;
    }

    async function importDirectorCaptures(payload){
        const requestId = safeText(payload?.requestId, '');
        if(requestId && appliedRequests.has(requestId)) return null;
        const captures = Array.isArray(payload?.captures) ? payload.captures : [];
        if(!captures.length) throw new Error('Director captures are empty');
        const originNodeId = payload?.originNodeId || payload?.context?.nodeId;
        const source = originNodeId ? (nodes || []).find(n => n.id === originNodeId && n.type === 'director-3d') : null;
        if(originNodeId && !source) throw new Error('未找到3D导演台来源节点');
        const images = captures.map(normalizeCapture).filter(Boolean);
        if(images.length !== captures.length) throw new Error('3D导演台截图数据不完整');
        if(requestId) appliedRequests.add(requestId);
        pushUndo();
        const importPoint = directorImportPoint(source);
        const meta = { sourceNodeId: source?.id || '', requestId: requestId || uid('director_request') };
        const imported = images.length === 1
            ? createDirectorImageNode(images[0], importPoint, meta)
            : createDirectorImageGroup(images, importPoint, meta);
        if(!imported) throw new Error('Unable to create director capture image node');
        if(source && !connections.some(conn => conn.from === source.id && conn.to === imported.id)){
            connections.push({ id: uid('c'), from: source.id, to: imported.id });
        }
        if(source) source.directorLastCaptureAt = Date.now();
        selected.clear();
        selected.add(imported.id);
        render();
        scheduleSave();
        if(typeof saveCanvas === 'function') saveCanvas().catch(err => console.error('[HstarClassicDirectorAdapter] save failed', err));
        return imported;
    }

    function removeDirectorPanorama(payload){
        const nodeId = payload?.nodeId || payload?.context?.nodeId;
        const edgeId = payload?.edgeId;
        const before = (connections || []).length;
        connections = (connections || []).filter(conn => {
            if(edgeId) return conn.id !== edgeId;
            return conn.to !== nodeId;
        });
        if(connections.length !== before){
            render();
            scheduleSave();
            return true;
        }
        return false;
    }

    function handleMessage(event){
        if(event.origin !== window.location.origin) return;
        const data = event.data || {};
        if(data.type === 'hstar-director-captures'){
            if(data.context?.canvasType && data.context.canvasType !== 'classic') return;
            importDirectorCaptures({
                requestId: data.requestId,
                context: data.context,
                originNodeId: data.context?.nodeId,
                captures: data.captures
            }).catch(error => {
                console.error('[HstarClassicDirectorAdapter] import failed', error);
                alert(error.message || '3D导演台截图导入失败');
            });
        }
        if(data.type === 'hstar-director-standalone-captures'){
            if(data.targetCanvasType && data.targetCanvasType !== 'classic') return;
            if(data.targetCanvasId && currentCanvasId() && data.targetCanvasId !== currentCanvasId()) return;
            importDirectorCaptures({
                requestId: data.requestId,
                originNodeId: data.originNodeId,
                captures: data.captures
            }).catch(error => {
                console.error('[HstarClassicDirectorAdapter] standalone import failed', error);
                alert(error.message || '3D导演台截图导入失败');
            });
        }
    }

    window.addEventListener('message', handleMessage);
    window.HstarClassicDirectorAdapter = {
        canConnect,
        renderDirectorNode,
        openDirectorNode,
        resolveDirectorPanorama,
        importDirectorCaptures,
        removeDirectorPanorama
    };
})();
