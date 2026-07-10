import crypto from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import express from "express";
import ffmpegPath from "ffmpeg-static";
import { authStoreConfigured, authStoreStatus, grokAuthPath, saveAuthJsonToStore, sha256Hex } from "./grok-auth-store.js";
import { currentGrokStateHash, grokStateInventory, grokStateStoreStatus, restoreGrokStateFromStore, saveGrokStateToStore } from "./grok-state-store.js";

const STARTED_AT = new Date();
const execFileAsync = promisify(execFile);
const GROK_EXECUTABLE_NAME = process.platform === "win32" ? "grok.exe" : "grok";
const STREAM_ANSWER_ELEMENT_ID = "answer_md";
const STREAM_STATUS_ELEMENT_ID = "status_md";
const botReplyMessageIds = new Map();
const routeDecisions = [];
const CARD_HEADER_TEMPLATES = new Set([
  "default",
  "blue",
  "wathet",
  "turquoise",
  "green",
  "yellow",
  "orange",
  "red",
  "carmine",
  "violet",
  "purple",
  "indigo",
  "grey"
]);
const CARD_TEXT_TAG_COLORS = new Set([
  "default",
  "blue",
  "wathet",
  "turquoise",
  "green",
  "yellow",
  "orange",
  "red",
  "carmine",
  "violet",
  "purple",
  "indigo",
  "grey"
]);
const DEFAULT_SYSTEM_PROMPT = [
  "You are OpenAI connected to a Feishu bot.",
  "Reply in the user's language.",
  "When the user asks for latest, current, prices, news, or web facts, use web search if available.",
  "Be direct, include dates for time-sensitive facts, and do not invent sources.",
  "If a searched company is private and has no public stock ticker, say that clearly before giving valuation or secondary-market context.",
  "In headless CLI mode, stop searching once you have enough reliable evidence to answer.",
  "Treat --max-turns as an upper bound, not a target; prefer a concise final answer over continuing optional searches.",
  "For image generation requests, only claim success when you create or return an actual image file path or downloadable image URL.",
  "For video generation requests, only claim success when you create or return an actual MP4 file path or downloadable video URL."
].join("\n");
const WEB_SOURCE_LINK_RULE = [
  "For any answer that uses web search or web sources, include a final section named `来源链接`.",
  "In that section, provide 1-4 Markdown links in the form `[short source name](https://...)`.",
  "Use only real source URLs that you actually used. Do not provide source names without URLs."
].join(" ");
const SEARCH_REQUIRED_RULE = [
  "The user requested web search for this turn.",
  "You must perform at least one fresh web_search before answering.",
  "For investment research, prefer the newest available primary filings, company announcements, exchange disclosures, and reputable financial news; clearly state dates for data points."
].join(" ");

function envFlag(name, fallback = false) {
  const value = process.env[name];
  if (value == null || value === "") return fallback;
  return ["1", "true", "yes", "y", "on"].includes(String(value).toLowerCase());
}

function envNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const config = {
  port: envNumber("PORT", 3000),
  serviceName: process.env.SERVICE_NAME || "feishu-grok-bridge",
  feishuAppId: process.env.FEISHU_APP_ID || "",
  feishuAppSecret: process.env.FEISHU_APP_SECRET || "",
  feishuVerificationToken: process.env.FEISHU_VERIFICATION_TOKEN || "",
  feishuEncryptKey: process.env.FEISHU_ENCRYPT_KEY || "",
  feishuDocBaseUrl: process.env.FEISHU_DOC_BASE_URL || "https://www.feishu.cn",
  feishuResearchParentWikiToken:
    process.env.FEISHU_RESEARCH_REPORT_PARENT_WIKI_TOKEN ||
    process.env.FEISHU_INVESTMENT_REPORT_PARENT_WIKI_TOKEN ||
    "",
  gpt55BaseUrl: process.env.GPT55_BASE_URL || process.env.MIKOTO_BASE_URL || "",
  gpt55ApiKey: process.env.GPT55_API_KEY || process.env.MIKOTO_API_KEY || "",
  gpt55Model: process.env.GPT55_MODEL || process.env.MIKOTO_MODEL || "gpt-5.5",
  gpt55WebSearchEnabled: envFlag("GPT55_WEB_SEARCH_ENABLED", true),
  gptImageModel: process.env.GPT_IMAGE_MODEL || "gpt-image-2",
  gptImageSize: process.env.GPT_IMAGE_SIZE || "1024x1024",
  gptImageQuality: process.env.GPT_IMAGE_QUALITY || "medium",
  gptImageTimeoutMs: envNumber("GPT_IMAGE_TIMEOUT_MS", 180000),
  obsidianSyncEnabled: envFlag("OBSIDIAN_SYNC_ENABLED", Boolean(process.env.OBSIDIAN_GITHUB_TOKEN || process.env.GITHUB_BACKUP_TOKEN)),
  obsidianGithubToken: process.env.OBSIDIAN_GITHUB_TOKEN || process.env.GITHUB_BACKUP_TOKEN || "",
  obsidianGithubRepo: process.env.OBSIDIAN_GITHUB_REPO || "Mad12345-qw/obsidian-knowledge-sync",
  obsidianGithubBranch: process.env.OBSIDIAN_GITHUB_BRANCH || "main",
  obsidianFolder: stripSlashes(process.env.OBSIDIAN_RESEARCH_FOLDER || "gpt55-research"),
  sessionHistoryTurns: envNumber("GPT_SESSION_HISTORY_TURNS", 12),
  memoryRecallLimit: envNumber("MEMORY_RECALL_LIMIT", 5),
  grokCliEnabled: envFlag("GROK_CLI_ENABLED", true),
  grokCliCommand: process.env.GROK_CLI_COMMAND || path.join(process.cwd(), ".grok", "bin", GROK_EXECUTABLE_NAME),
  grokCliCwd: process.env.GROK_CLI_CWD || path.join(os.tmpdir(), "grok-feishu-bridge-cwd"),
  grokCliTimeoutMs: envNumber("GROK_CLI_TIMEOUT_MS", 540000),
  maxCardContentChars: envNumber("MAX_CARD_CONTENT_CHARS", 90000),
  maxReplyChars: envNumber("MAX_REPLY_CHARS", 3500),
  maxImageBytes: envNumber("MAX_IMAGE_BYTES", 10 * 1024 * 1024),
  maxVideoBytes: envNumber("MAX_VIDEO_BYTES", 30 * 1024 * 1024),
  mediaMaxTurns: envNumber("GROK_MEDIA_MAX_TURNS", 10),
  videoMaxTurns: envNumber("GROK_VIDEO_MAX_TURNS", 10),
  videoModel: process.env.GROK_VIDEO_MODEL || "grok-build",
  grokMemoryEnabled: envFlag("GROK_MEMORY_ENABLED", true),
  grokStateSyncEnabled: envFlag("GROK_STATE_SYNC_ENABLED", true),
  debugToken: process.env.DEBUG_TOKEN || "",
  grokAuthSyncEnabled: envFlag("GROK_AUTH_SYNC_ENABLED", false),
  systemPrompt: process.env.SYSTEM_PROMPT || DEFAULT_SYSTEM_PROMPT
};

function parseJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

let lastObservedGrokAuthHash = "";
let lastObservedGrokStateHash = "";

function currentGrokAuthHash() {
  try {
    const authPath = grokAuthPath();
    if (!fs.existsSync(authPath)) return "";
    return sha256Hex(fs.readFileSync(authPath));
  } catch {
    return "";
  }
}

async function syncGrokAuthIfChanged(reason = "unknown") {
  if (!config.grokAuthSyncEnabled || !authStoreConfigured()) return;
  const authPath = grokAuthPath();
  if (!fs.existsSync(authPath)) return;
  const json = fs.readFileSync(authPath, "utf8");
  const hash = sha256Hex(Buffer.from(json, "utf8"));
  if (hash && hash === lastObservedGrokAuthHash) return;
  const result = await saveAuthJsonToStore(json);
  lastObservedGrokAuthHash = hash;
  console.log(`OpenAI auth synced to Redis after ${reason}: ${result.hashPrefix}`);
}

lastObservedGrokAuthHash = currentGrokAuthHash();

