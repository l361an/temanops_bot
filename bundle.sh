#!/usr/bin/env bash
# bundle.sh - gabungkan semua source code repo jadi SATU file teks
# supaya gampang di-upload / di-paste ke Claude.
#
# Pemakaian:
#   chmod +x bundle.sh
#   ./bundle.sh              -> hasil: bundle.txt
#   ./bundle.sh out.txt      -> hasil: out.txt
#   ./bundle.sh --git        -> hasil: repo.bundle (git bundle, bawa seluruh history)
#
# Jalankan dari root repo (folder yang ada worker.js).

set -euo pipefail

# ---- mode git bundle (opsional) ----
if [[ "${1:-}" == "--git" ]]; then
  git bundle create repo.bundle --all
  echo "OK -> repo.bundle ($(du -h repo.bundle | cut -f1))"
  exit 0
fi

OUT="${1:-bundle.txt}"

# Ekstensi file yang ikut dibundle
INCLUDE_EXT='js|mjs|ts|json|toml|md|sh|sql|html|css|yml|yaml'

# File/folder yang DILEWATI (tambahkan sesuai kebutuhan)
EXCLUDE_REGEX='(^|/)(\.git|node_modules|\.wrangler|dist|build)(/|$)|(^|/)(\.dev\.vars|\.env.*|package-lock\.json|workers\.old\.js)$|(^|/)'"$(basename "$OUT")"'$'

# Ambil daftar file: pakai git kalau ada (otomatis hormati .gitignore),
# kalau tidak pakai find.
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  FILES=$(git ls-files --cached --others --exclude-standard)
else
  FILES=$(find . -type f | sed 's|^\./||')
fi

FILES=$(echo "$FILES" \
  | grep -E "\.(${INCLUDE_EXT})$" \
  | grep -Ev "$EXCLUDE_REGEX" \
  | sort)

{
  echo "# BUNDLE: $(basename "$PWD")"
  echo "# Dibuat: $(date '+%Y-%m-%d %H:%M:%S')"
  if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    echo "# Commit: $(git rev-parse --short HEAD 2>/dev/null || echo 'n/a')"
  fi
  echo
  echo "## DAFTAR FILE"
  echo "$FILES" | sed 's/^/- /'
  echo

  while IFS= read -r f; do
    [[ -f "$f" ]] || continue
    echo
    echo "================================================================"
    echo "FILE: $f"
    echo "================================================================"
    cat "$f"
    echo
  done <<< "$FILES"
} > "$OUT"

echo "OK -> $OUT"
echo "  file : $(echo "$FILES" | wc -l)"
echo "  ukuran: $(du -h "$OUT" | cut -f1)"
echo
echo "PENTING: cek dulu isi $OUT, pastikan tidak ada token/secret sebelum dikirim!"
