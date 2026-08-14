#!/usr/bin/env bash
# Optional: run every CLI once with placeholder params (requires APIFY_API_TOKEN).
# Usage from qumak-backend:
#   export APIFY_API_TOKEN=...
#   export APIFY_SCRIPT_NO_CACHE=1   # optional
#   bash scripts/apify/run-all-sample.sh

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

node scripts/apify/run-google-places.js --search "coffee shop Dubai Marina" --location UAE --max 5 --reviews --no-cache || true
node scripts/apify/run-google-search-scraper.js --queries "top ecommerce brands UAE" --resultsPerPage 20 --no-cache || true
node scripts/apify/run-instagram-scraper.js --url "https://www.instagram.com/humansofny/" --resultsLimit 5 --no-cache || true
node scripts/apify/run-facebook-ads-library.js --keyword "delivery app" --count 5 --no-cache || true
node scripts/apify/run-tiktok-profiles.js --profile "tiktok" --no-cache || true

echo "Done (individual commands may soft-fail with || true — check JSON on stdout)."
