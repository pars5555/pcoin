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

REM System.Numerics is needed for secp256k1 arithmetic and System.Security for
REM DPAPI, which protects the stored recovery phrase. Both ship with the .NET
REM Framework; nothing here comes from NuGet.
REM
REM The WPF assemblies for the main window are not in the compiler's own
REM directory - they sit in the WPF subfolder of the same framework install, so
REM they have to be referenced by path. They are part of the .NET Framework, so
REM every machine that can run the rest of this app already has them.
set FW=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319
if not exist "%FW%\WPF\PresentationFramework.dll" set FW=%WINDIR%\Microsoft.NET\Framework\v4.0.30319
if not exist "%FW%\WPF\PresentationFramework.dll" (
  echo Could not find the WPF assemblies under %FW%\WPF.
  exit /b 1
)

"%CSC%" /nologo /target:winexe /optimize+ /out:PCoinTray.exe ^
  /win32manifest:PCoinTray.manifest ^
  /reference:System.dll ^
  /reference:System.Core.dll ^
  /reference:System.Drawing.dll ^
  /reference:System.Numerics.dll ^
  /reference:System.Security.dll ^
  /reference:System.Windows.Forms.dll ^
  /reference:System.Xaml.dll ^
  /reference:"%FW%\WPF\WindowsBase.dll" ^
  /reference:"%FW%\WPF\PresentationCore.dll" ^
  /reference:"%FW%\WPF\PresentationFramework.dll" ^
  PCoinTray.cs ^
  MinerWindow.cs ^
  SeedCrypto.cs ^
  SeedKeys.cs ^
  SeedRpc.cs ^
  SeedStore.cs ^
  SeedWallet.cs ^
  SeedForms.cs ^
  SeedSelfTest.cs ^
  Bip39Wordlist.cs

if errorlevel 1 exit /b 1
echo Built PCoinTray.exe
endlocal
