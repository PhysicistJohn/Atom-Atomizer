#!/usr/bin/env bash
# Fake `iio_attr`: ignores SIGTERM and spins forever, to exercise the
# timeout + forced SIGKILL escalation path. Deliberately uses a builtin busy
# loop (not `sleep`, which would fork a grandchild process that could hold
# the inherited stdio pipes open after this process is killed, preventing
# Node's 'close' event from ever firing). SIGKILL cannot be trapped/ignored,
# so this still terminates promptly once the transport escalates.
trap '' TERM
while true; do :; done
