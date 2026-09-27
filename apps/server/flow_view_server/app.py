"""The flow_view server.

Serves the UI and relays one traced run per WebSocket connection. Deliberately small: the server
runs programs and carries stdin. It does not interpret traces, and it holds no playback state.

Stepping, back-stepping and scrubbing all happen in the browser against the TraceStore, which is why
they are instant and why they are safe for a program with side effects — nothing re-executes. A
server that owned the playhead would have to re-run or remember, and both are worse.

Binds to loopback by default. flow_view is a local tool, and binding wider by default would publish
an execution surface the user never asked to expose.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from .capabilities import capabilities
from .runner import RunLimits, RunRequest, Runner

log = logging.getLogger("flow_view")

#: One WebSocket frame per animation frame. A million-event trace sent as a million tiny messages
#: would spend more time in framing overhead than in useful work, and would starve the browser's
#: event loop while it arrived.
BATCH_INTERVAL = 0.016

#: A batch is also flushed once it reaches this many events, so a fast program does not accumulate an
#: unbounded buffer between ticks.
BATCH_MAX = 400


@dataclass
class Session:
    """One run's worth of server-side state."""

    id: str
    created_at: float
    runner: Runner | None = None
    task: asyncio.Task[None] | None = None

    async def close(self) -> None:
        if self.task is not None and not self.task.done():
            self.task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self.task
        if self.runner is not None:
            await self.runner.stop()
            self.runner = None


class SessionStore:
    """Tracks live sessions so none can outlive the server.

    Sessions are closed on socket close, on idle timeout, and on shutdown. A run that survived any of
    those would be a process nobody is watching, still burning CPU.
    """

    def __init__(self, idle_seconds: float = 900.0) -> None:
        self._sessions: dict[str, Session] = {}
        self._idle_seconds = idle_seconds

    def create(self) -> Session:
        session = Session(id=uuid.uuid4().hex[:16], created_at=time.monotonic())
        self._sessions[session.id] = session
        return session

    def get(self, session_id: str) -> Session | None:
        return self._sessions.get(session_id)

    async def discard(self, session_id: str) -> None:
        session = self._sessions.pop(session_id, None)
        if session is not None:
            await session.close()

    async def reap_idle(self) -> None:
        cutoff = time.monotonic() - self._idle_seconds
        for session_id, session in list(self._sessions.items()):
            if session.created_at < cutoff:
                log.info("reaping idle session %s", session_id)
                await self.discard(session_id)

    async def close_all(self) -> None:
        for session_id in list(self._sessions):
            await self.discard(session_id)

    def __len__(self) -> int:
        return len(self._sessions)


def create_app(static_dir: Path | None = None) -> FastAPI:
    store = SessionStore()

    @contextlib.asynccontextmanager
    async def lifespan(_: FastAPI) -> Any:
        reaper = asyncio.create_task(_reaper(store))
        try:
            yield
        finally:
            # Shutdown must not leave a traced program running. Nobody would be watching it, and it
            # would keep whatever CPU and memory it had claimed.
            reaper.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await reaper
            await store.close_all()

    app = FastAPI(title="flow_view", version="0.1.0", lifespan=lifespan)

    @app.get("/api/capabilities")
    async def get_capabilities() -> JSONResponse:
        return JSONResponse(capabilities())

    @app.post("/api/session")
    async def create_session() -> JSONResponse:
        session = store.create()
        return JSONResponse({"id": session.id, "capabilities": capabilities()})

    @app.delete("/api/session/{session_id}")
    async def delete_session(session_id: str) -> JSONResponse:
        await store.discard(session_id)
        return JSONResponse({"closed": True})

    @app.websocket("/api/session/{session_id}/ws")
    async def session_socket(websocket: WebSocket, session_id: str) -> None:
        await websocket.accept()
        session = store.get(session_id)
        if session is None:
            await websocket.send_json(
                {"type": "error", "message": "That session no longer exists. Reload to start a new one."}
            )
            await websocket.close()
            return

        try:
            await _serve(websocket, session)
        except WebSocketDisconnect:
            pass
        except Exception:
            log.exception("session %s failed", session_id)
            with contextlib.suppress(Exception):
                await websocket.send_json(
                    {"type": "error", "message": "The run failed unexpectedly. See the server log."}
                )
        finally:
            # A closed socket means nobody is watching, so the run has no reason to continue.
            await store.discard(session_id)

    if static_dir is not None and static_dir.is_dir():
        app.mount("/", StaticFiles(directory=str(static_dir), html=True), name="ui")

    return app


