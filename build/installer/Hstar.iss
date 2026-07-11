#define MyAppName "Hstar"
#define MyAppVersion "2026.07.11"
#define MyAppPublisher "Hstar"
#define MyAppExeName "Hstar.exe"
#define SourceRoot "stage"

[Setup]
AppId={{B41E0B38-7D96-49FD-95BC-781C568F9E18}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppVerName={#MyAppName} {#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName=D:\Hstar
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
OutputDir=..\..\..
OutputBaseFilename=Hstar_Setup_2026.07.11
SetupIconFile={#SourceRoot}\Hstar.ico
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
ArchitecturesInstallIn64BitMode=x64compatible
PrivilegesRequired=lowest
UninstallDisplayIcon={app}\{#MyAppExeName}
CloseApplications=yes
CloseApplicationsFilter=Hstar.exe,python.exe
RestartApplications=no

[Languages]
Name: "chinesesimplified"; MessagesFile: "compiler:Languages\ChineseSimplified.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Create desktop shortcut"; GroupDescription: "Shortcuts:"; Flags: checkedonce
Name: "overwriteapidata"; Description: "Overwrite API config data while preserving saved local keys"; GroupDescription: "API data:"; Flags: unchecked

[Files]
Source: "{#SourceRoot}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs; Excludes: ".gitignore,API\.env,API\api.env.template,data\api_providers.json,*.log,logs\*,output\*,assets\input\*,assets\library\*,assets\output\*,assets\uploads\*,*\__pycache__\*,*.pyc,*.pyo,unins*.dat,unins*.exe,tools\tests\*,tools\probe-baofu-max-size.mjs,tools\test-baofu-4k-matrix.mjs"
Source: "{#SourceRoot}\API\api.env.template"; DestDir: "{app}\API"; DestName: ".env"; Flags: ignoreversion; Tasks: overwriteapidata
Source: "{#SourceRoot}\data\api_providers.json"; DestDir: "{app}\data"; Flags: ignoreversion skipifsourcedoesntexist; Tasks: overwriteapidata

[InstallDelete]
Type: files; Name: "{app}\static\assets"
Type: files; Name: "{app}\hstar_local_stdout.log"
Type: files; Name: "{app}\hstar_local_stderr.log"

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; WorkingDir: "{app}"; IconFilename: "{app}\Hstar.ico"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; WorkingDir: "{app}"; IconFilename: "{app}\Hstar.ico"; Tasks: desktopicon

[Run]
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\tools\merge-api-env.ps1"" -Old ""{code:GetApiEnvBackupPath}"" -New ""{app}\API\.env"""; Flags: runhidden waituntilterminated; Tasks: overwriteapidata
Filename: "{app}\{#MyAppExeName}"; Description: "Launch {#MyAppName}"; Flags: nowait postinstall skipifsilent unchecked

[Code]
procedure KillHstarIfRunning;
var
  ResultCode: Integer;
begin
  Exec(ExpandConstant('{cmd}'), '/C taskkill /F /IM Hstar.exe >nul 2>nul', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
end;

function GetApiEnvBackupPath(Param: String): String;
begin
  Result := ExpandConstant('{app}\API\.env.backup-hstar-install');
end;

procedure BackupFileIfExists(FilePath: String);
var
  BackupPath: String;
begin
  if FileExists(FilePath) then begin
    BackupPath := FilePath + '.backup-' + GetDateTimeString('yyyymmdd-hhnnss', '-', '-');
    CopyFile(FilePath, BackupPath, False);
  end;
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssInstall then begin
    KillHstarIfRunning;
    if WizardIsTaskSelected('overwriteapidata') then begin
      if FileExists(ExpandConstant('{app}\API\.env')) then begin
        CopyFile(ExpandConstant('{app}\API\.env'), GetApiEnvBackupPath(''), False);
      end;
      BackupFileIfExists(ExpandConstant('{app}\API\.env'));
      BackupFileIfExists(ExpandConstant('{app}\data\api_providers.json'));
    end;
  end;
end;
