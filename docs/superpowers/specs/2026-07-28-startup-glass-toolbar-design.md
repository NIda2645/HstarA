# Hstar Startup Glass Toolbar Design

## Scope

Add a non-interactive glass toolbar to the top of the existing Hstar startup animation. The toolbar must appear identically in the immediate native frame sequence and the embedded Lightfall WebView so their handoff remains visually consistent.

This change does not alter the main application UI, startup backend sequencing, user data, storage paths, or installer outputs.

## Visual Design

- Use the approved B layout: a slim, wide toolbar centered near the top edge.
- Width: 88% of the startup content area, with a maximum width that prevents excessive stretching on wide displays.
- Height: 50 px at the 1280 x 820 design size.
- Top offset: 20 px at the 1280 x 820 design size.
- Surface: translucent charcoal glass, 18 px backdrop blur, subtle saturation, a low-contrast white border, and a restrained shadow.
- Corners: 12 px radius.
- Left group: the official Hstar application logo followed by `Infinite Canvas`.
- Right group: `创意`, `想法`, `无界` with even horizontal spacing.
- Typography: white or softly muted white, no negative letter spacing.
- The toolbar is decorative during startup. It has no hover, click, focus, or navigation behavior.

## Runtime Integration

1. Add the toolbar markup to the embedded startup HTML above the centered startup title.
2. Serve the official Hstar SVG logo as a local embedded startup resource under the existing strict CSP.
3. Keep the toolbar beneath failure controls and above the Lightfall canvas.
4. Preserve the approved Lightfall configuration and the centered animated star/title group.
5. Regenerate the native startup frame sequence from the updated embedded startup page so the first visible frame already includes the toolbar.
6. Continue showing the startup experience for at least five seconds before revealing the interactive application.

## Responsive Behavior

- The toolbar remains centered and scales with the startup viewport.
- On narrower windows, preserve left and right content without overlap by reducing horizontal padding and link gaps.
- `Infinite Canvas` and each Chinese label remain on one line.
- The toolbar must not overlap the centered startup title at the supported minimum window size of 960 x 640.

## Verification

- Contract tests confirm toolbar text, logo resource, local-only CSP, and frame packaging.
- Desktop startup tests confirm the frame sequence, WebView handoff, and five-second minimum display remain intact.
- A real isolated desktop launch verifies that the toolbar is visible from the first frame, stays aligned across the handoff, and does not shift or overlap at 1280 x 820 and 960 x 640.
- No installer is built as part of this work.
