import copy
import ctypes
import re
import sys
from ctypes import wintypes
from threading import Lock


COMMON_FONTS = (
    "Microsoft YaHei UI",
    "Microsoft YaHei",
    "SimSun",
    "SimHei",
    "KaiTi",
    "FangSong",
    "Arial",
    "Georgia",
    "Verdana",
    "Times New Roman",
    "Courier New",
    "Consolas",
    "Impact",
)

DEFAULT_CHARSET = 1
LF_FACESIZE = 32


class LOGFONTW(ctypes.Structure):
    _fields_ = [
        ("lfHeight", wintypes.LONG),
        ("lfWidth", wintypes.LONG),
        ("lfEscapement", wintypes.LONG),
        ("lfOrientation", wintypes.LONG),
        ("lfWeight", wintypes.LONG),
        ("lfItalic", wintypes.BYTE),
        ("lfUnderline", wintypes.BYTE),
        ("lfStrikeOut", wintypes.BYTE),
        ("lfCharSet", wintypes.BYTE),
        ("lfOutPrecision", wintypes.BYTE),
        ("lfClipPrecision", wintypes.BYTE),
        ("lfQuality", wintypes.BYTE),
        ("lfPitchAndFamily", wintypes.BYTE),
        ("lfFaceName", wintypes.WCHAR * LF_FACESIZE),
    ]


def _style_label(weight, italic):
    if weight <= 150:
        base = "Thin"
    elif weight <= 250:
        base = "Extra Light"
    elif weight <= 350:
        base = "Light"
    elif weight <= 450:
        base = "Regular"
    elif weight <= 550:
        base = "Medium"
    elif weight <= 650:
        base = "Semibold"
    elif weight <= 750:
        base = "Bold"
    elif weight <= 850:
        base = "Extra Bold"
    else:
        base = "Black"
    return f"{base} Italic" if italic else base


def _style_id(family, weight, italic):
    slug = re.sub(r"\s+", "-", family.casefold()).strip("-") or "font"
    suffix = "italic" if italic else "normal"
    return f"{slug}-{weight}-{suffix}"


STYLE_SUFFIXES = (
    (re.compile(r"(?:\s+|-)(?:thin)$", re.IGNORECASE), 100),
    (re.compile(r"(?:\s+|-)(?:extra\s*light|ultra\s*light)$", re.IGNORECASE), 200),
    (re.compile(r"(?:\s+|-)(?:light)$", re.IGNORECASE), 300),
    (re.compile(r"(?:\s+|-)(?:medium)$", re.IGNORECASE), 500),
    (re.compile(r"(?:\s+|-)(?:semi\s*bold|demi\s*bold)$", re.IGNORECASE), 600),
    (re.compile(r"(?:\s+|-)(?:bold)$", re.IGNORECASE), 700),
    (re.compile(r"(?:\s+|-)(?:extra\s*bold|ultra\s*bold)$", re.IGNORECASE), 800),
    (re.compile(r"(?:\s+|-)(?:black|heavy)$", re.IGNORECASE), 900),
)
ITALIC_SUFFIX = re.compile(r"(?:\s+|-)(?:italic|oblique)$", re.IGNORECASE)
REGULAR_SUFFIX = re.compile(r"(?:\s+|-)(?:regular|normal)$", re.IGNORECASE)
NUMERIC_STYLE_SUFFIX = re.compile(
    r"(?:\s+|-)(?P<number>\d{2,3})\s+"
    r"(?P<style>thin|extra\s*light|ultra\s*light|light|regular|normal|medium|"
    r"semi\s*bold|demi\s*bold|bold|extra\s*bold|ultra\s*bold|black|heavy)$",
    re.IGNORECASE,
)
VENDOR_CODE_SUFFIX = re.compile(r"(?:\s+|-)(?P<style>[A-Z])$", re.IGNORECASE)
SPECIAL_FACE_SUFFIXES = (
    (re.compile(r"(?:\s+|-)Math$", re.IGNORECASE), "Math"),
)
REGISTRY_FORMAT_SUFFIX = re.compile(r"\s*\((?:TrueType|OpenType)\)\s*$", re.IGNORECASE)


