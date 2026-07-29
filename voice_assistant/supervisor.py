import asyncio
import contextlib
import json
import os
import secrets
import subprocess
import sys
import time
from collections import deque
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Mapping

from .protocol import (
    FRAME_AUDIO,
    FRAME_JSON,
    decode_json,
    read_frame,
    write_frame,
    write_json,
)


ALLOWED_CHILD_ENV = frozenset(
    {
        "APPDATA",
        "CUDA_PATH",
        "CUDA_VISIBLE_DEVICES",
        "HOMEDRIVE",
        "HOMEPATH",
        "LOCALAPPDATA",
        "NVIDIA_VISIBLE_DEVICES",
        "NUMBER_OF_PROCESSORS",
        "PATH",
        "PATHEXT",
        "PROCESSOR_ARCHITECTURE",
        "PROGRAMDATA",
        "PROGRAMFILES",
        "PROGRAMFILES(X86)",
        "SYSTEMDRIVE",
        "SYSTEMROOT",
        "TEMP",
        "TMP",
        "USERPROFILE",
        "WINDIR",
    }
)


def sanitized_child_env(source: Mapping[str, str]) -> dict[str, str]:
    env = {
        key: value
        for key, value in source.items()
        if key.upper() in ALLOWED_CHILD_ENV
    }
    env.update(
        {
            "PYTHONDONTWRITEBYTECODE": "1",
            "PYTHONUTF8": "1",
            "PYTHONIOENCODING": "utf-8",
            "PYTHONNOUSERSITE": "1",
        }
    )
    return env


def service_command(
    python_executable: str,
    runtime_site: Path,
    model_path: Path,
    token: str,
    *,
    parent_pid: int | None = None,
    test_mode: bool = False,
) -> list[str]:
    command = [
        str(python_executable),
        "-B",
        "-X",
        "utf8",
        "-m",
        "voice_assistant.service",
        "--runtime-site",
        str(runtime_site),
        "--model-path",
        str(model_path),
        f"--token={token}",
    ]
    if parent_pid:
        command.extend(["--parent-pid", str(parent_pid)])
    if test_mode:
        command.append("--test-mode")
    return command


@dataclass(frozen=True)
class VoiceServiceEndpoint:
    host: str
    port: int
    token: str
    protocol: int
    process_id: int


@dataclass(frozen=True)
class VoiceSupervisorStatus:
    process_state: str
    model_state: str
    process_id: int
    port: int
    active_sessions: int
    last_error: str


class VoiceServiceConnection:
    def __init__(
        self,
        reader: asyncio.StreamReader,
        writer: asyncio.StreamWriter,
        *,
        session_id: str,
        on_event: Callable[[dict], None] | None = None,
    ):
        self.reader = reader
        self.writer = writer
        self.session_id = session_id
        self.on_event = on_event
        self.closed = False

    async def send_json(self, payload: Mapping) -> None:
        if self.closed:
            raise ConnectionError("Voice service connection is closed")
        await write_json(self.writer, payload)

    async def send_audio(self, payload: bytes) -> None:
        if self.closed:
            raise ConnectionError("Voice service connection is closed")
        await write_frame(self.writer, FRAME_AUDIO, payload)

    async def receive_event(self) -> dict:
        frame_type, payload = await read_frame(self.reader)
        if frame_type != FRAME_JSON:
            raise ConnectionError("Voice service returned a non-JSON control frame")
        event = decode_json(payload)
        if self.on_event:
            self.on_event(event)
        return event

    async def close(self) -> None:
        if self.closed:
            return
        self.closed = True
        self.writer.close()
        with contextlib.suppress(Exception):
            await self.writer.wait_closed()


