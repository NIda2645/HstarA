#define MyAppName "Hstar"
#define MyEdition "Windows11"
#define MyAppPublisher "Hstar"
#define MyAppExeName "Hstar.exe"
#define MyAppMutex "Local\Hstar.Windows11"
#define SourceRoot "stage\windows11"
#ifndef MyAppVersion
  #error MyAppVersion must be passed by the build command from the repository VERSION file
#endif

[Setup]
AppId={{7D2E8423-5B6B-48EC-A986-5E8B57EE3A11}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppVerName={#MyAppName} {#MyEdition} {#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppMutex={#MyAppMutex}
DefaultDirName={localappdata}\Programs\Hstar
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0.22000
OutputDir=..\release\windows11
OutputBaseFilename=Hstar_Windows11_Setup_{#MyAppVersion}
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
CloseApplications=no
RestartApplications=no
UsePreviousAppDir=yes
UsePreviousGroup=yes
UsePreviousLanguage=yes
UsePreviousTasks=yes
UninstallDisplayIcon={app}\{#MyAppExeName}

[Languages]
Name: "chinesesimplified"; MessagesFile: "languages\ChineseSimplified.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式"; GroupDescription: "快捷方式"; Flags: checkedonce
Name: "updateapiconfig"; Description: "更新 API 配置（保留已有密钥和自定义服务商）"; GroupDescription: "API 配置"; Flags: unchecked

[Files]
Source: "{#SourceRoot}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; WorkingDir: "{app}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#MyAppExeName}"; Parameters: "--maintenance=update-api-config"; Flags: runhidden waituntilterminated; Tasks: updateapiconfig
Filename: "{app}\{#MyAppExeName}"; Description: "启动 {#MyAppName}"; WorkingDir: "{app}"; Flags: nowait postinstall skipifsilent

[Code]
const
  MyAppMutex = '{#MyAppMutex}';

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ExistingExecutable: String;
  ResultCode: Integer;
  Attempt: Integer;
begin
  Result := '';
  if not CheckForMutexes(MyAppMutex) then
    exit;

  ExistingExecutable := ExpandConstant('{app}\{#MyAppExeName}');
  if not FileExists(ExistingExecutable) then begin
    Result := 'Hstar Windows 11 正在运行，请先关闭软件后再继续安装。';
    exit;
  end;

  if (not Exec(
      ExistingExecutable,
      '--maintenance=shutdown',
      ExpandConstant('{app}'),
      SW_HIDE,
      ewWaitUntilTerminated,
      ResultCode)) or (ResultCode <> 0) then begin
    Result := '无法安全关闭正在运行的 Hstar Windows 11。';
    exit;
  end;

  for Attempt := 1 to 100 do begin
    if not CheckForMutexes(MyAppMutex) then
      exit;
    Sleep(100);
  end;
  Result := 'Hstar Windows 11 未能在 10 秒内完成关闭，请稍后重试。';
end;
