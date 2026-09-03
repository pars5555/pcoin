@echo off
REM Build PCoinWallet.exe - the PCoin wallet for Windows.
REM
REM The same compiler and the same shared sources as build.bat (the miner
REM tray); only the entry point and the screens differ. Two batch files rather
REM than a /define: each exe compiles exactly the files it needs, and the tray
REM build is left byte-for-byte as it was. Anything money-related lives in the
REM shared files and is covered by `PCoinWallet.exe --selftest`, which must be
REM green before the exe is shipped anywhere.

setlocal
set CSC=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe
if not exist "%CSC%" set CSC=%WINDIR%\Microsoft.NET\Framework\v4.0.30319\csc.exe
if not exist "%CSC%" (
  echo Could not find csc.exe from the .NET Framework.
  exit /b 1
)

set FW=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319
if not exist "%FW%\WPF\PresentationFramework.dll" set FW=%WINDIR%\Microsoft.NET\Framework\v4.0.30319
if not exist "%FW%\WPF\PresentationFramework.dll" (
  echo Could not find the WPF assemblies under %FW%\WPF.
  exit /b 1
)

"%CSC%" /nologo /target:winexe /optimize+ /out:PCoinWallet.exe ^
  /win32icon:pcoin.ico ^
  /win32manifest:PCoinWallet.manifest ^
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
  PCoinWallet.cs ^
  WalletWindow.cs ^
  WalletForms.cs ^
  ForwardPolicy.cs ^
  ForwardStore.cs ^
  ForwardEngine.cs ^
  SeedCrypto.cs ^
  SeedKeys.cs ^
  SeedRpc.cs ^
  SeedStore.cs ^
  SeedWallet.cs ^
  SeedForms.cs ^
  SeedSelfTest.cs ^
  Amounts.cs ^
  AddressBook.cs ^
  AddressBookStore.cs ^
  QrCode.cs ^
  Bip39Wordlist.cs

if errorlevel 1 exit /b 1
echo Built PCoinWallet.exe
endlocal
