@echo off
REM 一键启动前后端（Windows）
REM 用法: start-dev.bat  [--port 8787] [--web-port 5273] [--no-open] [--build]
cd /d "%~dp0"
node scripts\dev.mjs %*
