@echo off
chcp 65001 >nul
setlocal
set "HERE=%~dp0"
rem 只用陪伴版自带的 Electron（runtime\electron 或 npm 安装的 node_modules），不需要另装 Node 或 DSH
set "ELECTRON=%HERE%runtime\electron\electron.exe"
if not exist "%ELECTRON%" set "ELECTRON=%HERE%node_modules\electron\dist\electron.exe"
if not exist "%ELECTRON%" set "ELECTRON=%USERPROFILE%\.dsh\electron\electron.exe"
if not exist "%ELECTRON%" (
  echo 找不到 Electron。请先在本目录运行 npm install，或把 Electron 43 放到 runtime\electron。
  pause
  exit /b 1
)
set ELECTRON_RUN_AS_NODE=
start "" "%ELECTRON%" "%HERE%desktop.cjs" %*
