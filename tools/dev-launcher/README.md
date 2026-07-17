# Atomizer Dev launcher

`npm run dev:install-app` installs a dedicated macOS application at
`~/Applications/Atomizer Dev.app`, adds it to the Dock, and launches it.

Before installation, `.env` must be a regular file at the repository root—not
a symlink—owned by the current user, readable by that owner, and inaccessible
to group and other users. For an existing file, correct its permissions with:

```bash
chmod 600 .env
```

Both installation and every cold launch validate those properties from file
metadata without reading or logging the file contents. A missing file, symlink,
special file, ownership mismatch, or group/other permission bit fails closed
with the rejected path, observed metadata where safe, and a corrective action.

The installed launcher is bound to this checkout. On every cold launch it rebuilds
and protocol-validates the sibling SignalLab measurement bridge, rebuilds the shared
runtime packages plus Electron main/preload, starts Vite on the explicit port in
`config.json`, and then imports the freshly built main process. Renderer changes use
Vite HMR while the app is open. Main, preload, shared-package, and SignalLab bridge
changes take effect after quitting and reopening the Dock app.

`config.json` is the runtime contract. It pins
`"instrumentPolicy": "signal-lab-default-no-fallback"` and the sibling SignalLab
repository. The launcher passes the freshly built bridge through the explicit
`ATOMIZER_SIGNAL_LAB_BRIDGE` boundary. A fresh launcher profile starts with SignalLab;
Atomizer honors later explicit device selections, and startup admission never falls
through to another driver when the preferred driver fails. SignalLab build, bridge
handshake, discovery, evidence, insecure or missing `.env`, or occupied-port
failure aborts visibly and writes details to
`~/Library/Logs/Atomizer Dev.log`. The current log and its sole `.1`
rotation are each capped at 4 MiB; one child-process write is capped at 64 KiB,
so repeated live-edit sessions cannot grow diagnostics without bound.

The launcher also starts Electron's local crash reporter with uploads disabled,
records the crash-dump path, and retains bounded renderer memory samples and
`render-process-gone` details. The two historical macOS renderer reports examined
for the July 2026 crash are identical `SIGTRAP`/`EXC_BREAKPOINT` failures in
Electron's allocator path; the fault context includes a 2 GiB-sized value while
the renderer's resident writable regions were only about 17 MiB. That evidence is
consistent with one pathological allocation, not a gradual renderer leak. It does
not identify the initiating JavaScript or Electron API, and screenshot capture is
not established as the cause.

Rerun the installer after changing the launcher itself, moving the checkout, or
upgrading Electron. Ordinary application code changes do not require reinstalling.
