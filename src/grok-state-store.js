import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { Client as SshClient } from "ssh2";
import { sha256Hex } from "./grok-auth-store.js";

const DEFAULT_STATE_REDIS_KEY = "feishu-grok-bridge:grok-state";
const MAX_FILE_BYTES = 512 * 1024;
const MAX_TOTAL_BYTES = 4 * 1024 * 1024;
const REMOTE_MAX_FILE_BYTES = 32 * 1024 * 1024;
const REMOTE_MAX_TOTAL_BYTES = 128 * 1024 * 1024;
const DEFAULT_REMOTE_STATE_DIR = "/opt/grok-state-backups/feishu-grok-bridge";
const MEDIA_EXTENSIONS = new Set([".mp4", ".mov", ".webm", ".mkv", ".avi", ".png", ".jpg", ".jpeg", ".gif", ".webp"]);

function encryptionKey() {
  const raw = process.env.AUTH_ENCRYPTION_KEY || "";
  if (!raw.trim()) return null;
  const candidates = [];
  try {
    candidates.push(Buffer.from(raw, "base64"));
  } catch {
    // Try hex below.
  }
  if (/^[0-9a-f]{64}$/i.test(raw)) {
    candidates.push(Buffer.from(raw, "hex"));
  }
  const key = candidates.find((item) => item.length === 32);
  if (!key) throw new Error("AUTH_ENCRYPTION_KEY must decode to 32 bytes.");
  return key;
}

function redisConfig() {
  const url = (process.env.UPSTASH_REDIS_REST_URL || "").replace(/\/+$/, "");
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || "";
  const key = process.env.GROK_STATE_REDIS_KEY || DEFAULT_STATE_REDIS_KEY;
  return {
    url,
    token,
    key,
    enabled: Boolean(url && token && process.env.AUTH_ENCRYPTION_KEY)
  };
}

function remoteStateConfig() {
  const host = process.env.GROK_REMOTE_STATE_SSH_HOST || "";
  const username = process.env.GROK_REMOTE_STATE_SSH_USER || "root";
  const password = process.env.GROK_REMOTE_STATE_SSH_PASSWORD || "";
  const port = Number(process.env.GROK_REMOTE_STATE_SSH_PORT || 22) || 22;
  const dir = (process.env.GROK_REMOTE_STATE_DIR || DEFAULT_REMOTE_STATE_DIR).replace(/\/+$/, "");
  return {
    host,
    username,
    password,
    port,
    dir,
    file: `${dir}/latest.json.enc`,
    enabled: Boolean(host && username && password && process.env.AUTH_ENCRYPTION_KEY)
  };
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function sshConnect(cfg) {
  return new Promise((resolve, reject) => {
    const client = new SshClient();
    client.once("ready", () => resolve(client));
    client.once("error", reject);
    client.connect({
      host: cfg.host,
      port: cfg.port,
      username: cfg.username,
      password: cfg.password,
      readyTimeout: 15000,
      tryKeyboard: false
    });
  });
}

function sshExec(client, command) {
  return new Promise((resolve, reject) => {
    client.exec(command, (error, stream) => {
      if (error) {
        reject(error);
        return;
      }
      let stdout = "";
      let stderr = "";
      stream.on("data", (chunk) => {
        stdout += chunk.toString();
      });
      stream.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      stream.on("close", (code) => {
        if (code === 0) resolve({ stdout, stderr });
        else reject(new Error(`ssh command failed with code ${code}: ${stderr || stdout}`));
      });
    });
  });
}

function sftpWriteFile(client, remotePath, content) {
  return new Promise((resolve, reject) => {
    client.sftp((error, sftp) => {
      if (error) {
        reject(error);
        return;
      }
      sftp.writeFile(remotePath, content, (writeError) => {
        try {
          sftp.end();
        } catch {
          // Best effort cleanup.
        }
        if (writeError) reject(writeError);
        else resolve();
      });
    });
  });
}

function sftpReadFile(client, remotePath) {
  return new Promise((resolve, reject) => {
    client.sftp((error, sftp) => {
      if (error) {
        reject(error);
        return;
      }
      sftp.readFile(remotePath, (readError, data) => {
        try {
          sftp.end();
        } catch {
          // Best effort cleanup.
        }
        if (readError) reject(readError);
        else resolve(data);
      });
    });
  });
}

function isMissingRemoteStateFile(error) {
  return Number(error?.code) === 2 || /no such file|not found/i.test(String(error?.message || ""));
}

async function redisCommand(command) {
  const cfg = redisConfig();
  if (!cfg.enabled) throw new Error("Redis Grok state storage is not configured.");
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

function encryptPayload(payload) {
  const key = encryptionKey();
  if (!key) throw new Error("AUTH_ENCRYPTION_KEY is required for Redis Grok state storage.");
  const packed = zlib.gzipSync(Buffer.from(JSON.stringify(payload), "utf8"));
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(packed), cipher.final()]);
  const tag = cipher.getAuthTag();
  return JSON.stringify({
    v: 1,
    alg: "aes-256-gcm+gzip-json",
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    stateHash: sha256Hex(packed),
    updatedAt: new Date().toISOString(),
    fileCount: payload.files.length,
    skippedCount: payload.skipped.length,
    totalBytes: payload.totalBytes
  });
}