function redactSensitive(value = "") {
  return String(value || "")
    .replace(/(access_token|refresh_token|id_token|authorization|cookie|set-cookie)["':=\s]+[A-Za-z0-9._~+/=-]+/gi, "$1=<redacted>")
    .replace(/(xai-|xox[abp]-|sk-[A-Za-z0-9_-]*|eyJ[A-Za-z0-9._-]+)/g, "<redacted>")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "<redacted-email>");
}

function stripAnsi(text = "") {
  return String(text || "")
    .replace(/\u001b\][\s\S]*?(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b[PX^_][\s\S]*?\u001b\\/g, "")
    .replace(/\u001b[@-_]/g, "");
}

function isGrokDiagnosticLine(line = "") {
  const text = String(line || "").trim();
  return (
    /^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s+(WARN|ERROR|INFO|DEBUG)\b/i.test(text) ||
    /\b(repo_state\.git\.collect|Codebase upload failed|Reference blob upload|batch_exists returned|dedup batch existence probe)\b/i.test(text) ||
    /^Caused by:\s*$/i.test(text)
  );
}

function stripProgressOnlyLead(text = "") {
  const lines = String(text || "").split("\n");
  while (
    lines.filter((line) => line.trim()).length > 1 &&
    /^\s*正在(?:搜索|联网|查找|检索|查詢|查询)\b[\s\S]{0,120}[。.!！]?\s*$/i.test(lines[0] || "")
  ) {
    lines.shift();
  }
  return lines.join("\n");
}

function sanitizeGrokOutput(text = "") {
  const clean = stripAnsi(text)
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .split("\n")
    .filter((line) => !isGrokDiagnosticLine(line))
    .join("\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
  return stripProgressOnlyLead(clean).trim();
}

function sanitizeFeishuText(text = "") {
  const clean = sanitizeGrokOutput(text)
    .replace(/[\u2028\u2029]/g, "\n")
    .trim();
  return clean || "没有生成可发送的回复。";
}

function cardText(value = "", max = 80) {
  const clean = sanitizeFeishuText(value)
    .replace(/[<>{}]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return clean.length > max ? `${clean.slice(0, Math.max(0, max - 1))}…` : clean;
}

function cardMarkdown(value = "", max = config.maxCardContentChars) {
  const clean = sanitizeFeishuText(value)
    .replace(/[<>{}]/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
  return clean.length > max ? `${clean.slice(0, Math.max(0, max - 20))}\n\n…内容过长，已分段继续。` : clean;
}

function activeModelLabel() {
  return cardText(config.gpt55Model || "未配置模型", 80);
}

function runtimeModelReport() {
  const searchStatus = config.gpt55WebSearchEnabled
    ? "已启用；消息包含“搜索”时会强制执行联网检索"
    : "未启用";
  return [
    "## 当前运行模型",
    "",
    `- **模型 ID**：\`${activeModelLabel()}\``,
    "- **信息来源**：服务端运行时配置与上游 API 响应元数据，不是模型自报。",
    "",
    "## 本桥接已验证能力",
    "",
    "- **对话与投研回答**：支持",
    "- **流式输出**：支持",
    `- **联网检索**：${searchStatus}`,
    "- **单次回答上限**：4,000 output tokens",
    "- **生成温度**：0.2",
    "- **会话上下文**：当前飞书会话最近 12 轮",
    "",
    "## 边界",
    "",
    "未从上游模型元数据确认的上下文长度、视觉、音频、代码执行等厂商级能力，不在这里臆测；需要时以实际调用结果为准。"
  ].join("\n");
}

function isRuntimeModelQuestion(text = "") {
  const clean = String(text || "").trim();
  if (!clean || clean.length > 180) return false;
  return /(什么模型|哪个模型|哪种模型|当前模型|实际模型|使用的模型|正在用的模型|模型.{0,12}(特性|能力|配置|信息)|你是.{0,12}模型|what.{0,20}model|model.{0,20}(feature|capability|config))/i.test(clean);
}

function buildRuntimeModelContextBlock() {
  return [
    "Authoritative runtime model information:",
    `- Active model ID: ${activeModelLabel()}`,
    "- This model ID comes from server runtime configuration and upstream response metadata.",
    `- Web search for this bridge: ${config.gpt55WebSearchEnabled ? "enabled; the user field 搜索 forces fresh web search" : "disabled"}.`,
    "- Streaming output is enabled. This bridge requests temperature 0.2 and caps one response at 4000 output tokens.",
    "When asked which model is running or what it can do, state the exact Active model ID above. Describe only these verified bridge capabilities and do not invent provider-specific context window, multimodal, or tool claims."
  ].join("\n");
}

function escapeRegExp(value = "") {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function shellQuote(value = "") {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function imageMimeType(filePath = "") {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  return "image/jpeg";
}

function isSafeGrokFilePath(filePath = "", { pattern, maxBytes }) {
  if (!filePath || !pattern.test(filePath)) return false;
  const resolved = path.resolve(filePath);
  const cwdRoot = path.resolve(config.grokCliCwd);
  const sessionsRoot = path.resolve(os.homedir(), ".grok", "sessions");
  const generatedMediaRoot = path.resolve(os.homedir(), ".grok", "generated-media");
  const underCwd = resolved === cwdRoot || resolved.startsWith(`${cwdRoot}${path.sep}`);
  const underGrokSession = resolved.startsWith(`${sessionsRoot}${path.sep}`)
    && [path.sep + "images" + path.sep, path.sep + "videos" + path.sep, path.sep + "media" + path.sep, path.sep + "artifacts" + path.sep]
      .some((segment) => resolved.includes(segment));
  const underGeneratedMedia = resolved === generatedMediaRoot || resolved.startsWith(`${generatedMediaRoot}${path.sep}`);
  if (!underCwd && !underGrokSession && !underGeneratedMedia) return false;
  try {
    const stat = fs.statSync(resolved);
    return stat.isFile() && stat.size > 0 && stat.size <= maxBytes;
  } catch {
    return false;
  }
}

function isSafeGrokImagePath(filePath = "") {
  return isSafeGrokFilePath(filePath, {
    pattern: /\.(?:png|jpe?g|webp|gif)$/i,
    maxBytes: config.maxImageBytes
  });
}

function isSafeGrokVideoPath(filePath = "") {
  return isSafeGrokFilePath(filePath, {
    pattern: /\.(?:mp4|mov|webm)$/i,
    maxBytes: config.maxVideoBytes
  });
}

function candidatePathVariants(candidate = "") {
  const raw = String(candidate || "").replace(/[),.;:，。；：]+$/g, "");
  const variants = [raw];
  const jsonUnescaped = raw.replace(/\\\\/g, "\\");
  if (jsonUnescaped !== raw) variants.push(jsonUnescaped);
  try {
    const decoded = decodeURIComponent(raw);
    if (decoded !== raw) variants.push(decoded);
  } catch {
    // Keep raw if URI decoding is not applicable.
  }
  try {
    const decodedUnescaped = decodeURIComponent(jsonUnescaped);
    if (decodedUnescaped !== jsonUnescaped) variants.push(decodedUnescaped);
  } catch {
    // Keep unescaped if URI decoding is not applicable.
  }
  return variants;
}

function extractLocalPaths(text = "", patterns, validator, limit = 4) {
  const paths = [];
  const seen = new Set();
  for (const pattern of Array.isArray(patterns) ? patterns : [patterns]) {
    let match;
    while ((match = pattern.exec(String(text || ""))) !== null && paths.length < limit) {
      for (const candidate of candidatePathVariants(match[1])) {
        const resolved = path.resolve(candidate);
        if (!seen.has(resolved) && validator(resolved)) {
          seen.add(resolved);
          paths.push(resolved);
          break;
        }
      }
    }
  }
  return paths;
}

function appendCappedText(current = "", chunk = "", max = 120000) {
  const next = `${current}${chunk}`;
  return next.length > max ? next.slice(-max) : next;
}

function extractLocalPathCandidates(text = "", pattern, limit = 8) {
  const paths = [];
  const seen = new Set();
  let match;
  while ((match = pattern.exec(String(text || ""))) !== null && paths.length < limit) {
    for (const item of candidatePathVariants(match[1])) {
      const resolved = path.resolve(item);
      if (!seen.has(resolved)) {
        seen.add(resolved);
        paths.push(resolved);
      }
    }
  }
  return paths;
}

function extractLocalImagePaths(text = "", limit = 4) {
  return extractLocalPaths(text, [
    /(?:file:\/\/)?(\/[^\s"'<>`]+\.(?:png|jpe?g|webp|gif))/gi,
    /(?:file:\/\/\/)?([A-Za-z]:\\[^\s"'<>`]+\.(?:png|jpe?g|webp|gif))/gi
  ], isSafeGrokImagePath, limit);
}

function extractLocalVideoPaths(text = "", limit = 2) {
  return extractLocalPaths(text, [
    /(?:file:\/\/)?(\/[^\s"'<>`]+\.(?:mp4|mov|webm))/gi,
    /(?:file:\/\/\/)?([A-Za-z]:\\[^\s"'<>`]+\.(?:mp4|mov|webm))/gi
  ], isSafeGrokVideoPath, limit);
}

function stripLocalMediaPaths(text = "") {
  let clean = String(text || "");
  const localPaths = [
    ...extractLocalPathCandidates(clean, /(?:file:\/\/)?(\/[^\s"'<>`]+\.(?:png|jpe?g|webp|gif))/gi),
    ...extractLocalPathCandidates(clean, /(?:file:\/\/)?(\/[^\s"'<>`]+\.(?:mp4|mov|webm))/gi),
    ...extractLocalPathCandidates(clean, /(?:file:\/\/\/)?([A-Za-z]:\\[^\s"'<>`]+\.(?:png|jpe?g|webp|gif))/gi),
    ...extractLocalPathCandidates(clean, /(?:file:\/\/\/)?([A-Za-z]:\\[^\s"'<>`]+\.(?:mp4|mov|webm))/gi)
  ];
  for (const filePath of localPaths) {
    clean = clean.replace(new RegExp(escapeRegExp(filePath), "g"), "");
    clean = clean.replace(new RegExp(escapeRegExp(`file://${filePath}`), "g"), "");
  }
  return sanitizeGrokOutput(clean)
    .split("\n")
    .filter((line) => !/^\s*(图片文件路径|视频文件路径|媒体文件路径|文件路径|本地路径|path|image path|video path|media path|url)[:：]?\s*$/i.test(line))
    .join("\n")
    .trim();
}

function crc32(buffer) {
  let crc = -1;
  for (const byte of buffer) {
    crc ^= byte;
    for (let index = 0; index < 8; index += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ -1) >>> 0;
}

function pngChunk(type, data = Buffer.alloc(0)) {
  const name = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([name, data])), 0);
  return Buffer.concat([length, name, data, crc]);
}

function solidPng(width = 640, height = 360, rgba = [28, 45, 74, 255]) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const row = Buffer.alloc(1 + width * 4);
  row[0] = 0;
  for (let x = 0; x < width; x += 1) {
    row[1 + x * 4] = rgba[0];
    row[2 + x * 4] = rgba[1];
    row[3 + x * 4] = rgba[2];
    row[4 + x * 4] = rgba[3];
  }
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw)),
    pngChunk("IEND")
  ]);
}

function ensureVideoThumbnail() {
  const thumbnailPath = path.join(config.grokCliCwd, "video-thumbnail.png");
  if (!fs.existsSync(thumbnailPath)) {
    fs.mkdirSync(path.dirname(thumbnailPath), { recursive: true });
    fs.writeFileSync(thumbnailPath, solidPng());
  }
  return thumbnailPath;
}

function runFfmpeg(args, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    if (!ffmpegPath) {
      reject(new Error("ffmpeg-static did not provide a binary path."));
      return;
    }

    const child = spawn(ffmpegPath, args, { windowsHide: true });
    const stderr = [];
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("FFmpeg timed out while extracting video thumbnail."));
    }, timeoutMs);

    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
        return;
      }
      const detail = Buffer.concat(stderr).toString("utf8");
      reject(new Error(`FFmpeg thumbnail extraction failed ${code}: ${detail.slice(0, 800)}`));
    });
  });
}

async function createVideoThumbnail(videoPath = "") {
  const resolvedVideo = path.resolve(videoPath);
  if (!isSafeGrokVideoPath(resolvedVideo)) {
    throw new Error(`Refusing to thumbnail unsafe or missing video path: ${resolvedVideo}`);
  }

  const thumbnailDir = path.join(config.grokCliCwd, "video-thumbnails");
  fs.mkdirSync(thumbnailDir, { recursive: true });
  const thumbnailPath = path.join(thumbnailDir, `${crypto.randomUUID()}.jpg`);

  await runFfmpeg([
    "-y",
    "-ss", "0.5",
    "-i", resolvedVideo,
    "-frames:v", "1",
    "-vf", "scale=720:-2",
    "-q:v", "3",
    thumbnailPath
  ]);

  if (!isSafeGrokImagePath(thumbnailPath)) {
    throw new Error(`Generated thumbnail is not a safe image path: ${thumbnailPath}`);
  }
  return thumbnailPath;
}

function safeDeleteLocalFile(filePath = "") {
  if (!filePath) return false;
  const resolved = path.resolve(filePath);
  const cwdRoot = path.resolve(config.grokCliCwd);
  const sessionsRoot = path.resolve(os.homedir(), ".grok", "sessions");
  const generatedMediaRoot = path.resolve(os.homedir(), ".grok", "generated-media");
  const underCwd = resolved === cwdRoot || resolved.startsWith(`${cwdRoot}${path.sep}`);
  const underGrokSession = resolved.startsWith(`${sessionsRoot}${path.sep}`);
  const underGeneratedMedia = resolved === generatedMediaRoot || resolved.startsWith(`${generatedMediaRoot}${path.sep}`);
  if (!underCwd && !underGrokSession && !underGeneratedMedia) return false;
  try {
    const stat = fs.statSync(resolved);
    if (!stat.isFile()) return false;
    fs.rmSync(resolved, { force: true });
    return true;
  } catch {
    return false;
  }
}

function mediaPathPreview(filePath = "") {
  const resolved = path.resolve(filePath);
  const roots = [
    ["cwd", path.resolve(config.grokCliCwd)],
    ["grokSessions", path.resolve(os.homedir(), ".grok", "sessions")],
    ["grokGenerated", path.resolve(os.homedir(), ".grok", "generated-media")]
  ];
  for (const [label, root] of roots) {
    if (resolved === root || resolved.startsWith(`${root}${path.sep}`)) {
      return `${label}:${path.relative(root, resolved)}`;
    }
  }
  return `basename:${path.basename(resolved)}`;
}

function safeDeleteLocalFiles(filePaths = []) {
  let deleted = 0;
  for (const filePath of filePaths) {
    if (safeDeleteLocalFile(filePath)) deleted += 1;
  }
  return deleted;
}

function normalizeSourceLabel(label = "") {
  return String(label || "")
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/_([^_]+)_/g, "$1")
    .replace(/[<>{}]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function syncGrokStateIfChanged(reason = "unknown") {
  if (!config.grokStateSyncEnabled) return;
  const hash = currentGrokStateHash();
  if (!hash || hash === lastObservedGrokStateHash) return;
  const result = await saveGrokStateToStore();
  if (result.saved) {
    lastObservedGrokStateHash = hash;
    console.log(`OpenAI state synced after ${reason}: ${result.fileCount} Redis-scope files, ${result.skippedCount} skipped, remote=${result.remote?.saved ? "yes" : "no"}.`);
  }
}

function isGenericSourceLabel(label = "") {
  const clean = normalizeSourceLabel(label).toLowerCase();
  return !clean
    || /^(?:source|reference|link|here|this|read more|more|来源|链接|参考|点击|查看|原文|详情)\s*\d*$/i.test(clean)
    || /^[\[\(]?\d{1,3}[\]\)]?$/.test(clean);
}

function sourceLabelFromUrl(url = "") {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase().replace(/^(?:www|m)\./, "");
    const known = [
      [/aiindex\.stanford\.edu$/, "Stanford AI Index"],
      [/stanford\.edu$/, "Stanford"],
      [/stateof\.ai$/, "State of AI"],
      [/mckinsey\.com$/, "McKinsey"],
      [/deloitte\.com$/, "Deloitte"],
      [/idc\.com$/, "IDC"],
      [/gartner\.com$/, "Gartner"],
      [/cbinsights\.com$/, "CB Insights"],
      [/technologyreview\.com$/, "MIT Tech Review"],
      [/openai\.com$/, "OpenAI"],
      [/anthropic\.com$/, "Anthropic"],
      [/x\.ai$/, "xAI"],
      [/arxiv\.org$/, "arXiv"],
      [/nature\.com$/, "Nature"],
      [/science\.org$/, "Science"],
      [/reuters\.com$/, "Reuters"],
      [/bloomberg\.com$/, "Bloomberg"],
      [/sec\.gov$/, "SEC"],
      [/whitehouse\.gov$/, "White House"],
      [/europa\.eu$/, "EU"],
      [/weforum\.org$/, "WEF"]
    ];
    for (const [pattern, label] of known) {
      if (pattern.test(host)) return label;
    }
    const parts = host.split(".").filter(Boolean);
    const base = parts.length >= 2 ? parts[parts.length - 2] : parts[0] || host;
    return base
      .split(/[-_]/g)
      .filter(Boolean)
      .map((part) => part.length <= 3 ? part.toUpperCase() : part[0].toUpperCase() + part.slice(1))
      .join(" ") || host;
  } catch {
    return "";
  }
}

function sourceButtonLabel({ label = "", url = "" } = {}, index = 0) {
  const preferred = isGenericSourceLabel(label) ? "" : normalizeSourceLabel(label);
  const clean = preferred || sourceLabelFromUrl(url) || `来源 ${index + 1}`;
  return clean.length > 22 ? `${clean.slice(0, 21)}…` : clean;
}

function extractSourceLinksFromText(text = "", limit = 3) {
  const links = [];
  const seen = new Set();
  const add = (url, label = "") => {
    const clean = String(url || "").replace(/[.,!?;:，。！？；：]+$/g, "");
    if (!/^https?:\/\//i.test(clean) || seen.has(clean)) return;
    seen.add(clean);
    links.push({ url: clean, label: normalizeSourceLabel(label) });
  };
  for (const match of String(text || "").matchAll(/\[([^\]]{1,160})\]\((https?:\/\/[^)\s]+)\)/g)) add(match[2], match[1]);
  for (const match of String(text || "").matchAll(/https?:\/\/[^\s<>"')\]]+/g)) add(match[0]);
  return links.slice(0, limit);
}

function extractUrlsFromText(text = "", limit = 3) {
  return extractSourceLinksFromText(text, limit).map((item) => item.url);
}

function splitForCard(text = "", maxChars = 4200) {
  const clean = sanitizeFeishuText(text);
  if (clean.length <= maxChars) return [clean];
  const chunks = [];
  let rest = clean;
  while (rest.length > maxChars) {
    let index = rest.lastIndexOf("\n\n", maxChars);
    if (index < Math.floor(maxChars * 0.45)) index = rest.lastIndexOf("\n", maxChars);
    if (index < Math.floor(maxChars * 0.45)) index = maxChars;
    chunks.push(rest.slice(0, index).trim());
    rest = rest.slice(index).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

function sourceButtons(text = "") {
  return extractSourceLinksFromText(text, 3).map((source, index) => ({
    tag: "button",
    text: {
      tag: "plain_text",
      content: sourceButtonLabel(source, index)
    },
    type: index === 0 ? "primary" : "default",
    url: source.url
  }));
}

function sourceButtonsV2(text = "") {
  return extractSourceLinksFromText(text, 4).map((source, index) => ({
    tag: "button",
    element_id: `source_btn_${index + 1}`,
    text: {
      tag: "plain_text",
      content: sourceButtonLabel(source, index)
    },
    type: "default",
    size: "small",
    width: "default",
    behaviors: [
      {
        type: "open_url",
        default_url: source.url,
        pc_url: source.url,
        ios_url: source.url,
        android_url: source.url
      }
    ]
  }));
}

function grokHeaderTemplate(template = "") {
  return CARD_HEADER_TEMPLATES.has(template) ? template : "red";
}

function grokModeLabel(title = "", { webSearch = false } = {}) {
  const text = `${title}`;
  if (/视频|video|mp4/i.test(text)) return "视频任务";
  if (/图片|图像|照片|image|photo|picture/i.test(text)) return "图片任务";
  if (/媒体|media/i.test(text)) return "媒体任务";
  if (webSearch) return "联网搜索";
  return "对话";
}

function grokCardSubtitle({ webSearch = false, media = false, streaming = false } = {}) {
  return [
    activeModelLabel(),
    media ? "媒体结果卡片" : webSearch ? "联网检索" : "原生卡片",
    streaming ? "流式更新" : "完成"
  ].join(" · ");
}

function grokTextTag(elementId, content, color = "grey") {
  return {
    tag: "text_tag",
    element_id: elementId,
    text: {
      tag: "plain_text",
      content
    },
    color
  };
}

function grokHeaderTags(title = "", { webSearch = false, streaming = false, done = false, modeTagColor = "", memorySync = false, memoryRecall = false, compact = false } = {}) {
  const mode = grokModeLabel(title, { webSearch });
  const effectiveModeColor = CARD_TEXT_TAG_COLORS.has(modeTagColor)
    ? modeTagColor
    : mode === "联网搜索" ? "indigo" : "orange";
  const tags = [
    grokTextTag("mode_tag", mode, effectiveModeColor)
  ];
  if (!compact && memoryRecall) tags.push(grokTextTag("memory_recall_tag", "调取记忆库", "indigo"));
  if (!compact && memorySync) tags.push(grokTextTag("memory_sync_tag", "同步记忆库", "green"));
  if (!compact && streaming) tags.push(grokTextTag("stream_tag", "流式", "turquoise"));
  if (!compact && done) tags.push(grokTextTag("done_tag", "完成", "turquoise"));
  if (!compact && /视频|媒体|图片|图像|照片|video|image|photo/i.test(`${title}`)) {
    tags.push(grokTextTag("media_tag", "媒体", "red"));
  }
  return tags;
}

function grokStatusMarkdown(status = "") {
  return `**● 状态**  ${cardMarkdown(status, 260)}`;
}

function grokFooterNote({
  webSearch = false,
  memoryRecall = false,
  memorySync = false,
  memoryRecallOk = null,
  memoryRecallCount = null,
  memorySyncOk = null,
  wikiSynced = false,
  obsidianSynced = false
} = {}) {
  const parts = ["X1", activeModelLabel(), "OpenAI Bridge"];
  if (webSearch) parts.push("联网检索");
  if (memoryRecall) {
    const count = Number.isFinite(Number(memoryRecallCount)) ? ` ${Number(memoryRecallCount)}条` : "";
    parts.push(memoryRecallOk === false ? "调用知识库不成功" : `调用知识库成功${count}`);
  }
  if (memorySync) {
    if (memorySyncOk) {
      const targets = [wikiSynced ? "Wiki" : "", obsidianSynced ? "Obsidian" : ""].filter(Boolean).join("+");
      parts.push(targets ? `同步知识库成功 ${targets}` : "同步知识库成功");
    } else if (wikiSynced || obsidianSynced) {
      const detail = [
        obsidianSynced ? "Obsidian成功" : "Obsidian失败",
        wikiSynced ? "Wiki成功" : "Wiki失败"
      ].join(" ");
      parts.push(`同步知识库部分成功 ${detail}`);
    } else {
      parts.push("同步知识库不成功");
    }
  }
  return {
    tag: "markdown",
    element_id: "grok_footer",
    content: parts.join(" · ")
  };
}

function buildStreamingCard(text = "", title = `${activeModelLabel()} 回复`, { webSearch = false, status = "模型已接管任务", headerTemplate = "", modeTagColor = "", memorySync = false, memoryRecall = false } = {}) {
  const media = /视频|媒体|图片|图像|照片|video|image|photo|picture/i.test(`${title}`);
  return {
    schema: "2.0",
    config: {
      streaming_mode: true,
      update_multi: true,
      enable_forward: false,
      width_mode: "fill",
      summary: {
        content: `[生成中...] ${activeModelLabel()}`
      },
      streaming_config: {
        print_frequency_ms: { default: 45, android: 45, ios: 45, pc: 45 },
        print_step: { default: 2, android: 2, ios: 2, pc: 2 },
        print_strategy: "delay"
      }
    },
    header: {
      template: grokHeaderTemplate(headerTemplate),
      title: {
        tag: "plain_text",
        content: cardText(title, 40)
      },
      subtitle: {
        tag: "plain_text",
        content: grokCardSubtitle({ webSearch, media, streaming: true })
      },
      text_tag_list: grokHeaderTags(title, { webSearch, streaming: true, modeTagColor, memorySync, memoryRecall, compact: true })
    },
    body: {
      direction: "vertical",
      padding: "14px 16px 16px 16px",
      vertical_spacing: "10px",
      elements: [
        {
          tag: "markdown",
          element_id: STREAM_STATUS_ELEMENT_ID,
          content: grokStatusMarkdown(status)
        },
        {
          tag: "hr"
        },
        {
          tag: "markdown",
          element_id: STREAM_ANSWER_ELEMENT_ID,
          content: ` ${cardMarkdown(text || "", config.maxCardContentChars - 1)}`
        },
        grokFooterNote({ webSearch })
      ]
    }
  };
}

function buildFinalCard(text = "", title = `${activeModelLabel()} 回复`, {
  webSearch = false,
  headerTemplate = "",
  modeTagColor = "",
  memorySync = false,
  memoryRecall = false,
  memoryRecallOk = null,
  memoryRecallCount = null,
  memorySyncOk = null,
  wikiSynced = false,
  obsidianSynced = false
} = {}) {
  const safe = sanitizeFeishuText(text);
  const media = /视频|媒体|图片|图像|照片|video|image|photo|picture/i.test(`${title}\n${safe}`);
  const elements = [
    {
      tag: "markdown",
      element_id: STREAM_ANSWER_ELEMENT_ID,
      content: cardMarkdown(safe)
    }
  ];
  elements.push({ tag: "hr" });
  elements.push(grokFooterNote({
    webSearch,
    memorySync,
    memoryRecall,
    memoryRecallOk,
    memoryRecallCount,
    memorySyncOk,
    wikiSynced,
    obsidianSynced
  }));
  return {
    schema: "2.0",
    config: {
      streaming_mode: false,
      update_multi: true,
      enable_forward: true,
      width_mode: "fill",
      summary: {
        content: cardText(safe || title, 80)
      }
    },
    header: {
      template: grokHeaderTemplate(headerTemplate),
      title: {
        tag: "plain_text",
        content: cardText(title, 40)
      },
      subtitle: {
        tag: "plain_text",
        content: grokCardSubtitle({ webSearch, media, streaming: false })
      },
      text_tag_list: grokHeaderTags(title, { webSearch, done: true, modeTagColor, memorySync, memoryRecall })
    },
    body: {
      direction: "vertical",
      padding: "16px 18px 18px 18px",
      vertical_spacing: "10px",
      elements
    }
  };
}

function buildFeishuCard(text = "", title = `${activeModelLabel()} 回复`, { webSearch = false, part = 1, total = 1, headerTemplate = "" } = {}) {
  const safe = sanitizeFeishuText(text);
  const elements = [
    {
      tag: "div",
      text: {
        tag: "lark_md",
        content: cardMarkdown(safe)
      }
    }
  ];
  elements.push({
    tag: "note",
    elements: [
      {
        tag: "plain_text",
        content: [
          webSearch ? `${activeModelLabel()} · 联网检索` : activeModelLabel(),
          total > 1 ? `第 ${part}/${total} 段` : "飞书卡片富文本"
        ].join(" · ")
      }
    ]
  });
  return {
    config: {
      wide_screen_mode: true,
      enable_forward: true,
      update_multi: true
    },
    header: {
      template: grokHeaderTemplate(headerTemplate),
      title: {
        tag: "plain_text",
        content: cardText(title, 40)
      },
      subtitle: {
        tag: "plain_text",
        content: grokCardSubtitle({ webSearch, streaming: false })
      }
    },
    elements
  };
}

function plainMarkdownLine(line = "") {
  return String(line || "")
    .replace(/^#{1,6}\s+/, "")
    .replace(/^>\s?/, "")
    .replace(/^(\s*)[-*+]\s+/, "$1• ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/_([^_]+)_/g, "$1");
}

function appendTextNode(nodes, text, style = undefined) {
  if (!text) return;
  const node = { tag: "text", text };
  if (style?.length) node.style = style;
  const previous = nodes[nodes.length - 1];
  if (previous?.tag === "text" && JSON.stringify(previous.style || []) === JSON.stringify(node.style || [])) {
    previous.text += text;
    return;
  }
  nodes.push(node);
}

function appendInlineRichNodes(nodes, line = "", style = undefined) {
  const markdownLink = /\[([^\]]{1,120})\]\((https?:\/\/[^)\s]+)\)/g;
  let cursor = 0;
  let match;
  while ((match = markdownLink.exec(line)) !== null) {
    appendBareUrls(nodes, line.slice(cursor, match.index), style);
    nodes.push({ tag: "a", text: plainMarkdownLine(match[1]) || match[2], href: match[2] });
    cursor = match.index + match[0].length;
  }
  appendBareUrls(nodes, line.slice(cursor), style);
}

function appendBareUrls(nodes, text = "", style = undefined) {
  const urlPattern = /(https?:\/\/[^\s<>"')\]]+)/g;
  let cursor = 0;
  let match;
  while ((match = urlPattern.exec(text)) !== null) {
    appendTextNode(nodes, plainMarkdownLine(text.slice(cursor, match.index)), style);
    const url = match[1].replace(/[.,!?;:，。！？；：]+$/g, "");
    nodes.push({ tag: "a", text: url, href: url });
    cursor = match.index + match[1].length;
  }
  appendTextNode(nodes, plainMarkdownLine(text.slice(cursor)), style);
}

function markdownLineToPostNodes(line = "", inCodeBlock = false) {
  const nodes = [];
  const raw = String(line || "");
  if (!raw.trim()) return [{ tag: "text", text: " " }];
  if (inCodeBlock) {
    appendTextNode(nodes, raw);
    return nodes;
  }

  const heading = raw.match(/^(#{1,6})\s+(.+)$/);
  if (heading) {
    appendInlineRichNodes(nodes, heading[2], ["bold"]);
    return nodes;
  }

  const quote = raw.match(/^>\s?(.+)$/);
  if (quote) {
    appendTextNode(nodes, "引用：", ["bold"]);
    appendInlineRichNodes(nodes, quote[1]);
    return nodes;
  }

  const bullet = raw.match(/^(\s*)[-*+]\s+(.+)$/);
  if (bullet) {
    appendTextNode(nodes, "• ");
    appendInlineRichNodes(nodes, bullet[2]);
    return nodes;
  }

  const numbered = raw.match(/^\s*(\d+)[.)、]\s+(.+)$/);
  if (numbered) {
    appendTextNode(nodes, `${numbered[1]}. `);
    appendInlineRichNodes(nodes, numbered[2]);
    return nodes;
  }

  appendInlineRichNodes(nodes, raw);
  return nodes.length ? nodes : [{ tag: "text", text: plainMarkdownLine(raw) || " " }];
}

function buildFeishuPostContent(text = "", title = "OpenAI 回复") {
  const safe = sanitizeFeishuText(text);
  const lines = safe.split("\n");
  const content = [];
  let inCodeBlock = false;
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    content.push(markdownLineToPostNodes(line, inCodeBlock));
  }
  return {
    zh_cn: {
      title,
      content: content.length ? content : [[{ tag: "text", text: safe }]]
    }
  };
}

function isExecutable(filePath = "") {
  if (!filePath) return false;
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function ensureGrokCliCommand() {
  if (config.grokCliCommand && !config.grokCliCommand.includes(path.sep)) {
    try {
      await execFileAsync(config.grokCliCommand, ["--version"], { timeout: 10000, windowsHide: true });
      return config.grokCliCommand;
    } catch (error) {
      throw new Error(`Configured OpenAI CLI command is not available on PATH: ${config.grokCliCommand}; ${error.message}`);
    }
  }

  if (!isExecutable(config.grokCliCommand)) {
    throw new Error(`Configured OpenAI CLI path does not exist or is not executable: ${config.grokCliCommand}`);
  }
  return config.grokCliCommand;
}

function parseContent(content = "") {
  if (!content) return {};
  if (typeof content === "object") return content;
  return parseJson(content, {});
}

function stripAtTags(text = "") {
  return String(text || "")
    .replace(/<at\b[^>]*>[\s\S]*?<\/at>/gi, "")
    .replace(/@_user_\d+/g, "")
    .trim();
}

function flattenPostContent(content = {}) {
  const root = content?.zh_cn?.content || content?.content || content?.en_us?.content || [];
  const lines = Array.isArray(root) ? root : [];
  return lines
    .map((line) => {
      const nodes = Array.isArray(line) ? line : [line];
      return nodes.map((node) => {
        if (!node || typeof node !== "object") return "";
        if (node.tag === "at") return "";
        return node.text || node.name || "";
      }).join("");
    })
    .join("\n")
    .trim();
}

function messageType(message = {}) {
  return message.message_type || message.msg_type || message.body?.message_type || "";
}

function messageContent(message = {}) {
  return parseContent(message.content ?? message.body?.content ?? {});
}

function cardContentText(value) {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  return value.content || value.text || value.title || "";
}

function cardElementText(element = {}) {
  if (!element || typeof element !== "object") return "";
  const tag = String(element.tag || "").toLowerCase();
  if (tag === "markdown" || tag === "lark_md" || tag === "plain_text") {
    return cardContentText(element.content || element);
  }
  if (tag === "div") return cardContentText(element.text);
  if (tag === "note") return (element.elements || []).map(cardElementText).filter(Boolean).join("\n");
  if (tag === "column_set") return (element.columns || []).map(cardElementText).filter(Boolean).join("\n");
  if (tag === "column" || tag === "form" || tag === "collapsible_panel") {
    const heading = cardContentText(element.header || element.title);
    const children = (element.elements || []).map(cardElementText).filter(Boolean).join("\n");
    return [heading, children].filter(Boolean).join("\n");
  }
  return "";
}

function interactiveCardContent(content = {}) {
  let card = parseContent(content);
  if (card?.type === "card" && card?.data && typeof card.data === "object") card = card.data;
  if (card?.card && typeof card.card === "object") card = card.card;
  if (!card || typeof card !== "object") return { text: "", schema: "", source: "interactive_empty" };

  const schema = String(card.schema || "1.0");
  const bodyElements = Array.isArray(card?.body?.elements)
    ? card.body.elements
    : Array.isArray(card.elements)
      ? card.elements
      : [];
  const answerElements = bodyElements.filter((element) => element?.element_id === STREAM_ANSWER_ELEMENT_ID);
  const answerText = answerElements.map(cardElementText).filter(Boolean).join("\n").trim();
  if (answerText) return { text: answerText, schema, source: "interactive_answer" };

  const headerText = [
    cardContentText(card?.header?.title),
    cardContentText(card?.header?.subtitle)
  ].filter(Boolean).join("\n");
  const bodyText = bodyElements
    .filter((element) => ![STREAM_STATUS_ELEMENT_ID, "grok_footer"].includes(element?.element_id))
    .map(cardElementText)
    .filter(Boolean)
    .join("\n")
    .trim();
  return {
    text: [headerText, bodyText].filter(Boolean).join("\n\n"),
    schema,
    source: "interactive_card"
  };
}

function extractMessageTextDetails(message = {}) {
  const content = messageContent(message);
  const type = messageType(message);
  if (type === "post") return { text: stripAtTags(flattenPostContent(content)), source: "post", schema: "" };
  if (type === "interactive") {
    const result = interactiveCardContent(content);
    return { ...result, text: stripAtTags(result.text) };
  }
  return {
    text: stripAtTags(content.text || content.title || content.description || ""),
    source: type || "unknown",
    schema: ""
  };
}

function extractMessageText(message = {}) {
  return extractMessageTextDetails(message).text;
}

function quotedMessageId(message = {}) {
  const own = message.message_id || "";
  for (const key of ["parent_id", "parent_message_id", "root_id", "root_message_id"]) {
    const value = message[key];
    if (typeof value === "string" && value && value !== own) return value;
  }
  return "";
}

function rememberBotReplyMessageId(messageId = "") {
  if (!messageId) return;
  botReplyMessageIds.set(messageId, Date.now());
  for (const [id, ts] of botReplyMessageIds) {
    if (Date.now() - ts > 7 * 24 * 60 * 60 * 1000) botReplyMessageIds.delete(id);
  }
}

function idPrefix(value = "") {
  const text = String(value || "");
  return text ? text.slice(0, 10) : "";
}

function pushRouteDecision(entry = {}) {
  const safe = {
    at: new Date().toISOString(),
    ...entry
  };
  routeDecisions.push(safe);
  while (routeDecisions.length > 80) routeDecisions.shift();
  console.log(`Feishu route decision: ${JSON.stringify(safe)}`);
}

function responseMessageId(response = {}) {
  return response?.data?.message_id || response?.message_id || response?.data?.message?.message_id || "";
}

function rememberBotResponse(response = {}) {
  const messageId = responseMessageId(response);
  rememberBotReplyMessageId(messageId);
  return messageId;
}

function messageRepliesToKnownBotMessage(message = {}) {
  const own = message.message_id || "";
  for (const key of ["parent_id", "parent_message_id", "root_id", "root_message_id"]) {
    const value = message[key];
    if (typeof value === "string" && value && value !== own && botReplyMessageIds.has(value)) return true;
  }
  return false;
}

function messageMentions(message = {}) {
  const mentions = [];
  const add = (value) => {
    if (Array.isArray(value)) mentions.push(...value.filter((item) => item && typeof item === "object"));
  };
  add(message.mentions);
  add(message.body?.mentions);
  const content = messageContent(message);
  add(content.mentions);
  const text = String(content.text || content.title || content.description || "");
  for (const match of text.matchAll(/<at\b([^>]*)>([\s\S]*?)<\/at>/gi)) {
    const attrs = match[1] || "";
    const name = String(match[2] || "").trim();
    const id = {};
    for (const attr of attrs.matchAll(/\b([A-Za-z_:-]+)=["']([^"']+)["']/g)) {
      const key = attr[1];
      const value = attr[2];
      if (/open_id|user_id|union_id|app_id/i.test(key)) id[key.toLowerCase()] = value;
    }
    mentions.push({ name, id });
  }
  const walk = (value) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (value.tag === "at") {
      mentions.push({
        name: value.name || value.text || "",
        id: {
          open_id: value.open_id || value.user_id || "",
          user_id: value.user_id || "",
          union_id: value.union_id || "",
          app_id: value.app_id || ""
        }
      });
    }
    for (const item of Object.values(value)) walk(item);
  };
  walk(content);
  return mentions;
}

function mentionMatchesBot(mention = {}, bot = {}) {
  const ids = mention.id && typeof mention.id === "object" ? mention.id : {};
  const candidates = new Set([
    mention.open_id,
    mention.user_id,
    mention.union_id,
    mention.app_id,
    ids.open_id,
    ids.user_id,
    ids.union_id,
    ids.app_id
  ].filter(Boolean).map(String));
  if (bot.open_id && candidates.has(String(bot.open_id))) return true;
  if (config.feishuAppId && candidates.has(String(config.feishuAppId))) return true;
  const mentionName = String(mention.name || "").trim().toLowerCase();
  const botName = String(bot.app_name || "").trim().toLowerCase();
  return Boolean(mentionName && botName && mentionName === botName);
}

function messageSenderMatchesBot(message = {}, bot = {}) {
  const sender = message.sender || {};
  const senderId = sender.sender_id && typeof sender.sender_id === "object" ? sender.sender_id : {};
  const messageSenderId = message.sender_id && typeof message.sender_id === "object" ? message.sender_id : {};
  const candidates = new Set([
    sender.open_id,
    sender.user_id,
    sender.union_id,
    sender.app_id,
    senderId.open_id,
    senderId.user_id,
    senderId.union_id,
    senderId.app_id,
    messageSenderId.open_id,
    messageSenderId.user_id,
    messageSenderId.union_id,
    messageSenderId.app_id
  ].filter(Boolean).map(String));
  if (bot.open_id && candidates.has(String(bot.open_id))) return true;
  if (config.feishuAppId && candidates.has(String(config.feishuAppId))) return true;
  return false;
}

async function shouldHandleFeishuMessage(message = {}) {
  if (message.chat_type === "p2p") return { handle: true, reason: "p2p" };
  if (messageRepliesToKnownBotMessage(message)) return { handle: true, reason: "known_bot_reply" };
  const mentions = messageMentions(message);
  try {
    const bot = await feishu.botInfo();
    if (mentions.some((mention) => mentionMatchesBot(mention, bot))) {
      return { handle: true, reason: "mentioned_grok", mentionCount: mentions.length, botName: bot.app_name || "" };
    }
    const quotedId = quotedMessageId(message);
    if (!quotedId) return { handle: false, reason: "group_not_mentioned", mentionCount: mentions.length, botName: bot.app_name || "" };
    const quoted = await feishu.getMessage(quotedId);
    if (messageSenderMatchesBot(quoted, bot)) {
      rememberBotReplyMessageId(quotedId);
      return { handle: true, reason: "quoted_grok_message", mentionCount: mentions.length, botName: bot.app_name || "" };
    }
    return { handle: false, reason: "quoted_non_grok_message", mentionCount: mentions.length, botName: bot.app_name || "" };
  } catch (error) {
    console.warn(`Failed to resolve Feishu bot info for mention routing: ${error.message}`);
    return { handle: false, reason: "routing_error", error: error.message, mentionCount: mentions.length };
  }
}

function safeName(value = "") {
  return String(value || "file").replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 120) || "file";
}

function truncate(value = "", max = 500) {
  const text = String(value || "");
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function normalizeRepo(value = "") {
  const clean = String(value || "").trim().replace(/^https:\/\/github\.com\//i, "").replace(/\.git$/i, "");
  const parts = clean.split("/").filter(Boolean);
  return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : "";
}

function encodeGitHubPath(value = "") {
  return String(value || "").split("/").filter(Boolean).map(encodeURIComponent).join("/");
}

function stripSlashes(value = "") {
  return String(value || "").replace(/^[/\\]+|[/\\]+$/g, "") || "gpt55-research";
}

function slugify(value = "") {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
    .replace(/^-+|-+$/g, "") || "research";
}

function unique(items = []) {
  return [...new Set(items)];
}

function splitTerms(text = "") {
  const normalized = String(text || "").toLowerCase();
  const baseTerms = normalized
    .replace(/[^\p{L}\p{N}._-]+/gu, " ")
    .split(/\s+/)
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item.length >= 2);
  const cjkTerms = [];
  for (const match of normalized.matchAll(/[\p{Script=Han}]{2,}/gu)) {
    const chunk = match[0];
    if (chunk.length <= 20) cjkTerms.push(chunk);
    for (let size = 2; size <= Math.min(6, chunk.length); size += 1) {
      for (let index = 0; index <= chunk.length - size; index += 1) {
        cjkTerms.push(chunk.slice(index, index + size));
      }
    }
  }
  return unique([...baseTerms, ...cjkTerms])
    .filter((item) => item.length >= 2)
    .slice(0, 48);
}

function markdownToTextBlocks(markdown = "") {
  return String(markdown || "")
    .split(/\r?\n/)
    .map((line) => String(line || "").trim())
    .filter(Boolean)
    .map((line) => ({
      block_type: 2,
      text: {
        elements: [
          {
            text_run: {
              content: line.replace(/^#{1,6}\s+/, "").slice(0, 4000)
            }
          }
        ],
        style: {}
      }
    }));
}

function extFromContentType(contentType = "", fallback = ".bin") {
  const clean = String(contentType || "").toLowerCase();
  if (clean.includes("png")) return ".png";
  if (clean.includes("webp")) return ".webp";
  if (clean.includes("gif")) return ".gif";
  if (clean.includes("jpeg") || clean.includes("jpg")) return ".jpg";
  if (clean.includes("mp4")) return ".mp4";
  if (clean.includes("quicktime")) return ".mov";
  if (clean.includes("webm")) return ".webm";
  if (clean.includes("pdf")) return ".pdf";
  return fallback;
}

function messageContentKeys(message = {}) {
  const content = messageContent(message);
  const type = messageType(message);
  const keys = [];
  const seen = new Set();
  const add = (type, key, fallbackName = "") => {
    if (typeof key === "string" && key && !seen.has(`${type}:${key}`)) {
      seen.add(`${type}:${key}`);
      keys.push({ type, key, name: fallbackName || key });
    }
  };
  if (type === "image") {
    add("image", content.image_key, "quoted-image.jpg");
  } else if (type === "media") {
    add("file", content.file_key, content.file_name || "quoted-video.mp4");
    add("image", content.image_key, "quoted-video-thumbnail.jpg");
  } else if (type === "file") {
    add("file", content.file_key, content.file_name || content.name || "quoted-file.bin");
  } else if (type === "audio") {
    add("file", content.file_key, content.file_name || "quoted-audio.bin");
  }
  const walk = (value) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    add("image", value.image_key, value.file_name || value.name || "quoted-image.jpg");
    add("file", value.file_key, value.file_name || value.name || "quoted-file.bin");
    for (const item of Object.values(value)) walk(item);
  };
  walk(content);
  return keys;
}

function shouldUseWebSearch(text = "") {
  return /(最新|今天|今日|现在|当前|实时|联网|搜索|查一下|股价|价格|新闻|市值|估值|财报|汇率|天气|多少|latest|today|current|real[- ]?time|search|stock|price|news|valuation)/i.test(text);
}

function parseMediaCommand(text = "") {
  const raw = String(text || "");
  const image = removeStandaloneDirective(raw, "生图");
  if (image.found) return { kind: "image", prompt: image.cleaned.replace(/^\s*[:：]\s*/, "").trim() };
  const video = raw.match(/生成视频\s*[:：]\s*([\s\S]*)/i);
  if (!video) return null;
  return { kind: "video", prompt: String(video[1] || "").trim() };
}

function parseControlCommand(text = "") {
  const clean = String(text || "").trim();
  const match = clean.match(/^\/(new|reset|always)\s*$/i);
  if (!match) return null;
  const name = match[1].toLowerCase();
  if (name === "new" || name === "reset") return { name: "new" };
  return { name };
}

function removeStandaloneDirective(text = "", directive = "") {
  let found = false;
  const pattern = new RegExp(`(^|[\\s,，;；、。:：])${escapeRegExp(directive)}(?=$|[\\s,，;；、。:：])`, "g");
  const cleaned = String(text || "").replace(pattern, (match, prefix = "") => {
    found = true;
    return prefix && /\S/.test(prefix) ? prefix : " ";
  });
  return { found, cleaned };
}

function parseMemoryDirectives(text = "") {
  const raw = String(text || "");
  const sync = raw.includes("同步记忆库");
  const recall = raw.includes("调取记忆库");
  const search = removeStandaloneDirective(raw, "搜索");
  const cleaned = search.cleaned
    .replaceAll("同步记忆库", "")
    .replaceAll("调取记忆库", "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { sync, recall, webSearch: search.found, cleaned };
}

function isDeepResearch(text = "") {
  return /(深度|详细|全面|对比|分析|报告|调研|研究|多来源|多个来源|引用来源|长文|方案|strategy|research|compare|analysis|report)/i.test(text);
}

function isQuickFact(text = "") {
  return String(text || "").trim().length <= 80
    && /(是什么|什么意思|多少|是谁|哪天|今天|现在|股价|价格|定义|解释|when|what|who|price)/i.test(text);
}

function classifyTask(text = "", { forceWebSearch = false } = {}) {
  const media = parseMediaCommand(text);
  if (media?.kind === "video") {
    return {
      kind: "video",
      maxTurns: config.videoMaxTurns,
      title: "OpenAI 视频生成",
      webSearch: false,
      mediaTask: true,
      prompt: media.prompt,
      rules: [
        "This is a OpenAI Build video task. Use the available OpenAI Build media tools, especially image_to_video or reference_to_video. If no reference image is provided, create a source image first, then animate it. Do not create videos with Python, FFmpeg, shell scripts, or code. Return the saved local MP4 path."
      ]
    };
  }
  if (media?.kind === "image") {
    return {
      kind: "image",
      maxTurns: 0,
      title: `${config.gptImageModel} 生图`,
      webSearch: false,
      mediaTask: true,
      prompt: media.prompt,
      rules: []
    };
  }
  if (isRuntimeModelQuestion(text)) {
    return {
      kind: "model_info",
      maxTurns: 0,
      title: `${activeModelLabel()} 模型信息`,
      webSearch: false,
      mediaTask: false,
      rules: []
    };
  }
  if (forceWebSearch || shouldUseWebSearch(text)) {
    const deep = isDeepResearch(text);
    return {
      kind: deep ? "research" : "quick_search",
      maxTurns: deep ? 18 : 10,
      title: `${activeModelLabel()} 联网检索`,
      webSearch: true,
      mediaTask: false,
      rules: [SEARCH_REQUIRED_RULE, WEB_SOURCE_LINK_RULE]
    };
  }
  if (isQuickFact(text)) {
    return {
      kind: "quick_fact",
      maxTurns: 6,
      title: `${activeModelLabel()} 回复`,
      webSearch: false,
      mediaTask: false,
      rules: []
    };
  }
  return {
    kind: "chat",
    maxTurns: 8,
    title: `${activeModelLabel()} 回复`,
    webSearch: false,
    mediaTask: false,
    rules: []
  };
}

function deterministicUuid(value = "") {
  const bytes = crypto.createHash("sha256").update(String(value)).digest();
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function feishuSessionStatePath() {
  return path.join(os.homedir(), ".grok", "memory", "feishu-chat-sessions.json");
}

function readFeishuSessionState() {
  try {
    const filePath = feishuSessionStatePath();
    if (!fs.existsSync(filePath)) return { v: 1, sessions: {} };
    const parsed = parseJson(fs.readFileSync(filePath, "utf8"), {});
    return {
      v: 1,
      sessions: parsed && typeof parsed.sessions === "object" && parsed.sessions ? parsed.sessions : {}
    };
  } catch {
    return { v: 1, sessions: {} };
  }
}

function writeFeishuSessionState(state) {
  const filePath = feishuSessionStatePath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify({
    v: 1,
    updatedAt: new Date().toISOString(),
    sessions: state.sessions || {}
  }, null, 2));
}

function openAiChatHistoryPath() {
  return path.join(os.homedir(), ".grok", "memory", "openai-chat-history.json");
}

function readOpenAiChatHistory() {
  try {
    const filePath = openAiChatHistoryPath();
    if (!fs.existsSync(filePath)) return { v: 1, chats: {} };
    const parsed = parseJson(fs.readFileSync(filePath, "utf8"), {});
    return {
      v: 1,
      chats: parsed && typeof parsed.chats === "object" && parsed.chats ? parsed.chats : {}
    };
  } catch {
    return { v: 1, chats: {} };
  }
}

function writeOpenAiChatHistory(state) {
  const filePath = openAiChatHistoryPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify({
    v: 1,
    updatedAt: new Date().toISOString(),
    chats: state.chats || {}
  }, null, 2));
}

function chatHistoryKey(session = null) {
  return session?.scopeKey || session?.sessionId || "";
}

function readChatHistory(session = null) {
  const key = chatHistoryKey(session);
  if (!key) return [];
  const state = readOpenAiChatHistory();
  const turns = state.chats?.[key]?.turns;
  return Array.isArray(turns) ? turns.slice(-config.sessionHistoryTurns) : [];
}

function readStoredReplyText(session = null, messageId = "") {
  const key = chatHistoryKey(session);
  if (!key || !messageId) return "";
  const state = readOpenAiChatHistory();
  return String(state.chats?.[key]?.replies?.[messageId]?.text || "");
}

function appendChatHistory(session = null, { user = "", assistant = "", replyMessageId = "" } = {}) {
  const key = chatHistoryKey(session);
  if (!key || (!user && !assistant)) return;
  const state = readOpenAiChatHistory();
  const current = state.chats?.[key] || {};
  const existing = Array.isArray(current.turns) ? current.turns : [];
  const next = [
    ...existing,
    {
      at: new Date().toISOString(),
      user: String(user || "").slice(0, 6000),
      assistant: String(assistant || "").slice(0, 12000)
    }
  ].slice(-Math.max(1, config.sessionHistoryTurns));
  const replies = { ...(current.replies && typeof current.replies === "object" ? current.replies : {}) };
  if (replyMessageId && assistant) {
    replies[replyMessageId] = {
      at: new Date().toISOString(),
      text: String(assistant).slice(0, 12000)
    };
  }
  const retainedReplies = Object.entries(replies)
    .sort(([, left], [, right]) => String(right?.at || "").localeCompare(String(left?.at || "")))
    .slice(0, 36)
    .reduce((result, [id, value]) => ({ ...result, [id]: value }), {});
  state.chats[key] = {
    sessionId: session?.sessionId || "",
    scopeKey: key,
    updatedAt: new Date().toISOString(),
    turns: next,
    replies: retainedReplies
  };
  writeOpenAiChatHistory(state);
}

function resetChatHistory(session = null) {
  const key = chatHistoryKey(session);
  if (!key) return;
  const state = readOpenAiChatHistory();
  delete state.chats[key];
  writeOpenAiChatHistory(state);
}

function chatSessionScope(message = {}) {
  const chatId = message.chat_id || "";
  const chatType = message.chat_type || "unknown";
  if (!chatId) return null;
  const scopeKey = `${chatType}:${chatId}`;
  const state = readFeishuSessionState();
  const sessionId = state.sessions?.[scopeKey]?.sessionId || deterministicUuid(`feishu-grok:${scopeKey}`);
  const cwd = path.join(config.grokCliCwd, "chats", sessionId);
  return { sessionId, cwd, scopeKey };
}

function resetChatSessionScope(message = {}) {
  const chatId = message.chat_id || "";
  const chatType = message.chat_type || "unknown";
  if (!chatId) return null;
  const scopeKey = `${chatType}:${chatId}`;
  const previous = chatSessionScope(message);
  const state = readFeishuSessionState();
  const sessionId = crypto.randomUUID();
  state.sessions[scopeKey] = {
    sessionId,
    scopeHash: sha256Hex(scopeKey).slice(0, 16),
    resetAt: new Date().toISOString()
  };
  writeFeishuSessionState(state);
  const cwd = path.join(config.grokCliCwd, "chats", sessionId);
  return { sessionId, cwd, scopeKey, previousSessionId: previous?.sessionId || "" };
}

function encodedSessionCwd(cwd = config.grokCliCwd) {
  return encodeURIComponent(path.resolve(cwd));
}

function sessionDirectory(sessionId = "", cwd = config.grokCliCwd) {
  return path.join(os.homedir(), ".grok", "sessions", encodedSessionCwd(cwd), sessionId);
}

function sessionExists(sessionId = "", cwd = config.grokCliCwd) {
  return Boolean(sessionId && fs.existsSync(sessionDirectory(sessionId, cwd)));
}

function grokCliArgs(prompt, { maxTurns, model, cwd = config.grokCliCwd, sessionId = "", memoryEnabled = config.grokMemoryEnabled } = {}) {
  const raw = process.env.GROK_CLI_ARGS_JSON || "[\"--no-auto-update\",\"--always-approve\",\"--permission-mode\",\"bypassPermissions\",\"--max-turns\",\"10\",\"--cwd\",\"{{cwd}}\",\"--output-format\",\"streaming-json\",\"-p\",\"{{prompt}}\"]";
  const args = parseJson(raw, ["--no-auto-update", "--always-approve", "--permission-mode", "bypassPermissions", "--max-turns", "10", "--cwd", "{{cwd}}", "--output-format", "streaming-json", "-p", "{{prompt}}"]);
  const turns = String(maxTurns || config.mediaMaxTurns);
  const modelName = model ? String(model) : "";
  const resolvedCwd = cwd || config.grokCliCwd;
  const resolvedArgs = (Array.isArray(args) ? args : ["-p", "{{prompt}}"]).map((arg) => String(arg)
    .replaceAll("{{prompt}}", prompt)
    .replaceAll("{{maxTurns}}", turns)
    .replaceAll("{{model}}", modelName)
    .replaceAll("{{cwd}}", resolvedCwd));
  const turnIndex = resolvedArgs.indexOf("--max-turns");
  if (turnIndex >= 0 && turnIndex + 1 < resolvedArgs.length) {
    resolvedArgs[turnIndex + 1] = turns;
  }
  if (modelName) {
    const modelIndex = resolvedArgs.findIndex((arg) => arg === "-m" || arg === "--model");
    if (modelIndex >= 0 && modelIndex + 1 < resolvedArgs.length) {
      resolvedArgs[modelIndex + 1] = modelName;
    } else {
      resolvedArgs.unshift("--model", modelName);
    }
  }
  if (memoryEnabled) {
    for (let index = resolvedArgs.length - 1; index >= 0; index -= 1) {
      if (resolvedArgs[index] === "--no-memory") resolvedArgs.splice(index, 1);
    }
    if (!resolvedArgs.includes("--experimental-memory")) {
      resolvedArgs.unshift("--experimental-memory");
    }
  } else {
    for (let index = resolvedArgs.length - 1; index >= 0; index -= 1) {
      if (resolvedArgs[index] === "--experimental-memory") resolvedArgs.splice(index, 1);
    }
    if (!resolvedArgs.includes("--no-memory")) {
      resolvedArgs.unshift("--no-memory");
    }
  }
  if (sessionId) {
    const resume = sessionExists(sessionId, resolvedCwd);
    resolvedArgs.unshift(resume ? "--resume" : "--session-id", sessionId);
  }
  return resolvedArgs;
}

function buildConversationBlock(history = []) {
  const turns = (Array.isArray(history) ? history : []).slice(-config.sessionHistoryTurns);
  if (!turns.length) return "";
  return [
    "Recent conversation context for this Feishu chat:",
    ...turns.map((turn, index) => [
      `Turn ${index + 1}`,
      turn.user ? `User: ${turn.user}` : "",
      turn.assistant ? `Assistant: ${turn.assistant}` : ""
    ].filter(Boolean).join("\n"))
  ].join("\n\n");
}

function buildMemoryContextBlock(memoryItems = []) {
  const items = Array.isArray(memoryItems) ? memoryItems.filter(Boolean) : [];
  if (!items.length) return "";
  return [
    "Retrieved memory from the shared Feishu/Obsidian research knowledge base. Use it only when relevant, and do not assume it is current if the user asks for latest data.",
    ...items.map((item, index) => [
      `Memory ${index + 1}: ${item.title || item.path || "Untitled"}`,
      item.path ? `Path: ${item.path}` : "",
      item.preview ? `Content:\n${item.preview}` : ""
    ].filter(Boolean).join("\n"))
  ].join("\n\n");
}

function buildGrokPrompt(userPrompt = "", { quotedContext = null, taskRules = [], conversationHistory = [], memoryItems = [] } = {}) {
  const quotedLines = quotedContext
    ? [
        "The user explicitly replied to or quoted this Feishu message. Treat it as referenced context, then use your own agent judgment.",
        quotedContext.text ? `Quoted text:\n${quotedContext.text}` : "",
        ...quotedContext.files.map((item) => item.path
          ? `Quoted ${item.type} file: ${item.path}`
          : `Quoted ${item.type || "resource"} could not be downloaded: ${item.error || "unknown error"}`)
      ].filter(Boolean)
    : [];
  return [
    config.systemPrompt,
    buildRuntimeModelContextBlock(),
    buildConversationBlock(conversationHistory),
    buildMemoryContextBlock(memoryItems),
    ...quotedLines,
    ...taskRules,
    "User message:",
    String(userPrompt || "").trim()
  ].filter(Boolean).join("\n\n");
}

function parseStreamingJsonLine(line = "") {
  const clean = stripAnsi(line).trim();
  if (!clean || !clean.startsWith("{")) return null;
  try {
    return JSON.parse(clean);
  } catch {
    return null;
  }
}

function streamingEventText(event = {}) {
  for (const key of ["data", "text", "content", "delta", "message"]) {
    if (typeof event[key] === "string" && event[key]) return event[key];
  }
  return "";
}

function describeGrokEvent(event = {}) {
  const text = `${event.type || ""} ${event.name || ""} ${event.tool || ""}`.toLowerCase();
  if (!text.trim()) return "";
  if (text.includes("web") || text.includes("search") || text.includes("browser")) {
    return "正在联网搜索并核对来源";
  }
  if (text.includes("tool")) return "正在调用工具获取信息";
  if (text.includes("end") || text.includes("completed")) return "正在整理最终回答";
  if (text.includes("error") || text.includes("failed")) return "模型返回运行事件，正在等待最终结果";
  return "";
}

class GitHubFileSync {
  constructor({ token = "", repo = "", branch = "main", timeoutMs = 30000 } = {}) {
    this.token = token;
    this.repo = normalizeRepo(repo);
    this.branch = branch || "main";
    this.timeoutMs = Number(timeoutMs) || 30000;
  }

  get enabled() {
    return Boolean(this.token && this.repo);
  }

  splitRepo() {
    const [owner, repo] = this.repo.split("/");
    if (!owner || !repo) throw new Error("GitHub repo must use owner/repo format.");
    return { owner, repo };
  }

  async request(requestPath, options = {}) {
    if (!this.enabled) throw new Error("GitHub file sync is not configured.");
    let response;
    try {
      response = await fetch(`https://api.github.com${requestPath}`, {
        ...options,
        signal: options.signal || AbortSignal.timeout(this.timeoutMs),
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "Content-Type": "application/json",
          ...(options.headers || {})
        }
      });
    } catch (error) {
      if (error?.name === "AbortError" || error?.name === "TimeoutError") {
        throw new Error(`GitHub API timed out after ${this.timeoutMs}ms: ${requestPath}`);
      }
      throw error;
    }
    const text = await response.text();
    if (!response.ok) {
      const syncError = new Error(`GitHub API ${response.status}: ${truncate(text, 500)}`);
      syncError.status = response.status;
      throw syncError;
    }
    return text ? JSON.parse(text) : null;
  }

  async getFile(notePath) {
    const { owner, repo } = this.splitRepo();
    const branch = encodeURIComponent(this.branch);
    try {
      const file = await this.request(`/repos/${owner}/${repo}/contents/${encodeGitHubPath(notePath)}?ref=${branch}`);
      return {
        sha: file.sha || "",
        content: Buffer.from(file.content || "", "base64").toString("utf8")
      };
    } catch (error) {
      if (error.status === 404) return { sha: "", content: "" };
      throw error;
    }
  }

  async listFiles(folderPath) {
    const { owner, repo } = this.splitRepo();
    const branch = encodeURIComponent(this.branch);
    try {
      const data = await this.request(`/repos/${owner}/${repo}/contents/${encodeGitHubPath(folderPath)}?ref=${branch}`);
      return Array.isArray(data) ? data.filter((item) => item.type === "file") : [];
    } catch (error) {
      if (error.status === 404) return [];
      throw error;
    }
  }

  async listMarkdownFiles() {
    const { owner, repo } = this.splitRepo();
    const branch = encodeURIComponent(this.branch);
    const data = await this.request(`/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`);
    return (data?.tree || [])
      .filter((item) => item.type === "blob" && /\.md$/i.test(item.path || ""))
      .map((item) => ({ path: item.path, size: item.size || 0 }));
  }

  async putFile(notePath, content, message) {
    const { owner, repo } = this.splitRepo();
    const remote = await this.getFile(notePath);
    if (remote.content === String(content || "")) {
      return { path: notePath, sha: remote.sha, changed: false };
    }
    const body = {
      message: message || `Update ${notePath}`,
      content: Buffer.from(String(content || ""), "utf8").toString("base64"),
      branch: this.branch
    };
    if (remote.sha) body.sha = remote.sha;
    const result = await this.request(`/repos/${owner}/${repo}/contents/${encodeGitHubPath(notePath)}`, {
      method: "PUT",
      body: JSON.stringify(body)
    });
    return { path: notePath, sha: result?.content?.sha || "", changed: true };
  }

  async appendUnique(notePath, block, message) {
    const remote = await this.getFile(notePath);
    const current = String(remote.content || "").trimEnd();
    const nextBlock = String(block || "").trim();
    if (!nextBlock) return { path: notePath, sha: remote.sha, changed: false };
    if (current.includes(nextBlock)) return { path: notePath, sha: remote.sha, changed: false };
    const next = current ? `${current}\n\n${nextBlock}\n` : `${nextBlock}\n`;
    return this.putFile(notePath, next, message);
  }
}

async function callGrokCli(prompt, { onText, onEvent, maxTurns, model = "", quotedContext = null, taskRules = [], timeoutMs, session = null, memoryEnabled = config.grokMemoryEnabled, conversationHistory = [], memoryItems = [] } = {}) {
  const effectivePrompt = buildGrokPrompt(prompt, { quotedContext, taskRules, conversationHistory, memoryItems });
  return callGpt55Responses(effectivePrompt, { onText, onEvent, timeoutMs });
}

function gpt55ResponsesUrl() {
  const clean = String(config.gpt55BaseUrl || "").replace(/\/+$/, "");
  if (!clean) throw new Error("GPT55_BASE_URL is required.");
  if (/\/responses$/i.test(clean)) return clean;
  if (/\/v1$/i.test(clean)) return `${clean}/responses`;
  return `${clean}/v1/responses`;
}

function gptImageGenerationsUrl() {
  const clean = String(config.gpt55BaseUrl || "").replace(/\/+$/, "");
  if (!clean) throw new Error("GPT55_BASE_URL is required.");
  if (/\/v1\/responses$/i.test(clean)) return clean.replace(/\/responses$/i, "/images/generations");
  if (/\/responses$/i.test(clean)) return clean.replace(/\/responses$/i, "/images/generations");
  if (/\/v1$/i.test(clean)) return `${clean}/images/generations`;
  return `${clean}/v1/images/generations`;
}

function imageExtension(outputFormat = "") {
  const clean = String(outputFormat || "").toLowerCase();
  if (clean === "jpeg" || clean === "jpg") return "jpg";
  if (clean === "webp") return "webp";
  return "png";
}

function saveGeneratedImage(buffer, outputFormat = "png") {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error("Image API returned an empty image payload.");
  if (buffer.length > config.maxImageBytes) {
    throw new Error(`Generated image exceeds the ${config.maxImageBytes} byte upload limit.`);
  }
  const dir = path.join(os.homedir(), ".grok", "generated-media");
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `gpt-image-${Date.now()}-${crypto.randomUUID()}.${imageExtension(outputFormat)}`);
  fs.writeFileSync(filePath, buffer);
  if (!isSafeGrokImagePath(filePath)) {
    safeDeleteLocalFile(filePath);
    throw new Error("Generated image was not a safe uploadable image file.");
  }
  return filePath;
}

async function callGptImageGeneration(prompt = "") {
  const cleanPrompt = String(prompt || "").trim();
  if (!cleanPrompt) throw new Error("“生图”后需要写出图片描述，例如：生图 一张未来城市夜景。");
  if (!config.gpt55ApiKey) throw new Error("GPT55_API_KEY is required for image generation.");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.gptImageTimeoutMs);
  try {
    const response = await fetch(gptImageGenerationsUrl(), {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${config.gpt55ApiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: config.gptImageModel,
        prompt: cleanPrompt,
        size: config.gptImageSize,
        quality: config.gptImageQuality,
        output_format: "png",
        n: 1
      })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const detail = data?.error?.message || data?.message || JSON.stringify(data).slice(0, 500);
      throw new Error(`GPT Image API failed ${response.status}: ${detail}`);
    }
    const item = data?.data?.[0] || {};
    if (item.b64_json || item.base64) {
      const raw = String(item.b64_json || item.base64);
      const dataUrl = raw.match(/^data:image\/(png|jpe?g|webp);base64,(.+)$/i);
      const imageBuffer = Buffer.from(dataUrl ? dataUrl[2] : raw, "base64");
      return {
        imagePath: saveGeneratedImage(imageBuffer, dataUrl?.[1] || item.output_format || "png"),
        revisedPrompt: String(item.revised_prompt || "")
      };
    }
    if (item.url) {
      const imageResponse = await fetch(item.url, { signal: controller.signal });
      if (!imageResponse.ok) throw new Error(`GPT Image URL download failed ${imageResponse.status}.`);
      const contentType = imageResponse.headers.get("content-type") || "";
      const imageBuffer = Buffer.from(await imageResponse.arrayBuffer());
      return {
        imagePath: saveGeneratedImage(imageBuffer, contentType.includes("webp") ? "webp" : contentType.includes("jpeg") ? "jpg" : "png"),
        revisedPrompt: String(item.revised_prompt || "")
      };
    }
    throw new Error("GPT Image API returned neither b64_json nor an image URL.");
  } finally {
    clearTimeout(timer);
  }
}

function gpt55ExtractOutputText(data = {}) {
  if (typeof data.output_text === "string" && data.output_text) return data.output_text;
  if (Array.isArray(data.output)) {
    return data.output.flatMap((item) => {
      if (!Array.isArray(item.content)) return [];
      return item.content.map((part) => part.text || part.output_text || "").filter(Boolean);
    }).join("\n");
  }
  return data?.choices?.[0]?.message?.content || data?.choices?.[0]?.text || data?.text || "";
}

function gpt55EventStatus(event = {}) {
  const type = String(event.type || "");
  if (type.includes("web_search")) return "正在联网搜索并核对来源";
  if (type.includes("response.output_text")) return "正在生成回复";
  if (type.includes("completed")) return "正在整理最终回答";
  return "";
}

async function callGpt55Responses(prompt, { onText, onEvent, timeoutMs } = {}) {
  if (!config.gpt55ApiKey || !config.gpt55Model) {
    throw new Error("GPT55_API_KEY and GPT55_MODEL are required.");
  }
  const body = {
    model: config.gpt55Model,
    input: prompt,
    tools: config.gpt55WebSearchEnabled ? [{ type: "web_search" }] : [],
    temperature: 0.2,
    max_output_tokens: 4000,
    stream: true
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(timeoutMs || config.grokCliTimeoutMs));
  try {
    const response = await fetch(gpt55ResponsesUrl(), {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${config.gpt55ApiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`${activeModelLabel()} Responses API ${response.status}: ${sanitizeGrokOutput(text).slice(0, 1000)}`);
    }
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("text/event-stream")) {
      const data = await response.json();
      const text = sanitizeGrokOutput(gpt55ExtractOutputText(data));
      if (text) onText?.(text, text);
      if (!text) throw new Error(`${activeModelLabel()} Responses API returned no text: ${JSON.stringify(data).slice(0, 1000)}`);
      return text;
    }
    const decoder = new TextDecoder();
    let buffer = "";
    let answer = "";
    let completedText = "";
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });
      const frames = buffer.split(/\n\n/);
      buffer = frames.pop() || "";
      for (const frame of frames) {
        const dataLines = frame.split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim());
        for (const dataLine of dataLines) {
          if (!dataLine || dataLine === "[DONE]") continue;
          let event;
          try {
            event = JSON.parse(dataLine);
          } catch {
            continue;
          }
          const status = gpt55EventStatus(event);
          if (status) onEvent?.({ type: event.type, name: status });
          if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
            answer += event.delta;
            onText?.(sanitizeGrokOutput(answer), event.delta);
          } else if (event.type === "response.completed") {
            completedText = gpt55ExtractOutputText(event.response || {});
          } else if (event.type === "response.failed") {
            throw new Error(`${activeModelLabel()} Responses API failed: ${JSON.stringify(event.error || event).slice(0, 1000)}`);
          }
        }
      }
    }
    const finalText = sanitizeGrokOutput(answer || completedText);
    if (!finalText) throw new Error(`${activeModelLabel()} Responses API returned empty output.`);
    if (finalText !== answer) onText?.(finalText, finalText);
    return finalText;
  } finally {
    clearTimeout(timer);
  }
}

async function callGrokImagineVideo(prompt, options = {}) {
  options.onEvent?.({ type: "tool", name: "grok-build-image-to-video" });
  const answer = await callGrokCli(prompt, {
    ...options,
    model: config.videoModel,
    maxTurns: options.maxTurns || config.videoMaxTurns
  });
  const videoPaths = extractLocalVideoPaths(answer);
  if (!videoPaths.length) {
    throw new Error(`OpenAI video task finished without a safe MP4 path. Output: ${stripLocalMediaPaths(answer).slice(-1600)}`);
  }
  return answer;
}

async function probeGrokTui(input = "/help", timeoutMs = 12000) {
  fs.mkdirSync(config.grokCliCwd, { recursive: true });
  const command = await ensureGrokCliCommand();
  const shellCommand = [
    shellQuote(command),
    "--no-auto-update",
    "--no-memory",
    "--always-approve",
    "--permission-mode",
    "bypassPermissions",
    "--cwd",
    shellQuote(config.grokCliCwd)
  ].join(" ");
  return new Promise((resolve) => {
    const child = spawn("script", ["-q", "-f", "-e", "-c", shellCommand, "/dev/null"], {
      env: {
        ...process.env,
        GROK_MEMORY: "0"
      },
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let finished = false;
    const finish = (result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try {
        child.stdin?.write("/quit\r");
      } catch {
        // Ignore closed stdin.
      }
      setTimeout(() => {
        if (!child.killed) child.kill("SIGTERM");
      }, 1000).unref?.();
      resolve(result);
    };
    const timer = setTimeout(() => {
      finish({
        ok: false,
        timedOut: true,
        stdoutTail: sanitizeGrokOutput(stdout).slice(-3000),
        stderrTail: sanitizeGrokOutput(stderr).slice(-1000)
      });
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout = appendCappedText(stdout, chunk.toString("utf8"), 30000);
    });
    child.stderr.on("data", (chunk) => {
      stderr = appendCappedText(stderr, chunk.toString("utf8"), 10000);
    });
    child.on("error", (error) => {
      finish({ ok: false, error: error.message, stdoutTail: sanitizeGrokOutput(stdout).slice(-3000), stderrTail: sanitizeGrokOutput(stderr).slice(-1000) });
    });
    child.on("close", (code) => {
      finish({ ok: code === 0, exitCode: code, stdoutTail: sanitizeGrokOutput(stdout).slice(-5000), stderrTail: sanitizeGrokOutput(stderr).slice(-1000) });
    });
    setTimeout(() => {
      child.stdin.write(`${input}\r`);
    }, 1500).unref?.();
    setTimeout(() => {
      child.stdin.write("/quit\r");
    }, Math.max(2500, timeoutMs - 2000)).unref?.();
  });
}

async function probeGrokCli(prompt, timeoutMs = 60000) {
  fs.mkdirSync(config.grokCliCwd, { recursive: true });
  const command = await ensureGrokCliCommand();
  const args = grokCliArgs(prompt, { memoryEnabled: false });
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: {
        ...process.env,
        GROK_MEMORY: "0"
      },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const events = [];
    let stdout = "";
    let stderr = "";
    let lineBuffer = "";
    let textLength = 0;
    let finished = false;
    const finish = (result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish({
        ok: false,
        timedOut: true,
        command,
        args: args.map((arg) => (arg === prompt ? "{{prompt}}" : arg)),
        events,
        textLength,
        stderrTail: sanitizeGrokOutput(stderr).slice(-1200),
        stdoutTail: sanitizeGrokOutput(stdout).slice(-1200)
      });
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      const piece = chunk.toString("utf8");
      stdout += piece;
      lineBuffer += piece;
      const lines = lineBuffer.split(/\r?\n/);
      lineBuffer = lines.pop() || "";
      for (const line of lines) {
        const event = parseStreamingJsonLine(line);
        if (!event) continue;
        const delta = event.type === "text" ? streamingEventText(event) : "";
        if (delta) textLength += delta.length;
        if (events.length < 40) {
          events.push({
            type: event.type || "",
            name: event.name || event.tool || "",
            textLength: delta.length
          });
        }
      }
    });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      const event = parseStreamingJsonLine(lineBuffer);
      if (event) {
        const delta = event.type === "text" ? streamingEventText(event) : "";
        if (delta) textLength += delta.length;
        if (events.length < 40) {
          events.push({
            type: event.type || "",
            name: event.name || event.tool || "",
            textLength: delta.length
          });
        }
      }
      finish({
        ok: code === 0,
        timedOut: false,
        exitCode: code,
        command,
        args: args.map((arg) => (arg === prompt ? "{{prompt}}" : arg)),
        events,
        textLength,
        stderrTail: sanitizeGrokOutput(stderr).slice(-1200),
        stdoutTail: sanitizeGrokOutput(stdout).slice(-1200)
      });
    });
  });
}

async function runCliDiagnostic(command, args, timeout = 20000) {
  try {
    const result = await execFileAsync(command, args, {
      env: {
        ...process.env,
        GROK_MEMORY: "0"
      },
      timeout,
      windowsHide: true,
      maxBuffer: 1024 * 1024
    });
    return {
      ok: true,
      stdout: redactSensitive(sanitizeGrokOutput(result.stdout)).slice(0, 6000),
      stderr: redactSensitive(sanitizeGrokOutput(result.stderr)).slice(0, 3000)
    };
  } catch (error) {
    return {
      ok: false,
      message: redactSensitive(error.message),
      stdout: redactSensitive(sanitizeGrokOutput(error.stdout || "")).slice(0, 6000),
      stderr: redactSensitive(sanitizeGrokOutput(error.stderr || "")).slice(0, 3000)
    };
  }
}

function statIfExists(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return {
      exists: true,
      isFile: stat.isFile(),
      isDirectory: stat.isDirectory(),
      size: stat.size,
      modifiedAt: stat.mtime.toISOString()
    };
  } catch {
    return { exists: false };
  }
}

async function grokDiagnostics() {
  const command = await ensureGrokCliCommand();
  const home = os.homedir();
  const grokHome = path.join(home, ".grok");
  const help = await runCliDiagnostic(command, ["--help"]);
  const version = await runCliDiagnostic(command, ["--version"]);
  const inspect = await runCliDiagnostic(command, ["inspect"], 30000);
  const maxToolRoundsSmoke = await runCliDiagnostic(command, [
    "--no-auto-update",
    "--no-memory",
    "--always-approve",
    "--permission-mode",
    "bypassPermissions",
    "--max-tool-rounds",
    "1",
    "--output-format",
    "json",
    "-p",
    "Do not use tools. Reply with OK."
  ], 45000);
  const maxTurnsSmoke = await runCliDiagnostic(command, [
    "--no-auto-update",
    "--no-memory",
    "--always-approve",
    "--permission-mode",
    "bypassPermissions",
    "--max-turns",
    "4",
    "--output-format",
    "json",
    "-p",
    "Do not use tools. Reply with OK."
  ], 45000);
  const webToolsSmoke = await runCliDiagnostic(command, [
    "--no-auto-update",
    "--no-memory",
    "--always-approve",
    "--permission-mode",
    "bypassPermissions",
    "--tools",
    "web_search,web_fetch",
    "--max-turns",
    "6",
    "--output-format",
    "streaming-json",
    "-p",
    "Use web_search to find the xAI CLI headless scripting docs URL, then answer with only that URL."
  ], 90000);
  const helpText = `${help.stdout}\n${help.stderr}`;
  let sessionCount = null;
  try {
    const sessionsDir = path.join(grokHome, "sessions");
    sessionCount = fs.existsSync(sessionsDir) ? fs.readdirSync(sessionsDir).length : 0;
  } catch {
    sessionCount = null;
  }
  return {
    command,
    cwd: process.cwd(),
    home,
    grokCliCwd: config.grokCliCwd,
    configuredArgs: grokCliArgs("{{prompt}}"),
    mediaConfiguredArgs: grokCliArgs("{{prompt}}", { maxTurns: config.mediaMaxTurns }),
    videoConfiguredArgs: grokCliArgs("{{prompt}}", { maxTurns: config.videoMaxTurns, model: config.videoModel }),
    files: {
      grokHome: statIfExists(grokHome),
      authJson: statIfExists(path.join(grokHome, "auth.json")),
      configToml: statIfExists(path.join(grokHome, "config.toml")),
      requirementsToml: statIfExists(path.join(grokHome, "requirements.toml")),
      sessions: {
        ...statIfExists(path.join(grokHome, "sessions")),
        count: sessionCount
      }
    },
    supports: {
      alwaysApprove: /--always-approve/.test(helpText),
      permissionMode: /--permission-mode/.test(helpText),
      maxToolRounds: /--max-tool-rounds/.test(helpText),
      sandbox: /--sandbox/.test(helpText),
      deviceAuth: /device-auth/.test(helpText)
    },
    version,
    help: {
      ok: help.ok,
      excerpt: helpText.split("\n").filter((line) => /approve|permission|tool|search|sandbox|format|auto|headless|max/i.test(line)).slice(0, 80)
    },
    inspect,
    maxToolRoundsSmoke,
    maxTurnsSmoke,
    webToolsSmoke
  };
}

async function answerWithGrok(prompt) {
  return callGrokCli(prompt);
}

function createCardKitStreamingUpdater({ feishu, cardId, messageId = "", title, webSearch, memorySync = false, memoryRecall = false }) {
  let sequence = 0;
  let lastAnswerAt = 0;
  let lastStatusAt = 0;
  let latestAnswer = "";
  let latestStatus = webSearch ? "正在联网搜索并核对来源" : "正在生成回答";
  let sentAnswer = "";
  let sentStatus = "";
  let queue = Promise.resolve();
  const nextSequence = () => {
    sequence += 1;
    return sequence;
  };
  const enqueue = (task) => {
    queue = queue
      .then(task)
      .catch((error) => {
        console.error("Feishu CardKit streaming update failed:", error.message);
      });
    return queue;
  };
  const patchAnswer = (text, force = false) => {
    latestAnswer = sanitizeFeishuText(text);
    if (!cardId || !latestAnswer) return queue;
    const now = Date.now();
    if (!force && now - lastAnswerAt < 900) return queue;
    lastAnswerAt = now;
    return enqueue(async () => {
      const textToSend = latestAnswer;
      if (!textToSend || textToSend === sentAnswer) return;
      await feishu.streamCardText(cardId, STREAM_ANSWER_ELEMENT_ID, ` ${cardMarkdown(textToSend, config.maxCardContentChars - 1)}`, nextSequence());
      sentAnswer = textToSend;
    });
  };
  const patchStatus = (status, force = false) => {
    latestStatus = sanitizeFeishuText(status).slice(0, 260);
    if (!cardId || !latestStatus) return queue;
    const now = Date.now();
    if (!force && now - lastStatusAt < 3000) return queue;
    lastStatusAt = now;
    return enqueue(async () => {
      const statusToSend = latestStatus;
      if (!statusToSend || statusToSend === sentStatus) return;
      await feishu.streamCardText(cardId, STREAM_STATUS_ELEMENT_ID, grokStatusMarkdown(statusToSend), nextSequence());
      sentStatus = statusToSend;
    });
  };
  return {
    patchAnswer,
    patchStatus,
    finish: async (footerStatus = {}) => {
      await queue;
      await patchAnswer(latestAnswer, true);
      await queue;
      try {
        await feishu.updateCard(cardId, buildFinalCard(latestAnswer, title, {
          webSearch,
          memorySync,
          memoryRecall,
          ...footerStatus
        }), nextSequence());
      } catch (error) {
        console.warn(`CardKit final update failed, falling back to final rich card: ${error.message}`);
        if (!messageId) throw error;
        await feishu.replyRich(messageId, latestAnswer || "没有生成可发送的回复。", title);
      }
      await queue;
    },
    fail: async (errorText) => {
      latestAnswer = sanitizeFeishuText(errorText);
      await queue;
      await patchAnswer(latestAnswer, true);
      await patchStatus("运行失败，已把根因暴露在卡片里", true);
      await enqueue(() => feishu.updateCardSettings(cardId, {
        config: {
          streaming_mode: false,
          summary: { content: `${activeModelLabel()} 运行失败` }
        }
      }, nextSequence()));
      await queue;
    }
  };
}

function createPlainFinalUpdater({ feishu, messageId, title }) {
  let latestAnswer = "";
  return {
    patchAnswer: (text) => {
      latestAnswer = sanitizeFeishuText(text);
      return Promise.resolve();
    },
    patchStatus: () => Promise.resolve(),
    finish: async () => {
      await feishu.replyRich(messageId, latestAnswer || "没有生成可发送的回复。", title);
    },
    fail: async (errorText) => {
      await feishu.replyRich(messageId, sanitizeFeishuText(errorText), `${activeModelLabel()} 运行错误`);
    }
  };
}

class FeishuClient {
  constructor() {
    this.token = "";
    this.tokenExpiresAt = 0;
    this.cachedBotInfo = null;
    this.botInfoExpiresAt = 0;
  }

  get enabled() {
    return Boolean(config.feishuAppId && config.feishuAppSecret);
  }

  async tenantAccessToken() {
    const now = Date.now();
    if (this.token && now < this.tokenExpiresAt - 60000) return this.token;
    if (!this.enabled) throw new Error("Feishu credentials are not configured.");
    const response = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        app_id: config.feishuAppId,
        app_secret: config.feishuAppSecret
      })
    });
    const data = await response.json();
    if (!response.ok || data.code !== 0) {
      throw new Error(`Feishu tenant token failed: ${JSON.stringify(data).slice(0, 500)}`);
    }
    this.token = data.tenant_access_token;
    this.tokenExpiresAt = now + Number(data.expire || 3600) * 1000;
    return this.token;
  }

  async botInfo() {
    const now = Date.now();
    if (this.cachedBotInfo && now < this.botInfoExpiresAt) return this.cachedBotInfo;
    const data = await this.get("/open-apis/bot/v3/info");
    const bot = data?.bot || data?.data?.bot || {};
    if (!bot.open_id && !bot.app_name) throw new Error(`Feishu bot info did not return bot identity: ${JSON.stringify(data).slice(0, 500)}`);
    this.cachedBotInfo = bot;
    this.botInfoExpiresAt = now + 6 * 60 * 60 * 1000;
    return bot;
  }

  async post(path, body, method = "POST") {
    const token = await this.tenantAccessToken();
    const response = await fetch(`https://open.feishu.cn${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify(body)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.code !== 0) {
      throw new Error(`Feishu API failed ${response.status}: ${JSON.stringify(data).slice(0, 500)}`);
    }
    return data;
  }

  async get(path) {
    const token = await this.tenantAccessToken();
    const response = await fetch(`https://open.feishu.cn${path}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`
      }
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.code !== 0) {
      throw new Error(`Feishu API failed ${response.status}: ${JSON.stringify(data).slice(0, 500)}`);
    }
    return data;
  }

  async download(requestPath, destPath) {
    const token = await this.tenantAccessToken();
    const response = await fetch(`https://open.feishu.cn${requestPath}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`
      }
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Feishu download failed ${response.status}: ${body.slice(0, 500)}`);
    }
    const contentType = response.headers.get("content-type") || "";
    const buffer = Buffer.from(await response.arrayBuffer());
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.writeFileSync(destPath, buffer);
    return { path: destPath, contentType, size: buffer.length };
  }

  async getMessage(messageId) {
    if (!messageId) return null;
    // Feishu only returns the sent Card JSON when this documented query parameter is set.
    const params = new URLSearchParams({ card_msg_content_type: "user_card_content" });
    const data = await this.get(`/open-apis/im/v1/messages/${encodeURIComponent(messageId)}?${params.toString()}`);
    const item = data?.data?.items?.[0] || data?.data?.message || data?.data?.item || data?.data;
    return item && typeof item === "object" ? item : null;
  }

  async getWikiNode(token, objType = "wiki") {
    if (!token) throw new Error("Missing Feishu wiki token.");
    const params = new URLSearchParams({ token: String(token || "") });
    if (objType) params.set("obj_type", objType);
    const data = await this.get(`/open-apis/wiki/v2/spaces/get_node?${params.toString()}`);
    return data?.data?.node || data?.node || {};
  }

  async createWikiDocument({ parentWikiToken, title, markdown }) {
    if (!parentWikiToken) throw new Error("Missing Feishu parent wiki token.");
    const parent = await this.getWikiNode(parentWikiToken, "wiki");
    const spaceId = parent.space_id || "";
    const parentNodeToken = parent.node_token || parent.wiki_token || parentWikiToken;
    if (!spaceId || !parentNodeToken) {
      throw new Error(`Feishu parent wiki node missing space_id/node_token: ${truncate(JSON.stringify(parent), 500)}`);
    }
    const data = await this.post(`/open-apis/wiki/v2/spaces/${encodeURIComponent(spaceId)}/nodes`, {
      obj_type: "docx",
      node_type: "origin",
      parent_node_token: parentNodeToken,
      title: String(title || "OpenAI research note").slice(0, 800)
    });
    const node = data?.data?.node || data?.node || {};
    const documentId = node.obj_token || "";
    const wikiToken = node.node_token || node.wiki_token || "";
    if (!documentId) throw new Error(`Feishu wiki node response missing obj_token: ${truncate(JSON.stringify(data), 500)}`);
    await this.insertPlainMarkdown(documentId, markdown);
    return {
      created: true,
      token: documentId,
      wikiToken,
      url: node.url || (wikiToken ? `${config.feishuDocBaseUrl}/wiki/${wikiToken}` : `${config.feishuDocBaseUrl}/docx/${documentId}`)
    };
  }

  async insertPlainMarkdown(documentId, markdown) {
    const children = markdownToTextBlocks(markdown).slice(0, 500);
    for (let start = 0; start < children.length; start += 20) {
      const chunk = children.slice(start, start + 20);
      await this.post(`/open-apis/docx/v1/documents/${encodeURIComponent(documentId)}/blocks/${encodeURIComponent(documentId)}/children`, {
        children: chunk
      });
    }
  }

  async downloadMessageResource(messageId, resource) {
    const type = resource.type === "image" ? "image" : "file";
    const baseName = safeName(resource.name || resource.key);
    const rawDest = path.join(config.grokCliCwd, "quoted", safeName(messageId), baseName);
    const resourcePath = `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/resources/${encodeURIComponent(resource.key)}?type=${encodeURIComponent(type)}`;
    try {
      const downloaded = await this.download(resourcePath, rawDest);
      const ext = path.extname(rawDest) || extFromContentType(downloaded.contentType, type === "image" ? ".jpg" : ".bin");
      if (!path.extname(rawDest) && ext) {
        const renamed = `${rawDest}${ext}`;
        fs.renameSync(rawDest, renamed);
        downloaded.path = renamed;
      }
      return { type, key: resource.key, path: downloaded.path, size: downloaded.size };
    } catch (error) {
      if (type !== "image") throw error;
      const fallbackDest = path.extname(rawDest) ? rawDest : `${rawDest}.jpg`;
      const downloaded = await this.download(`/open-apis/im/v1/images/${encodeURIComponent(resource.key)}`, fallbackDest);
      return { type, key: resource.key, path: downloaded.path, size: downloaded.size };
    }
  }

  async quotedContextFromMessage(message, { resolveStoredReplyText } = {}) {
    const firstQuoteId = quotedMessageId(message);
    if (!firstQuoteId) return null;

    const seen = new Set([message.message_id].filter(Boolean));
    const chain = [];
    const textParts = [];
    const files = [];
    let currentId = firstQuoteId;

    for (let depth = 0; currentId && depth < 3 && !seen.has(currentId); depth += 1) {
      seen.add(currentId);
      const entry = {
        messageId: currentId,
        messageType: "",
        textSource: "",
        cardSchema: "",
        textPreview: "",
        resourceCount: 0,
        fileCount: 0
      };
      chain.push(entry);

      const quoted = await this.getMessage(currentId);
      if (!quoted) {
        entry.error = "Quoted Feishu message was not found.";
        break;
      }

      const type = messageType(quoted);
      const extracted = extractMessageTextDetails(quoted);
      let text = extracted.text;
      const resources = messageContentKeys(quoted);
      const filesBefore = files.filter((item) => item.path).length;
      entry.messageType = type;
      entry.textSource = extracted.source;
      entry.cardSchema = extracted.schema;
      if (!text && type === "interactive" && typeof resolveStoredReplyText === "function") {
        const storedText = await resolveStoredReplyText(currentId);
        if (storedText) {
          text = String(storedText);
          entry.textSource = "stored_reply_fallback";
        }
      }
      entry.textPreview = text.slice(0, 160);
      entry.resourceCount = resources.length;

      if (text) {
        textParts.push(`Quoted message ${depth + 1}${type ? ` (${type})` : ""}:\n${text}`);
      }

      for (const resource of resources) {
        try {
          const downloaded = await this.downloadMessageResource(currentId, resource);
          files.push({ ...downloaded, sourceMessageId: currentId });
        } catch (error) {
          files.push({ type: resource.type, key: resource.key, sourceMessageId: currentId, error: error.message });
        }
      }

      entry.fileCount = files.filter((item) => item.path).length - filesBefore;
      if (entry.fileCount > 0) break;

      const nextId = quotedMessageId(quoted);
      currentId = nextId && !seen.has(nextId) ? nextId : "";
    }

    return {
      messageId: firstQuoteId,
      messageType: chain[0]?.messageType || "",
      text: textParts.join("\n\n"),
      files,
      chain
    };
  }

  async uploadImage(filePath) {
    const resolved = path.resolve(filePath);
    if (!isSafeGrokImagePath(resolved)) {
      throw new Error(`Refusing to upload unsafe or missing image path: ${resolved}`);
    }
    const token = await this.tenantAccessToken();
    const buffer = fs.readFileSync(resolved);
    const form = new FormData();
    form.append("image_type", "message");
    form.append("image", new Blob([buffer], { type: imageMimeType(resolved) }), path.basename(resolved));
    const response = await fetch("https://open.feishu.cn/open-apis/im/v1/images", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`
      },
      body: form
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.code !== 0) {
      throw new Error(`Feishu image upload failed ${response.status}: ${JSON.stringify(data).slice(0, 500)}`);
    }
    const imageKey = data?.data?.image_key || data?.image_key || "";
    if (!imageKey) throw new Error(`Feishu image upload did not return image_key: ${JSON.stringify(data).slice(0, 500)}`);
    return imageKey;
  }

  async uploadFile(filePath, fileType = "stream") {
    const resolved = path.resolve(filePath);
    if (!isSafeGrokVideoPath(resolved)) {
      throw new Error(`Refusing to upload unsafe or missing video path: ${resolved}`);
    }
    const token = await this.tenantAccessToken();
    const buffer = fs.readFileSync(resolved);
    const form = new FormData();
    form.append("file_type", fileType);
    form.append("file_name", path.basename(resolved));
    form.append("file", new Blob([buffer], { type: "application/octet-stream" }), path.basename(resolved));
    const response = await fetch("https://open.feishu.cn/open-apis/im/v1/files", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`
      },
      body: form
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.code !== 0) {
      throw new Error(`Feishu file upload failed ${response.status}: ${JSON.stringify(data).slice(0, 500)}`);
    }
    const fileKey = data?.data?.file_key || data?.file_key || "";
    if (!fileKey) throw new Error(`Feishu file upload did not return file_key: ${JSON.stringify(data).slice(0, 500)}`);
    return fileKey;
  }

  async replyImage(messageId, imageKey) {
    if (!messageId || !imageKey) return null;
    const response = await this.post(`/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reply`, {
      msg_type: "image",
      content: JSON.stringify({ image_key: imageKey })
    });
    rememberBotResponse(response);
    return response;
  }

  async replyMedia(messageId, fileKey, imageKey) {
    if (!messageId || !fileKey || !imageKey) return null;
    const response = await this.post(`/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reply`, {
      msg_type: "media",
      content: JSON.stringify({ file_key: fileKey, image_key: imageKey })
    });
    rememberBotResponse(response);
    return response;
  }

  async replyFile(messageId, fileKey) {
    if (!messageId || !fileKey) return null;
    const response = await this.post(`/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reply`, {
      msg_type: "file",
      content: JSON.stringify({ file_key: fileKey })
    });
    rememberBotResponse(response);
    return response;
  }

  async replyLocalImages(messageId, imagePaths = []) {
    const sent = [];
    for (const imagePath of imagePaths) {
      const imageKey = await this.uploadImage(imagePath);
      await this.replyImage(messageId, imageKey);
      safeDeleteLocalFile(imagePath);
      sent.push({ imagePath, imageKey });
    }
    return sent;
  }

  async replyLocalVideos(messageId, videoPaths = []) {
    const sent = [];
    for (const videoPath of videoPaths) {
      const ext = path.extname(videoPath).toLowerCase();
      const fileKey = await this.uploadFile(videoPath, ext === ".mp4" ? "mp4" : "stream");
      if (ext === ".mp4") {
        const thumbnailPath = await createVideoThumbnail(videoPath);
        const thumbnailKey = await this.uploadImage(thumbnailPath);
        await this.replyMedia(messageId, fileKey, thumbnailKey);
        safeDeleteLocalFile(thumbnailPath);
        safeDeleteLocalFile(videoPath);
        sent.push({ videoPath, thumbnailPath, fileKey, type: "media" });
      } else {
        await this.replyFile(messageId, fileKey);
        safeDeleteLocalFile(videoPath);
        sent.push({ videoPath, fileKey, type: "file" });
      }
    }
    return sent;
  }

  async replyText(messageId, text) {
    if (!messageId) return;
    let lastResponse = null;
    for (const chunk of splitReply(sanitizeFeishuText(text), config.maxReplyChars)) {
      lastResponse = await this.post(`/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reply`, {
        msg_type: "text",
        content: JSON.stringify({ text: chunk })
      });
      rememberBotResponse(lastResponse);
    }
    return lastResponse;
  }

  async replyPost(messageId, text, title = "OpenAI 回复") {
    if (!messageId) return;
    let lastResponse = null;
    for (const chunk of splitReply(sanitizeFeishuText(text), config.maxReplyChars)) {
      lastResponse = await this.post(`/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reply`, {
        msg_type: "post",
        content: JSON.stringify(buildFeishuPostContent(chunk, title))
      });
      rememberBotResponse(lastResponse);
    }
    return lastResponse;
  }

  async replyRich(messageId, text, title = "OpenAI 回复") {
    if (!messageId) return;
    const chunks = splitForCard(text);
    let lastResponse = null;
    for (let index = 0; index < chunks.length; index += 1) {
      lastResponse = await this.post(`/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reply`, {
        msg_type: "interactive",
        content: JSON.stringify(buildFeishuCard(chunks[index], title, {
          webSearch: /联网|检索|搜索/i.test(title),
          part: index + 1,
          total: chunks.length
        }))
      });
      rememberBotResponse(lastResponse);
    }
    return lastResponse;
  }

  async createCardEntity(cardJson) {
    const data = await this.post("/open-apis/cardkit/v1/cards", {
      type: "card_json",
      data: JSON.stringify(cardJson)
    });
    const cardId = data?.data?.card_id || data?.card_id || "";
    if (!cardId) throw new Error(`Feishu CardKit did not return card_id: ${JSON.stringify(data).slice(0, 500)}`);
    return cardId;
  }

  async replyCardEntity(messageId, cardId) {
    if (!messageId || !cardId) return null;
    const response = await this.post(`/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reply`, {
      msg_type: "interactive",
      content: JSON.stringify({
        type: "card",
        data: { card_id: cardId }
      })
    });
    rememberBotResponse(response);
    return response;
  }

  async replyStreamingCard(messageId, initialText, title = "OpenAI 回复", options = {}) {
    const cardId = await this.createCardEntity(buildStreamingCard(initialText, title, options));
    const response = await this.replyCardEntity(messageId, cardId);
    return { cardId, response };
  }

  async streamCardText(cardId, elementId, content, sequence) {
    return this.post(`/open-apis/cardkit/v1/cards/${encodeURIComponent(cardId)}/elements/${encodeURIComponent(elementId)}/content`, {
      uuid: crypto.randomUUID(),
      content,
      sequence
    }, "PUT");
  }

  async updateCardSettings(cardId, settings, sequence) {
    return this.post(`/open-apis/cardkit/v1/cards/${encodeURIComponent(cardId)}/settings`, {
      settings: JSON.stringify(settings),
      uuid: crypto.randomUUID(),
      sequence
    }, "PATCH");
  }

  async updateCard(cardId, cardJson, sequence) {
    return this.post(`/open-apis/cardkit/v1/cards/${encodeURIComponent(cardId)}`, {
      card: {
        type: "card_json",
        data: JSON.stringify(cardJson)
      },
      uuid: crypto.randomUUID(),
      sequence
    }, "PUT");
  }

  async addCardElements(cardId, elements, { type = "insert_after", targetElementId = STREAM_ANSWER_ELEMENT_ID, sequence } = {}) {
    return this.post(`/open-apis/cardkit/v1/cards/${encodeURIComponent(cardId)}/elements`, {
      type,
      target_element_id: targetElementId,
      uuid: crypto.randomUUID(),
      sequence,
      elements: JSON.stringify(elements)
    });
  }

  async patchCard(messageId, text, title = "OpenAI 回复", options = {}) {
    if (!messageId) return;
    return this.post(`/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`, {
      content: JSON.stringify(buildFeishuCard(text, title, options))
    }, "PATCH");
  }
}

function feishuMessageId(response = {}) {
  return responseMessageId(response);
}

function splitReply(text, maxChars) {
  const clean = sanitizeFeishuText(text);
  if (clean.length <= maxChars) return [clean];
  const chunks = [];
  let rest = clean;
  while (rest.length > maxChars) {
    let index = rest.lastIndexOf("\n", maxChars);
    if (index < Math.floor(maxChars * 0.5)) index = maxChars;
    chunks.push(rest.slice(0, index).trim());
    rest = rest.slice(index).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

function researchNoteTitle(prompt = "", fallback = "OpenAI research note") {
  const first = String(prompt || "").split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  return (first || fallback || "OpenAI research note").slice(0, 80);
}

function buildResearchMarkdown({ title, prompt, answer, quotedContext, messageId }) {
  const quotedText = String(quotedContext?.text || "").trim();
  return [
    "---",
    "source_type: openai_feishu_research_bot",
    `generated_at: ${new Date().toISOString()}`,
    `model: ${config.gpt55Model}`,
    `web_search_enabled: ${config.gpt55WebSearchEnabled ? "true" : "false"}`,
    `feishu_message_id: ${messageId || ""}`,
    "tags:",
    "  - investment-research",
    "  - openai",
    "---",
    "",
    `# ${title}`,
    "",
    "## User Request",
    String(prompt || "").trim(),
    "",
    quotedText ? `## Quoted Context\n${quotedText}` : "",
    "",
    "## Research Output",
    String(answer || "").trim()
  ].filter(Boolean).join("\n").trim() + "\n";
}

