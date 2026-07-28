# Global Voice Assistant Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make HstarA voice input stay bound to the focused text target, preserve the caret, start microphone permission promptly, render correctly in both themes, and reject short pauses and background noise without changing the 10-second inactivity shutdown.

**Architecture:** Keep one top-level `VoiceCoordinator` for UI, media, and service ownership, while each same-origin page uses the shared `VoiceTargetAdapter` for target lifecycle, selection, and geometry. Add a light runtime-readiness status so permission and model startup can run in parallel safely, and strengthen the existing server-side VAD with confirmation and adaptive energy gating.

**Tech Stack:** Browser JavaScript, DOM/iframe messaging, CSS custom properties and animations, Vitest with jsdom, Python 3.10 `unittest`, WebRTC VAD, FastAPI/WebSocket service, FunASR, Playwright.

**Execution constraint:** The user prohibits subagents. Execute this plan inline in the current worktree with `superpowers:executing-plans`; do not touch the stable port 5000 application or stage `data/asset_library.json`.

---

## File Map

- `static/js/voice-input-adapter.js`: target eligibility, selection snapshots, caret-safe composition, iframe lifecycle and geometry messages.
- `static/js/voice-assistant-coordinator.js`: active-target state, floating control, start/stop state machine, permission and model startup orchestration.
- `static/css/voice-assistant.css`: light/dark button colors, readable status surface, and rainbow recognition ring.
- `static/index.html`: cache-busting versions for the shared voice CSS and coordinator script.
- `voice_assistant/installer.py`: public, side-effect-free runtime readiness detection.
- `voice_assistant/manager.py`: runtime readiness in the lightweight status response.
- `voice_assistant/audio.py`: speech confirmation, adaptive PCM energy gate, 1.3-second hangover, and 10-second silence behavior.
- `voice_assistant/service.py`: use the stricter VAD profile and continue emitting only accepted utterances.
- `tests/test_voice_installer.py`: runtime readiness marker coverage.
- `tests/test_voice_audio.py`: noise, confirmation, short-pause, and timeout coverage.
- `integrations/openshop/tests/hstar-voice-target-adapter.test.js`: caret and contenteditable transaction coverage.
- `integrations/openshop/tests/hstar-voice-coordinator.test.js`: lifecycle, positioning, theme contract, and startup ordering coverage.
- `integrations/openshop/tests/hstar-voice-assistant.e2e.spec.js`: focused-target, page-switch, and visual-state browser regression.
- `integrations/openshop/tests/hstar-voice-assistant-real.e2e.spec.js`: full-model silence and continuous-speech verification.

### Task 1: Keep Every Voice Transaction at the Latest Caret

**Files:**
- Modify: `integrations/openshop/tests/hstar-voice-target-adapter.test.js`
- Modify: `static/js/voice-input-adapter.js`

- [ ] **Step 1: Write failing textarea and contenteditable caret tests**

Add tests that prove partial updates, a final commit, and the next transaction all advance from the latest inserted text:

```javascript
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
  expect(committed.startContainer.textContent).toContain('中间');
  expect(committed.startOffset).toBe(2);
});
```

- [ ] **Step 2: Run the focused adapter tests and verify failure**

Run from `integrations/openshop`:

```powershell
npm run test:unit -- tests/hstar-voice-target-adapter.test.js
```

Expected: at least one new assertion fails because the contenteditable range is not restored after writing, or the next transaction starts at the old selection.

- [ ] **Step 3: Add explicit caret restoration helpers**

Implement native and contenteditable caret placement and call it after every successful update and commit:

```javascript
function placeTextControlCaret(target, offset) {
  target.focus({preventScroll: true});
  target.setSelectionRange(offset, offset);
}

function placeCaretAfter(node) {
  const selection = global.getSelection?.();
  if (!selection || !node?.isConnected) return;
  const next = document.createRange();
  next.setStartAfter(node);
  next.collapse(true);
  selection.removeAllRanges();
  selection.addRange(next);
}
```

For `input` and `textarea`, call `placeTextControlCaret(target, compositionEnd)` after `setRangeText`. For `contenteditable`, place the range after the composition marker on partial updates and after the committed text node on final commits. Preserve the existing beforeinput/input and undo behavior.

- [ ] **Step 4: Run the focused adapter tests and verify success**

Run:

