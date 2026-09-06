# ShadowEncoder 验证记录

日期：2026-07-30

## Windows 2.2.1 发布验证

- 日期：2026-07-31。
- `cd app && npm test`：89/89 通过。
- `cargo test --manifest-path app/agent-protocol/Cargo.toml`：3/3 通过。
- `cargo test --manifest-path app/agent-core/Cargo.toml`：14/14 通过。
- `cargo test --manifest-path app/agent-cli/Cargo.toml`：8/8 通过。
- `cargo test --manifest-path app/src-tauri/Cargo.toml --bin shadowencoder`：38 通过、1 项按环境忽略。
- `cd app && npm run package:portable`：使用独立 `CARGO_TARGET_DIR` 完成 TypeScript、Vite、CLI、Tauri、MSI、NSIS 与便携版构建。
- 便携版 `--portable-verify` 返回 0，内置 FFmpeg 与 FFprobe 均从自解压目录实际运行。
- 转码默认输出已移除 `_se` 后缀；同名文件通过唯一文件名逻辑安全避让，对应前后端回归测试通过。

| 产物 | 大小 | SHA-256 |
| --- | ---: | --- |
| `ShadowEncoder_2.2.1_x64-portable.exe` | 91,566,194 字节 | `48A3DC548CA34E5C0528DFF4553FB6BB443F00963BC6107C14FB4B1110149210` |
| `ShadowEncoder_2.2.1_x64-setup.exe` | 91,735,830 字节 | `ED6FE520E581FB57B6E68B860A2C59DE6B02C5BCDD8B85CD66F1FE6F46964616` |
| `ShadowEncoder_2.2.1_x64_en-US.msi` | 125,464,576 字节 | `68FF653128BFEE22E21208DEF8AB1AD3A10EC6AD6A3777137DCF01D613664759` |

## 便携版生产协议修复

- 根因：旧 Windows release 构建未启用 Cargo `custom-protocol` 特性，Tauri 因而加载开发地址 `http://127.0.0.1:1420`，在用户机器上显示“连接被拒绝”。
- 修复：`package:windows` 显式传入 `--features custom-protocol`；`--portable-verify-runtime` 会拒绝缺少该特性的主程序；单文件便携包生成后自动执行完整自检。
- 新便携包：90,846,604 字节，SHA-256 `6EEC1DE4A3C10448959D4143757150C95C2E90E9BBDD44E3A555776123C31E82`；Cargo 指纹为 `["custom-protocol"]`，自动 `--portable-verify` 通过。
- CLI 边界：CLI 在应用关闭时对 `status --json` 返回 `APP_NOT_RUNNING` 和退出码 2。它保留为安装包和便携包内的 Agent 控制端，不再作为可独立工作的 Release 附件分发。
- 任务运行 UI：移除全局“任务执行中”浮层；导航、参数编辑、素材变更和播放器控件仍按原规则锁定，素材滚动、结果切换与各功能页停止按钮保持可用。

## 本轮范围

- 预设管理器与主界面共用字段显示和禁用规则。
- DIT 备份预设直接复用主界面的 `BackupFields`，不再维护预设专用分支。
- 流程来源过滤、路径去重和容量计算抽为可执行的纯逻辑。
- DIT 文件复制抽为无 Tauri 窗口依赖的核心，覆盖真实复制、MD5、取消清理和拒绝覆盖。
- 补充 Gifski 三档压缩质量参数测试。
- 内置 `shadowencoder-cli`，让 Agent 通过仅限当前用户的本地 IPC 与 GUI 共用 Rust/SQLite 状态。
- Agent 每次只修改一个字段、列表项、素材或流程步骤；保留最近 20 步操作并执行冲突感知撤回。
- Agent 任务使用冻结的预设快照，支持编码、混音、检测、透明通道、备份和流程，并拒绝移动源文件、覆盖输出等破坏性行为。

## 已执行的自动化验证

