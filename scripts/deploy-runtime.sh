#!/usr/bin/env bash
# Deploy the eve runtime project (zap-eve-agent-runtime). The root vercel.json is
# swapped per target because Vercel builds read it from the uploaded files —
# see docs/plan-v1-zap-eve.md.
set -euo pipefail
cd "$(dirname "$0")/.."
cp vercel.runtime.json vercel.json
npx vercel link --yes --project zap-eve-runtime
npx vercel deploy --prod "$@"
