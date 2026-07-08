# Feishu GPT5.5 Research Bridge

Lightweight Feishu investment-research bot backed by an OpenAI-compatible GPT5.5 endpoint.

## Scope

- Receives Feishu bot mentions and direct messages.
- Adds a Feishu reaction immediately as a best-effort acknowledgement.
- Calls `MIKOTO_BASE_URL` with `MIKOTO_MODEL`.
- Replies with a structured Chinese investment-research answer.
- Can read quoted Feishu message text for simple cross-validation workflows.
- Optionally writes final notes to a Feishu Wiki folder.
- Optionally syncs Markdown notes to an Obsidian GitHub repository.
- Optionally stores a small reusable research index in Postgres.

This service does not run any external CLI and has no market-data provider dependency.

## Render

Build command:

```text
npm ci
```

Start command:

```text
npm start
```

Health check:

```text
/health
```

Feishu event callback:

```text
https://your-render-service.onrender.com/feishu/events
```

## Required Env

```env
MIKOTO_BASE_URL=
MIKOTO_API_KEY=
MIKOTO_MODEL=gpt-5.5

FEISHU_APP_ID=
FEISHU_APP_SECRET=
FEISHU_VERIFICATION_TOKEN=
FEISHU_ENCRYPT_KEY=
```

## Optional Knowledge Loop Env

```env
FEISHU_RESEARCH_REPORT_PARENT_WIKI_TOKEN=

DATABASE_URL=
DB_SSL=false

OBSIDIAN_SYNC_ENABLED=true
OBSIDIAN_GITHUB_TOKEN=
OBSIDIAN_GITHUB_REPO=Mad12345-qw/obsidian-knowledge-sync
OBSIDIAN_GITHUB_BRANCH=main
OBSIDIAN_RESEARCH_FOLDER=gpt55-research
```

## Debug

```text
GET /debug/status
GET /debug/test-model?prompt=hello
```

If `DEBUG_TOKEN` is set, include:

```text
x-debug-token: your_token
```
