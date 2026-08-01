#!/usr/bin/env bash
# Fake `iio_attr`: emulates success for both get (6 args) and set (7 args)
# invocations of `iio_attr -u URI -c DEVICE CHANNEL ATTRIBUTE [VALUE]`.
set -euo pipefail

if [ "$#" -eq 7 ]; then
  # set: real iio_attr prints a confirmation like "device.channel.attr: value"
  echo "$4.$5.$6: $7"
  exit 0
elif [ "$#" -eq 6 ]; then
  # get: emit a fixed, deterministic numeric value tests can assert on.
  echo "42000000"
  exit 0
else
  echo "fake iio_attr: unexpected argument count: $*" >&2
  exit 2
fi
