@echo off
chcp 65001 >nul
setlocal
set "HERE=%~dp0"
set "ELECTRON=%HERE%runtime\electron\electron.exe"
if not exist "%ELECTRON%" set "ELECTRON=%HERE%node_modules\electron\dist\electron.exe"
if not exist "%ELECTRON%" set "ELECTRON=%USERPROFILE%\.dsh\electron\electron.exe"
if not exist "%ELECTRON%" (
  echo 找不到 Electron。请先在本目录运行 npm install，或把 Electron 43 放到 runtime\electron。
  pause
  exit /b 1
)
rem 以 Node 模式运行自带的 Electron，只启动陪伴服务并在浏览器里打开控制台
set ELECTRON_RUN_AS_NODE=1
"%ELECTRON%" "%HERE%launch.cjs" console
