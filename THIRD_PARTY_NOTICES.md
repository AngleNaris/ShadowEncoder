# Third-party notices

ShadowEncoder depends on third-party software. Copyright in those components remains with their respective owners, and their licenses apply to those components.

## Core components

| Component | License | Source |
| --- | --- | --- |
| Gifski | AGPL-3.0-or-later | https://github.com/ImageOptim/gifski |
| FFmpeg | LGPL-2.1-or-later or GPL-2.0-or-later depending on build configuration | https://ffmpeg.org/ |
| mpv / libmpv | GPL-2.0-or-later by default; LGPL-2.1-or-later builds are available | https://mpv.io/ |
| Tauri | Apache-2.0 OR MIT | https://github.com/tauri-apps/tauri |
| React | MIT | https://github.com/facebook/react |
| Material UI | MIT | https://github.com/mui/material-ui |

The exact dependency graph is recorded in `app/package-lock.json` and `app/src-tauri/Cargo.lock`. Distributors are responsible for providing the license texts and source-code offers required by the exact FFmpeg and mpv binaries they ship. This repository does not include those binaries.

Gifski is linked into the desktop application with its `gifsicle` feature. Its AGPL-3.0-or-later terms are compatible with ShadowEncoder's AGPL-3.0-or-later licensing. A distributor offering ShadowEncoder under proprietary terms must separately obtain all necessary rights for Gifski and any other copyleft dependency.
