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

import openshop_image_ops as image_ops
from openshop_image_ops import (
    OpenShopImageNormalizationError,
    crop_art_font_reference,
    normalize_art_font_output,
    normalize_local_generation,
)


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


def expect_art_failure(content, aspect=1):
    try:
        normalize_art_font_output(content, aspect)
        raise AssertionError("unsafe art font output should fail")
    except OpenShopImageNormalizationError:
        pass


# Reference crops use normalized coordinates and display-oriented EXIF geometry.
reference = Image.new("RGB", (10, 8), (5, 10, 15))
for y in range(2, 6):
    for x in range(2, 6):
        reference.putpixel((x, y), (200, 30, 40))
reference_crop = Image.open(BytesIO(crop_art_font_reference(
    png(reference),
    [{"x": 0.2, "y": 0.25}, {"x": 0.6, "y": 0.25},
     {"x": 0.6, "y": 0.75}, {"x": 0.2, "y": 0.75}],
    padding_ratio=0,
))).convert("RGBA")
assert reference_crop.size == (4, 4)
assert reference_crop.getpixel((0, 0))[:3] == (200, 30, 40)

oriented = Image.new("RGB", (4, 2), (0, 0, 0))
for y in range(2):
    for x in range(2):
        oriented.putpixel((x, y), (240, 20, 30))
    for x in range(2, 4):
        oriented.putpixel((x, y), (20, 220, 30))
exif = oriented.getexif()
exif[274] = 6
oriented_bytes = BytesIO()
oriented.save(oriented_bytes, format="JPEG", quality=100, subsampling=0, exif=exif)
oriented_crop = Image.open(BytesIO(crop_art_font_reference(
    oriented_bytes.getvalue(),
    [{"x": 0, "y": 0}, {"x": 1, "y": 0},
     {"x": 1, "y": 0.5}, {"x": 0, "y": 0.5}],
    padding_ratio=0,
)))
assert oriented_crop.size == (2, 2)

# A real edge-connected transparent background is accepted and retained.
alpha_glyph = Image.new("RGBA", (7, 5), (0, 0, 0, 0))
for y in range(1, 4):
    for x in range(2, 5):
        alpha_glyph.putpixel((x, y), (12 + x, 40 + y, 190, 255))
alpha_png, alpha_geometry = normalize_art_font_output(png(alpha_glyph), 1)
alpha_result = Image.open(BytesIO(alpha_png)).convert("RGBA")
assert alpha_result.size == (3, 3)
assert alpha_geometry == {
    "contentBox": {"x": 0, "y": 0, "width": 3, "height": 3},
    "width": 3,
    "height": 3,
}
assert alpha_result.getpixel((1, 1)) == alpha_glyph.getpixel((3, 2))

# A few noisy alpha samples do not prove that the background is transparent.
false_alpha = Image.new("RGBA", (8, 6), (250, 250, 250, 255))
for point in ((0, 0), (7, 0), (0, 5), (7, 5)):
    false_alpha.putpixel(point, (250, 250, 250, 0))
false_alpha.putpixel((3, 2), (0, 0, 0, 255))
false_alpha.putpixel((4, 3), (0, 0, 0, 220))
expect_art_failure(png(false_alpha))

# Opaque output is accepted only with a uniform boundary matte. Flood removal
# must not erase a same-colored detail enclosed inside the glyph.
matte_ring = Image.new("RGB", (9, 7), (245, 245, 245))
for x in range(2, 7):
    matte_ring.putpixel((x, 1), (15, 20, 25))
    matte_ring.putpixel((x, 5), (15, 20, 25))
for y in range(1, 6):
    matte_ring.putpixel((2, y), (15, 20, 25))
    matte_ring.putpixel((6, y), (15, 20, 25))
ring_png, ring_geometry = normalize_art_font_output(png(matte_ring), 1)
ring = Image.open(BytesIO(ring_png)).convert("RGBA")
assert ring.size == (5, 5)
assert ring_geometry["contentBox"] == {"x": 0, "y": 0, "width": 5, "height": 5}
assert ring.getpixel((2, 2)) == (245, 245, 245, 255)

multicolor_edge = Image.new("RGB", (8, 6), (255, 255, 255))
for x in range(8):
    multicolor_edge.putpixel((x, 0), (255, 0, 0) if x % 2 else (0, 0, 255))
    multicolor_edge.putpixel((x, 5), (0, 255, 0) if x % 2 else (255, 255, 0))
for y in range(1, 5):
    multicolor_edge.putpixel((0, y), (255, 0, 255))
    multicolor_edge.putpixel((7, y), (0, 255, 255))
multicolor_edge.putpixel((3, 3), (0, 0, 0))
expect_art_failure(png(multicolor_edge))

# A uniform removable matte does not make a dense interior scene safe. A
# high-complexity checkerboard panel fills its rectangular content box and
# must be rejected as background/scene reconstruction.
checkerboard_panel = Image.new("RGB", (12, 10), (250, 250, 250))
panel_colors = ((220, 30, 40), (20, 170, 220), (240, 190, 20), (60, 180, 70))
for y in range(2, 8):
    for x in range(2, 10):
        checkerboard_panel.putpixel((x, y), panel_colors[(x + y) % 4])
expect_art_failure(png(checkerboard_panel), 4 / 3)

