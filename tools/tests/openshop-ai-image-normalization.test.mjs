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
import tracemalloc

from PIL import Image

sys.path.insert(0, os.getcwd())

import openshop_image_ops as image_ops
from openshop_image_ops import (
    OpenShopImageNormalizationError,
    crop_art_font_reference,
    normalize_art_font_output,
    normalize_local_generation,
    prepare_local_generation_inputs,
    prepare_art_font_reference,
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

provider_crop = Image.new("RGB", (2, 5), (80, 120, 220))
provider_normalized = Image.open(BytesIO(normalize_local_generation(
    png(source), png(mask), png(provider_crop), {"x": 1, "y": 2, "width": 5, "height": 3},
))).convert("RGBA")
assert provider_normalized.size == (8, 6)
assert provider_normalized.getpixel((2, 3)) == (80, 120, 220, 255)

# The provider edits the selected document crop, never a resized copy of the
# full scene. Otherwise a full poster can be miniaturized into the selection.
patterned_source = Image.new("RGBA", (8, 6), (10, 20, 30, 255))
for py in range(2, 5):
    for px in range(1, 6):
        patterned_source.putpixel((px, py), (100 + px, 150 + py, 200, 255))
local_source_bytes, local_mask_bytes = prepare_local_generation_inputs(
    png(patterned_source), png(mask), {"x": 1, "y": 2, "width": 5, "height": 3},
)
local_source = Image.open(BytesIO(local_source_bytes)).convert("RGBA")
local_mask = Image.open(BytesIO(local_mask_bytes)).convert("L")
assert local_source.size == (5, 3)
assert local_mask.size == (5, 3)
assert local_source.getpixel((0, 0)) == patterned_source.getpixel((1, 2))
assert local_source.getpixel((4, 2)) == patterned_source.getpixel((5, 4))
assert local_mask.getbbox() == (0, 0, 5, 3)

soft_mask = Image.new("L", (8, 6), 0)
soft_mask.putpixel((2, 2), 128)
soft = Image.open(BytesIO(normalize_local_generation(
    png(source), png(soft_mask), png(full), {"x": 2, "y": 2, "width": 1, "height": 1},
))).convert("RGBA")
assert soft.getpixel((2, 2))[3] == 128

invalid_cases = [
    (Image.new("L", (8, 6), 0), full, {"x": 1, "y": 2, "width": 5, "height": 3}),
    (mask.resize((4, 3)), full, {"x": 1, "y": 2, "width": 5, "height": 3}),
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

# Art-style references are tight, background-free, and fully opaque inside
# the glyph. Nearby decorations outside the OCR quad must not reach the model.
reference_source = Image.new("RGB", (100, 100), (248, 246, 238))
for y in range(28, 72):
    for x in range(42, 58):
        reference_source.putpixel((x, y), (65, 107, 75))
for y in range(35, 65):
    for x in range(84, 94):
        reference_source.putpixel((x, y), (220, 35, 30))
isolated_reference = Image.open(BytesIO(prepare_art_font_reference(
    png(reference_source),
    [{"x": 0.2, "y": 0.2}, {"x": 0.8, "y": 0.2},
     {"x": 0.8, "y": 0.8}, {"x": 0.2, "y": 0.8}],
))).convert("RGBA")
assert isolated_reference.size == (64, 64)
assert isolated_reference.getpixel((0, 0))[3] == 0
assert isolated_reference.getpixel((32, 32)) == (65, 107, 75, 255)
assert all(pixel[3] in (0, 255) for pixel in isolated_reference.getdata())
assert not any(pixel[0] > 180 and pixel[1] < 80 for pixel in isolated_reference.getdata())

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

# A model-created color wash around opaque glyph strokes is removed while the
# solid lettering core remains available for the OpenShop layer.
color_halo = Image.new("RGBA", (20, 20), (0, 0, 0, 0))
for y in range(2, 18):
    for x in range(2, 18):
        color_halo.putpixel((x, y), (70, 170, 95, 96))
for y in range(4, 16):
    for x in range(8, 12):
        color_halo.putpixel((x, y), (45, 90, 55, 255))
clean_halo_png, clean_halo_geometry = normalize_art_font_output(png(color_halo), 0.5)
clean_halo = Image.open(BytesIO(clean_halo_png)).convert("RGBA")
assert clean_halo_geometry["contentBox"]["width"] <= 8
assert clean_halo_geometry["contentBox"]["height"] == 16
assert max(clean_halo.getchannel("A").getdata()) == 255
assert sum(alpha > 16 for alpha in clean_halo.getchannel("A").getdata()) <= 128

# A translucent wash with no opaque lettering core remains unsafe.
wash_only = Image.new("RGBA", (20, 20), (0, 0, 0, 0))
for y in range(2, 18):
    for x in range(2, 18):
        wash_only.putpixel((x, y), (70, 170, 95, 96))
expect_art_failure(png(wash_only))

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

# Model outputs can contain a low-texture gradient/noise matte along the edge
# instead of one exact background color. It is safe to remove when the edge
# remains coherent, while the glyph stays isolated from that matte.
adaptive_matte = Image.new("RGB", (16, 10), (220, 230, 240))
boundary = list(image_ops._boundary_indexes(*adaptive_matte.size))
for order, pixel_index in enumerate(boundary):
    delta = (order % 7) * 4
    adaptive_matte.putpixel(
        (pixel_index % adaptive_matte.width, pixel_index // adaptive_matte.width),
        (220 + delta, 230, 240),
    )
for y in range(3, 7):
    for x in range(5, 11):
        adaptive_matte.putpixel((x, y), (18, 28, 42))
try:
    image_ops._uniform_boundary_matte(adaptive_matte)
    raise AssertionError("gradient matte should require adaptive estimation")
except OpenShopImageNormalizationError:
    pass
adaptive_png, adaptive_geometry = normalize_art_font_output(png(adaptive_matte), 1.5)
adaptive_result = Image.open(BytesIO(adaptive_png)).convert("RGBA")
assert adaptive_result.size == (6, 4)
assert adaptive_geometry["contentBox"] == {"x": 0, "y": 0, "width": 6, "height": 4}
assert adaptive_result.getpixel((2, 2)) == (18, 28, 42, 255)
assert all(pixel[3] == 0 for pixel in adaptive_result.getdata() if pixel[:3] == (220, 230, 240))

# Dense foreground validation uses streaming counters and a fixed histogram,
# not one Python integer object per visible pixel.
memory_probe = Image.new("RGBA", (1024, 1024), (210, 30, 45, 255))
tracemalloc.start()
try:
    image_ops._validate_art_font_no_scene(memory_probe)
    _current_memory, peak_memory = tracemalloc.get_traced_memory()
finally:
    tracemalloc.stop()
assert peak_memory < 16 * 1024 * 1024, peak_memory

assert image_ops.MAX_ART_FONT_WIDTH <= 4096
assert image_ops.MAX_ART_FONT_HEIGHT <= 4096
assert image_ops.MAX_ART_FONT_PIXELS <= 8 * 1024 * 1024
assert image_ops.MAX_ART_FONT_CANVAS_WIDTH <= 4096
assert image_ops.MAX_ART_FONT_CANVAS_HEIGHT <= 4096
assert image_ops.MAX_ART_FONT_CANVAS_PIXELS <= 12 * 1024 * 1024

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

# Opaque matte cleanup follows the complete boundary-connected soft component,
# not only the first antialias ring adjacent to the removed background.
two_ring_matte = Image.new("RGB", (9, 9), (255, 255, 255))
for y in range(1, 8):
    for x in range(1, 8):
        two_ring_matte.putpixel((x, y), (224, 224, 224))
for y in range(2, 7):
    for x in range(2, 7):
        two_ring_matte.putpixel((x, y), (128, 128, 128))
for y in range(3, 6):
    for x in range(3, 6):
        two_ring_matte.putpixel((x, y), (0, 0, 0))
two_ring_png, _two_ring_geometry = normalize_art_font_output(
    png(two_ring_matte), 1,
)
two_ring_result = Image.open(BytesIO(two_ring_png)).convert("RGBA")
outer_soft = two_ring_result.getpixel((0, 0))
inner_soft = two_ring_result.getpixel((1, 1))
assert 25 <= outer_soft[3] <= 35 and max(outer_soft[:3]) <= 3, outer_soft
assert 120 <= inner_soft[3] <= 135 and max(inner_soft[:3]) <= 3, inner_soft
assert two_ring_result.getpixel((3, 3)) == (0, 0, 0, 255)

# A true-alpha PNG can still carry a matte color in transparent boundary RGB
# and contaminated straight-alpha edge RGB. Remove that matte through every
# connected translucent ring while preserving alpha and opaque interiors.
alpha_halo = Image.new("RGBA", (9, 9), (255, 255, 255, 0))
for y in range(1, 8):
    for x in range(1, 8):
        alpha_halo.putpixel((x, y), (223, 223, 223, 32))
for y in range(2, 7):
    for x in range(2, 7):
        alpha_halo.putpixel((x, y), (127, 127, 127, 128))
for y in range(3, 6):
    for x in range(3, 6):
        alpha_halo.putpixel((x, y), (0, 0, 0, 255))
alpha_halo_png, _alpha_halo_geometry = normalize_art_font_output(
    png(alpha_halo), 1,
)
alpha_halo_result = Image.open(BytesIO(alpha_halo_png)).convert("RGBA")
assert alpha_halo_result.getpixel((0, 0))[3] == 32
assert max(alpha_halo_result.getpixel((0, 0))[:3]) <= 3
assert alpha_halo_result.getpixel((1, 1))[3] == 128
assert max(alpha_halo_result.getpixel((1, 1))[:3]) <= 3
assert alpha_halo_result.getpixel((3, 3)) == (0, 0, 0, 255)
composite = Image.alpha_composite(
    Image.new("RGBA", alpha_halo_result.size, (20, 180, 40, 255)),
    alpha_halo_result,
)
assert composite.getpixel((1, 1))[:3] == (10, 90, 20)

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
