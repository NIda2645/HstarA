import json
import unittest

from openshop_ai import (
    build_art_font_prompt,
    build_ocr_audit_prompt,
    build_ocr_prompt,
    merge_ocr_layouts,
    normalize_ai_task_record,
    normalize_art_font_result,
    normalize_art_font_snapshot,
    normalize_ocr_layout,
)


class OpenShopOcrPromptTests(unittest.TestCase):
    def test_requests_one_quad_and_unicode_style_runs_without_v4_geometry(self):
        prompt = build_ocr_prompt(1085, 1449)

        self.assertIn("one visible text line", prompt)
        self.assertIn("tight visible glyph bounds", prompt)
        self.assertIn("top-left, top-right, bottom-right, bottom-left", prompt)
        self.assertIn("runs", prompt)
        self.assertIn("Unicode code-point indexes", prompt)
        self.assertNotIn("fontMetricQuad", prompt)
        self.assertNotIn("glyphQuads", prompt)
        self.assertNotIn("Punctuation entries are optional", prompt)

    def test_requests_independent_typography_for_every_text_block(self):
        prompt = build_ocr_prompt(1085, 1449)

        self.assertIn("Estimate every run independently", prompt)
        self.assertIn("never reuse one run's typography", prompt)

    def test_requests_writing_mode_independently_from_rotation(self):
        prompt = build_ocr_prompt(1085, 1449)

        self.assertIn("writingMode", prompt)
        self.assertIn("horizontal or vertical", prompt)
        self.assertIn("rotation=90 does not imply vertical writing", prompt)

    def test_requires_an_exhaustive_spatial_inventory_and_omission_audit(self):
        prompt = build_ocr_prompt(1085, 1449)

        self.assertIn("exhaustive whole-image text inventory", prompt)
        self.assertIn("top to bottom", prompt)
        self.assertIn("left to right", prompt)
        self.assertIn("small, low-contrast, isolated", prompt)
        self.assertIn("headings, captions, labels, and numeric text", prompt)
        self.assertIn("final omission audit", prompt)
        self.assertIn("spatial scan order", prompt)

    def test_omission_audit_lists_existing_lines_and_requests_only_missing_blocks(self):
        prompt = build_ocr_audit_prompt(
            451,
            944,
            ["洗护二合一 洁面新理念", "01"],
        )

        self.assertIn("dedicated omission audit", prompt)
        self.assertIn('"洗护二合一 洁面新理念"', prompt)
        self.assertIn("ONLY for visible text lines missing", prompt)
        self.assertIn("Do not repeat listed lines", prompt)
        self.assertIn("nearby larger heading", prompt)


