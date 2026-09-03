# FFmpeg 运行时

ShadowEncoder 的 Windows 安装包和便携版都从仓库根目录的 `ffmpeg/win/` 读取 `ffmpeg.exe` 与 `ffprobe.exe`。这两个二进制不提交到 Git；`package:windows` 会在 Tauri 构建前检查它们必须属于 FFmpeg 9.x，便携版脚本还会检查 Tauri 复制到 `target/release/` 的文件。

## 当前打包输入

当前输入来自 gyan.dev 的 Windows 64 位 essentials 构建：

- 版本：FFmpeg 9.0 essentials build，构建标识为 `9.0-essentials_build-www.gyan.dev`。
- 下载页：[ffmpeg-release-essentials.zip](https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip)。
- 官方发布页：[FFmpeg Download](https://ffmpeg.org/download.html)。
- ZIP SHA-256：`e6b54767a6065919048f1a098eb27211ca4e12b4348a05d88777a5855d0b6e71`。
- `ffmpeg.exe` SHA-256：`227af0691433b703ffc5725e47f7d06eefc34b4a72e7870e73d30e2cda483ecf`。
- `ffprobe.exe` SHA-256：`901f0efe4793cbb0f017101e3427f816e8fbf9a407bd585f49df30f4325cfd88`。

更新本地输入时，先下载并校验归档，再只提取 `bin/ffmpeg.exe` 和 `bin/ffprobe.exe` 到 `ffmpeg/win/`。可以使用以下命令确认版本：

```powershell
cd app
npm run verify:ffmpeg
```

## FFmpeg 9 的 AI 相关能力

FFmpeg 不是训练框架，也不附带预训练模型。它提供的是可选的 DNN 推理接口和若干与机器学习相关的媒体滤镜；模型文件、训练、导出和模型转换由外部工具链负责。

FFmpeg 9.0 新增 ONNX Runtime DNN 后端，并支持执行提供器。根据编译时依赖和构建开关，DNN 能力还可以使用以下后端：

| 后端 | 模型格式 | 说明 |
| --- | --- | --- |
| TensorFlow | `.pb` | 用于 DNN 图像处理等滤镜。 |
| OpenVINO | `.xml` + `.bin` | 支持 Intel 生态的模型和执行设备。 |
| LibTorch | TorchScript `.pt` | 加载外部 TorchScript 模型。 |
| ONNX Runtime | `.onnx` | FFmpeg 9.0 新增；可使用 CUDA、DirectML 或其他构建启用的执行提供器。 |

相关滤镜包括 `dnn_processing`、`dnn_detect`、`dnn_classify`、`sr` 和 `derain`。`sr_amf` 提供 AMD AMF 硬件超分辨率，但它不属于 FFmpeg 的 DNN 后端。`libvmaf` 用于视频质量评价，也不等于视频增强或生成式 AI。

当前 gyan.dev essentials 构建的实际探测结果是：

- `dnn_processing` 不可用，因此该构建没有可直接调用的 DNN/ONNX Runtime 后端。
- `sr_amf` 和 `libvmaf` 可见，但 ShadowEncoder 当前没有调用它们。
- ShadowEncoder 没有 AI 滤镜参数、模型管理或 AI 工作流；本次升级只更新 FFmpeg 运行时，不会自动增加 AI 功能。

如果以后要加入 AI 超分或增强，应选择包含 `libonnxruntime` 的 FFmpeg 构建或自行编译 FFmpeg，并单独设计模型文件管理、GPU 执行器选择、失败回退和许可证说明。Windows 上可以优先评估 ONNX Runtime 的 DirectML 执行提供器。

## 验证

```powershell
cd app
npm test
cargo test --manifest-path src-tauri/Cargo.toml --bin shadowencoder
npm run package:portable
```

便携版构建完成后，`package:portable` 会执行 `--portable-verify`，确认自解压目录中的 FFmpeg、FFprobe、主程序和 CLI 都能启动。该检查验证运行和主版本；完整转码、GIF、WebP、序列帧和进度回归仍需要使用真实媒体执行。
