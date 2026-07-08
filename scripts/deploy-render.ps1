param(
  [string]$ServiceName = "feishu-grok-bridge",
  [string]$OwnerId = "",
  [string]$Repo = "https://github.com/Mad12345-qw/feishu-grok-cli-bridge",
  [string]$Branch = "main",
  [string]$Plan = "starter"
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

function Require-Env([string]$Name) {
  $value = [Environment]::GetEnvironmentVariable($Name, "Process")
  if ([string]::IsNullOrWhiteSpace($value)) {
    throw "Missing required environment variable: $Name"
  }
  return $value
}

$renderApiKey = Require-Env "RENDER_API_KEY"
$feishuAppId = Require-Env "FEISHU_APP_ID"
$feishuAppSecret = Require-Env "FEISHU_APP_SECRET"
$grokDeploymentKey = [Environment]::GetEnvironmentVariable("GROK_DEPLOYMENT_KEY", "Process")
$grokAuthJsonB64 = [Environment]::GetEnvironmentVariable("GROK_AUTH_JSON_B64", "Process")
$upstashRedisRestUrl = [Environment]::GetEnvironmentVariable("UPSTASH_REDIS_REST_URL", "Process")
$upstashRedisRestToken = [Environment]::GetEnvironmentVariable("UPSTASH_REDIS_REST_TOKEN", "Process")
$authEncryptionKey = [Environment]::GetEnvironmentVariable("AUTH_ENCRYPTION_KEY", "Process")
$debugToken = [Environment]::GetEnvironmentVariable("DEBUG_TOKEN", "Process")
$remoteStateHost = [Environment]::GetEnvironmentVariable("GROK_REMOTE_STATE_SSH_HOST", "Process")
$remoteStatePort = [Environment]::GetEnvironmentVariable("GROK_REMOTE_STATE_SSH_PORT", "Process")
$remoteStateUser = [Environment]::GetEnvironmentVariable("GROK_REMOTE_STATE_SSH_USER", "Process")
$remoteStatePassword = [Environment]::GetEnvironmentVariable("GROK_REMOTE_STATE_SSH_PASSWORD", "Process")
$remoteStateDir = [Environment]::GetEnvironmentVariable("GROK_REMOTE_STATE_DIR", "Process")

if ([string]::IsNullOrWhiteSpace($grokDeploymentKey) -and [string]::IsNullOrWhiteSpace($grokAuthJsonB64)) {
  throw "Set one Grok CLI credential: GROK_DEPLOYMENT_KEY or GROK_AUTH_JSON_B64"
}

$headers = @{
  Authorization = "Bearer $renderApiKey"
  Accept = "application/json"
  "Content-Type" = "application/json"
}

if ([string]::IsNullOrWhiteSpace($OwnerId)) {
  $owners = Invoke-RestMethod -Method Get -Uri "https://api.render.com/v1/owners?limit=20" -Headers $headers
  $first = @($owners)[0]
  $OwnerId = if ($first.owner) { $first.owner.id } else { $first.id }
}

$envVars = @(
  @{ key = "NODE_VERSION"; value = "20" },
  @{ key = "SERVICE_NAME"; value = $ServiceName },
  @{ key = "FEISHU_APP_ID"; value = $feishuAppId },
  @{ key = "FEISHU_APP_SECRET"; value = $feishuAppSecret },
  @{ key = "GROK_CLI_ENABLED"; value = "true" },
  @{ key = "GROK_CLI_TIMEOUT_MS"; value = "540000" },
  @{ key = "GROK_CLI_COMMAND"; value = "/opt/render/project/src/.grok/bin/grok" },
  @{ key = "GROK_CLI_CWD"; value = "/tmp/grok-feishu-bridge-cwd" },
  @{ key = "GROK_MEDIA_MAX_TURNS"; value = "10" },
  @{ key = "GROK_VIDEO_MAX_TURNS"; value = "10" },
  @{ key = "GROK_VIDEO_MODEL"; value = "grok-build" },
  @{ key = "GROK_MEMORY_ENABLED"; value = "true" },
  @{ key = "GROK_STATE_SYNC_ENABLED"; value = "true" },
  @{ key = "GROK_AUTH_SYNC_ENABLED"; value = "true" },
  @{ key = "GROK_AUTH_REDIS_KEY"; value = "feishu-grok-bridge:grok-auth" },
  @{ key = "GROK_STATE_REDIS_KEY"; value = "feishu-grok-bridge:grok-state" },
  @{ key = "GROK_CLI_ARGS_JSON"; value = '["--no-auto-update","--always-approve","--permission-mode","bypassPermissions","--max-turns","10","--cwd","{{cwd}}","--output-format","streaming-json","-p","{{prompt}}"]' },
  @{ key = "MAX_CARD_CONTENT_CHARS"; value = "90000" },
  @{ key = "MAX_REPLY_CHARS"; value = "3500" },
  @{ key = "MAX_IMAGE_BYTES"; value = "10485760" },
  @{ key = "MAX_VIDEO_BYTES"; value = "31457280" }
)

if (-not [string]::IsNullOrWhiteSpace($grokDeploymentKey)) {
  $envVars += @{ key = "GROK_DEPLOYMENT_KEY"; value = $grokDeploymentKey }
}
if (-not [string]::IsNullOrWhiteSpace($grokAuthJsonB64)) {
  $envVars += @{ key = "GROK_AUTH_JSON_B64"; value = $grokAuthJsonB64 }
}
if (-not [string]::IsNullOrWhiteSpace($upstashRedisRestUrl)) {
  $envVars += @{ key = "UPSTASH_REDIS_REST_URL"; value = $upstashRedisRestUrl }
}
if (-not [string]::IsNullOrWhiteSpace($upstashRedisRestToken)) {
  $envVars += @{ key = "UPSTASH_REDIS_REST_TOKEN"; value = $upstashRedisRestToken }
}
if (-not [string]::IsNullOrWhiteSpace($authEncryptionKey)) {
  $envVars += @{ key = "AUTH_ENCRYPTION_KEY"; value = $authEncryptionKey }
}
if (-not [string]::IsNullOrWhiteSpace($debugToken)) {
  $envVars += @{ key = "DEBUG_TOKEN"; value = $debugToken }
}
if (-not [string]::IsNullOrWhiteSpace($remoteStateHost)) {
  $envVars += @{ key = "GROK_REMOTE_STATE_SSH_HOST"; value = $remoteStateHost }
}
if (-not [string]::IsNullOrWhiteSpace($remoteStatePort)) {
  $envVars += @{ key = "GROK_REMOTE_STATE_SSH_PORT"; value = $remoteStatePort }
}
if (-not [string]::IsNullOrWhiteSpace($remoteStateUser)) {
  $envVars += @{ key = "GROK_REMOTE_STATE_SSH_USER"; value = $remoteStateUser }
}
if (-not [string]::IsNullOrWhiteSpace($remoteStatePassword)) {
  $envVars += @{ key = "GROK_REMOTE_STATE_SSH_PASSWORD"; value = $remoteStatePassword }
}
if (-not [string]::IsNullOrWhiteSpace($remoteStateDir)) {
  $envVars += @{ key = "GROK_REMOTE_STATE_DIR"; value = $remoteStateDir }
}

$body = @{
  type = "web_service"
  name = $ServiceName
  ownerId = $OwnerId
  repo = $Repo
  branch = $Branch
  autoDeploy = "yes"
  envVars = $envVars
  serviceDetails = @{
    env = "node"
    runtime = "node"
    plan = $Plan
    region = "oregon"
    healthCheckPath = "/health"
    numInstances = 1
    envSpecificDetails = @{
      buildCommand = 'export GROK_BIN_DIR="$PWD/.grok/bin" && curl -fsSL https://x.ai/cli/install.sh | bash && npm ci'
      startCommand = 'export GROK_BIN_DIR="$PWD/.grok/bin" && node scripts/restore-grok-auth.mjs && node scripts/ensure-grok-cli.mjs && export PATH="$GROK_BIN_DIR:$PATH" && npm start'
    }
  }
} | ConvertTo-Json -Depth 20

$service = Invoke-RestMethod -Method Post -Uri "https://api.render.com/v1/services" -Headers $headers -Body $body
$created = if ($service.service) { $service.service } else { $service }

[pscustomobject]@{
  id = $created.id
  name = $created.name
  url = "https://$ServiceName.onrender.com"
  eventsUrl = "https://$ServiceName.onrender.com/feishu/events"
} | ConvertTo-Json -Depth 5
