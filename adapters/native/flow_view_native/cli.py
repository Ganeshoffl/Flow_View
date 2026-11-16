"""Trace C source using real GDB/MI observations. No inferred addresses or values."""

from __future__ import annotations

import argparse
import ast
import hashlib
import json
import re
import shutil
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))
from mi import MIClient, Record


class Trace:
    def __init__(self, source: Path, args: argparse.Namespace) -> None:
        self.source = source
        self.args = args
        self.seq = 0
        self.step = 0
        self.start = time.monotonic()
        self.idle_ms = 0.0
        self.output_bytes = 0
        self.output_capped = False
        self.last_stdout = ""
        self.output_path: Path | None = None
        self.error_path: Path | None = None
        self.output_positions: dict[Path, int] = {}
        self.frames: list[tuple[int, str]] = []
        self.next_frame = 0
        self.bindings: dict[int, dict[str, dict[str, Any]]] = {}
        self.parameters: dict[int, set[str]] = {}
        self.visited_lines: dict[int, set[int]] = {}
        self.local_baselines: dict[tuple[int, str], str] = {}
        self.initialized_locals: set[tuple[int, str]] = set()
        self.return_modes: set[int] = set()
        self.return_values: dict[int, dict[str, Any]] = {}
        self.pending_branches: dict[int, tuple[int, str, str, int]] = {}
        self.loop_ranges: set[tuple[int, int]] = set()
        self.loop_bodies: dict[tuple[int, int], int] = {}
        self.loop_states: dict[tuple[int, int], dict[str, Any]] = {}
        self.next_region = 1
        self.allocations: dict[str, tuple[int, int]] = {}
        self.freed: set[str] = set()
        self.freed_objects: dict[str, int] = {}
        self.object_slots: dict[int, dict[str, Any]] = {}
        self.announced_objects: set[int] = set()
        self.object_kinds: dict[int, str] = {}
        self.original_bytes: dict[str, str] = {}
        self.raw_bytes: dict[str, str] = {}
        self.initialized: set[str] = set()
        self.zero_initialized: set[str] = set()
        self.next_object = 1
        self.current_line = 1
        self.current_frame = 0
        self.source_lines = source.read_text(encoding="utf-8").splitlines()
        self.declarations: dict[tuple[str, str], tuple[int, bool]] = {}
        function = ""
        for number, text in enumerate(self.source_lines, 1):
            signature = re.match(
                r"\s*(?:static\s+)?(?:int|void|char|long|short|struct\s+\w+)"
                r"\s+\*?\s*(\w+)\s*\(",
                text,
            )
            if signature:
                function = signature.group(1)
            declaration = re.match(
                r"\s*(?:(?:const|static|unsigned|signed)\s+)*"
                r"(?:int|long|short|float|double|char|struct\s+\w+)\s*"
                r"\*?\s*(\w+)(?:\s*\[\s*\d+\s*\])?\s*(=)?",
                text,
            )
            if function and declaration:
                self.declarations.setdefault(
                    (function, declaration.group(1)), (number, declaration.group(2) == "=")
                )
        for number, text in enumerate(self.source_lines, 1):
            if re.search(r"\b(?:while|for)\s*\(", text):
                self.current_line = number
                self.loop_instruction_mode(text)
        self.current_line = 1

    def header(self) -> None:
        text = self.source.read_bytes()
        header = {
            "schema": "flow_view/trace@1",
            "session": {
                "id": self.args.session_id,
                "language": "c",
                "language_version": compiler_version(),
                "adapter_version": "0.1.0",
                "profile": "full",
                "source_files": [
                    {
                        "path": self.source.name,
                        "sha256": hashlib.sha256(text).hexdigest(),
                        "line_count": len(text.decode("utf-8").split("\n")),
                    }
                ],
                "entry": {"path": self.source.name, "line": 1},
                "limits": {
                    "max_steps": self.args.max_steps,
                    "wall_ms": self.args.wall_ms,
                    "memory_mb": self.args.memory_mb,
                    "output_bytes": self.args.output_bytes,
                },
                "started_at": datetime.now(timezone.utc).isoformat(),
                "guards_active": [
                    "GDB response deadline",
                    "trace step budget",
                    "trace output truncation",
                ],
            },
        }
        self.write(header)

    @staticmethod
    def write(value: dict[str, Any]) -> None:
        sys.stdout.write(json.dumps(value, separators=(",", ":")) + "\n")
        sys.stdout.flush()

    def emit(self, event_type: str, **data: Any) -> None:
        event = {"seq": self.seq, "t": event_type, **data, "ms": round(self.elapsed(), 2)}
        self.seq += 1
        if event_type in {
            "step_line",
            "frame_push",
            "frame_pop",
            "branch",
            "jump",
            "exception_raise",
            "exception_catch",
            "collapse",
        }:
            event["step"] = self.step
            self.step += 1
        self.write(event)
        metric = (
            "assignment"
            if event_type == "var_set" and "unavailable" not in data["value"]
            else "call"
            if event_type == "frame_push"
            else "allocation"
            if event_type == "mem_alloc"
            else "write"
            if event_type == "obj_set" and "unavailable" not in data["value"]
            else None
        )
        if metric:
            self.emit("metric", name=metric, delta=1)

    def elapsed(self) -> float:
        return (time.monotonic() - self.start) * 1000 - self.idle_ms

    def end(self, status: str, exit_code: int | None = None) -> None:
        self.drain_output()
        for address, (obj, size) in self.allocations.items():
            self.announce_object(None, "", address, obj, size)
        for frame, _func in reversed(self.frames):
            self.close_loops(frame, "return" if status == "ok" else "exception")
            self.emit("frame_pop", frame=frame, reason="return" if status == "ok" else "exception")
        self.frames.clear()
        payload: dict[str, Any] = {
            "status": status,
            "steps": self.step,
            "duration_ms": round(self.elapsed(), 2),
        }
        if exit_code is not None:
            payload["exit_code"] = exit_code
        self.emit("run_end", **payload)

    def drain_output(self) -> None:
        for path, kind in ((self.output_path, "stdout"), (self.error_path, "stderr")):
            if path is None or not path.is_file():
                continue
            remaining = self.args.output_bytes - self.output_bytes
            if remaining <= 0:
                if not self.output_capped and path.stat().st_size > self.output_positions.get(
                    path, 0
                ):
                    self.output_capped = True
                    self.emit(
                        "note",
                        level="warn",
                        text=f"Output truncated at {self.args.output_bytes} bytes.",
                    )
                continue
            with path.open("rb") as stream:
                stream.seek(self.output_positions.get(path, 0))
                data = stream.read(remaining)
                self.output_positions[path] = stream.tell()
            if data:
                self.output_bytes += len(data)
                text = data.decode("utf-8", "replace").replace("\r\n", "\n")
                if kind == "stdout":
                    self.last_stdout = (self.last_stdout + text).split("\n")[-1][-120:]
                self.emit(kind, text=text)

    def output(self, records: list[Record]) -> None:
        for record in records:
            if record.kind not in {"@", "&"} or record.kind == "&":
                continue
            text = str(record.value)
            remaining = self.args.output_bytes - self.output_bytes
            if remaining <= 0:
                continue
            chunk = text.encode("utf-8")[:remaining].decode("utf-8", "ignore")
            if chunk:
                self.output_bytes += len(chunk.encode("utf-8"))
                self.emit("stdout", text=chunk)

    def inspect(self, debugger: MIClient, stopped: Record) -> bool:
        result, records = debugger.command("-stack-list-frames")
        self.output(records)
        if result.name != "done":
            return False
        raw = result.value.get("stack", [])
        levels = raw.get("frame", []) if isinstance(raw, dict) else []
        if isinstance(levels, dict):
            levels = [levels]
        if not levels or not self.is_user_frame(levels[0]):
            return False
        # GDB lists innermost first; use only frames backed by the user's own source.
        active = [entry for entry in reversed(levels) if self.is_user_frame(entry)]
        matched = 0
        while matched < min(len(self.frames), len(active)):
            if self.frames[matched][1] != active[matched].get("func"):
                break
            matched += 1
        for frame, _func in reversed(self.frames[matched:]):
            self.close_loops(frame, "return")
            payload: dict[str, Any] = {"frame": frame, "reason": "return"}
            if len(self.frames[matched:]) == 1:
                value = self.return_values.pop(frame, None)
                if value is None and stopped.value.get("reason") == "function-finished":
                    retval = stopped.value.get("return-value")
                    if retval is not None:
                        value = native_value(retval, self.source, "", 0)
                if value is not None:
                    payload["return_value"] = value
            self.return_modes.discard(frame)
            self.pending_branches.pop(frame, None)
            self.emit("frame_pop", **payload)
            self.bindings.pop(frame, None)
            self.parameters.pop(frame, None)
            self.visited_lines.pop(frame, None)
            self.initialized_locals = {key for key in self.initialized_locals if key[0] != frame}
            self.local_baselines = {
                key: val for key, val in self.local_baselines.items() if key[0] != frame
            }
        self.frames = self.frames[:matched]
        for entry in active[matched:]:
            frame = self.next_frame
            self.next_frame += 1
            func = entry.get("func", "<unknown>")
            arguments, _ = debugger.command(
                f"-stack-list-arguments --all-values {entry['level']} {entry['level']}"
            )
            args_list: list[dict[str, Any]] = []
            if arguments.name == "done":
                stack_args = arguments.value.get("stack-args", {})
                arg_frames = stack_args.get("frame", []) if isinstance(stack_args, dict) else []
                if isinstance(arg_frames, dict):
                    arg_frames = [arg_frames]
                if arg_frames:
                    args_list = [
                        {
                            "name": arg["name"],
                            "value": native_value(arg.get("value"), self.source, "", 0),
                        }
                        for arg in arg_frames[0].get("args", [])
                        if "name" in arg
                    ]
            payload: dict[str, Any] = {
                "frame": frame,
                "func": func,
                "args": args_list,
                "kind": "user",
                "recursion_depth": sum(1 for _id, parent in self.frames if parent == func),
                "line": int(entry.get("line", 1)),
                "path": self.source.name,
            }
            if self.frames:
                payload["caller"] = self.frames[-1][0]
            self.emit("frame_push", **payload)
            self.frames.append((frame, func))
            self.bindings[frame] = {}
            self.parameters[frame] = {argument["name"] for argument in args_list}
            self.visited_lines[frame] = set()
        if not active:
            return False
        innermost = active[-1]
        self.current_line = int(innermost["line"])
        self.current_frame = self.frames[-1][0]
        self.visited_lines[self.current_frame].add(self.current_line)
        self.observe_loops(self.current_frame, self.current_line, innermost.get("addr", ""))
        waiting = self.pending_branches.get(self.current_frame)
        if waiting is not None and self.current_line != waiting[0]:
            branch_line, expression, branch_kind, body_line = waiting
            self.emit(
                "branch",
                frame=self.current_frame,
                path=self.source.name,
                line=branch_line,
                kind=branch_kind,
                expr=expression,
                outcome="taken" if self.current_line == body_line else "not_taken",
            )
            del self.pending_branches[self.current_frame]
        source_lines = self.source.read_text(encoding="utf-8").splitlines()
        match = re.match(
            r"^\s*(?:}\s*)?(else\s+)?if\s*\((.*)\)\s*\{?\s*$", source_lines[self.current_line - 1]
        )
        if match and self.current_frame not in self.pending_branches:
            body_line = self.current_line + 1
            while body_line <= len(source_lines) and not source_lines[body_line - 1].strip():
                body_line += 1
            self.pending_branches[self.current_frame] = (
                self.current_line,
                match.group(2).strip(),
                "elif" if match.group(1) else "if",
                body_line,
            )
        self.emit(
            "step_line", frame=self.current_frame, line=self.current_line, path=self.source.name
        )
        for entry in active:
            frame = self.frames[active.index(entry)][0]
            level = entry["level"]
            selected, _ = debugger.command(f"-stack-select-frame {level}")
            if selected.name != "done":
                continue
            variables, _ = debugger.command("-stack-list-variables --all-values")
            if variables.name != "done":
                continue
            current: dict[str, dict[str, Any]] = {}
            for variable in variables.value.get("variables", []):
                name = variable.get("name", "")
                if not name:
                    continue
                raw_value = variable.get("value")
                declaration = self.declarations.get((entry.get("func", ""), name))
                if declaration and name not in self.parameters.get(frame, set()):
                    declared_line, has_initializer = declaration
                    key = (frame, name)
                    if raw_value is not None:
                        self.local_baselines.setdefault(key, raw_value)
                    if int(entry["line"]) <= declared_line:
                        continue
                    if has_initializer and declared_line not in self.visited_lines[frame]:
                        continue
                    if not has_initializer and key not in self.initialized_locals:
                        if raw_value == self.local_baselines.get(key):
                            continue
                        self.initialized_locals.add(key)
                value = native_value(raw_value, self.source, "", 0)
                if "addr" in value:
                    address = address_of(value["addr"])
                    if address in self.freed and address not in self.allocations:
                        value["dangling"] = True
                    elif address in self.allocations and entry is innermost:
                        obj, size = self.allocations[address]
                        memory = self.memory_bytes(debugger, address, size)
                        if address in self.raw_bytes and memory is not None:
                            if memory != self.raw_bytes[address]:
                                self.initialized.add(address)
                            self.raw_bytes[address] = memory
                        width, _ = debugger.command(
                            f"-data-evaluate-expression {json.dumps('sizeof(*' + name + ')')}"
                        )
                        readable = (
                            width.name == "done"
                            and width.value.get("value", "").isdigit()
                            and int(width.value["value"]) <= size
                        )
                        observed, _ = (
                            debugger.command(f"-data-evaluate-expression {json.dumps('*' + name)}")
                            if readable
                            else (None, [])
                        )
                        contents = (
                            native_value(observed.value.get("value"), self.source, "", 0)
                            if observed is not None
                            and observed.name == "done"
                            and address in self.initialized
                            else {
                                "unavailable": "pointee cannot be read"
                                if not readable
                                else "malloc memory has no observed write"
                            }
                        )
                        element_width = int(width.value["value"]) if readable else 0
                        self.announce_object(debugger, name, address, obj, size, element_width)
                        count = size // element_width if element_width and size <= 256 else 0
                        if self.object_kinds[obj] == "struct":
                            if address in self.initialized and readable:
                                self.inspect_fields(debugger, name, address, obj)
                        elif 1 < count <= 16 and size % element_width == 0:
                            self.inspect_elements(
                                debugger, name, address, obj, count, element_width
                            )
                        else:
                            self.set_slot(obj, "value", contents)
                current[name] = value
                prior = self.bindings[frame].get(name)
                if prior != value:
                    if "addr" in value:
                        addr = address_of(value["addr"])
                        pointer = {
                            "frame": frame,
                            "name": name,
                            "to_addr": addr,
                            "valid": addr in self.allocations,
                            "dangling": addr in self.freed and addr not in self.allocations,
                        }
                        if addr in self.allocations:
                            pointer["obj"] = self.allocations[addr][0]
                        if prior and "addr" in prior:
                            pointer["prev_addr"] = address_of(prior["addr"])
                        self.emit("ptr_set", **pointer)
                    payload = {
                        "frame": frame,
                        "name": name,
                        "value": value,
                        "scope": "param" if name in self.parameters.get(frame, set()) else "local",
                        "declared": prior is None,
                    }
                    if prior is not None:
                        payload["prev"] = prior
                    self.emit("var_set", **payload)
            for name, old in self.bindings[frame].items():
                if name not in current:
                    self.emit("var_del", frame=frame, name=name, prev=old)
            self.bindings[frame] = current
        return True

    def announce_object(
        self,
        debugger: MIClient | None,
        name: str,
        address: str,
        obj: int,
        size: int,
        width: int = 0,
    ) -> None:
        if obj in self.announced_objects:
            return
        type_name = "native allocation (type unavailable)"
        kind = "opaque"
        length: int | None = None
        if debugger is not None and name:
            result, _ = debugger.command(f"-var-create - * {json.dumps('*' + name)}")
            if result.name == "done":
                type_name = result.value.get("type", type_name)
                debugger.command(f"-var-delete {result.value['name']}")
                kind = "struct" if type_name.startswith(("struct ", "union ")) else "pointer"
                if kind != "struct" and width and size > width and size % width == 0:
                    kind = "array"
                    length = size // width
        payload: dict[str, Any] = {
            "obj": obj,
            "kind": kind,
            "type_name": type_name,
            "addr": address,
            "size": size,
        }
        if length is not None:
            payload["length"] = length
        self.emit("obj_new", **payload)
        self.announced_objects.add(obj)
        self.object_kinds[obj] = kind

    def set_slot(self, obj: int, key: str, value: dict[str, Any]) -> None:
        old = self.object_slots.setdefault(obj, {}).get(key)
        if old == value:
            return
        payload = {"obj": obj, "key": key, "value": value, "op": "set"}
        if old is not None:
            payload["prev"] = old
        self.emit("obj_set", **payload)
        self.object_slots[obj][key] = value

    def inspect_elements(
        self, debugger: MIClient, name: str, address: str, obj: int, count: int, width: int
    ) -> None:
        """Read bounded C pointer-indexed storage without exposing unwritten malloc bytes."""
        baseline = self.original_bytes.get(address)
        current = self.raw_bytes.get(address)
        for index in range(count):
            offset = index * width * 2
            initialized = address in self.zero_initialized or (
                address in self.initialized
                and baseline is not None
                and current is not None
                and baseline[offset : offset + width * 2] != current[offset : offset + width * 2]
            )
            result, _ = (
                debugger.command(
                    f"-data-evaluate-expression {json.dumps(name + '[' + str(index) + ']')}"
                )
                if initialized
                else (None, [])
            )
            value = (
                native_value(result.value.get("value"), self.source, "", 0)
                if result is not None and result.name == "done"
                else {"unavailable": "array element has no observed write"}
            )
            if "addr" in value:
                target = address_of(value["addr"])
                if target in self.allocations:
                    value = {"ref": self.allocations[target][0]}
                elif target in self.freed_objects:
                    value = {"ref": self.freed_objects[target]}
            self.set_slot(obj, str(index), value)

    def inspect_fields(self, debugger: MIClient, name: str, address: str, obj: int) -> None:
        """Read struct fields through GDB; do not expose bytes unchanged since malloc."""
        created, _ = debugger.command(f"-var-create - * {json.dumps('*' + name)}")
        if created.name != "done":
            return
        variable = created.value["name"]
        try:
            count = int(created.value.get("numchild", "0"))
            if count < 1 or count > 32:
                return
            result, _ = debugger.command(f"-var-list-children --all-values {variable}")
            if result.name != "done":
                return
            raw = result.value.get("children", {})
            fields = raw.get("child", []) if isinstance(raw, dict) else []
            if isinstance(fields, dict):
                fields = [fields]
            baseline = self.original_bytes.get(address)
            current = self.raw_bytes.get(address)
            for field in fields:
                key = field.get("exp", "")
                if not re.fullmatch(r"[A-Za-z_]\w*", key):
                    continue
                expr = f"{name}->{key}"
                offset_result, _ = debugger.command(
                    f"-data-evaluate-expression {json.dumps('&(' + expr + ')')}"
                )
                size_result, _ = debugger.command(
                    f"-data-evaluate-expression {json.dumps('sizeof(' + expr + ')')}"
                )
                changed = False
                if offset_result.name == size_result.name == "done" and baseline and current:
                    try:
                        offset = int(address_of(offset_result.value["value"]), 16) - int(
                            address, 16
                        )
                        width = int(size_result.value["value"])
                        if (
                            offset >= 0
                            and 0 < width <= 256
                            and (offset + width) * 2 <= len(current)
                        ):
                            changed = (
                                address in self.zero_initialized
                                or baseline[offset * 2 : (offset + width) * 2]
                                != current[offset * 2 : (offset + width) * 2]
                            )
                    except (ValueError, KeyError):
                        pass
                value = (
                    native_value(field.get("value"), self.source, "", 0)
                    if changed
                    else {"unavailable": "field has no observed write"}
                )
                if "addr" in value:
                    target = address_of(value["addr"])
                    if target in self.allocations:
                        value = {"ref": self.allocations[target][0]}
                    elif target in self.freed_objects:
                        value = {"ref": self.freed_objects[target]}
                    else:
                        value["type"] = field.get("type", "unknown pointer")
                old = self.object_slots.setdefault(obj, {}).get(key)
                if old != value:
                    payload = {"obj": obj, "key": key, "value": value, "op": "set"}
                    if old is not None:
                        payload["prev"] = old
                    self.emit("obj_set", **payload)
                    self.object_slots[obj][key] = value
        finally:
            debugger.command(f"-var-delete {variable}")

    def memory_bytes(self, debugger: MIClient, address: str, size: int) -> str | None:
        if size < 1 or size > 256:
            return None  # Bounded inspection; never read past the reported allocation.
        result, _ = debugger.command(f"-data-read-memory-bytes {address} {size}")
        if result.name != "done":
            return None
        blocks = result.value.get("memory", [])
        return blocks[0].get("contents") if isinstance(blocks, list) and blocks else None

    def close_loops(self, frame: int, reason: str) -> None:
        keys = sorted((key for key in self.loop_states if key[0] == frame), reverse=True)
        for key in keys:
            state = self.loop_states.pop(key)
            self.emit(
                "loop_exit",
                region=state["region"],
                iterations=state["iterations"],
                reason=reason,
                frame=frame,
            )

    def observe_loops(self, frame: int, line: int, pc: str) -> None:
        for key in sorted(self.loop_states, reverse=True):
            if key[0] != frame or key[1] <= line <= self.loop_states[key]["end"]:
                continue
            state = self.loop_states.pop(key)
            previous = self.source.read_text(encoding="utf-8").splitlines()[state["last_line"] - 1]
            reason = "break" if re.match(r"\s*break\s*;", previous) else "condition"
            if reason == "break":
                self.emit(
                    "jump",
                    kind="break",
                    frame=frame,
                    path=self.source.name,
                    line=state["last_line"],
                    target_line=line,
                )
            self.emit(
                "loop_exit",
                region=state["region"],
                iterations=state["iterations"],
                reason=reason,
                frame=frame,
            )
        for start, end in sorted(self.loop_ranges):
            if not start <= line <= end:
                continue
            key = (frame, start)
            if key not in self.loop_states:
                region = self.next_region
                self.next_region += 1
                self.loop_states[key] = {
                    "region": region,
                    "end": end,
                    "iterations": 0,
                    "first_pc": None,
                    "last_pc": None,
                    "last_line": line,
                }
                self.emit("loop_enter", region=region, line_start=start, line_end=end, frame=frame)
            state = self.loop_states[key]
            body_line = self.loop_bodies[(start, end)]
            if line == body_line and pc:
                if state["first_pc"] is None:
                    state["first_pc"] = pc
                    new_iteration = True
                else:
                    new_iteration = pc == state["first_pc"] and state["last_pc"] != pc
                if new_iteration:
                    self.emit(
                        "loop_iter", region=state["region"], i=state["iterations"], frame=frame
                    )
                    self.emit("metric", name="iteration", delta=1, region=state["region"])
                    state["iterations"] += 1
            state["last_pc"] = pc
            state["last_line"] = line

    def try_fold_loop(self, debugger: MIClient) -> Record | None:
        """Fast-forward only a pure counted loop; derive iterations and deltas from GDB state."""
        line = self.current_line
        text = self.source_lines[line - 1]
        match = re.fullmatch(
            r"\s*for\s*\(\s*;\s*(\w+)\s*<\s*(\d+)\s*;\s*\1\s*\+\+\s*\)\s*\{\s*",
            text,
        )
        if not match or int(match.group(2)) < 100:
            return None
        loop_range = next(((start, end) for start, end in self.loop_ranges if start == line), None)
        if loop_range is None:
            return None
        start, end = loop_range
        body = self.source_lines[start : end - 1]
        if not body or not all(
            re.fullmatch(r"\s*\w+\s*\+=\s*[\w\d]+\s*;\s*", part) for part in body
        ):
            return None
        before = self.bindings[self.current_frame].copy()
        counter = match.group(1)
        if counter not in before or not isinstance(before[counter].get("prim"), int):
            return None
        destination = end + 1
        while (
            destination <= len(self.source_lines) and not self.source_lines[destination - 1].strip()
        ):
            destination += 1
        if destination > len(self.source_lines):
            return None
        advanced, records = debugger.command(f"-exec-until {self.source.as_posix()}:{destination}")
        self.output(records)
        if advanced.name != "running":
            raise RuntimeError(f"Could not advance counted C loop: {advanced.value}")
        stopped, records = debugger.stop()
        self.output(records)
        if stopped.value.get("reason") != "location-reached":
            return stopped
        observed, _ = debugger.command("-stack-list-variables --all-values")
        if observed.name != "done":
            raise RuntimeError("GDB could not inspect state after counted loop")
        after = {
            v["name"]: native_value(v.get("value"), self.source, "", 0)
            for v in observed.value.get("variables", [])
            if v.get("name") in before
        }
        end_counter = after.get(counter, {}).get("prim")
        iterations = end_counter - before[counter]["prim"] if isinstance(end_counter, int) else 0
        if iterations < 100 or iterations > int(match.group(2)):
            raise RuntimeError("Counted loop did not match observed iteration bounds")
        effects = [
            {
                "kind": "var",
                "frame": self.current_frame,
                "key": name,
                "before": old,
                "after": after[name],
            }
            for name, old in before.items()
            if name in after and old != after[name]
        ]
        if not effects or any("prim" not in effect["after"] for effect in effects):
            raise RuntimeError("Counted loop had no safely representable scalar effects")
        region = self.loop_states[(self.current_frame, line)]
        seq = self.seq
        self.emit(
            "collapse",
            region=region["region"],
            from_seq=seq,
            to_seq=seq,
            iterations=iterations,
            from_iter=0,
            to_iter=iterations - 1,
            effects=effects,
            metrics={"iteration": iterations},
            frame=self.current_frame,
        )
        self.bindings[self.current_frame].update(after)
        region["iterations"] = iterations
        return stopped

    def loop_instruction_mode(self, line_text: str) -> bool:
        """Instruction-step a loop body so a one-line back edge cannot hang source stepping."""
        line = self.current_line
        if re.search(r"\b(?:while|for)\s*\(", line_text):
            lines = self.source.read_text(encoding="utf-8").splitlines()
            balance = 0
            end = line
            for index in range(line - 1, len(lines)):
                balance += lines[index].count("{") - lines[index].count("}")
                end = index + 1
                if balance <= 0:
                    break
            self.loop_ranges.add((line, end))
            body = line if end == line else line + 1
            while body < end and lines[body - 1].strip() in {"", "{"}:
                body += 1
            self.loop_bodies[(line, end)] = body
        return any(start <= line <= end for start, end in self.loop_ranges)

    def capture_return(self, debugger: MIClient) -> None:
        """Read the ABI result *before* the return instruction executes.

        After a source-level step, the caller may already have transformed the return register,
        so sampling it at frame-pop would fabricate a different return value.
        """
        frame = self.current_frame
        if frame not in self.return_modes or not self.returns_integer(self.frames[-1][1]):
            return
        disassembly, _ = debugger.command('-data-disassemble -s $pc -e "$pc+16" -- 0')
        instructions = disassembly.value.get("asm_insns", []) if disassembly.name == "done" else []
        if not isinstance(instructions, list) or not instructions:
            return
        if not re.search(r"\bret(?:q)?\b", instructions[0].get("inst", "")):
            return
        register, _ = debugger.command('-data-evaluate-expression "$rax"')
        if register.name == "done":
            self.return_values[frame] = native_value(
                register.value.get("value"), self.source, "", 0
            )

    def returns_integer(self, func: str) -> bool:
        source = self.source.read_text(encoding="utf-8")
        return bool(re.search(rf"\b(?:int|long|short)\s+{re.escape(func)}\s*\(", source))

    def is_user_frame(self, entry: dict[str, Any]) -> bool:
        name = entry.get("fullname") or entry.get("file")
        return bool(name and Path(name).resolve() == self.source.resolve())

    def input_stop(
        self, debugger: MIClient, stopped: Record, breakpoints: dict[str, str], input_path: Path
    ) -> Record | None:
        if stopped.value.get("reason") != "breakpoint-hit":
            return None
        if stopped.value.get("bkptno") not in breakpoints:
            return None
        stack, _ = debugger.command("-stack-list-frames")
        raw = stack.value.get("stack", {}) if stack.name == "done" else {}
        levels = raw.get("frame", []) if isinstance(raw, dict) else []
        if isinstance(levels, dict):
            levels = [levels]
        if len(levels) < 2 or not self.is_user_frame(levels[1]):
            return None
        # Redirected stdout is block-buffered. Flush the *actual* C stream before asking,
        # as a terminal would when a program waits for stdin; never invent prompt text.
        flushed, records = debugger.command(
            f"-data-evaluate-expression {json.dumps('(int)fflush((void*)0)')}"
        )
        self.output(records)
        if flushed.name == "done":
            self.drain_output()
        self.emit(
            "stdin_request",
            frame=self.current_frame,
            line=self.current_line,
            path=self.source.name,
            prompt=self.last_stdout,
        )
        self.last_stdout = ""
        before = time.monotonic()
        answer = sys.stdin.buffer.readline()
        waited = (time.monotonic() - before) * 1000
        self.idle_ms += waited
        with input_path.open("ab") as stream:
            stream.write(answer if answer.endswith(b"\n") else answer + b"\n")
            stream.flush()
        advanced, records = debugger.command("-exec-finish")
        self.output(records)
        if advanced.name != "running":
            raise RuntimeError(f"GDB input call did not resume: {advanced.value}")
        returned, records = debugger.stop()
        self.output(records)
        self.emit(
            "stdin_response",
            text=answer.decode("utf-8", "replace").rstrip("\r\n"),
            source="interactive",
            waited_ms=round(waited, 2),
        )
        return returned

    def release(self, address: str, via: str) -> None:
        allocation = self.allocations.pop(address, None)
        if allocation is None:
            return
        self.announce_object(None, "", address, allocation[0], allocation[1])
        self.emit("mem_free", addr=address, via=via)
        self.emit("obj_free", obj=allocation[0])
        self.object_slots.pop(allocation[0], None)
        self.raw_bytes.pop(address, None)
        self.original_bytes.pop(address, None)
        self.initialized.discard(address)
        self.zero_initialized.discard(address)
        self.freed.add(address)
        self.freed_objects[address] = allocation[0]

    def allocation_stop(
        self, debugger: MIClient, stopped: Record, breakpoints: dict[str, str]
    ) -> tuple[Record, list[Record]] | None:
        """Observe actual allocator calls and returns, never infer allocation from a pointer."""
        if stopped.value.get("reason") != "breakpoint-hit":
            return None
        number = stopped.value.get("bkptno")
        operation = breakpoints.get(number)
        if operation is None:
            return None
        stack, _ = debugger.command("-stack-list-frames")
        raw = stack.value.get("stack", {}) if stack.name == "done" else {}
        levels = raw.get("frame", []) if isinstance(raw, dict) else []
        if isinstance(levels, dict):
            levels = [levels]
        # Calls made inside libc are not allocations requested by the user's source.
        direct_user = len(levels) > 1 and self.is_user_frame(levels[1])
        first = "$rcx" if sys.platform == "win32" else "$rdi"
        second = "$rdx" if sys.platform == "win32" else "$rsi"
        argument, _ = debugger.command(f'-data-evaluate-expression "{first}"')
        raw_arg = argument.value.get("value", "") if argument.name == "done" else ""
        extra, _ = debugger.command(f'-data-evaluate-expression "{second}"')
        raw_extra = extra.value.get("value", "") if extra.name == "done" else ""
        ids = " ".join(breakpoints)
        if ids:
            debugger.command(f"-break-disable {ids}")
        try:
            advanced, records = debugger.command("-exec-finish")
            self.output(records)
            if advanced.name != "running":
                raise RuntimeError(f"GDB could not finish {operation}: {advanced.value}")
            returned, records = debugger.stop()
            self.output(records)
        finally:
            if ids and debugger.process.poll() is None:
                debugger.command(f"-break-enable {ids}")
        if not direct_user:
            return returned, []
        if operation in ("malloc", "calloc"):
            retval, _ = debugger.command('-data-evaluate-expression "$rax"')
            address = address_of(retval.value.get("value", "")) if retval.name == "done" else ""
            try:
                size = int(raw_arg) * (int(raw_extra) if operation == "calloc" else 1)
            except ValueError:
                size = 0
            if address and address != "0x0" and size > 0:
                obj = self.next_object
                self.next_object += 1
                self.allocations[address] = (obj, size)
                self.freed.discard(address)
                self.freed_objects.pop(address, None)
                self.initialized.discard(address)
                self.zero_initialized.discard(address)
                baseline = self.memory_bytes(debugger, address, size)
                if baseline is not None:
                    self.raw_bytes[address] = baseline
                    self.original_bytes[address] = baseline
                    if operation == "calloc" and set(baseline) <= {"0"}:
                        self.initialized.add(address)
                        self.zero_initialized.add(address)
                self.emit("mem_alloc", addr=address, size=size, region="heap", via=operation)
        elif operation == "realloc":
            old_address = address_of(raw_arg) if raw_arg else ""
            old_allocation = self.allocations.get(old_address)
            retval, _ = debugger.command('-data-evaluate-expression "$rax"')
            address = address_of(retval.value.get("value", "")) if retval.name == "done" else ""
            try:
                size = int(raw_extra)
            except ValueError:
                size = 0
            if address and address != "0x0" and size > 0:
                previous_initialized = old_address in self.initialized
                if address == old_address and old_allocation is not None:
                    obj, old_size = old_allocation
                    self.announce_object(None, "", address, obj, old_size)
                    self.allocations[address] = (obj, size)
                    self.emit("mem_alloc", addr=address, size=size, region="heap", via="realloc")
                    self.emit("obj_resize", obj=obj, length=size, prev_length=old_size)
                else:
                    if old_allocation is not None:
                        self.release(old_address, "realloc")
                    obj = self.next_object
                    self.next_object += 1
                    self.allocations[address] = (obj, size)
                    self.freed.discard(address)
                    self.freed_objects.pop(address, None)
                    baseline = self.memory_bytes(debugger, address, size)
                    if baseline is not None:
                        self.raw_bytes[address] = baseline
                        self.original_bytes[address] = baseline
                    if previous_initialized:
                        self.initialized.add(address)
                    self.emit("mem_alloc", addr=address, size=size, region="heap", via="realloc")
        elif operation == "free":
            address = address_of(raw_arg) if raw_arg else ""
            self.release(address, "free")
        return returned, []


