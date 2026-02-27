' Kkabi_c WSL 실행 스크립트 (선택)
' 이 스크립트는 WSL에서 까비를 백그라운드로 실행합니다.

Set WshShell = CreateObject("WScript.Shell")
WshShell.Run "wsl -d Ubuntu -- bash -c 'cd ~/Kkabi_c && npm start'", 0, False
Set WshShell = Nothing
