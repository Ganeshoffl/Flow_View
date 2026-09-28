# 4. A blocked program must be able to speak

**Status:** accepted · **Phase:** 5, tasks 5.1–5.6

## The question

Interactive `input()` was written in Phase 1: the tracer emits `stdin_request`, the server carries the
answer back, the UI shows a prompt. All of it correct, and none of it worked. The UI showed "running"
forever and the program never ended.

It was recorded as a Phase 5 feature gap for two phases. It was not a gap. It was three buffers.

## What was actually wrong

A traced program that asks a question is in a position nothing else in the system is: **it cannot
finish until something it has already written is read by someone else.** Every ordinary optimisation
for throughput assumes the opposite — that output can be held back, because the producer will keep
producing and the buffer will fill or the process will exit.

Three layers each made that assumption:

| Layer | The optimisation | What it did to a blocked program |
|---|---|---|
| Tracer | Python block-buffers a pipe (8 KB) | The question sat in the buffer. The buffer could only be emptied by the program exiting, and the program could not exit, because it was waiting for the answer to the question in the buffer. |
| Server | Batch events at 16 ms, deciding on arrival of the next event | There is no next event. The partial batch holding `stdin_request` was never sent. |
| Runner | Write prefilled stdin as given | No trailing newline, so `input()` never returned. |

Each is individually sufficient to deadlock the run. Each is individually invisible in a test that
runs a program to completion, which is what every test did.

## Decision

**A trace is a conversation, not a report. Any layer that buffers it must have a reason to flush that
does not depend on the program making further progress.**

Three rules follow, and they apply to every adapter and every transport, not just to Python:

1. **Flush before blocking.** An adapter must empty its output before any operation that waits on the
   outside world. `Emitter.URGENT` names those events; `stdin_request` is the one that matters, and
   `run_end`, `note` and `error` are there because a user waiting on an explanation is in the same
   position as a user waiting on a prompt.

2. **Batch on a timer, not on arrival.** Anything that groups events must be able to release a partial
   group because time passed. The server's pump races the next event against the batch interval, so
   silence releases the batch instead of holding it hostage.

3. **Flush on a timer too, for the same reason.** "Live" cannot mean "every 8 KB". The tracer flushes
   at the same 16 ms window the server batches at — beyond that there is nothing a viewer could see.

## Cost

Measured, because a flush is a syscall in the tracer's hot path and NFR-3 allows 100 µs per step:

| | Per-step cost |
|---|---|
| Flushing at 16 ms, urgent events immediate | 24.4 µs |
| No flushing at all (the old behaviour) | 25.1 µs |

Within noise. Time-bounded flushing costs nothing measurable because the number of flushes is
proportional to elapsed time, not to the number of events.

## The other half: whose time is it?

Making a run able to wait for a person immediately broke every deadline in the stack, because they all
measured wall-clock time and a person is slow. A run was killed for exceeding a 30-second execution
budget when the program had run for 3 ms and the user had spent 31 seconds reading. The runner
separately gave up and reported "The program stopped responding", which was a program doing exactly
what it was told.

**Time blocked on input is the person's, not the program's.** It is discounted from `elapsed_ms`, so
it counts against neither the wall-clock budget nor the elapsed clock the UI shows — and it is not
thrown away, because it is recorded on the answer as `waited_ms`. Deadlines that must still exist
while a question is outstanding are set loosely enough not to interrupt a human, and finitely enough
that a closed tab cannot park a subprocess forever.

The negative control matters here: a discount applied slightly too widely would leave the execution
budget meaning nothing at all, so there is a test that a genuinely slow program is still stopped.

## Consequences

- `stdin_response` carries `waited_ms`, and `source` is derived from it rather than asserted. It used
  to be hardcoded to `"prefilled"`, which quietly claimed no human was ever involved in any run. The
  adapter cannot know for certain — prefilled input and a typed answer are the same bytes on the same
  pipe — but the two differ by about three orders of magnitude in how long the read takes. Where the
  host supplied the input it knows exactly, and replaces the label.
- Every future adapter inherits rule 1. A JavaScript adapter instrumenting `prompt()`, or a C adapter
  wrapping `scanf`, has the same obligation, and the conformance corpus is where that gets checked.
- Tests that drive a blocking program must fail on a deadline rather than hang. A suite that hangs on
  regression is worse than one that fails: it reports nothing, and it does so slowly.
