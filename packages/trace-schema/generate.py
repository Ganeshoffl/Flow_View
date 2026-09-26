#!/usr/bin/env python3
"""Generate the trace schema artifacts from the single source of truth.

    model/trace.model.json
            |
            +--> generated/trace.schema.json   JSON Schema (draft 2020-12), the validator
            +--> generated/types.ts            TypeScript types + guards for the UI
            +--> generated/events.py           Python TypedDicts + constants for adapters

Run with --check to verify committed output is current; CI uses that to fail a build where
the model changed but generated files were not regenerated.

Deliberately dependency-free: it runs with a bare interpreter, and the Python it emits
imports nothing outside the standard library, because the tracer must stay zero-dependency
so the identical code can run inside Pyodide.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).parent
MODEL = ROOT / "model" / "trace.model.json"

# Each artifact is emitted where its consumer expects to import it from, rather than into one
# shared folder that every consumer then has to reach across package boundaries to read.
ARTIFACT_PATHS = {
    "trace.schema.json": ROOT / "generated" / "trace.schema.json",
    "types.ts": ROOT / "src" / "generated" / "types.ts",
    "events.py": ROOT / "python" / "flow_view_schema" / "events.py",
}

BANNER_LINES = [
    "DO NOT EDIT. Generated from packages/trace-schema/model/trace.model.json",
    "Regenerate with: pnpm schema:gen",
]

# ---------------------------------------------------------------------------
# type language
# ---------------------------------------------------------------------------
# A field type is either a shorthand string or {"t": <type>, "opt": bool, "doc": str}.
# Type strings:
#     int | float | bool | string | primitive | any
#     enum:<EnumName>
#     array:<type>
#     map:<valuetype>            (keys are always strings)
#     <StructName> | Value

SCALARS = {"int", "float", "bool", "string", "primitive", "any"}


def norm_field(spec: Any) -> dict[str, Any]:
    if isinstance(spec, str):
        return {"t": spec, "opt": False, "doc": None}
    return {"t": spec["t"], "opt": bool(spec.get("opt", False)), "doc": spec.get("doc")}


class Model:
    def __init__(self, raw: dict[str, Any]) -> None:
        self.raw = raw
        self.schema_id: str = raw["schema_id"]
        self.version_major: int = raw["version_major"]
        self.doc: str = raw["doc"]
        self.enums: dict[str, Any] = raw["enums"]
        self.unions: dict[str, Any] = raw["unions"]
        self.structs: dict[str, Any] = raw["structs"]
        self.common: dict[str, Any] = {k: norm_field(v) for k, v in raw["common_fields"].items()}
        self.events: dict[str, Any] = raw["events"]

    def event_fields(self, name: str) -> dict[str, dict[str, Any]]:
        return {k: norm_field(v) for k, v in self.events[name].get("fields", {}).items()}

    def struct_fields(self, name: str) -> dict[str, dict[str, Any]]:
        return {k: norm_field(v) for k, v in self.structs[name]["fields"].items()}

    def validate(self) -> list[str]:
        """Catch model mistakes here rather than letting them become broken output."""
        errs: list[str] = []
        known = SCALARS | set(self.enums) | set(self.unions) | set(self.structs)

        def check(t: str, where: str) -> None:
            if t.startswith("array:"):
                return check(t[6:], where)
            if t.startswith("map:"):
                return check(t[4:], where)
            if t.startswith("enum:"):
                if t[5:] not in self.enums:
                    errs.append(f"{where}: unknown enum {t[5:]!r}")
                return None
            if t not in known:
                errs.append(f"{where}: unknown type {t!r}")
            return None

        for sname in self.structs:
            for fname, f in self.struct_fields(sname).items():
                check(f["t"], f"struct {sname}.{fname}")
        for uname, u in self.unions.items():
            for vname, v in u["variants"].items():
                for fname, spec in v["fields"].items():
                    check(norm_field(spec)["t"], f"union {uname}.{vname}.{fname}")
        for ename in self.events:
            for fname, f in self.event_fields(ename).items():
                check(f["t"], f"event {ename}.{fname}")
            if set(self.event_fields(ename)) & set(self.common):
                errs.append(f"event {ename}: redeclares a common field")
        return errs


# ---------------------------------------------------------------------------
# JSON Schema
# ---------------------------------------------------------------------------


def js_type(t: str) -> dict[str, Any]:
    if t == "int":
        return {"type": "integer"}
    if t == "float":
        return {"type": "number"}
    if t == "bool":
        return {"type": "boolean"}
    if t == "string":
        return {"type": "string"}
    if t == "primitive":
        return {"type": ["null", "boolean", "integer", "number", "string"]}
    if t == "any":
        return {}
    if t.startswith("enum:"):
        return {"$ref": f"#/$defs/{t[5:]}"}
    if t.startswith("array:"):
        return {"type": "array", "items": js_type(t[6:])}
    if t.startswith("map:"):
        return {"type": "object", "additionalProperties": js_type(t[4:])}
    return {"$ref": f"#/$defs/{t}"}


def js_fields(fields: dict[str, dict[str, Any]]) -> tuple[dict[str, Any], list[str]]:
    props: dict[str, Any] = {}
    required: list[str] = []
    for name, f in fields.items():
        node = js_type(f["t"])
        if f["doc"]:
            node = {**node, "description": f["doc"]}
        props[name] = node
        if not f["opt"]:
            required.append(name)
    return props, required


def gen_json_schema(m: Model) -> str:
    defs: dict[str, Any] = {}

    for name, e in m.enums.items():
        defs[name] = {"description": e["doc"], "enum": e["values"]}

    for name, u in m.unions.items():
        variants = []
        for vname, v in u["variants"].items():
            props, required = js_fields({k: norm_field(s) for k, s in v["fields"].items()})
            variants.append(
                {
                    "title": vname,
                    "description": v["doc"],
                    "type": "object",
                    "properties": props,
                    "required": required,
                    "additionalProperties": False,
                }
            )
        defs[name] = {
            "description": f"{u['doc']} {u['discriminator_note']}",
            "oneOf": variants,
        }

    for name in m.structs:
        props, required = js_fields(m.struct_fields(name))
        defs[name] = {
            "description": m.structs[name]["doc"],
            "type": "object",
            "properties": props,
            "required": required,
            "additionalProperties": False,
        }

    common_props, common_required = js_fields(m.common)

    event_defs: list[dict[str, Any]] = []
    for name in m.events:
        ev = m.events[name]
        props, required = js_fields(m.event_fields(name))
        merged_props = {**common_props, **props, "t": {"const": name}}
        merged_required = sorted(set(common_required) | set(required) | {"t"})
        def_name = f"Event_{name}"
        defs[def_name] = {
            "description": ev["doc"],
            "type": "object",
            "properties": merged_props,
            "required": merged_required,
            # Unknown members are tolerated on purpose: additive schema changes must not
            # break older consumers (see trace-schema.md, versioning).
            "additionalProperties": True,
        }
        event_defs.append({"$ref": f"#/$defs/{def_name}"})

    defs["Event"] = {"description": "Any trace event.", "oneOf": event_defs}

    schema = {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "$id": f"https://flow-view.dev/schema/trace/v{m.version_major}.json",
        "title": "flow_view Universal Trace",
        "description": m.doc,
        "type": "object",
        "properties": {
            "schema": {"const": m.schema_id},
            "session": {"$ref": "#/$defs/Session"},
            "events": {"type": "array", "items": {"$ref": "#/$defs/Event"}},
        },
        "required": ["schema", "session", "events"],
        "additionalProperties": False,
        "$defs": defs,
    }
    return json.dumps(schema, indent=2) + "\n"


# ---------------------------------------------------------------------------
# TypeScript
# ---------------------------------------------------------------------------


def ts_type(t: str) -> str:
    if t == "int" or t == "float":
        return "number"
    if t == "bool":
        return "boolean"
    if t == "string":
        return "string"
    if t == "primitive":
        return "Primitive"
    if t == "any":
        return "unknown"
    if t.startswith("enum:"):
        return t[5:]
    if t.startswith("array:"):
        return f"{ts_type(t[6:])}[]"
    if t.startswith("map:"):
        return f"Record<string, {ts_type(t[4:])}>"
    return t


def ts_doc(text: str | None, indent: str) -> list[str]:
    if not text:
        return []
    words, lines, cur = text.split(), [], ""
    for w in words:
        if len(cur) + len(w) + 1 > 92:
            lines.append(cur)
            cur = w
        else:
            cur = f"{cur} {w}".strip()
    if cur:
        lines.append(cur)
    if len(lines) == 1:
        return [f"{indent}/** {lines[0]} */"]
    return [f"{indent}/**", *[f"{indent} * {ln}" for ln in lines], f"{indent} */"]


def ts_members(fields: dict[str, dict[str, Any]], indent: str = "  ") -> list[str]:
    out: list[str] = []
    for name, f in fields.items():
        out += ts_doc(f["doc"], indent)
        opt = "?" if f["opt"] else ""
        out.append(f"{indent}readonly {name}{opt}: {ts_type(f['t'])};")
    return out


def pascal(name: str) -> str:
    return "".join(p.capitalize() for p in name.split("_"))


def gen_typescript(m: Model) -> str:
    L: list[str] = [f"// {b}" for b in BANNER_LINES]
    L += ["", f"export const SCHEMA_ID = {json.dumps(m.schema_id)} as const;"]
    L += [f"export const SCHEMA_VERSION_MAJOR = {m.version_major} as const;", ""]
    L += ["/** A JSON primitive as carried in a trace. */"]
    L += ["export type Primitive = null | boolean | number | string;", ""]

    for name, e in m.enums.items():
        L += ts_doc(e["doc"], "")
        L.append(f"export type {name} =")
        for i, v in enumerate(e["values"]):
            tail = ";" if i == len(e["values"]) - 1 else ""
            L.append(f"  | {json.dumps(v)}{tail}")
        L.append("")
        L.append(
            f"export const {name.upper()}_VALUES = ["
            + ", ".join(json.dumps(v) for v in e["values"])
            + f"] as const satisfies readonly {name}[];"
        )
        L.append("")

    for name, u in m.unions.items():
        for vname, v in u["variants"].items():
            L += ts_doc(v["doc"], "")
            L.append(f"export interface {name}{pascal(vname)} {{")
            L += ts_members({k: norm_field(s) for k, s in v["fields"].items()})
            L.append("}")
            L.append("")
        L += ts_doc(f"{u['doc']} {u['discriminator_note']}", "")
        L.append(f"export type {name} =")
        names = list(u["variants"])
        for i, vname in enumerate(names):
            tail = ";" if i == len(names) - 1 else ""
            L.append(f"  | {name}{pascal(vname)}{tail}")
        L.append("")
        for vname in names:
            key = next(iter(u["variants"][vname]["fields"]))
            L.append(
                f"export const is{name}{pascal(vname)} = (v: {name}): "
                f"v is {name}{pascal(vname)} => {json.dumps(key)} in v;"
            )
        L.append("")

    for name in m.structs:
        L += ts_doc(m.structs[name]["doc"], "")
        L.append(f"export interface {name} {{")
        L += ts_members(m.struct_fields(name))
        L.append("}")
        L.append("")

    L += ts_doc("Fields carried by every event. Only seq and t are universally required.", "")
    L.append("export interface EventBase {")
    L += ts_members(m.common)
    L.append("}")
    L.append("")

    for name in m.events:
        ev = m.events[name]
        L += ts_doc(f"`{name}` — {ev['doc']}", "")
        L.append(f"export interface {pascal(name)}Event extends EventBase {{")
        L.append(f"  readonly t: {json.dumps(name)};")
        L += ts_members(m.event_fields(name))
        L.append("}")
        L.append("")

    L += ts_doc("Any trace event. Discriminated on `t`.", "")
    L.append("export type TraceEvent =")
    names = list(m.events)
    for i, name in enumerate(names):
        tail = ";" if i == len(names) - 1 else ""
        L.append(f"  | {pascal(name)}Event{tail}")
    L.append("")

    L.append("/** Event type names. */")
    L.append("export type EventType = TraceEvent['t'];")
    L.append("")
    L.append("export const EVENT_TYPES = [")
    for name in names:
        L.append(f"  {json.dumps(name)},")
    L.append("] as const satisfies readonly EventType[];")
    L.append("")

    steppable = [n for n in names if m.events[n].get("steppable")]
    L += ts_doc(
        "Event types a user can land on when stepping. Other events mutate state or carry "
        "bookkeeping, and are applied while passing over them.",
        "",
    )
    L.append("export const STEPPABLE_EVENT_TYPES: ReadonlySet<EventType> = new Set([")
    for name in steppable:
        L.append(f"  {json.dumps(name)},")
    L.append("]);")
    L.append("")

    groups: dict[str, list[str]] = {}
    for name in names:
        groups.setdefault(m.events[name].get("group", "other"), []).append(name)
    L.append("/** Event types by functional group. */")
    L.append("export const EVENT_GROUPS = {")
    for g, members in groups.items():
        L.append(f"  {g}: [{', '.join(json.dumps(x) for x in members)}],")
    L.append("} as const;")
    L.append("")

    L += ts_doc("A complete trace: header plus events. A saved trace file has this shape.", "")
    L.append("export interface Trace {")
    L.append("  readonly schema: typeof SCHEMA_ID;")
    L.append("  readonly session: Session;")
    L.append("  readonly events: readonly TraceEvent[];")
    L.append("}")
    L.append("")

    L += ts_doc(
        "Narrow an event by type. Keeps call sites free of casts: "
        "`if (isEvent(e, 'var_set')) { e.name }`.",
        "",
    )
    L.append("export function isEvent<T extends EventType>(")
    L.append("  event: TraceEvent,")
    L.append("  type: T,")
    L.append("): event is Extract<TraceEvent, { t: T }> {")
    L.append("  return event.t === type;")
    L.append("}")
    L.append("")
    return "\n".join(L)


# ---------------------------------------------------------------------------
# Python
# ---------------------------------------------------------------------------


def py_type(t: str) -> str:
    if t == "int":
        return "int"
    if t == "float":
        return "float"
    if t == "bool":
        return "bool"
    if t == "string":
        return "str"
    if t == "primitive":
        return "Primitive"
    if t == "any":
        return "object"
    if t.startswith("enum:"):
        return t[5:]
    if t.startswith("array:"):
        return f"list[{py_type(t[6:])}]"
    if t.startswith("map:"):
        return f"dict[str, {py_type(t[4:])}]"
    return t


def py_doc(text: str | None, indent: str) -> list[str]:
    if not text:
        return []
    words, lines, cur = text.split(), [], ""
    for w in words:
        if len(cur) + len(w) + 1 > 88 - len(indent):
            lines.append(cur)
            cur = w
        else:
            cur = f"{cur} {w}".strip()
    if cur:
        lines.append(cur)
    if len(lines) == 1:
        return [f'{indent}"""{lines[0]}"""']
    return [f'{indent}"""{lines[0]}', *[f"{indent}{ln}" for ln in lines[1:]], f'{indent}"""']


def py_members(fields: dict[str, dict[str, Any]], indent: str = "    ") -> list[str]:
    out: list[str] = []
    req = {k: v for k, v in fields.items() if not v["opt"]}
    opt = {k: v for k, v in fields.items() if v["opt"]}
    for name, f in req.items():
        out.append(f"{indent}{name}: {py_type(f['t'])}")
        if f["doc"]:
            out += py_doc(f["doc"], indent)
    if not req and not opt:
        out.append(f"{indent}pass")
    return out, opt


def gen_python(m: Model) -> str:
    L: list[str] = ['"""' + BANNER_LINES[0], BANNER_LINES[1] + '"""', ""]
    L += ["from __future__ import annotations", ""]
    L += ["from typing import Literal, TypedDict, Union", ""]
    L += [f"SCHEMA_ID = {json.dumps(m.schema_id)}"]
    L += [f"SCHEMA_VERSION_MAJOR = {m.version_major}", ""]
    L += ["Primitive = Union[None, bool, int, float, str]", ""]

    for name, e in m.enums.items():
        vals = ", ".join(json.dumps(v) for v in e["values"])
        L.append(f"{name} = Literal[{vals}]")
        L += py_doc(e["doc"], "")
        L.append(f"{name.upper()}_VALUES: tuple[{name}, ...] = ({vals},)")
        L.append("")

    for name, u in m.unions.items():
        variant_names = []
        for vname, v in u["variants"].items():
            cls = f"{name}{pascal(vname)}"
            variant_names.append(cls)
            fields = {k: norm_field(s) for k, s in v["fields"].items()}
            req, opt = py_members(fields)
            L.append(f"class {cls}(TypedDict):")
            L += py_doc(v["doc"], "    ")
            L += req
            L.append("")
            if opt:
                L.append(f"class {cls}Opt({cls}, total=False):")
                L.append('    """Optional members."""')
                for fname, f in opt.items():
                    L.append(f"    {fname}: {py_type(f['t'])}")
                L.append("")
                variant_names[-1] = f"{cls}Opt"
        L.append(f"{name} = Union[{', '.join(variant_names)}]")
        L += py_doc(f"{u['doc']} {u['discriminator_note']}", "")
        L.append("")

    for name in m.structs:
        fields = m.struct_fields(name)
        req, opt = py_members(fields)
        base = name if not opt else f"_{name}Req"
        L.append(f"class {base}(TypedDict):")
        L += py_doc(m.structs[name]["doc"], "    ")
        L += req
        L.append("")
        if opt:
            L.append(f"class {name}({base}, total=False):")
            L += py_doc(f"{m.structs[name]['doc']} (with optional members)", "    ")
            for fname, f in opt.items():
                L.append(f"    {fname}: {py_type(f['t'])}")
            L.append("")

    common_req = {k: v for k, v in m.common.items() if not v["opt"]}
    common_opt = {k: v for k, v in m.common.items() if v["opt"]}
    L.append("class _EventBase(TypedDict):")
    L.append('    """Required members of every event."""')
    for name, f in common_req.items():
        L.append(f"    {name}: {py_type(f['t'])}")
    L.append("")
    L.append("class EventBase(_EventBase, total=False):")
    L.append('    """Optional members shared by all events."""')
    for name, f in common_opt.items():
        L.append(f"    {name}: {py_type(f['t'])}")
    L.append("")

    event_classes: list[str] = []
    for name in m.events:
        ev = m.events[name]
        cls = f"{pascal(name)}Event"
        fields = m.event_fields(name)
        req = {k: v for k, v in fields.items() if not v["opt"]}
        opt = {k: v for k, v in fields.items() if v["opt"]}
        L.append(f"class _{cls}(_EventBase):")
        L += py_doc(f"`{name}` — {ev['doc']}", "    ")
        L.append(f"    t: Literal[{json.dumps(name)}]")
        for fname, f in req.items():
            L.append(f"    {fname}: {py_type(f['t'])}")
        L.append("")
        L.append(f"class {cls}(_{cls}, total=False):")
        L.append(f'    """`{name}` with optional members."""')
        for fname, f in {**common_opt, **opt}.items():
            L.append(f"    {fname}: {py_type(f['t'])}")
        L.append("")
        event_classes.append(cls)

    L.append("TraceEvent = Union[")
    for cls in event_classes:
        L.append(f"    {cls},")
    L.append("]")
    L.append('"""Any trace event, discriminated on `t`."""')
    L.append("")

    names = list(m.events)
    L.append("EventType = Literal[")
    for name in names:
        L.append(f"    {json.dumps(name)},")
    L.append("]")
    L.append("")
    L.append("EVENT_TYPES: tuple[EventType, ...] = (")
    for name in names:
        L.append(f"    {json.dumps(name)},")
    L.append(")")
    L.append("")
    steppable = [n for n in names if m.events[n].get("steppable")]
    L.append("STEPPABLE_EVENT_TYPES: frozenset[str] = frozenset({")
    for name in steppable:
        L.append(f"    {json.dumps(name)},")
    L.append("})")
    L += py_doc(
        "Event types a user can land on when stepping. Other events mutate state or carry "
        "bookkeeping, and are applied while passing over them.",
        "",
    )
    L.append("")

    L.append("class Trace(TypedDict):")
    L += py_doc("A complete trace: header plus events. Shape of a saved trace file.", "    ")
    L.append("    schema: str")
    L.append("    session: Session")
    L.append("    events: list[TraceEvent]")
    L.append("")

    # A machine-readable description of the same contract, embedded so the Python validator needs
    # neither the model file on disk nor a JSON Schema library. Adapters must stay dependency-free,
    # and a validator that only works from a source checkout is a validator nobody runs.
    L.append("")
    L.append("ENUM_VALUES: dict[str, tuple[str, ...]] = {")
    for name, e in m.enums.items():
        vals = ", ".join(json.dumps(v) for v in e["values"])
        L.append(f"    {json.dumps(name)}: ({vals},),")
    L.append("}")
    L.append('"""Permitted values for each enum, by enum name."""')
    L.append("")

    L.append("EVENT_SPEC: dict[str, dict[str, dict[str, object]]] = {")
    for name in m.events:
        fields = {**m.common, **m.event_fields(name)}
        L.append(f"    {json.dumps(name)}: {{")
        for fname, f in fields.items():
            required = "False" if f["opt"] or fname == "t" else "True"
            L.append(
                f"        {json.dumps(fname)}: "
                f'{{"type": {json.dumps(f["t"])}, "required": {required}}},'
            )
        L.append("    },")
    L.append("}")
    L += py_doc(
        "Field type and requiredness for every event, including the common envelope. The type "
        "strings use the model's own notation: scalars, `enum:Name`, `array:Type`, `map:Type`, "
        "or a struct name.",
        "",
    )
    L.append("")

    L.append("STRUCT_SPEC: dict[str, dict[str, dict[str, object]]] = {")
    for name in m.structs:
        L.append(f"    {json.dumps(name)}: {{")
        for fname, f in m.struct_fields(name).items():
            required = "False" if f["opt"] else "True"
            L.append(
                f"        {json.dumps(fname)}: "
                f'{{"type": {json.dumps(f["t"])}, "required": {required}}},'
            )
        L.append("    },")
    L.append("}")
    L.append('"""Field type and requiredness for every struct."""')
    L.append("")

    L.append("VALUE_VARIANTS: dict[str, tuple[str, ...]] = {")
    for name, u in m.unions.items():
        for vname, v in u["variants"].items():
            keys = ", ".join(json.dumps(k) for k in v["fields"])
            L.append(f"    {json.dumps(vname)}: ({keys},),")
    L.append("}")
    L += py_doc(
        "Variant name to its field names. The first field of each variant is its discriminator, "
        "and exactly one discriminator may be present in a value.",
        "",
    )
    L.append("")
    return "\n".join(L)


# ---------------------------------------------------------------------------


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "--check",
        action="store_true",
        help="verify committed output matches the model instead of writing",
    )
    args = ap.parse_args()

    model = Model(json.loads(MODEL.read_text()))
    if errs := model.validate():
        print("model is invalid:", file=sys.stderr)
        for e in errs:
            print(f"  - {e}", file=sys.stderr)
        return 2

    artifacts = {
        "trace.schema.json": gen_json_schema(model),
        "types.ts": gen_typescript(model),
        "events.py": gen_python(model),
    }

    stale: list[str] = []
    for name, text in artifacts.items():
        path = ARTIFACT_PATHS[name]
        if args.check:
            if not path.exists() or path.read_text() != text:
                stale.append(str(path.relative_to(ROOT)))
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text)

    if args.check:
        if stale:
            print("generated files are stale: " + ", ".join(stale), file=sys.stderr)
            print("run: pnpm schema:gen", file=sys.stderr)
            return 1
        print(f"schema artifacts current ({len(artifacts)} files)")
        return 0

    counts = ", ".join(f"{n} ({len(t.splitlines())} lines)" for n, t in artifacts.items())
    print(f"generated {counts}")
    print(f"  {len(model.events)} event types, {len(model.enums)} enums, {len(model.structs)} structs")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
