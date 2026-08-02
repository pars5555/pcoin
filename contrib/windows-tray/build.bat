@echo off
REM Build the PCoin miner tray app.
REM
REM Uses the C# compiler that ships with the .NET Framework, which is present on
REM every Windows 10/11 machine, so there is nothing to install either to build
REM this or to run the result.

setlocal
set CSC=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe
if not exist "%CSC%" set CSC=%WINDIR%\Microsoft.NET\Framework\v4.0.30319\csc.exe
if not exist "%CSC%" (
  echo Could not find csc.exe from the .NET Framework.
  exit /b 1
)

"%CSC%" /nologo /target:winexe /optimize+ /out:PCoinTray.exe ^
  /reference:System.dll ^
  /reference:System.Drawing.dll ^
  /reference:System.Windows.Forms.dll ^
  PCoinTray.cs

if errorlevel 1 exit /b 1
echo Built PCoinTray.exe
endlocal
