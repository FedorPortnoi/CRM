@echo off
REM Nightly backup wrapper: take the dump, then put a copy on a second physical disk.
REM
REM backup.js writes to %USERPROFILE%\crm-backups, which lives on C: — the same disk
REM as the database it is backing up. A dump that only exists beside the thing it
REM protects is not a backup; a dead C: takes both. D: is a separate physical drive,
REM so this mirror survives that. It does NOT survive theft, fire, or the laptop
REM being lost, because both disks are in the same machine. Off-site is still owed.
REM
REM Registered as the scheduled task CRM-db-backup (daily 03:00).

cd /d "%~dp0..\.."
node deploy\local\backup.js
if errorlevel 1 (
  echo backup FAILED - not mirroring a dump that may not exist
  exit /b 1
)

if not exist "D:\" (
  echo D: not present - dump kept on C: only
  exit /b 0
)

if not exist "D:\crm-backups" mkdir "D:\crm-backups"
REM /XO skips files already copied; the dumps are immutable once written.
robocopy "%USERPROFILE%\crm-backups" "D:\crm-backups" *.dump /XO /R:2 /W:5 /NJH /NJS /NDL /NP
REM robocopy exit codes below 8 are success variants; 8+ is a real failure.
if %ERRORLEVEL% GEQ 8 exit /b 1
exit /b 0
