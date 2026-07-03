#!/usr/bin/env bash
set -euo pipefail
echo "=== Building Nubyone Desktop ==="
cd "$(dirname "$0")/Nubyone-Desktop"
npm install
npm run build
echo "=== Done ==="
