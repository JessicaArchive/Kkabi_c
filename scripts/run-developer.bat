@echo off
cd /d "C:\Users\kyjs0\Documents\Work\AI_Platform\playground-fc"
claude -p "Execute the developer routine. Read data/prompts/developer.md for instructions and follow them exactly." --dangerously-skip-permissions > "%USERPROFILE%\Documents\Work\AI_Platform\Kkabi_c\data\logs\developer-%date:~0,4%%date:~5,2%%date:~8,2%-%time:~0,2%%time:~3,2%.log" 2>&1
