@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 国际物流报价助手 - 本地服务

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   未检测到 Node.js，无法启动本地服务。
  echo   请先安装 Node.js（https://nodejs.org/），再双击本文件。
  echo.
  pause
  exit /b 1
)

node serve.js
pause
