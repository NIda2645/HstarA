# HstarA Global FunASR Voice Assistant Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. The user explicitly prohibited subagents, so all work must stay inline in the active session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an optional, locally running Fun-ASR-Nano-2512 voice assistant that performs continuous speech-to-text for every eligible HstarA natural-language input without bundling model or runtime data in the application.

**Architecture:** Keep HstarA's FastAPI process lightweight. Install optional Python packages with `pip --target` under the configured voice-data root, launch FunASR in an authenticated loopback subprocess, proxy PCM audio over a framed local protocol, and expose one browser WebSocket managed by a top-level coordinator. Every page uses one shared target adapter; custom editors register the same composition transaction contract.

**Tech Stack:** Python 3.10, FastAPI/WebSocket, ModelScope, FunASR 1.3.29, PyTorch/Torchaudio 2.9.1, Transformers 4.57.6, WebRTC VAD, vanilla JavaScript, AudioWorklet, Vitest/jsdom, Playwright, Node contract tests, Inno Setup.

**Source Spec:** `docs/superpowers/specs/2026-07-26-global-voice-assistant-design.md`

**Official Model Page:** `https://www.modelscope.cn/models/FunAudioLLM/Fun-ASR-Nano-2512`

**Official Capability Boundary:** Use the model table for this exact repository: `Fun-ASR-Nano-2512` is the 800M Chinese/English/Japanese model. The page's generic 31-language copy also covers the separate `Fun-ASR-MLT-Nano-2512` and must not expand this implementation's language selector. Timestamps and speaker diarization remain upstream TODO items. Treat the official repository file API for the selected revision, not scraped page prose or this plan's recorded byte count, as the install manifest authority.

---

## File Map

### Backend files to create

- `voice_assistant/__init__.py`: public manager/settings exports only.
- `voice_assistant/settings.py`: normalization, effective-root resolution, and path validation.
- `voice_assistant/registry.py`: official manifest retrieval, bounded model discovery, and validation.
- `voice_assistant/installer.py`: idempotent runtime/model install tasks, progress, resume, migration, and uninstall.
- `voice_assistant/protocol.py`: framed loopback IPC constants, serializers, and stable error codes.
- `voice_assistant/audio.py`: PCM validation, WebRTC VAD state, utterance buffering, and 10-second silence timer.
- `voice_assistant/recognizer.py`: FunASR adapter and CUDA/CPU device policy.
- `voice_assistant/service.py`: isolated child-process TCP service and model lifecycle.
- `voice_assistant/supervisor.py`: child-process startup, authentication, health, warm timeout, and shutdown.
- `voice_assistant/manager.py`: application-facing orchestration and single-session lock.
- `voice_assistant/modelscope_worker.py`: optional-runtime bootstrap and ModelScope download entry point.
- `voice_assistant/runtime_manifest.json`: pinned optional packages and package-index profiles.
- `voice_assistant/testing.py`: fake engine enabled only by `HSTAR_VOICE_TEST_MODE=1`.

### Frontend files to create

- `static/js/voice-input-adapter.js`: focus discovery, eligibility, composition transactions, undo, and iframe registration.
- `static/js/voice-assistant-coordinator.js`: one global session, microphone capture, WebSocket, first-use flow, and state routing.
- `static/js/voice-audio-worklet.js`: resample and emit 16kHz mono PCM16 frames.
- `static/js/voice-settings-panel.js`: software-settings model, storage, device, shortcut, and install controls.
- `static/css/voice-assistant.css`: focus-follow microphone, progress dialog, status, theme, and responsive styles.

### Existing files to modify

- `main.py`: manager construction, lifespan shutdown, Pydantic requests, REST routes, WebSocket proxy, folder picker purpose, and status broadcasts.
- `static/software-settings.html`: voice settings card and shared assets.
- `static/index.html`: coordinator bootstrap and iframe registration.
- All user-facing `static/*.html`: shared target-adapter script.
- `integrations/openshop/index.html` and generated `static/openshop/index.html`: shared target adapter.
- `integrations/storyai-3d-director-desk/index.html` and `static/3d-director/index.html`: shared target adapter.
- `.gitignore`: local runtime/model/cache exclusions.
- `build/installer/Hstar.iss`: installer payload exclusions.

### Test files to create

- `tests/test_voice_settings.py`
- `tests/test_voice_registry.py`
- `tests/test_voice_installer.py`
- `tests/test_voice_protocol.py`
- `tests/test_voice_audio.py`
- `tests/test_voice_recognizer.py`
- `tests/test_voice_supervisor.py`
- `tests/test_voice_api.py`
- `integrations/openshop/tests/hstar-voice-target-adapter.test.js`
- `integrations/openshop/tests/hstar-voice-coordinator.test.js`
- `integrations/openshop/tests/hstar-voice-assistant.e2e.spec.js`
- `tools/tests/software-settings-voice-assistant.test.mjs`
- `tools/tests/voice-assistant-page-coverage.test.mjs`
- `tools/tests/voice-assistant-installer-exclusion.test.mjs`
- `tools/voice-assistant-real-smoke.py`

---

### Task 1: Voice Settings and Effective Storage Root

**Files:**
- Create: `voice_assistant/__init__.py`
- Create: `voice_assistant/settings.py`
- Create: `voice_assistant/runtime_manifest.json`
- Create: `tests/test_voice_settings.py`

- [ ] **Step 1: Write failing settings tests**

```python
class VoiceSettingsTests(unittest.TestCase):
    def test_custom_root_wins(self):
        settings = {"storage_root": "D:/Hstar", "voice_assistant": {
            "storage_mode": "custom", "storage_root": "E:/Speech"
        }}
        value = normalize_voice_settings(settings, app_data_root="C:/AppData/Hstar")
        self.assertEqual(value.effective_root, os.path.abspath("E:/Speech"))

    def test_inherit_uses_software_storage(self):
        value = normalize_voice_settings(
            {"storage_root": "D:/Hstar", "voice_assistant": {}},
            app_data_root="C:/AppData/Hstar",
        )
        self.assertEqual(value.effective_root, os.path.abspath("D:/Hstar/voice-assistant"))

    def test_default_uses_appdata_not_install_dir(self):
        value = normalize_voice_settings({}, app_data_root="C:/AppData/Hstar")
        self.assertEqual(value.effective_root, os.path.abspath("C:/AppData/Hstar/voice-assistant"))
        self.assertEqual(value.silence_stop_seconds, 10)
        self.assertEqual(value.shortcut, "Shift+Q")
```

- [ ] **Step 2: Run the settings test and verify it fails**

Run:

```powershell
.\python\python.exe -m unittest discover -s tests -p "test_voice_settings.py" -v
```

Expected: `ModuleNotFoundError: No module named 'voice_assistant'`.

- [ ] **Step 3: Implement normalized immutable settings**

Create `voice_assistant/settings.py` with this public contract:

```python
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping

MODEL_ID = "FunAudioLLM/Fun-ASR-Nano-2512"
DEFAULT_SHORTCUT = "Shift+Q"
SILENCE_STOP_SECONDS = 10
WARM_IDLE_SECONDS = 600

@dataclass(frozen=True)
class VoiceSettings:
    enabled: bool
    storage_mode: str
    configured_root: str
    effective_root: str
    model_path: str
    model_id: str
    model_revision: str
    language: str
    input_device_id: str
    shortcut: str
    prewarm_on_startup: bool
    warm_idle_seconds: int
    silence_stop_seconds: int

def normalize_voice_settings(
    software_settings: Mapping[str, Any], *, app_data_root: str
) -> VoiceSettings:
    raw = software_settings.get("voice_assistant")
    raw = raw if isinstance(raw, Mapping) else {}
    mode = "custom" if raw.get("storage_mode") == "custom" else "inherit"
    configured = str(raw.get("storage_root") or "").strip()
    software_root = str(software_settings.get("storage_root") or "").strip()
    if mode == "custom" and configured:
        effective = Path(configured).expanduser().resolve()
    elif software_root:
        effective = Path(software_root).expanduser().resolve() / "voice-assistant"
    else:
        effective = Path(app_data_root).expanduser().resolve() / "voice-assistant"
    language = str(raw.get("language") or "auto").lower()
    if language not in {"auto", "zh", "en", "ja"}:
        language = "auto"
    return VoiceSettings(
        enabled=bool(raw.get("enabled", True)),
        storage_mode=mode,
        configured_root=configured,
        effective_root=str(effective),
        model_path=str(raw.get("model_path") or ""),
        model_id=MODEL_ID,
        model_revision=str(raw.get("model_revision") or ""),
        language=language,
        input_device_id=str(raw.get("input_device_id") or "default"),
        shortcut=str(raw.get("shortcut") or DEFAULT_SHORTCUT),
        prewarm_on_startup=bool(raw.get("prewarm_on_startup", False)),
        warm_idle_seconds=WARM_IDLE_SECONDS,
        silence_stop_seconds=SILENCE_STOP_SECONDS,
    )

def voice_paths(settings: VoiceSettings) -> dict[str, Path]:
    root = Path(settings.effective_root)
    managed = root / ".hstar-voice"
    return {
        "root": root,
        "managed": managed,
        "runtime_site": managed / "runtime" / "site-packages",
        "downloads": managed / "downloads",
        "cache": managed / "cache",
        "state": managed / "state",
        "logs": managed / "logs",
        "model": root / "FunAudioLLM" / "Fun-ASR-Nano-2512",
    }
```

Export `VoiceSettings`, `normalize_voice_settings`, and `voice_paths` from `voice_assistant/__init__.py`.

- [ ] **Step 4: Add the pinned optional runtime manifest**

Create `voice_assistant/runtime_manifest.json`:

