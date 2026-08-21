#!/usr/bin/env bash
# Deploy the web project (zap-eve-agent): Next app, thread API, eve proxy.
# Requires EVE_UPSTREAM_ORIGIN to be set on the project (runtime URL).
set -euo pipefail
cd "$(dirname "$0")/.."
cp vercel.web.json vercel.json
npx vercel link --yes --project zap-eve
npx vercel deploy --prod "$@"
