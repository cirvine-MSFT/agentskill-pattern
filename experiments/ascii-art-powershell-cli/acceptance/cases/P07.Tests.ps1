param([Parameter(Mandatory)][string]$Workspace)
& (Join-Path (Split-Path -Parent $PSScriptRoot) 'Assert-Case.ps1') -CaseId P07 -Workspace $Workspace
exit $LASTEXITCODE
