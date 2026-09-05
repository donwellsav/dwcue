!macro customInstall
  ; Desktop shortcut for DonWells Cue Server
  CreateShortcut "$DESKTOP\DonWells Cue Server.lnk" \
    "$INSTDIR\resources\server-bin\dwcue-server.exe" \
    "--port 4480 --bind 0.0.0.0" \
    "$INSTDIR\resources\server-bin\dwcue-server.exe" 0

!macroend

!macro customUnInstall
  Delete "$DESKTOP\DonWells Cue Server.lnk"
!macroend
