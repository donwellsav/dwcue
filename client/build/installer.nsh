!macro customInstall
  ; Earlier versions put a "DonWells Cue Server" shortcut on the desktop. It
  ; started a second, network-facing engine on the port the app itself uses,
  ; so the app could then not start its own. The app runs its engine itself;
  ; remove the shortcut when upgrading.
  Delete "$DESKTOP\DonWells Cue Server.lnk"
!macroend

!macro customUnInstall
  Delete "$DESKTOP\DonWells Cue Server.lnk"
!macroend
