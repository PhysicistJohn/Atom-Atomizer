#!/usr/bin/env bash
# Fake `iio_readdev`: exits 0 but delivers zero bytes and writes a stderr
# message, matching a real observed failure mode -- a stuck AD9361
# DMA/buffer pipeline reports "Unable to refill buffer: Unknown error 110"
# (ETIMEDOUT) on stderr while still exiting cleanly. Exercises that this
# diagnostic detail is not silently discarded.
set -euo pipefail
echo "Unable to refill buffer: Unknown error 110" 1>&2
exit 0
