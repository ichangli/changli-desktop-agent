@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist "node_modules\electron" (
  echo 请先在本目录运行 npm ci 安装依赖。
  pause
  exit /b 1
)
call npm run build
if errorlevel 1 (
  echo 构建失败，请查看上方错误信息。
  pause
  exit /b 1
)
call npm start
if errorlevel 1 pause
