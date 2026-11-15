# Flow_View project audit (2026-11-15)

Baseline: `main` at `3e7dc72`, cloned into `D:\Flow_View` with a clean working tree; work is on `development/flow-view-completion`. Remote: `origin` → `https://github.com/Ganeshoffl/Flow_View.git`. `origin/main` is the default branch; no remote development branch was designated, so this new branch avoids modifying main. GitHub CLI is unavailable here, so branch protection and issues were not independently checked. Windows 11, Python 3.13.7 (venv), Node 24.18.0, pnpm 10.28.1. No other OS has been verified.

Authoritative sources: `README.md`, `.kiro/specs/flow-view/{requirements,design,trace-schema,tasks}.md`, `docs/decisions/0001`–`0005`, `.kiro/steering/project-rules.md`. ADRs supersede design where they explicitly revise it: settrace is the Python default (0002); bounded heap inspection (0001), client-side runtime inference (0003), flush-before-input (0004), strong identity retention and finalizer tradeoff (0005). The spec task list marks phases 2–3 passed while phase 1's gate is open; treat test evidence, not checkbox order, as authoritative. README's install claim needs qualification: `pip install -e .` requires a prebuilt web dist, the `server` extra is required, and the installed wheel lacks the JavaScript adapter. The advertised Docker launcher is not implemented.

## Baseline and verification

- `pnpm install --frozen-lockfile` succeeded; web production build succeeded (843 kB JS chunk warning). Initial editable install failed because `apps/web/dist` was absent; build then `.venv/Scripts/python.exe -m pip install -e '.[server,dev]'` succeeded.
- Before changes, `pnpm schema:check` failed on Windows: generator default text encoding misread committed UTF-8 em dashes. Python collection failed because latest Starlette TestClient needs `httpx2` (not declared). Once installed manually, three server tests errored on missing Windows `signal.SIGKILL`; the isolated Python suite additionally failed user finalizer path matching on Windows.
- Before changes, `conformance/runner.py` passed 32/33 adapter/case pairs: Python 17/17, JavaScript 15/16. JavaScript stdin retained `\r` from CRLF fixture input. `pnpm test` passed 990/991; the one failing assertion checks cross-language output for this same input case. `ruff check .` failed with numerous pre-existing lint diagnostics; not a passing gate.
- After the focused changes: Python schema check passes; Python schema/adapter/server/conformance tests pass (379 tests including a three-question interactive socket test); typecheck passes; web build passes; 724 TS tests pass when excluding `conformance/test/replay.test.ts`. Installed `flow-view` served the UI (HTTP 200) and capabilities from loopback; a real WebSocket run with three prefilled questions produced three ordered requests/responses, `Ada Grace Lin` and `run_end: ok`. An actual headless Edge browser ran a recursive Python factorial program via the installed UI: step 29/29 displayed `answer = 120`, output `120`, six calls in the timeline, and rewound to step 0 with zero frames/variables and no page errors. The full 17-fixture browser gate was **not** run (its `ab` harness is unavailable); this is one live browser smoke, not complete browser verification. The full JS conformance and full TS suite **still fail**, so the entire project is **not green**.

## Requirement-to-implementation matrix

Statuses indicate verified behavior in this Windows environment, not promises in source comments. A row marked Partial may contain substantial working code.

| Requirement | Existing implementation | Verified status | Remaining work |
|---|---|---|---|
| Universal trace schema and validation | `packages/trace-schema/`, generator and Python tests | Complete | Check generated artifacts on other OS in CI |
| Reversible TraceStore and fixtures | `packages/trace-store/`, `conformance/test/replay.test.ts` | Partial | Full TS suite blocked by JavaScript CRLF discrepancy; cold snapshot seek open |
| Python line/call/branch/exception trace | `adapters/python/flow_view_tracer/`, `conformance/` | Complete | Full 17-fixture browser gate remains untested; one recursive live run verified |
| Python heap identity and mutations | tracer `walk.py`, registry, Python tests | Partial | Retention/finalizer tradeoff; adversarial wide/cyclic heap gate |
| Python bounds and process cleanup | `adapters/python/.../guards.py`, server `runner.py` | Partial | Windows has no POSIX memory/CPU/process-group limits; malicious-code sandbox absent |
| Python stdin/output/three prompts | tracer bridge, server socket and tests | Partial | Three-prompt interactive UI/back-step/imported-session replay gate unverified |
| JavaScript adapter and shared schema | `adapters/javascript/src/`, server runner | Broken | CRLF stdin failure; installed wheel omits adapter; browser gate unverified |
| C actual debugger trace | capability placeholder | Missing | Compiler + GDB/MI integration, native memory and schema conformance |
| C++ actual debugger trace | capability placeholder | Missing | Reuse C debugger; C++ types/lifetime/containers and tests |
| Java actual JDI trace | capability placeholder | Missing | JDK/JDI integration and conformance |
| Structure inference, confidence, override | `packages/structure-inference/` and UI | Partial | Browser confirmation, ambiguous graphs and cross-language runtime evidence |
| Narration and metrics | `packages/narration/`, UI | Partial | Audit observable comparisons/swaps and test across adapters |
| Source/stack/heap/timeline views | `apps/web/`, `packages/renderers/` | Partial | One live Edge recursion run verified; full browser fixture gate and all-language visualization pending |
| Playback/seek and history | `packages/trace-store/`, `apps/web/` | Partial | Cold large-trace seek, fold expansion, retention gates |
| Loop folding at scale | Python/JS collapse, store | Partial | 100k cold seek and million-loop UI measurement; retain significant effects |
| Offline Lite/PWA Python and JS | no worker engine or Lite build | Missing | Pyodide, JS worker, local assets, service worker, offline gate |
| Full CLI/wheel | `flow-view` script and bundled web | Partial | Clean-venv wheel validation, JS packaging, platform coverage |
| Saved sessions/trace import/export | schema trace shape; frontend state | Partial | Verify full save/load round trip without re-execution |
| Accessibility and responsive UI | React UI | Partial | Browser keyboard/screen-reader/responsive verification |
| CI, cross-platform lint and security | `.github/workflows/ci.yml`, guard reporting | Partial | Windows CI, pinned compatible dev dependencies, existing lint backlog, honest isolation limits |

**Verified requirement progress:** 2 of 20 matrix rows independently pass their currently applicable automated gates in this environment (10%). This conservative figure is a *row-level gate count*, not a claim that only 10% of code exists. The remaining 18 rows include partially implemented but unverified work; `Complete` here does not waive additional browser or cross-platform gates noted in Remaining work. No requirement is marked 100% project-wide complete.

## Known blockers and fidelity limits

Full-profile arbitrary code execution is local-only and not a hostile-code sandbox; Windows lacks POSIX resource ceilings. JavaScript currently breaks on Windows CRLF input. Python's strong object registry delays finalizers. The UI bundle emits a >500 kB warning. CI runs Linux with Python 3.12 and Node 22, not this Windows environment. The complete 17-fixture `ab` browser gate, native toolchain tracing, and offline Lite gate were not performed; a single live Edge smoke run is recorded above. Do not mark language implementations finished from this audit alone.
