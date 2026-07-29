# ASCII-art PowerShell CLI delegation benchmark

This directory preregisters a paired benchmark of 60 fresh GitHub Copilot sessions. Ten independent prompts each ask a GPT-5.6 Sol parent to add one meaningful feature to the same clean PowerShell CLI fixture and create one task-specific ASCII banner. Each prompt is observed three times under each condition.

| Condition | Observations | Parent behavior |
|---|---:|---|
| Control | 30 | The GPT-5.6 Sol parent performs all implementation, testing, and banner work. |
| Treatment | 30 | The GPT-5.6 Sol parent performs implementation and testing, but delegates only the banner asset to one Claude Haiku 4.5 nested session that writes the asset directly into the observation workspace. |

The task text in `prompts.json` is byte-identical across conditions. Condition instructions are injected by the coordinator and never added to the prompt. No active Agent Skill, custom-agent definition, measured output, or model trial is stored here.

## Quick start

Requires Windows_NT, PowerShell 7+, and Node.js 20+. Windows job objects are the normative process-tree isolation mechanism. Measured sessions need no package installation or network setup.

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

An intentional no-result foundation smoke test may add `--allow-incomplete`; its summary is labeled
`empty_foundation_dry_run`, and every outcome with incomplete prompt clusters withholds its interval.
The same flag produces descriptive diagnostics when both allowed attempts for a planned schedule are
excluded for infrastructure reasons. The schedule remains one of 60 planned IDs, is reported with both
exclusion reasons, has no artifact/judgment requirement, and globally withholds inferential output.
If no parent session is created, record the attempt with the dedicated pre-execution failure schema:
`phase=pre_execution`, `status=excluded`, and `availability=not_created`. Do not fabricate session IDs,
telemetry, deterministic results, commits, artifacts, condition evidence, or outcomes. A started attempt
instead uses `phase=session_started` and requires telemetry plus deterministic evidence even when excluded.

Before judging, generate blinded bundles directly from exact-byte-authenticated selected source artifacts and bind them to selected runs:

```powershell
node .\experiments\ascii-art-powershell-cli\scripts\bind-blind-bundles.js `
  --runs .\experiments\ascii-art-powershell-cli\raw `
  --artifacts .\experiments\ascii-art-powershell-cli\artifacts `
  --out .\experiments\ascii-art-powershell-cli\artifacts
```

Blind generation rejects high-confidence candidate provenance phrases that reveal delegation,
specialist/subagent use, condition arms, trial sessions, or model routing while allowing ordinary task
language such as control flow, treatment plans, session caches, and data models. Control parent-wait
latency is unavailable; treatment parent wait is accepted only when it exactly reconciles to authenticated
delegation call/result timestamps. Exact forbidden values and candidate string leaves/keys are compared
through bounded, deterministic canonical variants: Unicode NFKC plus locale-independent lowercase,
normalized path separators, and up to two safe JSON-style escape-decoding passes. This rejects encoded
Unicode (including surrogate pairs), escaped quotes/slashes/backslashes, doubled Windows separators,
path-style variants, and decoded case variants without interpreting code, percent encoding, or base64;
malformed escapes remain literal.

See `protocol.md` for the immutable preregistration, telemetry definitions, exclusions, judging, and analysis.
