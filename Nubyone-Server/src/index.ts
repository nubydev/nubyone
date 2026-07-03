import path from "path";
import { fileURLToPath } from "url";
import { existsSync } from "fs";
import { loadConfig } from "./config";
import { getDb } from "./db";
import { startServer } from "./server";

loadConfig();
getDb();
startServer();

// Auto-install Go SDKs, garble, and UPX on startup (async, non-blocking).
// Runs every time the process starts so fresh Replit/VPS environments
// provision themselves without manual steps.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const setupScript = path.resolve(__dirname, "../../scripts/setup-toolchains.sh");

if (existsSync(setupScript)) {
  (async () => {
    try {
      const proc = Bun.spawn(["bash", setupScript], {
        stdout: "inherit",
        stderr: "inherit",
        env: { ...process.env },
      });
      const code = await proc.exited;
      if (code !== 0) {
        console.warn(`[startup] setup-toolchains.sh exited ${code} — some builds may fail`);
      }
    } catch (e: any) {
      console.warn("[startup] Could not run setup-toolchains.sh:", e?.message || e);
    }
  })();
} else {
  console.warn("[startup] setup-toolchains.sh not found at", setupScript);
}
