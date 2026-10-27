@echo off
chcp 65001 >nul
setlocal
rem 在桌面创建「月下陪伴版」快捷方式：直接用自带的 Electron 启动桌宠，不弹黑色命令行窗口。
rem 可选参数：快捷方式放在哪个文件夹（默认是桌面）。
set "HERE=%~dp0"
set "LINKDIR=%~1"
powershell -NoProfile -Command "$h = $env:HERE.TrimEnd('\'); $dir = if ($env:LINKDIR) { $env:LINKDIR } else { [Environment]::GetFolderPath('Desktop') }; $link = Join-Path $dir ([string][char]0x6708 + [char]0x4E0B + [char]0x966A + [char]0x4F34 + [char]0x7248 + '.lnk'); $s = (New-Object -ComObject WScript.Shell).CreateShortcut($link); $s.TargetPath = Join-Path $h 'runtime\electron\electron.exe'; $s.Arguments = '\"' + (Join-Path $h 'desktop.cjs') + '\"'; $s.WorkingDirectory = $h; $s.IconLocation = (Join-Path $h 'yuexia.ico') + ',0'; $s.Save(); Write-Host $link"
if errorlevel 1 (
  echo 创建失败。
) else (
  echo 已创建快捷方式，双击即可启动月下。
)
if "%~1"=="" pause