| 验证 | 结果 | 覆盖重点 |
| --- | --- | --- |
| `cd app && npm test` | 61/61 通过 | 预设字段状态、Agent 任务桥接、预设快照、流程过滤/递归/去重/容量、媒体子进程无窗口入口、既有前端逻辑 |
| `cargo test --manifest-path app/agent-protocol/Cargo.toml` | 3/3 通过 | CLI/GUI 协议序列化与命令契约 |
| `cargo test --manifest-path app/agent-core/Cargo.toml` | 10/10 通过 | SQLite 状态、单步修改、安全限制、任务与冲突感知撤回 |
| `cargo test --manifest-path app/agent-cli/Cargo.toml` | 4/4 通过 | 命令解析、请求构造、完整 Skill 帮助输出 |
| `cd app && npm run build` | 通过 | TypeScript 与 Vite 生产构建 |
| `cargo fmt --manifest-path app/src-tauri/Cargo.toml -- --check` | 通过 | Rust 格式 |
| `cargo check --manifest-path app/src-tauri/Cargo.toml` | 通过 | 使用隔离目标目录 `app/src-tauri/target-agent-check` 完成 Tauri/Rust 编译检查 |
| `cargo test --manifest-path app/src-tauri/Cargo.toml --bin shadowencoder` | 26 通过、1 忽略 | DIT 真实复制/MD5/取消、GIF 透明与压缩参数、Agent IPC、既有后端逻辑 |
| `cd app && npm run package:windows` | 通过 | CLI sidecar、Tauri release 主程序、MSI 与 NSIS 安装包 |
| `cd app && node scripts/package-portable.mjs` | 通过 | NSIS 单文件便携版，静态 Gifski 与全部应用自带运行时 |
| `git diff --check` | 通过 | 空白符与补丁格式 |

构建仍有既存的单个 JS chunk 超过 500 kB 警告，不影响本轮构建结果。

自动化测试发现并修复了一项旧问题：同一卷的根路径在 `D:` / `d:` 大小写不同的情况下会被错误视为两个卷，导致多目标容量计算失真。

## CLI Sidecar 产物

- 路径：`app/src-tauri/binaries/shadowencoder-cli-x86_64-pc-windows-msvc.exe`
- 大小：430,592 字节
- SHA-256：`8C1601F812F50FD9D43FCCEB21B2071F1E1C1E7D128878B17DDF33D82AAB47C5`
- 版本输出：`shadowencoder-cli 2.2.0 (protocol 1)`
- `help`：退出码 0；已确认包含 frontmatter、完整操作规则、非破坏性策略、错误处理和完成报告要求。
- 应用关闭时执行 `status --json`：退出码 2，并返回结构化 `APP_NOT_RUNNING`，没有启动或操作 GUI。
- 除 `help` 和 `--version` 外，CLI 只连接已经运行的 ShadowEncoder；本轮按约束没有启动或操作 GUI，因此实时 IPC 与 GUI 状态同步留给用户验证。

## Windows 2.2.0 发布产物

| 产物 | 大小 | SHA-256 |
| --- | ---: | --- |
| `ShadowEncoder_2.2.0_x64_en-US.msi` | 124,563,456 字节 | `9D3DCA5D5D53B3235A2D414BEABD234CFB4154811E6D1D5F0484992C19EF93EF` |
| `ShadowEncoder_2.2.0_x64-setup.exe` | 90,998,002 字节 | `015D52FA52BC378BE30CD6EB99925B6866E4D2CCD50D764D41BC40DDDC50FF65` |
| `shadowencoder.exe` | 14,412,800 字节 | `098DBA47C3914680E8DE8A749DBBB4665E39F88CE7034D99EB54BDB2A4521142` |
| `ShadowEncoder_2.2.0_x64-portable.exe` | 90,842,529 字节 | `8EE7F20C5BC82C11FBFF97BEE2610A6C10D87577896286BCEFA99B863D464D5E` |

- NSIS 安装包和主程序的文件版本、产品版本均为 `2.2.0`。
- MSI、NSIS 和主程序均未使用 Authenticode 证书签名，发布说明已注明 SmartScreen 风险。
- 便携版 `--portable-verify` 返回 0：64 位主程序成功装载 libmpv，FFmpeg、FFprobe、CLI 均从自解压目录实际运行，退出后残留 payload 文件数为 0。
- FFmpeg/FFprobe 统一经 `media_command` 启动，Windows 使用 `CREATE_NO_WINDOW`；Rust 后端测试 26 项通过、1 项按环境忽略，独立防回归测试通过。
- 包含无窗口修复的正式便携版已完成 `--portable-verify` 自检。

## 用户手动 UI 验证

全程使用一份临时预设，避免覆盖常用预设。每完成一类预设，都保存、关闭管理器、重新打开并应用一次，确认保存后的行为没有漂移。

