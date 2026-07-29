<p align="center">
  <img src="./app/src-tauri/icons/icon.png" width="112" alt="ShadowEncoder Logo">
</p>

<h1 align="center">ShadowEncoder</h1>

<p align="center"><strong>素材进来。结果出去。</strong></p>
<p align="center">一台工作站。一条干净的媒体流程。</p>

<p align="center">
  <a href="https://github.com/AngleNaris/ShadowEncoder/releases/latest"><img alt="Release" src="https://img.shields.io/github/v/release/AngleNaris/ShadowEncoder?style=flat-square&color=111111"></a>
  <a href="./LICENSE"><img alt="AGPL-3.0-or-later" src="https://img.shields.io/badge/license-AGPL--3.0--or--later-111111?style=flat-square"></a>
  <img alt="Windows" src="https://img.shields.io/badge/Windows-10%20%7C%2011-111111?style=flat-square">
</p>

<p align="center">
  <a href="https://github.com/AngleNaris/ShadowEncoder/releases/tag/v2.2.0"><strong>下载 v2.2.0</strong></a>
  ·
  <a href="./docs/agent-cli-design.md">Agent CLI</a>
  ·
  <a href="./CONTRIBUTING.md">参与贡献</a>
</p>

## 一次打开。全部完成。

转码、截取、GIF、WebP、透明通道、混音、检测和原生播放，都在同一个安静的界面里。少一点切换，多一点完成。

## GIF 更小。透明依然干净。

[Gifski](https://gif.ski/) 1.34.0 静态内置于主程序。ShadowEncoder 通过 RGBA 帧管线保留透明像素，并提供智能压缩、体积优先和极限压缩三档策略。

Gifski 无法完成任务时，FFmpeg 调色板编码会自动接手。工作继续，不需要重新设置。

## 拷贝，不是赌博。

DIT 备份支持多个目标、媒体过滤、MD5 校验、目录结构控制和同名冲突处理。每一份素材都有去处，也有证据。

流程功能把备份、转码、检测和混音串成可复用步骤。插入磁盘，启动流程，然后让工作自己向前走。

## AI 可以动手。你始终看得见。

内置 `shadowencoder-cli` 让 Agent 与 GUI 操作同一份状态。每条命令只改变一个字段或列表项，最近 20 步操作可以冲突感知撤回，用户随时可以查看进度或中止任务。

```text
shadowencoder-cli help
```

完整 Skill 说明已经写进 CLI。没有隐藏批量修改，没有静默覆盖，也没有绕过界面。

## 一个文件。直接出发。

| 下载 | 适合场景 |
| --- | --- |
| `ShadowEncoder_2.2.0_x64-portable.exe` | 单文件便携版；内含 ShadowEncoder、Gifski、FFmpeg、FFprobe、libmpv 和 CLI |
| `ShadowEncoder_2.2.0_x64-setup.exe` | 标准 Windows 安装程序 |
| `ShadowEncoder_2.2.0_x64_en-US.msi` | Windows Installer 部署 |

便携版启动时静默展开运行时，应用退出后自动清理。Windows 10/11 提供 Tauri 所需的 WebView2 系统运行时；安装包当前未签名，请从官方 Release 下载并核对 `SHA256SUMS.txt`。

## 构建

准备 Node.js 18+、Rust stable、Visual Studio 2022 Build Tools、FFmpeg 和 64 位 libmpv。将 FFmpeg 放入 `ffmpeg/win/`，将 mpv 开发包放入 `mpv/win/64/`。

```powershell
cd app
npm install
npm test
npm run package:portable
```

`package:portable` 先生成 CLI、前端与 Tauri Windows bundle，再调用 NSIS 生成单文件便携版。首次 Tauri NSIS 构建会准备 `makensis`；也可以通过 `MAKENSIS` 环境变量指定工具路径。

## 开源

ShadowEncoder 使用 [AGPL-3.0-or-later](./LICENSE)。媒体输出不会仅因为经过 ShadowEncoder 处理而自动受 AGPL 约束。

贡献适用 [CLA](./CLA.md) 与 [贡献指南](./CONTRIBUTING.md)。第三方组件及分发注意事项见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。
