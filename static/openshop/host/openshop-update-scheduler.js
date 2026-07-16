(function initOpenShopUpdateScheduler(root) {
  'use strict';

  function create({
    handlers = {},
    idleKeys = [],
    isVisible = () => true,
    frameRequest = root.requestAnimationFrame
      ? root.requestAnimationFrame.bind(root)
      : callback => root.setTimeout(callback, 16),
    idleRequest = root.requestIdleCallback
      ? callback => root.requestIdleCallback(callback, {timeout:250})
      : callback => root.setTimeout(() => callback({didTimeout:true, timeRemaining:() => 0}), 32),
    onError = () => {},
  } = {}) {
    const idleKeySet = new Set(idleKeys);
    const frameDirty = new Set();
    const idleDirty = new Set();
    let frameScheduled = false;
    let idleScheduled = false;
    let disposed = false;

    function invoke(key) {
      const handler = handlers[key];
      if (typeof handler !== 'function') return;
      try {
        handler();
      } catch (error) {
        onError(error, key);
      }
    }

    function runSet(dirtySet, keys = [...dirtySet]) {
      for (const key of keys) {
        if (!dirtySet.has(key)) continue;
        if (idleKeySet.has(key) && !isVisible(key)) continue;
        dirtySet.delete(key);
        invoke(key);
      }
    }

    function hasVisibleIdleWork() {
      return [...idleDirty].some(key => isVisible(key));
    }

    function schedule({includeHiddenIdle = true} = {}) {
      if (disposed) return;
      if (frameDirty.size && !frameScheduled) {
        frameScheduled = true;
        frameRequest(() => {
          frameScheduled = false;
          if (disposed) return;
          runSet(frameDirty);
          schedule({includeHiddenIdle:false});
        });
      }
      if (
        idleDirty.size
        && !idleScheduled
        && (includeHiddenIdle || hasVisibleIdleWork())
      ) {
        idleScheduled = true;
        idleRequest(() => {
          idleScheduled = false;
          if (disposed) return;
          runSet(idleDirty);
          schedule({includeHiddenIdle:false});
        });
      }
    }

    function markDirty(key) {
      if (disposed || typeof handlers[key] !== 'function') return;
      (idleKeySet.has(key) ? idleDirty : frameDirty).add(key);
    }

    return Object.freeze({
      request(...keys) {
        keys.flat().forEach(markDirty);
        schedule();
      },
      flushVisible(...keys) {
        if (disposed) return;
        const requested = keys.flat();
        runSet(frameDirty, requested);
        runSet(idleDirty, requested);
        schedule({includeHiddenIdle:false});
      },
      isDirty(key) {
        return frameDirty.has(key) || idleDirty.has(key);
      },
      dispose() {
        disposed = true;
        frameDirty.clear();
        idleDirty.clear();
      },
    });
  }

  root.HstarOpenShopUpdateScheduler = Object.freeze({create});
})(window);
