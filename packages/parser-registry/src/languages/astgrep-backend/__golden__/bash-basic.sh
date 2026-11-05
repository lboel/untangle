#!/usr/bin/env bash
# Deploys the app.
set -euo pipefail

MAX_RETRIES=3
readonly TARGET="${1:-staging}"

source ./lib/common.sh
. ./lib/log.sh

log_info() {
    printf '%s\n' "$*" >&2
}

function retry() {
    local attempt=0
    while [ "$attempt" -lt "$MAX_RETRIES" ]; do
        if "$@"; then
            return 0
        elif [ "$attempt" -gt 1 ]; then
            log_info "retrying"
        fi
        attempt=$((attempt + 1))
    done
    return 1
}

deploy() {
    case "$TARGET" in
        staging)
            log_info "staging"
            ;;
        prod|production)
            log_info "prod"
            ;;
        *)
            return 1
            ;;
    esac

    for f in ./dist/*; do
        [ -f "$f" ] || continue
        if [ -x "$f" ] && [ -s "$f" ]; then
            log_info "$f"
        fi
    done

    until retry true; do
        break
    done
}

deploy
