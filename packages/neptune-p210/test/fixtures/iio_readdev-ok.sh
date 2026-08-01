#!/usr/bin/env bash
# Fake `iio_readdev`: parses `-s <sampleCount>` out of argv and writes
# exactly sampleCount * 4 bytes (ci16le, 2 channels) of deterministic
# zeroed binary data to stdout, then exits 0.
set -euo pipefail

samples=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "-s" ]; then
    samples="$arg"
  fi
  prev="$arg"
done

if [ -z "$samples" ]; then
  echo "fake iio_readdev: missing -s <sampleCount>" >&2
  exit 2
fi

bytes=$((samples * 4))
head -c "$bytes" /dev/zero
exit 0
