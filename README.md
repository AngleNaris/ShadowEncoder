# ShadowEncoder

ShadowEncoder is a desktop media toolbox built with Tauri, React, Rust, FFmpeg, and libmpv. It provides video transcoding, clipping, GIF/WebP export, alpha-channel composition, audio processing, media inspection, and native playback in one application.

## GIF compression

GIF export uses [Gifski](https://gif.ski/) with FFmpeg decoding and preserves transparent pixels through an RGBA frame pipeline. Three volume-oriented profiles are available:

- **Smart compression (recommended):** balanced quality and file size (`quality=70`).
- **Size first:** stronger lossy compression (`quality=60`, `lossy-quality=60`, `motion-quality=60`).
- **Maximum compression:** smallest practical output (`quality=50`, `lossy-quality=40`, `motion-quality=50`).

If Gifski cannot complete an export, ShadowEncoder automatically falls back to FFmpeg's palette-based GIF encoder. Existing presets using the earlier `quality` or `smallest` values remain compatible.

## Requirements

- Node.js 18 or newer
- Rust stable toolchain
- FFmpeg and FFprobe
- libmpv development/runtime files
- Windows: Visual Studio 2022 Build Tools with the MSVC C++ workload

For the bundled Windows development scripts, put FFmpeg executables in `ffmpeg/win/` and the 64-bit mpv development package in `mpv/win/64/`. These binaries are intentionally not committed.

## Development

```powershell
cd app
npm install
dev-tauri.bat
```

Frontend-only checks:

```powershell
cd app
npm test
npx tsc --noEmit
```

Rust checks:

```powershell
cd app/src-tauri
cargo test
```

## Agent CLI

The application exposes a current-user-only local IPC service while it is running. The bundled `shadowencoder-cli` lets an AI Agent inspect the shared queue, edit one preset field or list item per command, run supported non-destructive tasks, watch GUI-visible progress, and undo the latest eligible Agent operation. Run `shadowencoder-cli help` to print the complete embedded Skill Markdown without starting the GUI.

Build and stage the matching sidecar from an MSVC developer environment:

```powershell
cd app
npm run build:cli
```

Create a Windows bundle containing both the GUI and CLI:

```powershell
cd app
npm run package:windows
```

The generated target-triple sidecar under `app/src-tauri/binaries/` is a build artifact and is not committed.

## Licensing

ShadowEncoder is licensed under the [GNU Affero General Public License v3.0 or later](LICENSE). Network users must be offered the Corresponding Source for the version they interact with. GIFs, videos, and other media produced with ShadowEncoder are not automatically covered by the AGPL merely because the program processed them.

Contributions are accepted under the [Contributor License Agreement](CLA.md). See [CONTRIBUTING.md](CONTRIBUTING.md) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
