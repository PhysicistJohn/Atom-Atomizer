#!/usr/bin/env bash
# Fake `iio_readdev`: exits 0 (clean exit) but writes fewer bytes than
# requested, to exercise the "short capture" error path.
set -euo pipefail

samples=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "-s" ]; then
    samples="$arg"
  fi
  prev="$arg"
done

full_bytes=$((samples * 4))
short_bytes=$((full_bytes / 2))
head -c "$short_bytes" /dev/zero
exit 0
