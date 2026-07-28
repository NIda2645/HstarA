(function installHstarVoiceInputAdapter(global) {
  'use strict';

  if (!global || global.HstarVoiceInputAdapter) return;

  const customAdapters = new WeakMap();
  const undoStacks = new WeakMap();
  const targetIds = new WeakMap();
  const targetsById = new Map();
  const WeakTargetRef = typeof global.WeakRef === 'function'
    ? global.WeakRef
    : (typeof WeakRef === 'function' ? WeakRef : null);
  const childFrameIds = new WeakMap();
  let targetSequence = 0;
  let childFrameSequence = 0;
  let activeTarget = null;
  let activeGeneration = 0;
  let geometryFrame = 0;
  let imeComposing = false;
  let shortcut = 'Shift+Q';
  const targetObserver = typeof global.ResizeObserver === 'function'
    ? new global.ResizeObserver(() => scheduleGeometry())
    : null;

  function inputEvent(type, options) {
    try {
      return new InputEvent(type, options);
    } catch (_error) {
      const event = new Event(type, {
        bubbles: Boolean(options.bubbles),
        cancelable: Boolean(options.cancelable),
      });
      for (const key of ['inputType', 'data', 'isComposing']) {
        Object.defineProperty(event, key, {value: options[key], configurable: true});
      }
      return event;
    }
  }

  function dispatchBeforeInput(target, inputType, data, isComposing) {
    return target.dispatchEvent(inputEvent('beforeinput', {
      bubbles: true,
      cancelable: true,
      inputType,
      data,
      isComposing,
    }));
  }

  function dispatchAfterInput(target, inputType, data, isComposing) {
    target.dispatchEvent(inputEvent('input', {
      bubbles: true,
      cancelable: false,
      inputType,
      data,
      isComposing,
    }));
  }

  function placeTextControlCaret(target, offset) {
    target.focus?.({preventScroll: true});
    target.setSelectionRange(offset, offset);
  }

  function placeCaretAfter(node) {
    const selection = global.getSelection?.();
    if (!selection || !node?.isConnected) return;
    const range = global.document.createRange();
    range.setStartAfter(node);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function isHidden(target) {
    if (!target) return true;
    for (let node = target; node instanceof Element; node = node.parentElement) {
      if (node.hidden || node.getAttribute?.('aria-hidden') === 'true') return true;
      const style = global.getComputedStyle?.(node);
      if (
        style?.display === 'none'
        || ['hidden', 'collapse'].includes(style?.visibility)
        || style?.contentVisibility === 'hidden'
        || (node !== target && Number.parseFloat(style?.opacity || '1') === 0)
      ) return true;
    }
    return false;
  }

  function isEligible(target) {
    if (!(target instanceof Element) || !target.isConnected || isHidden(target)) return false;
    const registered = customAdapters.get(target);
    if (registered) return registered.isTargetAvailable?.() !== false;
    if (target.matches('[data-voice-input="off"],:disabled,[readonly]')) return false;
    if (target.matches('[data-voice-input="on"]')) return true;
    if (target instanceof HTMLTextAreaElement) return true;
    if (target instanceof HTMLInputElement) {
      return ['text', 'search'].includes(String(target.type || 'text').toLowerCase());
    }
    return Boolean(target.isContentEditable);
  }

  function pushUndo(target, record) {
    const stack = undoStacks.get(target) || [];
    stack.push(record);
    if (stack.length > 50) stack.shift();
    undoStacks.set(target, stack);
  }

  function replaceTextRange(target, start, end, text, inputType, isComposing) {
    if (!dispatchBeforeInput(target, inputType, text, isComposing)) return false;
    target.setRangeText(text, start, end, 'end');
    placeTextControlCaret(target, start + text.length);
    dispatchAfterInput(target, inputType, text, isComposing);
    return true;
  }

  function beginTextControl(target) {
    const before = target.value;
    const start = target.selectionStart ?? before.length;
    const selectedEnd = target.selectionEnd ?? start;
    let compositionEnd = selectedEnd;
    let closed = false;
    return {
      update(text) {
        if (closed) return false;
        const value = String(text ?? '');
        if (!replaceTextRange(
          target, start, compositionEnd, value, 'insertCompositionText', true
        )) return false;
        compositionEnd = start + value.length;
        return true;
      },
      commit(text) {
        if (closed) return false;
        const value = String(text ?? '');
        if (!replaceTextRange(
          target, start, compositionEnd, value, 'insertFromDictation', false
        )) return false;
        compositionEnd = start + value.length;
        closed = true;
        pushUndo(target, {
          kind: 'text',
          before,
          after: target.value,
          selectionStart: start,
          selectionEnd: selectedEnd,
        });
        return true;
      },
      cancel() {
        if (closed) return false;
        if (!dispatchBeforeInput(target, 'deleteCompositionText', null, false)) return false;
        target.value = before;
        target.setSelectionRange(start, selectedEnd);
        dispatchAfterInput(target, 'deleteCompositionText', null, false);
        closed = true;
        return true;
      },
    };
  }

  function selectionRangeInside(target) {
    const selection = global.getSelection?.();
    if (selection?.rangeCount) {
      const selected = selection.getRangeAt(0);
      if (target.contains(selected.commonAncestorContainer)) return selected.cloneRange();
    }
    const range = document.createRange();
    range.selectNodeContents(target);
    range.collapse(false);
    return range;
  }

  function beginContentEditable(target) {
    const beforeHTML = target.innerHTML;
    const range = selectionRangeInside(target);
    let marker = null;
    let closed = false;

    function write(text, inputType, composing) {
      if (closed) return false;
      const value = String(text ?? '');
      if (!dispatchBeforeInput(target, inputType, value, composing)) return false;
      if (!marker) {
        range.deleteContents();
        marker = document.createElement('span');
        marker.dataset.voiceComposition = 'true';
        range.insertNode(marker);
      }
      marker.textContent = value;
      placeCaretAfter(marker);
      dispatchAfterInput(target, inputType, value, composing);
      return true;
    }

    return {
      update(text) {
        return write(text, 'insertCompositionText', true);
      },
      commit(text) {
        if (!write(text, 'insertFromDictation', false)) return false;
        const node = document.createTextNode(marker.textContent || '');
        marker.replaceWith(node);
        placeCaretAfter(node);
        marker = null;
        closed = true;
        pushUndo(target, {kind: 'html', before: beforeHTML, after: target.innerHTML});
        return true;
      },
      cancel() {
        if (closed) return false;
        if (!dispatchBeforeInput(target, 'deleteCompositionText', null, false)) return false;
        target.innerHTML = beforeHTML;
        dispatchAfterInput(target, 'deleteCompositionText', null, false);
        marker = null;
        closed = true;
        return true;
      },
    };
  }

  function beginCustom(target, adapter) {
    if (adapter.isTargetAvailable?.() === false) {
      throw new Error('Voice target is no longer available');
    }
    const transaction = adapter.beginComposition(adapter.getSelection?.());
    if (!transaction) throw new Error('Custom voice adapter did not create a transaction');
    return {
      update: text => transaction.updateComposition(String(text ?? '')),
      commit: text => transaction.commitComposition(String(text ?? '')),
      cancel: () => transaction.cancelComposition(),
    };
  }

  function begin(target) {
    if (!isEligible(target)) throw new Error('Target is not eligible for voice input');
    const custom = customAdapters.get(target);
    if (custom) return beginCustom(target, custom);
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
      return beginTextControl(target);
    }
    if (target.isContentEditable) return beginContentEditable(target);
    throw new Error('No voice transaction adapter is registered for this target');
  }

  function captureSelection(target) {
    if (!target || !isEligible(target)) return null;
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
      return {
        kind: 'text',
        start: target.selectionStart ?? target.value.length,
        end: target.selectionEnd ?? target.value.length,
      };
    }
    if (target.isContentEditable) {
      const selection = global.getSelection?.();
      if (selection?.rangeCount) {
        const range = selection.getRangeAt(0);
        if (target.contains(range.commonAncestorContainer)) {
          return {kind: 'range', range: range.cloneRange()};
        }
      }
    }
    const custom = customAdapters.get(target);
    return custom?.getSelection ? {kind: 'custom', value: custom.getSelection()} : {kind: 'focus'};
  }

  function restoreSelection(target, snapshot) {
    if (!target || !isEligible(target)) return false;
    target.focus?.({preventScroll: true});
    if (snapshot?.kind === 'text') {
      target.setSelectionRange(snapshot.start, snapshot.end);
    } else if (snapshot?.kind === 'range' && snapshot.range) {
      const selection = global.getSelection?.();
      if (selection) {
        selection.removeAllRanges();
        selection.addRange(snapshot.range);
      }
    } else if (snapshot?.kind === 'custom') {
      customAdapters.get(target)?.restoreSelection?.(snapshot.value);
    }
    return true;
  }

  function undo(target) {
    const stack = undoStacks.get(target);
    const record = stack?.[stack.length - 1];
    if (!record) return false;
    const current = record.kind === 'text' ? target.value : target.innerHTML;
    if (current !== record.after) return false;
    if (!dispatchBeforeInput(target, 'historyUndo', null, false)) return false;
    if (record.kind === 'text') {
      target.value = record.before;
      target.setSelectionRange(record.selectionStart, record.selectionEnd);
    } else {
      target.innerHTML = record.before;
    }
    stack.pop();
    dispatchAfterInput(target, 'historyUndo', null, false);
    return true;
  }

  function register(target, adapter) {
    if (!(target instanceof Element) || !adapter || typeof adapter.beginComposition !== 'function') {
      throw new TypeError('A custom voice target and beginComposition adapter are required');
    }
    customAdapters.set(target, adapter);
    return () => {
      customAdapters.delete(target);
      const id = targetIds.get(target);
      if (id && indexedTarget(id) === target) targetsById.delete(id);
      targetIds.delete(target);
    };
  }

  function indexedTarget(id) {
    const reference = targetsById.get(id);
    const target = reference?.deref ? reference.deref() : reference;
    if (!target || !target.isConnected) {
      targetsById.delete(id);
      return null;
    }
    return target;
  }

  function targetId(target) {
    let id = targetIds.get(target);
    if (!id) {
      id = `voice-target-${++targetSequence}`;
      targetIds.set(target, id);
      targetsById.set(id, WeakTargetRef ? new WeakTargetRef(target) : target);
    }
    return id;
  }

  function labelFor(target) {
    const custom = customAdapters.get(target);
    return String(
      custom?.getTargetLabel?.()
      || target.getAttribute?.('data-voice-label')
      || target.getAttribute?.('aria-label')
      || target.getAttribute?.('placeholder')
      || '文本输入'
    );
  }

  function postToCoordinator(type, target, generation = activeGeneration) {
    if (global.parent === global) return;
    global.parent.postMessage({
      type,
      targetId: target ? targetId(target) : '',
      label: target ? labelFor(target) : '',
      generation,
      framePath: [],
    }, global.location.origin);
  }

  function scheduleGeometry() {
    if (!activeTarget || geometryFrame) return;
    const send = () => {
      geometryFrame = 0;
      if (activeTarget) postToCoordinator('hstar-voice-target-geometry', activeTarget);
    };
    if (typeof global.requestAnimationFrame === 'function') {
      geometryFrame = global.requestAnimationFrame(send);
    } else {
      send();
    }
  }

  function observeTarget(target) {
    targetObserver?.disconnect();
    if (target) targetObserver?.observe(target);
  }

  function childFrameFor(source) {
    for (const frame of document.querySelectorAll('iframe')) {
      if (frame.contentWindow === source) return frame;
    }
    return null;
  }

  function childFrameId(frame) {
    let id = childFrameIds.get(frame) || frame.dataset.hstarVoiceFrameId;
    if (!id) {
      id = `voice-frame-${++childFrameSequence}`;
      childFrameIds.set(frame, id);
      frame.dataset.hstarVoiceFrameId = id;
    }
    return id;
  }

  function onChildTargetMessage(event) {
    if (global.parent === global || event.origin !== global.location.origin) return;
    const data = event.data;
    if (!data || ![
      'hstar-voice-target-active',
      'hstar-voice-target-geometry',
      'hstar-voice-target-lost',
      'hstar-voice-target-command',
    ].includes(data.type)) return;
    const frame = childFrameFor(event.source);
    if (!frame) return;
    global.parent.postMessage({
      type: data.type,
      targetId: String(data.targetId || ''),
      label: String(data.label || ''),
      generation: Number.isFinite(Number(data.generation)) ? Number(data.generation) : 0,
      framePath: [childFrameId(frame), ...(Array.isArray(data.framePath) ? data.framePath : [])],
    }, global.location.origin);
  }

  function eligibleAncestor(node) {
    if (!(node instanceof Element)) return null;
    const candidate = node.closest('textarea,input,[contenteditable="true"],[data-voice-input="on"]');
    return candidate && isEligible(candidate) ? candidate : null;
  }

  function onFocusIn(event) {
    const target = eligibleAncestor(event.target) || (isEligible(event.target) ? event.target : null);
    if (!target) return;
    activeGeneration += 1;
    activeTarget = target;
    observeTarget(target);
    postToCoordinator('hstar-voice-target-active', target);
    scheduleGeometry();
  }

  function onFocusOut() {
    const lostTarget = activeTarget;
    const lostGeneration = activeGeneration;
    global.setTimeout(() => {
      if (!lostTarget || activeTarget !== lostTarget || activeGeneration !== lostGeneration) return;
      if (document.activeElement === lostTarget || lostTarget.contains?.(document.activeElement)) return;
      postToCoordinator('hstar-voice-target-lost', lostTarget, lostGeneration);
      activeTarget = null;
      observeTarget(null);
      if (!lostTarget.isConnected) {
        const id = targetIds.get(lostTarget);
        if (id) targetsById.delete(id);
      }
    }, 0);
  }

  function shortcutMatches(event) {
    if (!shortcut) return false;
    const pieces = shortcut.toLowerCase().split('+');
    const key = pieces.pop();
    return event.key.toLowerCase() === key
      && event.shiftKey === pieces.includes('shift')
      && event.ctrlKey === pieces.includes('ctrl')
      && event.altKey === pieces.includes('alt')
      && event.metaKey === pieces.includes('meta');
  }

  function undoShortcutMatches(event) {
    return event.key.toLowerCase() === 'z'
      && (event.ctrlKey || event.metaKey)
      && !event.shiftKey
      && !event.altKey;
  }

  function onKeyDown(event) {
    if (imeComposing || event.isComposing) return;
    const target = isEligible(event.target) ? event.target : activeTarget;
    if (!target || !isEligible(target)) return;
    if (undoShortcutMatches(event) && undo(target)) {
      event.preventDefault();
      return;
    }
    if (!shortcutMatches(event)) return;
    event.preventDefault();
    postToCoordinator('hstar-voice-target-command', target);
    global.dispatchEvent(new CustomEvent('hstar-voice-target-command', {
      detail: {target, targetId: targetId(target), label: labelFor(target)},
    }));
  }

  function onPageHide() {
    if (activeTarget) postToCoordinator('hstar-voice-target-lost', activeTarget);
    activeTarget = null;
    activeGeneration += 1;
    observeTarget(null);
    targetsById.clear();
    if (geometryFrame && typeof global.cancelAnimationFrame === 'function') {
      global.cancelAnimationFrame(geometryFrame);
      geometryFrame = 0;
    }
  }

  document.addEventListener('focusin', onFocusIn, true);
  document.addEventListener('focusout', onFocusOut, true);
  document.addEventListener('compositionstart', () => { imeComposing = true; }, true);
  document.addEventListener('compositionend', () => { imeComposing = false; }, true);
  document.addEventListener('keydown', onKeyDown, true);
  global.addEventListener('pagehide', onPageHide);
  global.addEventListener('resize', scheduleGeometry);
  global.addEventListener('scroll', scheduleGeometry, true);
  global.visualViewport?.addEventListener?.('resize', scheduleGeometry);
  global.visualViewport?.addEventListener?.('scroll', scheduleGeometry);
  global.addEventListener('message', onChildTargetMessage);

  global.HstarVoiceInputAdapter = Object.freeze({
    begin,
    captureSelection,
    isEligible,
    register,
    restoreSelection,
    undo,
    getActiveTarget: () => activeTarget,
    getTargetById: indexedTarget,
    setShortcut(value) {
      shortcut = String(value || '').trim();
    },
  });
})(typeof window !== 'undefined' ? window : null);
