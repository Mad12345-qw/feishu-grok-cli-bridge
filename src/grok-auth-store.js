import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_AUTH_REDIS_KEY = "feishu-grok-bridge:grok-auth";

export function grokAuthPath() {
  return path.join(os.homedir(), ".grok", "auth.json");
}

export function sha256Hex(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

export function authSummaryFromJson(json = "") {
  try {
    const parsed = JSON.parse(json);
    const first = Object.values(parsed || {})[0] || {};
    return {
      keyCount: Object.keys(parsed || {}).length,
      authMode: first.auth_mode || "",
      createTime: first.create_time || "",
      expiresAt: first.expires_at || "",
      hasRefreshToken: Boolean(first.refresh_token)
    };
  } catch {
    return { keyCount: 0, authMode: "", createTime: "", expiresAt: "", hasRefreshToken: false };
  }
}

function encryptionKey() {
  const raw = process.env.AUTH_ENCRYPTION_KEY || "";
  if (!raw.trim()) return null;
  const candidates = [];
  try {
    candidates.push(Buffer.from(raw, "base64"));
  } catch {
    // Ignore invalid base64 and try hex below.
  }
  if (/^[0-9a-f]{64}$/i.test(raw)) {
    candidates.push(Buffer.from(raw, "hex"));
  }
  const key = candidates.find((item) => item.length === 32);
  if (!key) {
    throw new Error("AUTH_ENCRYPTION_KEY must decode to 32 bytes.");
  }
  return key;
}

function encryptAuthJson(json) {
  const key = encryptionKey();
  if (!key) throw new Error("AUTH_ENCRYPTION_KEY is required for Redis auth storage.");
  JSON.parse(json);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(json, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return JSON.stringify({
    v: 1,
    alg: "aes-256-gcm",
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    authHash: sha256Hex(Buffer.from(json, "utf8")),
    updatedAt: new Date().toISOString(),
    summary: authSummaryFromJson(json)
  });
}

function decryptAuthEnvelope(value) {
  const key = encryptionKey();
  if (!key) throw new Error("AUTH_ENCRYPTION_KEY is required for Redis auth storage.");
  const parsed = JSON.parse(value);
  if (parsed.v !== 1 || parsed.alg !== "aes-256-gcm") {
    throw new Error("Unsupported Grok auth Redis envelope.");
  }
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(parsed.iv, "base64"));
  decipher.setAuthTag(Buffer.from(parsed.tag, "base64"));
  const plain = Buffer.concat([
    decipher.update(Buffer.from(parsed.ciphertext, "base64")),
    decipher.final()
  ]).toString("utf8");
  JSON.parse(plain);
  return plain;
}

function redisConfig() {
  const url = (process.env.UPSTASH_REDIS_REST_URL || "").replace(/\/+$/, "");
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || "";
  const key = process.env.GROK_AUTH_REDIS_KEY || DEFAULT_AUTH_REDIS_KEY;
  return {
    url,
    token,
    key,
    enabled: Boolean(url && token && process.env.AUTH_ENCRYPTION_KEY)
  };
}

async function redisCommand(command) {
  const cfg = redisConfig();
  if (!cfg.enabled) throw new Error("Redis auth storage is not configured.");
  const response = await fetch(cfg.url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(command)
  });
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  if (!response.ok || body?.error) {
    throw new Error(`Redis command failed: ${response.status} ${body?.error || text.slice(0, 200)}`);
  }
  return body.result;
}

export function authStoreConfigured() {
  return redisConfig().enabled;
}

export async function loadAuthJsonFromStore() {
  if (!authStoreConfigured()) return null;
  const value = await redisCommand(["GET", redisConfig().key]);
  if (!value) return null;
  return decryptAuthEnvelope(String(value));
}

export async function saveAuthJsonToStore(json) {
  if (!authStoreConfigured()) return { saved: false, reason: "not_configured" };
  const envelope = encryptAuthJson(json);
  await redisCommand(["SET", redisConfig().key, envelope]);
  return {
    saved: true,
    key: redisConfig().key,
    hashPrefix: sha256Hex(Buffer.from(json, "utf8")).slice(0, 12),
    summary: authSummaryFromJson(json)
  };
}

export async function authStoreStatus() {
  const cfg = redisConfig();
  const authPath = grokAuthPath();
  const exists = fs.existsSync(authPath);
  const fileBytes = exists ? fs.readFileSync(authPath) : null;
  let storeHashPrefix = "";
  let storeSummary = null;
  let storePresent = false;
  let storeError = "";
  if (cfg.enabled) {
    try {
      const value = await redisCommand(["GET", cfg.key]);
      storePresent = Boolean(value);
      if (value) {
        const json = decryptAuthEnvelope(String(value));
        storeHashPrefix = sha256Hex(Buffer.from(json, "utf8")).slice(0, 12);
        storeSummary = authSummaryFromJson(json);
      }
    } catch (error) {
      storeError = error.message;
    }
  }
  const fileHash = fileBytes ? sha256Hex(fileBytes) : "";
  return {
    fileExists: exists,
    fileBytes: fileBytes?.length || 0,
    fileHashPrefix: fileHash.slice(0, 12),
    fileSummary: fileBytes ? authSummaryFromJson(fileBytes.toString("utf8")) : null,
    storeConfigured: cfg.enabled,
    storeKey: cfg.key,
    storePresent,
    storeHashPrefix,
    storeSummary,
    storeMatchesFile: Boolean(fileHash && storeHashPrefix && fileHash.startsWith(storeHashPrefix)),
    storeError
  };
}