```powershell
npm run test:unit -- tests/hstar-voice-target-adapter.test.js
```

Expected: all target-adapter tests pass.

- [ ] **Step 5: Commit the caret fix**

```powershell
git add static/js/voice-input-adapter.js integrations/openshop/tests/hstar-voice-target-adapter.test.js
git commit -m "fix: keep voice dictation at the latest caret"
```

### Task 2: Bind the Floating Control to One Live Target

**Files:**
- Modify: `integrations/openshop/tests/hstar-voice-coordinator.test.js`
- Modify: `static/js/voice-input-adapter.js`
- Modify: `static/js/voice-assistant-coordinator.js`

- [ ] **Step 1: Write failing lifecycle and focus-preservation tests**

Add coordinator tests for a still-connected iframe target sending `lost`, for the button preserving the target selection, and for geometry refresh:

```javascript
function nextAnimationFrame() {
  return new Promise(resolveFrame => requestAnimationFrame(() => resolveFrame()));
}

function dispatchFrameVoiceMessage(frame, type, targetId) {
  window.dispatchEvent(new MessageEvent('message', {
    origin: window.location.origin,
    source: frame.contentWindow,
    data: {type, targetId, label: '子页面提示词', framePath: []},
  }));
}

function attachVoiceFrame(harness, targetId) {
  const frame = document.createElement('iframe');
  document.body.append(frame);
  const childTarget = frame.contentDocument.createElement('textarea');
  frame.contentDocument.body.append(childTarget);
  frame.contentWindow.HstarVoiceInputAdapter = {
    getTargetById: id => id === targetId ? childTarget : null,
    isEligible: target => target === childTarget,
    begin: () => makeTransaction(),
  };
  harness.coordinator.attachFrame(frame);
  return {frame, childTarget};
}

it('clears a matching iframe target when it reports focus lost', async () => {
  const harness = makeHarness({renderUi: true});
  const {frame, childTarget} = attachVoiceFrame(harness, 'child-prompt');
  childTarget.getBoundingClientRect = () => ({left: 10, top: 20, right: 210, bottom: 80, width: 200, height: 60});
  dispatchFrameVoiceMessage(frame, 'hstar-voice-target-active', 'child-prompt');
  await nextAnimationFrame();
  expect(document.querySelector('.hstar-voice-entry').hidden).toBe(false);

  dispatchFrameVoiceMessage(frame, 'hstar-voice-target-lost', 'child-prompt');
  await nextAnimationFrame();
  expect(document.querySelector('.hstar-voice-entry').hidden).toBe(true);
});

it('does not blur or move the selection when the microphone is pressed', async () => {
  const harness = makeHarness({renderUi: true});
  const target = document.createElement('textarea');
  target.value = '前后';
  document.body.append(target);
  target.focus();
  target.setSelectionRange(1, 1);
  harness.coordinator.activateTarget(target);
  await nextAnimationFrame();

  document.querySelector('.hstar-voice-button').dispatchEvent(new PointerEvent('pointerdown', {
    bubbles: true,
    cancelable: true,
  }));

  expect(document.activeElement).toBe(target);
  expect([target.selectionStart, target.selectionEnd]).toEqual([1, 1]);
});
```

- [ ] **Step 2: Run coordinator tests and verify failure**

Run:

```powershell
npm run test:unit -- tests/hstar-voice-coordinator.test.js
```

Expected: the iframe target remains visible after `lost`, and pointer interaction lacks a guaranteed selection restore path.

- [ ] **Step 3: Add target identity, generation, and unconditional loss handling**

Add a target generation counter and these target-identity helpers:

```javascript
_sameTarget(left, right) {
  if (left === right) return true;
  return this._isFrameHandle(left)
    && this._isFrameHandle(right)
    && left.frame === right.frame
    && left.targetId === right.targetId
    && JSON.stringify(left.framePath || []) === JSON.stringify(right.framePath || []);
}

_clearActiveTarget(target, reason = 'target-lost') {
  if (!this._sameTarget(this._activeTarget, target)) return false;
  this._activeTarget = null;
  this._targetGeneration += 1;
  this._positionEntry();
  if (this._sameTarget(this._lockedTarget, target)) void this.stop(reason);
  return true;
}
```

Handle `hstar-voice-target-lost` by calling `_clearActiveTarget` directly. Do not gate loss on `_targetEligible`, because a blurred target can remain connected and eligible.

