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
