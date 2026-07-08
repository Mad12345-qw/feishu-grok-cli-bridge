import crypto from "crypto";
import express from "express";
import pg from "pg";

const { Pool } = pg;

const STARTED_AT = new Date();
const MAX_REPLY_CHARS = numberEnv("MAX_REPLY_CHARS", 3500);
const MAX_MODEL_TOKENS = numberEnv("MODEL_MAX_TOKENS", 6000);
const MODEL_TIMEOUT_MS = numberEnv("MODEL_TIMEOUT_MS", 300000);
const SERVICE_NAME = process.env.SERVICE_NAME || "feishu-gpt55-research-bridge";

const config = {
  port: Number(process.env.PORT || 3000),
  feishuAppId: process.env.FEISHU_APP_ID || "",
  feishuAppSecret: process.env.FEISHU_APP_SECRET || "",
  feishuVerificationToken: process.env.FEISHU_VERIFICATION_TOKEN || "",
  feishuEncryptKey: process.env.FEISHU_ENCRYPT_KEY || "",
  feishuDocBaseUrl: process.env.FEISHU_DOC_BASE_URL || "https://www.feishu.cn",
  feishuAckReaction: process.env.FEISHU_ACK_REACTION || "OneSecond",
  feishuDoneReaction: process.env.FEISHU_DONE_REACTION || "",
  feishuResearchParentWikiToken:
    process.env.FEISHU_RESEARCH_REPORT_PARENT_WIKI_TOKEN ||
    process.env.FEISHU_INVESTMENT_REPORT_PARENT_WIKI_TOKEN ||
    "",
  mikotoBaseUrl: process.env.MIKOTO_BASE_URL || process.env.KIMI_BASE_URL || "",
  mikotoApiKey: process.env.MIKOTO_API_KEY || process.env.KIMI_API_KEY || "",
  mikotoModel: process.env.MIKOTO_MODEL || process.env.KIMI_MODEL || "gpt-5.5",
  mikotoWebSearchEnabled: parseBool(
    process.env.MIKOTO_WEB_SEARCH_ENABLED || process.env.KIMI_WEB_SEARCH_ENABLED,
    /kimi/i.test(process.env.MIKOTO_MODEL || process.env.KIMI_MODEL || "")
  ),
  databaseUrl: process.env.DATABASE_URL || "",
  dbSsl: parseBool(process.env.DB_SSL, false),
  obsidianSyncEnabled: parseBool(process.env.OBSIDIAN_SYNC_ENABLED, Boolean(process.env.OBSIDIAN_GITHUB_TOKEN || process.env.GITHUB_BACKUP_TOKEN)),
  obsidianGithubToken: process.env.OBSIDIAN_GITHUB_TOKEN || process.env.GITHUB_BACKUP_TOKEN || "",
  obsidianGithubRepo: process.env.OBSIDIAN_GITHUB_REPO || "Mad12345-qw/obsidian-knowledge-sync",
  obsidianGithubBranch: process.env.OBSIDIAN_GITHUB_BRANCH || "main",
  obsidianFolder: stripSlashes(process.env.OBSIDIAN_RESEARCH_FOLDER || "gpt55-research"),
  debugToken: process.env.DEBUG_TOKEN || ""
};

const app = express();
let feishu;
let db;
let obsidian;

const jobs = new Map();
const seenMessageIds = new Map();
const botReplyMessageIds = new Set();

app.use(express.json({ limit: "2mb" }));
app.set("trust proxy", true);

app.get("/", (_req, res) => {
  res.json({
    ok: true,
    service: SERVICE_NAME,
    health: "/health",
    feishuEvents: "/feishu/events"
  });
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: SERVICE_NAME,
    startedAt: STARTED_AT.toISOString(),
    uptimeSeconds: Math.round(process.uptime()),
    model: config.mikotoModel,
    webSearchEnabled: Boolean(config.mikotoWebSearchEnabled),
    feishuConfigured: Boolean(config.feishuAppId && config.feishuAppSecret),
    wikiConfigured: Boolean(config.feishuResearchParentWikiToken),
    obsidianConfigured: Boolean(config.obsidianSyncEnabled && obsidian.enabled),
    databaseConfigured: Boolean(config.databaseUrl),
    cli: false
  });
});

app.get("/debug/status", requireDebugToken, (_req, res) => {
  res.json({
    ok: true,
    service: SERVICE_NAME,
    jobs: [...jobs.values()].slice(-50),
    env: {
      model: config.mikotoModel,
      webSearchEnabled: Boolean(config.mikotoWebSearchEnabled),
      feishuConfigured: Boolean(config.feishuAppId && config.feishuAppSecret),
      wikiConfigured: Boolean(config.feishuResearchParentWikiToken),
      obsidianConfigured: Boolean(config.obsidianSyncEnabled && obsidian.enabled),
      databaseConfigured: Boolean(config.databaseUrl),
      obsidianRepo: config.obsidianGithubRepo,
      obsidianBranch: config.obsidianGithubBranch,
      obsidianFolder: config.obsidianFolder
    }
  });
});

