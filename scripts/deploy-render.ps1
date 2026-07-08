param(
  [string]$ServiceName = "feishu-gpt55-research-bridge",
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

function Optional-Env([string]$Name) {
  return [Environment]::GetEnvironmentVariable($Name, "Process")
}

function Value-OrDefault([string]$Value, [string]$Default) {
  if ([string]::IsNullOrWhiteSpace($Value)) {
    return $Default
  }
  return $Value
}

$renderApiKey = Require-Env "RENDER_API_KEY"
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
  @{ key = "FEISHU_APP_ID"; value = (Require-Env "FEISHU_APP_ID") },
  @{ key = "FEISHU_APP_SECRET"; value = (Require-Env "FEISHU_APP_SECRET") },
  @{ key = "MIKOTO_BASE_URL"; value = (Require-Env "MIKOTO_BASE_URL") },
  @{ key = "MIKOTO_API_KEY"; value = (Require-Env "MIKOTO_API_KEY") },
  @{ key = "MIKOTO_MODEL"; value = (Value-OrDefault (Optional-Env "MIKOTO_MODEL") "gpt-5.5") },
  @{ key = "MODEL_TIMEOUT_MS"; value = "300000" },
  @{ key = "MODEL_MAX_TOKENS"; value = "6000" },
  @{ key = "MAX_REPLY_CHARS"; value = "3500" },
  @{ key = "FEISHU_ACK_REACTION"; value = (Value-OrDefault (Optional-Env "FEISHU_ACK_REACTION") "OneSecond") },
  @{ key = "FEISHU_DONE_REACTION"; value = (Value-OrDefault (Optional-Env "FEISHU_DONE_REACTION") "Done") },
  @{ key = "OBSIDIAN_SYNC_ENABLED"; value = (Value-OrDefault (Optional-Env "OBSIDIAN_SYNC_ENABLED") "true") },
  @{ key = "OBSIDIAN_GITHUB_REPO"; value = (Value-OrDefault (Optional-Env "OBSIDIAN_GITHUB_REPO") "Mad12345-qw/obsidian-knowledge-sync") },
  @{ key = "OBSIDIAN_GITHUB_BRANCH"; value = (Value-OrDefault (Optional-Env "OBSIDIAN_GITHUB_BRANCH") "main") },
  @{ key = "OBSIDIAN_RESEARCH_FOLDER"; value = (Value-OrDefault (Optional-Env "OBSIDIAN_RESEARCH_FOLDER") "gpt55-research") },
  @{ key = "DB_SSL"; value = (Value-OrDefault (Optional-Env "DB_SSL") "false") }
)

foreach ($name in @(
  "FEISHU_VERIFICATION_TOKEN",
  "FEISHU_ENCRYPT_KEY",
  "FEISHU_RESEARCH_REPORT_PARENT_WIKI_TOKEN",
  "DATABASE_URL",
  "OBSIDIAN_GITHUB_TOKEN",
  "DEBUG_TOKEN"
)) {
  $value = Optional-Env $name
  if (-not [string]::IsNullOrWhiteSpace($value)) {
    $envVars += @{ key = $name; value = $value }
  }
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
      buildCommand = "npm ci"
      startCommand = "npm start"
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
