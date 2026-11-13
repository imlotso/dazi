import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  build: {
    outDir: "dist/client",
  },
  optimizeDeps: {
    include: ["react", "react-dom/client"],
  },
  server: {
    host: "0.0.0.0",
    allowedHosts: ["terminal.local"],
    proxy: { "/api": "http://127.0.0.1:3001" },
    warmup: {
      clientFiles: ["./src/main.tsx"],
    },
  },
  plugins: [react(), tailwindcss()],
});
