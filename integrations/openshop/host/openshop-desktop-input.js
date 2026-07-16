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
    const TOOL_GROUP_LABELS = Object.freeze({
        v:'Move / Select Tool', m:'Marquee Tools', l:'Lasso Tool', w:'Selection Tools',
        c:'Crop Tool', b:'Brush Tools', j:'Healing Brush Tool', s:'Clone Stamp Tool',
        e:'Eraser Tool', g:'Fill Tools', o:'Toning Tools', r:'Smudge Tool', p:'Pen Tool',
        t:'Text Tool', u:'Shape Tools', i:'Sampling Tools', h:'Hand Tool', z:'Zoom Tool',
    });
    const COMMAND_SHORTCUTS = Object.freeze([
        {id:'command-palette', label:'Command Palette', keys:['Ctrl+Alt+K']},
        {id:'preferences', label:'Preferences', keys:['Ctrl+K']},
        {id:'new-document', label:'New Document', keys:['Ctrl+N']},
        {id:'open-image', label:'Open Image', keys:['Ctrl+O']},
        {id:'save-project', label:'Save Project', keys:['Ctrl+S']},
        {id:'export-settings', label:'Export Settings', keys:['Ctrl+Alt+Shift+W']},
        {id:'undo', label:'Undo', keys:['Ctrl+Z']},
        {id:'redo', label:'Redo', keys:['Ctrl+Shift+Z']},
        {id:'cut', label:'Cut', keys:['Ctrl+X']},
        {id:'copy', label:'Copy', keys:['Ctrl+C']},
        {id:'paste', label:'Paste', keys:['Ctrl+V']},
        {id:'duplicate-context', label:'Duplicate', keys:['Ctrl+J']},
        {id:'free-transform', label:'Free Transform', keys:['Ctrl+T']},
        {id:'select-all', label:'Select All', keys:['Ctrl+A']},
        {id:'deselect', label:'Deselect', keys:['Ctrl+D']},
        {id:'reselect', label:'Reselect', keys:['Ctrl+Shift+D']},
        {id:'invert-selection', label:'Inverse Selection', keys:['Ctrl+Shift+I']},
        {id:'invert-image', label:'Invert Image', keys:['Ctrl+I']},
        {id:'resize-canvas', label:'Resize Canvas', keys:['Ctrl+Alt+C']},
        {id:'levels', label:'Levels', keys:['Ctrl+L']},
        {id:'curves', label:'Curves', keys:['Ctrl+M']},
        {id:'color-balance', label:'Color Balance', keys:['Ctrl+B']},
        {id:'new-layer', label:'New Layer', keys:['Ctrl+Shift+N']},
        {id:'merge-context', label:'Merge Down', keys:['Ctrl+E']},
        {id:'merge-visible', label:'Merge Visible', keys:['Ctrl+Shift+E']},
        {id:'select-layer-below', label:'Select Layer Below', keys:['Alt+[']},
        {id:'select-layer-above', label:'Select Layer Above', keys:['Alt+]']},
        {id:'move-layers-down', label:'Move Layers Down', keys:['Ctrl+[']},
        {id:'move-layers-up', label:'Move Layers Up', keys:['Ctrl+]']},
        {id:'move-layers-bottom', label:'Move Layers to Bottom', keys:['Ctrl+Shift+[']},
        {id:'move-layers-top', label:'Move Layers to Top', keys:['Ctrl+Shift+]']},
        {id:'toggle-rulers', label:'Toggle Rulers', keys:['Ctrl+R']},
        {id:'toggle-grid', label:'Toggle Grid', keys:["Ctrl+'"]},
        {id:'zoom-fit', label:'Zoom Fit', keys:['Ctrl+0']},
        {id:'zoom-100', label:'Zoom 100%', keys:['Ctrl+1']},
        {id:'zoom-in', label:'Zoom In', keys:['Ctrl++', 'Ctrl+=']},
        {id:'zoom-out', label:'Zoom Out', keys:['Ctrl+-']},
        {id:'toggle-panels', label:'Toggle UI Panels', keys:['Tab']},
        {id:'cycle-screen-mode', label:'Cycle Screen Mode', keys:['F']},
        {id:'delete-context', label:'Delete Selected', keys:['Delete', 'Backspace']},
        {id:'commit-operation', label:'Apply Crop / Finish Pen', keys:['Enter']},
        {id:'cancel-operation', label:'Cancel / Deselect', keys:['Escape']},
        {id:'temporary-pan', label:'Temporary Pan', keys:['Space'], releaseCommand:'temporary-pan-release'},
        {id:'brush-size-down', label:'Decrease Brush Size', keys:['[']},
        {id:'brush-size-up', label:'Increase Brush Size', keys:[']']},
        {id:'default-colors', label:'Default Colors', keys:['D']},
        {id:'swap-colors', label:'Swap Colors', keys:['X']},
    ].map(descriptor => Object.freeze({...descriptor, keys:Object.freeze([...descriptor.keys])})));
    const COMMAND_BY_ID = new Map(COMMAND_SHORTCUTS.map(descriptor => [descriptor.id, descriptor]));
    const COMMAND_BY_KEY = new Map(COMMAND_SHORTCUTS.flatMap(descriptor => (
        descriptor.keys.map(key => [key, descriptor])
    )));

    function toolCycleForKey(key) {
        return [...(TOOL_CYCLES[String(key || '').toLowerCase()] || [])];
    }

    function toolShortcut(tool) {
        return TOOL_SHORTCUTS.get(String(tool || '')) || '';
    }

    function normalizedEventKey(value) {
        const key = String(value || '');
        const aliases = {
            ' ': 'Space',
            Spacebar: 'Space',
            Esc: 'Escape',
            Del: 'Delete',
            Add: '+',
            Subtract: '-',
            '{': '[',
            '}': ']',
            '"': "'",
        };
        if (aliases[key]) return aliases[key];
        return key.length === 1 && /[a-z]/i.test(key) ? key.toUpperCase() : key;
    }

    function eventShortcut(event) {
        const key = normalizedEventKey(event?.key);
        if (!key) return '';
        const parts = [];
        if (event?.ctrlKey || event?.metaKey) parts.push('Ctrl');
        if (event?.altKey) parts.push('Alt');
        if (event?.shiftKey && key !== '+') parts.push('Shift');
        parts.push(key);
        return parts.join('+');
    }

    function resolveShortcut(event, {currentTool = '', phase = 'keydown'} = {}) {
        const descriptor = COMMAND_BY_KEY.get(eventShortcut(event));
        if (descriptor) {
            if (phase === 'keyup') {
                return descriptor.releaseCommand ? {command:descriptor.releaseCommand} : null;
            }
            return {command:descriptor.id};
        }
        if (phase !== 'keydown' || event?.ctrlKey || event?.metaKey || event?.altKey) return null;
        const cycle = toolCycleForKey(normalizedEventKey(event?.key).toLowerCase());
        if (!cycle.length) return null;
        const currentIndex = cycle.indexOf(currentTool);
        const tool = event?.shiftKey
            ? cycle[(currentIndex + 1 + cycle.length) % cycle.length]
            : currentIndex >= 0 ? currentTool : cycle[0];
        return {command:'cycle-tool', tool};
    }

    function isEditableShortcutTarget(target, activeObject) {
        if (activeObject?.isEditing) return true;
        const element = target?.nodeType === 1 ? target : target?.parentElement;
        if (!element) return false;
        if (/^(INPUT|TEXTAREA|SELECT)$/i.test(element.tagName || '')) return true;
        if (element.isContentEditable) return true;
        const editable = element.closest?.('[contenteditable]');
        return Boolean(editable && editable.getAttribute('contenteditable') !== 'false');
    }

    function commandShortcut(commandId) {
        return COMMAND_BY_ID.get(String(commandId || ''))?.keys?.[0] || '';
    }

    function shortcutRows() {
        const commands = COMMAND_SHORTCUTS.map(descriptor => ({
            id:descriptor.id,
            label:descriptor.label,
            keys:[...descriptor.keys],
        }));
        const tools = Object.entries(TOOL_CYCLES).map(([key, cycle]) => ({
            id:`tool-${key}`,
            label:TOOL_GROUP_LABELS[key],
            keys:cycle.length > 1 ? [key.toUpperCase(), `Shift+${key.toUpperCase()}`] : [key.toUpperCase()],
        }));
        return [...commands, ...tools];
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
        resolveShortcut,
        isEditableShortcutTarget,
        commandShortcut,
        shortcutRows,
        resetLayerSelection,
        normalizeLayerSelection,
        selectLayerRange,
        localizedToolTip,
        createToolTooltipController,
    });
})();
