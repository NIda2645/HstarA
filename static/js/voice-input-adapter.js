(function installHstarVoiceInputAdapter(global) {
  'use strict';

  if (!global || global.HstarVoiceInputAdapter) return;

  const customAdapters = new WeakMap();
  const undoStacks = new WeakMap();
  const targetIds = new WeakMap();
  const targetsById = new Map();
  let targetSequence = 0;
  let activeTarget = null;
  let imeComposing = false;
  let shortcut = 'Shift+Q';

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

  function isHidden(target) {
    if (!target || target.hidden || target.closest?.('[hidden],[aria-hidden="true"]')) return true;
    const style = global.getComputedStyle?.(target);
    return style?.display === 'none' || style?.visibility === 'hidden';
  }

  function isEligible(target) {
    if (!(target instanceof Element) || isHidden(target)) return false;
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
    return () => customAdapters.delete(target);
  }

  function targetId(target) {
    let id = targetIds.get(target);
    if (!id) {
      id = `voice-target-${++targetSequence}`;
      targetIds.set(target, id);
      targetsById.set(id, target);
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

  function postToCoordinator(type, target) {
    if (global.parent === global) return;
    global.parent.postMessage({
      type,
      targetId: target ? targetId(target) : '',
      label: target ? labelFor(target) : '',
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
    activeTarget = target;
    postToCoordinator('hstar-voice-target-active', target);
  }

  function onFocusOut() {
    global.setTimeout(() => {
      if (activeTarget && document.activeElement !== activeTarget && !activeTarget.contains?.(document.activeElement)) {
        postToCoordinator('hstar-voice-target-lost', activeTarget);
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

  function onKeyDown(event) {
    if (imeComposing || event.isComposing || !shortcutMatches(event)) return;
    const target = isEligible(event.target) ? event.target : activeTarget;
    if (!target || !isEligible(target)) return;
    event.preventDefault();
    postToCoordinator('hstar-voice-target-command', target);
    global.dispatchEvent(new CustomEvent('hstar-voice-target-command', {
      detail: {target, targetId: targetId(target), label: labelFor(target)},
    }));
  }

  function onPageHide() {
    if (activeTarget) postToCoordinator('hstar-voice-target-lost', activeTarget);
    activeTarget = null;
  }

  document.addEventListener('focusin', onFocusIn, true);
  document.addEventListener('focusout', onFocusOut, true);
  document.addEventListener('compositionstart', () => { imeComposing = true; }, true);
  document.addEventListener('compositionend', () => { imeComposing = false; }, true);
  document.addEventListener('keydown', onKeyDown, true);
  global.addEventListener('pagehide', onPageHide);

  global.HstarVoiceInputAdapter = Object.freeze({
    begin,
    isEligible,
    register,
    undo,
    getActiveTarget: () => activeTarget,
    getTargetById: id => targetsById.get(id) || null,
    setShortcut(value) {
      shortcut = String(value || '').trim();
    },
  });
})(typeof window !== 'undefined' ? window : null);
