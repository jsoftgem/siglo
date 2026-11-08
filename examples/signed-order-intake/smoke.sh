#!/bin/sh
set -eu
cd "$(dirname "$0")/../.."
for scenario in standard gift review tamper expired replay; do
  node --import tsx examples/src/signed-order-intake/client.ts "$scenario"
done