- [ ] **Step 4: Add geometry signals and visibility validation**

Have `VoiceTargetAdapter` schedule `hstar-voice-target-geometry` for the active target on `scroll`, `resize`, `visualViewport.scroll`, `visualViewport.resize`, and `ResizeObserver`. Forward this message through nested frames like the existing active/lost messages. In the coordinator, accept geometry messages only for the current target and schedule `_positionEntry`.

Before showing the control, require every resolved target and iframe to be connected and visible with positive width and height. A hidden or unloaded frame clears the matching target instead of retaining a stale floating control.

- [ ] **Step 5: Preserve selection on pointerdown**

Snapshot the active native or frame target selection when it activates. Bind the control with:

```javascript
button.addEventListener('pointerdown', event => {
  event.preventDefault();
  this._restoreTargetFocus(this._activeTarget);
});
```

Restore focus with `preventScroll` and restore native selection or the adapter-provided custom selection before the click handler starts or stops recording.

- [ ] **Step 6: Run adapter and coordinator tests**

Run:

```powershell
npm run test:unit -- tests/hstar-voice-target-adapter.test.js tests/hstar-voice-coordinator.test.js
```

Expected: both suites pass, including target loss, geometry, focus, and caret assertions.

- [ ] **Step 7: Commit lifecycle and positioning**

```powershell
git add static/js/voice-input-adapter.js static/js/voice-assistant-coordinator.js integrations/openshop/tests/hstar-voice-coordinator.test.js
git commit -m "fix: bind voice controls to live text targets"
```

### Task 3: Render a Theme-Safe Microphone, Status, and Rainbow Ring

**Files:**
- Modify: `integrations/openshop/tests/hstar-voice-coordinator.test.js`
- Modify: `static/css/voice-assistant.css`
- Modify: `static/js/voice-assistant-coordinator.js`
- Modify: `static/index.html`

- [ ] **Step 1: Write a failing stylesheet contract test**

Extend the stylesheet test with explicit application-theme and recognition-ring requirements:

```javascript
it('uses app themes for a contrasting microphone and rainbow recognition ring', () => {
  const stylesheet = readFileSync(stylesheetPath, 'utf8');
  expect(stylesheet).toMatch(/\.hstar-voice-button\s*\{[^}]*background:\s*#111/si);
  expect(stylesheet).toMatch(/(?:html|body)\.theme-dark[^{]*\.hstar-voice-button/);
  expect(stylesheet).toContain('conic-gradient');
  expect(stylesheet).toContain('[data-state="recognizing"] .hstar-voice-level');
  expect(stylesheet).toMatch(/\.hstar-voice-status\s*\{[^}]*background:/si);
});
```

- [ ] **Step 2: Run the stylesheet contract and verify failure**

Run:

```powershell
npm run test:unit -- tests/hstar-voice-coordinator.test.js
```

Expected: the explicit HstarA theme, status background, or rainbow-gradient assertion fails.

- [ ] **Step 3: Implement application-theme colors**

Use default light-mode tokens and explicit HstarA dark-mode overrides:

```css
:root {
  --hstar-voice-button-bg: #111111;
  --hstar-voice-button-fg: #ffffff;
  --hstar-voice-tip-bg: rgba(255, 255, 255, 0.96);
  --hstar-voice-tip-fg: #171717;
}

html.theme-dark,
html.studio-theme-dark,
body.theme-dark,
body.studio-theme-dark {
  --hstar-voice-button-bg: #f5f5f7;
  --hstar-voice-button-fg: #111111;
  --hstar-voice-tip-bg: rgba(24, 24, 27, 0.96);
  --hstar-voice-tip-fg: #fafafa;
}
```

Set the button background and icon color from these variables. Give `.hstar-voice-status` a contrasting background, border, padding, radius no greater than 6px, and a restrained shadow. Keep the existing 28px button footprint.

- [ ] **Step 4: Implement the recognition-only rainbow ring**

Replace the recognizing border animation with a masked 2px conic-gradient ring. Keep it transparent in all other states, rotate and pulse only in `recognizing`, and make the reduced-motion rule display a static ring.

