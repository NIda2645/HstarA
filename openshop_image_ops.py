from __future__ import annotations

import io
import math
import warnings
from collections import Counter, deque
from statistics import median
from typing import Any

from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageOps


class OpenShopImageNormalizationError(ValueError):
    pass


MAX_IMAGE_BYTES = 64 * 1024 * 1024
MAX_IMAGE_DIMENSION = 16384
MAX_CROP_RATIO_ERROR = 0.10

MAX_ART_FONT_COMPRESSED_BYTES = 16 * 1024 * 1024
MAX_ART_FONT_SOURCE_WIDTH = 8192
MAX_ART_FONT_SOURCE_HEIGHT = 8192
MAX_ART_FONT_SOURCE_PIXELS = 32 * 1024 * 1024
MAX_ART_FONT_WIDTH = 4096
MAX_ART_FONT_HEIGHT = 4096
MAX_ART_FONT_PIXELS = 8 * 1024 * 1024
MAX_ART_FONT_CANVAS_WIDTH = 4096
MAX_ART_FONT_CANVAS_HEIGHT = 4096
MAX_ART_FONT_CANVAS_PIXELS = 12 * 1024 * 1024

_TRANSPARENT_ALPHA_MAX = 16
_MATTE_DISTANCE = 24
_MATTE_EDGE_MIN_COVERAGE = 0.02
_MATTE_EDGE_MAX_COVERAGE = 0.90
_ADAPTIVE_MATTE_MAX_DISTANCE = 96
_ADAPTIVE_MATTE_MIN_COVERAGE = 0.72


def _decode_image(data: bytes, mode: str, label: str) -> Image.Image:
    if not isinstance(data, bytes) or not data or len(data) > MAX_IMAGE_BYTES:
        raise OpenShopImageNormalizationError(f"OpenShop {label} is empty or too large")
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(data)) as image:
                width, height = image.size
                if (
                    width < 1
                    or height < 1
                    or width > MAX_IMAGE_DIMENSION
                    or height > MAX_IMAGE_DIMENSION
                ):
                    raise OpenShopImageNormalizationError(
                        f"OpenShop {label} dimensions are unsafe"
                    )
                image.load()
                return image.convert(mode)
    except OpenShopImageNormalizationError:
        raise
    except (Image.DecompressionBombWarning, Image.DecompressionBombError) as exc:
        raise OpenShopImageNormalizationError(
            f"OpenShop {label} dimensions are unsafe"
        ) from exc
    except Exception as exc:
        raise OpenShopImageNormalizationError(f"OpenShop {label} could not be decoded") from exc


def _validate_art_dimensions(
    width: int,
    height: int,
    label: str,
    generated_output: bool,
) -> None:
    max_width = MAX_ART_FONT_WIDTH if generated_output else MAX_ART_FONT_SOURCE_WIDTH
    max_height = MAX_ART_FONT_HEIGHT if generated_output else MAX_ART_FONT_SOURCE_HEIGHT
    max_pixels = MAX_ART_FONT_PIXELS if generated_output else MAX_ART_FONT_SOURCE_PIXELS
    if (
        width < 1
        or height < 1
        or width > max_width
        or height > max_height
        or width * height > max_pixels
    ):
        raise OpenShopImageNormalizationError(f"OpenShop {label} dimensions are unsafe")


def _decode_art_image(
    data: bytes,
    mode: str,
    label: str,
    *,
    exif_transpose: bool = False,
    generated_output: bool = False,
) -> Image.Image:
    if (
        not isinstance(data, bytes)
        or not data
        or len(data) > MAX_ART_FONT_COMPRESSED_BYTES
    ):
        raise OpenShopImageNormalizationError(f"OpenShop {label} is empty or too large")
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(data)) as image:
                _validate_art_dimensions(
                    *image.size,
                    label,
                    generated_output,
                )
                image.load()
                decoded = ImageOps.exif_transpose(image) if exif_transpose else image.copy()
                _validate_art_dimensions(
                    *decoded.size,
                    label,
                    generated_output,
                )
                return decoded.convert(mode)
    except OpenShopImageNormalizationError:
        raise
    except (Image.DecompressionBombWarning, Image.DecompressionBombError) as exc:
        raise OpenShopImageNormalizationError(
            f"OpenShop {label} dimensions are unsafe"
        ) from exc
    except Exception as exc:
        raise OpenShopImageNormalizationError(
            f"OpenShop {label} could not be decoded"
        ) from exc


def _normalized_art_quad(value: Any) -> list[tuple[float, float]]:
    if not isinstance(value, list) or len(value) != 4:
        raise OpenShopImageNormalizationError("OpenShop art font quad is invalid")
    points: list[tuple[float, float]] = []
    for item in value:
        if not isinstance(item, dict):
            raise OpenShopImageNormalizationError("OpenShop art font quad is invalid")
        try:
            x = float(item.get("x"))
            y = float(item.get("y"))
        except (TypeError, ValueError) as exc:
            raise OpenShopImageNormalizationError(
                "OpenShop art font quad is invalid"
            ) from exc
        if not math.isfinite(x) or not math.isfinite(y) or not 0 <= x <= 1 or not 0 <= y <= 1:
            raise OpenShopImageNormalizationError("OpenShop art font quad is invalid")
        points.append((x, y))
    return points


