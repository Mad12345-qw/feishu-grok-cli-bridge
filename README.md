# Feishu Grok CLI Bridge

把官方 Grok CLI 接到飞书机器人，并部署到 Render。适合只有 SuperGrok / Grok 网页账号、没有 xAI API key 的场景。

这套方案不调用 xAI API。Render 服务器安装 Grok CLI，通过你本地导出的 `auth.json` 登录态运行，然后把飞书消息转给 Grok CLI，再用飞书 CardKit 流式卡片回复。

## 功能

- 飞书私聊和群聊机器人接入
- Grok CLI headless 调用
- Grok 原生联网搜索
- 固定暗号触发图片和视频任务：`生成图片：...` / `生成视频：...`
- 飞书 CardKit 流式回复
- 引用/回复消息上下文传递
- Grok session / memory 持久化
- 可选 Redis 保存登录态和小状态
- 可选 SSH/SFTP 远程仓库保存完整 Grok 状态，避免 Render 重启后丢记忆

## 一键部署到 Render

1. Fork 这个仓库到你自己的 GitHub。
2. 在 Render 新建 Web Service，连接你的 Fork。
3. 使用下面命令：

```text
Build Command:
export GROK_BIN_DIR="$PWD/.grok/bin" && curl -fsSL https://x.ai/cli/install.sh | bash && npm ci

Start Command:
export GROK_BIN_DIR="$PWD/.grok/bin" && node scripts/restore-grok-auth.mjs && node scripts/ensure-grok-cli.mjs && export PATH="$GROK_BIN_DIR:$PATH" && npm start
```

也可以直接用 `render.yaml` Blueprint。

## 必填环境变量

```env
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=replace_me
GROK_AUTH_JSON_B64=replace_me
```

### 获取 GROK_AUTH_JSON_B64

在自己的电脑上安装并登录 Grok CLI：

```powershell
irm https://x.ai/cli/install.ps1 | iex
grok
```

浏览器授权成功后，导出本机登录态：

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("$env:USERPROFILE\.grok\auth.json"))
```

把输出整段填到 Render 的 `GROK_AUTH_JSON_B64`。不要提交到 GitHub。

## 推荐环境变量

如果希望 Render 重启/重新部署后不丢登录态和记忆，建议配置 Upstash Redis：

```env
GROK_AUTH_SYNC_ENABLED=true
GROK_STATE_SYNC_ENABLED=true
UPSTASH_REDIS_REST_URL=replace_me
UPSTASH_REDIS_REST_TOKEN=replace_me
AUTH_ENCRYPTION_KEY=replace_me
GROK_AUTH_REDIS_KEY=feishu-grok-bridge:grok-auth
GROK_STATE_REDIS_KEY=feishu-grok-bridge:grok-state
```

生成 `AUTH_ENCRYPTION_KEY`：

```powershell
$bytes = New-Object byte[] 32
[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
[Convert]::ToBase64String($bytes)
```

`AUTH_ENCRYPTION_KEY` 是加密钥匙，不要随便换。换了以后旧 Redis/远程状态会解不开。

## 可选：完整记忆远程仓库

Upstash 免费版容量较小。如果 Grok memory 里出现较大的 `index.sqlite`，建议配置一台自己的服务器作为完整状态仓库：

```env
GROK_REMOTE_STATE_SSH_HOST=your.server.ip
GROK_REMOTE_STATE_SSH_PORT=22
GROK_REMOTE_STATE_SSH_USER=root
GROK_REMOTE_STATE_SSH_PASSWORD=replace_me
GROK_REMOTE_STATE_DIR=/opt/grok-state-backups/feishu-grok-bridge
```

远程状态会以加密文件保存到：

```text
/opt/grok-state-backups/feishu-grok-bridge/latest.json.enc
```

媒体文件不会进入状态仓库，避免图片和视频挤爆服务器。

## 飞书配置

飞书事件请求地址：

```text
https://你的-render-service.onrender.com/feishu/events
```

建议开启并配置：

```env
FEISHU_VERIFICATION_TOKEN=replace_me
FEISHU_ENCRYPT_KEY=replace_me
```

飞书应用常用能力：

- 机器人能力
- 接收消息事件 `im.message.receive_v1`
- 发送消息
- 上传图片/文件
- CardKit 卡片写入

## 常用配置

```env
GROK_CLI_ENABLED=true
GROK_CLI_TIMEOUT_MS=540000
GROK_CLI_COMMAND=/opt/render/project/src/.grok/bin/grok
GROK_CLI_CWD=/tmp/grok-feishu-bridge-cwd
GROK_MEDIA_MAX_TURNS=10
GROK_VIDEO_MAX_TURNS=10
GROK_VIDEO_MODEL=grok-build
MAX_CARD_CONTENT_CHARS=90000
MAX_REPLY_CHARS=3500
MAX_IMAGE_BYTES=10485760
MAX_VIDEO_BYTES=31457280
DEBUG_TOKEN=replace_me
```

## 换 Grok 账号

1. 本地用新账号重新登录 Grok CLI。
2. 重新生成 `GROK_AUTH_JSON_B64`。
3. Render 更新 `GROK_AUTH_JSON_B64`。
4. 建议同时换新的 `GROK_AUTH_REDIS_KEY`，避免旧账号登录态从 Redis 恢复回来。
5. 不要换 `GROK_STATE_REDIS_KEY`，除非你想清空机器人记忆。

## 本地检查

```powershell
npm install
npm run check
```

## 安全提醒

不要把下面这些值提交到 GitHub：

- `FEISHU_APP_SECRET`
- `GROK_AUTH_JSON_B64`
- `UPSTASH_REDIS_REST_TOKEN`
- `AUTH_ENCRYPTION_KEY`
- `GROK_REMOTE_STATE_SSH_PASSWORD`
- `DEBUG_TOKEN`
