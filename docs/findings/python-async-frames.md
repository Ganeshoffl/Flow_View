# The Python adapter mishandles concurrent coroutines

**Found:** while adding `conformance/cases/018-concurrent-calls`, which was written to catch the equivalent bug
in the JavaScript adapter.
**Status:** open. Not yet fixed, and not yet covered by the corpus.

## What happens

The case runs two `work()` coroutines concurrently with `asyncio.gather`, each awaiting twice:

```python
async def work(n):
    first = await later(n)
    second = await later(n * 2)
    return first + second

both = await asyncio.gather(work(1), work(100))
print(both[0], both[1])
```

Python gets two things right that JavaScript got wrong — the output arrives, and the frames balance. It gets two
things wrong:

```
work returned: expected 3, got <Future #6>
calls to work: expected 2, got 6
```

**Six calls instead of two.** `sys.settrace` reports a `call` event every time a coroutine is *resumed*, not only
when it is first entered. Two coroutines resumed twice each read as six separate calls, so the trace shows six
frames where a reader expects two.

**The return value is a `Future`.** `settrace` fires `return` at every suspension, and the value it carries at that
point is whatever the coroutine yielded to the event loop, not what it will eventually return. The last such value
wins, so `work` appears to return a `Future`.

## Why it is not fixed here

The fix is not the same shape as the JavaScript one. There, instrumentation could mark suspension explicitly,
because the adapter writes the code. Here the tracer observes an interpreter that reports resumption and return
using the same two events it uses for ordinary calls, so the adapter has to tell them apart by other means:

- a `call` event whose frame object has been seen before is a **resumption**, not a new call
- a `return` event on a frame whose coroutine is not exhausted is a **suspension**, not a return

Both are knowable — `frame` identity is stable across resumptions, and a coroutine's state is inspectable — but it
is a change to the hot path of the Python tracer, which is the most performance-sensitive code in the project and
the most thoroughly tested. It deserves its own change with its own measurements rather than being appended to a
JavaScript fix.

## What exists in the meantime

`conformance/cases/018-concurrent-calls` covers JavaScript and states the expectations any adapter must meet. The
Python source is kept here rather than in the case directory, so the corpus stays green while the gap stays
visible: `conformance/runner.py` reports it as a case Python does not yet cover.

```python
import asyncio


async def later(value):
    await asyncio.sleep(0.01)
    return value


async def work(n):
    first = await later(n)
    second = await later(n * 2)
    return first + second


async def main():
    both = await asyncio.gather(work(1), work(100))
    print(both[0], both[1])


asyncio.run(main())
```
