@echo off
setlocal EnableExtensions

set "HOST_NAME=com.darren.videohelper"
set "ROOT_DIR=%~dp0"
set "MANIFEST_PATH=%ROOT_DIR%native\com.darren.videohelper.json"
set "REG_KEY=HKCU\Software\Google\Chrome\NativeMessagingHosts\%HOST_NAME%"

echo Darren Video Helper uninstall
echo.

reg delete "%REG_KEY%" /f >nul 2>nul
if exist "%MANIFEST_PATH%" del "%MANIFEST_PATH%" >nul 2>nul

echo Removed Native Messaging Host registration if it existed.
echo You can remove the Chrome extension from chrome://extensions/.
echo.
pause
