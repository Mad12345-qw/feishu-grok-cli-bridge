import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadAuthJsonFromStore, saveAuthJsonToStore } from "../src/grok-auth-store.js";

const home = os.homedir();
const grokDir = path.join(home, ".grok");
const authPath = path.join(grokDir, "auth.json");
fs.mkdirSync(grokDir, { recursive: true });

let json = null;
let source = "";
try {
  json = await loadAuthJsonFromStore();
  if (json) source = "redis";
} catch (error) {
  console.warn(`Grok auth Redis restore failed: ${error.message}`);
}

if (!json) {
  const encoded = process.env.GROK_AUTH_JSON_B64 || "";
  if (!encoded.trim()) {
    console.log("No Grok auth source is configured; skipping Grok auth restore.");
    process.exit(0);
  }
  json = Buffer.from(encoded, "base64").toString("utf8");
  source = "env";
}

JSON.parse(json);
fs.writeFileSync(authPath, json, { mode: 0o600 });
console.log(`Grok auth restored from ${source} to ${authPath}.`);

if (source === "env") {
  try {
    const result = await saveAuthJsonToStore(json);
    if (result.saved) console.log("Grok auth seeded into Redis.");
  } catch (error) {
    console.warn(`Grok auth Redis seed failed: ${error.message}`);
  }
}
