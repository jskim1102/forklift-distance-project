#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
PROJECT_ROOT=$(cd -- "$SCRIPT_DIR/.." && pwd)
BASELINE="$PROJECT_ROOT/specs/baseline.md"
MANIFEST="$PROJECT_ROOT/specs/baseline-manifest.sha256"
SOURCE_ROOTS=(backend frontend/src/utils frontend/src/hooks frontend/src/types mediamtx.yml)
SOURCE_FIND_ARGS=(
  -type f
  -not -path '*/.venv/*'
  -not -name '*.pyc'
  -not -path '*/__pycache__/*'
  -not -path '*/.pytest_cache/*'
  -not -path '*/data/weights/*'
  -not -name '*.db'
  -not -name '*.db.*.bak'
  -not -name '*.pt'
)
rc=0

fail() {
  printf 'visual-guard: FAIL: %s\n' "$*" >&2
  rc=1
}

baseline_value() {
  local key=$1
  awk -F= -v key="$key" '$1 == key { print $2; exit }' "$BASELINE"
}

require_count() {
  local value=$1
  if [[ ! "$value" =~ ^[0-9]+$ ]]; then
    return 1
  fi
  printf '%s\n' "$value"
}

source_files() {
  find "${SOURCE_ROOTS[@]}" "${SOURCE_FIND_ARGS[@]}" "$@"
}

current_source_paths() {
  source_files -print | LC_ALL=C sort
}

current_source_manifest() {
  source_files -exec sha256sum '{}' + | LC_ALL=C sort
}

manifest_source_paths() {
  sed -E 's/^[0-9a-f]{64}[[:space:]]+//' "$MANIFEST" | LC_ALL=C sort
}

cd "$PROJECT_ROOT"

if [[ "${1:-}" == "--refresh-manifest" && $# -eq 1 ]]; then
  current_source_manifest > "$MANIFEST"
  manifest_count=$(wc -l < "$MANIFEST" | tr -d ' ')
  printf 'visual-guard: manifest refreshed (%s source files)\n' "$manifest_count"
  exit 0
fi
if (( $# != 0 )); then
  printf 'usage: %s [--refresh-manifest]\n' "$0" >&2
  exit 2
fi

if [[ ! -s "$BASELINE" ]]; then
  fail "기준선 파일 없음: specs/baseline.md"
fi
if [[ ! -s "$MANIFEST" ]]; then
  fail "해시 manifest 없음: specs/baseline-manifest.sha256"
fi

if ! baseline_vitest=$(require_count "$(baseline_value vitest_passed)"); then
  fail "baseline.md의 vitest_passed 값이 없거나 정수가 아님"
  baseline_vitest=0
fi
if ! baseline_comments=$(require_count "$(baseline_value style_comment_lines)"); then
  fail "baseline.md의 style_comment_lines 값이 없거나 정수가 아님"
  baseline_comments=0
fi
if ! baseline_object_fit=$(require_count "$(baseline_value object_fit_contain_lines)"); then
  fail "baseline.md의 object_fit_contain_lines 값이 없거나 정수가 아님"
  baseline_object_fit=0
fi
if ! baseline_aria=$(require_count "$(baseline_value aria_label_occurrences)"); then
  fail "baseline.md의 aria_label_occurrences 값이 없거나 정수가 아님"
  baseline_aria=0
fi

# 0. manifest 생성 범위의 파일 추가·삭제도 해시 변경과 동일한 회귀다.
if ! source_diff=$(diff -u <(manifest_source_paths) <(current_source_paths)); then
  printf '%s\n' "$source_diff" >&2
  fail "manifest 소스 파일 집합이 달라짐(추가 또는 삭제)"
fi

# 1. backend와 MediaMTX는 rename 직후 상태에서 바뀌면 안 된다.
if ! awk '$2 ~ /^backend\// || $2 == "mediamtx.yml"' "$MANIFEST" | sha256sum --quiet -c -; then
  fail "backend 또는 mediamtx.yml이 rename 직후 기준선과 다름"
fi

# 2. 좌표·거리 수학, API 훅, 타입은 시각 작업의 변경 대상이 아니다.
if ! awk '$2 ~ /^frontend\/src\/(utils|hooks|types)\//' "$MANIFEST" | sha256sum --quiet -c -; then
  fail "frontend utils/hooks/types가 rename 직후 기준선과 다름"
fi

# 3. baseline.md가 열거한 시맨틱 랜드마크와 aria-label 수를 보존한다.
landmark_count=0
while IFS='|' read -r file literal; do
  [[ -n "$file" && -n "$literal" ]] || continue
  landmark_count=$((landmark_count + 1))
  if [[ ! -f "$file" ]]; then
    fail "랜드마크 파일 없음: $file"
  elif ! grep -Fq -- "$literal" "$file"; then
    fail "랜드마크 소실: $file :: $literal"
  fi
done < <(
  awk '/<!-- visual-guard-landmarks:start -->/ { active=1; next }
       /<!-- visual-guard-landmarks:end -->/ { active=0 }
       active && NF { print }' "$BASELINE"
)
if (( landmark_count == 0 )); then
  fail "baseline.md의 랜드마크 목록이 비어 있음"
fi

current_aria=$({ grep -Rho --include='*.ts' --include='*.tsx' 'aria-label=' frontend/src || true; } | wc -l | tr -d ' ')
if (( current_aria < baseline_aria )); then
  fail "aria-label 감소: baseline=$baseline_aria current=$current_aria"
fi

# 4. contain은 letterbox 좌표 보정의 전제다.
current_object_fit=$(grep -c 'object-fit: contain' frontend/src/styles.css || true)
if (( current_object_fit < baseline_object_fit )); then
  fail "object-fit: contain 감소: baseline=$baseline_object_fit current=$current_object_fit"
fi

# 5. 기능 주석이 시각 재작성 중 소실되지 않게 한다.
current_comments=$(grep -c '/\*' frontend/src/styles.css || true)
if (( current_comments < baseline_comments )); then
  fail "styles.css 기능 주석 감소: baseline=$baseline_comments current=$current_comments"
fi

# 6. solution-style tsconfig의 실제 타입체크 경로와 전체 Vitest를 실행한다.
if build_output=$(cd frontend && NO_COLOR=1 npm run build 2>&1); then
  printf '%s\n' "$build_output"
else
  printf '%s\n' "$build_output" >&2
  fail "frontend npm run build 실패"
fi

if vitest_output=$(cd frontend && NO_COLOR=1 npx vitest run 2>&1); then
  printf '%s\n' "$vitest_output"
  current_vitest=$(printf '%s\n' "$vitest_output" | sed -nE 's/.*Tests[[:space:]]+([0-9]+)[[:space:]]+passed.*/\1/p' | tail -n 1)
  if ! current_vitest=$(require_count "$current_vitest"); then
    fail "Vitest 출력에서 통과 수를 읽지 못함"
    current_vitest=0
  fi
  if (( current_vitest < baseline_vitest )); then
    fail "Vitest 통과 수 감소: baseline=$baseline_vitest current=$current_vitest"
  fi
else
  printf '%s\n' "$vitest_output" >&2
  fail "frontend Vitest 실패"
fi

if (( rc == 0 )); then
  echo "visual-guard: OK"
fi
exit "$rc"