class OpenShopOcrWritingModeTests(unittest.TestCase):
    def normalize(self, *blocks, width=1000, height=1000):
        return normalize_ocr_layout(
            json.dumps({"blocks": list(blocks)}),
            width,
            height,
        )

    def block(self, *, quad=None, rotation=0, **values):
        text = values.get("text", "OCR text")
        return {
            "text": text,
            "quad": quad
            or [
                {"x": 0.1, "y": 0.1},
                {"x": 0.4, "y": 0.1},
                {"x": 0.4, "y": 0.2},
                {"x": 0.1, "y": 0.2},
            ],
            "confidence": 0.95,
            "rotation": rotation,
            "runs": [{"start": 0, "end": len(text), "script": "en"}],
            **values,
        }

    def test_migrates_legacy_block_font_to_a_v5_style_run(self):
        text = "Legacy title"
        record = normalize_ai_task_record({
            "taskId": "legacy-ocr-task",
            "toolId": "text-extract",
            "status": "succeeded",
            "sourceAssetId": "e" * 64,
            "result": {
                "schemaVersion": 2,
                "width": 800,
                "height": 600,
                "blocks": [{
                    "id": "legacy-title",
                    "text": text,
                    "bbox": {"x": 80, "y": 60, "width": 320, "height": 72},
                    "language": "en",
                    "script": "en",
                    "confidence": 0.88,
                    "font": {
                        "familyCandidates": ["Legacy Serif"],
                        "size": 36,
                        "weight": 700,
                        "style": "italic",
                        "letterSpacing": 0,
                    },
                    "color": "#ABCDEF",
                    "align": "right",
                    "rotation": 12,
                }],
            },
        })

        result = record["result"]
        self.assertEqual(result["schemaVersion"], 5)
        self.assertEqual(result["blocks"][0]["runs"], [{
            "start": 0,
            "end": len(text),
            "script": "en",
            "familyCandidates": ["Legacy Serif"],
            "size": 36.0,
            "weight": 700,
            "style": "italic",
            "artistic": False,
            "styleDescription": "",
            "color": "#abcdef",
            "letterSpacing": 0.0,
            "lineHeight": 1.16,
            "strokeColor": "#00000000",
            "strokeWidth": 0.0,
            "shadow": {
                "color": "#00000000",
                "blur": 0.0,
                "offsetX": 0.0,
                "offsetY": 0.0,
            },
        }])

    def test_merges_audit_blocks_in_spatial_order_without_dropping_distant_repeated_text(self):
        primary = self.normalize(self.block(
            text="Label",
            quad=[
                {"x": 0.1, "y": 0.2},
                {"x": 0.3, "y": 0.2},
                {"x": 0.3, "y": 0.25},
                {"x": 0.1, "y": 0.25},
            ],
        ))
        audit = self.normalize(
            self.block(
                text="Missing heading",
                quad=[
                    {"x": 0.1, "y": 0.05},
                    {"x": 0.4, "y": 0.05},
                    {"x": 0.4, "y": 0.1},
                    {"x": 0.1, "y": 0.1},
                ],
            ),
            self.block(
                text="Label",
                quad=[
                    {"x": 0.101, "y": 0.201},
                    {"x": 0.301, "y": 0.201},
                    {"x": 0.301, "y": 0.251},
                    {"x": 0.101, "y": 0.251},
                ],
            ),
            self.block(
                text="Label",
                quad=[
                    {"x": 0.1, "y": 0.8},
                    {"x": 0.3, "y": 0.8},
                    {"x": 0.3, "y": 0.85},
                    {"x": 0.1, "y": 0.85},
                ],
            ),
        )

        merged = merge_ocr_layouts(primary, audit)

        self.assertEqual(
            [block["text"] for block in merged["blocks"]],
            ["Missing heading", "Label", "Label"],
        )
        self.assertEqual(
            [block["id"] for block in merged["blocks"]],
            ["ocr-1", "ocr-2", "ocr-3"],
        )

    def test_allows_an_empty_layout_only_for_the_omission_audit(self):
        with self.assertRaisesRegex(ValueError, "OCR 模型没有返回可靠的文字位置"):
            normalize_ocr_layout('{"blocks":[]}', 1000, 1000)

        result = normalize_ocr_layout(
            '{"blocks":[]}',
            1000,
            1000,
            allow_empty=True,
        )

        self.assertEqual(result["blocks"], [])

    def test_prefers_the_complete_layout_after_a_streamed_placeholder_object(self):
        complete = {"blocks": [self.block(text="专研氨基酸体系")]}
        raw = '{"blocks":[{"text":"…"}]}' + json.dumps(complete, ensure_ascii=False)

        result = normalize_ocr_layout(raw, 1000, 1000)

        self.assertEqual([block["text"] for block in result["blocks"]], ["专研氨基酸体系"])

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

    def test_infers_rotated_90_degree_horizontal_from_local_quad_edges(self):
        rotated_horizontal_quad = [
            {"x": 0.4, "y": 0.2},
            {"x": 0.4, "y": 0.8},
            {"x": 0.3, "y": 0.8},
            {"x": 0.3, "y": 0.2},
        ]

        block = self.normalize(
            self.block(quad=rotated_horizontal_quad, rotation=90)
        )["blocks"][0]

        self.assertEqual(block["writingMode"], "horizontal")
        self.assertEqual(block["rotation"], 90)

    def test_infers_local_pixel_geometry_on_non_square_images(self):
        source_tall_quad = [
            {"x": 0.1, "y": 0.1},
            {"x": 0.3, "y": 0.1},
            {"x": 0.3, "y": 0.3},
            {"x": 0.1, "y": 0.3},
        ]

        block = self.normalize(
            self.block(quad=source_tall_quad),
            width=1000,
            height=2000,
        )["blocks"][0]

        self.assertEqual(block["writingMode"], "vertical")

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

    def test_emits_schema_version_5_with_validated_runs(self):
        text = "Open夏日"
        result = self.normalize(self.block(
            text=text,
            runs=[
                {
                    "start": 0,
                    "end": 4,
                    "script": "en",
                    "familyCandidates": ["Poster"],
                    "size": 48,
                    "weight": 300,
                },
                {
                    "start": 4,
                    "end": 6,
                    "script": "zh-hans",
                    "familyCandidates": ["普惠体"],
                    "size": 52,
                    "weight": 700,
                },
            ],
        ))

        self.assertEqual(result["schemaVersion"], 5)
        self.assertEqual(result["blocks"][0]["writingMode"], "horizontal")
        self.assertEqual(result["blocks"][0]["runs"][0]["size"], 48)
        self.assertEqual(result["blocks"][0]["runs"][0]["weight"], 300)
        self.assertEqual(result["blocks"][0]["runs"][1]["size"], 52)
        self.assertEqual(result["blocks"][0]["runs"][1]["weight"], 700)

    def test_normalizes_or_splits_mixed_runs_into_font_pool_scripts(self):
        chinese = self.normalize(self.block(
            text="\u6e05\u51c9\u81ea\u6765",
            runs=[{"start": 0, "end": 4, "script": "mixed", "weight": 600}],
        ))["blocks"][0]["runs"]
        mixed = self.normalize(self.block(
            text="\u590f\u65e5SALE\uff0c",
            runs=[{"start": 0, "end": 7, "script": "mixed", "weight": 600}],
        ))["blocks"][0]["runs"]

        self.assertEqual(
            [(run["start"], run["end"], run["script"]) for run in chinese],
            [(0, 4, "zh-hans")],
        )
        self.assertEqual(
            [(run["start"], run["end"], run["script"]) for run in mixed],
            [(0, 2, "zh-hans"), (2, 7, "en")],
        )
        self.assertEqual([run["weight"] for run in mixed], [600, 600])

    def test_rejects_overlapping_or_incomplete_unicode_runs(self):
        valid = self.block(text="OK")
        incomplete = self.block(
            text="ABC",
            runs=[{"start": 0, "end": 2, "script": "en"}],
        )
        overlapping = self.block(
            text="夏日",
            runs=[
                {"start": 0, "end": 2, "script": "zh-hans"},
                {"start": 1, "end": 2, "script": "zh-hans"},
            ],
        )

        result = self.normalize(valid, incomplete, overlapping)

        self.assertEqual([block["text"] for block in result["blocks"]], ["OK"])
        self.assertEqual(
            [warning["code"] for warning in result["warnings"]],
            ["invalid_runs", "invalid_runs"],
        )

    def test_repairs_model_run_ranges_when_explicitly_enabled(self):
        incomplete = self.block(
            text="洗护二合一 洁面新理念",
            runs=[{"start": 0, "end": 11, "script": "zh-hans", "size": 38}],
        )
        mixed = self.block(
            text="超氧化物歧化酶 (SOD)",
            runs=[
                {"start": 0, "end": 7, "script": "zh-hans", "size": 23},
                {"start": 7, "end": 13, "script": "en", "size": 23},
            ],
        )

        result = normalize_ocr_layout(
            json.dumps({"blocks": [incomplete, mixed]}),
            1000,
            1000,
            repair_runs=True,
        )

        self.assertEqual([block["text"] for block in result["blocks"]], [
            incomplete["text"], mixed["text"],
        ])
        self.assertEqual(
            [(run["start"], run["end"]) for run in result["blocks"][0]["runs"]],
            [(0, len(list(incomplete["text"])))],
        )
        self.assertEqual(
            [(run["start"], run["end"]) for run in result["blocks"][1]["runs"]],
            [(0, 7), (7, len(list(mixed["text"])))],
        )

    def test_uses_unicode_code_point_indexes_for_astral_characters(self):
        text = "A😀夏"
        block = self.normalize(self.block(
            text=text,
            runs=[
                {"start": 0, "end": 2, "script": "en"},
                {"start": 2, "end": 3, "script": "zh-hans"},
            ],
        ))["blocks"][0]

        self.assertEqual(
            [(run["start"], run["end"]) for run in block["runs"]],
            [(0, 2), (2, 3)],
        )

    def test_preserves_ocr_text_whitespace_and_line_order(self):
        raw_text = " 甲乙 \n丙 "

        block = self.normalize(
            self.block(text=raw_text, writingMode="vertical")
        )["blocks"][0]

        self.assertEqual(block["text"], raw_text)

    def test_normalizes_ocr_crlf_and_removes_non_printable_controls(self):
        block = self.normalize(
            self.block(
                text=" A\r\nB\t\x00\x07 ",
                runs=[{"start": 0, "end": 6, "script": "en"}],
            )
        )["blocks"][0]

        self.assertEqual(block["text"], " A\nB\t ")

    def test_drops_legacy_geometry_fields_from_v5_blocks(self):
        block = self.normalize(self.block(
            fontMetricQuad=[
                {"x": 0.1, "y": 0.1},
                {"x": 0.2, "y": 0.1},
                {"x": 0.2, "y": 0.2},
                {"x": 0.1, "y": 0.2},
            ],
            glyphQuads=[],
        ))["blocks"][0]

        self.assertNotIn("fontMetricQuad", block)
        self.assertNotIn("glyphQuads", block)


