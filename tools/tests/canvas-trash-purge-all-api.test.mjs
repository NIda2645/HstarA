import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const pythonEnv = {
  ...process.env,
  PYTHONIOENCODING: 'utf-8',
  PYTHONUTF8: '1',
};
const candidates = process.platform === 'win32'
  ? [
      ...[join(repoRoot, 'python', 'python.exe')]
        .filter(existsSync)
        .map((command) => ({ command, args: [] })),
      { command: 'py', args: ['-3'] },
      { command: 'python', args: [] },
    ]
  : [
      ...[join(repoRoot, 'python', 'bin', 'python3'), join(repoRoot, 'python', 'bin', 'python')]
        .filter(existsSync)
        .map((command) => ({ command, args: [] })),
      { command: 'python3', args: [] },
      { command: 'python', args: [] },
    ];

let python;
for (const candidate of candidates) {
  const probe = spawnSync(
    candidate.command,
    [...candidate.args, '-X', 'utf8', '-c', 'import httpx'],
    { cwd: repoRoot, encoding: 'utf8', env: pythonEnv, timeout: 20_000 },
  );
  if (!probe.error && probe.status === 0) {
    python = candidate;
    break;
  }
}
assert.ok(python, 'a Python interpreter with httpx is required');

const harness = String.raw`
import asyncio
import json
import os
import sys
import tempfile
from pathlib import Path

import httpx

sys.path.insert(0, os.getcwd())


async def run():
    with tempfile.TemporaryDirectory(prefix="hstara-trash-purge-all-") as app_root:
        settings_dir = Path(app_root) / "data"
        settings_dir.mkdir(parents=True, exist_ok=True)
        (settings_dir / "software_settings.json").write_text(
            json.dumps({"storage_root": app_root}),
            encoding="utf-8",
        )
        os.environ["HSTAR_DATA_DIR"] = app_root

        import main
        from openshop_projects import OpenShopNotFound

        transport = httpx.ASGITransport(app=main.app)
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
            async def create_canvas(title):
                response = await client.post(
                    "/api/canvases",
                    json={"title": title, "icon": "layers", "kind": "classic"},
                )
                assert response.status_code == 200, response.text
                return response.json()["canvas"]

            active = await create_canvas("Active canvas")
            trashed_with_project = await create_canvas("Trashed with OpenShop")
            trashed_plain = await create_canvas("Trashed plain")

            active_owner = {
                "canvasType": "classic",
                "canvasId": active["id"],
                "nodeId": "node-active",
            }
            trashed_owner = {
                "canvasType": "classic",
                "canvasId": trashed_with_project["id"],
                "nodeId": "node-trashed",
            }
            main.OPENSHOP_STORE.initialize(
                "project-active", active_owner, {"width": 32, "height": 24}
            )
            main.OPENSHOP_STORE.initialize(
                "project-trashed", trashed_owner, {"width": 32, "height": 24}
            )
            task = main.OPENSHOP_AI_TASKS.create(
                "project-trashed",
                trashed_owner,
                "text-remove",
                "vision",
                "test-model",
                "a" * 64,
            )

            for canvas in (trashed_with_project, trashed_plain):
                response = await client.delete(f"/api/canvases/{canvas['id']}")
                assert response.status_code == 200, response.text

            trash_before = await client.get("/api/canvases/trash")
            assert trash_before.status_code == 200, trash_before.text
            assert {item["id"] for item in trash_before.json()["canvases"]} == {
                trashed_with_project["id"],
                trashed_plain["id"],
            }

            purged = await client.delete("/api/canvases/trash/purge-all")
            assert purged.status_code == 200, purged.text
            assert purged.json() == {"ok": True, "purged": 2}

            assert Path(main.canvas_path(active["id"])).is_file()
            assert not Path(main.canvas_path(trashed_with_project["id"])).exists()
            assert not Path(main.canvas_path(trashed_plain["id"])).exists()
            main.OPENSHOP_STORE.load("project-active", active_owner)
            try:
                main.OPENSHOP_STORE.load("project-trashed", trashed_owner)
                raise AssertionError("trashed OpenShop project should be deleted")
            except OpenShopNotFound:
                pass
            assert main.OPENSHOP_AI_TASKS.get(
                task["taskId"], "project-trashed", trashed_owner
            )["status"] == "cancelled"

            active_list = await client.get("/api/canvases")
            assert active_list.status_code == 200, active_list.text
            assert {item["id"] for item in active_list.json()["canvases"]} == {active["id"]}
            trash_after = await client.get("/api/canvases/trash")
            assert trash_after.status_code == 200, trash_after.text
            assert trash_after.json()["canvases"] == []

            empty_purge = await client.delete("/api/canvases/trash/purge-all")
            assert empty_purge.status_code == 200, empty_purge.text
            assert empty_purge.json() == {"ok": True, "purged": 0}


asyncio.run(run())
print("canvas trash purge-all API tests passed")
`;

const harnessDir = mkdtempSync(join(tmpdir(), 'hstara-trash-purge-all-test-'));
const harnessPath = join(harnessDir, 'harness.py');
let result;
try {
  writeFileSync(harnessPath, harness, 'utf8');
  result = spawnSync(python.command, [...python.args, '-X', 'utf8', harnessPath], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: pythonEnv,
    timeout: 60_000,
  });
} finally {
  rmSync(harnessDir, { recursive: true, force: true });
}

assert.ok(!result.error, `Python harness failed to launch: ${result.error?.message}`);
assert.equal(result.status, 0, result.stderr || result.stdout);
console.log(result.stdout.trim());