def address_of(raw: str) -> str:
    first = raw.split()[0]
    return hex(int(first, 16 if first.lower().startswith("0x") else 10))


def native_value(raw: str | None, source: Path, name: str, line: int) -> dict[str, Any]:
    if raw is None or raw in {"<optimized out>", "<unavailable>"}:
        return {"unavailable": raw or "debugger could not read value"}
    terminator = re.search(r"\\(?:0{1,3}|x00)", raw) if raw.startswith('"') else None
    if terminator:
        try:
            return {"prim": ast.literal_eval(raw[: terminator.start()] + '"')}
        except (ValueError, SyntaxError):
            pass
    char = re.fullmatch(r"[-+]?\d+\s+'((?:\\.|[^'])*)'", raw)
    if char:
        return {"prim": ast.literal_eval("'" + char.group(1) + "'")}
    if raw.startswith("0x") and re.match(r"^0x[0-9a-fA-F]+(?:\s|$)", raw):
        return {"addr": raw.split()[0], "type": "unknown pointer"}
    if re.fullmatch(r"[-+]?\d+", raw):
        number = int(raw)
        return {"prim": number} if abs(number) <= 2**53 - 1 else {"prim": raw, "bigint": True}
    if re.fullmatch(r"[-+]?\d+\.\d+(?:[eE][-+]?\d+)?", raw):
        return {"prim": float(raw)}
    if raw in {"true", "false"}:
        return {"prim": raw == "true"}
    # GDB's pretty-print format for structs/arrays is not a primitive or stable identity.
    return {"unavailable": "Debugger value cannot be represented faithfully"}