function decryptPayload(value) {
  const key = encryptionKey();
  if (!key) throw new Error("AUTH_ENCRYPTION_KEY is required for Redis Grok state storage.");
  const parsed = JSON.parse(value);
  if (parsed.v !== 1 || parsed.alg !== "aes-256-gcm+gzip-json") {
    throw new Error("Unsupported Grok state Redis envelope.");
  }
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(parsed.iv, "base64"));
  decipher.setAuthTag(Buffer.from(parsed.tag, "base64"));
  const packed = Buffer.concat([
    decipher.update(Buffer.from(parsed.ciphertext, "base64")),
    decipher.final()
  ]);
  return JSON.parse(zlib.gunzipSync(packed).toString("utf8"));
}

export function grokStateStoreConfigured() {
  return redisConfig().enabled;
}

export function grokStateRoots() {
  const home = os.homedir();
  return [
    { name: "sessions", root: path.join(home, ".grok", "sessions") },
    { name: "memory", root: path.join(home, ".grok", "memory") }
  ];
}

function shouldSkipFile(filePath, size, options = {}) {
  const maxFileBytes = options.maxFileBytes || MAX_FILE_BYTES;
  if (size > maxFileBytes) return `too_large:${size}`;
  if (MEDIA_EXTENSIONS.has(path.extname(filePath).toLowerCase())) return "media";
  return "";
}

function collectFiles(options = {}) {
  const maxFileBytes = options.maxFileBytes || MAX_FILE_BYTES;
  const maxTotalBytes = options.maxTotalBytes || MAX_TOTAL_BYTES;
  const files = [];
  const skipped = [];
  let totalBytes = 0;
  const visit = (rootName, root, current) => {
    if (!fs.existsSync(current)) return;
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        visit(rootName, root, fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      const stat = fs.statSync(fullPath);
      const rel = path.relative(root, fullPath).split(path.sep).join("/");
      const reason = shouldSkipFile(fullPath, stat.size, { maxFileBytes });
      if (reason) {
        skipped.push({ root: rootName, path: rel, reason });
        continue;
      }
      if (totalBytes + stat.size > maxTotalBytes) {
        skipped.push({ root: rootName, path: rel, reason: "total_cap" });
        continue;
      }
      files.push({
        root: rootName,
        path: rel,
        mode: stat.mode,
        modifiedAt: stat.mtime.toISOString(),
        content: fs.readFileSync(fullPath).toString("base64")
      });
      totalBytes += stat.size;
    }
  };

  for (const item of grokStateRoots()) {
    visit(item.name, item.root, item.root);
  }
  return {
    v: 1,
    savedAt: new Date().toISOString(),
    totalBytes,
    files,
    skipped
  };
}

export function currentGrokStateHash() {
  const payload = remoteStateConfig().enabled
    ? collectFiles({ maxFileBytes: REMOTE_MAX_FILE_BYTES, maxTotalBytes: REMOTE_MAX_TOTAL_BYTES })
    : collectFiles();
  return sha256Hex(Buffer.from(JSON.stringify(payload.files.map((item) => [item.root, item.path, item.content])), "utf8"));
}

export async function saveGrokStateToStore() {
  if (!grokStateStoreConfigured() && !remoteStateConfig().enabled) return { saved: false, reason: "not_configured" };
  const payload = collectFiles();
  let redisSaved = false;
  let redisEnvelope = null;
  if (grokStateStoreConfigured()) {
    redisEnvelope = encryptPayload(payload);
    await redisCommand(["SET", redisConfig().key, redisEnvelope]);
    redisSaved = true;
  }
  let remote = { saved: false, reason: "not_configured" };
  if (remoteStateConfig().enabled) {
    remote = await saveGrokStateToRemote();
  }
  return {
    saved: true,
    key: redisConfig().key,
    redisSaved,
    remote,
    hashPrefix: redisEnvelope ? JSON.parse(redisEnvelope).stateHash.slice(0, 12) : remote.hashPrefix,
    fileCount: payload.files.length,
    skippedCount: payload.skipped.length,
    totalBytes: payload.totalBytes
  };
}

