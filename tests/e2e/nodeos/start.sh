#!/bin/bash
set -euo pipefail

DATA_DIR="/data/nodeos"
CONFIG_DIR="/config"

# First-run: initialize with genesis
if [ ! -f "${DATA_DIR}/blocks/blocks.log" ]; then
    echo "==> First run detected, initializing chain from genesis..."
    nodeos \
        --data-dir "${DATA_DIR}" \
        --config-dir "${CONFIG_DIR}" \
        --genesis-json "${CONFIG_DIR}/genesis.json" \
        --delete-all-blocks \
        "$@"
else
    echo "==> Resuming from existing chain data..."
    nodeos \
        --data-dir "${DATA_DIR}" \
        --config-dir "${CONFIG_DIR}" \
        --hard-replay-if-dirty \
        "$@"
fi