def _display_style(value):
    return " ".join(part.capitalize() for part in str(value).split())


def _font_family_for_face(family, weight, italic, allow_vendor_code=False):
    base = ITALIC_SUFFIX.sub("", family).strip()
    if base != family:
        italic = True
    numeric_match = NUMERIC_STYLE_SUFFIX.search(base)
    if numeric_match:
        style_name = numeric_match.group("style")
        style_base = REGULAR_SUFFIX.sub("", f"Font {style_name}").strip()
        implied_weight = 400
        if style_base != f"Font {style_name}":
            implied_weight = 400
        else:
            for pattern, candidate_weight in STYLE_SUFFIXES:
                if pattern.search(f"Font {style_name}"):
                    implied_weight = candidate_weight
                    break
        base = base[: numeric_match.start()].strip(" -")
        style_label = f"{numeric_match.group('number')} {_display_style(style_name)}"
        if italic:
            style_label = f"{style_label} Italic"
        return base or family, implied_weight, italic, style_label
    regular_match = REGULAR_SUFFIX.search(base)
    regular_base = REGULAR_SUFFIX.sub("", base).strip()
    if regular_base != base:
        base = regular_base
        weight = 400
        style_label = _display_style(regular_match.group(0).strip(" -"))
        if italic:
            style_label = f"{style_label} Italic"
        return base or family, weight, italic, style_label
    for pattern, implied_weight in STYLE_SUFFIXES:
        style_match = pattern.search(base)
        candidate = pattern.sub("", base).strip()
        if candidate != base and candidate:
            base = candidate
            weight = implied_weight
            style_label = _display_style(style_match.group(0).strip(" -"))
            if italic:
                style_label = f"{style_label} Italic"
            return base or family, weight, italic, style_label
    for pattern, style_label in SPECIAL_FACE_SUFFIXES:
        candidate = pattern.sub("", base).strip()
        if candidate != base and candidate:
            if italic:
                style_label = f"{style_label} Italic"
            return candidate, weight, italic, style_label
    if allow_vendor_code:
        code_match = VENDOR_CODE_SUFFIX.search(base)
        if code_match:
            base = base[: code_match.start()].strip(" -")
            label = code_match.group("style").upper()
            if italic:
                label = f"{label} Italic"
            return base or family, weight, italic, label
    return base or family, weight, italic, _style_label(weight, italic)


def _normalize_faces(faces):
    vendor_code_groups = {}
    for face in faces:
        family = str(face.get("family") or "").strip()
        match = VENDOR_CODE_SUFFIX.search(family)
        if not match:
            continue
        base = family[: match.start()].strip(" -").casefold()
        vendor_code_groups.setdefault(base, set()).add(match.group("style").upper())
    grouped_vendor_codes = {
        base for base, styles in vendor_code_groups.items() if len(styles) > 1
    }

    grouped = {}
    for face in faces:
        family = str(face.get("family") or "").strip()
        if not family or family.startswith("@"):
            continue
        try:
            weight = max(100, min(900, int(face.get("weight") or 400)))
        except (TypeError, ValueError):
            weight = 400
        italic = bool(face.get("italic"))
        vendor_match = VENDOR_CODE_SUFFIX.search(family)
        vendor_base = family[: vendor_match.start()].strip(" -").casefold() if vendor_match else ""
        group_family, weight, italic, style_label = _font_family_for_face(
            family,
            weight,
            italic,
            allow_vendor_code=vendor_base in grouped_vendor_codes,
        )
        key = group_family.casefold()
        group = grouped.setdefault(key, {"family": group_family, "styles": {}})
        style_key = (style_label.casefold(), italic)
        group["styles"].setdefault(style_key, {
            "id": _style_id(family, weight, italic),
            "family": family,
            "label": style_label,
            "weight": weight,
            "italic": italic,
            "localNames": list(dict.fromkeys([family, group["family"]])),
        })

    fonts = []
    for value in sorted(grouped.values(), key=lambda item: item["family"].casefold()):
        styles = sorted(
            value["styles"].values(),
            key=lambda style: (
                style["weight"],
                style["italic"],
                style["label"].casefold(),
                style["family"].casefold(),
            ),
        )
        if any(style["label"] == "Math" for style in styles):
            for style in styles:
                if (
                    style["family"].casefold() == value["family"].casefold()
                    and style["label"] == "Regular"
                ):
                    style["label"] = "Default"
            styles.sort(key=lambda style: (style["label"] != "Default", style["weight"], style["label"]))
        fonts.append({"family": value["family"], "label": value["family"], "styles": styles})
    return fonts


