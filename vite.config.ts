import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    target: "es2022",
    rolldownOptions: {
      input: {
        index: resolve(import.meta.dirname, "index.html"),
        board: resolve(import.meta.dirname, "board.html"),
        camera: resolve(import.meta.dirname, "camera.html"),
        markers: resolve(import.meta.dirname, "markers.html"),
      },
    },
  },
  test: { include: ["tests/**/*.test.ts"], testTimeout: 30000 },
} as import("vite").UserConfig);