1. 混音：关闭“响度标准化”，确认三个响度数字框禁用；重新开启后恢复。对“动态压缩”重复相同检查。两个开关应位于分组标题右侧，标签与主界面一致。
2. 检测：对照预设为空时“帧率容差”禁用；选择编码预设后启用。“目录递归扫描”和“启用中间黑帧检测”应为组内独立勾选项，不出现多余字段标签。
3. 透明通道：确认显示“保持原始帧率 / 自定义帧率”两个单选项；只有自定义模式启用帧率输入。
4. 截图：比例为“自由”或“匹配输出尺寸”时分辨率禁用；固定比例时启用；“自定义”比例字段仅在选择自定义后出现。
5. 截取：固定时长勾选框与时长输入位于同一行，未勾选时时长禁用；预设管理器不显示独立帧率；编码预设、比例、分辨率和输出位置与主界面一致。
6. GIF / WebP：固定时长、比例、分辨率的状态同截取；GIF 显示三档压缩方式，WebP 显示质量。
7. 输出位置：逐一切换原目录、自定义目录和名称模板，确认预设管理器与主界面的条件输入框出现、消失、禁用状态和动画一致。
8. DIT 备份：比较主界面与预设管理器的四个分组、标题、字段顺序和文案。切换目录名称模板、文件名称模板、两种冲突策略，确认条件字段一致；添加、删除中间备份目标时列表平滑补位。
9. DIT 流程：打开流程预设管理器，确认触发条件和步骤编辑器与主界面相同；切换手动/新接入磁盘，检查条件字段的出现与消失。

## 真实功能回归流程

以下项目需要真实媒体、输出目录或物理磁盘，本轮按约束未操作 GUI：

1. DIT 备份：准备一个含嵌套目录、媒体文件和非媒体文件的小目录，分别验证扩展名、最小体积、媒体过滤、递归开关、双目标、MD5、冲突重命名和冲突子目录。
2. 取消备份：复制一个足够大的文件，在进度中取消；确认无最终目标文件、无 `.shadowencoder-part-*` 临时文件，日志明确显示取消。
3. DIT 流程：执行“备份到两个目录 -> 使用备份预设转码 -> 检测”，确认每步只引用所选预设、上一步输出传给下一步、失败模式符合设置。
4. 磁盘触发：启动流程后再插入匹配卷标的 U 盘，确认只在流程运行期间监听；容量不足时进入备用分支，停止流程后不再触发。
5. GIF：用含半透明边缘的短素材分别输出智能、体积优先和极限压缩，记录文件大小并检查透明边缘、色带和运动抖动。

## 未覆盖边界

- libmpv 本地文件冒烟测试需要设置 `SHADOWENCODER_MPV_SMOKE_FILE`，本轮保持忽略。
- Tauri 窗口事件、真实 U 盘插拔、播放器交互与最终视觉对齐必须由用户按上述流程验证。

## 2026-09-06：输出命名与高级自定义流程

- 统一编码预览、GUI、流程和 Agent 调用的命名标签；模板保留文件名中的点号。真实转码得到 `red.v1_orig_25fps_H264_CRF23.mp4` 和 `red.v1.v2_orig_H264.mp4`。
- 新增 JavaScript 脚本节点、独立素材来源节点、默认输入删除/恢复，以及必要输入、输出、连线校验。保留已有失败分支恢复语义，无最终输出时报告错误。
- AI 工具提供 script/material 节点、脚本字段、`workflow script-set --file`、`workflow validate` 和 schema 中的脚本契约，复用 revision 与 undo。
- 真实 Tauri/WebView 验证：列表素材拖入画布、删除默认输入、撤销/重做、脚本语法错误与成功反馈、空列表下独立素材流程执行。最终页面无 JavaScript 错误，脚本 iframe 数为零。
- 实际 CLI 写入脚本并启动流程，任务 `task_1a0753fa425_9d34_8` 达到 `completed`；抛出 `composition-test-error` 的任务达到 `failed` 且无输出。均使用隔离应用数据目录。
- 两个 160x90 红蓝素材拼成 320x90 视频。正序像素为左 `(253,0,0)`、右 `(0,0,254)`；脚本倒序后左右交换。重复运行生成 `_2`、`_3`、`_4` 独立输出。
- 沙箱检查通过：正常返回、语法错误、3 秒死循环超时、取消、禁止网络、无 Tauri IPC；原生端拒绝 `movie` 等外部资源滤镜。
- 完整流程暴露旧 Agent 输出哈希函数的 1 MB 栈缓冲区溢出，已改为堆分配；128 KB 栈线程回归测试及真实任务完成均通过。
- 自动检查：前端 103 项、CLI 8 项、Agent 核心 18 项、Tauri 41 项通过；既有 libmpv 独立冒烟 1 项保持忽略。`npm run build`、`git diff --check` 通过，仅保留既有 bundle 大小提醒。
- 桌面通过 `app/dev-tauri.bat` 同等环境启动，临时配置仅隔离 identifier 并开启 WebView 调试；未更改正式应用配置。根 PID 45548、59752、23388 及已记录子进程均已退出，1420/9223 无监听，无有意保留进程。
- 界面证据：`app/output/playwright/workflow-custom-verified.png`。临时媒体与隔离应用数据在验证后删除。
- 当前脚本返回受限 FFmpeg 视频/图片处理计划，支持 MP4/WebM/PNG，最多 32 输入、64K 字符、3 秒计划执行时间；不执行 shell、任意文件访问或音频脚本输出。本轮未打包、推送或发布。

