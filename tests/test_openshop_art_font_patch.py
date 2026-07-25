import unittest
from io import BytesIO

from PIL import Image

from openshop_image_ops import (
    OpenShopImageNormalizationError,
    normalize_art_font_patch_output,
    prepare_art_font_edit,
)


def png_bytes(image: Image.Image) -> bytes:
    output = BytesIO()
    image.save(output, format="PNG")
    return output.getvalue()


def decode_png(data: bytes) -> Image.Image:
    image = Image.open(BytesIO(data))
    image.load()
    return image.convert("RGBA")


class OpenShopArtFontPatchTests(unittest.TestCase):
    def source_png(self) -> bytes:
        image = Image.new("RGBA", (200, 120), (0, 0, 0, 255))
        for y in range(image.height):
            for x in range(image.width):
                image.putpixel((x, y), (x % 251, y % 239, (x + y) % 247, 255))
        return png_bytes(image)

    def quad(self):
        return [
            {"x": 0.30, "y": 0.30},
            {"x": 0.70, "y": 0.25},
            {"x": 0.72, "y": 0.68},
            {"x": 0.28, "y": 0.72},
        ]

    def test_prepares_opaque_source_patch_and_inverse_alpha_edit_mask(self):
        patch_bytes, mask_bytes, placement = prepare_art_font_edit(
            self.source_png(),
            self.quad(),
        )

        patch = decode_png(patch_bytes)
        mask = decode_png(mask_bytes)
        self.assertEqual(patch.size, mask.size)
        self.assertEqual(
            patch.size,
            (placement["width"], placement["height"]),
        )
        self.assertGreaterEqual(placement["x"], 0)
        self.assertGreaterEqual(placement["y"], 0)
        self.assertLessEqual(placement["x"] + placement["width"], 200)
        self.assertLessEqual(placement["y"] + placement["height"], 120)
        self.assertEqual(patch.getchannel("A").getextrema(), (255, 255))

        alpha = mask.getchannel("A")
        self.assertEqual(alpha.getpixel((0, 0)), 255)
        self.assertEqual(alpha.getpixel((mask.width // 2, mask.height // 2)), 0)
        self.assertEqual(set(alpha.tobytes()), {0, 255})

    def test_restores_every_protected_pixel_and_returns_native_placement(self):
        patch_bytes, mask_bytes, placement = prepare_art_font_edit(
            self.source_png(),
            self.quad(),
        )
        patch = decode_png(patch_bytes)
        mask = decode_png(mask_bytes)
        generated = Image.new(
            "RGBA",
            (patch.width * 2, patch.height * 2),
            (12, 220, 80, 255),
        )

        output_bytes, geometry = normalize_art_font_patch_output(
            png_bytes(generated),
            patch_bytes,
            mask_bytes,
            placement,
        )

        output = decode_png(output_bytes)
        self.assertEqual(output.size, patch.size)
        self.assertEqual(output.getchannel("A").getextrema(), (255, 255))
        self.assertEqual(
            geometry,
            {
                "width": patch.width,
                "height": patch.height,
                "placementBox": placement,
            },
        )
        protected = 0
        edited = 0
        mask_alpha = mask.getchannel("A")
        for y in range(output.height):
            for x in range(output.width):
                if mask_alpha.getpixel((x, y)) == 255:
                    self.assertEqual(output.getpixel((x, y)), patch.getpixel((x, y)))
                    protected += 1
                else:
                    self.assertEqual(output.getpixel((x, y)), (12, 220, 80, 255))
                    edited += 1
        self.assertGreater(protected, 0)
        self.assertGreater(edited, 0)

    def test_composites_transparent_generated_pixels_over_the_source_patch(self):
        patch_bytes, mask_bytes, placement = prepare_art_font_edit(
            self.source_png(),
            self.quad(),
        )
        patch = decode_png(patch_bytes)
        generated = Image.new("RGBA", patch.size, (240, 20, 40, 96))

        output_bytes, _geometry = normalize_art_font_patch_output(
            png_bytes(generated),
            patch_bytes,
            mask_bytes,
            placement,
        )

        output = decode_png(output_bytes)
        self.assertEqual(output.getchannel("A").getextrema(), (255, 255))

    def test_rejects_a_placement_box_that_does_not_match_the_patch(self):
        patch_bytes, mask_bytes, placement = prepare_art_font_edit(
            self.source_png(),
            self.quad(),
        )
        patch = decode_png(patch_bytes)
        invalid = {**placement, "width": placement["width"] + 1}

        with self.assertRaises(OpenShopImageNormalizationError):
            normalize_art_font_patch_output(
                png_bytes(Image.new("RGBA", patch.size, (1, 2, 3, 255))),
                patch_bytes,
                mask_bytes,
                invalid,
            )


if __name__ == "__main__":
    unittest.main()
