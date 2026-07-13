# ShadowEncoder 在线更新流程

## 架构概览

```
┌─────────────────────────────────────────────┐
│                  客户端                      │
│                                             │
│  启动时(2秒后)  GET version.json             │
│  手动按钮     → GET version.json             │
│                  │                          │
│         比较本地 __version__ vs 远程 version  │
│                  │                          │
│         有新版   → 弹出 UpdateDialog          │
│                  → 用户确认下载               │
│                  → 进度条下载 exe 到 %TEMP%   │
│                  → SHA256 校验               │
│                  → 用户点击「重启并更新」       │
│                  → 生成 updater.bat          │
│                  → 启动 bat → 主程序退出       │
│                  → bat 等待5秒 → 替换 → 重启   │
└─────────────────────────────────────────────┘
         │                          ▲
         ▼                          │
┌─────────────────────────────────────────────┐
│              CDN (cdn.3efs.com)             │
│                                             │
│  /xtools/shadowencoder/                     │
│  ├── version.json            ← 版本元信息    │
│  └── ShadowEncoder_vX.X.X.exe ← 安装包      │
└─────────────────────────────────────────────┘
```

## 核心文件

| 文件 | 职责 |
|------|------|
| `video_update_backend.py` | 版本检查、下载、校验、updater.bat 生成 |
| `version.json` | 发布元信息，放在 CDN 上供客户端拉取 |
| `updater.bat` | 运行时生成于 `%TEMP%`，负责文件替换和重启 |

## 版本号规则

使用语义化版本（Semantic Versioning）：`主版本.次版本.修订号`

```python
# video_update_backend.py 第 14 行
__version__ = "1.3.1"
```

版本比较通过元组逐位对比：

```python
(1, 3, 1) > (1, 3, 0)  → True   # 有更新
(1, 3, 1) > (1, 4, 0)  → False  # 当前更新
```

## version.json 格式

```json
{
  "version": "1.3.1",                    // 必填，语义化版本号
  "release_date": "2026-05-18",          // 发布日期
  "release_notes": "更新内容\n换行用\\n", // 发布说明（纯文本，支持 \n 换行）
  "download_url": "https://...",         // 必填，exe 直链地址
  "file_size": 112528499,                // 必填，字节数（用于下载校验）
  "sha256": "a0d5547d..."                // 必填，SHA256 校验值
}
```

所有字段必填。`download_url` 必须是可直接下载的直链，`sha256` 用于下载完成后校验文件完整性。

## 更新检查流程

```
1. urllib 请求 GET {UPDATE_URL}/version.json，超时 15 秒
2. 解析 JSON，提取 version 字段
3. _version_tuple(远程版本) > _version_tuple(本地版本) → 有更新
4. 返回 UpdateInfo 对象（包含所有字段）
5. 网络异常 → 静默忽略（启动时）/ 弹窗提示（手动时）
```

- 启动时检查：延迟 2 秒，静默模式，网络失败不打扰用户
- 手动检查：点击状态栏「检查更新」按钮，失败会提示

## 下载流程

```
1. 从 download_url 下载到 %TEMP%/ShadowEncoder_update/ShadowEncoder_vX.X.X.exe
2. urllib.urlretrieve 自带 reporthook → 进度条实时更新
3. 下载完成后 SHA256 校验：
   - 匹配 → 按钮变为「重启并更新」
   - 不匹配 → 删除文件，提示校验失败
```

## 文件替换机制（updater.bat）

Windows 不允许覆盖正在运行的 exe，因此采用「借壳替换」：

```
updater.bat 内容（UTF-8 编码）：
┌──────────────────────────────────────┐
│ @echo off                            │
│ chcp 65001 >nul                      │  ← UTF-8 编码，支持中文路径
│ echo Updating ShadowEncoder...       │
│ timeout /t 5 /nobreak >nul           │  ← 等待主程序完全退出（5秒）
│ if not exist "新exe路径" (            │  ← 检查下载文件是否存在
│   echo New version file not found.   │
│   pause                              │
│   exit /b 1                          │
│ )                                    │
│ move /y "新exe路径" "当前exe路径"     │  ← 用新文件覆盖旧文件
│ if errorlevel 1 (                    │  ← 替换失败则提示
│   echo Update failed.                │
│   pause                              │
│   exit /b 1                          │
│ )                                    │
│ start "" "当前exe路径"                │  ← 启动新版本
│ del "%~f0"                           │  ← 批处理自删
└──────────────────────────────────────┘
```

### 编码说明

bat 文件使用 **UTF-8 无 BOM** 编码写入，配合 `chcp 65001` 切换到 UTF-8 代码页。这确保：
- 含中文字符的路径（如用户名、文件夹名）能正确解析
- `move` 和 `start` 命令的路径参数不会因编码错误而失败

### 时序保证

```
主程序: 写bat(UTF-8) → 启动bat进程 → 立刻 quit()
                                       │
updater.bat:                            ▼
  chcp 65001           ← 切换到 UTF-8
  timeout /t 5 ......... 主程序已完全退出，exe 文件锁释放
  if not exist 新文件   ← 检查下载是否成功
  move /y 新 → 旧       ← 安全替换
  start 新版            ← 用户看到新版本
  del %~f0              ← 清理自身
```

### 关键点
- bat 等待 5 秒，确保主程序进程完全退出、文件句柄释放
- 主程序在启动 bat 后**立即** quit()，不延迟
- bat 在独立 cmd 进程中运行，不依赖主程序
- 替换前检查新文件是否存在，失败时 pause 等待用户查看，避免窗口一闪而过

## 发版操作步骤

### 1. 修改版本号

编辑 `video_update_backend.py`：

```python
__version__ = "1.3.2"  # 改这里
```

### 2. 打包

```bat
build_gui_exe.bat
```

产物在 `dist/video_tool_gui.exe`。

### 3. 计算 SHA256

```bat
certutil -hashfile dist\video_tool_gui.exe SHA256
```

### 4. 获取文件大小（字节）

```python
python -c "import os; print(os.path.getsize('dist/video_tool_gui.exe'))"
```

### 5. 更新 version.json

修改项目根目录的 `version.json`，填入新版本号、SHA256、文件大小、更新说明。

### 6. 上传到 CDN

```
重命名 dist/video_tool_gui.exe → ShadowEncoder_v1.3.2.exe
上传到 https://cdn.3efs.com/xtools/shadowencoder/ShadowEncoder_v1.3.2.exe
上传 version.json 到 https://cdn.3efs.com/xtools/shadowencoder/version.json
```

完成后，所有运行旧版的客户端将在启动时（或手动检查时）收到更新提示。

## 关键常量

| 常量 | 值 | 说明 |
|------|-----|------|
| `UPDATE_URL` | `https://cdn.3efs.com/xtools/shadowencoder/version.json` | 版本检查地址 |
| 请求超时 | 15 秒 | 连接+读取超时 |
| bat 等待时间 | 5 秒 | 主程序退出后的等待时间 |
| 启动检查延迟 | 2 秒 | 窗口显示 2 秒后开始检查 |
| 下载目录 | `%TEMP%/ShadowEncoder_update/` | 新版本下载位置 |
