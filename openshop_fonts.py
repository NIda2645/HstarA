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
    elif weight <= 350:
        base = "Light"
    elif weight <= 550:
        base = "Regular"
    elif weight <= 650:
        base = "Semibold"
    elif weight <= 800:
        base = "Bold"
    else:
        base = "Black"
    return f"{base} Italic" if italic else base


def _style_id(family, weight, italic):
    slug = re.sub(r"\s+", "-", family.casefold()).strip("-") or "font"
    suffix = "italic" if italic else "normal"
    return f"{slug}-{weight}-{suffix}"


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
        key = family.casefold()
        group = grouped.setdefault(key, {"family": family, "styles": {}})
        group["styles"][(weight, italic)] = {
            "id": _style_id(group["family"], weight, italic),
            "label": _style_label(weight, italic),
            "weight": weight,
            "italic": italic,
            "localNames": [group["family"]],
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
