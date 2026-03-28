#!/usr/bin/env bash
# =============================================================================
# scripts/smart-test.sh — Tiered Smart Test Runner for Kosca AR System
#
# Usage:
#   bash scripts/smart-test.sh <changed-file>          # auto-detect tier
#   bash scripts/smart-test.sh <changed-file> --all    # force full suite
#   bash scripts/smart-test.sh --smoke                 # smoke only
#   bash scripts/smart-test.sh --unit                  # all unit tests only
#   bash scripts/smart-test.sh --e2e                   # all E2E tests only
#
# Test tiers run in order:
#   1. Smoke        — HTTP health checks (always, <5s)
#   2. Unit         — Jest with mocked Prisma (no DB needed)
#   3. Integration  — Supertest route tests (included in unit tier)
#   4. Black Box    — Playwright E2E on running app (needs :3001)
#   5. Regression   — Full Jest + E2E suite (global changes only)
#
# A2B (before-to-after) snapshots:
#   Run with --snapshot-before before making changes to capture baseline.
#   After changes, the smoke step auto-compares if a snapshot exists.
# =============================================================================

set -euo pipefail

CHANGED_FILE=""
FORCE_TIER=""

# Parse args
while [[ $# -gt 0 ]]; do
    case "$1" in
        --smoke)      FORCE_TIER="smoke";   shift ;;
        --unit)       FORCE_TIER="unit";    shift ;;
        --e2e)        FORCE_TIER="e2e";     shift ;;
        --all)        FORCE_TIER="global";  shift ;;
        --snapshot-before) FORCE_TIER="snapshot"; shift ;;
        -*)           echo "Unknown flag: $1"; exit 1 ;;
        *)            CHANGED_FILE="$1"; shift ;;
    esac
done

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SNAPSHOT_DIR="$PROJECT_DIR/.test-snapshots"
cd "$PROJECT_DIR"

# ── Colours ──────────────────────────────────────────────────────────────────
CYAN='\033[0;36m'; GREEN='\033[0;32m'; RED='\033[0;31m'
YELLOW='\033[1;33m'; BOLD='\033[1m'; DIM='\033[2m'; NC='\033[0m'

header() { echo -e "\n${BOLD}${CYAN}━━━ $1 ━━━${NC}"; }
pass()   { echo -e "  ${GREEN}✔  $1${NC}"; }
fail()   { echo -e "  ${RED}✘  $1${NC}"; }
info()   { echo -e "  ${YELLOW}ℹ  $1${NC}"; }
dim()    { echo -e "  ${DIM}$1${NC}"; }

FAILURES=0
SKIPPED=0
START_TIME=$(date +%s)

fail_track() { fail "$1"; FAILURES=$((FAILURES + 1)); }
skip_track() { info "SKIP — $1"; SKIPPED=$((SKIPPED + 1)); }

# ── Get impact analysis ───────────────────────────────────────────────────────
if [ "$FORCE_TIER" = "smoke" ]; then
    TIER="smoke"; UNIT_TESTS=""; E2E_SPECS=""; REASON="Smoke-only run"
elif [ "$FORCE_TIER" = "unit" ]; then
    TIER="unit"; UNIT_TESTS="tests/routes/ar"; E2E_SPECS=""; REASON="All unit tests"
elif [ "$FORCE_TIER" = "e2e" ]; then
    TIER="e2e"; UNIT_TESTS=""; E2E_SPECS="$(ls e2e/*.spec.js 2>/dev/null | tr '\n' ' ')"; REASON="All E2E specs"
elif [ "$FORCE_TIER" = "global" ]; then
    TIER="global"; UNIT_TESTS="tests/routes/ar"; E2E_SPECS="$(ls e2e/*.spec.js 2>/dev/null | tr '\n' ' ')"; REASON="Full regression suite"
elif [ -n "$CHANGED_FILE" ]; then
    if ! IMPACT=$(node scripts/impact-map.js "$CHANGED_FILE" 2>/dev/null); then
        info "Impact map could not parse file — running smoke only"
        TIER="unknown"; UNIT_TESTS=""; E2E_SPECS="e2e/auth.spec.js"; REASON="Impact map error"
    else
        TIER=$(echo "$IMPACT"       | python3 -c "import json,sys; print(json.load(sys.stdin)['tier'])")
        REASON=$(echo "$IMPACT"     | python3 -c "import json,sys; print(json.load(sys.stdin)['reason'])")
        UNIT_TESTS=$(echo "$IMPACT" | python3 -c "import json,sys; print(' '.join(json.load(sys.stdin)['unitTests']))")
        E2E_SPECS=$(echo "$IMPACT"  | python3 -c "import json,sys; print(' '.join(json.load(sys.stdin)['e2eSpecs']))")
    fi
else
    info "No file specified — running smoke tests"
    TIER="smoke"; UNIT_TESTS=""; E2E_SPECS=""; REASON="No file specified"
fi

# ── Header ────────────────────────────────────────────────────────────────────
echo -e "\n${BOLD}${CYAN}╔════════════════════════════════════════╗"
echo -e "║        KOSCA AR — SMART TESTS          ║"
echo -e "╚════════════════════════════════════════╝${NC}"
[ -n "$CHANGED_FILE" ] && dim "File:   $CHANGED_FILE"
dim "Tier:   $TIER"
dim "Reason: $REASON"

# ── A2B Snapshot — before-to-after comparison ────────────────────────────────
do_snapshot() {
    local label="$1"
    mkdir -p "$SNAPSHOT_DIR"
    local endpoints=(
        "http://localhost:3001/health"
        "http://localhost:3001/login"
    )
    for url in "${endpoints[@]}"; do
        local safe=$(echo "$url" | sed 's|[^a-zA-Z0-9]|_|g')
        local snap_file="$SNAPSHOT_DIR/${safe}_${label}.txt"
        curl -sf -o /dev/null -w "%{http_code} %{content_type} %{size_download}" "$url" \
            > "$snap_file" 2>/dev/null && dim "Snapshot: $snap_file" || true
    done
}

