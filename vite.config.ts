import { defineConfig } from "vite";

// 本项目只构建 Tauri 桌面应用，不提供独立的网页预览入口。
export default defineConfig({
  clearScreen: false,
});
