!ifndef BUILD_UNINSTALLER
  !include nsDialogs.nsh
  !include LogicLib.nsh

Var PACS_DATA_DIR
Var PACS_DATA_DIR_CONTROL

!macro customPageAfterChangeDir
  Page custom PACSDataDirPage PACSDataDirPageLeave
!macroend

Function PACSDataDirPage
  ReadRegStr $PACS_DATA_DIR HKLM "SOFTWARE\PACS CHX" "DataDir"
  ${If} $PACS_DATA_DIR == ""
    ReadRegStr $0 HKLM "SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer\Shell Folders" "Common AppData"
    StrCpy $PACS_DATA_DIR "$0\PACS CHX"
  ${EndIf}

  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}
  ${NSD_CreateLabel} 0 0 100% 30u "Escolha onde o PACS CHX vai guardar configuração, banco de dados, chave de criptografia, exames e logs. Essa pasta será preservada ao desinstalar. Em atualizações, mantenha a pasta anterior para continuar usando os mesmos dados."
  Pop $0
  ${NSD_CreateText} 0 38u 76% 13u "$PACS_DATA_DIR"
  Pop $PACS_DATA_DIR_CONTROL
  ${NSD_CreateBrowseButton} 78% 37u 22% 15u "Procurar..."
  Pop $0
  ${NSD_OnClick} $0 PACSDataDirBrowse
  nsDialogs::Show
FunctionEnd

Function PACSDataDirBrowse
  nsDialogs::SelectFolderDialog "Selecione a pasta de dados do PACS CHX" "$PACS_DATA_DIR"
  Pop $0
  ${If} $0 != ""
    ${NSD_SetText} $PACS_DATA_DIR_CONTROL "$0"
  ${EndIf}
FunctionEnd

Function PACSDataDirPageLeave
  ${NSD_GetText} $PACS_DATA_DIR_CONTROL $PACS_DATA_DIR
  ${If} $PACS_DATA_DIR == ""
    MessageBox MB_ICONEXCLAMATION|MB_OK "Informe a pasta onde os dados do PACS CHX serão guardados."
    Abort
  ${EndIf}
FunctionEnd
!endif

!macro customInit
  DetailPrint "Parando PACS CHX Server para atualizar os arquivos..."
  nsExec::ExecToLog '"$SYSDIR\sc.exe" stop "PACS CHX Server"'
  Sleep 1000

  ; A versao anterior guardava a licenca dentro da pasta do aplicativo. Copie
  ; para a pasta persistente antes que o instalador remova os arquivos antigos.
  ReadRegStr $0 HKLM "SOFTWARE\PACS CHX" "DataDir"
  StrCmp $0 "" 0 pacsLicenseDataDirReady
  ReadRegStr $0 HKLM "SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer\Shell Folders" "Common AppData"
  StrCpy $0 "$0\PACS CHX"
pacsLicenseDataDirReady:
  CreateDirectory "$0"
  IfFileExists "$0\license.json" pacsLicenseStateReady
  IfFileExists "$INSTDIR\resources\app.asar.unpacked\server\license.json" 0 pacsLicenseStateReady
  CopyFiles /SILENT "$INSTDIR\resources\app.asar.unpacked\server\license.json" "$0"
  IfErrors pacsLicenseMigrationFailed
pacsLicenseStateReady:
  IfFileExists "$0\license-clock.enc" pacsLicenseClockReady
  IfFileExists "$INSTDIR\resources\app.asar.unpacked\server\license-clock.enc" 0 pacsLicenseClockReady
  CopyFiles /SILENT "$INSTDIR\resources\app.asar.unpacked\server\license-clock.enc" "$0"
  IfErrors pacsLicenseMigrationFailed
pacsLicenseClockReady:
  Goto pacsLicenseMigrationDone
pacsLicenseMigrationFailed:
  MessageBox MB_ICONSTOP "Nao foi possivel preservar o estado da licenca. A atualizacao foi cancelada para evitar perda da licenca. Verifique as permissoes da pasta de dados e tente novamente."
  Abort
pacsLicenseMigrationDone:
!macroend
!macro customInstall
  CreateDirectory "$PACS_DATA_DIR"
  WriteRegStr HKLM "SOFTWARE\PACS CHX" "DataDir" "$PACS_DATA_DIR"
  DetailPrint "Instalando PACS CHX Server Service..."
  nsExec::ExecToLog '"$SYSDIR\sc.exe" stop "PACS CHX Server"'
  nsExec::ExecToLog '"$SYSDIR\sc.exe" delete "PACS CHX Server"'
  Sleep 1000
  nsExec::ExecToLog '"$SYSDIR\sc.exe" create "PACS CHX Server" binPath= "\"$INSTDIR\resources\service\PacsChxServiceHost.exe\"" start= auto DisplayName= "PACS CHX Server"'
  nsExec::ExecToLog '"$SYSDIR\sc.exe" description "PACS CHX Server" "Servidor local PACS CHX: DICOM SCP, API, banco, storage, licenca e logs."'
  nsExec::ExecToLog '"$SYSDIR\sc.exe" failure "PACS CHX Server" reset= 60 actions= restart/60000/restart/60000/""/60000'
  nsExec::ExecToLog '"$SYSDIR\sc.exe" start "PACS CHX Server"'
!macroend

!macro customUnInstall
  DetailPrint "Removendo PACS CHX Server Service..."
  nsExec::ExecToLog '"$SYSDIR\sc.exe" stop "PACS CHX Server"'
  Sleep 1000
  nsExec::ExecToLog '"$SYSDIR\sc.exe" delete "PACS CHX Server"'
!macroend
