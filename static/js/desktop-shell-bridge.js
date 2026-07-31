(() => {
    const webview = window.chrome?.webview;
    const pendingBatches = new Map();

    function normalizeBatchFiles(files) {
        return (Array.isArray(files) ? files : [])
            .map(file => ({
                url:String(file?.url || ''),
                filename:String(file?.filename || 'download').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').slice(0, 180) || 'download',
            }))
            .filter(file => file.url)
            .slice(0, 500);
    }

    function triggerFiles(files) {
        files.forEach(file => {
            const link = document.createElement('a');
            link.href = file.url;
            link.download = file.filename;
            document.body.appendChild(link);
            link.click();
            link.remove();
        });
    }

    async function saveBatch(files) {
        const normalized = normalizeBatchFiles(files);
        if (!normalized.length) return {accepted:false, count:0};
        if (!webview || typeof webview.postMessage !== 'function') {
            triggerFiles(normalized);
            return {accepted:true, count:normalized.length};
        }

        const requestId = crypto.randomUUID();
        const accepted = await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                pendingBatches.delete(requestId);
                reject(new Error('批量保存位置选择超时'));
            }, 300000);
            pendingBatches.set(requestId, value => {
                clearTimeout(timeout);
                resolve(value);
            });
            webview.postMessage({
                type:'hstar:download-batch',
                schemaVersion:1,
                requestId,
                fileNames:normalized.map(file => file.filename),
            });
        });
        if (!accepted) return {accepted:false, count:0};
        triggerFiles(normalized);
        return {accepted:true, count:normalized.length};
    }

    window.HstarDesktopDownloads = Object.freeze({saveBatch});

    webview?.addEventListener?.('message', event => {
        const data = event?.data || {};
        if (data.type !== 'hstar:download-batch-ready' || data.schemaVersion !== 1) return;
        const resolve = pendingBatches.get(String(data.requestId || ''));
        if (!resolve) return;
        pendingBatches.delete(String(data.requestId || ''));
        resolve(Boolean(data.accepted));
    });

    if (!webview || typeof webview.postMessage !== 'function') return;

    let sent = false;
    const nextFrame = () => new Promise(resolve => requestAnimationFrame(resolve));

    function studioIsReady() {
        if (document.readyState === 'loading') return false;
        if (document.documentElement.classList.contains('studio-route-booting')) return false;
        if (typeof window.switchUI !== 'function') return false;
        const sidebar = document.getElementById('studioSidebar');
        const activeFrame = document.querySelector('iframe.active');
        return Boolean(sidebar && activeFrame && !document.querySelector('[data-blocking-error="true"]'));
    }

    async function announceWhenInteractive() {
        while (!sent && !studioIsReady()) {
            await new Promise(resolve => setTimeout(resolve, 40));
        }
        if (sent) return;
        await nextFrame();
        await nextFrame();
        if (!studioIsReady()) return announceWhenInteractive();

        const navigationId = String(window.__HSTAR_NAVIGATION_ID__ || '');
        if (!navigationId) return;
        sent = true;
        webview.postMessage({
            type: 'hstar:interactive',
            schemaVersion: 1,
            navigationId
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', announceWhenInteractive, {once: true});
    } else {
        announceWhenInteractive();
    }
})();