compare_snapshots() {
    local endpoints=(
        "http://localhost:3001/health"
        "http://localhost:3001/login"
    )
    local diffs=0
    for url in "${endpoints[@]}"; do
        local safe=$(echo "$url" | sed 's|[^a-zA-Z0-9]|_|g')
        local before="$SNAPSHOT_DIR/${safe}_before.txt"
        local after_file="$SNAPSHOT_DIR/${safe}_after_tmp.txt"
        [ ! -f "$before" ] && continue
        curl -sf -o /dev/null -w "%{http_code} %{content_type} %{size_download}" "$url" \
            > "$after_file" 2>/dev/null || true
        if ! diff -q "$before" "$after_file" > /dev/null 2>&1; then
            fail_track "A2B diff on $url — before: $(cat $before) | after: $(cat $after_file)"
            diffs=$((diffs + 1))
        fi
    done
    [ "$diffs" -eq 0 ] && pass "A2B check — no response signature changes"
}

if [ "$FORCE_TIER" = "snapshot" ]; then
    header "A2B Snapshot (Before)"
    if curl -sf http://localhost:3001/health > /dev/null 2>&1; then
        do_snapshot "before"
        pass "Baseline snapshot saved to .test-snapshots/"
        info "Make your changes, then run: bash scripts/smart-test.sh <file>"
    else
        skip_track "Server not running — cannot snapshot"
    fi
    exit 0
fi

# ── 1. SMOKE TESTS — always run ───────────────────────────────────────────────
header "1. Smoke Tests"
APP_UP=false

if curl -sf http://localhost:3001/health > /dev/null 2>&1; then
    pass "Server health (:3001/health)"
    APP_UP=true
else
    skip_track "Server not reachable at :3001 — start with: docker compose up -d"
fi

if $APP_UP; then
    STATUS=$(curl -sf -o /dev/null -w "%{http_code}" http://localhost:3001/login 2>/dev/null)
    [ "$STATUS" = "200" ] && pass "Login page (200)" || fail_track "Login page returned $STATUS"

    # A2B comparison if before-snapshot exists
    if ls "$SNAPSHOT_DIR"/*_before.txt > /dev/null 2>&1; then
        header "A2B Comparison"
        compare_snapshots
        do_snapshot "after"
    fi
fi

# Stop here for smoke-only runs
[ "$FORCE_TIER" = "smoke" ] && { header "Done"; [ "$FAILURES" -eq 0 ] && pass "Smoke passed" || fail_track "Smoke failed"; exit $FAILURES; }

# ── 2. UNIT + INTEGRATION TESTS (Jest / Supertest) ───────────────────────────
if [ -n "$UNIT_TESTS" ] && [ "$TIER" != "view" ] && [ "$TIER" != "partial" ]; then
    header "2. Unit + Integration Tests (Jest)"
    for TEST_PATH in $UNIT_TESTS; do
        if [ -e "$TEST_PATH" ]; then
            dim "→ $TEST_PATH"
            if npx jest --testPathPatterns "$TEST_PATH" --no-coverage 2>&1; then
                pass "$TEST_PATH"
            else
                fail_track "$TEST_PATH"
            fi
        else
            skip_track "$TEST_PATH not found — create it for this area"
        fi
    done
else
    [ "$TIER" = "view" ] || [ "$TIER" = "partial" ] \
        && dim "Skipping unit tests — template-only change" \
        || dim "No unit tests mapped for this file"
fi

# ── 3. BLACK BOX / E2E TESTS (Playwright) ────────────────────────────────────
if [ -n "$E2E_SPECS" ]; then
    header "3. Black Box / E2E Tests (Playwright)"
    if ! $APP_UP; then
        skip_track "Server not running — skipping all E2E specs"
    else
        for SPEC in $E2E_SPECS; do
            if [ -e "$SPEC" ]; then
                dim "→ $SPEC"
                if npx playwright test "$SPEC" --reporter=line 2>&1; then
                    pass "$SPEC"
                else
                    fail_track "$SPEC"
                    info "  Report: npx playwright show-report playwright-report"
                fi
            else
                skip_track "$SPEC not found — create it for this area"
            fi
        done
    fi
fi

# ── 4. FULL REGRESSION (global tier) ─────────────────────────────────────────
if [ "$TIER" = "global" ] || [ "$FORCE_TIER" = "global" ]; then
    header "4. Full Regression (global change detected)"
    info "Running all Jest unit tests..."
    if npx jest --no-coverage 2>&1; then
        pass "All unit tests passed"
    else
        fail_track "Unit regression failures"
    fi
fi

# ── Summary ───────────────────────────────────────────────────────────────────
END_TIME=$(date +%s)
ELAPSED=$((END_TIME - START_TIME))

header "Summary"
dim "Duration: ${ELAPSED}s | Failures: $FAILURES | Skipped: $SKIPPED | Tier: $TIER"

if [ "$FAILURES" -eq 0 ] && [ "$SKIPPED" -eq 0 ]; then
    echo -e "\n${GREEN}${BOLD}  ✔  All tests passed${NC}\n"
    exit 0
elif [ "$FAILURES" -eq 0 ]; then
    echo -e "\n${YELLOW}${BOLD}  ⚠  Tests passed (${SKIPPED} skipped — server may be down)${NC}\n"
    exit 0
else
    echo -e "\n${RED}${BOLD}  ✘  ${FAILURES} suite(s) failed${NC}\n"
    exit 1
fi
