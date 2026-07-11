# TinySA Atomizer Dev launcher

`npm run dev:install-app` installs a dedicated macOS application at
`~/Applications/TinySA Atomizer Dev.app`, adds it to the Dock, and launches it.

The installed launcher is bound to this checkout. On every cold launch it rebuilds
the shared runtime packages plus Electron main/preload, starts Vite on the explicit
port in `config.json`, and then imports the freshly built main process. Renderer
changes use Vite HMR while the app is open. Main, preload, and shared-package changes
take effect after quitting and reopening the Dock app.

`config.json` is the runtime contract. Use `"deviceMode": "simulator"` while no
instrument is connected. Change it to `"usb"` after the tinySA arrives. Unknown
keys, invalid values, a missing `.env`, a build failure, or an occupied port aborts
startup with a visible error and writes details to
`~/Library/Logs/TinySA Atomizer Dev.log`.

Rerun the installer after changing the launcher itself, moving the checkout, or
upgrading Electron. Ordinary application code changes do not require reinstalling.
