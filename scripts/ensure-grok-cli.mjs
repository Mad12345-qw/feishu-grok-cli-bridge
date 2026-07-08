import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

if (process.platform === "win32") {
  console.log("Skipping Linux Grok CLI install helper on Windows.");
  process.exit(0);
}

const binDir = process.env.GROK_BIN_DIR || path.join(process.cwd(), ".grok", "bin");
const grokPath = path.join(binDir, "grok");

if (fs.existsSync(grokPath)) {
  console.log(`Grok CLI already exists at ${grokPath}.`);
  process.exit(0);
}

fs.mkdirSync(binDir, { recursive: true });
execFileSync("bash", [
  "-lc",
  `export GROK_BIN_DIR=${JSON.stringify(binDir)} && curl -fsSL https://x.ai/cli/install.sh | bash`
], {
  stdio: "inherit",
  env: {
    ...process.env,
    HOME: process.env.HOME || os.homedir()
  }
});
