#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VENDOR="$ROOT/vendor"

mkdir -p "$VENDOR"

clone_or_pull() {
  local url="$1"
  local dir="$2"
  local extra="${3:-}"

  if [[ -d "$dir/.git" ]]; then
    echo "→ pull $dir"
    git -C "$dir" pull --ff-only
  else
    echo "→ clone $url → $dir"
    # shellcheck disable=SC2086
    git clone --depth 1 $extra "$url" "$dir"
  fi
}

clone_or_pull "https://github.com/LeoStehlik/no-slop-ui.git" "$VENDOR/no-slop-ui"
clone_or_pull "https://github.com/Nutlope/hallmark.git" "$VENDOR/hallmark"

if [[ ! -d "$VENDOR/open-design/.git" ]]; then
  echo "→ sparse clone open-design (design-systems only)"
  git clone --depth 1 --filter=blob:none --sparse \
    "https://github.com/nexu-io/open-design.git" "$VENDOR/open-design-full"
  git -C "$VENDOR/open-design-full" sparse-checkout set design-systems
else
  clone_or_pull "https://github.com/nexu-io/open-design.git" "$VENDOR/open-design-full" \
    "--filter=blob:none --sparse"
fi

echo ""
echo "Done. Cursor rules are in .cursor/rules/"
echo "Project design contract: DESIGN.md"