export async function restoreGrokStateFromStore() {
  if (remoteStateConfig().enabled) {
    try {
      const remote = await restoreGrokStateFromRemote();
      if (remote.restored) return remote;
    } catch (error) {
      if (!grokStateStoreConfigured()) throw error;
    }
  }
  if (!grokStateStoreConfigured()) return { restored: false, reason: "not_configured" };
  const value = await redisCommand(["GET", redisConfig().key]);
  if (!value) return { restored: false, reason: "empty_store" };
  const payload = decryptPayload(String(value));
  const result = restorePayloadFiles(payload);
  return {
    restored: true,
    source: "redis",
    key: redisConfig().key,
    restoredFiles: result.restoredFiles,
    savedAt: payload.savedAt || "",
    skippedCount: payload.skipped?.length || 0
  };
}

function restorePayloadFiles(payload) {
  const roots = new Map(grokStateRoots().map((item) => [item.name, item.root]));
  let restoredFiles = 0;
  for (const item of payload.files || []) {
    const root = roots.get(item.root);
    if (!root) continue;
    const target = path.resolve(root, item.path);
    const rootResolved = path.resolve(root);
    if (target !== rootResolved && !target.startsWith(`${rootResolved}${path.sep}`)) continue;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, Buffer.from(item.content, "base64"), { mode: item.mode || 0o600 });
    if (item.modifiedAt) {
      try {
        const modifiedAt = new Date(item.modifiedAt);
        if (!Number.isNaN(modifiedAt.getTime())) fs.utimesSync(target, modifiedAt, modifiedAt);
      } catch {
        // Restored content is more important than preserving timestamps.
      }
    }
    restoredFiles += 1;
  }
  return { restoredFiles };
}

export async function saveGrokStateToRemote() {
  const cfg = remoteStateConfig();
  if (!cfg.enabled) return { saved: false, reason: "not_configured" };
  const payload = collectFiles({
    maxFileBytes: REMOTE_MAX_FILE_BYTES,
    maxTotalBytes: REMOTE_MAX_TOTAL_BYTES
  });
  const envelope = encryptPayload(payload);
  const client = await sshConnect(cfg);
  try {
    await sshExec(client, `mkdir -p ${shellQuote(cfg.dir)} && chmod 700 ${shellQuote(cfg.dir)}`);
    await sftpWriteFile(client, cfg.file, Buffer.from(envelope, "utf8"));
    await sshExec(client, `chmod 600 ${shellQuote(cfg.file)} && ls -lh ${shellQuote(cfg.file)} && df -h /`);
  } finally {
    client.end();
  }
  return {
    saved: true,
    source: "remote_ssh",
    host: cfg.host,
    file: cfg.file,
    hashPrefix: JSON.parse(envelope).stateHash.slice(0, 12),
    fileCount: payload.files.length,
    skippedCount: payload.skipped.length,
    totalBytes: payload.totalBytes
  };
}

export async function restoreGrokStateFromRemote() {
  const cfg = remoteStateConfig();
  if (!cfg.enabled) return { restored: false, reason: "not_configured" };
  const client = await sshConnect(cfg);
  try {
    let value;
    try {
      value = await sftpReadFile(client, cfg.file);
    } catch (error) {
      if (isMissingRemoteStateFile(error)) {
        return { restored: false, reason: "remote_empty", source: "remote_ssh", host: cfg.host, file: cfg.file };
      }
      throw error;
    }
    const payload = decryptPayload(value.toString("utf8"));
    const result = restorePayloadFiles(payload);
    return {
      restored: true,
      source: "remote_ssh",
      host: cfg.host,
      file: cfg.file,
      restoredFiles: result.restoredFiles,
      savedAt: payload.savedAt || "",
      skippedCount: payload.skipped?.length || 0
    };
  } finally {
    client.end();
  };
}

