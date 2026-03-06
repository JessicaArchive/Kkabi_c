@echo off
title Kkabi_c
cd /d "C:\Users\kyjs0\Documents\Work\AI_Platform\Kkabi_c"

:: Check if Kkabi_c is already running (port 3000)
netstat -ano | findstr ":3000.*LISTENING" >nul 2>&1
if %errorlevel%==0 (
    echo [!] Kkabi_c is already running on port 3000.
    echo.
    choice /C YN /M "Kill existing process and restart?"
    if errorlevel 2 (
        echo Aborted.
        pause
        exit /b
    )
    for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":3000.*LISTENING"') do (
        echo Killing PID %%a...
        taskkill /PID %%a /F >nul 2>&1
    )
    timeout /t 2 /nobreak >nul
)

echo Starting Kkabi_c...
node --import tsx src/index.ts
pause
