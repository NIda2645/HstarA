import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "./",
  assetsInclude: ["**/*.fbx", "**/*.obj"],
  plugins: [react()],
  esbuild: {
    drop: ["console", "debugger"],
  },
  build: {
    outDir: "../../static/3d-director",
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          const moduleId = id.replaceAll("\\", "/");
          if (!moduleId.includes("/node_modules/")) return undefined;
          if (/\/node_modules\/(react|react-dom|scheduler|zustand)\//.test(moduleId)) {
            return "react-vendor";
          }
          if (moduleId.includes("/node_modules/@react-three/")) {
            return "react-three-vendor";
          }
          if (/\/node_modules\/(three|camera-controls)\//.test(moduleId)) {
            return "three-vendor";
          }
          if (moduleId.includes("/node_modules/lucide-react/")) {
            return "ui-vendor";
          }
          return "vendor";
        },
      },
    },
  },
  server: {
    fs: {
      allow: [".."],
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    pool: "threads",
    maxWorkers: 1,
    setupFiles: "./src/test/setup.ts",
  },
});
