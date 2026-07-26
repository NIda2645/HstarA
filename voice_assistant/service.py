import argparse
import asyncio
import contextlib
import json
import os
import sys
import threading
import time
from pathlib import Path

from .audio import VadSession, WebRtcVad
from .protocol import (
    FRAME_AUDIO,
    FRAME_JSON,
    VoiceProtocolError,
    authenticate_hello,
    decode_json,
    read_frame,
    write_json,
)
from .recognizer import FunAsrRecognizer, VoiceRecognitionError, prepend_runtime_site


def parent_process_is_alive(process_id: int) -> bool:
    if process_id <= 0:
        return True
    if os.name != "nt":
        try:
            os.kill(process_id, 0)
            return True
        except (OSError, ProcessLookupError):
            return False

    import ctypes
    from ctypes import wintypes

    synchronize = 0x00100000
    wait_timeout = 0x00000102
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel32.OpenProcess.restype = wintypes.HANDLE
    kernel32.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    kernel32.WaitForSingleObject.restype = wintypes.DWORD
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel32.CloseHandle.restype = wintypes.BOOL
    handle = kernel32.OpenProcess(synchronize, False, process_id)
    if not handle:
        return False
    try:
        return kernel32.WaitForSingleObject(handle, 0) == wait_timeout
    finally:
        kernel32.CloseHandle(handle)


def start_parent_watchdog(process_id: int) -> threading.Thread | None:
    if process_id <= 0:
        return None

    def watch_parent():
        while parent_process_is_alive(process_id):
            time.sleep(0.5)
        os._exit(0)

    thread = threading.Thread(
        target=watch_parent,
        name="hstar-voice-parent-watchdog",
        daemon=True,
    )
    thread.start()
    return thread


class VoiceConnection:
    def __init__(self, service, reader, writer):
        self.service = service
        self.reader = reader
        self.writer = writer
        self.sequence = 0
        self.session_id = ""
        self.language = "auto"
        self.vad_session = None
        self.send_lock = asyncio.Lock()
        self.partial_task = None
        self.pending_partial = None
        self.closed = False

    async def run(self):
        await authenticate_hello(self.reader, self.service.token)
        await self.send({"type": "authenticated", "protocol": 1})
        while not self.closed:
            frame_type, payload = await read_frame(self.reader)
            if frame_type == FRAME_JSON:
                await self.handle_command(decode_json(payload))
            elif frame_type == FRAME_AUDIO:
                await self.handle_audio(payload)

    async def handle_command(self, message):
        command = message.get("type")
        if command == "load":
            device = await asyncio.to_thread(
                self.service.ensure_loaded,
                str(message.get("device") or "auto"),
            )
            await self.send({"type": "loaded", "device": device})
        elif command == "start":
            if self.service.recognizer.device == "":
                await asyncio.to_thread(self.service.ensure_loaded, "auto")
            if not self.service.claim(self):
                await self.send_error("VOICE_MIC_BUSY", "Another session is active")
                return
            self.session_id = str(message.get("session_id") or "")
            self.language = str(message.get("language") or "auto")
            vad = self.service.create_vad()
            self.vad_session = VadSession.for_device(
                self.service.recognizer.device,
                vad=vad,
                silence_seconds=10,
            )
            await self.send(
                {
                    "type": "ready",
                    "session_id": self.session_id,
                    "device": self.service.recognizer.device,
                }
            )
        elif command == "stop":
            await self.stop_session("user", flush=True)
        elif command == "cancel":
            await self.stop_session(str(message.get("reason") or "cancelled"), flush=False)
        elif command == "unload":
            await self.stop_session("unload", flush=False)
            await asyncio.to_thread(self.service.recognizer.close)
            await self.send({"type": "unloaded"})
        elif command == "shutdown":
            await self.stop_session("shutdown", flush=False)
            self.service.shutdown_event.set()
            self.closed = True
        else:
            await self.send_error("VOICE_PROTOCOL_COMMAND", f"Unknown command: {command}")

    async def handle_audio(self, payload):
        if self.vad_session is None:
            await self.send_error("VOICE_SESSION_NOT_STARTED", "Start a session first")
            return
        event = self.vad_session.accept_pcm(payload)
        await self.send(
            {
                "type": "speech-state",
                "active": event.speech_active,
                "silence_remaining_ms": event.silence_remaining_ms,
            }
        )
        if event.partial_pcm:
            self.submit_partial(event.partial_pcm)
        if event.final_utterance_pcm:
            await self.submit_final(event.final_utterance_pcm)
        if event.stop_reason:
            await self.stop_session(event.stop_reason, flush=False)

    def submit_partial(self, pcm):
        self.pending_partial = pcm
        if self.partial_task is None or self.partial_task.done():
            self.partial_task = asyncio.create_task(self._drain_partials())

    async def _drain_partials(self):
        while self.pending_partial is not None and self.vad_session is not None:
            pcm = self.pending_partial
            self.pending_partial = None
            text = await asyncio.to_thread(
                self.service.recognizer.transcribe,
                pcm,
                self.language,
            )
            if text and self.vad_session is not None:
                await self.send({"type": "partial", "text": text})

    async def submit_final(self, pcm):
        self.pending_partial = None
        if self.partial_task and not self.partial_task.done():
            self.partial_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self.partial_task
        text = await asyncio.to_thread(
            self.service.recognizer.transcribe,
            pcm,
            self.language,
        )
        if text:
            await self.send({"type": "final", "text": text})

    async def stop_session(self, reason, *, flush):
        if self.vad_session is None:
            return
        if flush:
            event = self.vad_session.flush()
            if event.final_utterance_pcm:
                await self.submit_final(event.final_utterance_pcm)
        self.pending_partial = None
        if self.partial_task and not self.partial_task.done():
            self.partial_task.cancel()
        self.vad_session = None
        self.service.release(self)
        await self.send({"type": "stopped", "reason": reason})

    async def send(self, payload):
        self.sequence += 1
        event = {**payload, "sequence": self.sequence}
        async with self.send_lock:
            await write_json(self.writer, event)

    async def send_error(self, code, message):
        await self.send(
            {
                "type": "error",
                "code": code,
                "message": message,
                "recoverable": True,
            }
        )

    async def close(self):
        await self.stop_session("disconnected", flush=False)
        self.closed = True
        self.writer.close()
        with contextlib.suppress(Exception):
            await self.writer.wait_closed()


