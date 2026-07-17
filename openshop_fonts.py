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
    (re.compile(r"\s+(?:thin)$", re.IGNORECASE), 100),
    (re.compile(r"\s+(?:extra\s*light|ultra\s*light)$", re.IGNORECASE), 200),
    (re.compile(r"\s+(?:light)$", re.IGNORECASE), 300),
    (re.compile(r"\s+(?:medium)$", re.IGNORECASE), 500),
    (re.compile(r"\s+(?:semi\s*bold|demi\s*bold)$", re.IGNORECASE), 600),
    (re.compile(r"\s+(?:bold)$", re.IGNORECASE), 700),
    (re.compile(r"\s+(?:extra\s*bold|ultra\s*bold)$", re.IGNORECASE), 800),
    (re.compile(r"\s+(?:black|heavy)$", re.IGNORECASE), 900),
)
ITALIC_SUFFIX = re.compile(r"\s+(?:italic|oblique)$", re.IGNORECASE)
REGULAR_SUFFIX = re.compile(r"\s+(?:regular|normal)$", re.IGNORECASE)


def _font_family_for_face(family, weight, italic):
    base = ITALIC_SUFFIX.sub("", family).strip()
    if base != family:
        italic = True
    regular_base = REGULAR_SUFFIX.sub("", base).strip()
    if regular_base != base:
        base = regular_base
        weight = 400
    for pattern, implied_weight in STYLE_SUFFIXES:
        candidate = pattern.sub("", base).strip()
        if candidate != base and candidate:
            base = candidate
            weight = implied_weight
            break
    return base or family, weight, italic


def _normalize_faces(faces):
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
        group_family, weight, italic = _font_family_for_face(family, weight, italic)
        key = group_family.casefold()
        group = grouped.setdefault(key, {"family": group_family, "styles": {}})
        group["styles"][(weight, italic)] = {
            "id": _style_id(group["family"], weight, italic),
            "family": family,
            "label": _style_label(weight, italic),
            "weight": weight,
            "italic": italic,
            "localNames": list(dict.fromkeys([family, group["family"]])),
        }

    return [
        {
            "family": value["family"],
            "label": value["family"],
            "styles": [value["styles"][style] for style in sorted(value["styles"])],
        }
        for value in sorted(grouped.values(), key=lambda item: item["family"].casefold())
    ]


def _fallback_faces():
    return [
        {"family": family, "weight": 400, "italic": False}
        for family in COMMON_FONTS
    ]


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
