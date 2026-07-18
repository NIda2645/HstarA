import os
import unittest
import sys
from types import SimpleNamespace
from unittest.mock import patch


class OpenShopFontCatalogTests(unittest.TestCase):
    @staticmethod
    def _fake_registry(machine_entries, user_entries=None):
        local_machine = object()
        current_user = object()

        class RegistryKey:
            def __init__(self, entries):
                self.entries = entries

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

        def open_key(hive, _path):
            if hive is current_user and user_entries is None:
                raise OSError("missing user font key")
            entries = machine_entries if hive is local_machine else user_entries
            return RegistryKey(entries)

        return SimpleNamespace(
            HKEY_LOCAL_MACHINE=local_machine,
            HKEY_CURRENT_USER=current_user,
            OpenKey=open_key,
            QueryInfoKey=lambda key: (0, len(key.entries), 0),
            EnumValue=lambda key, index: key.entries[index],
        )

    def test_emits_authoritative_language_and_free_commercial_metadata(self):
        from openshop_fonts import OpenShopFontCatalog

        catalog = OpenShopFontCatalog(
            enumerator=lambda: [
                {"family": "思源黑体", "weight": 400, "italic": False},
                {"family": "Example Sans", "weight": 400, "italic": False},
                {"family": "01免霞鹜文楷", "weight": 400, "italic": False},
                {"family": "02免源云明体", "weight": 400, "italic": False},
                {"family": "03免Libre Baskerville", "weight": 400, "italic": False},
            ],
            platform="win32",
        )

        fonts = {item["family"]: item for item in catalog.get_catalog()["fonts"]}

        self.assertEqual(fonts["思源黑体"]["languageGroup"], "zh-hans")
        self.assertEqual(fonts["思源黑体"]["freeCommercialCategory"], "")
        self.assertEqual(fonts["思源黑体"]["sortName"], "思源黑体")
        self.assertEqual(fonts["Example Sans"]["languageGroup"], "en")
        self.assertEqual(fonts["Example Sans"]["freeCommercialCategory"], "")
        self.assertEqual(fonts["Example Sans"]["sortName"], "Example Sans")
        self.assertEqual(fonts["01免霞鹜文楷"]["languageGroup"], "zh-hans")
        self.assertEqual(fonts["01免霞鹜文楷"]["freeCommercialCategory"], "01")
        self.assertEqual(fonts["02免源云明体"]["languageGroup"], "zh-hant")
        self.assertEqual(fonts["02免源云明体"]["freeCommercialCategory"], "02")
        self.assertEqual(fonts["03免Libre Baskerville"]["languageGroup"], "en")
        self.assertEqual(fonts["03免Libre Baskerville"]["freeCommercialCategory"], "03")
        self.assertEqual(fonts["03免Libre Baskerville"]["sortName"], "Libre Baskerville")
        self.assertEqual(fonts["03免Libre Baskerville"]["family"], "03免Libre Baskerville")
        self.assertEqual(fonts["03免Libre Baskerville"]["label"], "03免Libre Baskerville")

    def test_classifies_known_windows_simplified_chinese_families_as_zh_hans(self):
        from openshop_fonts import OpenShopFontCatalog, _font_metadata

        simplified_families = (
            "Microsoft YaHei UI",
            "Microsoft YaHei",
            "SimSun",
            "NSimSun",
            "SimSun-ExtB",
            "SimHei",
            "KaiTi",
            "FangSong",
            "DengXian",
            "YouYuan",
        )
        non_chinese_families = ("Example Sans", "Meiryo", "Malgun Gothic")
        catalog = OpenShopFontCatalog(
            enumerator=lambda: [
                {"family": family, "weight": 400, "italic": False}
                for family in (*simplified_families, *non_chinese_families)
            ],
            platform="win32",
        )

        fonts = {item["family"]: item for item in catalog.get_catalog()["fonts"]}

        for family in simplified_families:
            with self.subTest(family=family):
                self.assertEqual(fonts[family]["languageGroup"], "zh-hans")
                self.assertEqual(fonts[family]["freeCommercialCategory"], "")
                self.assertEqual(fonts[family]["family"], family)
                self.assertEqual(fonts[family]["label"], family)
        for family in non_chinese_families:
            with self.subTest(non_chinese_family=family):
                self.assertEqual(fonts[family]["languageGroup"], "en")
        self.assertEqual(
            _font_metadata("mIcRoSoFt yAhEi Ui")["languageGroup"],
            "zh-hans",
        )

    def test_classifies_known_windows_traditional_chinese_families_as_zh_hant(self):
        from openshop_fonts import OpenShopFontCatalog, _font_metadata

        traditional_families = (
            "Microsoft JhengHei UI",
            "Microsoft JhengHei",
            "MingLiU",
            "PMingLiU",
            "MingLiU-ExtB",
            "PMingLiU-ExtB",
            "DFKai-SB",
        )
        catalog = OpenShopFontCatalog(
            enumerator=lambda: [
                {"family": family, "weight": 400, "italic": False}
                for family in traditional_families
            ],
            platform="win32",
        )

        fonts = {item["family"]: item for item in catalog.get_catalog()["fonts"]}

        for family in traditional_families:
            with self.subTest(family=family):
                self.assertEqual(fonts[family]["languageGroup"], "zh-hant")
                self.assertEqual(fonts[family]["freeCommercialCategory"], "")
                self.assertEqual(fonts[family]["family"], family)
                self.assertEqual(fonts[family]["label"], family)
        self.assertEqual(
            _font_metadata("mIcRoSoFt jHeNgHeI Ui")["languageGroup"],
            "zh-hant",
        )

    def test_collapses_installer_aliases_without_inventing_removed_family_aliases(self):
        from openshop_fonts import OpenShopFontCatalog

        catalog = OpenShopFontCatalog(
            enumerator=lambda: [
                {"family": "01免Example Sans", "weight": 400, "italic": False},
                {
                    "family": "01免Example Sans Regular [123]",
                    "weight": 400,
                    "italic": False,
                },
                {
                    "family": "01免Example Sans Bold [other-12]",
                    "weight": 700,
                    "italic": False,
                },
                {"family": "阿里巴巴普惠体 3.0", "weight": 400, "italic": False},
            ],
            platform="win32",
        )

        fonts = {item["family"]: item for item in catalog.get_catalog()["fonts"]}

        self.assertEqual(set(fonts), {"01免Example Sans", "阿里巴巴普惠体 3.0"})
        self.assertEqual(
            [
                (style["family"], style["weight"], style["label"])
                for style in fonts["01免Example Sans"]["styles"]
            ],
            [
                ("01免Example Sans Regular", 400, "Regular"),
                ("01免Example Sans Bold", 700, "Bold"),
            ],
        )
        self.assertTrue(
            all(
                "01免Example Sans" in style["localNames"]
                for style in fonts["01免Example Sans"]["styles"]
            )
        )
        self.assertNotIn("阿里巴巴普惠体 3", fonts)

    def test_same_style_aliases_are_order_independent_and_keep_all_local_names(self):
        from openshop_fonts import OpenShopFontCatalog

        base_first = [
            {"family": "01免Example Sans", "weight": 400, "italic": False},
            {
                "family": "01免Example Sans Regular [123]",
                "weight": 400,
                "italic": False,
            },
            {"family": "01免Example Sans", "weight": 700, "italic": False},
            {
                "family": "01免Example Sans Bold [other-12]",
                "weight": 700,
                "italic": False,
            },
        ]

        def normalized(faces):
            return OpenShopFontCatalog(
                enumerator=lambda: faces,
                platform="win32",
            ).get_catalog()["fonts"]

        base_first_fonts = normalized(base_first)
        explicit_first_fonts = normalized(list(reversed(base_first)))

        self.assertEqual(base_first_fonts, explicit_first_fonts)
        self.assertEqual(
            [
                (
                    style["label"],
                    style["family"],
                    style["id"],
                    style["localNames"],
                )
                for style in base_first_fonts[0]["styles"]
            ],
            [
                (
                    "Regular",
                    "01免Example Sans Regular",
                    "01免example-sans-regular-400-normal",
                    ["01免Example Sans Regular", "01免Example Sans"],
                ),
                (
                    "Bold",
                    "01免Example Sans Bold",
                    "01免example-sans-bold-700-normal",
                    ["01免Example Sans Bold", "01免Example Sans"],
                ),
            ],
        )

    def test_canonicalizes_confirmed_alibaba_3_alias_to_3_0(self):
        from openshop_fonts import OpenShopFontCatalog

        catalog = OpenShopFontCatalog(
            enumerator=lambda: [
                {"family": "阿里巴巴普惠体 3 Thin", "weight": 100, "italic": False},
                {"family": "阿里巴巴普惠体 3.0 Light", "weight": 300, "italic": False},
                {"family": "阿里巴巴普惠体 3 Regular", "weight": 400, "italic": False},
                {"family": "阿里巴巴普惠体 3.0 Medium", "weight": 500, "italic": False},
                {"family": "阿里巴巴普惠体 3 SemiBold", "weight": 600, "italic": False},
                {"family": "阿里巴巴普惠体 3.0 ExtraBold", "weight": 800, "italic": False},
                {"family": "阿里巴巴普惠体 3 Heavy", "weight": 900, "italic": False},
                {"family": "阿里巴巴普惠体 3.0 Black", "weight": 900, "italic": False},
            ],
            platform="win32",
        )

        fonts = catalog.get_catalog()["fonts"]

        self.assertEqual([font["family"] for font in fonts], ["阿里巴巴普惠体 3.0"])
        self.assertEqual(
            [
                (style["family"], style["weight"], style["label"])
                for style in fonts[0]["styles"]
            ],
            [
                ("阿里巴巴普惠体 3 Thin", 100, "Thin"),
                ("阿里巴巴普惠体 3.0 Light", 300, "Light"),
                ("阿里巴巴普惠体 3 Regular", 400, "Regular"),
                ("阿里巴巴普惠体 3.0 Medium", 500, "Medium"),
                ("阿里巴巴普惠体 3 SemiBold", 600, "Semibold"),
                ("阿里巴巴普惠体 3.0 ExtraBold", 800, "Extrabold"),
                ("阿里巴巴普惠体 3.0 Black", 900, "Black"),
                ("阿里巴巴普惠体 3 Heavy", 900, "Heavy"),
            ],
        )

    def test_legacy_only_alibaba_3_keeps_legacy_display_family(self):
        from openshop_fonts import OpenShopFontCatalog

        catalog = OpenShopFontCatalog(
            enumerator=lambda: [
                {"family": "阿里巴巴普惠体 3", "weight": 400, "italic": False},
                {"family": "阿里巴巴普惠体 3 Regular", "weight": 400, "italic": False},
            ],
            platform="win32",
        )

        fonts = catalog.get_catalog()["fonts"]

        self.assertEqual([font["family"] for font in fonts], ["阿里巴巴普惠体 3"])
        self.assertEqual(fonts[0]["styles"][0]["family"], "阿里巴巴普惠体 3 Regular")
        self.assertEqual(
            fonts[0]["styles"][0]["localNames"],
            ["阿里巴巴普惠体 3 Regular", "阿里巴巴普惠体 3"],
        )
        self.assertNotEqual(fonts[0]["family"], "阿里巴巴普惠体 3.0")

    def test_canonicalizes_alibaba_numbered_l3_faces_and_preserves_local_names(self):
        from openshop_fonts import OpenShopFontCatalog

        legacy_l3 = "阿里巴巴普惠体 3 55 Regular L3"
        canonical_l3 = "阿里巴巴普惠体 3.0 55 Regular L3"
        catalog = OpenShopFontCatalog(
            enumerator=lambda: [
                {"family": "阿里巴巴普惠体 3 Regular", "weight": 400, "italic": False},
                {"family": "阿里巴巴普惠体 3.0 Regular", "weight": 400, "italic": False},
                {"family": legacy_l3, "weight": 400, "italic": False},
                {"family": canonical_l3, "weight": 400, "italic": False},
            ],
            platform="win32",
        )

        fonts = catalog.get_catalog()["fonts"]

        self.assertEqual([font["family"] for font in fonts], ["阿里巴巴普惠体 3.0"])
        l3_style = next(
            style for style in fonts[0]["styles"] if style["label"] == "55 Regular L3"
        )
        self.assertEqual(l3_style["family"], canonical_l3)
        self.assertEqual(l3_style["weight"], 400)
        self.assertEqual(
            set(l3_style["localNames"]),
            {legacy_l3, "阿里巴巴普惠体 3", canonical_l3, "阿里巴巴普惠体 3.0"},
        )

    def test_does_not_strip_numbered_l3_suffix_from_unrelated_fonts(self):
        from openshop_fonts import OpenShopFontCatalog

        catalog = OpenShopFontCatalog(
            enumerator=lambda: [
                {"family": "Example Sans", "weight": 400, "italic": False},
                {"family": "Example Sans 55 Regular L3", "weight": 400, "italic": False},
            ],
            platform="win32",
        )

        families = [font["family"] for font in catalog.get_catalog()["fonts"]]

        self.assertEqual(families, ["Example Sans", "Example Sans 55 Regular L3"])

    def test_does_not_generically_merge_versioned_family_names(self):
        from openshop_fonts import OpenShopFontCatalog

        catalog = OpenShopFontCatalog(
            enumerator=lambda: [
                {"family": "Example Sans 3", "weight": 400, "italic": False},
                {"family": "Example Sans 3.0", "weight": 400, "italic": False},
            ],
            platform="win32",
        )

        families = [font["family"] for font in catalog.get_catalog()["fonts"]]

        self.assertEqual(families, ["Example Sans 3", "Example Sans 3.0"])

    def test_groups_separate_light_faces_under_the_base_family(self):
        from openshop_fonts import OpenShopFontCatalog

        catalog = OpenShopFontCatalog(
            enumerator=lambda: [
                {"family": "DengXian", "weight": 400, "italic": False},
                {"family": "DengXian Light", "weight": 300, "italic": False},
                {"family": "DengXian Medium", "weight": 400, "italic": False},
                {"family": "DengXian Italic", "weight": 400, "italic": False},
                {"family": "Microsoft YaHei UI", "weight": 400, "italic": False},
                {"family": "Microsoft YaHei UI Light", "weight": 290, "italic": False},
            ],
            platform="win32",
        )

        fonts = {item["family"]: item for item in catalog.get_catalog()["fonts"]}

        self.assertEqual(set(fonts), {"DengXian", "Microsoft YaHei UI"})
        self.assertEqual(
            [(style["family"], style["weight"], style["label"]) for style in fonts["DengXian"]["styles"]],
            [
                ("DengXian Light", 300, "Light"),
                ("DengXian", 400, "Regular"),
                ("DengXian Italic", 400, "Regular Italic"),
                ("DengXian Medium", 500, "Medium"),
            ],
        )
        self.assertEqual(
            [style["family"] for style in fonts["Microsoft YaHei UI"]["styles"]],
            ["Microsoft YaHei UI Light", "Microsoft YaHei UI"],
        )

    def test_groups_styles_and_filters_vertical_aliases(self):
        from openshop_fonts import OpenShopFontCatalog

        calls = []

        def enumerate_faces():
            calls.append(True)
            return [
                {"family": "Arial", "weight": 400, "italic": False},
                {"family": "Arial", "weight": 700, "italic": False},
                {"family": "Arial", "weight": 700, "italic": True},
                {"family": "Arial", "weight": 700, "italic": True},
                {"family": "@SimSun", "weight": 400, "italic": False},
            ]

        catalog = OpenShopFontCatalog(enumerator=enumerate_faces, platform="win32")
        result = catalog.get_catalog()

        self.assertEqual(result["platform"], "windows")
        self.assertFalse(result["cached"])
        self.assertEqual([item["family"] for item in result["fonts"]], ["Arial"])
        self.assertEqual(
            [
                (item["weight"], item["italic"], item["label"])
                for item in result["fonts"][0]["styles"]
            ],
            [
                (400, False, "Regular"),
                (700, False, "Bold"),
                (700, True, "Bold Italic"),
            ],
        )
        self.assertEqual(len(calls), 1)

        cached = catalog.get_catalog()
        self.assertTrue(cached["cached"])
        self.assertEqual(len(calls), 1)

        refreshed = catalog.get_catalog(refresh=True)
        self.assertFalse(refreshed["cached"])
        self.assertEqual(len(calls), 2)

    def test_preserves_vendor_face_names_inside_one_real_family(self):
        from openshop_fonts import OpenShopFontCatalog

        catalog = OpenShopFontCatalog(
            enumerator=lambda: [
                {"family": "Alibaba PuHuiTi B", "weight": 400, "italic": False},
                {"family": "Alibaba PuHuiTi H", "weight": 400, "italic": False},
                {"family": "阿里巴巴普惠体 2.0 55 Regular", "weight": 400, "italic": False},
                {"family": "阿里巴巴普惠体 2.0 65 Medium", "weight": 400, "italic": False},
            ],
            platform="win32",
        )

        fonts = {item["family"]: item for item in catalog.get_catalog()["fonts"]}

        self.assertEqual(set(fonts), {"Alibaba PuHuiTi", "阿里巴巴普惠体 2.0"})
        self.assertEqual(
            [(style["family"], style["label"]) for style in fonts["Alibaba PuHuiTi"]["styles"]],
            [("Alibaba PuHuiTi B", "B"), ("Alibaba PuHuiTi H", "H")],
        )
        self.assertEqual(
            [
                (style["family"], style["weight"], style["label"])
                for style in fonts["阿里巴巴普惠体 2.0"]["styles"]
            ],
            [
                ("阿里巴巴普惠体 2.0 55 Regular", 400, "55 Regular"),
                ("阿里巴巴普惠体 2.0 65 Medium", 500, "65 Medium"),
            ],
        )

    def test_does_not_strip_an_isolated_style_like_trailing_letter(self):
        from openshop_fonts import OpenShopFontCatalog

        catalog = OpenShopFontCatalog(
            enumerator=lambda: [
                {"family": "DIN A", "weight": 400, "italic": False},
                {"family": "DIN Next", "weight": 400, "italic": False},
            ],
            platform="win32",
        )

        families = [item["family"] for item in catalog.get_catalog()["fonts"]]

        self.assertEqual(families, ["DIN A", "DIN Next"])

    def test_keeps_distinct_vendor_weight_names_even_when_numeric_weights_match(self):
        from openshop_fonts import OpenShopFontCatalog

        catalog = OpenShopFontCatalog(
            enumerator=lambda: [
                {"family": "Alibaba Sans Heavy", "weight": 800, "italic": False},
                {"family": "Alibaba Sans Black", "weight": 900, "italic": False},
            ],
            platform="win32",
        )

        font = catalog.get_catalog()["fonts"][0]

        self.assertEqual(font["family"], "Alibaba Sans")
        self.assertEqual([style["label"] for style in font["styles"]], ["Black", "Heavy"])

    def test_groups_cambria_math_as_a_real_face_of_cambria(self):
        from openshop_fonts import OpenShopFontCatalog

        catalog = OpenShopFontCatalog(
            enumerator=lambda: [
                {"family": "Cambria", "weight": 400, "italic": False},
                {"family": "Cambria Math", "weight": 400, "italic": False},
            ],
            platform="win32",
        )

        fonts = catalog.get_catalog()["fonts"]

        self.assertEqual([font["family"] for font in fonts], ["Cambria"])
        self.assertEqual(
            [(style["family"], style["label"]) for style in fonts[0]["styles"]],
            [("Cambria", "Default"), ("Cambria Math", "Math")],
        )

    def test_splits_registry_collection_names_without_splitting_regular_font_names(self):
        from openshop_fonts import _enumerate_windows_registry_faces

        entries = [
            ("Cambria & Cambria Math (TrueType)", "cambria.ttc", 1),
            ("Rock & Roll (TrueType)", "rock-roll.ttf", 1),
        ]
        fake_winreg = self._fake_registry(entries)

        with patch.dict(sys.modules, {"winreg": fake_winreg}), patch(
            "os.path.isfile", return_value=True
        ):
            faces = _enumerate_windows_registry_faces()

        self.assertEqual(
            [face["family"] for face in faces],
            ["Cambria", "Cambria Math", "Rock & Roll"],
        )

    def test_resolves_registry_font_paths_by_hive(self):
        from openshop_fonts import _enumerate_windows_registry_faces

        machine_entries = [
            ("Absolute Font (TrueType)", r"D:\Fonts\absolute.ttf", 1),
            ("Machine Font (TrueType)", "machine.ttf", 1),
        ]
        user_entries = [("User Font (TrueType)", "user.ttf", 1)]
        fake_winreg = self._fake_registry(machine_entries, user_entries)
        checked_paths = []

        def is_file(path):
            checked_paths.append(path)
            return True

        with patch.dict(sys.modules, {"winreg": fake_winreg}), patch.dict(
            os.environ,
            {"WINDIR": r"C:\WindowsRoot", "LOCALAPPDATA": r"C:\Users\Test\AppData\Local"},
        ), patch("os.path.isfile", side_effect=is_file):
            faces = _enumerate_windows_registry_faces()

        self.assertEqual(
            checked_paths,
            [
                os.path.normpath(r"D:\Fonts\absolute.ttf"),
                os.path.normpath(r"C:\WindowsRoot\Fonts\machine.ttf"),
                os.path.normpath(r"C:\Users\Test\AppData\Local\Microsoft\Windows\Fonts\user.ttf"),
            ],
        )
        self.assertEqual(
            [face["family"] for face in faces],
            ["Absolute Font", "Machine Font", "User Font"],
        )

    def test_hkcu_relative_font_path_requires_local_app_data(self):
        from openshop_fonts import _registry_font_path

        current_user = object()
        fake_winreg = SimpleNamespace(HKEY_CURRENT_USER=current_user)

        for environment in ({}, {"LOCALAPPDATA": ""}):
            with self.subTest(environment=environment), patch.dict(
                os.environ, environment, clear=True
            ):
                self.assertEqual(
                    _registry_font_path(current_user, "user.ttf", fake_winreg),
                    "",
                )

    def test_registry_font_path_expands_environment_and_normalizes_absolute_values(self):
        from openshop_fonts import _registry_font_path

        local_machine = object()
        fake_winreg = SimpleNamespace(
            HKEY_CURRENT_USER=object(),
            HKEY_LOCAL_MACHINE=local_machine,
        )

        with patch.dict(
            os.environ,
            {"OPENSHOP_FONT_ROOT": r"C:\Custom\Fonts"},
            clear=True,
        ):
            resolved = _registry_font_path(
                local_machine,
                r"%OPENSHOP_FONT_ROOT%\nested\..\example.ttf",
                fake_winreg,
            )

        self.assertEqual(resolved, os.path.normpath(r"C:\Custom\Fonts\example.ttf"))

    def test_registry_refresh_excludes_missing_backing_files(self):
        from openshop_fonts import _enumerate_windows_registry_faces

        entries = [
            ("01免Available (TrueType)", r"C:\Fonts\available.ttf", 1),
            ("01免Removed (TrueType)", r"C:\Fonts\removed.ttf", 1),
        ]
        fake_winreg = self._fake_registry(entries)

        with patch.dict(sys.modules, {"winreg": fake_winreg}), patch(
            "os.path.isfile",
            side_effect=lambda path: path.casefold().endswith("available.ttf"),
        ):
            faces = _enumerate_windows_registry_faces()

        self.assertEqual([face["family"] for face in faces], ["01免Available"])

    def test_response_never_exposes_font_paths_or_binary_metadata(self):
        from openshop_fonts import OpenShopFontCatalog

        catalog = OpenShopFontCatalog(
            enumerator=lambda: [
                {
                    "family": "Test Font",
                    "weight": 400,
                    "italic": False,
                    "path": r"C:\Windows\Fonts\test-font.ttf",
                    "binary": b"not-font-data",
                }
            ],
            platform="win32",
        )

        serialized = repr(catalog.get_catalog()).lower()

        self.assertNotIn(".ttf", serialized)
        self.assertNotIn("path", serialized)
        self.assertNotIn("binary", serialized)

    def test_uses_common_fallbacks_off_windows(self):
        from openshop_fonts import OpenShopFontCatalog

        catalog = OpenShopFontCatalog(enumerator=lambda: [], platform="linux")
        result = catalog.get_catalog()
        families = [item["family"] for item in result["fonts"]]

        self.assertEqual(result["platform"], "linux")
        self.assertIn("Microsoft YaHei UI", families)
        self.assertIn("Arial", families)
        self.assertIn("Times New Roman", families)


class OpenShopFontEndpointTests(unittest.TestCase):
    def test_endpoint_forwards_refresh_to_the_process_catalog(self):
        import main

        payload = {"platform": "windows", "cached": False, "fonts": []}
        with patch.object(
            main.OPENSHOP_FONTS,
            "get_catalog",
            return_value=payload,
        ) as getter:
            self.assertEqual(main.get_openshop_fonts(refresh=True), payload)

        getter.assert_called_once_with(refresh=True)


if __name__ == "__main__":
    unittest.main()
