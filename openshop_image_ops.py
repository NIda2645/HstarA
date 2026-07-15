from __future__ import annotations

import io
import warnings
from typing import Any

from PIL import Image, ImageChops


class OpenShopImageNormalizationError(ValueError):
    pass


MAX_IMAGE_BYTES = 64 * 1024 * 1024
MAX_IMAGE_DIMENSION = 16384
MAX_CROP_RATIO_ERROR = 0.10


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
