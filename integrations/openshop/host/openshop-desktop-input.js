(() => {
    'use strict';

    const TOOL_CYCLES = Object.freeze({
        v: Object.freeze(['select']),
        m: Object.freeze(['marquee-rect', 'marquee-ellipse']),
        l: Object.freeze(['lasso']),
        w: Object.freeze(['magic-wand', 'ai-segment']),
        c: Object.freeze(['crop']),
        b: Object.freeze(['brush', 'pencil', 'spray']),
        j: Object.freeze(['healing']),
        s: Object.freeze(['clone']),
        e: Object.freeze(['eraser']),
        g: Object.freeze(['gradient', 'fill', 'pattern']),
        o: Object.freeze(['dodge', 'burn', 'sponge']),
        r: Object.freeze(['smudge']),
        p: Object.freeze(['pen']),
        t: Object.freeze(['text']),
        u: Object.freeze(['rect', 'circle', 'triangle', 'line', 'arrow', 'polygon', 'star']),
        i: Object.freeze(['eyedropper', 'measure', 'note']),
        h: Object.freeze(['pan']),
        z: Object.freeze(['zoom']),
    });
    const TOOL_SHORTCUTS = new Map(
        Object.entries(TOOL_CYCLES).flatMap(([key, tools]) => (
            tools.map(tool => [tool, key.toUpperCase()])
        ))
    );

    function toolCycleForKey(key) {
        return [...(TOOL_CYCLES[String(key || '').toLowerCase()] || [])];
    }

    function toolShortcut(tool) {
        return TOOL_SHORTCUTS.get(String(tool || '')) || '';
    }

    function localizedToolTip(button) {
        const label = String(button?.dataset?.tip || '').trim();
        const shortcut = toolShortcut(button?.dataset?.tool);
        return shortcut ? `${label}（${shortcut}）` : label;
    }

    function createToolTooltipController({root = document, delay = 250} = {}) {
        root.getElementById('tool-tooltip')?.remove();
        const tooltip = root.createElement('div');
        tooltip.id = 'tool-tooltip';
        tooltip.setAttribute('role', 'tooltip');
        root.body.appendChild(tooltip);

        let currentButton = null;
        let timer = 0;

        const clearTimer = () => {
            if (timer) clearTimeout(timer);
            timer = 0;
        };
        const hide = () => {
            clearTimer();
            currentButton = null;
            tooltip.classList.remove('visible');
        };
        const place = button => {
            const rect = button.getBoundingClientRect();
            const text = localizedToolTip(button);
            tooltip.textContent = text;
            button.setAttribute('aria-label', text);
            tooltip.style.left = `${rect.right + 10}px`;
            const height = tooltip.offsetHeight || 28;
            const half = height / 2;
            const top = Math.max(8 + half, Math.min(window.innerHeight - 8 - half, rect.top + rect.height / 2));
            tooltip.style.top = `${top}px`;
            tooltip.classList.add('visible');
        };
        const show = button => {
            clearTimer();
            currentButton = button;
            timer = setTimeout(() => {
                timer = 0;
                if (!currentButton?.isConnected) {
                    hide();
                    return;
                }
                place(currentButton);
            }, Math.max(0, Number(delay) || 0));
        };
        const toolButton = target => target?.closest?.('.tool-btn[data-tip]') || null;
        const enter = event => {
            const button = toolButton(event.target);
            if (button) show(button);
        };
        const leave = event => {
            const button = toolButton(event.target);
            if (button && event.relatedTarget instanceof Node && button.contains(event.relatedTarget)) return;
            hide();
        };
        const focusOut = event => {
            const button = toolButton(event.target);
            if (button && event.relatedTarget instanceof Node && button.contains(event.relatedTarget)) return;
            hide();
        };

        root.addEventListener('pointerover', enter);
        root.addEventListener('pointerout', leave);
        root.addEventListener('focusin', enter);
        root.addEventListener('focusout', focusOut);

        return {
            hide,
            refresh() {
                if (currentButton?.isConnected) place(currentButton);
            },
            destroy() {
                hide();
                root.removeEventListener('pointerover', enter);
                root.removeEventListener('pointerout', leave);
                root.removeEventListener('focusin', enter);
                root.removeEventListener('focusout', focusOut);
                tooltip.remove();
            },
        };
    }

    window.HstarOpenShopDesktopInput = Object.freeze({
        toolCycleForKey,
        toolShortcut,
        localizedToolTip,
        createToolTooltipController,
    });
})();
