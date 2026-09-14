@echo off
REM Start the local web app, then open the browser.
REM Kills any stale server already on port 5000 first (avoids two servers
REM fighting over the port and serving stale code/templates).
cd /d "%~dp0"

for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":5000" ^| findstr "LISTENING"') do (
  echo [start_server] killing stale process on port 5000: PID %%a
  taskkill /PID %%a /F >nul 2>&1
)
timeout /t 1 /nobreak >nul

start "" http://127.0.0.1:5000
".venv\Scripts\python.exe" app.py