class VoiceServiceSupervisor:
    def __init__(
        self,
        *,
        python_executable: str,
        runtime_site: Path,
        model_path: Path,
        test_mode: bool = False,
        clock: Callable[[], float] = time.monotonic,
        warm_idle_seconds: int = 600,
        readiness_timeout: float = 15.0,
    ):
        self.python_executable = str(python_executable)
        self.runtime_site = Path(runtime_site).resolve()
        self.model_path = Path(model_path).resolve()
        self.test_mode = test_mode
        self.clock = clock
        self.warm_idle_seconds = warm_idle_seconds
        self.readiness_timeout = readiness_timeout
        self._start_lock = asyncio.Lock()
        self._process = None
        self._endpoint = None
        self._stderr_task = None
        self._diagnostics = deque(maxlen=200)
        self._model_state = "unloaded"
        self._active_sessions = 0
        self._idle_since = None
        self._last_error = ""
        self.start_count = 0

    async def ensure_ready(self) -> VoiceServiceEndpoint:
        if self.is_running() and self._endpoint:
            return self._endpoint
        async with self._start_lock:
            if self.is_running() and self._endpoint:
                return self._endpoint
            await self._start_process()
            return self._endpoint

    async def _start_process(self) -> None:
        token = secrets.token_urlsafe(32)
        command = service_command(
            self.python_executable,
            self.runtime_site,
            self.model_path,
            token,
            parent_pid=os.getpid(),
            test_mode=self.test_mode,
        )
        env = sanitized_child_env(os.environ)
        if self.test_mode:
            env["HSTAR_VOICE_TEST_MODE"] = "1"
        creationflags = 0
        if os.name == "nt":
            creationflags = subprocess.CREATE_NO_WINDOW | subprocess.CREATE_NEW_PROCESS_GROUP
        self._process = await asyncio.create_subprocess_exec(
            *command,
            cwd=str(Path(__file__).resolve().parents[1]),
            env=env,
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            creationflags=creationflags,
        )
        self.start_count += 1
        try:
            raw_line = await asyncio.wait_for(
                self._process.stdout.readline(),
                timeout=self.readiness_timeout,
            )
            if not raw_line:
                stderr_task = asyncio.create_task(
                    self._read_stderr_tail(
                        self._process.stderr,
                        64 * 1024,
                        max_chunks=256,
                    )
                )
                try:
                    if self._process.returncode is None:
                        with contextlib.suppress(ProcessLookupError):
                            self._process.terminate()
                    try:
                        return_code = await asyncio.wait_for(
                            self._process.wait(), timeout=1.0
                        )
                    except asyncio.TimeoutError:
                        with contextlib.suppress(ProcessLookupError):
                            self._process.kill()
                        return_code = await asyncio.wait_for(
                            self._process.wait(), timeout=1.0
                        )
                    stderr_bytes = await asyncio.wait_for(stderr_task, timeout=1.0)
                except BaseException:
                    stderr_task.cancel()
                    with contextlib.suppress(asyncio.CancelledError):
                        await stderr_task
                    raise
                diagnostics = stderr_bytes.decode("utf-8", errors="replace").strip()
                for line in diagnostics.splitlines()[-50:]:
                    self._diagnostics.append(line)
                detail = diagnostics[-4000:] or "no child diagnostics"
                raise RuntimeError(
                    f"Voice service exited before readiness (code {return_code}): {detail}"
                )
            payload = json.loads(raw_line.decode("utf-8"))
            if payload.get("type") != "ready" or not int(payload.get("port") or 0):
                raise RuntimeError(f"Invalid voice service readiness line: {payload!r}")
            self._endpoint = VoiceServiceEndpoint(
                host="127.0.0.1",
                port=int(payload["port"]),
                token=token,
                protocol=int(payload.get("protocol") or 1),
                process_id=int(self._process.pid),
            )
            self._stderr_task = asyncio.create_task(self._drain_stderr(self._process))
            self._last_error = ""
            self._model_state = "unloaded"
        except Exception as error:
            self._last_error = str(error)
            await self._terminate_process()
            raise

    @staticmethod
    async def _read_stderr_tail(
        stream,
        limit: int,
        *,
        max_chunks: int | None = None,
    ) -> bytes:
        if stream is None:
            return b""
        tail = bytearray()
        chunks_read = 0
        while True:
            chunk = await stream.read(8192)
            if not chunk:
                break
            tail.extend(chunk)
            if len(tail) > limit:
                del tail[:-limit]
            chunks_read += 1
            if max_chunks is not None and chunks_read >= max_chunks:
                break
            await asyncio.sleep(0)
        return bytes(tail)

    async def _drain_stderr(self, process) -> None:
        while process.stderr and not process.stderr.at_eof():
            line = await process.stderr.readline()
            if not line:
                break
            self._diagnostics.append(line.decode("utf-8", errors="replace").rstrip())

    async def connect(
        self,
        endpoint: VoiceServiceEndpoint,
        session_id: str,
        *,
        track_session: bool = True,
    ) -> VoiceServiceConnection:
        reader, writer = await asyncio.open_connection(endpoint.host, endpoint.port)
        await write_json(
            writer,
            {"type": "hello", "token": endpoint.token, "protocol": endpoint.protocol},
        )
        frame_type, payload = await read_frame(reader)
        if frame_type != FRAME_JSON or decode_json(payload).get("type") != "authenticated":
            writer.close()
            raise ConnectionError("Voice service authentication failed")
        if track_session:
            self._active_sessions += 1
            self._idle_since = None
        return VoiceServiceConnection(
            reader,
            writer,
            session_id=session_id,
            on_event=self._observe_event,
        )

    def _observe_event(self, event: dict) -> None:
        event_type = event.get("type")
        if event_type in {"loaded", "ready"}:
            self._model_state = "loaded"
        elif event_type == "unloaded":
            self._model_state = "unloaded"

    async def session_finished(self) -> None:
        self._active_sessions = max(0, self._active_sessions - 1)
        if self._active_sessions == 0:
            self._idle_since = self.clock()

    async def reap_idle(self) -> bool:
        if (
            not self.is_running()
            or self._model_state != "loaded"
            or self._active_sessions
            or self._idle_since is None
            or self.clock() - self._idle_since < self.warm_idle_seconds
        ):
            return False
        connection = await self.connect(
            self._endpoint,
            "idle-reaper",
            track_session=False,
        )
        try:
            await connection.send_json({"type": "unload"})
            event = await connection.receive_event()
            if event.get("type") != "unloaded":
                raise RuntimeError(f"Unexpected unload event: {event!r}")
        finally:
            await connection.close()
        self._model_state = "unloaded"
        self._idle_since = None
        return True

    async def prewarm(self, device: str = "auto") -> None:
        endpoint = await self.ensure_ready()
        connection = await self.connect(endpoint, "prewarm", track_session=False)
        try:
            await connection.send_json({"type": "load", "device": device})
            event = await connection.receive_event()
            if event.get("type") != "loaded":
                raise RuntimeError(f"Unexpected load event: {event!r}")
        finally:
            await connection.close()

    def status(self) -> VoiceSupervisorStatus:
        process_id = int(self._process.pid) if self.is_running() else 0
        return VoiceSupervisorStatus(
            process_state="running" if self.is_running() else "stopped",
            model_state=self._model_state,
            process_id=process_id,
            port=self._endpoint.port if self.is_running() and self._endpoint else 0,
            active_sessions=self._active_sessions,
            last_error=self._last_error,
        )

    def is_running(self) -> bool:
        return self._process is not None and self._process.returncode is None

    async def shutdown(self) -> None:
        if self.is_running() and self._endpoint:
            with contextlib.suppress(Exception):
                connection = await self.connect(
                    self._endpoint,
                    "shutdown",
                    track_session=False,
                )
                await connection.send_json({"type": "shutdown"})
                await connection.close()
        await self._terminate_process()
        self._endpoint = None
        self._model_state = "unloaded"
        self._active_sessions = 0
        self._idle_since = None

    async def _terminate_process(self) -> None:
        process = self._process
        if process is None:
            return
        if process.returncode is None:
            try:
                await asyncio.wait_for(process.wait(), timeout=5)
            except asyncio.TimeoutError:
                process.terminate()
                try:
                    await asyncio.wait_for(process.wait(), timeout=5)
                except asyncio.TimeoutError:
                    process.kill()
                    await process.wait()
        if self._stderr_task:
            self._stderr_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._stderr_task
        self._process = None
        self._stderr_task = None