def _fallback_faces():
    return [
        {"family": family, "weight": 400, "italic": False}
        for family in COMMON_FONTS
    ]


def _enumerate_windows_registry_faces():
    import winreg

    faces = []
    locations = (
        (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Microsoft\Windows NT\CurrentVersion\Fonts"),
        (winreg.HKEY_CURRENT_USER, r"SOFTWARE\Microsoft\Windows NT\CurrentVersion\Fonts"),
    )
    for hive, path in locations:
        try:
            with winreg.OpenKey(hive, path) as key:
                value_count = winreg.QueryInfoKey(key)[1]
                for index in range(value_count):
                    try:
                        display_name, _file_value, _value_type = winreg.EnumValue(key, index)
                    except OSError:
                        continue
                    family = REGISTRY_FORMAT_SUFFIX.sub("", str(display_name)).strip()
                    if family:
                        faces.append({"family": family, "weight": 400, "italic": False})
        except OSError:
            continue
    return faces


def _enumerate_windows_faces():
    faces = []
    user32 = ctypes.windll.user32
    gdi32 = ctypes.windll.gdi32
    callback_type = ctypes.WINFUNCTYPE(
        ctypes.c_int,
        ctypes.POINTER(LOGFONTW),
        ctypes.c_void_p,
        wintypes.DWORD,
        ctypes.c_ssize_t,
    )

    @callback_type
    def collect(logfont_pointer, _metric, _font_type, _parameter):
        logfont = logfont_pointer.contents
        faces.append(
            {
                "family": str(logfont.lfFaceName),
                "weight": int(logfont.lfWeight or 400),
                "italic": bool(logfont.lfItalic),
            }
        )
        return 1

    user32.GetDC.argtypes = [wintypes.HWND]
    user32.GetDC.restype = wintypes.HDC
    user32.ReleaseDC.argtypes = [wintypes.HWND, wintypes.HDC]
    user32.ReleaseDC.restype = ctypes.c_int
    gdi32.EnumFontFamiliesExW.argtypes = [
        wintypes.HDC,
        ctypes.POINTER(LOGFONTW),
        callback_type,
        ctypes.c_ssize_t,
        wintypes.DWORD,
    ]
    gdi32.EnumFontFamiliesExW.restype = ctypes.c_int

    device_context = user32.GetDC(None)
    if not device_context:
        raise OSError("Unable to acquire the Windows screen device context")
    try:
        query = LOGFONTW()
        query.lfCharSet = DEFAULT_CHARSET
        gdi32.EnumFontFamiliesExW(device_context, ctypes.byref(query), collect, 0, 0)
    finally:
        user32.ReleaseDC(None, device_context)
    try:
        registry_faces = _enumerate_windows_registry_faces()
    except Exception:
        registry_faces = []
    known = {str(face.get("family") or "").casefold() for face in faces}
    for face in registry_faces:
        if face["family"].casefold() not in known:
            faces.append(face)
            known.add(face["family"].casefold())
    return faces or _fallback_faces()


class OpenShopFontCatalog:
    def __init__(self, enumerator=None, platform=None):
        self._platform = platform or sys.platform
        self._enumerator = enumerator or _enumerate_windows_faces
        self._lock = Lock()
        self._fonts = None

    def get_catalog(self, refresh=False):
        with self._lock:
            cached = self._fonts is not None and not refresh
            if not cached:
                if self._platform == "win32":
                    try:
                        faces = self._enumerator()
                    except Exception:
                        faces = _fallback_faces()
                else:
                    faces = _fallback_faces()
                self._fonts = _normalize_faces(faces)
            return {
                "platform": "windows" if self._platform == "win32" else self._platform,
                "cached": cached,
                "fonts": copy.deepcopy(self._fonts),
            }