async function maybeCreateWikiDocument(title, markdown) {
  if (!config.feishuResearchParentWikiToken) return { created: false, reason: "missing_parent_wiki_token" };
  return feishu.createWikiDocument({
    parentWikiToken: config.feishuResearchParentWikiToken,
    title,
    markdown
  });
}

async function maybeSyncObsidian(title, markdown) {
  if (!config.obsidianSyncEnabled) return { synced: false, reason: "disabled" };
  if (!obsidianSync.enabled) return { synced: false, reason: "missing_github_config" };
  const date = new Date().toISOString().slice(0, 10);
  const slug = slugify(title).slice(0, 80) || "research";
  const notePath = `${config.obsidianFolder}/${date}-${slug}.md`;
  const indexPath = `${config.obsidianFolder}/index.md`;
  await obsidianSync.putFile(notePath, markdown, `Add OpenAI research note: ${title.slice(0, 60)}`);
  await obsidianSync.appendUnique(indexPath, `- ${date} [[${notePath.replace(/\.md$/i, "")}|${title}]]`, "Index OpenAI research note");
  return { synced: true, path: notePath, repo: config.obsidianGithubRepo, branch: config.obsidianGithubBranch };
}

function obsidianIndexPaths(indexContent = "") {
  const paths = [];
  for (const match of String(indexContent || "").matchAll(/\[\[([^|\]]+)(?:\|[^\]]+)?\]\]/g)) {
    const pathValue = match[1].trim();
    if (pathValue) paths.push(pathValue.endsWith(".md") ? pathValue : `${pathValue}.md`);
  }
  return unique(paths);
}

