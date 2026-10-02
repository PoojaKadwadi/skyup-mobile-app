@echo off
REM ── SkyUp CRM : build installable APK on Windows ─────────────────────────
REM Needs: Node 18+, JDK 17, Android SDK (default D:\Android\Sdk)
REM Output: android\app\build\outputs\apk\release\SkyUpCRM-v1.1.0.apk
setlocal
cd /d "%~dp0"

if "%ANDROID_HOME%"=="" set "ANDROID_HOME=D:\Android\Sdk"
if not exist "%ANDROID_HOME%" (
  echo [X] Android SDK not found at %ANDROID_HOME%. Set ANDROID_HOME and re-run.
  pause & exit /b 1
)
echo sdk.dir=%ANDROID_HOME:\=\\%> android\local.properties

if not exist android\app\google-services.json (
  echo [!] android\app\google-services.json missing - app will build but push notifications won't work.
)

echo [1/3] Installing packages...
call npm install --no-audit --no-fund || goto :fail

echo [2/3] Cleaning old build...
cd android
call gradlew.bat clean || goto :fail

echo [3/3] Building release APK...
call gradlew.bat assembleRelease || goto :fail
cd ..

echo.
echo DONE  ->  android\app\build\outputs\apk\release\
explorer "android\app\build\outputs\apk\release"
pause
exit /b 0

:fail
echo.
echo [X] Build failed - scroll up for the first red error line.
pause
exit /b 1
