# What works, and how

Everything below is real output from `scripts/tour.sh`, which runs each feature through the actual
tracer. Run it yourself to reproduce any of it:

```sh
scripts/tour.sh                # the whole thing, with screenshots
scripts/tour.sh --no-browser   # just the numbers, ~40s
```

Screenshots land in `.kiro/artifacts/screenshots/tour/`.

---

## Try it in thirty seconds

```sh
pnpm install && pnpm --filter @flow-view/web build
uv build --wheel
pip install './dist/flow_view-0.1.0-py3-none-any.whl[server]'
flow-view
```

Paste a program, press **Run**, then step through it with the arrow keys. `Ctrl+Enter` also runs.

> **Do not bind this to a public interface.** It runs the code you paste. `--host` exists for a machine
> you reach over a trusted network; the guards catch accidents, not attackers.

---

## 1. It records what every line did

```python
a = 2
b = a * 3
c = [a, b]
c.append(a + b)
print(c)
```

```
steps recorded: 7
a = 2, b = 6, c = object #1
printed: '[2, 6, 8]'
every assignment carries its previous value, which is how stepping backwards works:
  line 1: a (new) -> 2
  line 2: b (new) -> 6
  line 3: c (new) -> object #1
```

**How it works.** Every mutation carries its `prev` value, which makes each event invertible. Stepping
backwards therefore *undoes* recorded events rather than re-running your program — so a program with side
effects can be stepped back through safely, and going back is as cheap as going forward (~0.002 ms).

## 2. It follows calls, including recursion

```python
def fact(n):
    if n <= 1:
        return 1
    return n * fact(n - 1)

print(fact(5))
```

```
fact called 5 times, recursion depth reaching 4
values returned, innermost first: [1, 2, 6, 24, 120]
printed: '120'
```

Library calls are shown as a single opaque frame — you see `json.dumps(...)`, not the forty frames of
`json`'s internals underneath it.

## 3. It works out what your data structure *is*, from what it does

| program | recorded |
|---|---|
| three `Node`s chained by `next` | 4 objects, 8 links → **linked list** |
| four `T`s with `left`/`right` | 5 objects, 15 links → **binary search tree** |
| `[[1,2,3],[4,5,6],[7,8,9]]` | 4 objects, 12 links → **matrix** |
| a list with `append`/`pop` at one end | 1 object, 3 links → **stack** |

**How it works.** The shape is inferred from *measured facts*, not from names: how many same-type
references each node has, whether a cycle exists, whether any node is reachable twice, whether rows are
equal length, whether pushes and pops happen at the same end. Names only break ties.

So a class called `TreeNode` whose objects form a cycle is reported as a **graph**, and the evidence panel
says why: *"the field names suggest a tree, but the objects form a cycle."* You can override it if you
disagree.

Eleven shapes are recognised; `scripts/verify-heap.sh` checks each one.

## 4. It explains each step in English

For a bubble sort it produces lines like:

- *values[j] > values[j + 1] is true, so the body runs.*
- *values[0] and values[1] are swapped.*
- *Iteration 3 begins.*
- *The loop ran 6 times.*

**No language model is involved.** These are deterministic templates over the trace — which is why they
work offline and never invent anything. Patterns like a swap or a construction are recognised before the
individual events, so it says "are swapped" rather than narrating three separate assignments.

## 5. It counts the work, so you can see the algorithm's cost

Bubble sort over six elements:

```
{'comparison': 15, 'assignment': 22, 'iteration': 20, 'write': 20, 'call': 1, 'allocation': 1}
sorted result: [1, 2, 3, 4, 5, 8]
```

15 comparisons for 6 elements is n(n−1)/2. The counts are drawn as a curve, so the quadratic shape is
visible rather than asserted.

## 6. A million iterations stay readable

```python
total = 0
for i in range(1000000):
    total += i
print(total)
```

```
events in the whole trace: 729
iterations folded into composite steps: 999,976
iterations kept in full, at each end: 24
final answer: 499999500000   (correct)
```

**How it works.** The first and last few iterations are kept verbatim; the middle is folded into composite
steps. A folded step carries the *net* before-and-after of every slot it touched, so you can still step
backwards across it and the final state is exact. A fold that would have to swallow output, a question, an
exception or a new object is not performed at all — correctness first.

## 7. A program that asks you a question

```python
age = input("how old? ")
print("in ten years:", int(age) + 10)
```

```
the program asked: 'how old? '
it was answered:   '32'  (source: prefilled, waited 0.003ms)
printed: 'in ten years: 42'
```

In the browser the run genuinely stops, the UI asks, and you type. The answer is recorded in the trace, so
the finished run replays without anyone typing. Time spent waiting for you is not charged to your
program's execution budget, and not counted in its elapsed clock.

## 8. It refuses what a learning program should not do

| attempt | result |
|---|---|
| `socket.socket()` | *flow_view blocks network access while tracing* |
| `os.system('echo hi')` | *flow_view does not allow a traced program to start another* |
| `open('/tmp/x','w')` | *flow_view only allows writes inside the run's own directory* |

Plus CPU, memory, file-size and step limits. The run also names the guards protecting it, so you can see
what is and is not in force on your platform.

**These catch accidents.** They are not a defence against someone attacking you, which is why the tool
binds to loopback and why you should not publish it.

## 9. A program that goes wrong is a result, not a crash

```python
xs = [1, 2, 3]
total = 0
for x in xs:
    total += x
print(xs[9])
```

```
status: error
the program got as far as: total = 6 after 17 steps
then: IndexError: list index out of range
```

The trace up to the failure is complete and steppable — which is the point. You can walk back and watch
`total` accumulate, then see exactly where it stopped.

---

## What does not work yet

| | |
|---|---|
| JavaScript, C, C++, Java | the adapters are unwritten; only Python traces |
| The Lite profile | no-install, in-browser via Pyodide — not started |
| Expand a collapsed region | you can see a fold, not open it |
| Cold seek on a huge trace | jumping to the far end of a 100k-step trace is slow *until* it has been played once; after that it is ~1 ms |
| Faithful `__del__` timing | a finalizer you write runs late, because tracing holds objects to keep their ids stable. The trace warns you on each `__del__` it finds |

## How to check any of this

```sh
scripts/tour.sh              # this document, regenerated live
scripts/cross-verify.sh      # everything: 365 Python tests, 680 TypeScript, browser gates, the wheel
scripts/verify-fixes.sh      # reverts each fix and checks the suite notices it went missing
scripts/verify-install.sh    # installs the wheel in a clean venv and traces a program
```

The last two exist because this project found two fixes with no test behind them and three gates that
reported success they had not earned. `verify-fixes.sh` currently runs 20 checks with 0 survivors.
