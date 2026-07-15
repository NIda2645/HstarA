import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const candidates = process.platform === 'win32'
  ? [
      ...[join(repoRoot, 'python', 'python.exe')]
        .filter(existsSync)
        .map(command => ({command, args:[]})),
      {command:'py', args:['-3']},
      {command:'python', args:[]},
    ]
  : [
      {command:'python3', args:[]},
      {command:'python', args:[]},
    ];

const python = candidates.find(candidate => {
  const probe = spawnSync(
    candidate.command,
    [...candidate.args, '-X', 'utf8', '-c', 'import PIL'],
    {
      cwd:repoRoot,
      encoding:'utf8',
      env:{...process.env, PYTHONIOENCODING:'utf-8', PYTHONUTF8:'1'},
    },
  );
  return !probe.error && probe.status === 0;
});
assert.ok(python, 'A Python interpreter with Pillow is required');

const harness = String.raw`
from io import BytesIO
import os
import sys

from PIL import Image

sys.path.insert(0, os.getcwd())

from openshop_image_ops import OpenShopImageNormalizationError, normalize_local_generation


def png(image):
    output = BytesIO()
    image.save(output, format="PNG")
    return output.getvalue()


source = Image.new("RGBA", (8, 6), (20, 30, 40, 255))
mask = Image.new("L", (8, 6), 0)
for y in range(2, 5):
    for x in range(1, 6):
        mask.putpixel((x, y), 255)

full = Image.new("RGBA", (8, 6), (220, 20, 40, 255))
normalized = Image.open(BytesIO(normalize_local_generation(
    png(source), png(mask), png(full), {"x": 1, "y": 2, "width": 5, "height": 3},
))).convert("RGBA")
assert normalized.size == (8, 6)
assert normalized.getpixel((0, 0))[3] == 0
assert normalized.getpixel((2, 3)) == (220, 20, 40, 255)

crop = Image.new("RGB", (5, 3), (10, 200, 70))
cropped = Image.open(BytesIO(normalize_local_generation(
    png(source), png(mask), png(crop), {"x": 1, "y": 2, "width": 5, "height": 3},
))).convert("RGBA")
assert cropped.size == (8, 6)
assert cropped.getpixel((1, 2)) == (10, 200, 70, 255)
assert cropped.getpixel((7, 5))[3] == 0

soft_mask = Image.new("L", (8, 6), 0)
soft_mask.putpixel((2, 2), 128)
soft = Image.open(BytesIO(normalize_local_generation(
    png(source), png(soft_mask), png(full), {"x": 2, "y": 2, "width": 1, "height": 1},
))).convert("RGBA")
assert soft.getpixel((2, 2))[3] == 128

invalid_cases = [
    (Image.new("L", (8, 6), 0), full, {"x": 1, "y": 2, "width": 5, "height": 3}),
    (mask.resize((4, 3)), full, {"x": 1, "y": 2, "width": 5, "height": 3}),
    (mask, Image.new("RGB", (2, 5), (1, 2, 3)), {"x": 1, "y": 2, "width": 5, "height": 3}),
    (mask, crop, {"x": 7, "y": 5, "width": 5, "height": 3}),
]
for invalid_mask, invalid_result, invalid_bounds in invalid_cases:
    try:
        normalize_local_generation(
            png(source), png(invalid_mask), png(invalid_result), invalid_bounds,
        )
        raise AssertionError("invalid local generation should fail")
    except OpenShopImageNormalizationError:
        pass

print("OpenShop AI image normalization tests passed")
`;

const result = spawnSync(python.command, [...python.args, '-X', 'utf8', '-c', harness], {
  cwd:repoRoot,
  encoding:'utf8',
  env:{...process.env, PYTHONIOENCODING:'utf-8', PYTHONUTF8:'1'},
  timeout:30_000,
});

assert.equal(result.status, 0, result.stderr || result.stdout || 'OpenShop image normalization harness failed');
console.log(result.stdout.trim());