class OpenShopArtFontWritingModeTests(unittest.TestCase):
    def snapshot(self, writing_mode):
        return {
            "textLayerId": "text-layer-1",
            "ocrBlockId": "ocr-1",
            "originalText": "原文",
            "currentText": "甲乙\n丙丁",
            "requestGeneration": 1,
            "document": {"width": 1000, "height": 800},
            "quad": [
                {"x": 0.1, "y": 0.1},
                {"x": 0.3, "y": 0.1},
                {"x": 0.3, "y": 0.7},
                {"x": 0.1, "y": 0.7},
            ],
            "visualProfile": {
                "writingMode": writing_mode,
                "script": "zh-hans",
                "fill": "#112233",
                "rotation": 90,
                "weight": 700,
            },
        }

    def test_preserves_vertical_writing_mode_in_normalized_profile(self):
        snapshot = normalize_art_font_snapshot(self.snapshot("vertical-rl"))

        self.assertEqual(snapshot["visualProfile"]["writingMode"], "vertical")
        self.assertEqual(snapshot["visualProfile"]["rotation"], 90)

    def test_invalid_art_font_writing_mode_falls_back_to_horizontal(self):
        snapshot = normalize_art_font_snapshot(self.snapshot("diagonal"))

        self.assertEqual(snapshot["visualProfile"]["writingMode"], "horizontal")

    def test_art_font_prompt_keeps_writing_direction_independent_from_rotation(self):
        snapshot = normalize_art_font_snapshot(self.snapshot("vertical"))

        prompt = build_art_font_prompt(snapshot)

        self.assertIn("writing direction vertical", prompt)
        self.assertIn("independent from rotation", prompt)
        self.assertIn("angle 90.0", prompt)

    def test_art_font_prompt_requires_local_patch_editing_without_color_halo(self):
        snapshot = normalize_art_font_snapshot(self.snapshot("vertical"))

        prompt = build_art_font_prompt(snapshot)

        self.assertIn("first supplied image is the source patch", prompt)
        self.assertIn("second supplied image is the inverse-alpha edit mask", prompt)
        self.assertIn("transparent mask region", prompt)
        self.assertIn("protected mask region", prompt)
        self.assertIn("same pixel dimensions", prompt)
        self.assertIn("no glow, halo, aura, color wash", prompt)
        self.assertNotIn("alpha must be zero outside the glyph contours", prompt)

    def test_art_font_prompt_renders_edited_text_and_uses_original_only_for_style(self):
        value = self.snapshot("vertical")
        value["originalText"] = "小暑"
        value["currentText"] = "大树"
        snapshot = normalize_art_font_snapshot(value)

        prompt = build_art_font_prompt(snapshot)

        self.assertIn('Render exactly this edited text once: "大树"', prompt)
        self.assertNotIn("小暑", prompt)
        self.assertIn("reference text content is style-only", prompt)
        self.assertIn("never copy or restore its original characters", prompt)

    def test_normalizes_native_patch_placement_instead_of_transparent_content_box(self):
        result = normalize_art_font_result({
            "assetId": "a" * 64,
            "url": "/api/openshop/assets/" + "a" * 64,
            "name": "art-font-patch.png",
            "mime": "image/png",
            "width": 320,
            "height": 128,
            "placementBox": {"x": 140, "y": 90, "width": 320, "height": 128},
        })

        self.assertEqual(
            result["placementBox"],
            {"x": 140, "y": 90, "width": 320, "height": 128},
        )
        self.assertNotIn("contentBox", result)

    def test_migrates_legacy_applied_art_font_content_box_before_save(self):
        value = {
            "taskId": "openshop_ai_legacy_art_font",
            "toolId": "art-font-restore",
            "status": "succeeded",
            "sourceLayerId": "text-layer-1",
            "sourceAssetId": "b" * 64,
            "outputAssetId": "a" * 64,
            "createdAt": 1000,
            "updatedAt": 2000,
            "completedAt": 2000,
            "appliedAt": 2100,
            "reconcileState": "applied",
            "generatedLayerId": "generated-layer-1",
            "snapshot": self.snapshot("horizontal"),
            "result": {
                "assetId": "a" * 64,
                "url": "/api/openshop/assets/" + "a" * 64,
                "name": "legacy-art-font.png",
                "mime": "image/png",
                "width": 605,
                "height": 1051,
                "contentBox": {"x": 66, "y": 0, "width": 472, "height": 1051},
            },
            "context": {
                "canvasType": "classic",
                "canvasId": "canvas-1",
                "nodeId": "node-1",
                "projectId": "project-1",
            },
            "owner": {
                "canvasType": "classic",
                "canvasId": "canvas-1",
                "nodeId": "node-1",
            },
        }

        record = normalize_ai_task_record(value)

        self.assertEqual(
            record["result"]["placementBox"],
            {"x": 0, "y": 0, "width": 605, "height": 1051},
        )
        self.assertNotIn("contentBox", record["result"])


if __name__ == "__main__":
    unittest.main()
