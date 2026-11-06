# CodeLens 桌面端构建（Windows 便捷入口）
# 直接运行： pwsh -File build.ps1   或右键“使用 PowerShell 运行”
# 实际构建逻辑在 build.mjs（跨平台），本脚本仅设置工作目录后调用它。
$ErrorActionPreference = 'Stop'
$desktopDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Push-Location $desktopDir
try {
    & node build.mjs
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
finally {
    Pop-Location
}
