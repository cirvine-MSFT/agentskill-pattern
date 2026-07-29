param([Parameter(Mandatory)][string]$Workspace)
& (Join-Path (Split-Path -Parent $PSScriptRoot) 'Assert-Case.ps1') -CaseId P05 -Workspace $Workspace
exit $LASTEXITCODE
