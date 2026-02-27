@echo off
echo ============================================
echo   Kkabi_c 설치 스크립트 (Windows)
echo ============================================
echo.

:: Check Node.js
where node >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo [ERROR] Node.js가 설치되어 있지 않습니다.
    echo https://nodejs.org 에서 다운로드하세요.
    pause
    exit /b 1
)

for /f "tokens=*" %%i in ('node --version') do set NODE_VER=%%i
echo [OK] Node.js %NODE_VER% 감지

:: Check npm
where npm >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo [ERROR] npm이 설치되어 있지 않습니다.
    pause
    exit /b 1
)

:: Install dependencies
echo.
echo 의존성 설치 중...
cd /d "%~dp0.."
call npm install
if %ERRORLEVEL% neq 0 (
    echo [ERROR] npm install 실패
    pause
    exit /b 1
)

:: Create data directories
if not exist "data" mkdir data
if not exist "data\memory\logs" mkdir data\memory\logs
if not exist "data\persona" mkdir data\persona
if not exist "data\uploads" mkdir data\uploads

:: Check config
if not exist "config.json" (
    echo.
    echo [주의] config.json이 없습니다.
    echo config.example.json을 복사하여 config.json을 만들어주세요.
    copy config.example.json config.json
    echo config.json 생성 완료 - 토큰을 수정해주세요!
)

echo.
echo ============================================
echo   설치 완료!
echo   실행: npm start
echo ============================================
pause
