!macro customInstall
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