app.get("/debug/test-model", requireDebugToken, async (req, res) => {
  try {
    const prompt = String(req.query.prompt || "用一句中文回答：投研桥机器人已就绪。").slice(0, 1000);
    const result = await callModel([
      { role: "system", content: "You are a concise Chinese assistant." },
      { role: "user", content: prompt }
    ], { maxTokens: 800 });
    res.json({ ok: true, answer: result.content, usage: result.usage, webSearchCalls: result.webSearchCalls });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get("/debug/test-memory", requireDebugToken, async (req, res) => {
  try {
    const query = String(req.query.query || "").slice(0, 500);
    if (!query) {
      res.status(400).json({ ok: false, error: "query is required" });
      return;
    }
    const results = await db.search(query, 8);
    res.json({
      ok: true,
      query,
      count: results.length,
      results: results.map((item) => ({
        sourceKind: item.sourceKind || "",
        title: item.title || "",
        feishuDocUrl: item.feishuDocUrl || "",
        obsidianPath: item.obsidianPath || "",
        createdAt: item.createdAt || "",
        preview: truncate(item.answer || item.prompt || "", 500)
      }))
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
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
  rememberSeenMessage(messageId);
  res.json({});

  processFeishuMessage(payload).catch((error) => {
    console.error(`Feishu background job failed: ${error.stack || error.message}`);
  });
});

async function processFeishuMessage(payload) {
  const event = payload.event || {};
  if (event.sender?.sender_type === "app") return;

  const message = event.message || {};
  const messageId = message.message_id || "";
  const route = await shouldHandleFeishuMessage(message);
  if (!route.handle) return;

  const promptText = cleanupPrompt(extractMessageText(message));
  const quotedId = quotedMessageId(message);
  const job = {
    id: messageId,
    status: "running",
    route: route.reason,
    chatId: message.chat_id || "",
    chatType: message.chat_type || "",
    promptPreview: promptText.slice(0, 160),
    quotedMessageId: quotedId,
    startedAt: new Date().toISOString()
  };
  jobs.set(messageId, job);

  feishu.addReaction(messageId, config.feishuAckReaction).catch((error) => {
    job.reactionError = error.message;
    console.warn(`Failed to add Feishu reaction: ${error.message}`);
  });

  try {
    let quotedText = "";
    if (quotedId) {
      const quoted = await feishu.getMessage(quotedId).catch((error) => {
        job.quotedError = error.message;
        return null;
      });
      quotedText = cleanupPrompt(extractMessageText(quoted || {}));
    }

    const effectivePrompt = promptText || quotedText;
    if (!effectivePrompt) {
      await feishu.replyText(messageId, "我收到了，但这条消息里没有可分析的文本。请直接写公司、行业、问题，或者引用一段研究内容后再 @ 我。");
      job.status = "empty";
      job.completedAt = new Date().toISOString();
      return;
    }

    const related = await db.search(effectivePrompt, 5).catch((error) => {
      job.memorySearchError = error.message;
      return [];
    });
    job.relatedCount = related.length;

    const answer = await runResearch(effectivePrompt, {
      quotedText,
      related,
      chatType: message.chat_type || ""
    });
    job.answerChars = answer.length;

    const title = researchTitle(effectivePrompt, answer);
    const markdown = buildResearchMarkdown({
      title,
      prompt: effectivePrompt,
      answer,
      quotedText,
      related,
      messageId
    });

    const doc = await maybeCreateWikiDocument(title, markdown).catch((error) => {
      job.wikiError = error.message;
      return null;
    });
    const obsidianResult = await maybeSyncObsidian(title, markdown).catch((error) => {
      job.obsidianError = error.message;
      return null;
    });

    await db.save({
      id: crypto.randomUUID(),
      title,
      prompt: effectivePrompt,
      answer,
      feishuDocUrl: doc?.url || "",
      obsidianPath: obsidianResult?.path || "",
      chatId: message.chat_id || "",
      messageId,
      quotedMessageId: quotedId,
      metadata: {
        route: route.reason,
        relatedCount: related.length,
        model: config.mikotoModel
      }
    }).catch((error) => {
      job.indexError = error.message;
    });

    const reply = [
      answer,
      "",
      buildSyncFooter(doc, obsidianResult)
    ].filter(Boolean).join("\n");
    await feishu.replyText(messageId, reply);
    if (config.feishuDoneReaction) {
      feishu.addReaction(messageId, config.feishuDoneReaction).catch((error) => {
        job.doneReactionError = error.message;
      });
    }

    job.status = "completed";
    job.completedAt = new Date().toISOString();
    job.feishuDocUrl = doc?.url || "";
    job.obsidianPath = obsidianResult?.path || "";
  } catch (error) {
    job.status = "failed";
    job.error = error.message;
    job.completedAt = new Date().toISOString();
    await feishu.replyText(messageId, `投研桥机器人执行失败：${error.message}`);
  }
}

async function runResearch(prompt, { quotedText = "", related = [] } = {}) {
  const relatedBlock = related.length
    ? related.map((item, index) => {
        const sourceKind = item.sourceKind ? `Source: ${item.sourceKind}` : "";
        return [
          `#${index + 1} ${item.title || "Untitled"}`,
          sourceKind,
          item.feishuDocUrl ? `Feishu: ${item.feishuDocUrl}` : "",
          item.obsidianPath ? `Obsidian: ${item.obsidianPath}` : "",
          truncate(item.answer || item.prompt || "", 1600)
        ].filter(Boolean).join("\n");
      }).join("\n\n")
    : "No prior internal notes found.";

  const quotedBlock = quotedText
    ? `User quoted or replied to this context:\n${truncate(quotedText, 4000)}`
    : "No quoted context.";

  const result = await callModel([
    {
      role: "system",
      content: [
        "You are a Chinese-language buy-side investment research assistant.",
        "Do not claim that you ran a CLI or a market-data tool unless one actually exists in this service.",
        "When web search is enabled, use the Kimi builtin $web_search tool for companies, industries, macro, news, policy, filings, prices, valuation, financials, and cross-checking public evidence.",
        "Base the answer on the user request, quoted context, internal memory, and public sources retrieved by web search.",
        "The output must include: core conclusion, key evidence, counter-view, data still requiring verification, and follow-up watchpoints.",
        "If real-time market or financial data is missing, state the gap clearly and do not invent numbers.",
        "When the user quotes another bot answer, first extract its thesis, then mark agreement, reservations, and what still needs verification.",
        "Answer in Chinese. End with a short note covering whether web search was enabled, how many internal-memory hits were used, and the main source URLs or evidence gaps."
      ].join("\n")
    },
    {
      role: "user",
      content: [
        quotedBlock,
        "",
        "Prior internal research memory:",
        relatedBlock,
        "",
        "User request:",
        prompt
      ].join("\n")
    }
  ], { maxTokens: MAX_MODEL_TOKENS });
  return result.content;
}

async function callModel(messages, { maxTokens = MAX_MODEL_TOKENS } = {}) {
  if (!config.mikotoBaseUrl || !config.mikotoApiKey || !config.mikotoModel) {
    throw new Error("MIKOTO_BASE_URL, MIKOTO_API_KEY, and MIKOTO_MODEL are required.");
  }

  const modelMessages = messages.map((item) => ({ ...item }));
  const tools = config.mikotoWebSearchEnabled
    ? [{ type: "builtin_function", function: { name: "$web_search" } }]
    : undefined;
  let usage = null;
  let webSearchCalls = 0;
  let lastFinishReason = "";

  for (let turn = 0; turn < 8; turn += 1) {
    const data = await callChatCompletion(modelMessages, { maxTokens, tools });
    usage = data.usage || usage;
    const choice = data?.choices?.[0] || {};
    const message = choice.message || {};
    lastFinishReason = choice.finish_reason || "";
    const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];

    if (toolCalls.length) {
      webSearchCalls += toolCalls.filter((tool) => tool?.function?.name === "$web_search").length;
      modelMessages.push(message);
      for (const tool of toolCalls) {
        modelMessages.push({
          role: "tool",
          tool_call_id: tool.id,
          name: tool?.function?.name || "$web_search",
          content: tool?.function?.arguments || ""
        });
      }
      continue;
    }

    const content = message.content || choice.text || data?.output_text || data?.text || "";
    if (!content) {
      throw new Error(`Model API returned no text; finish_reason=${lastFinishReason || "unknown"}.`);
    }
    return { content: String(content).trim(), usage, webSearchCalls };
  }

  throw new Error(`Model API web search tool loop did not finish after 8 turns; finish_reason=${lastFinishReason || "unknown"}.`);
}

async function callChatCompletion(messages, { maxTokens = MAX_MODEL_TOKENS, tools } = {}) {
  const url = chatCompletionsUrl(config.mikotoBaseUrl);
  const body = {
    model: config.mikotoModel,
    messages,
    temperature: 0.35,
    max_tokens: maxTokens
  };
  if (tools?.length) body.tools = tools;
  if (/kimi/i.test(config.mikotoModel)) body.thinking = { type: "disabled" };

  const response = await fetch(url, {
    method: "POST",
    signal: AbortSignal.timeout(MODEL_TIMEOUT_MS),
    headers: {
      Authorization: `Bearer ${config.mikotoApiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Model API ${response.status}: ${truncate(text, 800)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Model API returned non-JSON: ${truncate(text, 500)}`);
  }
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
  if (!obsidian.enabled) return { synced: false, reason: "missing_github_config" };
  const date = new Date().toISOString().slice(0, 10);
  const slug = slugify(title).slice(0, 80) || "research";
  const path = `${config.obsidianFolder}/${date}-${slug}.md`;
  const indexPath = `${config.obsidianFolder}/index.md`;
  await obsidian.putFile(path, markdown, `Add research bridge note: ${title.slice(0, 60)}`);
  await obsidian.appendUnique(indexPath, `- ${date} [[${path.replace(/\.md$/i, "")}|${title}]]`, `Index research bridge note`);
  return { synced: true, path, repo: config.obsidianGithubRepo, branch: config.obsidianGithubBranch };
}

function buildResearchMarkdown({ title, prompt, answer, quotedText, related, messageId }) {
  const now = new Date().toISOString();
  const relatedLines = related.length
    ? related.map((item) => `- ${item.sourceKind ? `[${item.sourceKind}] ` : ""}${item.title || "Untitled"}${item.feishuDocUrl ? ` - ${item.feishuDocUrl}` : ""}${item.obsidianPath ? ` - ${item.obsidianPath}` : ""}`).join("\n")
    : "- none";
  return [
    "---",
    "source_type: research_bridge_bot",
    `generated_at: ${now}`,
    `model: ${config.mikotoModel}`,
    `web_search_enabled: ${config.mikotoWebSearchEnabled ? "true" : "false"}`,
    `feishu_message_id: ${messageId}`,
    "tags:",
    "  - investment-research",
    "  - research-bridge",
    "---",
    "",
    `# ${title}`,
    "",
    "## User Request",
    prompt,
    "",
    quotedText ? "## Quoted Context\n" + quotedText : "",
    "",
    "## Prior Internal Notes",
    relatedLines,
    "",
    "## Research Output",
    answer
  ].filter(Boolean).join("\n").trim() + "\n";
}

function buildSyncFooter(doc, obsidianResult) {
  const lines = [];
  if (doc?.url) lines.push(`飞书知识库：${doc.url}`);
  if (obsidianResult?.path) lines.push(`Obsidian：${obsidianResult.path}`);
  return lines.length ? lines.join("\n") : "";
}

function researchTitle(prompt, answer) {
  const firstHeading = String(answer || "").match(/^#\s+(.+)$/m)?.[1];
  if (firstHeading) return firstHeading.slice(0, 80);
  return cleanupPrompt(prompt).split(/\r?\n/)[0].slice(0, 80) || "投研桥记录";
}

class FeishuClient {
  constructor(cfg) {
    this.config = cfg;
    this.tenantToken = "";
    this.tenantTokenExpiresAt = 0;
    this.cachedBotInfo = null;
    this.cachedBotInfoExpiresAt = 0;
  }

  async tenantAccessToken() {
    const now = Date.now();
    if (this.tenantToken && now < this.tenantTokenExpiresAt) return this.tenantToken;
    if (!this.config.feishuAppId || !this.config.feishuAppSecret) {
      throw new Error("Feishu app credentials are not configured.");
    }
    const response = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        app_id: this.config.feishuAppId,
        app_secret: this.config.feishuAppSecret
      })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.code !== 0 || !data.tenant_access_token) {
      throw new Error(`Feishu token failed ${response.status}: ${truncate(JSON.stringify(data), 500)}`);
    }
    this.tenantToken = data.tenant_access_token;
    this.tenantTokenExpiresAt = now + Math.max(60, Number(data.expire || 7200) - 300) * 1000;
    return this.tenantToken;
  }

  async request(path, { method = "GET", body = null } = {}) {
    const token = await this.tenantAccessToken();
    const response = await fetch(`https://open.feishu.cn${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: body === null ? undefined : JSON.stringify(body)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.code !== 0) {
      throw new Error(`Feishu API ${response.status}: ${truncate(JSON.stringify(data), 800)}`);
    }
    return data.data || data;
  }

  async botInfo() {
    const now = Date.now();
    if (this.cachedBotInfo && now < this.cachedBotInfoExpiresAt) return this.cachedBotInfo;
    const data = await this.request("/open-apis/bot/v3/info");
    const bot = data.bot || data;
    this.cachedBotInfo = bot;
    this.cachedBotInfoExpiresAt = now + 6 * 60 * 60 * 1000;
    return bot;
  }

  async getMessage(messageId) {
    if (!messageId) return null;
    const data = await this.request(`/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`);
    return data?.items?.[0] || data?.message || data?.item || data || null;
  }

  async addReaction(messageId, emojiType) {
    if (!messageId || !emojiType) return null;
    return this.request(`/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reactions`, {
      method: "POST",
      body: { reaction_type: { emoji_type: emojiType } }
    });
  }

  async replyText(messageId, text) {
    let last = null;
    for (const chunk of splitText(String(text || ""), MAX_REPLY_CHARS)) {
      last = await this.request(`/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reply`, {
        method: "POST",
        body: {
          msg_type: "text",
          content: JSON.stringify({ text: chunk })
        }
      });
      const replyId = last?.message_id || last?.message?.message_id || "";
      if (replyId) botReplyMessageIds.add(replyId);
    }
    return last;
  }

  async getWikiNode(token, objType = "wiki") {
    const params = new URLSearchParams({ token: String(token || "") });
    if (objType) params.set("obj_type", objType);
    const data = await this.request(`/open-apis/wiki/v2/spaces/get_node?${params.toString()}`);
    return data.node || {};
  }

  async createWikiDocument({ parentWikiToken, title, markdown }) {
    const parent = await this.getWikiNode(parentWikiToken, "wiki");
    const spaceId = parent.space_id || "";
    const parentNodeToken = parent.node_token || parent.wiki_token || parentWikiToken;
    if (!spaceId || !parentNodeToken) {
      throw new Error("Feishu parent wiki node is missing space_id/node_token.");
    }
    const data = await this.request(`/open-apis/wiki/v2/spaces/${encodeURIComponent(spaceId)}/nodes`, {
      method: "POST",
      body: {
        obj_type: "docx",
        node_type: "origin",
        parent_node_token: parentNodeToken,
        title: String(title || "投研桥记录").slice(0, 800)
      }
    });
    const node = data.node || {};
    const documentId = node.obj_token || "";
    const wikiToken = node.node_token || node.wiki_token || "";
    if (!documentId) throw new Error("Feishu wiki node response missing obj_token.");
    await this.insertPlainMarkdown(documentId, markdown);
    return {
      created: true,
      token: documentId,
      wikiToken,
      url: node.url || (wikiToken ? `${this.config.feishuDocBaseUrl}/wiki/${wikiToken}` : `${this.config.feishuDocBaseUrl}/docx/${documentId}`)
    };
  }

  async insertPlainMarkdown(documentId, markdown) {
    const children = markdownToTextBlocks(markdown).slice(0, 500);
    for (let start = 0; start < children.length; start += 20) {
      const chunk = children.slice(start, start + 20);
      await this.request(`/open-apis/docx/v1/documents/${encodeURIComponent(documentId)}/blocks/${encodeURIComponent(documentId)}/children`, {
        method: "POST",
        body: { children: chunk }
      });
    }
  }
}

class GitHubFileSync {
  constructor({ token = "", repo = "", branch = "main" } = {}) {
    this.token = token;
    this.repo = normalizeRepo(repo);
    this.branch = branch || "main";
  }

  get enabled() {
    return Boolean(this.token && this.repo);
  }

  splitRepo() {
    const [owner, repo] = this.repo.split("/");
    if (!owner || !repo) throw new Error("GitHub repo must use owner/repo format.");
    return { owner, repo };
  }

  async request(path, options = {}) {
    if (!this.enabled) throw new Error("GitHub sync is not configured.");
    const response = await fetch(`https://api.github.com${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
        ...(options.headers || {})
      }
    });
    const text = await response.text();
    if (!response.ok) {
      const error = new Error(`GitHub API ${response.status}: ${truncate(text, 500)}`);
      error.status = response.status;
      throw error;
    }
    return text ? JSON.parse(text) : null;
  }

  async getFile(path) {
    const { owner, repo } = this.splitRepo();
    const encodedPath = encodeGitHubPath(path);
    try {
      const data = await this.request(`/repos/${owner}/${repo}/contents/${encodedPath}?ref=${encodeURIComponent(this.branch)}`);
      return {
        sha: data.sha || "",
        content: Buffer.from(data.content || "", "base64").toString("utf8")
      };
    } catch (error) {
      if (error.status === 404) return { sha: "", content: "" };
      throw error;
    }
  }

  async putFile(path, content, message) {
    const { owner, repo } = this.splitRepo();
    const encodedPath = encodeGitHubPath(path);
    const remote = await this.getFile(path);
    if (remote.content === content) return { path, changed: false, sha: remote.sha };
    const body = {
      message,
      content: Buffer.from(content, "utf8").toString("base64"),
      branch: this.branch
    };
    if (remote.sha) body.sha = remote.sha;
    const result = await this.request(`/repos/${owner}/${repo}/contents/${encodedPath}`, {
      method: "PUT",
      body: JSON.stringify(body)
    });
    return { path, changed: true, sha: result?.content?.sha || "" };
  }

  async appendUnique(path, block, message) {
    const remote = await this.getFile(path);
    const current = String(remote.content || "").trimEnd();
    const clean = String(block || "").trim();
    if (!clean || current.includes(clean)) return { path, changed: false, sha: remote.sha };
    const next = current ? `${current}\n${clean}\n` : `${clean}\n`;
    return this.putFile(path, next, message);
  }
}

class ResearchIndex {
  constructor(cfg) {
    this.config = cfg;
    this.pool = null;
  }

  get enabled() {
    return Boolean(this.config.databaseUrl);
  }

  async init() {
    if (!this.enabled) return;
    this.pool = new Pool({
      connectionString: this.config.databaseUrl,
      ssl: this.config.dbSsl ? { rejectUnauthorized: false } : false
    });
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS gpt55_research_notes (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL DEFAULT 'gpt55-research',
        title TEXT NOT NULL DEFAULT '',
        prompt TEXT NOT NULL DEFAULT '',
        answer TEXT NOT NULL DEFAULT '',
        feishu_doc_url TEXT NOT NULL DEFAULT '',
        obsidian_path TEXT NOT NULL DEFAULT '',
        chat_id TEXT NOT NULL DEFAULT '',
        message_id TEXT NOT NULL DEFAULT '',
        quoted_message_id TEXT NOT NULL DEFAULT '',
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_gpt55_research_notes_created
        ON gpt55_research_notes (created_at DESC);
    `);
  }

  async search(query, limit = 5) {
    if (!this.pool) return [];
    const terms = splitTerms(query).slice(0, 8);
    if (!terms.length) return [];
    const safeLimit = Math.max(1, Math.min(10, Number(limit) || 5));
    const searches = await Promise.allSettled([
      this.searchGpt55Notes(terms, safeLimit),
      this.searchResearchSources(terms, safeLimit),
      this.searchResearchReports(terms, safeLimit),
      this.searchResearchTheses(terms, safeLimit)
    ]);
    return searches
      .flatMap((result) => result.status === "fulfilled" ? result.value : [])
      .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))
      .slice(0, safeLimit);
  }

  async searchGpt55Notes(terms, limit) {
    const clauses = [];
    const values = [];
    for (const term of terms) {
      values.push(`%${term}%`);
      clauses.push(`title ILIKE $${values.length} OR prompt ILIKE $${values.length} OR answer ILIKE $${values.length}`);
    }
    values.push(limit);
    try {
      const result = await this.pool.query(
        `SELECT id, 'gpt55_note' AS "sourceKind", title, prompt, answer,
                feishu_doc_url AS "feishuDocUrl", obsidian_path AS "obsidianPath",
                created_at AS "createdAt"
         FROM gpt55_research_notes
         WHERE ${clauses.map((item) => `(${item})`).join(" OR ")}
         ORDER BY created_at DESC
         LIMIT $${values.length}`,
        values
      );
      return result.rows || [];
    } catch (error) {
      if (isMissingResearchTable(error)) return [];
      throw error;
    }
  }

  async searchResearchSources(terms, limit) {
    const clauses = [];
    const values = [];
    for (const term of terms) {
      values.push(`%${term}%`);
      const slot = `$${values.length}`;
      clauses.push([
        `s.title ILIKE ${slot}`,
        `s.author ILIKE ${slot}`,
        `s.organization ILIKE ${slot}`,
        `s.source_type ILIKE ${slot}`,
        `s.platform ILIKE ${slot}`,
        `s.raw_text ILIKE ${slot}`,
        `s.metadata::text ILIKE ${slot}`,
        `evidence_search.text ILIKE ${slot}`
      ].join(" OR "));
    }
    values.push(limit);
    try {
      const result = await this.pool.query(
        `SELECT s.source_id AS id,
                'xiaoye_research_source' AS "sourceKind",
                COALESCE(NULLIF(s.title, ''), s.source_id) AS title,
                concat_ws(' ', s.source_type, s.platform, s.organization, s.author, s.url) AS prompt,
                concat_ws(E'\n',
                  NULLIF(s.raw_text, ''),
                  NULLIF(evidence_search.text, ''),
                  NULLIF(s.metadata::text, '{}')
                ) AS answer,
                s.doc_url AS "feishuDocUrl",
                s.obsidian_path AS "obsidianPath",
                COALESCE(s.analyzed_at, s.updated_at, s.created_at) AS "createdAt"
         FROM research_sources s
         LEFT JOIN LATERAL (
           SELECT string_agg(
                    DISTINCT concat_ws(' ', ec.claim, ec.quote_zh, ec.quote_original, ec.why_it_matters),
                    E'\n'
                  ) AS text
           FROM research_evidence_cards ec
           WHERE ec.source_id = s.source_id
         ) evidence_search ON true
         WHERE ${clauses.map((item) => `(${item})`).join(" OR ")}
         ORDER BY COALESCE(s.analyzed_at, s.updated_at, s.created_at) DESC
         LIMIT $${values.length}`,
        values
      );
      return result.rows || [];
    } catch (error) {
      if (isMissingResearchTable(error)) return [];
      throw error;
    }
  }

  async searchResearchReports(terms, limit) {
    const clauses = [];
    const values = [];
    for (const term of terms) {
      values.push(`%${term}%`);
      const slot = `$${values.length}`;
      clauses.push([
        `v.report_topic ILIKE ${slot}`,
        `v.report_topic_key ILIKE ${slot}`,
        `v.delta_summary ILIKE ${slot}`,
        `v.metadata::text ILIKE ${slot}`,
        `j.input::text ILIKE ${slot}`,
        `j.output::text ILIKE ${slot}`
      ].join(" OR "));
    }
    values.push(limit);
    try {
      const result = await this.pool.query(
        `SELECT v.job_id AS id,
                'xiaoye_report_version' AS "sourceKind",
                COALESCE(NULLIF(v.report_topic, ''), NULLIF(j.input->>'query', ''), v.job_id) AS title,
                COALESCE(j.input->>'query', v.report_topic, '') AS prompt,
                concat_ws(E'\n',
                  NULLIF(v.delta_summary, ''),
                  'source_count=' || v.source_count::text,
                  'evidence_count=' || v.evidence_count::text,
                  NULLIF(j.output::text, '{}')
                ) AS answer,
                COALESCE(j.output->>'feishuDocUrl', j.output->>'feishu_doc_url', '') AS "feishuDocUrl",
                COALESCE(j.output->>'obsidianPath', j.output->>'obsidian_path', '') AS "obsidianPath",
                COALESCE(v.created_at, j.updated_at, j.created_at) AS "createdAt"
         FROM research_report_versions v
         JOIN research_jobs j ON j.id = v.job_id
         WHERE ${clauses.map((item) => `(${item})`).join(" OR ")}
         ORDER BY v.created_at DESC
         LIMIT $${values.length}`,
        values
      );
      return result.rows || [];
    } catch (error) {
      if (isMissingResearchTable(error)) return [];
      throw error;
    }
  }

  async searchResearchTheses(terms, limit) {
    const clauses = [];
    const values = [];
    for (const term of terms) {
      values.push(`%${term}%`);
      const slot = `$${values.length}`;
      clauses.push([
        `topic_key ILIKE ${slot}`,
        `thesis ILIKE ${slot}`,
        `thesis_type ILIKE ${slot}`,
        `conviction ILIKE ${slot}`,
        `metadata::text ILIKE ${slot}`
      ].join(" OR "));
    }
    values.push(limit);
    try {
      const result = await this.pool.query(
        `SELECT id::text AS id,
                'xiaoye_thesis_ledger' AS "sourceKind",
                COALESCE(NULLIF(topic_key, ''), 'research thesis') AS title,
                topic_key AS prompt,
                concat_ws(E'\n',
                  thesis,
                  'type=' || thesis_type,
                  'conviction=' || conviction,
                  NULLIF(time_horizon, ''),
                  NULLIF(metadata::text, '{}')
                ) AS answer,
                '' AS "feishuDocUrl",
                '' AS "obsidianPath",
                created_at AS "createdAt"
         FROM research_thesis_ledger
         WHERE status <> 'archived'
           AND (${clauses.map((item) => `(${item})`).join(" OR ")})
         ORDER BY created_at DESC
         LIMIT $${values.length}`,
        values
      );
      return result.rows || [];
    } catch (error) {
      if (isMissingResearchTable(error)) return [];
      throw error;
    }
  }

  async save(note) {
    if (!this.pool) return { saved: false, reason: "database_not_configured" };
    await this.pool.query(
      `INSERT INTO gpt55_research_notes (
         id, title, prompt, answer, feishu_doc_url, obsidian_path,
         chat_id, message_id, quoted_message_id, metadata
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (id) DO UPDATE SET
         title = EXCLUDED.title,
         prompt = EXCLUDED.prompt,
         answer = EXCLUDED.answer,
         feishu_doc_url = EXCLUDED.feishu_doc_url,
         obsidian_path = EXCLUDED.obsidian_path,
         metadata = EXCLUDED.metadata`,
      [
        note.id,
        note.title || "",
        note.prompt || "",
        note.answer || "",
        note.feishuDocUrl || "",
        note.obsidianPath || "",
        note.chatId || "",
        note.messageId || "",
        note.quotedMessageId || "",
        JSON.stringify(note.metadata || {})
      ]
    );
    return { saved: true };
  }
}

async function shouldHandleFeishuMessage(message = {}) {
  if (message.chat_type === "p2p") return { handle: true, reason: "p2p" };
  if (messageRepliesToKnownBotMessage(message)) return { handle: true, reason: "known_bot_reply" };
  const mentions = messageMentions(message);
  try {
    const bot = await feishu.botInfo();
    if (mentions.some((mention) => mentionMatchesBot(mention, bot))) {
      return { handle: true, reason: "mentioned_bot" };
    }
    const quotedId = quotedMessageId(message);
    if (!quotedId) return { handle: false, reason: "group_not_mentioned" };
    const quoted = await feishu.getMessage(quotedId);
    if (messageSenderMatchesBot(quoted, bot)) {
      botReplyMessageIds.add(quotedId);
      return { handle: true, reason: "quoted_bot_message" };
    }
    return { handle: false, reason: "quoted_non_bot_message" };
  } catch (error) {
    console.warn(`Mention routing failed: ${error.message}`);
    return { handle: false, reason: "routing_error" };
  }
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

function messageContent(message = {}) {
  const raw = message.content || message.body?.content || {};
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return { text: raw };
    }
  }
  return raw && typeof raw === "object" ? raw : {};
}

function extractMessageText(message = {}) {
  const content = messageContent(message);
  const parts = [];
  for (const key of ["text", "title", "description"]) {
    if (typeof content[key] === "string") parts.push(content[key]);
  }
  const walk = (value) => {
    if (!value) return;
    if (typeof value === "string") {
      parts.push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (typeof value === "object") {
      if (typeof value.text === "string") parts.push(value.text);
      if (typeof value.content === "string") parts.push(value.content);
      if (value.text_run?.content) parts.push(value.text_run.content);
      if (value.tag === "at") return;
      for (const item of Object.values(value)) walk(item);
    }
  };
  if (message.message_type === "post" || content.content) walk(content.content);
  return unique(parts.map((item) => String(item || "").trim()).filter(Boolean)).join("\n").trim();
}

function cleanupPrompt(text = "") {
  return String(text || "")
    .replace(/<at\b[^>]*>[\s\S]*?<\/at>/gi, "")
    .replace(/\u200b/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

function quotedMessageId(message = {}) {
  return String(
    message.parent_id ||
    message.root_id ||
    message.upper_message_id ||
    message.body?.parent_id ||
    message.body?.root_id ||
    ""
  );
}

function messageRepliesToKnownBotMessage(message = {}) {
  const own = message.message_id || "";
  for (const key of ["parent_id", "root_id", "upper_message_id"]) {
    const value = message[key];
    if (value && value !== own && botReplyMessageIds.has(String(value))) return true;
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
  const candidates = new Set([
    sender.open_id,
    sender.user_id,
    sender.union_id,
    sender.app_id,
    senderId.open_id,
    senderId.user_id,
    senderId.union_id,
    senderId.app_id
  ].filter(Boolean).map(String));
  if (bot.open_id && candidates.has(String(bot.open_id))) return true;
  if (config.feishuAppId && candidates.has(String(config.feishuAppId))) return true;
  return false;
}

function markdownToTextBlocks(markdown) {
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

function splitText(text, max) {
  const clean = String(text || "");
  const chunks = [];
  for (let index = 0; index < clean.length; index += max) {
    chunks.push(clean.slice(index, index + max));
  }
  return chunks.length ? chunks : [""];
}

function splitTerms(text) {
  return unique(String(text || "")
    .replace(/[^\p{L}\p{N}._-]+/gu, " ")
    .split(/\s+/)
    .map((item) => item.trim())
    .filter((item) => item.length >= 2)
    .slice(0, 24));
}

function chatCompletionsUrl(base) {
  const clean = String(base || "").replace(/\/+$/, "");
  if (/\/chat\/completions$/i.test(clean)) return clean;
  if (/\/v1$/i.test(clean)) return `${clean}/chat/completions`;
  return `${clean}/v1/chat/completions`;
}

function normalizeRepo(value = "") {
  return String(value || "").trim().replace(/^https:\/\/github\.com\//i, "").replace(/\.git$/i, "");
}

function encodeGitHubPath(path) {
  return String(path || "").split("/").filter(Boolean).map(encodeURIComponent).join("/");
}

function slugify(value = "") {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
    .replace(/^-+|-+$/g, "") || "research";
}

function stripSlashes(value = "") {
  return String(value || "").replace(/^[/\\]+|[/\\]+$/g, "") || "gpt55-research";
}

function truncate(value, max) {
  const text = String(value || "");
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function unique(items) {
  return [...new Set(items)];
}

function isMissingResearchTable(error) {
  return error?.code === "42P01" || /relation .* does not exist/i.test(String(error?.message || ""));
}

function parseBool(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

function numberEnv(key, fallback) {
  const value = Number(process.env[key]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function requireDebugToken(req, res, next) {
  if (config.debugToken && req.get("x-debug-token") !== config.debugToken) {
    res.status(401).json({ ok: false, error: "Unauthorized" });
    return;
  }
  next();
}

function rememberSeenMessage(messageId) {
  seenMessageIds.set(messageId, Date.now());
  for (const [id, ts] of seenMessageIds) {
    if (Date.now() - ts > 30 * 60 * 1000) seenMessageIds.delete(id);
  }
}

feishu = new FeishuClient(config);
db = new ResearchIndex(config);
obsidian = new GitHubFileSync({
  token: config.obsidianGithubToken,
  repo: config.obsidianGithubRepo,
  branch: config.obsidianGithubBranch
});

await db.init().catch((error) => {
  console.warn(`Research index init skipped: ${error.message}`);
});

app.listen(config.port, () => {
  console.log(`${SERVICE_NAME} listening on ${config.port}`);
});
