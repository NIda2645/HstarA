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

    function orderedSelection(layers, candidates) {
        const wanted = candidates instanceof Set ? candidates : new Set(candidates || []);
        return new Set(layers.filter(layer => wanted.has(layer)));
    }

    function resetLayerSelection(layers = [], preferred = null) {
        const primary = layers.includes(preferred) ? preferred : layers.at(-1) || null;
        return {
            selected: new Set(primary ? [primary] : []),
            primary,
            anchor: primary,
        };
    }

    function normalizeLayerSelection(layers = [], state = {}, preferred = null) {
        const selected = orderedSelection(layers, state.selected);
        let primary = selected.has(state.primary) ? state.primary : null;
        if (!primary && layers.length) {
            primary = layers.includes(preferred)
                ? preferred
                : [...selected].at(-1) || layers.at(-1);
            selected.add(primary);
        }
        const ordered = orderedSelection(layers, selected);
        const anchor = layers.includes(state.anchor) ? state.anchor : primary;
        return {selected:ordered, primary, anchor};
    }

    function selectLayerRange({layers = [], state = {}, layer = null, ctrl = false, shift = false} = {}) {
        const current = normalizeLayerSelection(layers, state, layer);
        if (!layers.includes(layer)) return current;

        if (shift) {
            const anchor = layers.includes(current.anchor) ? current.anchor : current.primary || layer;
            const start = layers.indexOf(anchor);
            const end = layers.indexOf(layer);
            const range = layers.slice(Math.min(start, end), Math.max(start, end) + 1);
            const selected = ctrl
                ? orderedSelection(layers, new Set([...current.selected, ...range]))
                : new Set(range);
            return {selected, primary:layer, anchor};
        }

        if (ctrl) {
            const selected = new Set(current.selected);
            if (selected.has(layer) && selected.size > 1) selected.delete(layer);
            else selected.add(layer);
            const ordered = orderedSelection(layers, selected);
            const primary = ordered.has(layer)
                ? layer
                : ordered.has(current.primary)
                    ? current.primary
                    : ordered.has(current.anchor)
                        ? current.anchor
                        : [...ordered].at(-1) || null;
            return {selected:ordered, primary, anchor:current.anchor || primary};
        }

        return resetLayerSelection(layers, layer);
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
        resetLayerSelection,
        normalizeLayerSelection,
        selectLayerRange,
        localizedToolTip,
        createToolTooltipController,
    });
})();
