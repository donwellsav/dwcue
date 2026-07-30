!macro customInstall
  ; Desktop shortcut for DW Cue Server
  CreateShortcut "$DESKTOP\DW Cue Server.lnk" \
    "$INSTDIR\resources\server-bin\dwcue-server.exe" \
    "--port 4480 --bind 0.0.0.0" \
    "$INSTDIR\resources\server-bin\dwcue-server.exe" 0

!macroend

!macro customUnInstall
  Delete "$DESKTOP\DW Cue Server.lnk"
!macroend