```css
.hstar-voice-entry[data-state="recognizing"] .hstar-voice-level {
  opacity: 1;
  background: conic-gradient(#ff3b30, #ffcc00, #34c759, #00c7be, #0a84ff, #af52de, #ff3b30);
  animation: hstar-voice-rainbow 1.1s linear infinite,
             hstar-voice-ring-breathe 900ms ease-in-out infinite alternate;
}
```

- [ ] **Step 5: Ensure the icon always renders and bust stale assets**

Keep the Lucide `mic` element and add a deterministic visible fallback class after icon initialization. Update the voice CSS and coordinator query strings in `static/index.html` from their current `2026.07.20.*` values to `2026.07.26.2000000001` so port 3000 cannot retain the previous empty-circle UI.

- [ ] **Step 6: Run the coordinator suite**

Run:

```powershell
npm run test:unit -- tests/hstar-voice-coordinator.test.js
```

Expected: all coordinator UI and state-style tests pass.

- [ ] **Step 7: Commit the visual state changes**

```powershell
git add static/css/voice-assistant.css static/js/voice-assistant-coordinator.js static/index.html integrations/openshop/tests/hstar-voice-coordinator.test.js
git commit -m "feat: refine voice control themes and recognition state"
```

### Task 4: Expose Runtime Readiness Without Starting the Model

**Files:**
- Modify: `tests/test_voice_installer.py`
- Modify: `voice_assistant/installer.py`
- Modify: `voice_assistant/manager.py`

- [ ] **Step 1: Write failing runtime readiness tests**

Add installer coverage for no marker, a valid marker, and a package mismatch:

```python
def test_runtime_status_requires_matching_marker_and_site_packages(self):
    self.assertFalse(self.installer.runtime_status()["ready"])
    self.paths["runtime_site"].mkdir(parents=True)
    self.paths["state"].mkdir(parents=True, exist_ok=True)
    manifest = self.installer._load_runtime_manifest()
    (self.paths["state"] / "runtime-install.json").write_text(
        json.dumps({"profile": "cpu", "packages": manifest["packages"]}),
        encoding="utf-8",
    )
    self.assertEqual(
        self.installer.runtime_status(),
        {"ready": True, "profile": "cpu"},
    )
```

Add this manager assertion in `tests/test_voice_api.py`:

```python
async def test_manager_status_reports_runtime_without_starting_service(self):
    with tempfile.TemporaryDirectory() as root:
        manager = VoiceAssistantManager(
            app_data_root=root,
            load_settings=lambda: {},
            save_settings=lambda value: None,
            test_mode=True,
        )
        status = manager.status()
        self.assertEqual(status["runtime"], {"ready": False, "profile": ""})
        self.assertEqual(status["service"]["process_state"], "stopped")
```

Add `import tempfile` at the top of the test file.

- [ ] **Step 2: Run the installer/API tests and verify failure**

Run from the worktree root:

```powershell
python -m unittest tests.test_voice_installer tests.test_voice_api -v
```

Expected: `VoiceInstaller` has no `runtime_status` method or manager status lacks `runtime`.

- [ ] **Step 3: Implement side-effect-free runtime status**

Add a public method that reads the current runtime manifest and install marker, validates the recorded profile and package list, and verifies `runtime_site` exists:

```python
def runtime_status(self) -> dict[str, object]:
    manifest = self._load_runtime_manifest()
    marker = self.paths["state"] / "runtime-install.json"
    if not marker.is_file() or not self.paths["runtime_site"].is_dir():
        return {"ready": False, "profile": ""}
    try:
        installed = json.loads(marker.read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError):
        return {"ready": False, "profile": ""}
    profile = str(installed.get("profile") or "")
    ready = profile in manifest["profiles"] and installed.get("packages") == manifest["packages"]
    return {"ready": ready, "profile": profile if ready else ""}
```

Include `"runtime": self.installer.runtime_status()` in `VoiceAssistantManager.status()`.

- [ ] **Step 4: Run installer/API tests and verify success**

Run:

```powershell
python -m unittest tests.test_voice_installer tests.test_voice_api -v
```

Expected: all installer and API tests pass.

- [ ] **Step 5: Commit runtime readiness**

```powershell
git add voice_assistant/installer.py voice_assistant/manager.py tests/test_voice_installer.py tests/test_voice_api.py
git commit -m "feat: expose voice runtime readiness"
```

### Task 5: Request Permission in Parallel With Model Startup

