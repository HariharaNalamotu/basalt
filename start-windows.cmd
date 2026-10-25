@echo off
rem Double-click to start Basalt on Windows. It runs start.sh inside WSL (Windows Subsystem for Linux),
rem with Docker Desktop providing Docker. Pass --no-build or --stop like start.sh.
setlocal
cd /d "%~dp0"

where wsl >nul 2>nul
if errorlevel 1 goto nowsl
wsl -e true >nul 2>nul
if errorlevel 1 goto nodistro
where docker >nul 2>nul
if errorlevel 1 goto nodocker

docker info >nul 2>nul
if not errorlevel 1 goto ready
echo Starting Docker Desktop...
if exist "%ProgramFiles%\Docker\Docker\Docker Desktop.exe" start "" "%ProgramFiles%\Docker\Docker\Docker Desktop.exe"
set /a tries=0
:waitdocker
timeout /t 3 /nobreak >nul
docker info >nul 2>nul
if not errorlevel 1 goto ready
set /a tries+=1
if %tries% lss 60 goto waitdocker
echo Docker Desktop did not start. Open it yourself, wait until it says it is running, then run this again.
goto end

:ready
rem A Windows checkout can give the shell scripts Windows line endings, which bash cannot run.
wsl --cd "%~dp0." -e sh -c "sed -i 's/\r$//' start.sh hosting/deploy/*.sh"
wsl --cd "%~dp0." -e bash ./start.sh %*
goto end

:nowsl
echo Basalt needs WSL. Open PowerShell as administrator, run:  wsl --install
echo then restart the computer and run this again.
goto end
:nodistro
echo WSL has no Linux installed yet. Open PowerShell and run:  wsl --install -d Ubuntu
echo then run this again.
goto end
:nodocker
echo Basalt needs Docker Desktop: https://www.docker.com/products/docker-desktop/
echo Install it, turn on Settings ^> Resources ^> WSL integration for Ubuntu, then run this again.
goto end

:end
echo.
pause
