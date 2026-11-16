import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// The daemon the dev server proxies to. Override to point at a throwaway daemon on another port.
const daemon = process.env.AGNI_DAEMON_URL?.trim() || "http://127.0.0.1:8787";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: Number(process.env.AGNI_WEB_PORT) || 5173,
    // Same origin as the daemon in dev, so the session cookie works.
    proxy: {
      "/ws": { target: daemon, ws: true },
      ...Object.fromEntries(
        ["/auth", "/health", "/attachments", "/backgrounds", "/debug", "/share", "/oauth"].map((path) => [path, daemon]),
      ),
    },
  },
  preview: {
    host: "127.0.0.1",
    port: 4173,
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./test/setup.ts"],
    include: ["test/**/*.test.{ts,tsx}"],
    restoreMocks: true,
  },
});
