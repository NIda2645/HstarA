from __future__ import annotations

import io
import math
import warnings
from collections import Counter, deque
from typing import Any

from PIL import Image, ImageChops, ImageOps


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


def _remove_boundary_matte(image: Image.Image) -> Image.Image:
    width, height = image.size
    total = width * height
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
        if distance <= _MATTE_DISTANCE**2:
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
        image = _remove_boundary_matte(image)

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


def normalize_local_generation(
    source_bytes: bytes,
    mask_bytes: bytes,
    generated_bytes: bytes,
    bounds: dict[str, Any],
) -> bytes:
    if not isinstance(bounds, dict):
        raise OpenShopImageNormalizationError("OpenShop selection bounds are invalid")

    source = _decode_image(source_bytes, "RGBA", "source image")
    mask = _decode_image(mask_bytes, "L", "selection mask")
    generated = _decode_image(generated_bytes, "RGBA", "generated image")
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

    if generated.size == source.size:
        full = generated
    else:
        generated_ratio = generated.width / generated.height
        bounds_ratio = width / height
        if abs(generated_ratio - bounds_ratio) / bounds_ratio > MAX_CROP_RATIO_ERROR:
            raise OpenShopImageNormalizationError(
                "OpenShop generated crop aspect ratio is misaligned"
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