def _png_bytes(image: Image.Image, label: str) -> bytes:
    output = io.BytesIO()
    image.save(output, format="PNG", compress_level=6)
    content = output.getvalue()
    if len(content) > MAX_ART_FONT_COMPRESSED_BYTES:
        raise OpenShopImageNormalizationError(f"OpenShop {label} is too large")
    return content


def _general_png_bytes(image: Image.Image, label: str) -> bytes:
    output = io.BytesIO()
    image.save(output, format="PNG", compress_level=6)
    content = output.getvalue()
    if len(content) > MAX_IMAGE_BYTES:
        raise OpenShopImageNormalizationError(f"OpenShop {label} is too large")
    return content


def normalize_generated_text_removal(
    generated_bytes: bytes,
    target_size: tuple[int, int],
) -> bytes:
    target_width, target_height = (int(target_size[0]), int(target_size[1]))
    if (
        target_width < 64
        or target_height < 64
        or target_width > 4096
        or target_height > 4096
        or target_width * target_height > 4096 * 4096
    ):
        raise OpenShopImageNormalizationError(
            "OpenShop text removal target dimensions are unsafe"
        )
    generated = ImageOps.exif_transpose(
        _decode_image(generated_bytes, "RGBA", "text removal generated output")
    )
    if generated.size != (target_width, target_height):
        generated = generated.resize(
            (target_width, target_height),
            Image.Resampling.LANCZOS,
        )
    return _general_png_bytes(generated, "text removal normalized output")


def _normalized_text_removal_quad(quad: Any) -> list[tuple[float, float]] | None:
    if not isinstance(quad, list) or len(quad) != 4:
        return None
    points: list[tuple[float, float]] = []
    for item in quad:
        if not isinstance(item, dict):
            return None
        try:
            x = float(item.get("x"))
            y = float(item.get("y"))
        except (TypeError, ValueError):
            return None
        if not math.isfinite(x) or not math.isfinite(y) or not 0 <= x <= 1 or not 0 <= y <= 1:
            return None
        points.append((x, y))
    return points


def prepare_text_removal_edit(
    source_bytes: bytes,
    layout: dict[str, Any],
    target_size: tuple[int, int],
) -> tuple[bytes, bytes, bytes]:
    source = ImageOps.exif_transpose(
        _decode_image(source_bytes, "RGBA", "text removal source")
    )
    target_width, target_height = (int(target_size[0]), int(target_size[1]))
    if (
        target_width < 64
        or target_height < 64
        or target_width > 4096
        or target_height > 4096
        or target_width * target_height > 4096 * 4096
    ):
        raise OpenShopImageNormalizationError("OpenShop text removal target dimensions are unsafe")

    scale = min(target_width / source.width, target_height / source.height)
    content_width = max(1, min(target_width, round(source.width * scale)))
    content_height = max(1, min(target_height, round(source.height * scale)))
    offset_x = (target_width - content_width) // 2
    offset_y = (target_height - content_height) // 2
    resized = source.resize((content_width, content_height), Image.Resampling.LANCZOS)
    average = source.resize((1, 1), Image.Resampling.BOX).getpixel((0, 0))
    prepared = Image.new("RGBA", (target_width, target_height), average)
    prepared.alpha_composite(resized, (offset_x, offset_y))

    # White pixels are editable. The outer margins are editable for outpainting;
    # all original image pixels remain protected except OCR text polygons.
    edit_mask = Image.new("L", (target_width, target_height), 255)
    draw = ImageDraw.Draw(edit_mask)
    draw.rectangle(
        (
            offset_x,
            offset_y,
            offset_x + content_width - 1,
            offset_y + content_height - 1,
        ),
        fill=0,
    )
    for block in layout.get("blocks", []) if isinstance(layout, dict) else []:
        if not isinstance(block, dict) or not str(block.get("text") or "").strip():
            continue
        quad = _normalized_text_removal_quad(block.get("quad"))
        if not quad:
            continue
        draw.polygon(
            [
                (
                    offset_x + x * content_width,
                    offset_y + y * content_height,
                )
                for x, y in quad
            ],
            fill=255,
        )
    edit_mask = edit_mask.filter(ImageFilter.MaxFilter(9))

    api_mask = Image.new("RGBA", prepared.size, (0, 0, 0, 0))
    api_mask.putalpha(ImageOps.invert(edit_mask))
    return (
        _general_png_bytes(prepared, "text removal prepared source"),
        _general_png_bytes(api_mask, "text removal API mask"),
        _general_png_bytes(edit_mask, "text removal edit mask"),
    )


def normalize_text_removal_output(
    prepared_source_bytes: bytes,
    edit_mask_bytes: bytes,
    generated_bytes: bytes,
) -> bytes:
    prepared = _decode_image(
        prepared_source_bytes,
        "RGBA",
        "text removal prepared source",
    )
    generated = _decode_image(generated_bytes, "RGBA", "text removal generated output")
    edit_mask = _decode_image(edit_mask_bytes, "L", "text removal edit mask")
    if generated.size != prepared.size:
        generated = generated.resize(prepared.size, Image.Resampling.LANCZOS)
    if edit_mask.size != prepared.size:
        edit_mask = edit_mask.resize(prepared.size, Image.Resampling.NEAREST)
    normalized = Image.composite(generated, prepared, edit_mask)
    return _general_png_bytes(normalized, "text removal normalized output")


