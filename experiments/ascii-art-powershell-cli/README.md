# ASCII-art PowerShell CLI delegation benchmark

This directory preregisters a paired benchmark of 60 fresh GitHub Copilot sessions. Ten independent prompts each ask a GPT-5.6 Sol parent to add one meaningful feature to the same clean PowerShell CLI fixture and create one task-specific ASCII banner. Each prompt is observed three times under each condition.

| Condition | Observations | Parent behavior |
|---|---:|---|
| Control | 30 | The GPT-5.6 Sol parent performs all implementation, testing, and banner work. |
| Treatment | 30 | The GPT-5.6 Sol parent performs implementation and testing, but delegates only the banner asset to one Claude Haiku 4.5 nested session that writes the asset directly into the observation workspace. |

The task text in `prompts.json` is byte-identical across conditions. Condition instructions are injected by the coordinator and never added to the prompt. No active Agent Skill, custom-agent definition, measured output, or model trial is stored here.

## Quick start

Requires PowerShell 7+ and Node.js 20+. Measured sessions need no package installation or network setup.

```powershell
pwsh -NoProfile -File .\experiments\ascii-art-powershell-cli\scripts\preflight.ps1
node .\experiments\ascii-art-powershell-cli\scripts\randomize.js --check
node .\experiments\ascii-art-powershell-cli\scripts\create-judge-assignments.js --check
node .\experiments\ascii-art-powershell-cli\scripts\validate-dataset.js
node .\experiments\ascii-art-powershell-cli\scripts\tests\run-tests.js
pwsh -NoProfile -File .\experiments\ascii-art-powershell-cli\scripts\tests\Run-AcceptanceHarness.Tests.ps1
pwsh -NoProfile -File .\experiments\ascii-art-powershell-cli\fixture\tests\Run-Tests.ps1
```

Acceptance tests are held outside the candidate workspace. For a completed observation:

```powershell
pwsh -NoProfile -File .\experiments\ascii-art-powershell-cli\acceptance\cases\P01.Tests.ps1 `
  -Workspace C:\path\to\observation\fixture
node .\experiments\ascii-art-powershell-cli\scripts\validate-art.js `
  --prompt P01 --workspace C:\path\to\observation\fixture
```

Generate analysis only after complete, validated raw data exists:

```powershell
node .\experiments\ascii-art-powershell-cli\scripts\summarize.js `
  --runs .\experiments\ascii-art-powershell-cli\raw `
  --artifacts .\experiments\ascii-art-powershell-cli\artifacts `
  --judgments .\experiments\ascii-art-powershell-cli\judgments `
  --out .\experiments\ascii-art-powershell-cli\results\summary.json
```

Before judging, materialize the blinded bundle files and bind them to the selected runs and source artifact hashes:

```powershell
node .\experiments\ascii-art-powershell-cli\scripts\bind-blind-bundles.js `
  --runs .\experiments\ascii-art-powershell-cli\raw `
  --artifacts .\experiments\ascii-art-powershell-cli\artifacts `
  --blind-bundles C:\path\to\blind-bundles `
  --out .\experiments\ascii-art-powershell-cli\artifacts
```

See `protocol.md` for the immutable preregistration, telemetry definitions, exclusions, judging, and analysis.
