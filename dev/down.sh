#!/usr/bin/env bash
# Deletes the demo cluster dev/up.sh made. Nothing else is touched.
set -euo pipefail
CLUSTER="${CLUSTER:-gatewayapi-demo}"
kind delete cluster --name "$CLUSTER"