def crop_art_font_reference(
    source_bytes: bytes,
    quad: Any,
    padding_ratio: float = 0.15,
) -> bytes:
    source = _decode_art_image(
        source_bytes,
        "RGBA",
        "art font source",
        exif_transpose=True,
    )
    points = [
        (x * source.width, y * source.height)
        for x, y in _normalized_art_quad(quad)
    ]
    try:
        padding_value = float(padding_ratio)
    except (TypeError, ValueError) as exc:
        raise OpenShopImageNormalizationError(
            "OpenShop art font reference padding is invalid"
        ) from exc
    if not math.isfinite(padding_value):
        raise OpenShopImageNormalizationError(
            "OpenShop art font reference padding is invalid"
        )
    left = min(x for x, _ in points)
    top = min(y for _, y in points)
    right = max(x for x, _ in points)
    bottom = max(y for _, y in points)
    if right - left < 1 or bottom - top < 1:
        raise OpenShopImageNormalizationError("OpenShop art font quad has no usable area")
    padding = max(right - left, bottom - top) * max(0.0, min(0.5, padding_value))
    box = (
        max(0, math.floor(left - padding)),
        max(0, math.floor(top - padding)),
        min(source.width, math.ceil(right + padding)),
        min(source.height, math.ceil(bottom + padding)),
    )
    if box[2] <= box[0] or box[3] <= box[1]:
        raise OpenShopImageNormalizationError("OpenShop art font reference crop is empty")
    return _png_bytes(source.crop(box), "art font reference")


def prepare_art_font_edit(
    source_bytes: bytes,
    quad: Any,
    padding_ratio: float = 0.25,
    edit_padding_ratio: float = 0.08,
) -> tuple[bytes, bytes, dict[str, int]]:
    """Create a local source patch and inverse-alpha edit mask for art text."""
    source = _decode_art_image(
        source_bytes,
        "RGBA",
        "art font source",
        exif_transpose=True,
    )
    points = [
        (x * source.width, y * source.height)
        for x, y in _normalized_art_quad(quad)
    ]
    left = min(x for x, _ in points)
    top = min(y for _, y in points)
    right = max(x for x, _ in points)
    bottom = max(y for _, y in points)
    quad_width = right - left
    quad_height = bottom - top
    if quad_width < 1 or quad_height < 1:
        raise OpenShopImageNormalizationError("OpenShop art font quad has no usable area")
    try:
        crop_ratio = float(padding_ratio)
        edit_ratio = float(edit_padding_ratio)
    except (TypeError, ValueError) as exc:
        raise OpenShopImageNormalizationError(
            "OpenShop art font edit padding is invalid"
        ) from exc
    if not math.isfinite(crop_ratio) or not math.isfinite(edit_ratio):
        raise OpenShopImageNormalizationError(
            "OpenShop art font edit padding is invalid"
        )
    span = max(quad_width, quad_height)
    crop_padding = span * max(0.05, min(0.75, crop_ratio))
    crop_box = (
        max(0, math.floor(left - crop_padding)),
        max(0, math.floor(top - crop_padding)),
        min(source.width, math.ceil(right + crop_padding)),
        min(source.height, math.ceil(bottom + crop_padding)),
    )
    if crop_box[2] <= crop_box[0] or crop_box[3] <= crop_box[1]:
        raise OpenShopImageNormalizationError("OpenShop art font edit crop is empty")
    patch_size = (crop_box[2] - crop_box[0], crop_box[3] - crop_box[1])
    _validate_art_dimensions(
        *patch_size,
        "art font edit patch",
        generated_output=True,
    )

    # The result is an opaque replacement patch. Flattening here also gives
    # image providers deterministic context when the source PNG has alpha.
    opaque_source = Image.alpha_composite(
        Image.new("RGBA", source.size, (255, 255, 255, 255)),
        source,
    )
    patch = opaque_source.crop(crop_box)

    edit_padding = span * max(0.0, min(0.35, edit_ratio))
    center_x = sum(x for x, _ in points) / len(points)
    center_y = sum(y for _, y in points) / len(points)
    scale_x = (quad_width + edit_padding * 2) / quad_width
    scale_y = (quad_height + edit_padding * 2) / quad_height
    expanded_points = [
        (
            center_x + (x - center_x) * scale_x - crop_box[0],
            center_y + (y - center_y) * scale_y - crop_box[1],
        )
        for x, y in points
    ]
    mask = Image.new("RGBA", patch_size, (0, 0, 0, 255))
    ImageDraw.Draw(mask).polygon(expanded_points, fill=(0, 0, 0, 0))
    placement = {
        "x": crop_box[0],
        "y": crop_box[1],
        "width": patch.width,
        "height": patch.height,
    }
    return (
        _png_bytes(patch, "art font edit source"),
        _png_bytes(mask, "art font edit mask"),
        placement,
    )


