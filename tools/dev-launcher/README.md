# TinySA Atomizer Dev launcher

`npm run dev:install-app` installs a dedicated macOS application at
`~/Applications/TinySA Atomizer Dev.app`, adds it to the Dock, and launches it.

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
handshake, discovery, evidence, missing `.env`, or occupied-port failure aborts
visibly and writes details to
`~/Library/Logs/TinySA Atomizer Dev.log`. The current log and its sole `.1`
rotation are each capped at 4 MiB; one child-process write is capped at 64 KiB,
so repeated live-edit sessions cannot grow diagnostics without bound.

Rerun the installer after changing the launcher itself, moving the checkout, or
upgrading Electron. Ordinary application code changes do not require reinstalling.