```json
{
  "schemaVersion": 1,
  "python": "3.10",
  "packages": [
    "modelscope==1.38.1",
    "funasr==1.3.29",
    "torch==2.9.1",
    "torchaudio==2.9.1",
    "transformers==4.57.6",
    "webrtcvad-wheels==2.0.14",
    "soundfile==0.14.0"
  ],
  "profiles": {
    "cuda": {
      "indexUrl": "https://download.pytorch.org/whl/cu128",
      "extraIndexUrl": "https://pypi.org/simple"
    },
    "cpu": {
      "indexUrl": "https://download.pytorch.org/whl/cpu",
      "extraIndexUrl": "https://pypi.org/simple"
    }
  }
}
```

The real compatibility task later must prove this exact set before release. A version change requires a manifest edit and a repeated real smoke test; runtime code must never silently install unbounded latest versions.

- [ ] **Step 5: Run tests and commit**

Run:

```powershell
.\python\python.exe -m unittest discover -s tests -p "test_voice_settings.py" -v
```

Expected: all settings tests pass.

Commit:

```powershell
git add voice_assistant/__init__.py voice_assistant/settings.py voice_assistant/runtime_manifest.json tests/test_voice_settings.py
git commit -m "feat: add voice assistant settings foundation"
```

---

### Task 2: Bounded Model Discovery and Manifest Validation

**Files:**
- Create: `voice_assistant/registry.py`
- Create: `tests/test_voice_registry.py`

- [ ] **Step 1: Write failing registry tests**

```python
REQUIRED = {
    "configuration.json": b"{}",
    "config.yaml": b"model: FunASRNano\n",
    "model.pt": b"weights",
    "multilingual.tiktoken": b"tokens",
    "Qwen3-0.6B/config.json": b"{}",
    "Qwen3-0.6B/generation_config.json": b"{}",
    "Qwen3-0.6B/merges.txt": b"",
    "Qwen3-0.6B/tokenizer.json": b"{}",
    "Qwen3-0.6B/tokenizer_config.json": b"{}",
    "Qwen3-0.6B/vocab.json": b"{}",
}

def make_model(root: Path):
    for relative, content in REQUIRED.items():
        target = root / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content)

class VoiceRegistryTests(unittest.TestCase):
    def test_accepts_direct_model_directory(self):
        make_model(self.root)
        result = ModelRegistry().detect(self.root)
        self.assertTrue(result.ready)
        self.assertEqual(result.model_path, str(self.root.resolve()))

    def test_accepts_modelscope_parent_layout(self):
        model = self.root / "FunAudioLLM" / "Fun-ASR-Nano-2512"
        make_model(model)
        self.assertEqual(ModelRegistry().detect(self.root).model_path, str(model.resolve()))

    def test_rejects_missing_weights_without_recursive_disk_scan(self):
        make_model(self.root)
        (self.root / "model.pt").unlink()
        result = ModelRegistry().detect(self.root)
        self.assertFalse(result.ready)
        self.assertIn("model.pt", result.missing)
```

- [ ] **Step 2: Run the registry test and verify it fails**

```powershell
.\python\python.exe -m unittest discover -s tests -p "test_voice_registry.py" -v
```

Expected: import failure for `voice_assistant.registry`.

- [ ] **Step 3: Implement bounded candidate resolution**

```python
REQUIRED_PATHS = (
    "configuration.json",
    "config.yaml",
    "model.pt",
    "multilingual.tiktoken",
    "Qwen3-0.6B/config.json",
    "Qwen3-0.6B/generation_config.json",
    "Qwen3-0.6B/merges.txt",
    "Qwen3-0.6B/tokenizer.json",
    "Qwen3-0.6B/tokenizer_config.json",
    "Qwen3-0.6B/vocab.json",
)

def candidate_model_dirs(selected: Path) -> tuple[Path, ...]:
    selected = selected.expanduser().resolve()
    return tuple(dict.fromkeys((
        selected,
        selected / "FunAudioLLM" / "Fun-ASR-Nano-2512",
        selected / "hub" / "FunAudioLLM" / "Fun-ASR-Nano-2512",
        selected / "models" / "FunAudioLLM" / "Fun-ASR-Nano-2512",
    )))

@dataclass(frozen=True)
class ModelDetection:
    ready: bool
    model_path: str
    revision: str
    missing: tuple[str, ...]
    size_bytes: int
    source: str

class ModelRegistry:
    def detect(self, selected: str | Path) -> ModelDetection:
        best = None
        for candidate in candidate_model_dirs(Path(selected)):
            missing = tuple(name for name in REQUIRED_PATHS if not (candidate / name).is_file())
            detection = ModelDetection(
                ready=not missing,
                model_path=str(candidate),
                revision=self._read_revision(candidate),
                missing=missing,
                size_bytes=self._size(candidate) if candidate.is_dir() else 0,
                source="managed" if (candidate / ".hstar-model.json").is_file() else "external",
            )
            if detection.ready:
                return detection
            if best is None or len(detection.missing) < len(best.missing):
                best = detection
        return best or ModelDetection(False, "", "", REQUIRED_PATHS, 0, "external")
```

`_size` must walk only the selected candidate. `_read_revision` reads `.hstar-model.json` or ModelScope metadata and returns an empty string when absent.

- [ ] **Step 4: Add remote manifest verification without making it mandatory offline**

Use the repository file API, recursively requesting only tree roots returned by that repository:

```python
import hashlib
import json
from dataclasses import dataclass
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from voice_assistant.settings import MODEL_ID

FILES_API = "https://www.modelscope.cn/api/v1/models/{model_id}/repo/files"

class ModelManifestError(RuntimeError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code

def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()

@dataclass(frozen=True)
class ManifestFile:
    path: str
    size: int
    sha256: str

def fetch_official_manifest(
    revision: str = "master", *, opener=urlopen
) -> tuple[ManifestFile, ...]:
    pending = [""]
    files = []
    while pending:
        root = pending.pop()
        query = urlencode({"Revision": revision, "Root": root})
        request = Request(
            f"{FILES_API.format(model_id=MODEL_ID)}?{query}",
            headers={"Accept": "application/json", "User-Agent": "HstarA-Voice/1"},
        )
        with opener(request, timeout=20) as response:
            payload = json.load(response)
        if payload.get("Code") != 200:
            raise ModelManifestError("VOICE_MANIFEST_UNAVAILABLE", payload.get("Message", ""))
        for item in payload.get("Data", {}).get("Files", []):
            path = str(item.get("Path") or "")
            if item.get("Type") == "tree":
                pending.append(path)
            elif item.get("Type") == "blob":
                files.append(ManifestFile(
                    path=path,
                    size=int(item.get("Size") or 0),
                    sha256=str(item.get("Sha256") or "").lower(),
                ))
    return tuple(sorted(files, key=lambda item: item.path))

def verify_against_manifest(
    model_path: Path, manifest: tuple[ManifestFile, ...]
) -> tuple[str, ...]:
    invalid = []
    for item in manifest:
        local = model_path / Path(item.path)
        if not local.is_file() or (item.size and local.stat().st_size != item.size):
            invalid.append(item.path)
            continue
        if item.sha256 and sha256_file(local) != item.sha256:
            invalid.append(item.path)
    return tuple(invalid)
```

Cache the successful response in `.hstar-voice/state/model-manifest.json` together with `model_id`, `revision`, and `fetched_at`. Offline detection may use a previously cached manifest; a complete local model without cache proceeds to the isolated load smoke test rather than being rejected solely for lack of network. The current repository API has no top-level `model.py`, so `REQUIRED_PATHS` must not require one; if a future revision adds remote code, the downloaded manifest verifies it as an ordinary revision-owned file.

- [ ] **Step 5: Run tests and commit**

```powershell
.\python\python.exe -m unittest discover -s tests -p "test_voice_registry.py" -v
git add voice_assistant/registry.py tests/test_voice_registry.py
git commit -m "feat: validate local FunASR model directories"
```

Expected: all registry tests pass and no test scans outside its temporary root.

---

### Task 3: Optional Runtime and Model Installer

**Files:**
- Create: `voice_assistant/installer.py`
- Create: `voice_assistant/modelscope_worker.py`
- Create: `tests/test_voice_installer.py`

- [ ] **Step 1: Write failing command and task-state tests**

```python
class VoiceInstallerTests(unittest.TestCase):
    def test_pip_target_never_modifies_main_python(self):
        command = build_pip_install_command(
            python_executable="C:/Hstar/python/python.exe",
            runtime_site=Path("E:/Speech/.hstar-voice/runtime/site-packages"),
            packages=["funasr==1.3.29"],
            index_url="https://download.pytorch.org/whl/cpu",
            extra_index_url="https://pypi.org/simple",
        )
        self.assertIn("--target", command)
        self.assertEqual(command[command.index("--index-url") + 1], "https://download.pytorch.org/whl/cpu")
        self.assertNotIn("--user", command)
        self.assertNotIn("venv", " ".join(command))

    def test_repeated_install_returns_same_active_task(self):
        installer = VoiceInstaller(self.paths, runner=self.runner)
        first = installer.start_install(profile="cpu")
        second = installer.start_install(profile="cpu")
        self.assertEqual(first.task_id, second.task_id)

    def test_auto_profile_uses_lightweight_hardware_probe(self):
        installer = VoiceInstaller(
            self.paths, runner=self.runner, hardware_probe=lambda: "cuda"
        )
        task = installer.start_install(profile="auto")
        self.assertEqual(task.profile, "cuda")

    def test_cancelled_partial_download_is_resumable_not_ready(self):
        task = self.installer.start_install(profile="cpu")
        self.installer.cancel(task.task_id)
        state = self.installer.status(task.task_id)
        self.assertEqual(state.status, "cancelled")
        self.assertFalse(state.model_ready)
        self.assertTrue(state.resume_available)
```

