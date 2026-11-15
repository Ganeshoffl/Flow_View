# Flow_View task tracker

Updated 2026-11-15. Branch `development/flow-view-completion`, based on `main` `3e7dc72`. Remote `origin` points to `https://github.com/Ganeshoffl/Flow_View.git`. Verified platform fix commit `efee4faa36db562e7cc7c4ae8717547de0921c5b` was pushed and confirmed by `git ls-remote` on this branch. Python **language gate remains open**; do not mistake this scoped fix commit for language completion.

## Verified this session

- Cloned directly into `D:\Flow_View`; original tree clean; fetched all remote refs. Development branch created without modifying `main`.
- Inspected README, Kiro requirements/design/schema/tasks, five ADRs, source/test inventory, config and recent history. Details in `PROJECT_AUDIT.md`.
- Built web UI and installed local Python extras after initial editable-install failure caused by absent built UI. `httpx2` installed manually for newer Starlette TestClient; now declared in the `dev` extra.
- Corrected platform-specific UTF-8 generator reads/writes, normalized Python source-file identity, and replaced nonexistent Windows SIGKILL with terminate/kill escalation. Added an end-to-end three-prefilled-question server test.
- `pnpm schema:check` PASS (3 artifacts); Python `pytest packages/trace-schema/python/tests adapters/python/tests apps/server/tests conformance/tests -q` PASS (379 tests after the extra interactive test); `pnpm typecheck` PASS; `pnpm --filter @flow-view/web build` PASS (bundle-size warning); TS tests excluding replay suite PASS (724 tests). Installed `flow-view` launched on loopback, served `/` (HTTP 200), and a live WebSocket run answered three prefilled questions in order with `run_end: ok`. A real headless Edge run of recursive factorial through the installed UI rendered `answer = 120`, six timeline calls and output `120` at step 29; rewind cleared frames/variables at step 0 with zero page errors. The full browser fixture gate was not run.
- Before fixes: Python suite had a user-finalizer path failure and three server shutdown errors on Windows. Those now pass. Python corpus had 17/17 passes. The existing cross-language runner had 32/33 passes; JavaScript stdin case failed on CRLF. Full Vitest had 990/991 passes, same input mismatch. These failures remain open and are not included in Python gate completion.

## Modified files (audit docs pending commit)

The verified platform fix commit changed `packages/trace-schema/generate.py`, `adapters/python/flow_view_tracer/tracer.py`, `apps/server/flow_view_server/runner.py`, `apps/server/tests/test_server.py`, and `pyproject.toml`. A subsequent uncommitted test change adds a three-question *interactive* socket test to `apps/server/tests/test_server.py`. `PROJECT_AUDIT.md`, `IMPLEMENTATION_PLAN.md`, and `TASK_TRACKER.md` are pending their separate documentation commit.

## Open gates and blockers

- Python language gate **not declared complete**: one live Edge browser recursion smoke passed, but full fixture browser verification (`ab` not on PATH), three-question interactive *UI* back-step/imported-session replay and Windows process descendants isolation remain unverified. Existing Python code supports 17/17 corpus; this does not prove every spec requirement.
- JavaScript conformance failure: `adapters/javascript/src/stdin.js` preserves `\r` in CRLF input; full TS suite also fails. Do not begin JavaScript changes until Python checkpoint is committed/pushed or the workflow exception is authorized.
- `ruff check .` fails with substantial pre-existing diagnostics, including long lines and unused `noqa`; it was not a passing gate at baseline. Browser `ab` gate unavailable; GitHub CLI absent, branch protections/issues unverified. No native toolchains or offline Lite tested.
- No full language milestone has been declared complete. Git push of the **scoped platform fix** succeeded; browser visualization remains unverified. Never report a successful language-gate push until that gate passes.

## Exact next task

Finish Python gate verification: test a three-question *interactive* socket exchange and trace replay/back-stepping if available, validate bounded/truncated traces, and obtain a browser gate for actual visualization. The scoped Python/platform fix is already pushed as `efee4fa`; **do not call it a completed Python language milestone**. If browser tooling cannot be made available, clearly record the unverified gate and ask for an exception before moving to JavaScript. Only after the completed Python checkpoint is confirmed on the remote address JavaScript CRLF input and its missing wheel packaging.
