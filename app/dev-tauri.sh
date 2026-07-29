#!/usr/bin/env bash
# ShadowEncoder Tauri 开发启动脚本（Linux）
# 对应 Windows 的 app/dev-tauri.bat
#
# 说明：部分环境下 `tauri dev` 会因 notify 扫过大目录触发
# "Too many open files"。本脚本默认走更稳妥路径：
#   vite(dev server) + cargo run（或直接跑已有 debug 二进制）
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
FFMPEG_DIR="${PROJECT_DIR}/ffmpeg/linux"
TAURI_DIR="${SCRIPT_DIR}/src-tauri"
BIN="${TAURI_DIR}/target/debug/shadowencoder"
VITE_URL="http://127.0.0.1:1420/"
MODE="${1:-auto}"   # auto | tauri | direct

# 提高本进程可打开文件数
raise_nofile_limit() {
  local target="${SE_NOFILE_LIMIT:-65536}"
  local soft hard
  soft="$(ulimit -Sn 2>/dev/null || echo 0)"
  hard="$(ulimit -Hn 2>/dev/null || echo 0)"
  if [[ "${hard}" == "unlimited" ]]; then hard=1048576; fi
  if [[ "${soft}" == "unlimited" ]]; then soft=1048576; fi
  if (( target > hard )); then target="${hard}"; fi
  if (( soft < target )); then
    if ulimit -Sn "${target}" 2>/dev/null; then
      echo "[info] 已提升 nofile 软限制: ${soft} -> $(ulimit -Sn)"
    else
      echo "[warn] 无法提升 nofile 软限制（soft=${soft}, hard=${hard}）" >&2
    fi
  fi
}

need_cmd() {
  local name="$1"
  if ! command -v "${name}" >/dev/null 2>&1; then
    echo "[error] 未找到 ${name}。" >&2
    case "${name}" in
      ffmpeg|ffprobe)
        echo "  请安装: sudo apt install ffmpeg" >&2
        echo "  或放到: ${FFMPEG_DIR}/" >&2
        ;;
      cargo) echo "  请安装 Rust: https://rustup.rs" >&2 ;;
      npm|node) echo "  请安装 Node.js / npm。" >&2 ;;
    esac
    exit 1
  fi
}

port_open() {
  # 1420 是否在监听
  if command -v ss >/dev/null 2>&1; then
    ss -ltn 2>/dev/null | grep -qE '[:.]1420[[:space:]]'
  else
    curl -s -o /dev/null --connect-timeout 0.3 "${VITE_URL}" 2>/dev/null
  fi
}

wait_vite() {
  local i
  for i in $(seq 1 60); do
    if curl -s -o /dev/null --connect-timeout 0.3 "${VITE_URL}" 2>/dev/null; then
      return 0
    fi
    sleep 0.25
  done
  return 1
}

start_vite() {
  if port_open; then
    echo "[info] Vite 已在 1420 端口运行"
    return 0
  fi
  echo "[info] 启动 Vite 开发服务器 ..."
  (
    cd "${SCRIPT_DIR}"
    # 独立进程组，脚本退出时不连带杀掉（用户手动关）
    nohup npm run dev > /tmp/shadowencoder-vite.log 2>&1 &
    echo $! > /tmp/shadowencoder-vite.pid
  )
  if wait_vite; then
    echo "[info] Vite 就绪: ${VITE_URL}"
  else
    echo "[error] Vite 启动超时，日志: /tmp/shadowencoder-vite.log" >&2
    tail -40 /tmp/shadowencoder-vite.log >&2 || true
    exit 1
  fi
}

run_tauri_cli() {
  echo "[info] 尝试 npm run tauri dev ..."
  cd "${SCRIPT_DIR}"
  npm run tauri dev
}

run_direct() {
  start_vite

  # 若源码比二进制新，则 cargo build
  local need_build=0
  if [[ ! -x "${BIN}" ]]; then
    need_build=1
  else
    # main.rs 或 Cargo.toml 更新过则重建
    if [[ "${TAURI_DIR}/src/main.rs" -nt "${BIN}" ]] || [[ "${TAURI_DIR}/Cargo.toml" -nt "${BIN}" ]]; then
      need_build=1
    fi
  fi

  if (( need_build )); then
    echo "[info] 编译 debug 二进制 (cargo build) ..."
    (cd "${TAURI_DIR}" && cargo build)
  else
    echo "[info] 使用已有二进制: ${BIN}"
  fi

  # 避免重复开多个窗口
  if pgrep -x shadowencoder >/dev/null 2>&1; then
    echo "[info] ShadowEncoder 已在运行 (pid $(pgrep -x shadowencoder | tr '\n' ' '))"
    echo "[info] 如需重启: pkill -x shadowencoder && $0 direct"
    exit 0
  fi

  # Preserve the session-selected GTK backend. The native mpv surface supports
  # Wayland; forcing X11 here disables it even inside a Wayland session.
  # 部分 GPU/驱动组合下 WebKit 合成会黑屏，可按需打开：
  # export WEBKIT_DISABLE_COMPOSITING_MODE=1

  echo "[info] 启动 ShadowEncoder 窗口"
  echo "  app:    ${SCRIPT_DIR}"
  echo "  bin:    ${BIN}"
  echo "  vite:   ${VITE_URL}"
  echo "  ffmpeg: $(command -v ffmpeg)"
  echo "  cargo:  $(command -v cargo)"
  echo "  nofile: $(ulimit -Sn) (hard $(ulimit -Hn))"
  echo "  backend:${GDK_BACKEND:-auto}"
  echo

  cd "${SCRIPT_DIR}"
  exec "${BIN}"
}

# ── main ──────────────────────────────────────────────
raise_nofile_limit

if [[ -d "${HOME}/.cargo/bin" ]]; then
  export PATH="${HOME}/.cargo/bin:${PATH}"
fi
if [[ -x "${FFMPEG_DIR}/ffmpeg" ]]; then
  export PATH="${FFMPEG_DIR}:${PATH}"
fi

# 图形会话环境（从用户会话继承失败时的兜底）
export DISPLAY="${DISPLAY:-:0}"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
if [[ -z "${WAYLAND_DISPLAY:-}" && -S "${XDG_RUNTIME_DIR}/wayland-0" ]]; then
  export WAYLAND_DISPLAY=wayland-0
fi
if [[ -z "${DBUS_SESSION_BUS_ADDRESS:-}" && -S "${XDG_RUNTIME_DIR}/bus" ]]; then
  export DBUS_SESSION_BUS_ADDRESS="unix:path=${XDG_RUNTIME_DIR}/bus"
fi

need_cmd node
need_cmd npm
need_cmd cargo
need_cmd ffmpeg
need_cmd ffprobe

# WebKit/GTK 预览依赖：缺 libav 时 H.264 等常见编码无法解码，播放器会显示无法预览
if ! dpkg -s gstreamer1.0-libav >/dev/null 2>&1; then
  echo "[warn] 未安装 gstreamer1.0-libav，工具页视频预览可能失败。"
  echo "       建议: sudo apt install gstreamer1.0-libav gstreamer1.0-plugins-ugly"
fi

cd "${SCRIPT_DIR}"
if [[ ! -d node_modules ]]; then
  echo "[info] 未检测到 node_modules，正在 npm install ..."
  npm install
fi

case "${MODE}" in
  tauri)
    run_tauri_cli
    ;;
  direct)
    run_direct
    ;;
  auto|*)
    # 默认走 direct：绕过 tauri-cli 的文件监听崩溃
    run_direct
    ;;
esac