export async function grokStateStoreStatus() {
  const cfg = redisConfig();
  const remoteCfg = remoteStateConfig();
  const roots = grokStateRoots().map((item) => ({
    name: item.name,
    root: item.root,
    exists: fs.existsSync(item.root)
  }));
  let storePresent = false;
  let storeError = "";
  let storeSummary = null;
  if (cfg.enabled) {
    try {
      const value = await redisCommand(["GET", cfg.key]);
      storePresent = Boolean(value);
      if (value) {
        const parsed = JSON.parse(String(value));
        storeSummary = {
          updatedAt: parsed.updatedAt || "",
          fileCount: parsed.fileCount || 0,
          skippedCount: parsed.skippedCount || 0,
          totalBytes: parsed.totalBytes || 0,
          stateHashPrefix: String(parsed.stateHash || "").slice(0, 12)
        };
      }
    } catch (error) {
      storeError = error.message;
    }
  }
  return {
    configured: cfg.enabled,
    key: cfg.key,
    remote: {
      configured: remoteCfg.enabled,
      host: remoteCfg.host || "",
      port: remoteCfg.port,
      username: remoteCfg.username || "",
      dir: remoteCfg.dir,
      file: remoteCfg.file
    },
    roots,
    storePresent,
    storeSummary,
    storeError
  };
}

function countLines(filePath) {
  try {
    const text = fs.readFileSync(filePath, "utf8");
    if (!text) return 0;
    return text.split(/\r?\n/).filter(Boolean).length;
  } catch {
    return null;
  }
}

export function grokStateInventory() {
  const roots = grokStateRoots();
  const totals = {
    fileCount: 0,
    totalBytes: 0,
    skippedByPolicy: 0,
    maxFile: null
  };
  const sessions = new Map();
  const memory = {
    exists: false,
    fileCount: 0,
    totalBytes: 0,
    latestModifiedAt: "",
    maxFile: null,
    byTopLevel: {}
  };

  const touchMaxFile = (target, file) => {
    if (!target.maxFile || file.bytes > target.maxFile.bytes) target.maxFile = file;
  };

  const visit = (rootName, root, current) => {
    if (!fs.existsSync(current)) return;
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        visit(rootName, root, fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      const stat = fs.statSync(fullPath);
      const rel = path.relative(root, fullPath).split(path.sep).join("/");
      const modifiedAt = stat.mtime.toISOString();
      const fileMeta = { root: rootName, path: rel, bytes: stat.size, modifiedAt };
      totals.fileCount += 1;
      totals.totalBytes += stat.size;
      if (shouldSkipFile(fullPath, stat.size)) totals.skippedByPolicy += 1;
      touchMaxFile(totals, fileMeta);

      if (rootName === "sessions") {
        const parts = rel.split("/");
        if (parts.length < 3) continue;
        const encodedCwd = parts[0] || "";
        const sessionId = parts[1] || "";
        const key = `${encodedCwd}/${sessionId}`;
        if (!sessionId) continue;
        const item = sessions.get(key) || {
          encodedCwd,
          sessionId,
          fileCount: 0,
          totalBytes: 0,
          latestModifiedAt: "",
          turnCount: null,
          chatHistoryLines: null,
          updateLines: null,
          maxFile: null
        };
        item.fileCount += 1;
        item.totalBytes += stat.size;
        if (!item.latestModifiedAt || modifiedAt > item.latestModifiedAt) item.latestModifiedAt = modifiedAt;
        if (path.basename(fullPath) === "chat_history.jsonl") {
          item.chatHistoryLines = countLines(fullPath);
          item.turnCount = item.chatHistoryLines;
        }
        if (path.basename(fullPath) === "updates.jsonl") item.updateLines = countLines(fullPath);
        touchMaxFile(item, fileMeta);
        sessions.set(key, item);
      } else if (rootName === "memory") {
        memory.exists = true;
        memory.fileCount += 1;
        memory.totalBytes += stat.size;
        if (!memory.latestModifiedAt || modifiedAt > memory.latestModifiedAt) memory.latestModifiedAt = modifiedAt;
        touchMaxFile(memory, fileMeta);
        const top = rel.split("/")[0] || "(root)";
        memory.byTopLevel[top] ||= { fileCount: 0, totalBytes: 0, latestModifiedAt: "" };
        memory.byTopLevel[top].fileCount += 1;
        memory.byTopLevel[top].totalBytes += stat.size;
        if (!memory.byTopLevel[top].latestModifiedAt || modifiedAt > memory.byTopLevel[top].latestModifiedAt) {
          memory.byTopLevel[top].latestModifiedAt = modifiedAt;
        }
      }
    }
  };

  for (const item of roots) {
    visit(item.name, item.root, item.root);
  }

  return {
    generatedAt: new Date().toISOString(),
    policy: {
      maxFileBytes: MAX_FILE_BYTES,
      maxTotalBytes: MAX_TOTAL_BYTES,
      mediaExtensions: [...MEDIA_EXTENSIONS]
    },
    totals,
    sessions: [...sessions.values()].sort((a, b) => String(b.latestModifiedAt).localeCompare(String(a.latestModifiedAt))),
    memory
  };
}
