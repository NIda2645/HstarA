# Online Image Archive Performance Design

## Problem

The Online Image page currently fetches every matching history record from `/api/history?type=online`, then renders the first 24 full-resolution images. An `IntersectionObserver` can continue appending pages while layout is still settling. With the current local archive this means 457 records, a 2.8 MB initial JSON response, and repeated decoding of large original images. The result is high CPU usage and degraded responsiveness across HstarA.

## Goals

- Keep initial archive work bounded regardless of total history size.
- Preserve original image quality for lightbox preview, download, reuse, and generation.
- Preserve existing archive management behavior for cards that have been loaded.
- Keep existing `/api/history` callers backward compatible.
- Avoid exposing arbitrary local files through the thumbnail API.

## Non-Goals

- Replacing the archive layout or management UI.
- Virtualizing every archive page in HstarA.
- Changing history storage format.
- Re-encoding or modifying original generated images.

## Backend Design

### Compatible Pagination

`GET /api/history` keeps returning the existing array when pagination is not requested. When `paged=1` is supplied, the endpoint accepts:

- `type`: existing history type filter.
- `offset`: zero-based starting record, clamped to a non-negative integer.
- `limit`: requested page size, clamped to `1..50`.

The paged response is:

```json
{
  "items": [],
  "total": 0,
  "offset": 0,
  "next_offset": null,
  "has_more": false
}
```

Filtering, image validation, and descending timestamp sorting retain current behavior. The Online Image page requests 16 records per page. Existing pages that omit `paged=1` remain unchanged.

### Cached Thumbnails

Add a same-origin thumbnail endpoint for history image URLs. It accepts only URLs that `output_file_from_url` resolves inside HstarA-managed output roots. Remote URLs, data URLs, traversal attempts, missing files, and files outside managed roots are rejected.

The endpoint produces a WebP preview with a maximum edge of 480 pixels and moderate quality. Cache identity includes the canonical source path, source modification time, source size, requested edge, and format settings. Cached files live in HstarA's regenerable runtime cache, not beside originals.

Thumbnail generation is lazy: only requested cards generate previews. Concurrent requests for the same thumbnail share a per-key lock or atomic temporary-file rename so partial files cannot be served. Existing cached previews are returned without decoding the original again.

If a supported source cannot be decoded, the endpoint returns a controlled error and the frontend falls back to the original image for that card. Deleting a history record removes the current cached thumbnail when practical; stale cache entries are always harmless because the cache key contains source metadata.

## Frontend Design

The Online Image archive maintains only the currently loaded page data:

- Initial request: `paged=1&offset=0&limit=16&type=online`.
- Each explicit "Load More" action requests the next offset.
- The existing automatic `IntersectionObserver` loading is removed to prevent cascading page insertion.
- The load button is hidden when `has_more` is false and disabled while a request is active.
- Failed requests restore the button and show a retryable status instead of leaving the page stuck.

Archive cards use the cached thumbnail URL and set `loading="lazy"`, `decoding="async"`, and low fetch priority. The grid uses `content-visibility: auto` with a stable intrinsic size so off-screen cards do not require immediate layout and paint work.

The card retains the original history record. Opening the lightbox, downloading, applying the same style, or passing the image into another generation flow continues to use the original image URL. A thumbnail is never treated as a source image.

Newly generated records are prepended without reloading the archive. Duplicate timestamp protection remains. Management mode continues to select and delete loaded cards, matching the current behavior.

## Data Flow

1. The page requests 16 history records.
2. The backend reads, filters, sorts, and returns only the requested page metadata.
3. Each visible card requests a validated thumbnail.
4. The backend serves a cached WebP or creates it once from the managed original.
5. The browser decodes small previews while retaining original URLs in record data.
6. User actions that require full quality request the original image only at that time.

## Error Handling

- Invalid pagination values are clamped instead of causing server errors.
- Invalid thumbnail sources return a client error without revealing filesystem paths.
- Missing originals render the existing broken-image state or fallback behavior without blocking other cards.
- A failed page request does not advance `next_offset`.
- A failed thumbnail request affects only its card.
- History deletion remains authoritative even if thumbnail cleanup fails.

## Security And Privacy

- The thumbnail endpoint never accepts arbitrary absolute filesystem paths.
- Source resolution uses the existing managed-output URL resolver and verifies the resolved path remains inside approved roots.
- API keys, prompts, and local configuration are not embedded in thumbnail cache names or responses.
- Cache filenames use a one-way digest rather than source paths.

## Testing

Automated tests cover:

- Legacy `/api/history` response compatibility.
- Paged filtering, ordering, limits, offsets, totals, and end-of-list behavior.
- Thumbnail path validation, cache reuse, and maximum dimensions.
- Online page initial page size of 16 and explicit load-more behavior.
- Absence of automatic archive pagination.
- Thumbnail attributes and preservation of original URLs for lightbox/download/reuse.
- Delete behavior and graceful thumbnail cleanup failure.

Browser verification uses the existing archive and confirms:

- No more than 16 cards exist after initial load.
- The initial history response is substantially below the current 2.8 MB response.
- Archive cards request thumbnail URLs rather than original image URLs.
- Original images are requested only after opening or downloading them.
- Load More, management selection, deletion, lightbox, and same-style reuse still work.

## Acceptance Criteria

- Initial archive DOM contains at most 16 cards.
- Initial history metadata response contains at most 16 records.
- No full-resolution archive image is requested during initial card rendering when thumbnail generation succeeds.
- Scrolling alone cannot load all 457 records.
- Loading more records requires an explicit user action and adds at most 16 cards.
- Existing root integration tests pass.
- Online archive performance tests pass.
- HstarA remains responsive while the first archive page is displayed.

