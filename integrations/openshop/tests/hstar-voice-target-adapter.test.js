import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const testDir = dirname(fileURLToPath(import.meta.url));
const adapterPath = resolve(testDir, '..', '..', '..', 'static', 'js', 'voice-input-adapter.js');

describe('Hstar global voice target adapter', () => {
  let adapter;

  beforeEach(async () => {
    expect(existsSync(adapterPath), `${adapterPath} should exist`).toBe(true);
    document.body.innerHTML = '';
    delete window.HstarVoiceInputAdapter;
    window.eval(`${readFileSync(adapterPath, 'utf8')}\n//# sourceURL=voice-input-adapter.js`);
    adapter = window.HstarVoiceInputAdapter;
  });

  it('accepts natural-language inputs and rejects sensitive controls', () => {
    document.body.innerHTML = `
      <textarea id="prompt"></textarea>
      <input id="search" type="search">
      <input id="key" type="text" data-voice-input="off">
      <input id="password" type="password">
      <input id="number" type="number">
      <input id="readonly" type="text" readonly>
    `;

    expect(adapter.isEligible(document.querySelector('#prompt'))).toBe(true);
    expect(adapter.isEligible(document.querySelector('#search'))).toBe(true);
    expect(adapter.isEligible(document.querySelector('#key'))).toBe(false);
    expect(adapter.isEligible(document.querySelector('#password'))).toBe(false);
    expect(adapter.isEligible(document.querySelector('#number'))).toBe(false);
    expect(adapter.isEligible(document.querySelector('#readonly'))).toBe(false);
  });

  it('rejects a target hidden by an ancestor panel state', () => {
    document.body.innerHTML = `
      <section id="composer" style="opacity: 0; pointer-events: none">
        <textarea id="prompt"></textarea>
      </section>
    `;

    expect(adapter.isEligible(document.querySelector('#prompt'))).toBe(false);
  });

  it('accepts an explicitly enabled transparent input proxy in a visible panel', () => {
    document.body.innerHTML = `
      <section>
        <textarea id="fabric-proxy" data-voice-input="on" style="opacity: 0"></textarea>
      </section>
    `;

    expect(adapter.isEligible(document.querySelector('#fabric-proxy'))).toBe(true);
  });

  it('replaces one partial composition and commits one undo transaction', () => {
    document.body.innerHTML = '<textarea id="prompt"></textarea>';
    const prompt = document.querySelector('#prompt');
    prompt.value = '前 后';
    prompt.setSelectionRange(2, 2);

    const transaction = adapter.begin(prompt);
    transaction.update('你');
    transaction.update('你好');
    transaction.commit('你好。');

    expect(prompt.value).toBe('前 你好。后');
    expect(adapter.undo(prompt)).toBe(true);
    expect(prompt.value).toBe('前 后');
  });

  it('keeps the caret after partial and final text across consecutive phrases', () => {
    document.body.innerHTML = '<textarea id="prompt">前后</textarea>';
    const prompt = document.querySelector('#prompt');
    prompt.focus();
    prompt.setSelectionRange(1, 1);

    const first = adapter.begin(prompt);
    first.update('第一');
    expect([prompt.selectionStart, prompt.selectionEnd]).toEqual([3, 3]);
    first.commit('第一句');
    expect([prompt.selectionStart, prompt.selectionEnd]).toEqual([4, 4]);

    const second = adapter.begin(prompt);
    second.update('第二');
    second.commit('第二句');

    expect(prompt.value).toBe('前第一句第二句后');
    expect([prompt.selectionStart, prompt.selectionEnd]).toEqual([7, 7]);
  });

  it('moves a contenteditable selection after committed dictation', () => {
    document.body.innerHTML = '<div id="editor" contenteditable="true">前后</div>';
    const editor = document.querySelector('#editor');
    Object.defineProperty(editor, 'isContentEditable', {value: true});
    const range = document.createRange();
    range.setStart(editor.firstChild, 1);
    range.collapse(true);
    getSelection().removeAllRanges();
    getSelection().addRange(range);

    const transaction = adapter.begin(editor);
    transaction.update('中');
    transaction.commit('中间');

    expect(editor.textContent).toBe('前中间后');
    const committed = getSelection().getRangeAt(0);
    expect(committed.collapsed).toBe(true);
    expect(committed.startContainer).toBe(editor);
    expect(committed.startOffset).toBe(2);
  });

  it('routes Ctrl+Z through the voice transaction undo stack', () => {
    document.body.innerHTML = '<textarea id="prompt"></textarea>';
    const prompt = document.querySelector('#prompt');
    prompt.value = '前缀旧内容后缀';
    prompt.setSelectionRange(2, 5);
    prompt.focus();

    const transaction = adapter.begin(prompt);
    transaction.update('测试语音');
    transaction.commit('测试语音完成。');
    expect(prompt.value).toBe('前缀测试语音完成。后缀');

    const event = new KeyboardEvent('keydown', {
      key: 'z',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    prompt.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(prompt.value).toBe('前缀旧内容后缀');
  });

  it('fires beforeinput before mutation, input after mutation, and honors cancellation', () => {
    document.body.innerHTML = '<textarea id="prompt"></textarea>';
    const prompt = document.querySelector('#prompt');
    prompt.value = '原文';
    prompt.setSelectionRange(2, 2);
    const observations = [];
    prompt.addEventListener('beforeinput', event => {
      observations.push(`before:${prompt.value}:${event.inputType}`);
      if (event.data === '拒绝') event.preventDefault();
    });
    prompt.addEventListener('input', event => {
      observations.push(`after:${prompt.value}:${event.inputType}`);
    });

    const transaction = adapter.begin(prompt);
    transaction.update('临时');
    transaction.update('拒绝');

    expect(prompt.value).toBe('原文临时');
    expect(observations).toEqual([
      'before:原文:insertCompositionText',
      'after:原文临时:insertCompositionText',
      'before:原文临时:insertCompositionText',
    ]);
  });

  it('delegates registered custom editors without changing their DOM', () => {
    const editor = document.createElement('div');
    document.body.append(editor);
    const transaction = {
      updateComposition: vi.fn(),
      commitComposition: vi.fn(),
      cancelComposition: vi.fn(),
    };
    adapter.register(editor, {
      isTargetAvailable: () => true,
      beginComposition: () => transaction,
      getTargetLabel: () => 'OpenShop prompt',
    });

    const active = adapter.begin(editor);
    active.update('测试');
    active.commit('完成');

    expect(transaction.updateComposition).toHaveBeenCalledWith('测试');
    expect(transaction.commitComposition).toHaveBeenCalledWith('完成');
    expect(editor.textContent).toBe('');
  });

  it('removes registered targets from both adapter indexes when unregistered', () => {
    const editor = document.createElement('div');
    document.body.append(editor);
    const unregister = adapter.register(editor, {
      isTargetAvailable: () => true,
      beginComposition: () => ({
        updateComposition() {},
        commitComposition() {},
        cancelComposition() {},
      }),
    });
    editor.tabIndex = 0;
    editor.focus();
    let id = '';
    window.addEventListener('hstar-voice-target-command', event => {
      id = event.detail?.targetId || '';
    }, {once: true});
    editor.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Q', shiftKey: true, bubbles: true, cancelable: true,
    }));

    expect(id).toBeTruthy();
    expect(adapter.getTargetById(id)).toBe(editor);
    unregister();

    expect(adapter.getTargetById(id)).toBeNull();
    expect(adapter.isEligible(editor)).toBe(false);
  });

  it('releases an ordinary detached textarea from the target index', async () => {
    document.body.innerHTML = '<textarea id="prompt"></textarea>';
    const prompt = document.querySelector('#prompt');
    prompt.focus();
    let id = '';
    window.addEventListener('hstar-voice-target-command', event => {
      id = event.detail?.targetId || '';
    }, {once: true});
    prompt.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Q', shiftKey: true, bubbles: true, cancelable: true,
    }));
    expect(adapter.getTargetById(id)).toBe(prompt);

    prompt.remove();
    prompt.dispatchEvent(new FocusEvent('focusout', {bubbles: true}));
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(adapter.getTargetById(id)).toBeNull();
  });
});
