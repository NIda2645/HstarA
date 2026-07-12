# Hstar Android Client Design

## 1. Goal

Build a mature, independently installable Android client for HstarA. The Android app must run without a Windows PC or Hstar desktop process, retain HstarA's user-visible features and workflows, connect directly to configured online APIs, store projects locally, export selected media to the system gallery, and remove all app-private data when uninstalled.

The first acceptance device is Xiaomi 17 Ultra. Layout and behavior must use Android window metrics and must not hard-code that device's pixel dimensions.

## 2. Platform Scope

- `compileSdk` and `targetSdk`: Android 16 / API 36.
- `minSdk`: Android 15 / API 35.
- Release ABI: `arm64-v8a`.
- Development builds may include an emulator ABI.
- Primary package: signed APK installable through the Xiaomi system package installer.
- The Windows application remains supported and isolated from the Android build.

The Android implementation preserves behavior and results rather than Windows-specific internals. Windows executables, PowerShell, Inno Setup, drive-letter paths, and desktop-only CLI processes are replaced by Android-native equivalents.

## 3. Architecture

Create an independent `android/` Gradle project inside HstarA.

### 3.1 Native shell

Kotlin and Jetpack Compose own:

- application lifecycle and navigation;
- permissions and system dialogs;
- Room database access;
- Android Keystore integration;
- MediaStore imports and exports;
- background and foreground task management;
- notifications, sharing, and external-app intents;
- APK update handoff to the Android package installer.

### 3.2 Web feature host

The existing HstarA web UI remains the primary implementation for ordinary canvas, smart canvas, 3D Director Desk, API settings, online generation, chat, asset management, and workflow pages.

An in-process Ktor server binds only to `127.0.0.1` on a random available port. It serves bundled static assets and implements the compatible `/api/*` surface, allowing existing frontend requests and same-origin behavior to remain intact.

Each app process creates an unguessable session token. API requests from the WebView must include that token. The Ktor server rejects requests without it, does not bind to external interfaces, and is stopped with the app process.

Use AndroidX WebKit and a current Android System WebView. Disable unsafe file URL access, JavaScript debugging in release builds, mixed content, and exported native bridge components.

### 3.3 Backend migration

Do not embed the Windows Python runtime. Migrate `main.py` behavior into bounded Kotlin modules:

- `ProviderRegistry`: API providers, models, endpoint overrides, protocol rules, and encrypted credentials.
- `ApiAdapters`: text, image, video, recognition, RunningHub, ComfyUI, and compatible custom-provider protocols.
- `TaskEngine`: persistent generation queue, polling, cancellation, recovery, and result normalization.
- `ProjectRepository`: projects, canvases, nodes, links, workflows, recycle bin, and migrations.
- `MediaRepository`: private media, reference counting, thumbnails, metadata, cleanup, and MediaStore export.
- `AssetRepository`: asset libraries, folders, classifications, captions, and imports.
- `SettingsRepository`: app settings, touch preferences, appearance, and endpoint configuration.
- `DiagnosticsRepository`: redacted local logs and user-initiated export.

Shared JSON schemas and contract fixtures must keep Windows and Android behavior aligned.

## 4. Feature Parity Rules

The Android feature matrix starts from every user-visible HstarA entry and records one of:

- same implementation through the existing web feature;
- Kotlin implementation behind the same API contract;
- Android-native equivalent with the same user outcome.

Windows-only operations map as follows:

- external software open -> Android chooser, share, or `ACTION_VIEW` intent;
- choose folder / Save As -> app-private storage plus Save to Gallery;
- desktop shortcuts -> touch toolbar plus external keyboard shortcuts;
- Codex/Gemini/Jimeng CLI -> mobile API or OAuth adapters behind the same feature entry;
- local ComfyUI -> configurable LAN or public ComfyUI instance;
- Windows update installer -> signed APK update with explicit system confirmation.

No feature is considered migrated when only its label or visual control exists. Its upstream inputs, protocol dispatch, persisted task state, downstream node creation, media output, cancellation, and failure reporting must work.

## 5. Responsive UI

### 5.1 Window behavior

- Support portrait and landscape without forced orientation.
- Use window size classes, density-independent dimensions, safe-area insets, and keyboard insets.
- Use bottom navigation on compact portrait windows and a navigation rail on wider or landscape windows.
- Put secondary destinations in a More drawer without removing existing HstarA entries.
- Use bottom sheets on compact portrait windows and side panels on wider windows.
- Preserve a minimum 48 dp touch target.
- Do not scale font size from viewport width.
- Respect system font scaling while preventing clipped controls and overlapping text.
- Support light and dark themes, gesture navigation, display cutouts, rounded corners, and Xiaomi system bars.

### 5.2 Canvas gestures

- Tap selects a node.
- Dragging a node moves that node.
- One-finger dragging on empty space pans the canvas.
- Two-finger gestures pan and zoom around the gesture centroid.
- Long press opens the relevant node or canvas menu.
- Existing double-tap, triple-tap, marker, marker-reference, and `@` behavior remains available with touch slop and timing guards.
- External keyboard shortcuts remain available, with visible toolbar equivalents for touch-only use.
- Stylus input supports hover, tap, and drag without becoming a requirement.

### 5.3 3D Director Desk

- Landscape uses the full multi-panel workspace.
- Portrait keeps the 3D viewport full-screen and moves scene, property, model-library, and capture panels into switchable bottom sheets.
- Gesture ownership must prevent camera controls from conflicting with page scrolling.
- Adaptive quality monitors frame rate and thermal status and may reduce shadows, antialiasing, pixel ratio, or model detail while preserving scene data.

## 6. Data and Media Lifecycle

