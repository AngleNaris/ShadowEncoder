import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri 的 dev server 固定端口，与 tauri.conf.json 的 devUrl 对应
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    // 显式使用 IPv4 回环地址，避免此主机默认解析为 ::1 后 127.0.0.1 无法访问。
    host: "127.0.0.1",
    port: 1420,
    strictPort: true,
    // Rust 编译产物在 Windows 上会被编译器短暂锁定，不能交给 Vite 监听。
    watch: {
      ignored: ["**/src-tauri/target/**"],
    },
  },
});