async def _reaper(store: SessionStore) -> None:
    while True:
        await asyncio.sleep(60)
        with contextlib.suppress(Exception):
            await store.reap_idle()


async def _serve(websocket: WebSocket, session: Session) -> None:
    """Handle messages for one session until the socket closes."""
    while True:
        message = await websocket.receive_json()
        kind = message.get("type")

        if kind == "run":
            if session.runner is not None:
                await session.close()
            await _start_run(websocket, session, message)

        elif kind == "stdin":
            if session.runner is not None:
                await session.runner.send_stdin(str(message.get("text", "")))

        elif kind == "stop":
            await session.close()
            await websocket.send_json({"type": "stopped"})

        elif kind == "ping":
            await websocket.send_json({"type": "pong"})

        else:
            await websocket.send_json(
                {"type": "error", "message": f"Unknown message type: {kind!r}"}
            )


async def _start_run(websocket: WebSocket, session: Session, message: dict[str, Any]) -> None:
    language = message.get("language", "python")
    if language != "python":
        await websocket.send_json(
            {
                "type": "error",
                "message": f"{language} is not available yet. Python is the only adapter built so far.",
            }
        )
        return

    limits_in = message.get("limits") or {}
    limits = RunLimits(
        max_steps=int(limits_in.get("max_steps", 200_000)),
        wall_ms=int(limits_in.get("wall_ms", 30_000)),
        memory_mb=int(limits_in.get("memory_mb", 512)),
        output_bytes=int(limits_in.get("output_bytes", 1_048_576)),
    )

    request = RunRequest(
        source=str(message.get("source", "")),
        language=language,
        session_id=session.id,
        stdin=message.get("stdin") or None,
        limits=limits,
        complete_heap=bool(message.get("complete_heap", False)),
    )

    runner = Runner(request)
    session.runner = runner
    await runner.start()
    session.task = asyncio.create_task(_pump(websocket, runner))


async def _pump(websocket: WebSocket, runner: Runner) -> None:
    """Forward the event stream to the browser in batches."""
    batch: list[dict[str, Any]] = []
    last_flush = time.monotonic()
    started = False

    async def flush() -> None:
        nonlocal batch, last_flush
        if not batch:
            return
        payload, batch = batch, []
        last_flush = time.monotonic()
        await websocket.send_json({"type": "events", "events": payload})

    # Events are read in one task so that the batch can be flushed on a timer as well as on arrival.
    #
    # Batching used to be driven purely by the arrival of the next event, which deadlocked any program
    # that stopped to ask a question: the `stdin_request` went into the batch, the batch was under its
    # interval so it was not sent, and the next event — the answer — could never arrive, because the
    # question was sitting unsent in the batch. The UI showed "running" forever.
    events = runner.events()
    pending: asyncio.Task[dict[str, Any]] | None = None

    try:
        while True:
            if pending is None:
                pending = asyncio.ensure_future(anext(events))  # type: ignore[arg-type]

            # With nothing buffered there is nothing to time out for, so wait for the next event.
            timeout = BATCH_INTERVAL if batch else None
            done, _ = await asyncio.wait({pending}, timeout=timeout)
            if not done:
                # The window closed while the program was quiet. Send what we have.
                await flush()
                continue

            task, pending = pending, None
            try:
                event = task.result()
            except StopAsyncIteration:
                break

            # The header arrives first and alone, so the UI can set up before any event lands.
            if "session" in event:
                await websocket.send_json(
                    {"type": "session", "schema": event.get("schema"), "session": event["session"]}
                )
                started = True
                continue

            batch.append(event)
            due = (time.monotonic() - last_flush) >= BATCH_INTERVAL
            if len(batch) >= BATCH_MAX or due:
                await flush()

        await flush()

        if not started:
            # The adapter never produced a header, so it failed before tracing began. Its stderr is
            # the only explanation available, and hiding it would leave the user with silence.
            detail = (await runner.stderr_text()).strip()
            await websocket.send_json(
                {
                    "type": "error",
                    "message": "The tracer could not start.",
                    "detail": detail[-2000:] or None,
                }
            )
            return

        await websocket.send_json({"type": "complete", "exit_code": runner.exit_code})

    except asyncio.CancelledError:
        raise
    except WebSocketDisconnect:
        pass
    finally:
        if pending is not None:
            pending.cancel()
            with contextlib.suppress(asyncio.CancelledError, StopAsyncIteration):
                await pending
        await events.aclose()
        await runner.stop()
