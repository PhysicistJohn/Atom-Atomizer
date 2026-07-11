# TinySA Atomizer Dev launcher

`npm run dev:install-app` installs a dedicated macOS application at
`~/Applications/TinySA Atomizer Dev.app`, adds it to the Dock, and launches it.

The installed launcher is bound to this checkout. On every cold launch it rebuilds
the shared runtime packages plus Electron main/preload, starts Vite on the explicit
port in `config.json`, and then imports the freshly built main process. Renderer
changes use Vite HMR while the app is open. Main, preload, and shared-package changes
take effect after quitting and reopening the Dock app.

`config.json` is the runtime contract. It pins
`"instrumentPolicy": "physical-first-executable-twin"` and the sibling Firmware
repository. Every launch completes USB discovery first: an exact physical ZS407
suppresses the twin; otherwise Atomizer boots and connects the pinned executable
Renode twin. Discovery, bridge, evidence, build, missing `.env`, or occupied-port
failure aborts visibly and writes details to
`~/Library/Logs/TinySA Atomizer Dev.log`.

Rerun the installer after changing the launcher itself, moving the checkout, or
upgrading Electron. Ordinary application code changes do not require reinstalling.
