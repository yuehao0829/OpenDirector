# OpenDirector

Timeline-based AI video creation tool with native Seedance 2.0 support.

## Requirements

- Windows or macOS
- Node.js 20+
- pnpm 10+
- Rust stable
- Windows development: Visual Studio 2022 C++ build tools and WebView2 runtime
- macOS development: Homebrew if you want the setup script to install/link `pkgconf` and `gstreamer`

The automated media-runtime setup currently supports Windows and macOS only.

## First-Time Setup

Run the bootstrap command from the repo root:

```bash
pnpm bootstrap
```

What it does:

- installs workspace dependencies
- configures the repo-local GStreamer runtime in `apps/desktop/src-tauri/gstreamer-dev`
- installs `pkg-config` automatically on Windows if it is missing

Then start the desktop app:

```bash
pnpm dev
```

`pnpm dev` starts the desktop (Tauri) development flow. It will launch or reuse the desktop Vite server first, then start the native shell.

## Common Commands

- `pnpm bootstrap`: install dependencies and prepare the repo-local desktop runtime
- `pnpm dev`: start the desktop app in development mode
- `pnpm doctor:gstreamer`: inspect repo-local and environment-discovered GStreamer runtimes
- `pnpm setup:gstreamer -- --force`: reinstall or relink the repo-local GStreamer runtime
- `pnpm build`: build workspace packages
- `pnpm build:desktop`: package the desktop app

## Troubleshooting

- `pnpm dev` automatically falls back to another local port when `http://localhost:3000` is already in use.
- To force a specific dev port, set `OPENDIRECTOR_DEV_SERVER_PORT` before running `pnpm dev`.
- If `pkg-config` was installed during first-time setup on Windows, reopen the terminal before running `cargo ...` commands directly.
- The desktop app does not require a repo `.env` file to boot. Provider keys are configured inside the app settings UI.