Room stores projects, canvases, nodes, edges, tasks, provider metadata, histories, assets, and references. Files use UUID-based names in app-private storage.

Each private media record maintains references from canvases, nodes, tasks, and asset-library items. A file may be deleted only when no live or recycled entity references it.

Canvas deletion follows the existing recycle-bin model:

1. Moving a canvas to the recycle bin preserves its database and private media.
2. Restoring the canvas restores its references without re-downloading media.
3. Permanent deletion or expiry after 30 days removes canvas records and garbage-collects media with zero remaining references.

Generated images and videos remain private by default. Save to Gallery creates a separate MediaStore copy. The gallery copy remains after canvas deletion or application uninstall and is no longer governed by private-media reference counts.

Set `android:allowBackup="false"` and exclude sensitive state from device transfer mechanisms. Uninstalling the application therefore clears Room, private files, caches, encrypted credentials, pending tasks, and recycled canvases. Media explicitly exported to the gallery remains.

The settings page provides separate actions for clearing cache, clearing failed-task files, emptying the recycle bin, and clearing all local app data. Destructive actions require confirmation and report what will be preserved in the gallery.

## 7. API and Task Engine

Retain all current provider protocols, model lists, custom URLs, generation/edit endpoints, and protocol overrides.

Kotlin HTTP clients perform upstream requests outside WebView, avoiding browser CORS restrictions. Requests follow Android system VPN, proxy, DNS, and certificate policies.

Reference-image requests must fail before submission when source images cannot be read or converted. They must never silently send text-only requests when an image was supplied.

Credentials are encrypted with Android Keystore. Plaintext keys exist only for the duration of a request and must not enter WebView state, Room, crash reports, or logs.

Text, image, video, recognition, and ComfyUI operations use distinct typed task channels. Every task stores:

- provider, protocol, model, and normalized parameters;
- input media references and prompt data;
- lifecycle state and upstream task identifier;
- bounded polling schedule and cancellation state;
- normalized outputs or redacted failure details.

Use WorkManager for deferrable persistence and a foreground service with notification controls for active long-running work. Android force-stop pauses work until the user opens the app again; the app must reconcile persisted task states on restart.

Explicit upstream failures stop local progress immediately, update canvas nodes, and enter the local log. Polling is bounded, cancellation aborts active HTTP calls when possible, and automatic retries must not risk duplicate billing.

## 8. Permissions and Security

Request only permissions required for:

- internet access;
- notifications;
- foreground data-transfer tasks.

Use the system photo picker for imports and MediaStore for exports. Do not request all-files access. Do not request contacts, location, SMS, call logs, microphone, or other unrelated permissions.

Release builds use a private signing key stored outside Git. Every upgrade must use the same signing identity. APK installation and upgrades require explicit Android package-installer confirmation; no silent installation is attempted.

Diagnostics remain local by default and redact credentials, authorization headers, signed URLs, and private media content. Export occurs only after a user command.

## 9. Delivery Phases

Each phase produces an installable APK and a parity report.

1. **Feature and protocol baseline**: inventory all HstarA features, API contracts, schemas, and reference workflows.
2. **Android foundation**: Gradle project, Compose shell, Ktor loopback host, WebView security, Room, Keystore, install/uninstall, rotation, and navigation.
3. **Data and media**: projects, canvases, recycle bin, private media, reference counting, gallery export, and cleanup.
4. **API and task engine**: all provider protocols, background queue, notifications, cancellation, recovery, and redacted logs.
5. **Ordinary canvas**: nodes, links, markers, `@`, controller, shortcuts, double/triple tap, and gallery export.
6. **Smart canvas**: workflows, markers, controller, text recognition/edit/removal, downstream generation, and Director nodes.
7. **3D Director Desk**: responsive panels, model library, captures, batch send, independent scene sessions, reset, and adaptive performance.
8. **Remaining applications**: online generation, chat, asset library, software settings, workflow settings, ComfyUI, and mobile CLI equivalents.
9. **Release hardening**: physical-device testing, signing, upgrade, uninstall, security, performance, accessibility, and final parity closure.

## 10. Verification

### Automated

- Kotlin unit tests for repositories, adapters, task state machines, cleanup, and protocol normalization.
- Contract tests that run the same fixtures against Windows FastAPI and Android Ktor implementations.
- Room migration and reference-count tests.
- MockWebServer tests for success, failure, timeout, cancellation, polling, malformed data, and missing reference images.
- Compose UI and WebView integration tests on Android 16 emulator images.
- JavaScript regression tests for canvas behavior shared with Windows.
- Screenshot tests for compact portrait, compact landscape, large-font, dark-mode, and keyboard-open layouts.
- WebGL canvas pixel checks and nonblank capture checks for 3D Director Desk.
- APK content, signing, manifest, permission, and secret scans.

### Xiaomi 17 Ultra acceptance

- portrait/landscape rotation during canvas editing and active tasks;
- system font and display-size changes;
- gesture navigation, cutouts, keyboard, stylus, and external keyboard;
- Wi-Fi, mobile data, VPN, proxy, disconnection, and reconnection;
- lock screen, backgrounding, process reclamation, force-stop, and restart reconciliation;
- low-storage behavior, cache cleanup, recycle-bin purge, and gallery persistence;
- long image/video tasks, cancellation, error termination, and notification controls;
- 3D frame rate, thermal adaptation, screenshot export, and batch send;
- clean install, signed upgrade with data preservation, clear-data, and uninstall with private-data removal.

## 11. Completion Standard

The Android client is complete only when every HstarA feature-matrix item has a working Android implementation or approved Android-native equivalent, all required data flows are functional, the release APK passes automated and Xiaomi 17 Ultra acceptance tests, and no user credential or private media is packaged into the APK.
