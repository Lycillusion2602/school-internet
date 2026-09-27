# ============================================================
#  schoolnet 开机自启管理（Windows 计划任务）
#  用法（管理员 PowerShell）:
#     powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1
#     powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1 -Remove
#
#  说明：计划任务通过 bin\schoolnet-daemon.exe 启动守护进程。
#        该 exe 是「无控制台子系统」(winexe) 的程序，运行时不弹任何窗口。
#        （不用 .vbs：本机 Windows Script Host 不可用；
#          也不用直接执行 node.exe：那是控制台程序会闪黑框。）
# ============================================================
param(
    [switch]$Remove,
    [string]$TaskName = "SchoolNet-AutoAuth"
)

$ErrorActionPreference = "Stop"

# 定位项目根目录（本脚本在 scripts\ 下）
$Root = Split-Path -Parent $PSScriptRoot
$Exe  = Join-Path $Root "bin\schoolnet-daemon.exe"

if ($Remove) {
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Host "[OK] 已移除计划任务: $TaskName" -ForegroundColor Green
    } else {
        Write-Host "[--] 计划任务不存在: $TaskName" -ForegroundColor Yellow
    }
    return
}

if (-not (Test-Path $Exe)) {
    Write-Host "[ERR] 找不到启动器 $Exe" -ForegroundColor Red
    Write-Host "      请先运行: node scripts\build-launcher.js" -ForegroundColor Yellow
    exit 1
}

# 找 node.exe 绝对路径，显式传给启动器（计划任务的 PATH 可能不完整）
$Node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $Node) {
    Write-Host "[ERR] 未找到 node，请先安装 Node.js 并加入 PATH。" -ForegroundColor Red
    exit 1
}
Write-Host "[..] Node: $Node"
Write-Host "[..] Launcher: $Exe"

# 动作：运行无窗口启动器，把 node 路径作为参数传入。
# 加 --wait：让启动器阻塞直到守护进程退出，这样任务能跟踪其状态，
# 且守护进程意外崩溃时由计划任务的 RestartCount 自动重启。
$Action = New-ScheduledTaskAction `
    -Execute $Exe `
    -Argument "`"$Node`" --wait" `
    -WorkingDirectory $Root

# 触发器：用户登录时启动
$Trigger = New-ScheduledTaskTrigger -AtLogOn

# 设置：允许按需启动、无电源限制、失败可重启、无运行时限
$Settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit (New-TimeSpan -Seconds 0)

# 以当前用户身份、交互式登录运行（继承用户网络设置）
$Principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $Action `
    -Trigger $Trigger `
    -Settings $Settings `
    -Principal $Principal `
    -Description "校园网 Dr.COM 自动认证守护（schoolInternet 项目，无窗口运行）" | Out-Null

Write-Host "[OK] 已创建计划任务: $TaskName (无窗口模式)" -ForegroundColor Green
Write-Host "     登录 Windows 后将自动在后台静默运行守护进程，不弹窗口。"
Write-Host ""
Write-Host "  立即启动一次:  Start-ScheduledTask -TaskName $TaskName"
Write-Host "  停止:          Stop-ScheduledTask -TaskName $TaskName"
Write-Host "  移除自启:      powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1 -Remove"
