#!/usr/bin/env bash
# Replaces non-ASCII typographic glyphs in TS/TSX string literals with \uXXXX
# escapes so source files stay pure ASCII (see global instructions).
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"

mapfile -t files < <(find "$root/web/src" "$root/server/src" -type f \( -name '*.ts' -o -name '*.tsx' \) 2>/dev/null)

changed=0
for f in "${files[@]}"; do
  if LC_ALL=C grep -q $'\xc2\xb7\|\xe2\x86\x92\|\xe2\x80\xa6\|\xe2\x88\x92\|\xe2\x86\x90' "$f"; then
    perl -i -pe 's/\x{00B7}/\\u00B7/g; s/\x{2192}/\\u2192/g; s/\x{2026}/\\u2026/g; s/\x{2212}/\\u2212/g; s/\x{2190}/\\u2190/g' -CSD "$f"
    echo "asciified: ${f#$root/}"
    changed=$((changed + 1))
  fi
done
echo "Asciified $changed file(s)"

bad=0
for f in "${files[@]}"; do
  if perl -ne 'exit 1 if /[\x80-\xFF]/' "$f"; then :; else
    echo "REMAINING NON-ASCII: ${f#$root/}"
    bad=1
  fi
done
[ "$bad" -eq 0 ] && echo "All files ASCII-clean"
