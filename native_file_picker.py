import mimetypes
import os
import subprocess
from threading import Lock
from typing import Any, Callable, Dict


IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"}
PSD_EXTENSIONS = {".psd"}
MAX_BYTES = {
    "image": 100 * 1024 * 1024,
    "psd": 256 * 1024 * 1024,
}
PICKER_LOCK = Lock()


class NativeFilePickerError(Exception):
    def __init__(self, status_code: int, detail: str):
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


def normalize_kind(value: Any) -> str:
    kind = str(value or "").strip().lower()
    if kind not in MAX_BYTES:
        raise NativeFilePickerError(400, "Unsupported local file type")
    return kind


def validate_selected_file(path: str, kind: str) -> str:
    normalized_kind = normalize_kind(kind)
    selected = os.path.abspath(
        os.path.expanduser(os.path.expandvars(str(path or "").strip().strip('"')))
    )
    if not selected or not os.path.isfile(selected):
        raise NativeFilePickerError(404, "Selected local file was not found")
    extension = os.path.splitext(selected)[1].lower()
    allowed = IMAGE_EXTENSIONS if normalized_kind == "image" else PSD_EXTENSIONS
    if extension not in allowed:
        raise NativeFilePickerError(400, "Selected local file type is not allowed")
    size = os.path.getsize(selected)
    if size > MAX_BYTES[normalized_kind]:
        label = "Image" if normalized_kind == "image" else "PSD"
        limit_mb = MAX_BYTES[normalized_kind] // (1024 * 1024)
        raise NativeFilePickerError(413, f"{label} exceeds {limit_mb} MB import limit")
    return selected


def selected_file_metadata(path: str, kind: str) -> Dict[str, Any]:
    normalized_kind = normalize_kind(kind)
    selected = validate_selected_file(path, normalized_kind)
    mime = (
        "image/vnd.adobe.photoshop"
        if normalized_kind == "psd"
        else mimetypes.guess_type(selected)[0] or "application/octet-stream"
    )
    return {
        "path": selected,
        "name": os.path.basename(selected),
        "size": os.path.getsize(selected),
        "mime": mime,
    }


def picker_script(kind: str) -> str:
    normalized_kind = normalize_kind(kind)
    if normalized_kind == "image":
        title = "HstarA - Open image"
        file_filter = (
            "Image Files (*.png;*.jpg;*.jpeg;*.webp;*.gif;*.bmp)|"
            "*.png;*.jpg;*.jpeg;*.webp;*.gif;*.bmp"
        )
    else:
        title = "HstarA - Open PSD"
        file_filter = "PSD Files (*.psd)|*.psd"
    return f"""
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$owner = New-Object System.Windows.Forms.Form
$owner.Text = 'HstarA'
$owner.StartPosition = 'CenterScreen'
$owner.Size = New-Object System.Drawing.Size(1, 1)
$owner.FormBorderStyle = 'None'
$owner.Opacity = 0
$owner.ShowInTaskbar = $true
$owner.TopMost = $true
$owner.Show()
$owner.Activate()
$owner.BringToFront()
$dialog = New-Object System.Windows.Forms.OpenFileDialog
$dialog.Title = '{title}'
$dialog.Filter = '{file_filter}'
$dialog.CheckFileExists = $true
$dialog.Multiselect = $false
$dialog.RestoreDirectory = $true
try {{
  $result = $dialog.ShowDialog($owner)
  if ($result -eq [System.Windows.Forms.DialogResult]::OK) {{ Write-Output $dialog.FileName }}
}} finally {{
  $dialog.Dispose()
  $owner.Close()
  $owner.Dispose()
}}
"""


def choose_open_file_path(
    kind: str,
    runner: Callable[..., Any] = subprocess.run,
    platform: str = None,
) -> str:
    normalized_kind = normalize_kind(kind)
    current_platform = os.name if platform is None else platform
    if current_platform != "nt":
        raise NativeFilePickerError(501, "Native local file picker is supported on Windows only")
    command = ["powershell", "-NoProfile", "-STA", "-Command", picker_script(normalized_kind)]
    try:
        with PICKER_LOCK:
            completed = runner(
                command,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="ignore",
                timeout=300,
            )
    except subprocess.TimeoutExpired as exc:
        raise NativeFilePickerError(504, "Native local file picker timed out") from exc
    except OSError as exc:
        raise NativeFilePickerError(500, f"Native local file picker could not start: {exc}") from exc
    if completed.returncode != 0:
        detail = (completed.stderr or completed.stdout or "Native local file picker failed").strip()
        raise NativeFilePickerError(500, detail)
    selected = [line.strip() for line in str(completed.stdout or "").splitlines() if line.strip()]
    return validate_selected_file(selected[-1], normalized_kind) if selected else ""