- [ ] **Step 2: Run tests and verify failure**

```powershell
.\python\python.exe -m unittest discover -s tests -p "test_voice_installer.py" -v
```

Expected: import failure for installer symbols.

- [ ] **Step 3: Implement safe `pip --target` runtime installation**

```python
def build_pip_install_command(
    *, python_executable, runtime_site, packages, index_url, extra_index_url
):
    return [
        str(python_executable), "-m", "pip", "install",
        "--disable-pip-version-check", "--no-input", "--upgrade",
        "--target", str(Path(runtime_site).resolve()),
        "--index-url", index_url,
        "--extra-index-url", extra_index_url,
        *packages,
    ]
```

Load package pins from `runtime_manifest.json`. Run with `shell=False`, a sanitized environment, and stdout/stderr pipes. Persist a task JSON after every state transition with `task_id`, `kind`, `status`, `stage`, `downloaded_bytes`, `total_bytes`, `speed_bps`, `eta_seconds`, `error_code`, `cancel_requested`, and `resume_available`.

`VoiceInstaller.start_install(profile)` accepts `auto`, `cuda`, or `cpu`. `auto` uses the injected lightweight NVIDIA-driver probe before installing Torch; it resolves to one concrete manifest profile and persists that value in `InstallTaskState.profile`. It must not import Torch into the main HstarA process.

- [ ] **Step 4: Implement the ModelScope worker and atomic activation**

`modelscope_worker.py` must prepend the external target site before importing ModelScope:

```python
def bootstrap_runtime(runtime_site: str) -> None:
    resolved = str(Path(runtime_site).resolve())
    if resolved not in sys.path:
        sys.path.insert(0, resolved)

def download(model_id: str, revision: str, staging_dir: str) -> str:
    from modelscope import snapshot_download
    return snapshot_download(
        model_id,
        revision=revision or "master",
        local_dir=str(Path(staging_dir).resolve()),
    )
```

The installer runs this worker by argument array. It calculates progress by comparing the staged file sizes with the official manifest, validates the complete staged model, writes `.hstar-model.json`, then activates it with rename/backup/rollback. A cancelled or failed task keeps only resumable staging data.

- [ ] **Step 5: Implement migration, repair, and ownership-safe uninstall**

Only paths carrying `.hstar-voice/state/managed-install.json` may be deleted without an extra external-path confirmation token. Migration copies to a sibling staging directory, validates, atomically switches settings, and deletes the source only after success. Repair reruns missing-file download and the load smoke test.

- [ ] **Step 6: Run tests and commit**

```powershell
.\python\python.exe -m unittest discover -s tests -p "test_voice_installer.py" -v
git add voice_assistant/installer.py voice_assistant/modelscope_worker.py tests/test_voice_installer.py
git commit -m "feat: add resumable voice runtime installer"
```

Expected: tests pass using fake runners and temporary directories; no package or model is downloaded during unit tests.

---

### Task 4: Authenticated Framed Loopback Protocol

**Files:**
- Create: `voice_assistant/protocol.py`
- Create: `tests/test_voice_protocol.py`

- [ ] **Step 1: Write failing frame round-trip tests**

```python
class VoiceProtocolTests(unittest.IsolatedAsyncioTestCase):
    async def test_binary_audio_round_trip(self):
        reader = asyncio.StreamReader()
        reader.feed_data(encode_frame(FRAME_AUDIO, b"\x01\x02"))
        reader.feed_eof()
        frame_type, payload = await read_frame(reader)
        self.assertEqual(frame_type, FRAME_AUDIO)
        self.assertEqual(payload, b"\x01\x02")

    def test_rejects_oversized_frame(self):
        with self.assertRaises(VoiceProtocolError):
            encode_frame(FRAME_AUDIO, b"x" * (MAX_FRAME_BYTES + 1))
```

- [ ] **Step 2: Run tests and verify failure**

```powershell
.\python\python.exe -m unittest discover -s tests -p "test_voice_protocol.py" -v
```

- [ ] **Step 3: Implement exact framing and error codes**

```python
HEADER = struct.Struct("!BI")
FRAME_JSON = 1
FRAME_AUDIO = 2
MAX_FRAME_BYTES = 1_048_576

def encode_frame(frame_type: int, payload: bytes) -> bytes:
    if frame_type not in {FRAME_JSON, FRAME_AUDIO}:
        raise VoiceProtocolError("VOICE_PROTOCOL_FRAME_TYPE")
    if len(payload) > MAX_FRAME_BYTES:
        raise VoiceProtocolError("VOICE_PROTOCOL_FRAME_TOO_LARGE")
    return HEADER.pack(frame_type, len(payload)) + payload

async def read_frame(reader: asyncio.StreamReader) -> tuple[int, bytes]:
    frame_type, length = HEADER.unpack(await reader.readexactly(HEADER.size))
    if length > MAX_FRAME_BYTES:
        raise VoiceProtocolError("VOICE_PROTOCOL_FRAME_TOO_LARGE")
    return frame_type, await reader.readexactly(length)
```

Define every stable error code from the design as constants and add `encode_json`, `decode_json`, `write_frame`, and `authenticate_hello(token)` helpers. Authentication must be the first frame on every local connection.

- [ ] **Step 4: Run tests and commit**

```powershell
.\python\python.exe -m unittest discover -s tests -p "test_voice_protocol.py" -v
git add voice_assistant/protocol.py tests/test_voice_protocol.py
git commit -m "feat: define voice service IPC protocol"
```

---

### Task 5: PCM, WebRTC VAD, and Ten-Second Silence State

**Files:**
- Create: `voice_assistant/audio.py`
- Create: `tests/test_voice_audio.py`

- [ ] **Step 1: Write deterministic VAD and silence tests**

```python
class VoiceAudioTests(unittest.TestCase):
    def test_stops_after_ten_seconds_without_speech(self):
        clock = FakeClock()
        session = VadSession(vad=FakeVad(False), clock=clock, silence_seconds=10)
        for _ in range(500):
            event = session.accept_pcm(SILENT_20MS_FRAME)
            clock.advance(0.02)
        self.assertEqual(event.stop_reason, "silence-timeout")

    def test_noise_does_not_reset_timer_when_vad_rejects_it(self):
        session = VadSession(vad=FakeVad(False), clock=self.clock, silence_seconds=10)
        session.accept_pcm(NOISY_20MS_FRAME)
        self.assertEqual(session.last_speech_at, session.started_at)

    def test_valid_speech_resets_timer_and_emits_utterance(self):
        session = VadSession(vad=SequenceVad([True, True, False]), clock=self.clock)
        events = [session.accept_pcm(frame) for frame in THREE_FRAMES]
        self.assertTrue(events[0].speech_active)
        self.assertIsNotNone(events[-1].final_utterance_pcm)
```

- [ ] **Step 2: Run tests and verify failure**

```powershell
.\python\python.exe -m unittest discover -s tests -p "test_voice_audio.py" -v
```

- [ ] **Step 3: Implement strict PCM framing and VAD state**

Accept only 16kHz, mono, signed little-endian PCM16 in 20ms frames (`640` bytes). `VadSession` keeps a bounded pre-roll, current utterance, last-speech monotonic timestamp, 700ms end-of-utterance hangover, and a hard 10-second no-speech timeout. It exposes immutable `VadEvent` values rather than calling ASR directly.

```python
@dataclass(frozen=True)
class VadEvent:
    speech_active: bool
    partial_pcm: bytes | None = None
    final_utterance_pcm: bytes | None = None
    silence_remaining_ms: int = 10_000
    stop_reason: str = ""

class WebRtcVad:
    def __init__(self, aggressiveness: int = 2):
        import webrtcvad
        self._vad = webrtcvad.Vad(aggressiveness)

    def is_speech(self, frame: bytes) -> bool:
        return self._vad.is_speech(frame, 16_000)
```

Partial PCM snapshots are emitted no faster than 800ms on CUDA policy and 2000ms on CPU policy. The utterance buffer has a 30-second cap; reaching the cap finalizes the current utterance but does not end the full listening session.

- [ ] **Step 4: Run tests and commit**

```powershell
.\python\python.exe -m unittest discover -s tests -p "test_voice_audio.py" -v
git add voice_assistant/audio.py tests/test_voice_audio.py
git commit -m "feat: add bounded voice activity sessions"
```

---

### Task 6: FunASR Recognizer and Isolated Service Process

**Files:**
- Create: `voice_assistant/recognizer.py`
- Create: `voice_assistant/service.py`
- Create: `voice_assistant/testing.py`
- Create: `tests/test_voice_recognizer.py`

- [ ] **Step 1: Write failing device and sequence tests**

```python
class VoiceRecognizerTests(unittest.TestCase):
    def test_cuda_failure_falls_back_to_cpu(self):
        factory = FakeModelFactory(cuda_error=RuntimeError("CUDA unavailable"))
        recognizer = FunAsrRecognizer(self.model_path, model_factory=factory)
        recognizer.load("auto")
        self.assertEqual(recognizer.device, "cpu")
        self.assertEqual(factory.calls, ["cuda:0", "cpu"])

    def test_partial_results_keep_only_stable_monotonic_sequence(self):
        state = RecognitionState()
        self.assertTrue(state.accept(sequence=2, text="你好"))
        self.assertFalse(state.accept(sequence=1, text="你"))

    def test_language_is_limited_to_supported_values(self):
        self.assertEqual(funasr_language("zh"), "中文")
        self.assertEqual(funasr_language("en"), "英文")
        self.assertEqual(funasr_language("ja"), "日文")
        self.assertIsNone(funasr_language("auto"))
        self.assertIsNone(funasr_language("xx"))
```

