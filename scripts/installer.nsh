!macro customInstall
  ExecWait '"$INSTDIR\\${APP_EXECUTABLE_FILENAME}" --install-updater-service'
!macroend

!macro customUnInstall
  ExecWait '"$INSTDIR\\${APP_EXECUTABLE_FILENAME}" --uninstall-updater-service'
!macroend
