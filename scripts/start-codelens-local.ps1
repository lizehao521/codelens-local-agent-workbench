# 本地启动 CodeLens（配合同机 api-relay）
# 前置：api-relay 已在 127.0.0.1:8787 运行
# 用法：pwsh -NoProfile -File scripts\start-codelens-local.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$serverDir = Join-Path $root 'server'

if (-not (Test-Path (Join-Path $serverDir 'dist\app.js'))) {
  Write-Error "缺少 $serverDir\dist\app.js，请先执行：npm --prefix server run build"
}

# 本机全局可能设了 NODE_TLS_REJECT_UNAUTHORIZED=0；仅对本进程恢复证书校验
$env:NODE_TLS_REJECT_UNAUTHORIZED = '1'

Set-Location -LiteralPath $serverDir
Write-Host "[codelens] 启动 http://127.0.0.1:8080 （试用上游 -> http://127.0.0.1:8787/v1）"
& node --disable-warning=ExperimentalWarning dist/app.js