- [ ] **Step 2: Run tests and verify failure**

```powershell
.\python\python.exe -m unittest discover -s tests -p "test_voice_recognizer.py" -v
```

- [ ] **Step 3: Implement optional-runtime loading and device fallback**

```python
class VoiceRecognitionError(RuntimeError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code

def prepend_runtime_site(runtime_site: str) -> None:
    site = str(Path(runtime_site).resolve())
    if site not in sys.path:
        sys.path.insert(0, site)
    if os.name == "nt":
        for dll_dir in (Path(site) / "torch" / "lib", Path(site) / "torchaudio" / "lib"):
            if dll_dir.is_dir():
                os.add_dll_directory(str(dll_dir))

class FunAsrRecognizer:
    def load(self, requested_device: str = "auto") -> str:
        from funasr import AutoModel
        import torch
        if requested_device == "cuda" and not torch.cuda.is_available():
            raise VoiceRecognitionError("VOICE_CUDA_UNAVAILABLE", "CUDA is unavailable")
        candidates = ["cuda:0", "cpu"] if requested_device == "auto" else [requested_device]
        last_error = None
        for device in candidates:
            try:
                self.model = AutoModel(
                    model=str(self.model_path),
                    trust_remote_code=True,
                    device=device,
                )
                self.device = "cuda" if device.startswith("cuda") else "cpu"
                return self.device
            except Exception as error:
                last_error = error
                self._release_model()
        raise VoiceRecognitionError("VOICE_MODEL_LOAD_FAILED", str(last_error))

    def transcribe(self, pcm16: bytes, language: str) -> str:
        audio = numpy.frombuffer(pcm16, dtype="<i2").astype(numpy.float32) / 32768.0
        language_arg = funasr_language(language)
        options = {"language": language_arg} if language_arg else {}
        result = self.model.generate(
            input=[audio], cache={}, batch_size=1,
            itn=True, **options,
        )
        return str(result[0].get("text") or "").strip()
```

`funasr_language` maps only `zh -> 中文`, `en -> 英文`, and `ja -> 日文`. `auto` omits the model argument so upstream detection can run; Task 13 must prove that behavior with the three official examples. If it fails, disable `auto` in settings instead of silently treating it as Chinese.

Do not import FunASR, Torch, NumPy, or WebRTC VAD at module import time in the HstarA main process. They are imported only after `prepend_runtime_site` inside the child process.

- [ ] **Step 4: Implement the authenticated child service**

`service.py` starts an `asyncio.start_server` listener on `127.0.0.1`, prints exactly one JSON readiness line containing the assigned port, requires the token hello frame, and accepts one active transcription session. It sends `ready`, `speech-state`, `partial`, `final`, `stopped`, and `error` events with monotonic sequence numbers. ASR calls run in `asyncio.to_thread`; only the newest pending partial request survives, while every final utterance is processed.

When `HSTAR_VOICE_TEST_MODE=1`, load `FakeRecognizer` from `testing.py`. The fake accepts PCM frames and emits deterministic `partial="测试"`, `final="测试完成。"` without optional packages. Outside that exact environment value, importing the fake backend is forbidden.

- [ ] **Step 5: Implement release and memory cleanup**

`FunAsrRecognizer.close()` drops the model reference, runs `gc.collect()`, and when Torch was loaded on CUDA calls `torch.cuda.empty_cache()`. The service handles `unload` and `shutdown` control frames only after token authentication.

- [ ] **Step 6: Run tests and commit**

```powershell
.\python\python.exe -m unittest discover -s tests -p "test_voice_recognizer.py" -v
git add voice_assistant/recognizer.py voice_assistant/service.py voice_assistant/testing.py tests/test_voice_recognizer.py
git commit -m "feat: add isolated FunASR recognition service"
```

Expected: tests pass without importing or installing Torch in the main test process.

---

### Task 7: Service Supervisor, Manager, REST API, and WebSocket Proxy

**Files:**
- Create: `voice_assistant/supervisor.py`
- Create: `voice_assistant/manager.py`
- Create: `tests/test_voice_supervisor.py`
- Create: `tests/test_voice_api.py`
- Modify: `main.py:133-143`
- Modify: `main.py:229-287`
- Modify: `main.py:2928-2934`
- Modify: `main.py:12481-12563`
- Modify: `main.py:12925-13002`

- [ ] **Step 1: Write failing supervisor lifecycle tests**

```python
class VoiceSupervisorTests(unittest.IsolatedAsyncioTestCase):
    async def test_concurrent_start_reuses_one_process(self):
        supervisor = VoiceServiceSupervisor(process_factory=self.factory, clock=self.clock)
        first, second = await asyncio.gather(supervisor.ensure_ready(), supervisor.ensure_ready())
        self.assertEqual(first.port, second.port)
        self.assertEqual(self.factory.start_count, 1)

    async def test_idle_timeout_unloads_model_but_keeps_manager_usable(self):
        supervisor = VoiceServiceSupervisor(process_factory=self.factory, clock=self.clock)
        await supervisor.ensure_ready()
        await supervisor.session_finished()
        self.clock.advance(600)
        await supervisor.reap_idle()
        self.assertEqual(supervisor.status().model_state, "unloaded")

    async def test_shutdown_terminates_child(self):
        supervisor = VoiceServiceSupervisor(process_factory=self.factory)
        await supervisor.ensure_ready()
        await supervisor.shutdown()
        self.assertTrue(self.factory.process.terminated)
```

- [ ] **Step 2: Implement process startup with a sanitized environment**

```python
ALLOWED_CHILD_ENV = {
    "PATH", "SYSTEMROOT", "WINDIR", "TEMP", "TMP",
    "CUDA_PATH", "CUDA_VISIBLE_DEVICES", "NVIDIA_VISIBLE_DEVICES",
    "PYTHONUTF8", "PYTHONIOENCODING",
}

def sanitized_child_env(source: Mapping[str, str]) -> dict[str, str]:
    env = {key: value for key, value in source.items() if key.upper() in ALLOWED_CHILD_ENV}
    env.update({"PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8"})
    return env

def service_command(python_executable, runtime_site, model_path, token, test_mode=False):
    command = [
        str(python_executable), "-X", "utf8", "-m", "voice_assistant.service",
        "--runtime-site", str(runtime_site), "--model", str(model_path),
        "--token", token, "--port", "0",
    ]
    if test_mode:
        command.append("--test-mode")
    return command
```

Read exactly one readiness JSON line with a 120-second cold-load timeout, then switch stdout/stderr to bounded rotating diagnostics. Never use `shell=True`. On Windows, start the process hidden and in a new process group.

- [ ] **Step 3: Implement one-session manager and warm reaper**

`VoiceAssistantManager` owns settings, registry, installer, supervisor, and an `asyncio.Lock` for the active browser session. `open_session(session_id)` rejects a second owner with `VOICE_MIC_BUSY`; `close_session` always releases the lock in `finally`. A background reaper checks idle expiry every 15 seconds only while a service exists.

```python
class VoiceAssistantManager:
    async def open_session(self, session_id: str) -> VoiceServiceConnection:
        if self._session_lock.locked():
            raise VoiceManagerError("VOICE_MIC_BUSY")
        await self._session_lock.acquire()
        try:
            endpoint = await self.supervisor.ensure_ready()
            return await self.supervisor.connect(endpoint, session_id)
        except Exception:
            self._session_lock.release()
            raise

    async def close_session(self, connection) -> None:
        try:
            await connection.close()
        finally:
            if self._session_lock.locked():
                self._session_lock.release()
            await self.supervisor.session_finished()
```

- [ ] **Step 4: Write failing REST API tests with an injected fake manager**

```python
class VoiceApiTests(unittest.IsolatedAsyncioTestCase):
    async def test_status_does_not_start_service(self):
        response = await self.client.get("/api/voice-assistant/status")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.fake_manager.start_count, 0)

    async def test_repeated_install_is_idempotent(self):
        first = await self.client.post("/api/voice-assistant/install", json={"profile": "cpu"})
        second = await self.client.post("/api/voice-assistant/install", json={"profile": "cpu"})
        self.assertEqual(first.json()["task_id"], second.json()["task_id"])

    async def test_custom_path_failure_does_not_overwrite_settings(self):
        response = await self.client.post("/api/voice-assistant/settings", json={
            "storage_mode": "custom", "storage_root": "Z:/not-writable"
        })
        self.assertEqual(response.status_code, 400)
        self.assertEqual(self.read_settings(), self.original_settings)
```

- [ ] **Step 5: Add manager construction and stable HTTP routes to `main.py`**

Construct `VOICE_ASSISTANT` after `APP_DATA_ROOT` and `SOFTWARE_SETTINGS_FILE` exist. Add Pydantic models with explicit fields and `Literal` values; do not accept arbitrary dictionaries for destructive operations.

```python
class VoiceSettingsRequest(BaseModel):
    enabled: bool = True
    storage_mode: Literal["inherit", "custom"] = "inherit"
    storage_root: str = ""
    language: Literal["auto", "zh", "en", "ja"] = "auto"
    input_device_id: str = "default"
    shortcut: str = "Shift+Q"
    prewarm_on_startup: bool = False

class VoiceInstallRequest(BaseModel):
    profile: Literal["auto", "cuda", "cpu"] = "auto"
    revision: str = "master"

class VoiceTaskRequest(BaseModel):
    task_id: str
```

Register every route in the spec. Reuse `choose_folder_path` with `purpose="voice-storage"` and a voice-specific title. REST responses return `{ok, status, settings, task}` with stable state values.

