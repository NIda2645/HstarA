# OpenShop Node-Scoped Persistence Design

## Status

Approved direction: store every OpenShop layered-editing node as an independent,
durable project beside its owning HstarA canvas. Embedded OpenShop must not use
the shared browser OPFS recovery slot.

This specification addresses project isolation and durable layer persistence.
The art-font regeneration control and OCR/font-catalog refinements remain
separate follow-up work after persistence is reliable.

## Problem

HstarA already saves OpenShop projects on the server and validates an owner made
from `canvasType`, `canvasId`, and `nodeId`. However, the embedded OpenShop editor
also starts its upstream OPFS auto-recovery code. Every editor frame on the same
origin reads and writes the single file `openshop-autosave.json`.

That shared recovery slot causes two failures:

- opening one layered-editing node can offer recovery data written by another
  node;
- the OPFS payload contains Fabric JSON plus reduced layer metadata, so recovery
  can flatten or lose the authoritative multi-layer structure.

The recovery prompt is therefore not a safe persistence mechanism for embedded
HstarA projects.

## Goals

- Persist each OpenShop node as a real file owned by exactly one HstarA canvas
  and one node.
- Restore the complete editable project, including layer order, layer types,
  visibility, transforms, editor objects, source bindings, font references,
  AI references, task snapshots, and export records.
- Prevent any node from loading or overwriting another node's project.
- Remove the embedded OpenShop recovery/discard prompt.
- Keep OpenShop tasks running when the editor is hidden or the user returns to
  the canvas.
- Permanently delete only the selected OpenShop node's project when that node is
  deleted.
- Preserve upstream and downstream image nodes and every asset still referenced
  by any canvas or OpenShop project.
- Migrate existing server-side OpenShop projects without requiring manual user
  action.

## Non-Goals

- No visual comparison UI is added.
- No change is made to general canvas recycle-bin behavior.
- Deleting an OpenShop node does not delete connected image nodes, generated
  image nodes, or their independent data.
- This phase does not implement art-font regeneration or alter OCR layout rules.
- This phase does not make standalone OpenShop depend on HstarA storage.

## Storage Layout

The canvas JSON remains the graph document and stores the node's stable
`projectId`. The complete OpenShop project is stored in a node-specific sidecar:

```text
data/
  canvases/
    <canvasId>.json
    <canvasId>.openshop/
      <nodeId>/
        project.json
  openshop/
    assets/
      <sha256>.<extension>
      <sha256>.json
```

`project.json` remains a versioned document and retains these required fields:

- `schemaVersion`, `projectId`, and the complete owner tuple;
- document width and height;
- authoritative editor JSON and semantic layer records;
- source bindings and asset references;
- font references and AI tool preferences;
- AI reference records, task snapshots, pending results, and export records;
- monotonically increasing `autosaveVersion` plus creation/update timestamps.

Image binaries remain content-addressed in the shared asset directory. This
avoids duplicating large files while preserving node ownership through references
in `project.json`.

## Ownership And Path Rules

The owner tuple is authoritative:

```text
(canvasType, canvasId, nodeId)
```

The server derives the project path from the validated owner. Client-supplied
paths are never accepted. A loaded project's embedded owner and `projectId` must
match the requested owner and project ID before any data is returned or changed.

Project IDs remain stable identifiers, but they no longer determine the storage
path by themselves. Clone requests must identify both source owner and target
owner so the server never scans or guesses across canvases.

## Embedded Editor Lifecycle

### Open

1. HstarA creates a session scoped by canvas type, canvas ID, node ID, and project
   ID.
2. The host loads the project from that node's sidecar path.
3. If no project exists, the host creates a new sidecar project for that exact
   owner.
4. The editor receives the complete project and rebuilds all editable layers.
5. HstarA embedded mode never checks global OPFS and never displays the
   recovery/discard prompt.

### Edit And Autosave

- Every committed editor command marks the project dirty.
- The host serializes the complete project and performs a debounced server PUT.
- PUT uses `autosaveVersion` optimistic concurrency and an atomic file replace.
- A newer server version is never silently overwritten. The host reloads or
  reports a scoped save conflict instead of replacing another version.
- Explicit Save and Send to Canvas flush pending project changes before
  confirming completion.
- Hiding OpenShop or switching HstarA pages does not dispose the session or stop
  AI tasks. Completed results update that node's project file and layers.
- Reclaiming an idle hidden frame is allowed only after its save queue is empty
  and it has no active task. Reopening then reloads the same sidecar file.

### Application Restart

On restart, opening a node directly loads its sidecar project. There is no
recovery choice because the sidecar is the authoritative saved project, not a
temporary browser cache.

## Node Deletion Semantics

Deleting an OpenShop layered-editing node means permanent deletion of that
node's own OpenShop data. It does not enter any recycle state.

The deletion flow is:

1. Remove the selected OpenShop node and only graph connections attached to that
   node from the canvas graph.