class VoiceService:
    def __init__(self, *, token, recognizer, vad_factory):
        self.token = token
        self.recognizer = recognizer
        self.vad_factory = vad_factory
        self.shutdown_event = asyncio.Event()
        self.owner = None

    def ensure_loaded(self, device):
        if self.recognizer.device:
            return self.recognizer.device
        return self.recognizer.load(device)

    def create_vad(self):
        return self.vad_factory()

    def claim(self, connection):
        if self.owner not in {None, connection}:
            return False
        self.owner = connection
        return True

    def release(self, connection):
        if self.owner is connection:
            self.owner = None

    async def handle(self, reader, writer):
        connection = VoiceConnection(self, reader, writer)
        try:
            await connection.run()
        except (VoiceProtocolError, VoiceRecognitionError) as error:
            with contextlib.suppress(Exception):
                await connection.send_error(getattr(error, "code", "VOICE_SERVICE_ERROR"), str(error))
        except (asyncio.IncompleteReadError, ConnectionError):
            pass
        finally:
            await connection.close()


async def serve(args) -> int:
    prepend_runtime_site(args.runtime_site)
    start_parent_watchdog(int(getattr(args, "parent_pid", 0) or 0))
    test_mode = bool(args.test_mode)
    if test_mode:
        if os.environ.get("HSTAR_VOICE_TEST_MODE") != "1":
            raise RuntimeError("Test mode requires HSTAR_VOICE_TEST_MODE=1")
        from .testing import FakeRecognizer, FakeVad

        recognizer = FakeRecognizer(args.model_path)
        vad_factory = FakeVad
    else:
        recognizer = FunAsrRecognizer(args.model_path)
        vad_factory = WebRtcVad
    service = VoiceService(
        token=args.token,
        recognizer=recognizer,
        vad_factory=vad_factory,
    )
    server = await asyncio.start_server(service.handle, "127.0.0.1", 0)
    port = server.sockets[0].getsockname()[1]
    print(json.dumps({"type": "ready", "port": port, "protocol": 1}), flush=True)
    async with server:
        await service.shutdown_event.wait()
    recognizer.close()
    return 0


def parse_args(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--runtime-site", required=True)
    parser.add_argument("--model-path", required=True)
    parser.add_argument("--token", required=True)
    parser.add_argument("--parent-pid", type=int, default=0)
    parser.add_argument("--test-mode", action="store_true")
    return parser.parse_args(argv)


def main() -> int:
    try:
        return asyncio.run(serve(parse_args()))
    except Exception as error:
        print(str(error), file=sys.stderr, flush=True)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
