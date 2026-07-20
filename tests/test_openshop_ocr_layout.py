import json
import unittest

from openshop_ai import build_ocr_prompt, normalize_ocr_layout


class OpenShopOcrPromptTests(unittest.TestCase):
    def test_requests_independent_tightly_positioned_style_aware_text_blocks(self):
        prompt = build_ocr_prompt(1085, 1449)

        self.assertIn("one block per visually distinct text line", prompt)
        self.assertIn("tight visible glyph bounds", prompt)
        self.assertIn("font.size in source-image pixels", prompt)
        self.assertIn("glyph fill as a #RRGGBB color", prompt)
        self.assertIn("reading order", prompt)

    def test_requests_writing_mode_independently_from_rotation(self):
        prompt = build_ocr_prompt(1085, 1449)

        self.assertIn("writingMode", prompt)
        self.assertIn("horizontal or vertical", prompt)
        self.assertIn("rotation=90 does not imply vertical writing", prompt)


class OpenShopOcrWritingModeTests(unittest.TestCase):
    def normalize(self, *blocks):
        return normalize_ocr_layout(
            json.dumps({"blocks": list(blocks)}),
            1000,
            1000,
        )

    def block(self, *, quad=None, rotation=0, **values):
        return {
            "text": "OCR text",
            "quad": quad
            or [
                {"x": 0.1, "y": 0.1},
                {"x": 0.4, "y": 0.1},
                {"x": 0.4, "y": 0.2},
                {"x": 0.1, "y": 0.2},
            ],
            "confidence": 0.95,
            "rotation": rotation,
            **values,
        }

    def test_normalizes_explicit_horizontal_and_vertical_aliases(self):
        cases = {
            "horizontal": "horizontal",
            "horizontal-tb": "horizontal",
            "vertical": "vertical",
            "vertical-rl": "vertical",
            "vertical-lr": "vertical",
        }

        result = self.normalize(
            *(self.block(writingMode=value) for value in cases)
        )

        self.assertEqual(
            [block["writingMode"] for block in result["blocks"]],
            list(cases.values()),
        )

    def test_infers_only_missing_or_blank_writing_mode_from_normalized_quad(self):
        tall_quad = [
            {"x": 0.1, "y": 0.1},
            {"x": 0.2, "y": 0.1},
            {"x": 0.2, "y": 0.5},
            {"x": 0.1, "y": 0.5},
        ]
        wide_quad = [
            {"x": 100, "y": 100},
            {"x": 700, "y": 100},
            {"x": 700, "y": 300},
            {"x": 100, "y": 300},
        ]

        result = self.normalize(
            self.block(quad=tall_quad),
            self.block(quad=wide_quad, writingMode="  "),
        )

        self.assertEqual(
            [block["writingMode"] for block in result["blocks"]],
            ["vertical", "horizontal"],
        )

    def test_explicit_invalid_writing_mode_falls_back_to_horizontal(self):
        tall_quad = [
            {"x": 0.1, "y": 0.1},
            {"x": 0.2, "y": 0.1},
            {"x": 0.2, "y": 0.8},
            {"x": 0.1, "y": 0.8},
        ]

        block = self.normalize(
            self.block(quad=tall_quad, writingMode="diagonal")
        )["blocks"][0]

        self.assertEqual(block["writingMode"], "horizontal")

    def test_rotation_90_does_not_override_explicit_horizontal_writing_mode(self):
        result = self.normalize(
            self.block(writingMode="horizontal", rotation=90)
        )
        block = result["blocks"][0]

        self.assertEqual(block["writingMode"], "horizontal")
        self.assertEqual(block["rotation"], 90)

    def test_emits_schema_version_3_and_writing_mode_for_every_block(self):
        result = self.normalize(self.block())

        self.assertEqual(result["schemaVersion"], 3)
        self.assertEqual(result["blocks"][0]["writingMode"], "horizontal")

    def test_preserves_ocr_text_whitespace_and_line_order(self):
        raw_text = " 甲乙 \n丙 "

        block = self.normalize(
            self.block(text=raw_text, writingMode="vertical")
        )["blocks"][0]

        self.assertEqual(block["text"], raw_text)

    def test_normalizes_ocr_crlf_and_removes_non_printable_controls(self):
        block = self.normalize(
            self.block(text=" A\r\nB\t\x00\x07 ")
        )["blocks"][0]

        self.assertEqual(block["text"], " A\nB\t ")


if __name__ == "__main__":
    unittest.main()