2. Persist the updated canvas graph.
3. Cancel in-memory AI tasks owned by that exact project.
4. Delete only
   `data/canvases/<canvasId>.openshop/<nodeId>/`.
5. Run reference-aware asset garbage collection.

Steps 3-5 are idempotent so a failed cleanup can be retried safely. The backend
canvas-save path remains the authoritative cleanup trigger; the UI may request
early disposal for responsiveness, but it cannot widen the owner scope.

The cleanup must not mutate upstream or downstream nodes. Removing graph edges
connected to the deleted node is expected, but image nodes and their media stay
intact. An asset is deleted only when both checks are true:

- no remaining OpenShop `project.json` references it;
- no HstarA canvas JSON references it, including upstream/downstream image nodes
  and images previously sent to the canvas.

Therefore, an exported image already present in a downstream image node survives
deletion of the OpenShop node that produced it.

Moving a whole canvas to the canvas recycle bin keeps all sidecar projects so the
canvas can be restored. Permanently purging the canvas deletes its complete
`<canvasId>.openshop` directory and then runs the same reference-aware asset
garbage collection.

## Migration

Existing projects currently live at:

```text
data/openshop/projects/<projectId>.json
```

Migration is lazy and atomic:

1. Try the new owner-derived sidecar path.
2. If it is absent, inspect the legacy project identified by `projectId`.
3. Validate that the legacy project's full owner matches the current request.
4. Atomically write the validated project to the sidecar path.
5. Re-read and validate the sidecar.
6. Remove the legacy project file only after successful validation.

A mismatched legacy owner is treated as an ownership error and is never migrated.
Migration must not merge two project files. If both locations exist, the sidecar
is authoritative and the legacy file is left for explicit orphan inspection or
garbage collection.

The migration must be safe to repeat after interruption. Assets are not moved
because their content-addressed location remains unchanged.

## Standalone OpenShop

Standalone OpenShop may retain its existing OPFS recovery behavior because it has
no HstarA canvas/node owner. The editor receives an explicit host-mode flag:

- `embedded-hstara`: disable OPFS initialization, recovery UI, timers, workers,
  and OPFS cleanup calls;
- `standalone`: preserve current OpenShop recovery behavior.

Mode detection must come from the validated host session handshake, not from a
query string alone.

## Error Handling

- Invalid owner or path components return a validation error without touching
  the filesystem.
- Owner mismatch returns a scoped authorization error and never falls back to a
  different node.
- Corrupt project JSON returns a project-specific load error; it is not replaced
  with another project or a blank project automatically.
- Atomic writes use a temporary file in the destination directory followed by
  `os.replace` so readers never observe partial JSON.
- Save conflicts return the current server project/version for explicit client
  reconciliation.
- Failed deletion is logged with the exact owner and retried by an orphan cleanup
  pass; cleanup never broadens from node scope to canvas scope.
- Asset garbage-collection failure does not roll back a successfully deleted
  project and must never delete uncertain references.

## Verification

### Store Unit Tests

- two nodes in the same canvas save and reload different multi-layer projects;
- identical node IDs in different canvases remain isolated;
- a project cannot be loaded, saved, cloned, or deleted using another owner;
- saves remain atomic and reject stale `autosaveVersion` values;
- legacy projects migrate only when the complete owner matches;
- repeated migration and repeated deletion are safe;
- deleting one node keeps assets referenced by another project or canvas;
- deleting the last reference removes the content-addressed asset;
- canvas recycle retains sidecars, while permanent purge removes them.

### Host And Editor Tests

- embedded sessions do not call `_initAutoSave`, open recovery UI, or write
  `openshop-autosave.json`;
- standalone OpenShop still supports its recovery flow;
- reopening a node restores layer count, order, types, names, visibility,
  transforms, and document dimensions exactly;
- opening node A, then node B, then restarting and reopening A never shows B's
  data;
- hiding the editor during an AI task leaves the task running and persists its
  completed result into the correct node;
- idle session reclamation flushes dirty state before removing the iframe.

### End-To-End Tests

- create two OpenShop nodes in one engineering canvas, give each visibly distinct
  multi-layer content, restart HstarA, and verify exact independent restoration;
- delete one OpenShop node and verify its sidecar directory is gone immediately
  after canvas save;
- verify connected image nodes and images sent to the canvas remain readable;
- permanently purge a test canvas and verify only that canvas's sidecar projects
  are removed;
- remove all engineering test canvases created by the tests without touching the
  stable installed HstarA data location.

## Acceptance Criteria

- No embedded OpenShop node displays a recovery/discard prompt.
- Multiple OpenShop nodes in one canvas never share restored data.
- Restarting HstarA restores every node's editable multi-layer structure without
  flattening.
- The filesystem contains one durable project directory per OpenShop node under
  its owning canvas.
- Deleting an OpenShop node permanently removes only that node's project data.
- Upstream/downstream image nodes and all still-referenced assets remain intact.
- Hiding or closing the OpenShop view does not interrupt tasks or prevent their
  results from being persisted to the owning node.
