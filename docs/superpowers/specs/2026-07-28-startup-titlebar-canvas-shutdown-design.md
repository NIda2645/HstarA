# Hstar Windows Startup, Title Bar, and Canvas-Style Shutdown Design

## Scope

This change completes the current Windows desktop-shell polish in three focused areas:

1. Perform one final startup-animation smoothness pass without changing the approved Lightfall visual design or the five-second minimum display time.
2. Make the main Hstar Windows title bar dark so it no longer appears as a bright white strip above the application.
3. Replace the traditional Windows-style shutdown confirmation with a borderless native dialog that uses the existing Hstar canvas visual language and follows the active canvas light or dark theme.

Installer generation, installer-size optimization, application data migration, and canvas-data changes are explicitly out of scope. No installer may be produced until the user gives a separate instruction.

## Approved Visual Direction

The shutdown confirmation is a native WPF window for reliability, but it visually behaves like a Hstar canvas modal rather than a separate system dialog.

The approved dialog uses the canvas design tokens already present in `static/css/canvas.css`:

- Canvas-style blurred backdrop treatment around the panel.
- A 20 px panel corner radius.
- A thin neutral border and restrained canvas shadow.
- Compact 13 px, heavy-weight heading typography.
- A 14 px rounded information block using the canvas soft-surface color.
- 38 px pill action buttons.
- A neutral secondary `取消` button and the canvas strong-color `关闭 Hstar` button.
- A compact close icon in the upper-right corner instead of a Windows title bar.

The information copy has two levels:

- Primary line: `当前正在运行的任务将停止`
- Secondary line: `已保存的画布和软件数据不会受到影响。`

In light mode, the dialog uses the canvas white panel, pale-gray border, dark text, and black primary action. In dark mode, it uses the canvas dark panel, cool-gray border, light text, and light primary action. Letter spacing remains zero.

## Approaches Considered

### Borderless native WPF canvas dialog, selected

This keeps shutdown confirmation available even when the WebView, backend, or page fails, while allowing the desktop shell to reproduce the canvas appearance and keyboard behavior. It is the best balance of visual consistency and shutdown reliability.

### Modal injected into the WebView

This would reuse the CSS tokens directly and produce exact browser rendering, but it would be unavailable when the main page is not interactive and would make native close handling depend on JavaScript. It is not selected.

### Styled Windows system dialog

This would be simple and reliable, but its native title bar, frame, and spacing would continue to look separate from the canvas. It is not selected.

## Architecture

### Native window theming

Introduce one focused desktop-shell helper responsible for Windows DWM appearance calls. It applies immersive dark title-bar mode to the main window and, where supported, sets dark caption, border, and caption-text colors. Unsupported attributes and failed calls must be ignored so visual polish can never prevent Hstar from starting.

The helper is initialized after a native window handle exists. The main Hstar title bar remains dark regardless of the current canvas theme, as requested.

### Active canvas theme detection

Before opening the shutdown confirmation, `MainWindow` asks the active main WebView whether the document or body currently carries `theme-dark` or `studio-theme-dark`. The returned JSON boolean is parsed through the structured WebView result rather than by substring matching.

If the WebView is unavailable, navigation is incomplete, script execution fails, or the result is invalid, the dialog falls back to the canvas light theme. Theme detection failure must not block closing or show an additional error.

### Shutdown confirmation window

`ShutdownConfirmationWindow` remains a native modal owned by `MainWindow`, but uses:

- `WindowStyle=None`
- A transparent outer window surface
- A single rounded canvas panel
- Theme resources selected before the dialog is shown
- A custom close icon that performs the same action as `取消`

The existing `ShutdownCoordinator` remains the sole owner of shutdown sequencing. This change does not alter backend-stop behavior, restart behavior, or system-shutdown behavior.

## Interaction Rules

- Clicking the main window close control opens the confirmation once.
- `取消`, the upper-right close icon, and `Esc` all return `false` and leave Hstar running normally.
- The cancel action receives initial keyboard focus.
- Pressing `Enter` must not implicitly close Hstar while cancel has focus.
- Only clicking `关闭 Hstar` returns `true` and allows the existing shutdown coordinator to proceed.
- Repeated clicks on the main close control while a request is active do not create duplicate dialogs.
- Controlled restart and operating-system shutdown continue to bypass the user-close confirmation according to the existing coordinator rules.

## Startup Smoothness Pass

The approved Lightfall media, poster, centered white startup mark and text, toolbar, and five-second minimum display remain unchanged.

The final performance pass is limited to desktop-shell scheduling and media lifecycle work:

- Start native media only once per startup lifecycle.
- Avoid duplicate play, animation, and fallback preparation work.
- Keep the poster available synchronously before the first window paint.
- Reveal video only after the native media path is ready, without adding another colored or black intermediate surface.
- Keep the HTML Lightfall implementation lazy and use it only after native playback failure or for startup failure controls.
- Dispose media and fallback resources exactly once when the main application becomes interactive.

No visual simplification, frame-rate reduction, replacement animation, or additional startup delay is introduced by this pass.

## Error Handling

- DWM theming failures are non-fatal and fall back to the platform title-bar appearance.
- Theme-query failures fall back to the light canvas dialog.
- Shutdown confirmation construction failures must be caught by the existing close path and must not leave the close-request guard permanently active.
- Native startup media failure continues to activate the existing HTML startup fallback.
- Existing diagnostic messages must be valid UTF-8 Chinese; mojibake in files touched by this work must be corrected.

## Verification

Automated tests must cover:

- Main-window title-bar theming is requested after handle creation.
- Unsupported DWM behavior does not throw into startup.
- Dark-theme detection recognizes both `theme-dark` and `studio-theme-dark` on the document and body.
- Invalid or unavailable WebView theme results select the light fallback.
- The shutdown dialog has no system title bar and exposes both light and dark resource sets.
- Cancel retains initial focus and `IsCancel` behavior.
- The close icon and cancel button return `false`.
- The explicit close action returns `true`.
- Existing user-close, controlled-restart, and system-shutdown coordinator contracts remain valid.
- Startup media is started and disposed once, the HTML runtime stays lazy on the successful path, and the minimum five-second display contract remains intact.

Manual verification must cover:

- Light canvas theme shutdown dialog.
- Dark canvas theme shutdown dialog.
- Main title bar on Windows 11 in normal, maximized, and restored states.
- Cancel, close icon, `Esc`, and explicit close interactions.
- A normal startup viewed from desktop launch through the interactive application page, checking for initial stutter, black/blue/color flashes, and title-bar color transitions.

## Constraints

- Do not modify `E:\Hstar缓存`.
- Do not modify the stable installation under `D:\Hstar`.
- Do not modify existing canvas data.
- Do not bind to or disrupt port `3000` during tests.
- Tests that need application data or a backend must use an isolated temporary data root and a random port.
- Do not build or package an installer in this change.
- Preserve the existing startup artwork and the current application feature set.