def compiler_version() -> str:
    compiler = shutil.which("gcc")
    if not compiler:
        return "compiler unavailable"
    try:
        return subprocess.run(
            [compiler, "--version"], capture_output=True, text=True, timeout=3, check=False
        ).stdout.splitlines()[0]
    except (OSError, subprocess.SubprocessError, IndexError):
        return "compiler unavailable"


def run(args: argparse.Namespace) -> int:
    source = Path(args.source).resolve()
    trace = Trace(source, args)
    trace.header()
    trace.emit("run_start")
    binary = source.with_name(
        "flow_view_program.exe" if sys.platform == "win32" else "flow_view_program"
    )
    try:
        build = subprocess.run(
            ["gcc", "-g", "-O0", "-fno-omit-frame-pointer", str(source), "-o", str(binary)],
            capture_output=True,
            text=True,
            timeout=max(1, args.wall_ms / 1000),
            check=False,
        )
        if build.returncode:
            trace.emit("note", level="warn", text=f"C compilation failed: {build.stderr[:3000]}")
            trace.end("error", build.returncode)
            return 1
        with MIClient(timeout=max(1, args.wall_ms / 1000)) as debugger:
            loaded, _ = debugger.command(f"-file-exec-and-symbols {json.dumps(binary.as_posix())}")
            breakpoint, _ = debugger.command("-break-insert main")
            if loaded.name != "done" or breakpoint.name != "done":
                raise RuntimeError("GDB could not load the executable or locate main")
            input_path = source.with_name(".flow_view_stdin")
            input_path.write_bytes(b"")
            trace.output_path = source.with_name(".flow_view_stdout")
            trace.error_path = source.with_name(".flow_view_stderr")
            trace.output_path.write_bytes(b"")
            trace.error_path.write_bytes(b"")
            debugger.watch_output((trace.output_path, trace.error_path), args.output_bytes)
            startup = (
                f"run < {json.dumps(input_path.as_posix())} "
                f"> {json.dumps(trace.output_path.as_posix())} "
                f"2> {json.dumps(trace.error_path.as_posix())}"
            )
            started, records = debugger.command(f"-interpreter-exec console {json.dumps(startup)}")
            trace.output(records)
            if started.name != "running":
                raise RuntimeError(f"GDB could not start the program: {started.value}")
            allocation_breakpoints: dict[str, str] = {}
            input_breakpoints: dict[str, str] = {}
            first_stop = True
            pending_stop: Record | None = None
            while True:
                if pending_stop is None:
                    stopped, records = debugger.stop()
                    trace.output(records)
                else:
                    stopped = pending_stop
                    pending_stop = None
                trace.drain_output()
                if first_stop and stopped.value.get("reason") == "breakpoint-hit":
                    first_stop = False
                    for operation in ("malloc", "calloc", "realloc", "free"):
                        result, _ = debugger.command(f"-break-insert {operation}")
                        if result.name == "done":
                            allocation_breakpoints[result.value["bkpt"]["number"]] = operation
                    # glibc rewrites scanf/fscanf calls to ISO-versioned symbols at link time.
                    # Break at the symbol actually called, not only the source-level spelling.
                    for operation in (
                        "scanf",
                        "__isoc99_scanf",
                        "__isoc23_scanf",
                        "fscanf",
                        "__isoc99_fscanf",
                        "__isoc23_fscanf",
                        "fgets",
                        "__fgets_chk",
                        "getchar",
                        "getc",
                    ):
                        result, _ = debugger.command(f"-break-insert {operation}")
                        if result.name == "done":
                            input_breakpoints[result.value["bkpt"]["number"]] = operation
                answer_stop = trace.input_stop(debugger, stopped, input_breakpoints, input_path)
                if answer_stop is not None:
                    pending_stop = answer_stop
                    continue
                allocation = trace.allocation_stop(debugger, stopped, allocation_breakpoints)
                if allocation is not None:
                    pending_stop = allocation[0]
                    continue
                reason = stopped.value.get("reason")
                if reason and reason.startswith("exited"):
                    code = int(stopped.value.get("exit-code", "0"), 8)
                    trace.end("ok" if code == 0 else "error", code)
                    return code
                if reason == "signal-received":
                    signal_name = str(stopped.value.get("signal-name", "signal"))
                    frames, _ = debugger.command("-stack-list-frames")
                    raw = frames.value.get("stack", {}) if frames.name == "done" else {}
                    entries = raw.get("frame", []) if isinstance(raw, dict) else []
                    if isinstance(entries, dict):
                        entries = [entries]
                    stack = [
                        {
                            "func": item.get("func", "<unknown>"),
                            "path": source.name,
                            "line": int(item.get("line", 1)),
                        }
                        for item in entries
                        if trace.is_user_frame(item)
                    ]
                    signal_message = str(stopped.value.get("signal-meaning", signal_name))
                    trace.emit("exception_raise", type=signal_name, message=signal_message)
                    trace.emit(
                        "exception_uncaught",
                        type=signal_name,
                        message=signal_message,
                        stack=stack,
                    )
                    trace.end("error", 1)
                    return 1
                at_user_source = trace.inspect(debugger, stopped)
                if at_user_source and trace.step + 100 < args.max_steps:
                    folded = trace.try_fold_loop(debugger)
                    if folded is not None:
                        pending_stop = folded
                        continue
                if trace.step >= args.max_steps:
                    trace.emit("note", level="warn", text=f"Stopped after {args.max_steps} steps.")
                    trace.end("step_limit")
                    return 0
                if trace.elapsed() >= args.wall_ms:
                    trace.end("timeout")
                    return 0
                line_text = source.read_text(encoding="utf-8").splitlines()[trace.current_line - 1]
                # GDB's source step may run past a return and let the caller overwrite RAX.
                # Instruction-step only on return lines; capture the register at `ret`.
                if at_user_source and re.search(r"\breturn\b", line_text):
                    trace.return_modes.add(trace.current_frame)
                elif at_user_source and line_text.strip() not in {"}", "};"}:
                    trace.return_modes.discard(trace.current_frame)
                if at_user_source:
                    trace.capture_return(debugger)
                instruction = (
                    "-exec-finish"
                    if not at_user_source
                    else "-exec-step-instruction"
                    if trace.current_frame in trace.return_modes
                    or trace.loop_instruction_mode(line_text)
                    else "-exec-step"
                )
                advanced, records = debugger.command(instruction)
                trace.output(records)
                if advanced.name != "running":
                    raise RuntimeError(f"GDB stepping failed: {advanced.value}")
    except (TimeoutError, subprocess.TimeoutExpired) as error:
        if "debugger" in locals() and debugger.output_exceeded:
            trace.emit("note", level="warn", text="C output exceeded the bounded output file.")
            trace.end("killed")
            return 1
        trace.emit("note", level="warn", text=f"C execution timed out: {error}")
        trace.end("timeout")
        return 1
    except (OSError, RuntimeError, ValueError) as error:
        if "debugger" in locals() and debugger.output_exceeded:
            trace.emit("note", level="warn", text="C output exceeded the bounded output file.")
            trace.end("killed")
            return 1
        trace.emit("note", level="warn", text=f"C debugger failed: {error}")
        trace.end("error", 1)
        return 1


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True)
    parser.add_argument("--session-id", default="local")
    parser.add_argument("--max-steps", type=int, default=200000)
    parser.add_argument("--wall-ms", type=int, default=30000)
    parser.add_argument("--memory-mb", type=int, default=512)
    parser.add_argument("--output-bytes", type=int, default=1048576)
    return run(parser.parse_args())


if __name__ == "__main__":
    sys.exit(main())