- [ ] **Step 6: Implement `/ws/voice-assistant/transcribe` as a byte proxy**

The browser sends one JSON `start` frame followed by binary PCM. Validate origin/collaboration access using the same local/LAN policy as existing routes. Forward binary frames to the authenticated child connection and child JSON events back to the browser. A disconnect executes this exact cleanup order in `finally`: stop/cancel child session, release manager lock, release microphone state.

```python
@app.websocket("/ws/voice-assistant/transcribe")
async def voice_transcribe_socket(websocket: WebSocket):
    await websocket.accept()
    connection = None
    try:
        start = json.loads(await websocket.receive_text())
        session_id = validate_voice_start(start)
        connection = await VOICE_ASSISTANT.open_session(session_id)
        await proxy_voice_session(websocket, connection, start)
    except WebSocketDisconnect:
        pass
    except VoiceManagerError as error:
        await websocket.send_json(error.as_event())
    finally:
        if connection is not None:
            await VOICE_ASSISTANT.close_session(connection)
```

- [ ] **Step 7: Wire startup prewarm and guaranteed shutdown**

Change lifespan to:

```python
@asynccontextmanager
async def app_lifespan(_app):
    await startup_event()
    try:
        yield
    finally:
        await VOICE_ASSISTANT.shutdown()
```

At the end of `startup_event`, call `VOICE_ASSISTANT.schedule_prewarm()` only when settings enable the feature, model detection is ready, and `prewarm_on_startup` is true.

- [ ] **Step 8: Run backend tests and commit**

```powershell
.\python\python.exe -m unittest discover -s tests -p "test_voice_supervisor.py" -v
.\python\python.exe -m unittest discover -s tests -p "test_voice_api.py" -v
git add voice_assistant/supervisor.py voice_assistant/manager.py tests/test_voice_supervisor.py tests/test_voice_api.py main.py
git commit -m "feat: expose managed voice assistant service"
```

---

### Task 8: Shared Text Target Adapter and Undo Transactions

**Files:**
- Create: `static/js/voice-input-adapter.js`
- Create: `integrations/openshop/tests/hstar-voice-target-adapter.test.js`

- [ ] **Step 1: Write failing Vitest coverage for eligibility and insertion**

```javascript
it('accepts natural-language inputs and rejects sensitive controls', () => {
  document.body.innerHTML = `
    <textarea id="prompt"></textarea>
    <input id="search" type="search">
    <input id="key" type="text" data-voice-input="off">
    <input id="path" type="text" data-voice-input="off">
    <input id="readonly" type="text" readonly>
  `;
  expect(adapter.isEligible(prompt)).toBe(true);
  expect(adapter.isEligible(search)).toBe(true);
  expect(adapter.isEligible(key)).toBe(false);
  expect(adapter.isEligible(path)).toBe(false);
  expect(adapter.isEligible(readonly)).toBe(false);
});

it('replaces one partial composition and commits one undo transaction', () => {
  prompt.value = '前 后';
  prompt.setSelectionRange(2, 2);
  const transaction = adapter.begin(prompt);
  transaction.update('你');
  transaction.update('你好');
  transaction.commit('你好。');
  expect(prompt.value).toBe('前 你好。后');
  adapter.undo(prompt);
  expect(prompt.value).toBe('前 后');
});

it('fires beforeinput before mutation, input after mutation, and honors cancellation', () => {
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
```

- [ ] **Step 2: Run Vitest and verify failure**

```powershell
Set-Location integrations/openshop
npx vitest run tests/hstar-voice-target-adapter.test.js
Set-Location ../..
```

- [ ] **Step 3: Implement standard input transactions**

Expose `window.HstarVoiceInputAdapter` from an IIFE. Eligibility accepts enabled visible `textarea`, `input[type=text|search]`, and contenteditable unless `data-voice-input="off"`; any other input needs `data-voice-input="on"`.

```javascript
function dispatchBeforeInput(target, inputType, data, isComposing) {
  return target.dispatchEvent(new InputEvent('beforeinput', {
    bubbles: true,
    cancelable: true,
    inputType,
    data,
    isComposing,
  }));
}

function dispatchAfterInput(target, inputType, data, isComposing) {
  target.dispatchEvent(new InputEvent('input', {
    bubbles: true,
    inputType,
    data,
    isComposing,
  }));
}

function replaceTextRange(target, start, end, text, inputType, isComposing) {
  if (!dispatchBeforeInput(target, inputType, text, isComposing)) return false;
  target.setRangeText(text, start, end, 'end');
  dispatchAfterInput(target, inputType, text, isComposing);
  return true;
}

function beginTextControl(target){
  const before = target.value;
  const start = target.selectionStart ?? before.length;
  const selectedEnd = target.selectionEnd ?? start;
  let compositionEnd = selectedEnd;
  return {
    update(text){
      if (replaceTextRange(
        target, start, compositionEnd, text, 'insertCompositionText', true
      )) compositionEnd = start + text.length;
    },
    commit(text){
      if (replaceTextRange(
        target, start, compositionEnd, text, 'insertFromDictation', false
      )) {
        compositionEnd = start + text.length;
        pushUndo({target, before, after:target.value, selection:start});
      }
    },
    cancel(){
      if (!dispatchBeforeInput(
        target, 'deleteCompositionText', null, false
      )) return;
      target.value = before;
      target.setSelectionRange(start, selectedEnd);
      dispatchAfterInput(target, 'deleteCompositionText', null, false);
    },
  };
}
```

Each accepted replacement emits exactly one cancelable `beforeinput` before mutation and one non-cancelable `input` after mutation. A canceled `beforeinput` leaves both the value and composition range unchanged, and repeated partial updates never append duplicate text.

- [ ] **Step 4: Implement contenteditable and custom adapter transactions**

Contenteditable inserts one temporary `span[data-voice-composition]` at the current Range and only changes that span's text. Commit replaces it with one text node; cancel restores the selected DocumentFragment. Custom editors register:

```javascript
adapter.register(element, {
  getSelection,
  beginComposition,
  updateComposition,
  commitComposition,
  cancelComposition,
  isTargetAvailable,
  getTargetLabel,
});
```

Add an adapter-local voice undo stack. `Ctrl+Z` consumes only the newest matching voice transaction when current content still equals its recorded `after` state; otherwise it yields to HstarA's existing undo behavior.

- [ ] **Step 5: Implement focus and iframe messages**

Use `focusin`, `focusout`, `compositionstart`, `compositionend`, `keydown`, `pagehide`, and `MutationObserver` listeners. Post `hstar-voice-target-active`, `hstar-voice-target-lost`, and `hstar-voice-target-command` to the same-origin parent. During IME composition ignore `Shift+Q`. If no parent coordinator exists and `window.top === window`, lazily load `/static/js/voice-assistant-coordinator.js` once.

- [ ] **Step 6: Run tests and commit**

```powershell
Set-Location integrations/openshop
npx vitest run tests/hstar-voice-target-adapter.test.js
Set-Location ../..
git add static/js/voice-input-adapter.js integrations/openshop/tests/hstar-voice-target-adapter.test.js
git commit -m "feat: add global voice text transactions"
```

---

### Task 9: Browser AudioWorklet and Global Coordinator

**Files:**
- Create: `static/js/voice-audio-worklet.js`
- Create: `static/js/voice-assistant-coordinator.js`
- Create: `static/css/voice-assistant.css`
- Create: `integrations/openshop/tests/hstar-voice-coordinator.test.js`

- [ ] **Step 1: Write failing coordinator state-machine tests**

```javascript
it('keeps one target and replaces partial text before final commit', async () => {
  coordinator.activateTarget(targetHandle);
  await coordinator.start();
  socket.emit({type:'partial', text:'测', sequence:1});
  socket.emit({type:'partial', text:'测试', sequence:2});
  socket.emit({type:'final', text:'测试完成。', sequence:3});
  expect(targetHandle.update).toHaveBeenNthCalledWith(1, '测');
  expect(targetHandle.update).toHaveBeenNthCalledWith(2, '测试');
  expect(targetHandle.commit).toHaveBeenCalledWith('测试完成。');
});

it('drops stale sequence events', () => {
  socket.emit({type:'partial', text:'新', sequence:5});
  socket.emit({type:'partial', text:'旧', sequence:4});
  expect(targetHandle.update).toHaveBeenCalledTimes(1);
});

it('stops and releases media on silence timeout', async () => {
  socket.emit({type:'stopped', reason:'silence-timeout', sequence:6});
  expect(track.stop).toHaveBeenCalledOnce();
  expect(coordinator.state).toBe('ready');
});
```

- [ ] **Step 2: Run Vitest and verify failure**

```powershell
Set-Location integrations/openshop
npx vitest run tests/hstar-voice-coordinator.test.js
Set-Location ../..
```

- [ ] **Step 3: Implement a 16kHz PCM AudioWorklet**

The processor receives the browser sample rate through `processorOptions`, keeps fractional resampling position across callbacks, averages channels, clamps samples, and posts transferable `Int16Array` buffers in 20ms blocks.

```javascript
class HstarVoiceProcessor extends AudioWorkletProcessor {
  constructor(options){
    super();
    this.sourceRate = options.processorOptions.sourceRate;
    this.targetRate = 16000;
    this.pending = [];
    this.phase = 0;
  }
  process(inputs){
    const channels = inputs[0];
    if(channels?.length) this.consume(channels);
    return true;
  }
}
registerProcessor('hstar-voice-processor', HstarVoiceProcessor);
```

Do not use MediaRecorder/WebM because the backend contract is deterministic PCM and must not require FFmpeg.

- [ ] **Step 4: Implement coordinator states and target locking**

