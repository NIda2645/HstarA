import unittest

from openshop_ai import build_ocr_prompt


class OpenShopOcrPromptTests(unittest.TestCase):
    def test_requests_independent_tightly_positioned_style_aware_text_blocks(self):
        prompt = build_ocr_prompt(1085, 1449)

        self.assertIn("one block per visually distinct text line", prompt)
        self.assertIn("tight visible glyph bounds", prompt)
        self.assertIn("font.size in source-image pixels", prompt)
        self.assertIn("glyph fill as a #RRGGBB color", prompt)
        self.assertIn("reading order", prompt)


if __name__ == "__main__":
    unittest.main()
