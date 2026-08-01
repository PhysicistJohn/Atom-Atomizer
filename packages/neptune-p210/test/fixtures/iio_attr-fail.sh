#!/usr/bin/env bash
# Fake `iio_attr`: emulates a non-zero exit (e.g. unreachable device).
echo "fake iio_attr: mock failure: no such device found" >&2
exit 1
