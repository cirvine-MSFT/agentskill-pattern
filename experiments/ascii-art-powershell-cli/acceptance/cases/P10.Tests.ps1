param([Parameter(Mandatory)][string]$Workspace)
& (Join-Path (Split-Path -Parent $PSScriptRoot) 'Assert-Case.ps1') -CaseId P10 -Workspace $Workspace
exit $LASTEXITCODE