**Files:**
- Modify: `integrations/openshop/tests/hstar-voice-coordinator.test.js`
- Modify: `static/js/voice-assistant-coordinator.js`

- [ ] **Step 1: Update status fixtures and write failing ordering tests**

Add `runtime: {ready: true, profile: 'cuda'}` to `readyStatus()`. Replace the old loading cancellation expectation with tests that verify immediate permission acquisition and cleanup:

```javascript
it('requests microphone permission while the model service is cold-starting', async () => {
  const service = deferred();
  const harness = makeHarness({fetchOverride: vi.fn(async url => {
    if (String(url).endsWith('/status')) return response(readyStatus());
    if (String(url).endsWith('/service/start')) return service.promise;
    throw new Error(`Unexpected request: ${url}`);
  })});
  harness.coordinator.activateTarget(document.createElement('textarea'));

  const start = harness.coordinator.start();
  await vi.waitFor(() => expect(harness.mediaDevices.getUserMedia).toHaveBeenCalledOnce());
  expect(harness.coordinator.state).toBe('loading');
  service.resolve(response({ok: true, service: {process_state: 'running'}}));
  await expect(start).resolves.toBe(true);
});

it('does not request permission when runtime readiness is false', async () => {
  const status = readyStatus();
  status.status.runtime = {ready: false, profile: ''};
  const harness = makeHarness({status});
  harness.coordinator.activateTarget(document.createElement('textarea'));
  await expect(harness.coordinator.start()).resolves.toBe(false);
  expect(harness.mediaDevices.getUserMedia).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run coordinator tests and verify failure**

Run:

```powershell
npm run test:unit -- tests/hstar-voice-coordinator.test.js
```

Expected: permission remains blocked behind `_startService`, or runtime readiness is not checked.

- [ ] **Step 3: Split media acquisition from socket setup and start in parallel**

Refactor `_openBrowserSession` into `_acquireMicrophone(generation)` and `_connectBrowserSession(generation)`. After status confirms `runtime.ready` and `model.ready`, settle permission and startup together so a late media grant cannot leak after another branch fails:

```javascript
const [mediaResult, serviceResult] = await Promise.allSettled([
  this._acquireMicrophone(generation),
  this._startService(),
]);
if (mediaResult.status === 'rejected') throw mediaResult.reason;
if (serviceResult.status === 'rejected') {
  for (const track of mediaResult.value.getTracks?.() || []) track.stop();
  throw serviceResult.reason;
}
const stream = mediaResult.value;
if (generation !== this._startGeneration) {
  for (const track of stream.getTracks?.() || []) track.stop();
  throw new VoiceCoordinatorError('VOICE_START_CANCELLED');
}
this._stream = stream;
await this._connectBrowserSession(generation);
```

Ensure `_acquireMicrophone` stops its stream when its generation is stale. If either branch rejects, `_releaseResources` stops any stream already stored. A stop during cold startup must leave state `ready` and release the track exactly once.

- [ ] **Step 4: Run coordinator tests and verify success**

Run:

```powershell
npm run test:unit -- tests/hstar-voice-coordinator.test.js
```

Expected: all startup, cancellation, missing model/runtime, and resource cleanup tests pass.

- [ ] **Step 5: Commit startup orchestration**

```powershell
git add static/js/voice-assistant-coordinator.js integrations/openshop/tests/hstar-voice-coordinator.test.js
git commit -m "perf: request voice permission during model startup"
```

### Task 6: Reject Noise and Keep Short Pauses in One Utterance

**Files:**
- Modify: `tests/test_voice_audio.py`
- Modify: `voice_assistant/audio.py`
- Modify: `voice_assistant/service.py`

- [ ] **Step 1: Write failing noise, confirmation, and pause tests**

Create deterministic PCM helpers and tests:

```python
def pcm_frame(amplitude):
    sample = int(amplitude).to_bytes(2, "little", signed=True)
    return sample * (FRAME_BYTES // 2)

def test_vad_positive_low_energy_noise_does_not_start_speech(self):
    session = VadSession(vad=FakeVad(True), clock=self.clock)
    for _ in range(25):
        event = session.accept_pcm(pcm_frame(8))
        self.clock.advance(0.02)
    self.assertFalse(event.speech_active)
    self.assertIsNone(event.partial_pcm)

def test_speech_requires_confirmation_but_keeps_pre_roll(self):
    session = VadSession(vad=FakeVad(True), clock=self.clock)
    for _ in range(5):
        event = session.accept_pcm(pcm_frame(3000))
        self.clock.advance(0.02)
    self.assertFalse(event.speech_active)
    event = session.accept_pcm(pcm_frame(3000))
    self.assertTrue(event.speech_active)

def test_half_second_pause_does_not_finalize_utterance(self):
    sequence = [True] * 10 + [False] * 25 + [True] * 10
    session = VadSession(vad=SequenceVad(sequence), clock=self.clock)
    finals = []
    for active in sequence:
        event = session.accept_pcm(pcm_frame(3000 if active else 0))
        finals.append(event.final_utterance_pcm)
        self.clock.advance(0.02)
    self.assertTrue(all(value is None for value in finals))
```

- [ ] **Step 2: Run audio tests and verify failure**

Run:

```powershell
python -m unittest tests.test_voice_audio -v
```

Expected: low-energy VAD positives start speech immediately, confirmation is absent, or the 0.5-second pause finalizes under the old behavior.

- [ ] **Step 3: Implement named audio thresholds and adaptive energy gating**

Add these module-level defaults and keep constructor overrides available for tests:

```python
DEFAULT_HANGOVER_SECONDS = 1.3
DEFAULT_SPEECH_CONFIRMATION_SECONDS = 0.12
DEFAULT_MIN_RMS = 0.003
DEFAULT_MIN_SNR_DB = 6.0
DEFAULT_NOISE_FLOOR = 0.001
```

Calculate normalized PCM16 RMS with `audioop.rms` or `array('h')` without importing NumPy or Torch into the service process before model load. Maintain an asymmetric noise-floor estimate only on frames that are not accepted as speech. Require both the wrapped VAD result and energy threshold for six consecutive 20ms frames, retaining candidates in pre-roll so confirmed speech includes its beginning. Rejected candidates do not update `last_speech_at`.

- [ ] **Step 4: Use the longer hangover and stricter WebRTC mode**

Set the default hangover to 1.3 seconds and instantiate `WebRtcVad(3)` in the real service. Keep `silence_seconds=10`. Ensure `flush()` only emits an utterance that passed confirmation and minimum energy; short rejected noise returns no final PCM.

- [ ] **Step 5: Run audio and service tests**

Run:

```powershell
python -m unittest tests.test_voice_audio tests.test_voice_testing -v
```

Expected: all noise, pause, partial, timeout, and service protocol tests pass.

- [ ] **Step 6: Commit VAD hardening**

```powershell
git add voice_assistant/audio.py voice_assistant/service.py tests/test_voice_audio.py
git commit -m "fix: suppress noise in realtime voice segmentation"
```

### Task 7: Verify Page Switching, Themes, and the Full FunASR Model

**Files:**
- Modify: `integrations/openshop/tests/hstar-voice-assistant.e2e.spec.js`
- Modify: `integrations/openshop/tests/hstar-voice-assistant-real.e2e.spec.js`

- [ ] **Step 1: Add browser lifecycle and theme tests**

Add a focused control lifecycle test using the existing isolated server:

```javascript
test('anchors the control, hides it on section switch, and applies both app themes', async () => {
  const {browser, context} = await launchVoiceBrowser();
  try {
    const page = await openMainPage(context);
    await page.evaluate(() => {
      const target = document.createElement('textarea');
      target.id = 'voice-anchor-target';
      target.dataset.voiceInput = 'on';
      target.style.cssText = 'position:fixed;left:220px;top:140px;width:320px;height:96px';
      document.body.append(target);
      target.focus();
    });
    const entry = page.locator('.hstar-voice-entry');
    await expect(entry).toBeVisible();
    const before = await page.evaluate(() => ({
      target: document.querySelector('#voice-anchor-target').getBoundingClientRect(),
      entry: document.querySelector('.hstar-voice-entry').getBoundingClientRect(),
    }));
    expect(Math.abs(before.entry.x - (before.target.right - 34))).toBeLessThanOrEqual(8);
    expect(Math.abs(before.entry.y - (before.target.top + 6))).toBeLessThanOrEqual(8);

    await page.setViewportSize({width: 1200, height: 820});
    const after = await page.evaluate(() => ({
      target: document.querySelector('#voice-anchor-target').getBoundingClientRect(),
      entry: document.querySelector('.hstar-voice-entry').getBoundingClientRect(),
    }));
    expect(Math.abs(after.entry.x - (after.target.right - 34))).toBeLessThanOrEqual(8);

    const light = await page.locator('.hstar-voice-button').evaluate(element => getComputedStyle(element).backgroundColor);
    await page.evaluate(() => {
      document.documentElement.classList.add('theme-dark', 'studio-theme-dark');
      document.body.classList.add('theme-dark', 'studio-theme-dark');
    });
    const dark = await page.locator('.hstar-voice-button').evaluate(element => getComputedStyle(element).backgroundColor);
    expect(light).not.toBe(dark);

    await page.evaluate(() => window.HstarVoiceAssistant._setState('recognizing'));
    const ring = await page.locator('.hstar-voice-level').evaluate(element => getComputedStyle(element).backgroundImage);
    expect(ring).toContain('conic-gradient');

    await page.evaluate(() => window.switchUI(null, 'gpt-chat'));
    await expect(entry).toBeHidden();
  } finally {
    await browser.close();
  }
});
```

- [ ] **Step 2: Run fake-service browser tests**

Run from `integrations/openshop`:

```powershell
npm run test:hstar:voice
```

Expected: all GPT, smart-canvas, OpenShop, focus, page-switch, theme, ring, caret, and 10-second timeout tests pass.

- [ ] **Step 3: Add real-model silence and short-pause assertions**

Extend the real-model event capture to retain event type and text, then assert the prepared official WAV produces one ordered non-empty transcript and that the trailing silence produces no later hallucinated text:

```javascript
const transcriptEvents = await page.evaluate(() => (
  (window.__hstarVoicePerformanceEvents || [])
    .filter(item => item.type === 'partial' || item.type === 'final')
    .map(item => ({type: item.type, text: item.text || ''}))
));
expect(transcriptEvents.some(item => item.type === 'final' && /时间早上九点至下午五点/.test(item.text))).toBe(true);
expect(transcriptEvents.every(item => item.text.trim().length > 0)).toBe(true);
const finalIndex = transcriptEvents.findLastIndex(item => item.type === 'final');
expect(transcriptEvents.slice(finalIndex + 1)).toEqual([]);
```

Update the page init listener to record `event.detail.type` and `event.detail.text`. Use the Python VAD test from Task 6 as the deterministic `0.5s` pause boundary test; the real-model browser test remains responsible for actual CUDA transcription and trailing-silence hallucination behavior.

- [ ] **Step 4: Run the full installed model test**

Run from `integrations/openshop` with the existing configured voice root:

```powershell
npx playwright test tests/hstar-voice-assistant-real.e2e.spec.js
```

Expected: the installed Fun-ASR-Nano-2512 loads on CUDA, valid Chinese audio is transcribed in order, 0.5-second silence does not split it prematurely, and zero/white-noise input produces no transcript.

- [ ] **Step 5: Run focused and broad regressions**

Run from the worktree root:

```powershell
python -m unittest tests.test_voice_audio tests.test_voice_testing tests.test_voice_installer tests.test_voice_api tests.test_voice_recognizer -v
Set-Location integrations\openshop
npm run test:unit -- tests/hstar-voice-target-adapter.test.js tests/hstar-voice-coordinator.test.js
npm run test:hstar:voice
```

Expected: every command exits with code 0 and reports no failed tests.

- [ ] **Step 6: Capture desktop visual evidence**

Use Playwright at 1440x1000 in both HstarA themes to save screenshots of a focused Prompt in ready and recognizing states. Confirm the button remains 28px, the light theme is black/white, the dark theme is near-white/black, status text is readable, and the rainbow ring does not overlap neighboring controls.

- [ ] **Step 7: Commit browser and real-model coverage**

```powershell
git add integrations/openshop/tests/hstar-voice-assistant.e2e.spec.js integrations/openshop/tests/hstar-voice-assistant-real.e2e.spec.js
git commit -m "test: verify global voice assistant hardening"
```

- [ ] **Step 8: Check repository and running service boundaries**

Run:

```powershell
git diff --check
git status --short
Get-NetTCPConnection -LocalPort 3000 -State Listen
```

Expected: no whitespace errors; only intentionally changed project files plus the pre-existing unstaged `data/asset_library.json`; port 3000 listens; no operation has started, stopped, or modified port 5000.
