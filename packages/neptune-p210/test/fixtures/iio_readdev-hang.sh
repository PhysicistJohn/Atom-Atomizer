#!/usr/bin/env bash
# Fake `iio_readdev`: ignores SIGTERM, never produces output, and spins
# forever, to exercise the capture-timeout + forced SIGKILL escalation path.
# Deliberately uses a builtin busy loop (not `sleep`, which would fork a
# grandchild process that could hold the inherited stdio pipes open after
# this process is killed, preventing Node's 'close' event from ever firing).
trap '' TERM
while true; do :; done