def normalize_art_font_patch_output(
    generated_bytes: bytes,
    source_patch_bytes: bytes,
    mask_bytes: bytes,
    placement_box: Any,
) -> tuple[bytes, dict[str, Any]]:
    """Fit a generated patch and restore every inverse-mask protected pixel."""
    source = _decode_art_image(
        source_patch_bytes,
        "RGBA",
        "art font edit source",
    )
    mask = _decode_art_image(mask_bytes, "RGBA", "art font edit mask")
    generated = _decode_art_image(
        generated_bytes,
        "RGBA",
        "art font edit output",
        generated_output=True,
    )
    if mask.size != source.size:
        raise OpenShopImageNormalizationError(
            "OpenShop art font edit mask is misaligned"
        )
    if not isinstance(placement_box, dict):
        raise OpenShopImageNormalizationError(
            "OpenShop art font placement box is invalid"
        )
    placement: dict[str, int] = {}
    for key in ("x", "y", "width", "height"):
        value = placement_box.get(key)
        if isinstance(value, bool) or not isinstance(value, int):
            raise OpenShopImageNormalizationError(
                "OpenShop art font placement box is invalid"
            )
        placement[key] = value
    if (
        placement["x"] < 0
        or placement["y"] < 0
        or placement["width"] != source.width
        or placement["height"] != source.height
    ):
        raise OpenShopImageNormalizationError(
            "OpenShop art font placement box is invalid"
        )

    if generated.size != source.size:
        generated = ImageOps.fit(
            generated,
            source.size,
            method=Image.Resampling.LANCZOS,
            centering=(0.5, 0.5),
        )
    opaque_source = Image.alpha_composite(
        Image.new("RGBA", source.size, (255, 255, 255, 255)),
        source,
    )
    generated_over_source = Image.alpha_composite(opaque_source, generated)
    protected = mask.getchannel("A").point(lambda value: 255 if value >= 128 else 0)
    output = Image.composite(opaque_source, generated_over_source, protected)
    geometry = {
        "width": output.width,
        "height": output.height,
        "placementBox": placement,
    }
    return _png_bytes(output, "art font edit normalized output"), geometry


def _boundary_indexes(width: int, height: int) -> list[int]:
    indexes = list(range(width))
    if height > 1:
        indexes.extend((height - 1) * width + x for x in range(width))
    if height > 2:
        for y in range(1, height - 1):
            indexes.append(y * width)
            if width > 1:
                indexes.append(y * width + width - 1)
    return indexes


def _has_meaningful_transparent_background(image: Image.Image) -> bool:
    width, height = image.size
    total = width * height
    alpha = image.getchannel("A").tobytes()
    boundary = _boundary_indexes(width, height)
    seeds = [index for index in boundary if alpha[index] <= _TRANSPARENT_ALPHA_MAX]
    if len(seeds) < max(2, math.ceil(len(boundary) * 0.25)):
        return False
    visited = bytearray(total)
    queue: deque[int] = deque()
    for index in seeds:
        if not visited[index]:
            visited[index] = 1
            queue.append(index)
    connected = 0
    while queue:
        index = queue.popleft()
        if alpha[index] > _TRANSPARENT_ALPHA_MAX:
            continue
        connected += 1
        x = index % width
        for neighbor in (
            index - 1 if x else -1,
            index + 1 if x + 1 < width else -1,
            index - width if index >= width else -1,
            index + width if index + width < total else -1,
        ):
            if neighbor >= 0 and not visited[neighbor]:
                visited[neighbor] = 1
                queue.append(neighbor)
    return connected >= max(4, math.ceil(total * 0.05))


def _rgb_distance_squared(data: bytes, index: int, color: tuple[int, int, int]) -> int:
    offset = index * 3
    return sum((data[offset + channel] - color[channel]) ** 2 for channel in range(3))


