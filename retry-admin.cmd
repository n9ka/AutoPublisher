@echo off
setlocal
cd /d "%~dp0"

echo ==========================================
echo   Aspy - Publish Retry Admin (local)
echo ==========================================
echo.

node src\retry-admin.js
set EXIT_CODE=%ERRORLEVEL%

echo.
if not "%EXIT_CODE%"=="0" (
  echo Le script s'est termine avec le code %EXIT_CODE%.
)
pause
exit /b %EXIT_CODE%
