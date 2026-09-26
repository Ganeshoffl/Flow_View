#!/usr/bin/env bash
# Start the Vite dev server for apps/web, bound to loopback only.
set -euo pipefail
cd "$(dirname "$0")/../apps/web"
exec pnpm exec vite