Use explicit states:

```javascript
const STATES = Object.freeze({
  DISABLED:'disabled', MISSING:'missing', READY:'ready',
  LOADING:'loading', LISTENING:'listening', RECOGNIZING:'recognizing',
  STOPPING:'stopping', ERROR:'error',
});
```

`start()` verifies an active target, calls `/api/voice-assistant/status`, opens the first-use dialog when missing, waits for service readiness, then requests `getUserMedia`. It creates one `AudioContext`, worklet, media source, and WebSocket. It must not request microphone permission while model/runtime is missing.

- [ ] **Step 5: Implement event routing and cleanup**

Sequence-gate all `partial/final/stopped/error` events. Partial calls `transaction.update`; final calls `transaction.commit` and starts a new transaction at the resulting caret. `stop()` is idempotent and always closes WebSocket, disconnects nodes, closes AudioContext, stops every media track, removes countdown state, and clears the target lock in `finally`.

If service failure occurs, commit only text from prior `final` events and cancel the current partial transaction.

- [ ] **Step 6: Implement focus-follow overlay and first-use shell**

Create one top-level fixed-position overlay. Reposition with `requestAnimationFrame` from target rect updates, scroll, resize, iframe load, and target messages. The button never changes target dimensions. Add states for download, ready, loading, listening level, recognizing, 10-second countdown, and error. The first-use dialog contains default/custom location, choose-folder, detect-existing, download, cancel, and progress.

- [ ] **Step 7: Run tests and commit**

```powershell
Set-Location integrations/openshop
npx vitest run tests/hstar-voice-coordinator.test.js
Set-Location ../..
git add static/js/voice-audio-worklet.js static/js/voice-assistant-coordinator.js static/css/voice-assistant.css integrations/openshop/tests/hstar-voice-coordinator.test.js
git commit -m "feat: add realtime browser voice coordinator"
```

---

### Task 10: Software Settings Voice Management UI

**Files:**
- Create: `static/js/voice-settings-panel.js`
- Create: `tools/tests/software-settings-voice-assistant.test.mjs`
- Modify: `static/software-settings.html:1-450`
- Modify: `tools/tests/software-settings-integration.test.mjs`

- [ ] **Step 1: Write failing static UI contract tests**

```javascript
assert.match(html, /id="voiceAssistantCard"/, 'settings exposes voice assistant card');
assert.match(html, /id="voiceStorageMode"/, 'settings exposes inherit/custom storage mode');
assert.match(html, /id="voiceStorageInput"/, 'settings exposes voice data path');
assert.match(html, /id="voiceDownloadBtn"/, 'settings exposes download action');
assert.match(html, /id="voiceDetectBtn"/, 'settings exposes existing-model detection');
assert.match(html, /id="voiceProgress"[^>]*role="progressbar"/, 'download progress is accessible');
assert.match(js, /\/api\/voice-assistant\/status/, 'panel reads authoritative status');
assert.match(js, /Shift\+Q/, 'panel exposes approved default shortcut');
assert.doesNotMatch(html, /type="password"[^>]*data-voice-input="on"/, 'secrets never opt into voice');
```

- [ ] **Step 2: Run Node test and verify failure**

```powershell
node --test tools/tests/software-settings-voice-assistant.test.mjs
```

- [ ] **Step 3: Add the settings card without nesting cards**

Add one sibling `<section id="voiceAssistantCard" class="card">` after local storage. Include status, storage mode, effective path, model path/revision/size, runtime version, device, microphone select, language select, shortcut input, prewarm checkbox, and command toolbar. Mark storage path, shortcut capture, and machine values with `data-voice-input="off"`.

- [ ] **Step 4: Implement authoritative state rendering**

`voice-settings-panel.js` must render only values returned by the backend. It polls every 750ms only while an install/migrate/repair task is active and otherwise reacts to `voice-assistant-updated` messages.

```javascript
async function api(path, options){
  const response = await fetch(path, {cache:'no-store', ...options});
  const body = await response.json().catch(() => ({}));
  if(!response.ok) throw new Error(body.detail || body.message || '语音助手操作失败。');
  return body;
}

function renderProgress(task){
  progress.hidden = !task;
  progress.value = task?.total_bytes > 0
    ? Math.min(100, task.downloaded_bytes / task.total_bytes * 100)
    : 0;
  progress.removeAttribute('aria-valuenow');
  if(task?.total_bytes > 0) progress.setAttribute('aria-valuenow', String(progress.value));
}
```

Unknown totals use an indeterminate visual and bytes downloaded, never a fake percentage.

- [ ] **Step 5: Wire choose, detect, install, cancel, repair, migrate, update, and uninstall**

All destructive operations use an in-app confirmation dialog that displays the exact affected path and ownership. Disable duplicate actions while a task is active. Saving a bad path leaves the old setting visible and active.

- [ ] **Step 6: Run tests and commit**

```powershell
node --test tools/tests/software-settings-voice-assistant.test.mjs
node --test tools/tests/software-settings-integration.test.mjs
git add static/software-settings.html static/js/voice-settings-panel.js tools/tests/software-settings-voice-assistant.test.mjs tools/tests/software-settings-integration.test.mjs
git commit -m "feat: add voice model management settings"
```

---

### Task 11: Page Coverage, OpenShop, and 3D Director Integration

**Files:**
- Create: `tools/tests/voice-assistant-page-coverage.test.mjs`
- Modify: `static/index.html`
- Modify: `static/zimage.html`
- Modify: `static/enhance.html`
- Modify: `static/klein.html`
- Modify: `static/angle.html`
- Modify: `static/online.html`
- Modify: `static/gpt-chat.html`
- Modify: `static/asset-manager.html`
- Modify: `static/canvas-list.html`
- Modify: `static/canvas.html`
- Modify: `static/smart-canvas.html`
- Modify: `static/api-settings.html`
- Modify: `static/comfyui-settings.html`
- Modify: `static/software-settings.html`
- Modify: `integrations/openshop/index.html`
- Modify: `static/openshop/index.html` through the OpenShop build
- Modify: `integrations/storyai-3d-director-desk/index.html`
- Modify: `static/3d-director/index.html` through the Vite build
- Modify: `static/js/canvas.js`
- Modify: `static/js/smart-canvas.js`
- Modify: `static/gpt-chat.html`
- Modify: `static/js/asset-manager.js`
- Modify: `integrations/openshop/host/openshop-generative-tools.js`
- Modify: `static/openshop/host/openshop-generative-tools.js` through the OpenShop build

- [ ] **Step 1: Write a failing page coverage contract**

```javascript
const entryPages = [
  'zimage.html', 'enhance.html', 'klein.html', 'angle.html', 'online.html',
  'gpt-chat.html', 'asset-manager.html', 'canvas-list.html', 'canvas.html',
  'smart-canvas.html', 'api-settings.html', 'comfyui-settings.html',
  'software-settings.html', 'openshop/index.html', '3d-director/index.html',
];

for(const relative of entryPages){
  const html = readFileSync(resolve(root, 'static', relative), 'utf8');
  assert.match(html, /\/static\/js\/voice-input-adapter\.js\?v=/,
    `${relative} loads the shared voice target adapter`);
}

const shell = readFileSync(resolve(root, 'static/index.html'), 'utf8');
assert.match(shell, /\/static\/js\/voice-assistant-coordinator\.js\?v=/,
  'main shell owns the one global voice coordinator');
assert.match(shell, /\/static\/css\/voice-assistant\.css\?v=/,
  'main shell owns global voice styles');
```

Also scan API key, token, path, number, shortcut-capture, hidden Fabric textarea, and readonly controls for `data-voice-input="off"` or an excluded input type.

- [ ] **Step 2: Run coverage test and verify failure**

```powershell
node --test tools/tests/voice-assistant-page-coverage.test.mjs
```

- [ ] **Step 3: Add shared scripts in deterministic order**

In `static/index.html`, load:

```html
<link rel="stylesheet" href="/static/css/voice-assistant.css?v=...">
<script src="/static/js/voice-input-adapter.js?v=..."></script>
<script src="/static/js/voice-assistant-coordinator.js?v=..."></script>
```

Every child entry page loads only `voice-input-adapter.js`; it discovers the parent coordinator via same-origin messages. Add the script before `</body>` so it does not delay first paint. Main shell iframe `load` handlers call `window.HstarVoiceAssistant?.attachFrame(frame)` after theme/language/scale sync.

- [ ] **Step 4: Mark sensitive and machine fields explicitly**

Add `data-voice-input="off"` to API keys, provider URLs, model IDs, file paths, output paths, shortcut capture inputs, numeric/custom-size fields, hidden Fabric textareas, and readonly identifiers. Add `data-voice-input="on"` and `data-voice-label` only to natural-language custom controls missed by standard selectors.

Generated node markup in `canvas.js` and `smart-canvas.js` must label prompt, LLM, image instruction, and description textareas while leaving model/size/settings controls excluded.

- [ ] **Step 5: Register OpenShop rich editors without breaking mention capsules**

In the OpenShop source, register generative-fill and local-redraw editors after their DOM exists. The custom adapter must use the editor's current selection and composition span, preserve existing blue mention capsules, and commit plain recognized text without converting spoken `@` into a mention.

```javascript
window.HstarVoiceInputAdapter?.register(editor, {
  getSelection: () => captureEditorSelection(editor),
  beginComposition: () => beginVoiceComposition(editor),
  updateComposition: (_state, text) => updateVoiceComposition(editor, text),
  commitComposition: (_state, text) => commitVoiceComposition(editor, text),
  cancelComposition: state => cancelVoiceComposition(editor, state),
  isTargetAvailable: () => editor.isConnected && !editor.hidden,
  getTargetLabel: () => mode === 'fill' ? '生成式填充要求' : '局部重绘要求',
});
```

