# Hstar Windows 11 Installer Validation - 2026-07-27

## Result

The isolated Windows 11 package passes the current-machine install, startup, packaged feature, storage migration, upgrade, data-preservation, and real CUDA voice-assistant gates. It is not an official release artifact yet because the stage is marked `test-dirty` and a clean Windows 11 VM has not been tested.

The existing stable Hstar installation and its data were not queried, modified, upgraded, or uninstalled. Port `5000` was not used. All package tests used isolated roots and ports.

## Artifact

| Field | Value |
| --- | --- |
| Version | `2026.07.26.1630000001` |
| Source commit | `3acbc6ffd3ceb90f333f1f2fd530c7123141e141` |
| Edition | Windows 11 x64, minimum build `22000` |
| Installer | `build/release/windows11/Hstar_Windows11_Setup_2026.07.26.1630000001.exe` |
| Size | `336,231,897` bytes |
| SHA-256 | `f5cbfc092722d48b8ef7728a56eb45cc9007d09d1fe2abcd86b5511863a32d09` |
| Inno Setup | `6.7.3` |
| Signature | Unsigned (`NotSigned`) |
| Qualification | `test-dirty` |
| Stage payload | `1,044,811,510` bytes; manifest `3,419` payload files; validator `3,420` total files |
| Runtime lock SHA-256 | `9588ae01aff084ef0904eae86d2a7f6cabd31c0be6ad049523c72cd2f4f0de28` |
| SBOM SHA-256 | `4fb999b9d3b36d5c628fce3ca4ae0881ae917314b55cf455c2984f356d9dffec` |

Host: Windows 11 Home China, 64-bit, build `26200`; NVIDIA GeForce RTX 4070 Laptop GPU, driver `32.0.16.1047`.

## Installation And Upgrade

- Installed only to `E:\Claude专业组\tmp\hstar-win11-install-test`.
- Same-version installation completed twice, followed by test version `2026.07.26.1630000002`.
- The version-bumped test installer SHA-256 is `6ceef0cce591fd0699ee4c24d89e2f7b46ad6d8bc2d9465ba42cd17e15781b08`.
- Obsolete probe files beneath installed `app` and `runtime` were removed by upgrade.
- All three pre-existing isolated data files retained identical hashes across installation and upgrade.
- Official API defaults updated while the custom provider and credential file hash remained intact; one sanitized API backup was created.
- No `__pycache__`, `.pyc`, or `.pyo` file was created in the installed program directory.

Evidence: `build/generated/windows11-upgrade-smoke/run-ef26c855a0b641cb9a9cc72a9c1f4404/upgrade-result.json`.

## Startup

Five cold and five warm starts passed:

| Metric | Result | Gate |
| --- | ---: | ---: |
| Cold median interactive | `2,595.63 ms` | `<= 5,000 ms` |
| Warm median interactive | `2,603.38 ms` | `<= 3,000 ms` |
| Shell window | `447.52-586.25 ms` | Recorded |

All ten runs had no visible console process, no eager voice/OpenShop/3D heavyweight process, and successful backend cleanup.

Evidence: `E:\Claude专业组\tmp\hstar-win11-startup-test-5.json`.

## Packaged Features

- Canvas/OpenShop integration: `9/9` passed.
- Packaged shell/settings/3D/storage checks: `4/4` passed.
- Storage migration activated the Unicode target path after restart.
- Custom API provider survived migration and restart.
- Voice status did not download a model or start the service during ordinary package startup.
- Validation port: `55500`; stable port `5000` was explicitly rejected by tooling.

Evidence: `build/generated/windows11-package-smoke/run-a9daa47e2e93414596ec4512e506d49c/package-smoke-result.json`.

## Real Voice Assistant

The model and optional CUDA runtime remain external to the installer at `E:\Claude专业组\tmp\hstar-win11-voice-test`. The installed package Python `3.11.9` downloaded and loaded the complete `FunAudioLLM/Fun-ASR-Nano-2512` model (`model.pt`: `2,127,426,538` bytes).

| Metric | Result |
| --- | ---: |
| Device | CUDA |
| Direct model cold load | `9.455 s` |
| Fastest warm inference | `0.438 s` |
| Browser cold click to listening | `13.677 s` |
| Smart Canvas warm click to listening | `125.2 ms` |
| OpenShop warm click to listening | `157.7 ms` |
| Main-page response during cold load | `12 ms` |
| Peak working set | `7,704,018,944` bytes |
| Peak CUDA allocation | `4,458,356,224` bytes |

Chinese, English, Japanese, and all three `auto` language samples produced transcripts. Browser E2E passed `2/2`, covering GPT, Smart Canvas, OpenShop, one reused model process, live text flow, `Shift+Q`, ten-second silence completion, low-level white-noise rejection, and service/device cleanup.

Evidence:

- `E:\Claude专业组\tmp\hstar-win11-voice-test\.hstar-voice\logs\real-smoke-20260726T203709Z.json`
- Playwright output marker: `HSTAR_REAL_VOICE_METRICS`

## Regression Gate

| Suite | Result |
| --- | --- |
| Python backend | `209/209` passed |
| Root Node contracts | `90/90` test files passed |
| OpenShop Vitest | `644` passed, `4` expected skips |
| OpenShop production build | Passed; SHA-256 `05170af4977911abc070ce25518d99d7963f4849f1085267fc4a64e2c79a1f66` |
| 3D Director Vitest | `323/323` passed |
| 3D Director production build | Passed; existing large-chunk warning remains |
| Desktop shell | `25/25` passed |
| Windows 11 stage | `3,420` files validated; packaged Python/backend imports passed |
| Encoding audit | `189` user-facing files passed |

## Protected State

The following hashes matched before and after validation:

| Path | SHA-256 |
| --- | --- |
| `data/asset_library.json` | `2691a3351df2a53a0f9f2fcb6aa4e97a99a15be603df730cf487d7e52eeb3672` |
| `data/openshop-font-catalog-v1.json` | `7b02677d9f3e73c8830beadf2320e0b7cedf2c2317a6a9150b5bf94582dba89f` |
| `data/projects.json` | `f9f761935e0691cf41b5a7476404e6f0ba2317761f01617b229eda94e9a0d88f` |
| `data/prompt_libraries.json` | `1a54be4654079f543a3b6a2c661acbcc047d1c932286ac1927db5717a379b100` |
| `API/defaults/api-providers.json` | `05632869342d7558da87fdf44474d621b06ea8b38f016c3ed63031abd1397fd1` |

Ports `3000`, `3011`, and `5000` had no remaining test listener after validation. No package or voice test process remained.

## Pending Before Official Release

1. Rebuild from a clean Git tree so the stage qualification is `release`, then regenerate installer hash and report fields.
2. Validate offline installation, first-run wizard, save/restart, upgrade, uninstall, and retained data in a clean Windows 11 23H2-or-newer x64 VM with no preinstalled Python, Node.js, .NET desktop runtime, or WebView2 Evergreen runtime.
3. Re-run authorized paid/provider workflows separately; no paid external API call was made in this validation.
4. The first real voice activation remains `13.677 s` on this host. Warm activation is sub-`160 ms`, but further cold-load optimization is still desirable.
5. Do not install over the user's stable Hstar until the exact final release artifact is explicitly approved.