# Palette size is not itself unsafe. Multicolor letter strokes with clear
# counters, gaps, and non-rectangular geometry remain valid.
multicolor_glyphs = Image.new("RGB", (14, 10), (250, 250, 250))
glyph_colors = ((230, 20, 80), (20, 120, 230), (245, 160, 20), (40, 190, 100))
glyph_points = set()
for y in range(2, 8):
    glyph_points.update(((2, y), (5, y), (8, y), (11, y)))
for x in range(2, 6):
    glyph_points.add((x, 4))
for x in range(8, 12):
    glyph_points.add((x, 2))
    glyph_points.add((x, 5))
for index, (x, y) in enumerate(sorted(glyph_points)):
    multicolor_glyphs.putpixel((x, y), glyph_colors[index % len(glyph_colors)])
multicolor_png, multicolor_geometry = normalize_art_font_output(
    png(multicolor_glyphs), 5 / 3,
)
multicolor_result = Image.open(BytesIO(multicolor_png)).convert("RGBA")
visible_multicolor = {
    pixel[:3] for pixel in multicolor_result.getdata() if pixel[3] > 0
}
assert len(visible_multicolor) >= 4
assert multicolor_geometry["contentBox"]["width"] == 10
assert sum(pixel[3] == 0 for pixel in multicolor_result.getdata()) > 0

# Matte-colored antialiasing is decontaminated into a dark translucent edge,
# rather than leaving an opaque gray/white halo.
antialias = Image.new("RGB", (7, 5), (255, 255, 255))
for y in range(1, 4):
    for x in range(2, 5):
        antialias.putpixel((x, y), (0, 0, 0))
antialias.putpixel((1, 2), (128, 128, 128))
decontaminated_png, decontaminated_geometry = normalize_art_font_output(png(antialias), 1)
decontaminated = Image.open(BytesIO(decontaminated_png)).convert("RGBA")
edge = decontaminated.getpixel((0, 1))
assert 120 <= edge[3] <= 135, edge
assert max(edge[:3]) <= 3, edge
assert decontaminated_geometry["contentBox"]["width"] == 4

expect_art_failure(png(Image.new("RGBA", (6, 4), (0, 0, 0, 0))))
expect_art_failure(png(Image.new("RGB", (6, 4), (255, 255, 255))))

# The art decoder has independent compressed-byte, width, height, and pixel
# limits, while padding has its own final-canvas dimension and pixel limits.
bounded_fixture = png(alpha_glyph)
limit_names = (
    "MAX_ART_FONT_COMPRESSED_BYTES",
    "MAX_ART_FONT_WIDTH",
    "MAX_ART_FONT_HEIGHT",
    "MAX_ART_FONT_PIXELS",
    "MAX_ART_FONT_CANVAS_WIDTH",
    "MAX_ART_FONT_CANVAS_HEIGHT",
    "MAX_ART_FONT_CANVAS_PIXELS",
)
original_limits = {name: getattr(image_ops, name) for name in limit_names}
try:
    image_ops.MAX_ART_FONT_COMPRESSED_BYTES = len(bounded_fixture) - 1
    expect_art_failure(bounded_fixture)
    image_ops.MAX_ART_FONT_COMPRESSED_BYTES = original_limits["MAX_ART_FONT_COMPRESSED_BYTES"]
    image_ops.MAX_ART_FONT_WIDTH = 6
    expect_art_failure(bounded_fixture)
    image_ops.MAX_ART_FONT_WIDTH = original_limits["MAX_ART_FONT_WIDTH"]
    image_ops.MAX_ART_FONT_HEIGHT = 4
    expect_art_failure(bounded_fixture)
    image_ops.MAX_ART_FONT_HEIGHT = original_limits["MAX_ART_FONT_HEIGHT"]
    image_ops.MAX_ART_FONT_PIXELS = 34
    expect_art_failure(bounded_fixture)
    image_ops.MAX_ART_FONT_PIXELS = original_limits["MAX_ART_FONT_PIXELS"]
    image_ops.MAX_ART_FONT_CANVAS_WIDTH = 5
    expect_art_failure(bounded_fixture, 2)
    image_ops.MAX_ART_FONT_CANVAS_WIDTH = original_limits["MAX_ART_FONT_CANVAS_WIDTH"]
    image_ops.MAX_ART_FONT_CANVAS_HEIGHT = 2
    expect_art_failure(bounded_fixture, 1)
    image_ops.MAX_ART_FONT_CANVAS_HEIGHT = original_limits["MAX_ART_FONT_CANVAS_HEIGHT"]
    image_ops.MAX_ART_FONT_CANVAS_PIXELS = 17
    expect_art_failure(bounded_fixture, 2)
finally:
    for name, value in original_limits.items():
        setattr(image_ops, name, value)

# Aspect correction is transparent padding only: visible pixels and their byte
# values are unchanged, with no resize or nonuniform scaling.
pattern = Image.new("RGBA", (6, 6), (0, 0, 0, 0))
for y in range(1, 5):
    pattern.putpixel((2, y), (20 * y, 10, 200, 255))
    pattern.putpixel((3, y), (10, 30 * y, 100, 128 + 20 * y))
original_content = pattern.crop((2, 1, 4, 5))
padded_png, padded_geometry = normalize_art_font_output(png(pattern), 2)
padded = Image.open(BytesIO(padded_png)).convert("RGBA")
assert padded.size == (8, 4)
assert padded_geometry == {
    "contentBox": {"x": 3, "y": 0, "width": 2, "height": 4},
    "width": 8,
    "height": 4,
}
assert list(padded.crop((3, 0, 5, 4)).getdata()) == list(original_content.getdata())

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
