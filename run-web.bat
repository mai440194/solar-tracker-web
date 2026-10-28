@echo off
title Solar Tracker Web Server
cd /d "%~dp0"
echo Dang chay web server tai http://localhost:8000
echo Dong cua so nay = dung server.
start "" cmd /c "timeout /t 2 >nul & start "" http://localhost:8000"
python -m http.server 8000
pause
