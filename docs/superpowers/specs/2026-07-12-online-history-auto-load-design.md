# Online History Automatic Loading Design

## Goal

Restore automatic archive loading while preserving the bounded CPU and network behavior introduced by the online history performance work.

## User Experience

- Remove the clickable "Load More Archive" control.
- Keep a non-interactive sentinel after the archive grid.
- Hide the sentinel label while idle.
- Show the existing localized loading label only while a page request is active.
- Load the next page when the sentinel enters the viewport prefetch margin.
- A continuous intersection may load at most one page. The sentinel must leave the intersection area before another automatic load can be armed.
- If loading fails, do not retry in a loop. A later leave-and-reenter cycle may retry.

## Data And Concurrency

- Keep `PAGE_SIZE = 16` and the paged `/api/history` contract.
- Keep 480px cached previews, lazy decoding, `DocumentFragment` insertion, and original URLs for lightbox/download/reuse.
- Reuse the existing `isLoading`, mutation-depth, revision, and queued-load protections.
- Mutation-driven stale-page retries remain internal and must not depend on observer re-entry.
- Stop observing when `historyHasMore` becomes false.

## Observer Design

- Use one `IntersectionObserver` attached once after the initial archive load.
- Use a modest positive `rootMargin` so the next page starts shortly before the user reaches the bottom.
- Maintain an explicit armed flag:
  - non-intersecting state arms the observer;
  - intersecting state consumes the arm and requests one page;
  - remaining intersecting does not request another page.
- The observer callback never bypasses `loadHistory` guards.

## Accessibility And Errors

- The sentinel is not clickable or keyboard-focusable.
- Give its status text `role="status"` and `aria-live="polite"`.
- During a request, expose the localized loading text.
- On failure, hide the loading status and log the existing diagnostic. Do not create automatic retry loops.

## Verification

- Contract test proves there is no clickable load-more button or click handler.
- Contract test proves one `IntersectionObserver`, an armed flag, and automatic `loadHistory(false)` wiring.
- Browser verification proves:
  - initial load contains at most 16 cards;
  - reaching the bottom adds at most 16 cards;
  - remaining at the bottom does not cascade additional pages;
  - leaving and returning can load the following page;
  - idle status is hidden and loading status is transient;
  - preview and original-image behavior remains unchanged.