function memoryScore(content = "", terms = []) {
  const lower = String(content || "").toLowerCase();
  return terms.reduce((score, term) => score + (lower.includes(term) ? 1 : 0), 0);
}

function noteTitleFromMarkdown(markdown = "", fallback = "") {
  return String(markdown || "").match(/^#\s+(.+)$/m)?.[1]?.trim().slice(0, 100) || fallback;
}

async function recallObsidianMemory(query = "", limit = config.memoryRecallLimit) {
  if (!config.obsidianSyncEnabled || !obsidianSync.enabled) return [];
  const terms = splitTerms(query);
  if (!terms.length) return [];
  const indexPath = `${config.obsidianFolder}/index.md`;
  const indexFile = await obsidianSync.getFile(indexPath).catch(() => ({ content: "" }));
  const indexedPaths = obsidianIndexPaths(indexFile.content).slice(-80).reverse();
  const sharedFiles = await obsidianSync.listMarkdownFiles().catch(async () => {
    const files = await obsidianSync.listFiles(config.obsidianFolder);
    return files.map((item) => ({ path: `${config.obsidianFolder}/${item.name}` }));
  });
  const sharedPaths = sharedFiles
    .map((item) => item.path)
    .filter((item) => /\.md$/i.test(item) && !/(^|\/)index\.md$/i.test(item));
  const paths = unique([...indexedPaths, ...sharedPaths.reverse()]).slice(0, 160);
  const notes = [];
  for (const notePath of paths.slice(0, 120)) {
    const file = await obsidianSync.getFile(notePath).catch(() => null);
    const content = file?.content || "";
    if (!content) continue;
    const score = memoryScore(content, terms);
    if (score <= 0) continue;
    notes.push({
      path: notePath,
      title: noteTitleFromMarkdown(content, notePath),
      score,
      preview: content.slice(0, 1800)
    });
  }
  return notes
    .sort((a, b) => b.score - a.score || String(b.path).localeCompare(String(a.path)))
    .slice(0, Math.max(1, Number(limit) || 5));
}

function buildSyncFooter(doc, obsidianResult) {
  const lines = [];
  if (doc?.url) lines.push(`Feishu Wiki: ${doc.url}`);
  if (obsidianResult?.path) lines.push(`Obsidian: ${obsidianResult.path}`);
  return lines.length ? lines.join("\n") : "";
}

async function syncResearchArtifacts({ prompt, answer, title, quotedContext, messageId, job }) {
  const markdown = buildResearchMarkdown({ title, prompt, answer, quotedContext, messageId });
  const doc = await maybeCreateWikiDocument(title, markdown).catch((error) => {
    if (job) job.wikiError = error.message;
    console.warn(`Feishu Wiki sync failed: ${error.message}`);
    return null;
  });
  const obsidianResult = await maybeSyncObsidian(title, markdown).catch((error) => {
    if (job) job.obsidianError = error.message;
    console.warn(`Obsidian sync failed: ${error.message}`);
    return null;
  });
  if (job) {
    job.feishuDocUrl = doc?.url || "";
    job.obsidianPath = obsidianResult?.path || "";
  }
  return { doc, obsidianResult, footer: buildSyncFooter(doc, obsidianResult) };
}

function appendSyncFooter(answer, syncResult) {
  const footer = String(syncResult?.footer || "").trim();
  return footer ? `${String(answer || "").trim()}\n\n---\n${footer}` : String(answer || "");
}

function decryptIfNeeded(payload) {
  if (!payload?.encrypt) return payload;
  if (!config.feishuEncryptKey) {
    throw new Error("Received encrypted Feishu event, but FEISHU_ENCRYPT_KEY is not configured.");
  }
  const key = crypto.createHash("sha256").update(config.feishuEncryptKey).digest();
  const encrypted = Buffer.from(payload.encrypt, "base64");
  const iv = encrypted.subarray(0, 16);
  const data = encrypted.subarray(16);
  const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
  return JSON.parse(Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8"));
}

function handleUrlVerification(payload) {
  if (payload?.type !== "url_verification") return null;
  if (config.feishuVerificationToken && payload.token !== config.feishuVerificationToken) {
    throw new Error("Invalid Feishu URL verification token.");
  }
  return { challenge: payload.challenge };
}

function validFeishuToken(payload) {
  if (!config.feishuVerificationToken) return true;
  return payload?.header?.token === config.feishuVerificationToken || payload?.token === config.feishuVerificationToken;
}

const app = express();
const feishu = new FeishuClient();
const obsidianSync = new GitHubFileSync({
  token: config.obsidianGithubToken,
  repo: config.obsidianGithubRepo,
  branch: config.obsidianGithubBranch
});
const seenMessageIds = new Map();
const jobs = new Map();
let latestPrivateMessage = null;

if (config.grokStateSyncEnabled) {
  try {
    const restored = await restoreGrokStateFromStore();
    if (restored.restored) {
      lastObservedGrokStateHash = currentGrokStateHash();
      console.log(`OpenAI state restored from ${restored.source || "state store"}: ${restored.restoredFiles} files.`);
    } else {
      console.log(`OpenAI state restore skipped: ${restored.reason}.`);
    }
  } catch (error) {
    console.warn(`OpenAI state restore failed: ${error.message}`);
  }
}

app.use(express.json({ limit: "2mb" }));
app.set("trust proxy", true);

app.get("/", (_req, res) => {
  res.json({ ok: true, service: config.serviceName, health: "/health", feishuEvents: "/feishu/events" });
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: config.serviceName,
    startedAt: STARTED_AT.toISOString(),
    uptimeSeconds: Math.round(process.uptime()),
    cwd: process.cwd(),
    feishuConfigured: feishu.enabled,
    wikiConfigured: Boolean(config.feishuResearchParentWikiToken),
    obsidianConfigured: Boolean(config.obsidianSyncEnabled && obsidianSync.enabled),
    grokCliEnabled: config.grokCliEnabled,
    gpt55Configured: Boolean(config.gpt55BaseUrl && config.gpt55ApiKey && config.gpt55Model),
    gpt55WebSearchEnabled: config.gpt55WebSearchEnabled,
    gptImageConfigured: Boolean(config.gpt55BaseUrl && config.gpt55ApiKey && config.gptImageModel),
    gptImageModel: config.gptImageModel,
    gptImageSize: config.gptImageSize,
    gptImageQuality: config.gptImageQuality,
    grokCliCwd: config.grokCliCwd,
    grokCliCommand: config.grokCliCommand,
    grokCliCommandExists: config.grokCliCommand.includes(path.sep) ? fs.existsSync(config.grokCliCommand) : null,
    grokCliCommandExecutable: config.grokCliCommand.includes(path.sep) ? isExecutable(config.grokCliCommand) : null,
    model: config.gpt55Model,
    videoModel: config.videoModel,
    videoMaxTurns: config.videoMaxTurns,
    grokMemoryEnabled: config.grokMemoryEnabled,
    grokStateSyncEnabled: config.grokStateSyncEnabled,
    sessionHistoryTurns: config.sessionHistoryTurns,
    memoryRecallLimit: config.memoryRecallLimit,
    memorySyncMode: "explicit-field:同步记忆库",
    memoryRecallMode: "explicit-field:调取记忆库",
    webSearchForceMode: "explicit-field:搜索",
    cardMode: "feishu-cardkit-streaming-json-2.0",
    webSearchMode: config.gpt55WebSearchEnabled ? "gpt55-responses-web-search" : "gpt55-responses"
  });
});

