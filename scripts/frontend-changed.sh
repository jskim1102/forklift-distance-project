#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
PROJECT_ROOT=$(cd -- "$SCRIPT_DIR/.." && pwd)
BASELINE_DIR="$PROJECT_ROOT/specs/frontend-pre-redesign"
CURRENT_DIR="$PROJECT_ROOT/frontend/src"

if [[ ! -d "$BASELINE_DIR" ]]; then
  echo "frontend-changed: 기준선 디렉터리 없음: specs/frontend-pre-redesign" >&2
  exit 1
fi
if [[ ! -d "$CURRENT_DIR" ]]; then
  echo "frontend-changed: 현재 소스 디렉터리 없음: frontend/src" >&2
  exit 1
fi

if ! relative_paths=$(
  {
    find "$BASELINE_DIR" -type f -printf '%P\n'
    find "$CURRENT_DIR" -type f -printf '%P\n'
  } | LC_ALL=C sort -u
); then
  echo "frontend-changed: 프론트 파일 목록을 읽지 못함" >&2
  exit 1
fi

while IFS= read -r relative_path; do
  [[ -n "$relative_path" ]] || continue

  baseline_path="$BASELINE_DIR/$relative_path"
  current_path="$CURRENT_DIR/$relative_path"
  if [[ ! -f "$baseline_path" || ! -f "$current_path" ]]; then
    printf 'frontend/src/%s\n' "$relative_path"
  elif cmp -s -- "$baseline_path" "$current_path"; then
    continue
  else
    cmp_rc=$?
    if (( cmp_rc > 1 )); then
      printf 'frontend-changed: 파일 비교 실패: frontend/src/%s\n' "$relative_path" >&2
      exit 1
    fi
    printf 'frontend/src/%s\n' "$relative_path"
  fi
done <<< "$relative_paths"