### Windows 列表素材拖入修复

- 前述拖动检查未覆盖 Windows 原生鼠标输入。Tauri 开启原生文件拖放时会拦截 HTML5 drag/drop，导致列表素材无法实际拖入画布。
- 内部素材拖动改用 Pointer Events，保留资源管理器原生文件导入；仅在可见流程画布内松开时创建独立素材来源节点。支持移动阈值、Escape/失焦/取消与卸载清理。
- 使用真实 Windows 鼠标拖动验证文件名到画布，成功出现文件路径与素材输出端口；点击撤销按钮后节点消失。测试列表项已通过 CLI 移除，原图片与已保存的 4K 三格拼接预设保留。
- `npm run build` 通过；素材拖动、流程 UI 和自定义流程相关 11 项测试通过。保留既有 bundle 大小提醒。
- 按用户要求保留开发版：根 PID 16744，应用 PID 47840，Vite 端口 1420；停止命令为 `taskkill /PID 16744 /T /F`。本次修复复用现有开发进程，未另启测试服务器。

### 预处理与编码分离、输出设置覆盖

- 自定义脚本只返回 `{ filterComplex, duration }`，最终视频标签为 `[out]`。编码器、格式、质量和音频由后续转码节点引用的编码预设决定；脚本返回编码或输出字段时明确拒绝。本节替代前述脚本直接输出 MP4/WebM/PNG 的旧契约。
- 新增“输出设置覆盖”节点，位置与命名独立继承或覆盖，放在转码/混音之前生效，不修改被引用预设。AI CLI/schema 同步支持节点创建、字段修改与流程校验。
- 预处理计划直接交给已有编码执行器，不生成中间编码文件。缺少编码节点、提前检测/输出、串接未编码脚本均报错；不接受纯音频或视频流复制预设。音频按预设处理第一份输入素材。
- 真实 CLI 任务 `task_1a075bade91_a01c_52` 完成，产物为 `app/output/preprocessing-check/exports/red.v1_grid_H264_4Mbps.mp4`：H.264 双遍、3840x2160、25 fps、1 秒。预设原目录 `must-not-exist` 未创建，未生成中间 `_custom` 文件。
- 四格中心 RGB：左上 `(253,0,0)`、右上 `(0,127,0)`、左下 `(0,0,254)`、右下 `(0,0,0)`。采用中心裁切检查，避免极小 YUV 缩放引入色度混合。
- 真实 Tauri 界面已检查覆盖节点展开、目录选项、条件输入和空目录错误；无效配置阻止保存。4K 三格示例已升级为“输入 -> 脚本 -> 输出覆盖 -> Standard MP4 转码 -> 输出”，保存版本 22。
- 回归：前端 107 项、Agent 核心 18 项、原生 42 项通过，libmpv 独立冒烟 1 项仍忽略；生产构建和 `git diff --check` 通过，保留既有 bundle 大小提示。新增回归覆盖精简预设保留默认值、表单数值字符串、脚本禁止编码字段。
- 两个临时测试预设和三项测试素材列表记录已通过 CLI 删除，测试媒体与输出保留供复核。`app/output/preprocessing-check/manifest.json` 是第一次失败运行的历史快照，以本节成功任务为最终证据。
- 本轮旧开发根 PID 16744、4544 已终止；4544 的完整子进程树及 1420 端口释放已核验。最终开发版根 PID 19528，启动于 2026-09-06 16:09:30，Vite 1420，按用户要求保留；停止：`taskkill /PID 19528 /T /F`。未推送或发布。

### v2.2.7 发布验证

- 版本统一为 2.2.7，使用现有 `npm run package:portable` 生成 Windows NSIS、MSI 和单文件便携版，便携版运行库、FFmpeg、FFprobe 与 CLI 自检通过。
- 发布版真实窗口显示 v2.2.7；1420 无开发服务器监听时内置页面正常渲染，随包 CLI 校验已有三格流程通过。
- 发布前重新通过前端 107 项、CLI 8 项、Agent 核心 18 项、协议 3 项测试；原生逻辑沿用本节上方已通过的 42 项回归结果。仓库没有 GitHub Actions 工作流。
- 构建根 PID 41208 已退出；发布版检查根 PID 50004 及完整 WebView 子进程树已清理并复核。此前保留的开发根 PID 19528 在本轮检查时已不运行，本轮无保留测试进程。
