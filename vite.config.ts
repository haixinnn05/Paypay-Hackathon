import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // Pre-bundle both together so Studio's theme and widget objects come from a single copy of ag-studio.
  optimizeDeps: { include: ["ag-studio", "ag-studio-react"] },
  server: { proxy: { "/api": "http://localhost:8787" } },
});