- [ ] **Step 6: Build OpenShop and 3D Director from source**

```powershell
Set-Location integrations/openshop
npm run build:hstar
Set-Location ../storyai-3d-director-desk
npm run build
Set-Location ../..
```

Expected: OpenShop reports one build SHA; Vite writes `static/3d-director` and retains the absolute shared adapter script.

- [ ] **Step 7: Refresh cache keys, run integration tests, and commit**

```powershell
.\python\python.exe -X utf8 -c "import main; main.sync_static_html_versions()"
node --test tools/tests/voice-assistant-page-coverage.test.mjs
node --test tools/tests/static-cache-integrity.test.mjs
Set-Location integrations/openshop
npx vitest run tests/hstar-voice-target-adapter.test.js tests/hstar-generative-tools.test.js
Set-Location ../..
git add static integrations/openshop integrations/storyai-3d-director-desk tools/tests/voice-assistant-page-coverage.test.mjs
git commit -m "feat: connect voice input across HstarA pages"
```

Before committing, inspect the staged list and exclude `node_modules`, `.vite`, source maps not already part of the build policy, and unrelated generated files.

---

### Task 12: Isolated Fake-Engine Browser E2E

**Files:**
- Create: `integrations/openshop/tests/hstar-voice-assistant.e2e.spec.js`
- Modify: `voice_assistant/testing.py`
- Modify: `integrations/openshop/package.json`

- [ ] **Step 1: Add a deterministic fake engine contract**

The fake backend reports runtime/model ready and emits these events after receiving non-empty PCM:

```json
{"type":"ready","device":"cpu","sequence":0}
{"type":"partial","text":"测试","sequence":1}
{"type":"partial","text":"测试语音","sequence":2}
{"type":"final","text":"测试语音完成。","sequence":3}
```

When it receives only silence, it emits `speech-state` countdown events and `stopped(reason="silence-timeout")` at exactly 10 seconds according to its injected monotonic clock. Production mode must reject `--test-mode` unless `HSTAR_VOICE_TEST_MODE=1`.

- [ ] **Step 2: Write failing Playwright tests for main shell and canvas frames**

```javascript
test('dictates into the focused smart-canvas prompt without duplicate partials', async ({page}) => {
  await page.goto(baseUrl);
  const frame = await openSmartCanvas(page);
  const prompt = frame.locator('[data-voice-label="Prompt"]').first();
  await prompt.focus();
  await frame.keyboard.press('Shift+Q');
  await expect(prompt).toHaveValue(/测试语音完成。/);
  await expect(prompt).not.toHaveValue(/测试测试/);
});

test('ten seconds of silence stops and releases the microphone', async ({page}) => {
  await startVoiceOnFocusedPrompt(page);
  await expect(page.locator('[data-voice-state="listening"]')).toBeVisible();
  await expect(page.locator('[data-voice-state="ready"]')).toBeVisible({timeout: 12_000});
  expect(await page.evaluate(() => window.HstarVoiceAssistant.debugState().trackCount)).toBe(0);
});
```

Add cases for selected-text replacement, `Ctrl+Z`, target deletion, iframe navigation, stale sequence rejection, OpenShop mention preservation, GPT input, asset search, and one-session microphone contention.

- [ ] **Step 3: Generate fake microphone audio at test runtime**

The test creates a temporary PCM WAV in `os.tmpdir()` and launches Chromium with:

```javascript
const browser = await chromium.launch({args:[
  '--use-fake-device-for-media-stream',
  '--use-fake-ui-for-media-stream',
  `--use-file-for-fake-audio-capture=${wavPath}`,
]});
```

Generate the WAV from numeric samples in the test; do not commit a recording fixture. Remove the temporary file in `finally`.

- [ ] **Step 4: Start an isolated 3011 test server**

Use a temporary `HSTAR_DATA_DIR`, never port 5000 and never the user's port-3000 data:

```powershell
$testRoot = Join-Path $env:TEMP "hstar-voice-e2e"
$env:HSTAR_DATA_DIR = $testRoot
$env:HSTAR_PORT = "3011"
$env:HSTAR_VOICE_TEST_MODE = "1"
$server = Start-Process -FilePath ".\python\python.exe" -ArgumentList "-X","utf8","main.py" -WorkingDirectory $PWD -PassThru -WindowStyle Hidden
$env:HSTAR_BASE_URL = "http://127.0.0.1:3011"
```

Wait on `/api/app-info`, run tests, then stop only `$server` in `finally`. Resolve and verify `$testRoot` is under `$env:TEMP` before deleting it.

- [ ] **Step 5: Run E2E and commit**

```powershell
Set-Location integrations/openshop
npx playwright test tests/hstar-voice-assistant.e2e.spec.js
Set-Location ../..
git add voice_assistant/testing.py integrations/openshop/tests/hstar-voice-assistant.e2e.spec.js integrations/openshop/package.json
git commit -m "test: cover global voice assistant workflows"
```

Expected: all fake-engine E2E cases pass; ports 3000 and 5000 remain untouched.

---

### Task 13: Real Fun-ASR-Nano-2512 Install, CPU/CUDA Smoke, and Performance

**Files:**
- Create: `tools/voice-assistant-real-smoke.py`
- Modify: `voice_assistant/runtime_manifest.json` only if the pinned set fails the documented compatibility gate
- Modify: `voice_assistant/recognizer.py` only for failures reproduced by the real model
- Modify: `voice_assistant/settings.py` and `static/js/voice-settings-panel.js` only if native `auto` language detection fails the official three-language examples

- [ ] **Step 1: Implement an opt-in real smoke runner**

```python
import argparse
import asyncio
import ctypes
import json
import os
import time
from datetime import datetime, timezone
from pathlib import Path

from voice_assistant.installer import VoiceInstaller
from voice_assistant.recognizer import (
    FunAsrRecognizer,
    VoiceRecognitionError,
    prepend_runtime_site,
)
from voice_assistant.registry import ModelRegistry
from voice_assistant.settings import normalize_voice_settings, voice_paths

REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
TERMINAL_INSTALL_STATES = {"completed", "cancelled", "failed"}

def is_inside(path: Path, parent: Path) -> bool:
    resolved = path.resolve()
    root = parent.resolve()
    return resolved == root or root in resolved.parents

async def wait_for_install(installer: VoiceInstaller, task_id: str):
    while True:
        state = installer.status(task_id)
        if state.status in TERMINAL_INSTALL_STATES:
            if state.status != "completed" or not state.model_ready:
                raise RuntimeError(state.error_code or f"install ended as {state.status}")
            return state
        await asyncio.sleep(0.5)

def load_pcm16(path: Path, runtime_site: Path) -> tuple[bytes, float]:
    prepend_runtime_site(str(runtime_site))
    import numpy
    import soundfile
    import torch
    from torchaudio.functional import resample

    samples, sample_rate = soundfile.read(path, dtype="float32", always_2d=True)
    mono = samples.mean(axis=1)
    if sample_rate != 16000:
        mono = resample(torch.from_numpy(mono), sample_rate, 16000).numpy()
    mono = numpy.clip(mono, -1.0, 1.0)
    pcm16 = (mono * 32767.0).astype("<i2").tobytes()
    return pcm16, len(mono) / 16000.0

def process_peak_rss_bytes() -> int:
    if os.name != "nt":
        import resource
        return int(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss) * 1024

    class ProcessMemoryCounters(ctypes.Structure):
        _fields_ = [
            ("cb", ctypes.c_ulong),
            ("PageFaultCount", ctypes.c_ulong),
            ("PeakWorkingSetSize", ctypes.c_size_t),
            ("WorkingSetSize", ctypes.c_size_t),
            ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
            ("QuotaPagedPoolUsage", ctypes.c_size_t),
            ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
            ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
            ("PagefileUsage", ctypes.c_size_t),
            ("PeakPagefileUsage", ctypes.c_size_t),
        ]

    counters = ProcessMemoryCounters()
    counters.cb = ctypes.sizeof(counters)
    handle = ctypes.windll.kernel32.GetCurrentProcess()
    ok = ctypes.windll.psapi.GetProcessMemoryInfo(
        handle, ctypes.byref(counters), counters.cb
    )
    return int(counters.PeakWorkingSetSize) if ok else 0

async def run_real_smoke(
    root: Path, install: bool, device: str, languages: list[str]
) -> dict:
    settings = normalize_voice_settings(
        {"voice_assistant": {"storage_mode": "custom", "storage_root": str(root)}},
        app_data_root=str(root.parent),
    )
    paths = voice_paths(settings)
    installer = VoiceInstaller(paths)
    if install:
        task = installer.start_install(profile=device)
        await wait_for_install(installer, task.task_id)

    detection = ModelRegistry().detect(root)
    if not detection.ready:
        return {"ok": False, "error_code": "VOICE_MODEL_MISSING", "missing": detection.missing}

    prepend_runtime_site(str(paths["runtime_site"]))
    import torch
    if torch.cuda.is_available():
        torch.cuda.reset_peak_memory_stats()

    recognizer = FunAsrRecognizer(detection.model_path)
    started = time.perf_counter()
    try:
        selected_device = await asyncio.to_thread(recognizer.load, device)
    except VoiceRecognitionError as error:
        return {"ok": False, "error_code": error.code, "message": str(error)}
    cold_load_seconds = time.perf_counter() - started

    results = []
    try:
        test_cases = [(language, language) for language in languages]
        test_cases += [("auto", language) for language in languages]
        for requested_language, sample_language in test_cases:
            audio_path = Path(detection.model_path) / "example" / f"{sample_language}.mp3"
            pcm16, audio_seconds = load_pcm16(audio_path, paths["runtime_site"])
            started = time.perf_counter()
            transcript = await asyncio.to_thread(
                recognizer.transcribe, pcm16, requested_language
            )
            elapsed = time.perf_counter() - started
            results.append({
                "requested_language": requested_language,
                "sample_language": sample_language,
                "transcript": transcript,
                "audio_seconds": audio_seconds,
                "inference_seconds": elapsed,
                "real_time_factor": elapsed / audio_seconds,
            })
        report = {
            "ok": all(item["transcript"] for item in results),
            "model_path": detection.model_path,
            "revision": detection.revision,
            "device": selected_device,
            "cold_load_seconds": cold_load_seconds,
            "warm_session_seconds": min(item["inference_seconds"] for item in results),
            "peak_rss_bytes": process_peak_rss_bytes(),
            "peak_vram_bytes": (
                int(torch.cuda.max_memory_allocated()) if selected_device == "cuda" else 0
            ),
            "results": results,
        }
    finally:
        recognizer.close()

    log_dir = paths["logs"]
    log_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    (log_dir / f"real-smoke-{stamp}.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return report

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--voice-root", required=True)
    parser.add_argument("--install", action="store_true")
    parser.add_argument("--device", choices=("auto", "cuda", "cpu"), default="auto")
    parser.add_argument("--languages", nargs="+", default=["zh", "en", "ja"])
    args = parser.parse_args()
    root = Path(args.voice_root).expanduser().resolve()
    assert not is_inside(root, REPOSITORY_ROOT), "real model root must stay outside repository"
    report = asyncio.run(run_real_smoke(root, args.install, args.device, args.languages))
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report["ok"] else 1

if __name__ == "__main__":
    raise SystemExit(main())
```

