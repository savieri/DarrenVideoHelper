@echo off
setlocal EnableExtensions

set "EXTENSION_ID=mabnjnddplpelefjgohbjcoajnimpgna"
set "HOST_NAME=com.darren.videohelper"
set "ROOT_DIR=%~dp0"
set "EXTENSION_DIR=%ROOT_DIR%extension"
set "HOST_PATH=%ROOT_DIR%native\host.exe"
set "MANIFEST_PATH=%ROOT_DIR%native\com.darren.videohelper.json"
set "REG_KEY=HKCU\Software\Google\Chrome\NativeMessagingHosts\%HOST_NAME%"

echo Darren Video Helper
echo Universal Web Video Downloader
echo.

if not exist "%HOST_PATH%" (
  echo Missing native host executable:
  echo %HOST_PATH%
  echo.
  echo This package is incomplete. Build host.exe on Windows with PyInstaller or re-download DarrenVideoHelper-Windows.zip.
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$manifest = [ordered]@{ name='%HOST_NAME%'; description='Darren Video Helper Native Host'; path='%HOST_PATH%'; type='stdio'; allowed_origins=@('chrome-extension://%EXTENSION_ID%/') }; $manifest | ConvertTo-Json -Depth 4 | Set-Content -Encoding UTF8 '%MANIFEST_PATH%'"

reg add "%REG_KEY%" /ve /t REG_SZ /d "%MANIFEST_PATH%" /f >nul

echo Registered Native Messaging Host:
echo %MANIFEST_PATH%
echo.
"%HOST_PATH%" --self-test
echo.

start "" chrome://extensions/

echo Chrome extension folder to load:
echo %EXTENSION_DIR%
echo.
echo In Chrome:
echo 1. Enable Developer mode
echo 2. Click Load unpacked
echo 3. Select the extension folder above
echo.
pause
