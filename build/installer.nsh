!macro customInit
  DetailPrint "Closing Insider & Whale Terminal..."
  nsExec::Exec 'taskkill /F /IM "insider-whale-terminal.exe" /T'
!macroend

!macro customUnInit
  DetailPrint "Closing Insider & Whale Terminal..."
  nsExec::Exec 'taskkill /F /IM "insider-whale-terminal.exe" /T'
!macroend
