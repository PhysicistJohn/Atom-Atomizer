#!/usr/bin/env bash
# Fake `iio_attr`: exits 0 but prints non-numeric output on a get, to
# exercise the "unparseable output" error path.
set -euo pipefail

if [ "$#" -eq 7 ]; then
  echo "$4.$5.$6: $7"
  exit 0
fi

echo "not-a-number"
exit 0