app.get("/debug/grok-config", (req, res) => {
  if (!config.debugToken || req.get("x-debug-token") !== config.debugToken) {
    res.status(404).json({ error: "not found" });
    return;
  }
  res.json({
    ok: true,
    mediaMaxTurns: config.mediaMaxTurns,
    videoMaxTurns: config.videoMaxTurns,
    videoModel: config.videoModel,
    grokMemoryEnabled: config.grokMemoryEnabled,
    grokStateSyncEnabled: config.grokStateSyncEnabled,
    configuredArgs: grokCliArgs("{{prompt}}"),
    mediaConfiguredArgs: grokCliArgs("{{prompt}}", { maxTurns: config.mediaMaxTurns }),
    videoConfiguredArgs: grokCliArgs("{{prompt}}", { maxTurns: config.videoMaxTurns, model: config.videoModel })
  });
});

app.get("/debug/grok-state-status", async (req, res) => {
  if (!config.debugToken || req.get("x-debug-token") !== config.debugToken) {
    res.status(404).json({ error: "not found" });
    return;
  }
  try {
    res.json({ ok: true, state: await grokStateStoreStatus() });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get("/debug/grok-state-inventory", async (req, res) => {
  if (!config.debugToken || req.get("x-debug-token") !== config.debugToken) {
    res.status(404).json({ error: "not found" });
    return;
  }
  try {
    res.json({
      ok: true,
      state: await grokStateStoreStatus(),
      inventory: grokStateInventory()
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post("/debug/grok-state-sync", async (req, res) => {
  if (!config.debugToken || req.get("x-debug-token") !== config.debugToken) {
    res.status(404).json({ error: "not found" });
    return;
  }
  try {
    const result = await saveGrokStateToStore();
    if (result.saved) lastObservedGrokStateHash = currentGrokStateHash();
    res.json({ ok: true, result });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get("/debug/classify", (req, res) => {
  if (!config.debugToken || req.get("x-debug-token") !== config.debugToken) {
    res.status(404).json({ error: "not found" });
    return;
  }
  const prompt = String(req.query.prompt || "").slice(0, 1000);
  const control = parseControlCommand(prompt);
  if (control) {
    res.json({
      ok: true,
      input: prompt,
      controlCommand: control.name,
      interceptedBeforeGrok: true
    });
    return;
  }
  const task = classifyTask(prompt);
  res.json({
    ok: true,
    input: prompt,
    routedPrompt: task.prompt || prompt,
    kind: task.kind,
    title: task.title,
    webSearch: task.webSearch,
    mediaTask: task.mediaTask,
    maxTurns: task.maxTurns
  });
});

app.get("/debug/grok-auth-status", async (req, res) => {
  if (!config.debugToken || req.get("x-debug-token") !== config.debugToken) {
    res.status(404).json({ error: "not found" });
    return;
  }
  try {
    res.json({ ok: true, auth: await authStoreStatus() });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get("/debug/jobs", (req, res) => {
  if (!config.debugToken || req.get("x-debug-token") !== config.debugToken) {
    res.status(404).json({ error: "not found" });
    return;
  }
  res.json({ jobs: [...jobs.values()].slice(-50) });
});

app.get("/debug/route-decisions", (req, res) => {
  if (!config.debugToken || req.get("x-debug-token") !== config.debugToken) {
    res.status(404).json({ error: "not found" });
    return;
  }
  res.json({ ok: true, decisions: routeDecisions.slice(-80) });
});

app.get("/debug/grok-test", async (req, res) => {
  if (!config.debugToken || req.get("x-debug-token") !== config.debugToken) {
    res.status(404).json({ error: "not found" });
    return;
  }
  try {
    const prompt = String(req.query.prompt || `用一句中文回答：${activeModelLabel()} Responses 联网桥已经可以运行。`).slice(0, 1000);
    const answer = await callGrokCli(prompt, { memoryEnabled: false });
    res.json({ ok: true, model: config.gpt55Model, webSearchEnabled: config.gpt55WebSearchEnabled, answer: answer.slice(0, 4000) });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post("/debug/gpt-image-test", async (req, res) => {
  if (!config.debugToken || req.get("x-debug-token") !== config.debugToken) {
    res.status(404).json({ error: "not found" });
    return;
  }
  let imagePath = "";
  try {
    const prompt = String(req.body?.prompt || "A minimal blue circle on a clean white background.").slice(0, 1000);
    const uploadToFeishu = Boolean(req.body?.upload_to_feishu);
    const generated = await callGptImageGeneration(prompt);
    imagePath = generated.imagePath;
    const bytes = fs.statSync(imagePath).size;
    const imageKey = uploadToFeishu ? await feishu.uploadImage(imagePath) : "";
    res.json({
      ok: true,
      model: config.gptImageModel,
      size: config.gptImageSize,
      quality: config.gptImageQuality,
      bytes,
      revisedPrompt: Boolean(generated.revisedPrompt),
      uploadedToFeishu: Boolean(imageKey),
      sentToChat: false
    });
  } catch (error) {
    res.status(/timed out|abort/i.test(error.message) ? 504 : 500).json({ ok: false, error: error.message });
  } finally {
    safeDeleteLocalFile(imagePath);
  }
});

app.get("/debug/grok-probe", async (req, res) => {
  if (!config.debugToken || req.get("x-debug-token") !== config.debugToken) {
    res.status(404).json({ error: "not found" });
    return;
  }
  try {
    const prompt = String(req.query.prompt || "用一句中文回答：probe").slice(0, 500);
    const timeoutMs = Math.min(envNumber("DEBUG_PROBE_TIMEOUT_MS", 60000), 90000);
    const result = await probeGrokCli(prompt, timeoutMs);
    res.status(result.ok ? 200 : 504).json(result);
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get("/debug/grok-tui-probe", async (req, res) => {
  if (!config.debugToken || req.get("x-debug-token") !== config.debugToken) {
    res.status(404).json({ error: "not found" });
    return;
  }
  try {
    const input = String(req.query.input || "/help").slice(0, 500);
    const timeoutMs = Math.min(Number(req.query.timeoutMs || 12000) || 12000, 30000);
    const result = await probeGrokTui(input, timeoutMs);
    res.status(result.ok ? 200 : 504).json(result);
  } catch (error) {
    res.status(/timed out/i.test(error.message) ? 504 : 500).json({ ok: false, error: error.message });
  }
});

app.get("/debug/grok-diagnostics", async (req, res) => {
  if (!config.debugToken || req.get("x-debug-token") !== config.debugToken) {
    res.status(404).json({ error: "not found" });
    return;
  }
  try {
    res.json({ ok: true, diagnostics: await grokDiagnostics() });
  } catch (error) {
    res.status(500).json({ ok: false, error: redactSensitive(error.message) });
  }
});

app.get("/debug/cardkit-test", async (req, res) => {
  if (!config.debugToken || req.get("x-debug-token") !== config.debugToken) {
    res.status(404).json({ error: "not found" });
    return;
  }
  try {
    const cardId = await feishu.createCardEntity(buildStreamingCard("", "CardKit 流式协议自检", {
      webSearch: true,
      status: "服务端自检：创建卡片实体"
    }));
    await feishu.streamCardText(cardId, STREAM_ANSWER_ELEMENT_ID, " CardKit 流式文本接口自检通过。", 1);
    await feishu.updateCardSettings(cardId, {
      config: {
        streaming_mode: false,
        summary: { content: "CardKit 自检通过" }
      }
    }, 2);
    res.json({ ok: true, cardId, cardMode: "cardkit-json-2.0-streaming" });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get("/debug/card-style-test", async (req, res) => {
  if (!config.debugToken || req.get("x-debug-token") !== config.debugToken) {
    res.status(404).json({ error: "not found" });
    return;
  }
  if (!latestPrivateMessage?.messageId) {
    res.status(409).json({
      ok: false,
      error: "No recent private Feishu message target. Send the bot a private message first, then retry this endpoint."
    });
    return;
  }

  const requested = String(req.query.templates || req.query.template || "grey")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const templates = (requested.includes("all") ? [...CARD_HEADER_TEMPLATES] : requested)
    .filter((item, index, list) => CARD_HEADER_TEMPLATES.has(item) && list.indexOf(item) === index)
    .slice(0, 13);
  if (!templates.length) {
    res.status(400).json({ ok: false, error: `Unsupported template. Allowed: ${[...CARD_HEADER_TEMPLATES].join(", ")}` });
    return;
  }

  try {
    const sent = [];
    for (const template of templates) {
      const cardId = await feishu.createCardEntity(buildFinalCard(
        [
          `Header template: ${template}`,
          "",
          "This is a real Feishu mobile preview card. Compare this header color on iPhone and desktop.",
          "",
          "No OpenAI request was executed."
        ].join("\n"),
        `OpenAI ${template}`,
        { headerTemplate: template }
      ));
      const response = await feishu.replyCardEntity(latestPrivateMessage.messageId, cardId);
      sent.push({
        template,
        cardId,
        replyMessageId: feishuMessageId(response)
      });
    }
    res.json({
      ok: true,
      sentTo: {
        messageId: latestPrivateMessage.messageId,
        chatType: latestPrivateMessage.chatType,
        receivedAt: latestPrivateMessage.receivedAt
      },
      sent
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get("/debug/card-tag-style-test", async (req, res) => {
  if (!config.debugToken || req.get("x-debug-token") !== config.debugToken) {
    res.status(404).json({ error: "not found" });
    return;
  }
  if (!latestPrivateMessage?.messageId) {
    res.status(409).json({
      ok: false,
      error: "No recent private Feishu message target. Send the bot a private message first, then retry this endpoint."
    });
    return;
  }

  const requested = String(req.query.colors || req.query.color || "grey")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const colors = (requested.includes("all") ? [...CARD_TEXT_TAG_COLORS] : requested)
    .filter((item, index, list) => CARD_TEXT_TAG_COLORS.has(item) && list.indexOf(item) === index)
    .slice(0, CARD_TEXT_TAG_COLORS.size);
  if (!colors.length) {
    res.status(400).json({ ok: false, error: `Unsupported color. Allowed: ${[...CARD_TEXT_TAG_COLORS].join(", ")}` });
    return;
  }

  const sent = [];
  const failed = [];
  for (const color of colors) {
    try {
      const cardId = await feishu.createCardEntity(buildFinalCard(
        [
          `Mode tag color: ${color}`,
          "",
          "Header template is fixed to grey. Only the mode tag color changes.",
          "",
          "Compare the small mode tag next to the title on iPhone and desktop."
        ].join("\n"),
        `OpenAI tag ${color}`,
        { headerTemplate: "grey", modeTagColor: color }
      ));
      const response = await feishu.replyCardEntity(latestPrivateMessage.messageId, cardId);
      sent.push({
        color,
        cardId,
        replyMessageId: feishuMessageId(response)
      });
      await new Promise((resolve) => setTimeout(resolve, 250));
    } catch (error) {
      failed.push({ color, error: error.message });
    }
  }

  res.json({
    ok: failed.length === 0,
    sentTo: {
      messageId: latestPrivateMessage.messageId,
      chatType: latestPrivateMessage.chatType,
      receivedAt: latestPrivateMessage.receivedAt
    },
    sent,
    failed
  });
});

app.get("/debug/source-button-test", async (req, res) => {
  if (!config.debugToken || req.get("x-debug-token") !== config.debugToken) {
    res.status(404).json({ error: "not found" });
    return;
  }
  if (!latestPrivateMessage?.messageId) {
    res.status(409).json({
      ok: false,
      error: "No recent private Feishu message target. Send the bot a private message first, then retry this endpoint."
    });
    return;
  }

  const sample = [
    "示例来源按钮：",
    "",
    "[Stanford AI Index 2026](https://aiindex.stanford.edu/report/)",
    "[McKinsey 2025](https://www.mckinsey.com/capabilities/quantumblack/our-insights)",
    "[Deloitte 2026](https://www.deloitte.com/us/en/insights.html)",
    "https://www.idc.com/getdoc.jsp?containerId=prUS00000000"
  ].join("\n");

  try {
    const cardId = await feishu.createCardEntity(buildFinalCard(sample, "OpenAI 来源按钮测试", { webSearch: true }));
    const response = await feishu.replyCardEntity(latestPrivateMessage.messageId, cardId);
    res.json({
      ok: true,
      cardId,
      replyMessageId: feishuMessageId(response),
      labels: sourceButtonsV2(sample).map((button) => button.text?.content || "")
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get("/debug/media-upload-test", async (req, res) => {
  if (!config.debugToken || req.get("x-debug-token") !== config.debugToken) {
    res.status(404).json({ error: "not found" });
    return;
  }
  try {
    const imageKey = await feishu.uploadImage(ensureVideoThumbnail());
    res.json({
      ok: true,
      uploaded: true,
      imageKeyPrefix: imageKey.slice(0, 8),
      sentToChat: false
    });
  } catch (error) {
    res.status(/timed out/i.test(error.message) ? 504 : 500).json({ ok: false, error: error.message });
  }
});

app.get("/debug/grok-media-test", async (req, res) => {
  if (!config.debugToken || req.get("x-debug-token") !== config.debugToken) {
    res.status(404).json({ error: "not found" });
    return;
  }
  try {
    const prompt = String(req.query.prompt || "生成图片：一张简单的蓝色圆形测试图。必须返回真实图片文件路径，不要只描述。").slice(0, 500);
    const timeoutMs = Math.min(Math.max(Number(req.query.timeoutMs || 180000) || 180000, 60000), 240000);
    const task = classifyTask(prompt);
    const grokPrompt = task.prompt || prompt;
    const answer = task.kind === "video"
      ? await callGrokImagineVideo(grokPrompt, { maxTurns: task.maxTurns, mediaTask: true, taskRules: task.rules, timeoutMs, memoryEnabled: false })
      : await callGrokCli(grokPrompt, { maxTurns: task.maxTurns || config.mediaMaxTurns, mediaTask: true, taskRules: task.rules, timeoutMs, memoryEnabled: false });
    const imagePaths = extractLocalImagePaths(answer);
    const videoPaths = extractLocalVideoPaths(answer);
    const uploadedImages = [];
    const uploadedVideos = [];
    for (const imagePath of imagePaths) {
      const imageKey = await feishu.uploadImage(imagePath);
      uploadedImages.push({ name: path.basename(imagePath), imageKeyPrefix: imageKey.slice(0, 8) });
    }
    for (const videoPath of videoPaths) {
      const fileKey = await feishu.uploadFile(videoPath, path.extname(videoPath).toLowerCase() === ".mp4" ? "mp4" : "stream");
      let thumbnail = null;
      if (path.extname(videoPath).toLowerCase() === ".mp4") {
        const thumbnailPath = await createVideoThumbnail(videoPath);
        const imageKey = await feishu.uploadImage(thumbnailPath);
        thumbnail = {
          name: path.basename(thumbnailPath),
          pathPreview: mediaPathPreview(thumbnailPath),
          imageKeyPrefix: imageKey.slice(0, 8)
        };
        safeDeleteLocalFile(thumbnailPath);
      }
      uploadedVideos.push({
        name: path.basename(videoPath),
        pathPreview: mediaPathPreview(videoPath),
        fileKeyPrefix: fileKey.slice(0, 8),
        thumbnail
      });
    }
    res.json({
      ok: true,
      sentToChat: false,
      textPreview: stripLocalMediaPaths(answer).slice(0, 300),
      taskKind: task.kind,
      timeoutMs,
      foundImages: imagePaths.length,
      foundVideos: videoPaths.length,
      uploadedImages,
      uploadedVideos
    });
  } catch (error) {
    res.status(/timed out/i.test(error.message) ? 504 : 500).json({ ok: false, error: error.message });
  }
});

app.get("/debug/grok-media-job", (req, res) => {
  if (!config.debugToken || req.get("x-debug-token") !== config.debugToken) {
    res.status(404).json({ error: "not found" });
    return;
  }
  const prompt = String(req.query.prompt || "生成视频：2-second minimal MP4 test video: blue sky with one slow white cloud. Use OpenAI Build official video generation and return the saved local MP4 path.").slice(0, 500);
  const timeoutMs = Math.min(Math.max(Number(req.query.timeoutMs || 180000) || 180000, 30000), 300000);
  const jobId = `debug-media-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  const task = classifyTask(prompt);
  const job = {
    id: jobId,
    debug: true,
    sentToChat: false,
    status: "running",
    promptPreview: prompt.slice(0, 120),
    taskKind: task.kind,
    timeoutMs,
    startedAt: new Date().toISOString()
  };
  jobs.set(jobId, job);
  res.json({ ok: true, jobId, status: job.status, taskKind: job.taskKind, timeoutMs, sentToChat: false, poll: `/debug/grok-media-job/${jobId}` });

  (async () => {
    try {
      const grokPrompt = task.prompt || prompt;
      const answer = task.kind === "video"
        ? await callGrokImagineVideo(grokPrompt, { maxTurns: task.maxTurns, mediaTask: true, taskRules: task.rules, timeoutMs, memoryEnabled: false })
        : await callGrokCli(grokPrompt, { maxTurns: task.maxTurns || config.mediaMaxTurns, mediaTask: true, taskRules: task.rules, timeoutMs, memoryEnabled: false });
      const imagePaths = extractLocalImagePaths(answer);
      const videoPaths = extractLocalVideoPaths(answer);
      const uploadedImages = [];
      const uploadedVideos = [];
      for (const imagePath of imagePaths) {
        const imageKey = await feishu.uploadImage(imagePath);
        uploadedImages.push({ name: path.basename(imagePath), imageKeyPrefix: imageKey.slice(0, 8) });
      }
      for (const videoPath of videoPaths) {
        const fileKey = await feishu.uploadFile(videoPath, path.extname(videoPath).toLowerCase() === ".mp4" ? "mp4" : "stream");
        let thumbnail = null;
        if (path.extname(videoPath).toLowerCase() === ".mp4") {
          const thumbnailPath = await createVideoThumbnail(videoPath);
          const imageKey = await feishu.uploadImage(thumbnailPath);
          thumbnail = {
            name: path.basename(thumbnailPath),
            pathPreview: mediaPathPreview(thumbnailPath),
            imageKeyPrefix: imageKey.slice(0, 8)
          };
          safeDeleteLocalFile(thumbnailPath);
        }
        uploadedVideos.push({
          name: path.basename(videoPath),
          pathPreview: mediaPathPreview(videoPath),
          fileKeyPrefix: fileKey.slice(0, 8),
          thumbnail
        });
      }
      Object.assign(job, {
        status: "completed",
        completedAt: new Date().toISOString(),
        textPreview: stripLocalMediaPaths(answer).slice(0, 500),
        foundImages: imagePaths.length,
        foundVideos: videoPaths.length,
        uploadedImages,
        uploadedVideos
      });
    } catch (error) {
      Object.assign(job, {
        status: "failed",
        completedAt: new Date().toISOString(),
        error: error.message
      });
    }
  })();
});

app.get("/debug/grok-media-job/:id", (req, res) => {
  if (!config.debugToken || req.get("x-debug-token") !== config.debugToken) {
    res.status(404).json({ error: "not found" });
    return;
  }
  const job = jobs.get(req.params.id);
  if (!job) {
    res.status(404).json({ ok: false, error: "job not found" });
    return;
  }
  res.json({ ok: true, job });
});

app.post("/feishu/events", async (req, res) => {
  let payload;
  try {
    payload = decryptIfNeeded(req.body || {});
    const verification = handleUrlVerification(payload);
    if (verification) {
      res.json(verification);
      return;
    }
    if (!validFeishuToken(payload)) {
      res.status(403).json({ error: "Invalid Feishu verification token." });
      return;
    }
  } catch (error) {
    res.status(400).json({ error: error.message });
    return;
  }

  const eventType = payload?.header?.event_type || payload?.type || "";
  if (eventType !== "im.message.receive_v1") {
    res.json({});
    return;
  }

  const message = payload?.event?.message || {};
  const messageId = message.message_id || "";
  if (!messageId || seenMessageIds.has(messageId)) {
    res.json({});
    return;
  }
  seenMessageIds.set(messageId, Date.now());
  for (const [id, ts] of seenMessageIds) {
    if (Date.now() - ts > 30 * 60 * 1000) seenMessageIds.delete(id);
  }

  res.json({});
  processFeishuMessage(payload).catch((error) => {
    console.error("Feishu background job failed:", error.message);
  });
});

async function processFeishuMessage(payload) {
  const event = payload.event || {};
  const senderType = event.sender?.sender_type || "";
  if (senderType === "app") return;
  const message = event.message || {};
  const messageId = message.message_id || "";
  const directPrompt = extractMessageText(message);
  const mentions = messageMentions(message);
  const control = parseControlCommand(directPrompt);
  const route = await shouldHandleFeishuMessage(message);
  const baseRouteLog = {
    messageId: idPrefix(messageId),
    chatType: message.chat_type || "",
    senderType: event.sender?.sender_type || "",
    mentionCount: mentions.length,
    mentionNames: mentions.map((item) => String(item.name || "").slice(0, 30)).filter(Boolean).slice(0, 6),
    quotedMessageId: idPrefix(quotedMessageId(message)),
    controlCommand: control?.name || "",
    routeReason: route.reason || "",
    routeHandle: Boolean(route.handle),
    directPromptEmpty: !directPrompt
  };
  if (!route.handle) {
    pushRouteDecision({ ...baseRouteLog, ignored: true });
    return;
  }
  const session = chatSessionScope(message);
  let quotedContextPromise = null;
  const loadQuotedContext = () => {
    if (!quotedContextPromise) {
      quotedContextPromise = feishu.quotedContextFromMessage(message, {
        resolveStoredReplyText: (quotedMessageId) => readStoredReplyText(session, quotedMessageId)
      })
        .then((context) => ({ context }))
        .catch((error) => ({ error }));
    }
    return quotedContextPromise;
  };
  const initialDirectives = parseMemoryDirectives(directPrompt);
  let prompt = initialDirectives.cleaned;
  let memoryDirectives = {
    sync: initialDirectives.sync,
    recall: initialDirectives.recall,
    webSearch: initialDirectives.webSearch
  };
  let promptFromQuotedMessage = false;
  if (!prompt) {
    const quotedResult = await loadQuotedContext();
    if (quotedResult.error) {
      pushRouteDecision({ ...baseRouteLog, ignored: true, routeReason: "empty_prompt_quote_error", error: quotedResult.error.message });
      return;
    }
    const quotedDirectives = parseMemoryDirectives(String(quotedResult.context?.text || "").trim());
    const quotedText = quotedDirectives.cleaned;
    memoryDirectives = {
      sync: memoryDirectives.sync || quotedDirectives.sync,
      recall: memoryDirectives.recall || quotedDirectives.recall,
      webSearch: memoryDirectives.webSearch || quotedDirectives.webSearch
    };
    const quotedFileCount = quotedResult.context?.files?.filter((item) => item.path).length || 0;
    if (quotedText) {
      prompt = quotedText;
      promptFromQuotedMessage = true;
    } else if (quotedFileCount > 0) {
      prompt = "The user mentioned OpenAI while replying to the quoted message. Use the quoted files and metadata as the user's input, then decide the task from that context.";
      promptFromQuotedMessage = true;
    }
  }
  if (!prompt) {
    pushRouteDecision({ ...baseRouteLog, ignored: true, routeReason: "empty_prompt" });
    return;
  }
  if (message.chat_type === "p2p") {
    latestPrivateMessage = {
      messageId,
      chatId: message.chat_id || "",
      chatType: message.chat_type,
      receivedAt: new Date().toISOString(),
      promptPreview: prompt.slice(0, 80)
    };
  }
  if (control) {
    if (message.chat_type !== "p2p") {
      pushRouteDecision({ ...baseRouteLog, ignored: true, routeReason: "group_control_command_blocked" });
      return;
    }
    const startedAtMs = Date.now();
    const job = {
      id: messageId,
      promptPreview: prompt.slice(0, 120),
      status: "completed",
      taskKind: "control",
      controlCommand: control.name,
      webSearch: false,
      mediaTask: false,
      startedAt: new Date(startedAtMs).toISOString(),
      completedAt: new Date().toISOString(),
      timings: {
        handledMs: Date.now() - startedAtMs
      }
    };
    jobs.set(messageId, job);
    if (control.name === "new") {
      const session = resetChatSessionScope(message);
      resetChatHistory(session);
      job.sessionId = session?.sessionId || "";
      job.previousSessionId = session?.previousSessionId || "";
      job.sessionScope = session?.scopeKey || "";
      await syncGrokStateIfChanged("control-new-session").catch((error) => {
        console.warn(`OpenAI state Redis sync failed after control command: ${error.message}`);
      });
      await feishu.replyText(messageId, "New OpenAI CLI session created for this Feishu chat. Long-term memory is preserved.");
      pushRouteDecision({ ...baseRouteLog, ignored: false, routeReason: "p2p_control_new", promptFromQuotedMessage });
      return;
    }
    await feishu.replyText(messageId, "Bridge control command received, but this command is not enabled. No OpenAI request was sent.");
    pushRouteDecision({ ...baseRouteLog, ignored: false, routeReason: "p2p_control_unsupported", promptFromQuotedMessage });
    return;
  }
  pushRouteDecision({ ...baseRouteLog, ignored: false, promptFromQuotedMessage });
  const task = classifyTask(prompt, { forceWebSearch: memoryDirectives.webSearch });
  const grokPrompt = task.prompt || prompt;
  const startedAtMs = Date.now();
  loadQuotedContext();

  const job = {
    id: messageId,
    promptPreview: prompt.slice(0, 120),
    status: "running",
    taskKind: task.kind,
    webSearch: task.webSearch,
    mediaTask: task.mediaTask,
    memorySyncRequested: Boolean(memoryDirectives.sync),
    memoryRecallRequested: Boolean(memoryDirectives.recall),
    webSearchRequested: Boolean(memoryDirectives.webSearch),
    promptFromQuotedMessage,
    sessionId: session?.sessionId || "",
    sessionScope: session?.scopeKey || "",
    quotedMessageId: "",
    quotedFileCount: 0,
    quotedChain: [],
    startedAt: new Date(startedAtMs).toISOString(),
    timings: {
      classifiedMs: 0
    }
  };
  const markTiming = (name) => {
    job.timings[name] = Date.now() - startedAtMs;
  };
  jobs.set(messageId, job);

  const title = task.title;
  let updater = null;
  let quotedTempFiles = [];
  let quotedContext = null;
  try {
    try {
      const streamingCard = await feishu.replyStreamingCard(
        messageId,
        "",
        title,
        {
          webSearch: job.webSearch,
          status: task.kind === "model_info"
            ? "正在读取服务端运行模型配置"
            : task.kind === "image"
              ? `正在使用 ${config.gptImageModel} 生图`
            : job.webSearch
              ? `正在调用 ${activeModelLabel()} 联网搜索`
              : `正在调用 ${activeModelLabel()}`,
          memorySync: memoryDirectives.sync,
          memoryRecall: memoryDirectives.recall
        }
      );
      markTiming("streamingCardReadyMs");
      job.cardId = streamingCard.cardId;
      job.replyMessageId = feishuMessageId(streamingCard.response);
      updater = createCardKitStreamingUpdater({
        feishu,
        cardId: streamingCard.cardId,
        messageId,
        title,
        webSearch: job.webSearch,
        memorySync: memoryDirectives.sync,
        memoryRecall: memoryDirectives.recall
      });
    } catch (error) {
      job.cardKitError = error.message;
      console.warn(`CardKit streaming bootstrap failed, falling back to final rich card: ${error.message}`);
      updater = createPlainFinalUpdater({ feishu, messageId, title });
      markTiming("streamingCardFallbackMs");
    }
    const quotedResult = await quotedContextPromise;
    if (quotedResult.error) throw quotedResult.error;
    quotedContext = quotedResult.context;
    quotedTempFiles = quotedContext?.files?.map((item) => item.path).filter(Boolean) || [];
    job.quotedMessageId = quotedContext?.messageId || "";
    job.quotedFileCount = quotedContext?.files?.filter((item) => item.path).length || 0;
    job.quotedChain = quotedContext?.chain || [];
    if (job.quotedChain.length) {
      console.log("Feishu quoted context:", JSON.stringify({
        messageId: idPrefix(job.quotedMessageId),
        depth: job.quotedChain.length,
        sources: job.quotedChain.map((entry) => ({
          messageType: entry.messageType,
          textSource: entry.textSource,
          cardSchema: entry.cardSchema,
          hasText: Boolean(entry.textPreview),
          error: entry.error || ""
        }))
      }));
    }
    markTiming("quotedContextReadyMs");
    const conversationHistory = readChatHistory(session);
    job.sessionHistoryTurns = conversationHistory.length;
    const memoryItems = memoryDirectives.recall
      ? await recallObsidianMemory(prompt).catch((error) => {
          job.memoryRecallError = error.message;
          console.warn(`Memory recall failed: ${error.message}`);
          return [];
        })
      : [];
    job.memoryRecallCount = memoryItems.length;
    markTiming("memoryReadyMs");
    const grokOptions = {
      maxTurns: task.maxTurns,
      quotedContext,
      session,
      conversationHistory,
      memoryItems,
      mediaTask: task.mediaTask,
      taskRules: task.rules,
      onText: (fullText) => {
        if (job.timings.firstTextMs == null) markTiming("firstTextMs");
        updater.patchAnswer(stripLocalMediaPaths(fullText) || "媒体生成中，正在等待 OpenAI 返回真实文件。");
      },
      onEvent: (event) => {
        if (job.timings.firstEventMs == null) markTiming("firstEventMs");
        const status = describeGrokEvent(event);
        if (status) {
          job.lastEvent = event.type || "";
          updater.patchStatus(status);
        }
      }
    };
    let answer = "";
    let generatedImagePaths = [];
    if (task.kind === "image") {
      updater.patchStatus(`正在使用 ${config.gptImageModel} 生成图片`, true);
      markTiming("imageStartMs");
      const generated = await callGptImageGeneration(grokPrompt);
      generatedImagePaths = [generated.imagePath];
      answer = generated.revisedPrompt
        ? `已使用 ${config.gptImageModel} 生图。\n\n模型优化后的提示词：${generated.revisedPrompt}`
        : `已使用 ${config.gptImageModel} 生图。`;
      job.imageModel = config.gptImageModel;
      markTiming("imageDoneMs");
    } else {
      markTiming("grokStartMs");
      answer = task.kind === "model_info"
        ? runtimeModelReport()
        : task.kind === "video"
          ? await callGrokImagineVideo(grokPrompt, grokOptions)
          : await callGrokCli(grokPrompt, grokOptions);
      markTiming("grokDoneMs");
    }
    const imagePaths = generatedImagePaths.length ? generatedImagePaths : extractLocalImagePaths(answer);
    const videoPaths = extractLocalVideoPaths(answer);
    const answerWithoutMediaPaths = stripLocalMediaPaths(answer);
    appendChatHistory(session, {
      user: prompt,
      assistant: answerWithoutMediaPaths || answer,
      replyMessageId: job.replyMessageId
    });
    await syncGrokStateIfChanged("openai-chat-history").catch((error) => {
      job.stateSyncError = error.message;
      console.warn(`OpenAI chat history state sync failed: ${error.message}`);
    });
    const syncResult = memoryDirectives.sync
      ? await syncResearchArtifacts({
          prompt,
          answer: answerWithoutMediaPaths || answer,
          title: researchNoteTitle(prompt, title),
          quotedContext,
          messageId,
          job
        })
      : { footer: "" };
    const footerStatus = {
      memoryRecallOk: memoryDirectives.recall ? !job.memoryRecallError : null,
      memoryRecallCount: memoryItems.length,
      memorySyncOk: memoryDirectives.sync
        ? Boolean((syncResult?.doc?.url || syncResult?.obsidianResult?.path) && !job.wikiError && !job.obsidianError)
        : null,
      wikiSynced: Boolean(syncResult?.doc?.url),
      obsidianSynced: Boolean(syncResult?.obsidianResult?.path)
    };
    job.status = "completed";
    job.completedAt = new Date().toISOString();
    if (imagePaths.length || videoPaths.length) {
      await updater.patchAnswer(answerWithoutMediaPaths || "媒体已生成，正在上传到飞书。", true);
      const sentImages = await feishu.replyLocalImages(messageId, imagePaths);
      const sentVideos = await feishu.replyLocalVideos(messageId, videoPaths);
      job.imageCount = sentImages.length;
      job.videoCount = sentVideos.length;
      const sentSummary = [
        sentImages.length ? `${sentImages.length} 张图片` : "",
        sentVideos.length ? `${sentVideos.length} 个视频` : ""
      ].filter(Boolean).join("、");
      markTiming("mediaUploadDoneMs");
      const finalText = answerWithoutMediaPaths
        ? `${answerWithoutMediaPaths}\n\n已发送 ${sentSummary}。`
        : `媒体已生成，已发送 ${sentSummary}。`;
      await updater.patchAnswer(appendSyncFooter(finalText, syncResult), true);
    } else {
      await updater.patchAnswer(appendSyncFooter(answer, syncResult), true);
    }
    await updater.finish(footerStatus);
    markTiming("finalCardDoneMs");
  } catch (error) {
    job.status = "failed";
    job.error = error.message;
    job.completedAt = new Date().toISOString();
    markTiming("failedMs");
    const failure = [
      `这次没有拿到 ${activeModelLabel()} 的最终回答，但我不会停在“正在检索”。`,
      "",
      `原因：${error.message}`,
      "",
      "这不是正常答案，我会把它作为需要修复的运行错误暴露出来，而不是降级成普通文本。"
    ].join("\n");
    if (updater) {
      await updater.fail(failure);
    } else {
      await feishu.replyRich(messageId, failure, `${activeModelLabel()} 运行错误`);
    }
  } finally {
    safeDeleteLocalFiles(quotedTempFiles);
  }
}

app.listen(config.port, "0.0.0.0", () => {
  console.log(`${config.serviceName} listening on 0.0.0.0:${config.port}`);
  if (feishu.enabled) {
    feishu.tenantAccessToken()
      .then(() => console.log("Feishu tenant token prewarmed."))
      .catch((error) => console.warn(`Feishu tenant token prewarm failed: ${error.message}`));
  }
});
