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
import hashlib
import json
import os
import sys
import tempfile
from pathlib import Path
from unittest.mock import patch

import httpx

sys.path.insert(0, os.getcwd())


def snapshot(root):
    result = {}
    for path in sorted(root.rglob("*"), key=lambda item: str(item).lower()):
        relative = path.relative_to(root).as_posix()
        if path.is_dir():
            result[relative] = {"type": "directory"}
        elif path.is_file():
            content = path.read_bytes()
            result[relative] = {
                "type": "file",
                "size": len(content),
                "sha256": hashlib.sha256(content).hexdigest(),
            }
    return result


async def run():
    with tempfile.TemporaryDirectory(prefix="hstara-legacy-readonly-") as app_root:
        root = Path(app_root)
        data_dir = root / "data"
        canvas_dir = data_dir / "canvases"
        canvas_dir.mkdir(parents=True)
        (data_dir / "openshop").mkdir()
        (root / "assets" / "input").mkdir(parents=True)
        (root / "assets" / "output").mkdir()
        (root / "assets" / "library").mkdir()
        (root / "assets" / "uploads").mkdir()
        (root / "output").mkdir()

        canvas = {
            "id": "legacy-canvas-1",
            "title": "Existing legacy canvas",
            "icon": "layers",
            "kind": "classic",
            "project": "default",
            "created_at": 100,
            "updated_at": 200,
            "nodes": [{"id": "node-1"}],
            "connections": [],
        }
        canvas_file = canvas_dir / "legacy-canvas-1.json"
        canvas_file.write_text(json.dumps(canvas, ensure_ascii=False), encoding="utf-8")
        (data_dir / "projects.json").write_text(
            json.dumps({"projects": [{"id": "default", "name": "Default", "order": 0}]}),
            encoding="utf-8",
        )
        external_appdata = root / "external-appdata"
        external_settings = external_appdata / "Hstar" / "data" / "software_settings.json"
        external_settings.parent.mkdir(parents=True)
        external_settings.write_text(
            json.dumps({"storage_root": "must-not-be-copied"}),
            encoding="utf-8",
        )

        before = snapshot(root)
        os.environ.update({
            "HSTAR_DATA_DIR": app_root,
            "HSTAR_EDITION": "development",
            "HSTAR_PROGRAM_DIR": os.getcwd(),
            "HSTAR_SHELL_TOKEN": "T" * 64,
            "HSTAR_VOICE_TEST_MODE": "1",
            "APPDATA": str(external_appdata),
        })

        import main

        assert main.PRESERVE_EXISTING_DATA_ON_STARTUP is True
        assert Path(main.CANVAS_DIR) == canvas_dir
        assert Path(main.SOFTWARE_SETTINGS_FILE) == data_dir / "software_settings.json"
        assert not Path(main.SOFTWARE_SETTINGS_FILE).exists()

        with patch.object(main, "sync_static_html_versions", lambda: None):
            await main.startup_event()

        transport = httpx.ASGITransport(app=main.app, client=("127.0.0.1", 51100))
        headers = {main.SHELL_TOKEN_HEADER: main.SHELL_TOKEN}
        async with httpx.AsyncClient(
            transport=transport,
            base_url="http://127.0.0.1",
            headers=headers,
        ) as client:
            settings_response = await client.get("/api/software-settings")
            canvases_response = await client.get("/api/canvases")
            projects_response = await client.get("/api/projects")

        assert settings_response.status_code == 200, settings_response.text
        settings = settings_response.json()["settings"]
        assert Path(settings["active_storage_root"]) == root
        assert Path(settings["active_data_dir"]) == data_dir
        assert settings.get("storage_root") != "must-not-be-copied"

        assert canvases_response.status_code == 200, canvases_response.text
        canvases = canvases_response.json()["canvases"]
        assert [item["id"] for item in canvases] == ["legacy-canvas-1"]
        assert canvases[0]["node_count"] == 1

        assert projects_response.status_code == 200, projects_response.text
        assert projects_response.json()["projects"][0]["id"] == "default"
        after = snapshot(root)
        assert after == before, json.dumps({
            "added": sorted(set(after) - set(before)),
            "removed": sorted(set(before) - set(after)),
            "changed": sorted(
                path for path in set(before) & set(after)
                if before[path] != after[path]
            ),
        }, ensure_ascii=False, indent=2)
        assert not (root / "config").exists()
        assert not (root / "projects").exists()


asyncio.run(run())
print("legacy storage read-only API tests passed")
`;

const harnessDir = mkdtempSync(join(tmpdir(), 'hstara-legacy-storage-test-'));
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
