# Smart Canvas External Open Design

## Scope

Add an `外部打开` dropdown to the selected Smart Canvas image-node toolbar. Place it after `宫格切分` or `宫格拼接` and before `下载`.

The feature applies only to image media. It must not add backend routes, change browser or Photoshop plugins, or alter the established Classic Canvas external-open behavior.

## User Experience

The toolbar action uses the existing dropdown presentation already established by `编辑文字`, including its caret, compact sizing, menu alignment, and canvas-scaled positioning.

The menu contains these commands in order:

1. `用 Photoshop 打开`
2. `用 Illustrator 打开`
3. `用自定义软件打开`

The command acts on the image currently selected inside the node. The menu closes when the user selects a command, clicks outside it, presses Escape, changes selection, or causes the node toolbar to be rerendered. Opening the external-app menu closes the text-edit menu, and opening the text-edit menu closes the external-app menu.

## Architecture

Smart Canvas owns a small menu controller in `static/js/smart-canvas.js`. It resolves the current node and image index through the existing Smart Canvas toolbar selection helpers, then uses the same backend contract as Classic Canvas:

- `POST /api/open-external-image` with `{ url, app }`
- `POST /api/native/choose-executable` with `{ app, force }`
- `POST /api/software-settings/external-app` with `{ app, path }`

No cross-frame delegation is introduced. The Classic Canvas implementation remains unchanged, limiting regression risk while keeping both surfaces behaviorally consistent through the shared backend contract.

## Data Flow

1. The user opens the dropdown on a selected image node.
2. Smart Canvas records the node ID and active image index.
3. Selecting an app closes the menu and posts the image URL plus the app identifier to `/api/open-external-image`.
4. If no executable is configured, Smart Canvas invokes the native executable picker.
5. A selected executable path is saved through the existing settings endpoint.
6. Smart Canvas retries the original open request once and reports success or the final error through the existing toast surface.

One menu command results in at most one normal open attempt and one retry after an explicit executable selection. There are no background retries.

## Error Handling

- Missing node, image, or URL: close the menu and show a concise unavailable-material message.
- Video or unsupported media: keep the action disabled or reject it without calling the backend.
- Cancelled executable picker: stop without saving or retrying.
- Picker, settings, or open failure: preserve the canvas and report the backend detail through the existing toast mechanism.
- Rerendered or deleted node: discard stale menu state.

## Verification

Contract tests must prove:

- `externalOpen` appears after `grid` and before `download`.
- The toolbar action is a dropdown and contains the three required commands in order.
- The active image URL and selected app reach `/api/open-external-image`.
- Missing app configuration invokes `/api/native/choose-executable`, persists the chosen path, and retries once.
- Outside click, Escape, viewport repositioning, rerendering, and menu mutual exclusion are wired.

Browser verification on the engineering service must confirm the selected image node shows the correctly ordered toolbar, the menu remains aligned while zoomed, and each command follows the existing native workflow.