The runner uses the model's own `example/zh.mp3`, `example/en.mp3`, and `example/ja.mp3`. It records non-empty transcript, selected device, cold-load seconds, warm-session seconds, audio duration, real-time factor, peak RSS, and peak VRAM when available. Write reports under `<voice-root>/.hstar-voice/logs`, not the repository.

- [ ] **Step 2: Install the real optional runtime and model outside the repository**

```powershell
$voiceRoot = Join-Path $env:LOCALAPPDATA "Hstar\voice-assistant-real-test"
.\python\python.exe -X utf8 tools/voice-assistant-real-smoke.py --voice-root $voiceRoot --install --device auto --languages zh en ja
```

Expected: progress covers runtime install, manifest resolution, approximately 2.13GB `model.pt` plus tokenizer/config files, validation, and load smoke. The command may incur network and disk usage but must not modify tracked files or the main Python site-packages.

- [ ] **Step 3: Verify CUDA and explicit CPU paths**

When an NVIDIA CUDA device is present, run both:

```powershell
.\python\python.exe -X utf8 tools/voice-assistant-real-smoke.py --voice-root $voiceRoot --device cuda --languages zh en ja
.\python\python.exe -X utf8 tools/voice-assistant-real-smoke.py --voice-root $voiceRoot --device cpu --languages zh en ja
```

If no CUDA device is present, the CUDA command must return the stable `VOICE_CUDA_UNAVAILABLE` result and the CPU command must pass. Do not mark CUDA tested on a machine where it was not actually available.

- [ ] **Step 4: Run the real browser path on an isolated port**

Start HstarA on port 3011 with an isolated software-settings file that points `voice_assistant.storage_root` at `$voiceRoot`. Use the real service, not `HSTAR_VOICE_TEST_MODE`. Feed model example audio through Chromium's fake microphone and verify final text reaches GPT, a smart-canvas Prompt, and OpenShop. Record cold and warm timings; warmed click-to-audio-ready must be at most 500ms.

- [ ] **Step 5: Confirm load and resource behavior**

Verify:

- The main FastAPI process remains responsive during cold model load.
- A second session reuses the same model process.
- Temporary partial requests remain bounded on CPU.
- Ten minutes idle unloads the model and releases major memory/VRAM.
- Ten seconds of VAD-confirmed silence releases browser microphone tracks.
- No raw recording is written under the voice root.

- [ ] **Step 6: Lock any compatibility correction and commit**

If a pinned package must change, update `runtime_manifest.json` to the exact tested version and include the reason in the commit. Never relax a pin to `>=`.

If any explicit `zh`/`en`/`ja` case passes while its corresponding `auto` case fails or switches language incorrectly, remove `auto` from backend validation and the settings selector in the same commit. Do not map `auto` to Chinese.

```powershell
git status --short
git add tools/voice-assistant-real-smoke.py voice_assistant/runtime_manifest.json voice_assistant/recognizer.py voice_assistant/settings.py static/js/voice-settings-panel.js
git commit -m "test: validate real FunASR voice runtime"
```

Expected: `git status` shows no model, runtime, report, recording, or cache file.

---

### Task 14: Packaging Exclusions, Full Regression, and Release Readiness

**Files:**
- Create: `tools/tests/voice-assistant-installer-exclusion.test.mjs`
- Modify: `.gitignore`
- Modify: `build/installer/Hstar.iss`
- Modify: `VERSION` only when preparing the final release build, not during feature development

- [ ] **Step 1: Write failing repository and installer exclusion tests**

```javascript
const ignore = readFileSync('.gitignore', 'utf8');
const installer = readFileSync('build/installer/Hstar.iss', 'utf8');
assert.match(ignore, /\.hstar-voice\//, 'voice runtime directory is ignored');
assert.match(ignore, /FunAudioLLM\/Fun-ASR-Nano-2512\//, 'local model directory is ignored');
assert.match(installer, /\.hstar-voice\\\*/, 'installer excludes optional runtime');
assert.match(installer, /FunAudioLLM\\Fun-ASR-Nano-2512\\\*/, 'installer excludes model weights');

const staged = execFileSync('git', ['diff', '--cached', '--name-only'], {encoding:'utf8'});
assert.doesNotMatch(staged, /(?:model\.pt|\.safetensors|\.hstar-voice|Fun-ASR-Nano-2512)/i);
```

Also walk `build/installer/stage` when it exists and fail on `.pt`, `.safetensors`, `.bin` larger than 100MB, `.hstar-voice`, ModelScope cache, audio recordings, or voice diagnostic logs.

- [ ] **Step 2: Run test and verify failure**

```powershell
node --test tools/tests/voice-assistant-installer-exclusion.test.mjs
```

- [ ] **Step 3: Add narrow ignore and installer patterns**

Append to `.gitignore`:

```gitignore
# Optional local voice assistant runtime and model data
**/.hstar-voice/
/FunAudioLLM/Fun-ASR-Nano-2512/
/voice-assistant-data/
```

Extend the Inno Setup `[Files]` `Excludes` value with `.hstar-voice\*`, `FunAudioLLM\Fun-ASR-Nano-2512\*`, `voice-assistant-data\*`, ModelScope cache paths, and voice test reports. Do not use a broad `*.bin` exclusion that could remove legitimate HstarA assets.

- [ ] **Step 4: Run focused voice test suite**

```powershell
.\python\python.exe -m unittest discover -s tests -p "test_voice_*.py" -v
node --test tools/tests/software-settings-voice-assistant.test.mjs
node --test tools/tests/voice-assistant-page-coverage.test.mjs
node --test tools/tests/voice-assistant-installer-exclusion.test.mjs
Set-Location integrations/openshop
npx vitest run tests/hstar-voice-target-adapter.test.js tests/hstar-voice-coordinator.test.js
npx playwright test tests/hstar-voice-assistant.e2e.spec.js
Set-Location ../..
```

Expected: all focused tests pass.

- [ ] **Step 5: Run full HstarA regression**

```powershell
Get-ChildItem tools/tests/*.test.mjs | ForEach-Object { node --test $_.FullName; if($LASTEXITCODE){ exit $LASTEXITCODE } }
.\python\python.exe -m unittest discover -s tests -p "test_*.py" -v
Set-Location integrations/openshop
npm test
npx playwright test
npm run audit:i18n
Set-Location ../..
node tools/audit-text-encoding.mjs
node --check static/js/voice-input-adapter.js
node --check static/js/voice-assistant-coordinator.js
node --check static/js/voice-settings-panel.js
git diff --check
```

Expected: all existing and new suites pass; text encoding audit reports no mojibake; static cache integrity passes.

- [ ] **Step 6: Inspect the complete staged payload**

```powershell
git status --short
git diff --stat
git diff --check
git grep --cached -n -I -E '(ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|(^|[^[:alnum:]])sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16})'
```

Expected: no credential-shaped values; no model/runtime/cache/user data; `data/asset_library.json` remains unstaged unless the user explicitly requests it.

- [ ] **Step 7: Commit release-ready integration**

```powershell
git add .gitignore build/installer/Hstar.iss tools/tests/voice-assistant-installer-exclusion.test.mjs
git commit -m "build: exclude optional voice model data"
```

Do not push or build the stable 5000-port installer until the user separately requests release packaging after port-3000 verification.

---

## Execution Checkpoints

Use inline execution only. Stop for a concise user checkpoint after:

1. Tasks 1-3: storage, registry, and installer contracts are green.
2. Tasks 4-7: fake isolated backend, API, and shutdown are green.
3. Tasks 8-11: global input UI and every page integration are green.
4. Task 12: isolated browser E2E is green.
5. Task 13: actual ModelScope download and real CPU/CUDA results are recorded.
6. Task 14: full regression and package exclusion audit are green.

At every checkpoint, report exact tests, real hardware paths tested, remaining risks, and any unavailable hardware capability. Never report CUDA as tested from mocks.
