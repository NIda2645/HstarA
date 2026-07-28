(() => {
    const webview = window.chrome?.webview;
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