def _uniform_boundary_matte(image: Image.Image) -> tuple[tuple[int, int, int], bytes]:
    rgb_data = image.convert("RGB").tobytes()
    boundary = _boundary_indexes(*image.size)
    colors = [tuple(rgb_data[index * 3 : index * 3 + 3]) for index in boundary]
    bins = Counter(tuple(channel // 8 for channel in color) for color in colors)
    dominant_bin, dominant_count = bins.most_common(1)[0]
    if dominant_count / len(colors) < 0.90:
        raise OpenShopImageNormalizationError(
            "OpenShop art font output has no safe transparent matte"
        )
    dominant_colors = [
        color
        for color in colors
        if tuple(channel // 8 for channel in color) == dominant_bin
    ]
    matte = tuple(
        round(sum(color[channel] for color in dominant_colors) / len(dominant_colors))
        for channel in range(3)
    )
    inliers = [
        color
        for color in colors
        if sum((color[channel] - matte[channel]) ** 2 for channel in range(3))
        <= _MATTE_DISTANCE**2
    ]
    if len(inliers) / len(colors) < 0.90:
        raise OpenShopImageNormalizationError(
            "OpenShop art font output has no safe transparent matte"
        )
    for channel in range(3):
        mean = sum(color[channel] for color in inliers) / len(inliers)
        variance = sum((color[channel] - mean) ** 2 for color in inliers) / len(inliers)
        if variance > 16.0:
            raise OpenShopImageNormalizationError(
                "OpenShop art font output has an unsafe boundary matte"
            )
    return matte, rgb_data


def _adaptive_boundary_matte(
    image: Image.Image,
) -> tuple[tuple[int, int, int], bytes, int]:
    """Estimate a low-texture opaque background when the model adds mild noise."""
    rgb_data = image.convert("RGB").tobytes()
    boundary = _boundary_indexes(*image.size)
    colors = [tuple(rgb_data[index * 3 : index * 3 + 3]) for index in boundary]
    matte = tuple(
        round(median(color[channel] for color in colors))
        for channel in range(3)
    )
    distances = sorted(
        math.sqrt(sum((color[channel] - matte[channel]) ** 2 for channel in range(3)))
        for color in colors
    )
    percentile_index = max(0, min(len(distances) - 1, math.ceil(len(distances) * 0.90) - 1))
    percentile_distance = distances[percentile_index]
    if percentile_distance > _ADAPTIVE_MATTE_MAX_DISTANCE:
        raise OpenShopImageNormalizationError(
            "OpenShop art font output has no safe transparent matte"
        )
    tolerance = max(32, min(_ADAPTIVE_MATTE_MAX_DISTANCE, math.ceil(percentile_distance + 8)))
    inlier_count = sum(distance <= tolerance for distance in distances)
    if inlier_count / len(distances) < _ADAPTIVE_MATTE_MIN_COVERAGE:
        raise OpenShopImageNormalizationError(
            "OpenShop art font output has no safe transparent matte"
        )
    return matte, rgb_data, tolerance


def _matte_coverage(
    rgb_data: bytes,
    index: int,
    matte: tuple[int, int, int],
) -> float:
    rgb_offset = index * 3
    coverages = []
    for channel in range(3):
        value = rgb_data[rgb_offset + channel]
        background = matte[channel]
        denominator = background if value < background else 255 - background
        coverages.append(
            abs(value - background) / denominator if denominator else 0.0
        )
    return max(coverages)


def _decontaminate_rgb(
    rgba_data: bytearray,
    rgb_data: bytes,
    index: int,
    matte: tuple[int, int, int],
    coverage: float,
) -> None:
    rgba_offset = index * 4
    rgba_data[rgba_offset + 3] = max(1, min(254, round(coverage * 255)))
    rgb_offset = index * 3
    for channel in range(3):
        observed = rgb_data[rgb_offset + channel]
        foreground = (observed - matte[channel] * (1.0 - coverage)) / coverage
        rgba_data[rgba_offset + channel] = max(0, min(255, round(foreground)))


def _remove_boundary_matte(
    image: Image.Image,
    matte: tuple[int, int, int] | None = None,
    rgb_data: bytes | None = None,
    background_distance: int = _MATTE_DISTANCE,
) -> Image.Image:
    width, height = image.size
    total = width * height
    if matte is None or rgb_data is None:
        matte, rgb_data = _uniform_boundary_matte(image)
    rgba_data = bytearray(image.tobytes())
    visited = bytearray(total)
    queue: deque[int] = deque()
    for index in _boundary_indexes(width, height):
        if not visited[index]:
            visited[index] = 1
            queue.append(index)
    while queue:
        index = queue.popleft()
        distance = _rgb_distance_squared(rgb_data, index, matte)
        if distance <= background_distance**2:
            rgba_data[index * 4 + 3] = 0
        else:
            coverage = _matte_coverage(rgb_data, index, matte)
            if not (
                _MATTE_EDGE_MIN_COVERAGE
                < coverage
                < _MATTE_EDGE_MAX_COVERAGE
            ):
                continue
            _decontaminate_rgb(
                rgba_data,
                rgb_data,
                index,
                matte,
                coverage,
            )
        x = index % width
        for neighbor in (
            index - 1 if x else -1,
            index + 1 if x + 1 < width else -1,
            index - width if index >= width else -1,
            index + width if index + width < total else -1,
        ):
            if neighbor >= 0 and not visited[neighbor]:
                visited[neighbor] = 1
                queue.append(neighbor)
    return Image.frombytes("RGBA", image.size, bytes(rgba_data))


def prepare_art_font_reference(
    source_bytes: bytes,
    quad: Any,
    padding_ratio: float = 0.02,
) -> bytes:
    """Build a tight, opaque-glyph reference without surrounding artwork."""
    cropped_bytes = crop_art_font_reference(source_bytes, quad, padding_ratio)
    image = _decode_art_image(cropped_bytes, "RGBA", "art font reference")
    if image.getchannel("A").getextrema()[0] < 255:
        isolated = image
    else:
        try:
            matte, rgb_data = _uniform_boundary_matte(image)
            background_distance = _MATTE_DISTANCE
        except OpenShopImageNormalizationError:
            matte, rgb_data, background_distance = _adaptive_boundary_matte(image)
        isolated = _remove_boundary_matte(
            image,
            matte=matte,
            rgb_data=rgb_data,
            background_distance=background_distance,
        )

    source_rgba = bytearray(image.tobytes())
    isolated_alpha = isolated.getchannel("A").tobytes()
    visible_pixels = 0
    for index, alpha in enumerate(isolated_alpha):
        offset = index * 4
        if alpha >= 32:
            source_rgba[offset + 3] = 255
            visible_pixels += 1
        else:
            source_rgba[offset : offset + 4] = b"\x00\x00\x00\x00"
    if not visible_pixels:
        raise OpenShopImageNormalizationError(
            "OpenShop art font reference has no isolated glyph pixels"
        )
    return _png_bytes(
        Image.frombytes("RGBA", image.size, bytes(source_rgba)),
        "art font isolated reference",
    )


def _transparent_boundary_matte(image: Image.Image) -> tuple[int, int, int] | None:
    rgba_data = image.tobytes()
    colors = []
    for index in _boundary_indexes(*image.size):
        offset = index * 4
        if rgba_data[offset + 3] <= _TRANSPARENT_ALPHA_MAX:
            colors.append(tuple(rgba_data[offset : offset + 3]))
    if not colors:
        return None
    bins = Counter(tuple(channel // 8 for channel in color) for color in colors)
    dominant_bin, dominant_count = bins.most_common(1)[0]
    if dominant_count / len(colors) < 0.90:
        return None
    dominant_colors = [
        color
        for color in colors
        if tuple(channel // 8 for channel in color) == dominant_bin
    ]
    matte = tuple(
        round(sum(color[channel] for color in dominant_colors) / len(dominant_colors))
        for channel in range(3)
    )
    if max(matte) <= _TRANSPARENT_ALPHA_MAX:
        return None
    return matte


def _decontaminate_transparent_matte(image: Image.Image) -> Image.Image:
    matte = _transparent_boundary_matte(image)
    if matte is None:
        return image
    width, height = image.size
    total = width * height
    rgba_data = bytearray(image.tobytes())
    visited = bytearray(total)
    queue: deque[int] = deque()
    for index in _boundary_indexes(width, height):
        if rgba_data[index * 4 + 3] <= _TRANSPARENT_ALPHA_MAX and not visited[index]:
            visited[index] = 1
            queue.append(index)
    while queue:
        index = queue.popleft()
        offset = index * 4
        alpha = rgba_data[offset + 3]
        if _TRANSPARENT_ALPHA_MAX < alpha < 255:
            coverage = alpha / 255.0
            candidates = []
            for channel in range(3):
                observed = rgba_data[offset + channel]
                foreground = (
                    observed - matte[channel] * (1.0 - coverage)
                ) / coverage
                candidates.append(max(0, min(255, round(foreground))))
            recomposed = [
                round(
                    candidates[channel] * coverage
                    + matte[channel] * (1.0 - coverage)
                )
                for channel in range(3)
            ]
            if all(
                abs(recomposed[channel] - rgba_data[offset + channel]) <= 2
                for channel in range(3)
            ):
                rgba_data[offset : offset + 3] = bytes(candidates)
        if alpha >= 255:
            continue
        x = index % width
        for neighbor in (
            index - 1 if x else -1,
            index + 1 if x + 1 < width else -1,
            index - width if index >= width else -1,
            index + width if index + width < total else -1,
        ):
            if neighbor >= 0 and not visited[neighbor]:
                visited[neighbor] = 1
                queue.append(neighbor)
    return Image.frombytes("RGBA", image.size, bytes(rgba_data))


def _validate_art_font_no_scene(image: Image.Image) -> None:
    content_box = image.getchannel("A").getbbox()
    if not content_box:
        return
    left, top, right, bottom = content_box
    width = right - left
    height = bottom - top
    area = width * height
    if width < 6 or height < 4 or area < 32:
        return
    alpha = image.getchannel("A").tobytes()
    rgb = image.convert("RGB").tobytes()
    image_width = image.width
    visible_count = 0
    color_bins = bytearray(512)
    color_bin_count = 0
    compared = 0
    high_contrast = 0
    for y in range(top, bottom):
        for x in range(left, right):
            index = y * image_width + x
            if alpha[index] <= _TRANSPARENT_ALPHA_MAX:
                continue
            visible_count += 1
            offset = index * 3
            color_bin = (
                (rgb[offset] // 32) * 64
                + (rgb[offset + 1] // 32) * 8
                + rgb[offset + 2] // 32
            )
            if not color_bins[color_bin]:
                color_bins[color_bin] = 1
                color_bin_count += 1
            for neighbor in (
                index + 1 if x + 1 < right else -1,
                index + image_width if y + 1 < bottom else -1,
            ):
                if neighbor < 0 or alpha[neighbor] <= _TRANSPARENT_ALPHA_MAX:
                    continue
                compared += 1
                neighbor_offset = neighbor * 3
                distance = sum(
                    (rgb[offset + channel] - rgb[neighbor_offset + channel]) ** 2
                    for channel in range(3)
                )
                if distance >= 48**2:
                    high_contrast += 1
    if visible_count / area < 0.92 or color_bin_count < 4:
        return
    if compared and high_contrast / compared >= 0.30:
        raise OpenShopImageNormalizationError(
            "OpenShop art font output contains a scene-like rectangular foreground panel"
        )


def _art_font_has_color_halo(image: Image.Image) -> bool:
    content_box = image.getchannel("A").getbbox()
    if not content_box:
        return False
    left, top, right, bottom = content_box
    if (right - left) * (bottom - top) < 256:
        return False
    alpha = image.getchannel("A").tobytes()
    visible = 0
    opaque = 0
    soft = 0
    width = image.width
    for y in range(top, bottom):
        row = y * width
        for x in range(left, right):
            value = alpha[row + x]
            if value <= _TRANSPARENT_ALPHA_MAX:
                continue
            visible += 1
            if value >= 240:
                opaque += 1
            else:
                soft += 1
    return bool(
        visible
        and soft / visible >= 0.75
        and soft >= max(128, opaque * 3)
    )


def _art_font_opaque_palette(image: Image.Image) -> list[tuple[int, int, int]]:
    rgba = image.tobytes()
    bins: dict[tuple[int, int, int], list[int]] = {}
    for offset in range(0, len(rgba), 4):
        if rgba[offset + 3] < 240:
            continue
        key = tuple(rgba[offset + channel] // 16 for channel in range(3))
        stats = bins.setdefault(key, [0, 0, 0, 0])
        stats[0] += 1
        for channel in range(3):
            stats[channel + 1] += rgba[offset + channel]
    total = sum(stats[0] for stats in bins.values())
    if not total:
        raise OpenShopImageNormalizationError(
            "OpenShop art font output contains a color halo or translucent wash"
        )
    selected = []
    covered = 0
    for _key, stats in sorted(
        bins.items(), key=lambda item: item[1][0], reverse=True
    ):
        count = stats[0]
        selected.append(tuple(round(stats[channel + 1] / count) for channel in range(3)))
        covered += count
        if covered >= total * 0.95 or len(selected) >= 8:
            break
    return selected


def _remove_art_font_color_halo(image: Image.Image) -> Image.Image:
    width, height = image.size
    total = width * height
    alpha = image.getchannel("A")
    palette = _art_font_opaque_palette(image)
    opaque = alpha.point(lambda value: 255 if value >= 240 else 0)
    supported = opaque.filter(ImageFilter.MaxFilter(5))

    # A padded flood fill marks every area connected to the outside. Soft
    # pixels are restored as solid interiors only when a reliable opaque
    # contour encloses them and their color belongs to the glyph palette.
    padded = Image.new("L", (width + 2, height + 2), 0)
    padded.paste(supported, (1, 1))
    ImageDraw.floodfill(padded, (0, 0), 128)
    external = padded.crop((1, 1, width + 1, height + 1)).tobytes()
    support = supported.tobytes()
    source = image.tobytes()
    cleaned = bytearray(source)
    visible = 0
    for index in range(total):
        offset = index * 4
        value = source[offset + 3]
        if value <= _TRANSPARENT_ALPHA_MAX:
            cleaned[offset : offset + 4] = b"\x00\x00\x00\x00"
            continue
        nearest = palette[0]
        nearest_distance = math.inf
        for color in palette:
            distance = sum(
                (source[offset + channel] - color[channel]) ** 2
                for channel in range(3)
            )
            if distance < nearest_distance:
                nearest = color
                nearest_distance = distance
        if support[index]:
            if value < 240:
                cleaned[offset : offset + 3] = bytes(nearest)
            visible += 1
            continue
        if external[index] == 0 and nearest_distance <= 40**2:
            cleaned[offset + 3] = 255
            visible += 1
            continue
        cleaned[offset : offset + 4] = b"\x00\x00\x00\x00"
    if not visible:
        raise OpenShopImageNormalizationError(
            "OpenShop art font output has no visible glyph pixels"
        )
    return Image.frombytes("RGBA", image.size, bytes(cleaned))


def _validate_art_font_no_color_halo(image: Image.Image) -> None:
    if _art_font_has_color_halo(image):
        raise OpenShopImageNormalizationError(
            "OpenShop art font output contains a color halo or translucent wash"
        )


def normalize_art_font_output(
    generated_bytes: bytes,
    target_aspect: Any,
) -> tuple[bytes, dict[str, Any]]:
    image = _decode_art_image(
        generated_bytes,
        "RGBA",
        "art font output",
        generated_output=True,
    )
    try:
        aspect = float(target_aspect)
    except (TypeError, ValueError) as exc:
        raise OpenShopImageNormalizationError("OpenShop art font aspect is invalid") from exc
    if not math.isfinite(aspect) or not 0.01 <= aspect <= 100.0:
        raise OpenShopImageNormalizationError("OpenShop art font aspect is invalid")

    alpha = image.getchannel("A")
    if alpha.getextrema()[0] < 255:
        if not _has_meaningful_transparent_background(image):
            raise OpenShopImageNormalizationError(
                "OpenShop art font output has no safe transparent background"
            )
        image = _decontaminate_transparent_matte(image)
    else:
        try:
            matte, rgb_data = _uniform_boundary_matte(image)
            background_distance = _MATTE_DISTANCE
        except OpenShopImageNormalizationError:
            matte, rgb_data, background_distance = _adaptive_boundary_matte(image)
        image = _remove_boundary_matte(
            image,
            matte=matte,
            rgb_data=rgb_data,
            background_distance=background_distance,
        )

    if _art_font_has_color_halo(image):
        image = _remove_art_font_color_halo(image)
    _validate_art_font_no_color_halo(image)
    _validate_art_font_no_scene(image)
    content_box = image.getchannel("A").getbbox()
    if not content_box:
        raise OpenShopImageNormalizationError(
            "OpenShop art font output has no visible glyph pixels"
        )
    content = image.crop(content_box)
    if content.width / content.height >= aspect:
        canvas_width = content.width
        canvas_height = max(content.height, math.ceil(content.width / aspect))
    else:
        canvas_height = content.height
        canvas_width = max(content.width, math.ceil(content.height * aspect))
    if (
        canvas_width > MAX_ART_FONT_CANVAS_WIDTH
        or canvas_height > MAX_ART_FONT_CANVAS_HEIGHT
        or canvas_width * canvas_height > MAX_ART_FONT_CANVAS_PIXELS
    ):
        raise OpenShopImageNormalizationError(
            "OpenShop art font padded canvas dimensions are unsafe"
        )
    canvas = Image.new("RGBA", (canvas_width, canvas_height), (0, 0, 0, 0))
    offset = (
        (canvas_width - content.width) // 2,
        (canvas_height - content.height) // 2,
    )
    canvas.alpha_composite(content, offset)
    geometry = {
        "contentBox": {
            "x": offset[0],
            "y": offset[1],
            "width": content.width,
            "height": content.height,
        },
        "width": canvas.width,
        "height": canvas.height,
    }
    return _png_bytes(canvas, "art font normalized output"), geometry


def _positive_integer(value: Any, label: str) -> int:
    if isinstance(value, bool):
        raise OpenShopImageNormalizationError(f"OpenShop {label} is invalid")
    try:
        number = int(value)
    except (TypeError, ValueError) as exc:
        raise OpenShopImageNormalizationError(f"OpenShop {label} is invalid") from exc
    if number < 1:
        raise OpenShopImageNormalizationError(f"OpenShop {label} is invalid")
    return number


def _non_negative_integer(value: Any, label: str) -> int:
    if isinstance(value, bool):
        raise OpenShopImageNormalizationError(f"OpenShop {label} is invalid")
    try:
        number = int(value)
    except (TypeError, ValueError) as exc:
        raise OpenShopImageNormalizationError(f"OpenShop {label} is invalid") from exc
    if number < 0:
        raise OpenShopImageNormalizationError(f"OpenShop {label} is invalid")
    return number


def _validated_local_generation_bounds(
    source: Image.Image,
    mask: Image.Image,
    bounds: dict[str, Any],
) -> tuple[int, int, int, int]:
    if not isinstance(bounds, dict):
        raise OpenShopImageNormalizationError("OpenShop selection bounds are invalid")
    if mask.size != source.size or not mask.getbbox():
        raise OpenShopImageNormalizationError(
            "OpenShop selection mask is empty or misaligned"
        )

    x = _non_negative_integer(bounds.get("x"), "selection x")
    y = _non_negative_integer(bounds.get("y"), "selection y")
    width = _positive_integer(bounds.get("width"), "selection width")
    height = _positive_integer(bounds.get("height"), "selection height")
    if x + width > source.width or y + height > source.height:
        raise OpenShopImageNormalizationError(
            "OpenShop selection bounds are outside the document"
        )
    return x, y, width, height


def prepare_local_generation_inputs(
    source_bytes: bytes,
    mask_bytes: bytes,
    bounds: dict[str, Any],
) -> tuple[bytes, bytes]:
    """Return source and mask crops in the exact document selection space."""
    source = _decode_image(source_bytes, "RGBA", "source image")
    mask = _decode_image(mask_bytes, "L", "selection mask")
    x, y, width, height = _validated_local_generation_bounds(source, mask, bounds)
    crop_box = (x, y, x + width, y + height)
    local_source = source.crop(crop_box)
    local_mask = mask.crop(crop_box)
    if not local_mask.getbbox():
        raise OpenShopImageNormalizationError(
            "OpenShop selection mask does not overlap selection bounds"
        )
    return (
        _general_png_bytes(local_source, "local source image"),
        _general_png_bytes(local_mask, "local selection mask"),
    )


def normalize_local_generation(
    source_bytes: bytes,
    mask_bytes: bytes,
    generated_bytes: bytes,
    bounds: dict[str, Any],
) -> bytes:
    source = _decode_image(source_bytes, "RGBA", "source image")
    mask = _decode_image(mask_bytes, "L", "selection mask")
    generated = _decode_image(generated_bytes, "RGBA", "generated image")
    x, y, width, height = _validated_local_generation_bounds(source, mask, bounds)

    if generated.size == source.size:
        full = generated
    else:
        generated_ratio = generated.width / generated.height
        bounds_ratio = width / height
        if generated_ratio > bounds_ratio:
            crop_width = max(1, min(generated.width, round(generated.height * bounds_ratio)))
            crop_left = max(0, (generated.width - crop_width) // 2)
            generated = generated.crop(
                (crop_left, 0, crop_left + crop_width, generated.height)
            )
        elif generated_ratio < bounds_ratio:
            crop_height = max(1, min(generated.height, round(generated.width / bounds_ratio)))
            crop_top = max(0, (generated.height - crop_height) // 2)
            generated = generated.crop(
                (0, crop_top, generated.width, crop_top + crop_height)
            )
        crop = generated.resize((width, height), Image.Resampling.LANCZOS)
        full = Image.new("RGBA", source.size, (0, 0, 0, 0))
        full.alpha_composite(crop, (x, y))

    alpha = ImageChops.multiply(full.getchannel("A"), mask)
    if not alpha.getbbox():
        raise OpenShopImageNormalizationError(
            "OpenShop generated result has no selected pixels"
        )
    full.putalpha(alpha)
    output = io.BytesIO()
    full.save(output, format="PNG", compress_level=6)
    return output.getvalue()
