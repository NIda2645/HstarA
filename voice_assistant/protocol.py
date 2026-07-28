import asyncio
import hmac
import json
import struct
from typing import Any, Mapping


HEADER = struct.Struct("!BI")
FRAME_JSON = 1
FRAME_AUDIO = 2
FRAME_TYPES = frozenset({FRAME_JSON, FRAME_AUDIO})
MAX_FRAME_BYTES = 1_048_576

VOICE_PROTOCOL_FRAME_TYPE = "VOICE_PROTOCOL_FRAME_TYPE"
VOICE_PROTOCOL_FRAME_TOO_LARGE = "VOICE_PROTOCOL_FRAME_TOO_LARGE"
VOICE_PROTOCOL_INCOMPLETE = "VOICE_PROTOCOL_INCOMPLETE"
VOICE_PROTOCOL_JSON_INVALID = "VOICE_PROTOCOL_JSON_INVALID"
VOICE_PROTOCOL_AUTH_REQUIRED = "VOICE_PROTOCOL_AUTH_REQUIRED"
VOICE_PROTOCOL_AUTH_FAILED = "VOICE_PROTOCOL_AUTH_FAILED"

VOICE_CUDA_UNAVAILABLE = "VOICE_CUDA_UNAVAILABLE"
VOICE_DOWNLOAD_DISK_FULL = "VOICE_DOWNLOAD_DISK_FULL"
VOICE_DOWNLOAD_NETWORK_ERROR = "VOICE_DOWNLOAD_NETWORK_ERROR"
VOICE_MIC_BUSY = "VOICE_MIC_BUSY"
VOICE_MIC_PERMISSION_DENIED = "VOICE_MIC_PERMISSION_DENIED"
VOICE_MODEL_INCOMPLETE = "VOICE_MODEL_INCOMPLETE"
VOICE_MODEL_LOAD_FAILED = "VOICE_MODEL_LOAD_FAILED"
VOICE_MODEL_MISSING = "VOICE_MODEL_MISSING"
VOICE_MODEL_OOM = "VOICE_MODEL_OOM"
VOICE_RUNTIME_INSTALL_FAILED = "VOICE_RUNTIME_INSTALL_FAILED"
VOICE_RUNTIME_MISSING = "VOICE_RUNTIME_MISSING"
VOICE_SERVICE_DISCONNECTED = "VOICE_SERVICE_DISCONNECTED"
VOICE_STORAGE_NOT_WRITABLE = "VOICE_STORAGE_NOT_WRITABLE"
VOICE_TARGET_LOST = "VOICE_TARGET_LOST"


class VoiceProtocolError(RuntimeError):
    def __init__(self, code: str, message: str = ""):
        self.code = code
        self.message = message
        super().__init__(f"{code}: {message}" if message else code)


def encode_frame(frame_type: int, payload: bytes) -> bytes:
    if frame_type not in FRAME_TYPES:
        raise VoiceProtocolError(VOICE_PROTOCOL_FRAME_TYPE)
    if not isinstance(payload, bytes):
        raise TypeError("Voice frame payload must be bytes")
    if len(payload) > MAX_FRAME_BYTES:
        raise VoiceProtocolError(VOICE_PROTOCOL_FRAME_TOO_LARGE)
    return HEADER.pack(frame_type, len(payload)) + payload


async def read_frame(reader: asyncio.StreamReader) -> tuple[int, bytes]:
    try:
        header = await reader.readexactly(HEADER.size)
        frame_type, length = HEADER.unpack(header)
        if frame_type not in FRAME_TYPES:
            raise VoiceProtocolError(VOICE_PROTOCOL_FRAME_TYPE)
        if length > MAX_FRAME_BYTES:
            raise VoiceProtocolError(VOICE_PROTOCOL_FRAME_TOO_LARGE)
        payload = await reader.readexactly(length)
    except asyncio.IncompleteReadError as error:
        raise VoiceProtocolError(VOICE_PROTOCOL_INCOMPLETE) from error
    return frame_type, payload


def encode_json(payload: Mapping[str, Any]) -> bytes:
    try:
        data = json.dumps(
            dict(payload),
            ensure_ascii=False,
            separators=(",", ":"),
        ).encode("utf-8")
    except (TypeError, ValueError) as error:
        raise VoiceProtocolError(VOICE_PROTOCOL_JSON_INVALID, str(error)) from error
    return encode_frame(FRAME_JSON, data)


def decode_json(payload: bytes) -> dict[str, Any]:
    try:
        value = json.loads(payload.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise VoiceProtocolError(VOICE_PROTOCOL_JSON_INVALID, str(error)) from error
    if not isinstance(value, dict):
        raise VoiceProtocolError(
            VOICE_PROTOCOL_JSON_INVALID,
            "JSON frame must contain an object",
        )
    return value


async def write_frame(
    writer: asyncio.StreamWriter,
    frame_type: int,
    payload: bytes,
) -> None:
    writer.write(encode_frame(frame_type, payload))
    await writer.drain()


async def write_json(
    writer: asyncio.StreamWriter,
    payload: Mapping[str, Any],
) -> None:
    writer.write(encode_json(payload))
    await writer.drain()


async def authenticate_hello(
    reader: asyncio.StreamReader,
    expected_token: str,
) -> dict[str, Any]:
    frame_type, raw_payload = await read_frame(reader)
    if frame_type != FRAME_JSON:
        raise VoiceProtocolError(VOICE_PROTOCOL_AUTH_REQUIRED)
    payload = decode_json(raw_payload)
    supplied_token = payload.get("token")
    if payload.get("type") != "hello" or not isinstance(supplied_token, str):
        raise VoiceProtocolError(VOICE_PROTOCOL_AUTH_REQUIRED)
    if not expected_token or not hmac.compare_digest(supplied_token, expected_token):
        raise VoiceProtocolError(VOICE_PROTOCOL_AUTH_FAILED)
    return payload
