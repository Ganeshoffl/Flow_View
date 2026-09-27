#!/usr/bin/env bash
# Shared setup for the verification scripts. Source, do not execute.
#
# Node is installed through a version manager whose shims are not always on PATH for a non-login
# shell, which made a verification script fail with an empty log and no explanation. Finding it here
# means the scripts work however they are invoked.

find_node() {
  if command -v pnpm >/dev/null 2>&1; then
    return 0
  fi
  for candidate in \
    "$HOME/.nvm/versions/node"/*/bin \
    "$HOME/.local/share/mise/shims" \
    /usr/local/bin
  do
    if [ -x "$candidate/pnpm" ] || [ -x "$candidate/node" ]; then
      PATH="$candidate:$PATH"
      export PATH
    fi
  done
  command -v pnpm >/dev/null 2>&1
}

if ! find_node; then
  echo "pnpm was not found. Install Node 20 or newer and pnpm 10." >&2
  exit 1
fi

# The interpreter the project was set up with, falling back to whatever python3 is available.
PYTHON="${PYTHON:-}"
if [ -z "$PYTHON" ]; then
  if [ -x "$ROOT/.venv/bin/python" ]; then
    PYTHON="$ROOT/.venv/bin/python"
  else
    PYTHON="$(command -v python3 || command -v python)"
  fi
fi
export PYTHON

wait_for_http() {
  # wait_for_http <url> <seconds>
  local url="$1" limit="${2:-45}" code=""
  for _ in $(seq 1 "$limit"); do
    code="$(curl -s -o /dev/null -w '%{http_code}' "$url" || true)"
    [ "$code" = "200" ] && { echo "$code"; return 0; }
    printf '.' >&2
    sleep 1
  done
  echo "${code:-000}"
  return 1
}


# ---------------------------------------------------------------- browser driving
#
# Shared by the three browser gates. Set AB_SESSION before use.
#
# These exist because of two silent failures. A gate clicked "Run again" nine times and every click
# landed on <html>: the button had scrolled off the top of a too-short viewport, `agent-browser click`
# dispatched a mouse event at y=-42 anyway, and printed "Done". The gate then reported a heap that had
# not been redrawn, and the wrong conclusion drawn from it was that the product's Run button was
# broken. Separately, all three gates printed "console errors: 0" while reading a variable that nothing
# ever assigned. A gate that cannot fail is not a gate.

AB_SESSION="${AB_SESSION:-flow-view}"

ab() { agent-browser --session "$AB_SESSION" "$@"; }

# Run an expression and print its value, unquoted.
ab_eval() { ab eval "$1" 2>&1 | tail -2 | head -1 | sed 's/^"//; s/"$//; s/\\"/"/g'; }

# Install the recorders. Must be called after every navigation; a page load wipes them.
ab_instrument() {
  ab_eval "(() => {
    if (window.__fv) return 'already installed';
    window.__fv = { errors: [], clicks: [], target: null };
    // The gates read window.__fvErrors. Alias the same array so pushes are visible through both.
    window.__fvErrors = window.__fv.errors;
    addEventListener('error', (e) => window.__fv.errors.push('error: ' + (e.message || e.error)));
    addEventListener('unhandledrejection', (e) =>
      window.__fv.errors.push('rejection: ' + (e.reason && e.reason.message || e.reason)));
    const original = console.error;
    console.error = (...args) => {
      window.__fv.errors.push('console.error: ' + args.map(String).join(' '));
      original.apply(console, args);
    };
    document.addEventListener('click', (e) => window.__fv.clicks.push(e.target), true);
    return 'instrumented';
  })()"
}

# ab_click <selector> — click, and fail loudly if the click did not land on that element.
#
# Returns non-zero and prints "MISS: <reason>" when the selector is ambiguous, the element is
# disabled or invisible, or the dispatched click was received by something else.
ab_click() {
  local selector="$1" prepared verdict
  prepared="$(ab_eval "(() => {
    const found = document.querySelectorAll(${selector@Q});
    if (found.length !== 1) return 'MISS: ' + found.length + ' elements match';
    const el = found[0];
    if (el.disabled) return 'MISS: element is disabled';
    const box = el.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) return 'MISS: element has no size';
    window.__fv.clicks.length = 0;
    window.__fv.target = el;
    return 'ready';
  })()")"
  if [ "$prepared" != "ready" ]; then
    echo "  ab_click $selector -> ${prepared:-MISS: no instrumentation}" >&2
    return 1
  fi

  ab scrollintoview "$selector" >/dev/null 2>&1
  ab click "$selector" >/dev/null 2>&1

  verdict="$(ab_eval "(() => {
    const t = window.__fv.target, seen = window.__fv.clicks;
    // A click on a child of the target still counts: buttons contain spans.
    if (seen.some((n) => n === t || t.contains(n))) return 'HIT';
    const where = seen.map((n) => n.tagName + '.' + (n.className || '')).join(', ');
    return 'MISS: landed on ' + (where || 'nothing at all');
  })()")"
  if [ "$verdict" != "HIT" ]; then
    echo "  ab_click $selector -> $verdict" >&2
    return 1
  fi
}

# ab_click_text <tag> <exact text> — click the one element of <tag> whose text matches exactly.
ab_click_text() {
  local tag="$1" text="$2" id
  id="$(ab_eval "(() => {
    const found = [...document.querySelectorAll(${tag@Q})].filter(
      (e) => e.textContent.trim() === ${text@Q});
    if (found.length !== 1) return 'MISS: ' + found.length + ' match';
    found[0].setAttribute('data-ab-target', '1');
    return 'tagged';
  })()")"
  [ "$id" = "tagged" ] || { echo "  ab_click_text $tag '$text' -> $id" >&2; return 1; }
  local status=0
  ab_click "[data-ab-target]" || status=1
  ab_eval "(() => { document.querySelectorAll('[data-ab-target]').forEach(
    (e) => e.removeAttribute('data-ab-target')); return 'cleared'; })()" >/dev/null
  return $status
}

# ab_errors — the recorded errors, or a loud complaint if nothing was recording.
ab_errors() {
  ab_eval "(() => {
    if (!window.__fv) return 'NOT INSTRUMENTED - this number would be meaningless';
    return window.__fv.errors.length + (window.__fv.errors.length
      ? ': ' + window.__fv.errors.join(' | ') : '');
  })()"
}
