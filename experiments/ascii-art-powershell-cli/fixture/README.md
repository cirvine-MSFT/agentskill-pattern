# TaskForge fixture

TaskForge is a dependency-free PowerShell 7 CLI with JSON-file persistence.

```powershell
pwsh -NoProfile -File .\src\TaskForge.ps1 add --title "Ship release" --description "Tag and publish"
pwsh -NoProfile -File .\src\TaskForge.ps1 list
pwsh -NoProfile -File .\src\TaskForge.ps1 complete --id 1
pwsh -NoProfile -File .\src\TaskForge.ps1 remove --id 1
pwsh -NoProfile -File .\tests\Run-Tests.ps1
```

Use `--data-file PATH` to isolate storage and `--json` for machine-readable output. Feature prompts start from this exact fixture independently.
