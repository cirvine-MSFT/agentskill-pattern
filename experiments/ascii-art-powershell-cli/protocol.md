# ASCII-art benchmark protocol

## Identity and question

- Protocol: `ascii-art-powershell-cli-v1`
- Registered start: `71635d9f6ba1e54e81e9f1f3eb081e51187e66bd`
- Parent: `gpt-5.6-sol`
- Treatment worker: `claude-haiku-4.5`
- Runtime target: Copilot CLI 1.0.71 on Windows

Question: when a larger PowerShell CLI task contains one separable ASCII-banner
subtask, does delegating only that banner reduce parent context and total cost without
materially reducing functional or visual quality?

## Design

The preregistered design paired 10 prompts by three repetitions and two conditions:
60 planned fresh sessions. `design/randomization.json` freezes the order.

| Condition | Required behavior |
| --- | --- |
| Control | Parent implements, tests, and creates the banner. No delegation. |
| Treatment | Parent implements and tests, but delegates exactly the registered banner path to one worker. |

Task text, fixture bytes, parent model, runtime limits, and external checks were shared.
Candidate sessions could not read the held-out acceptance directory. Infrastructure
failures could be retried once; started implementation failures remained intent-to-treat.
All treatment-minus-control estimates used only prompt/repetition pairs with both
outcomes available.

## Outcomes

Primary resource outcomes were combined and parent AI credits/nano-AIU, parent
cumulative and peak input, parent output, and wall time. Combined cost includes parent
and worker; external judge use is excluded.

Quality was assessed outside the parent:

1. repository-owned acceptance scripts executed CLI behavior and validated the banner;
2. blinded judging scored function, code quality, integration, recognizability,
   composition, and cleanliness on 1-5 scales.

The preregistered efficiency markers required total nano-AIU at least 10% lower and
parent cumulative input at least 15% lower. Noninferiority and art-quality outcomes
were descriptive only if the planned paired dataset was incomplete.

## Integrity and retained provenance

The retained files bind the meaningful surviving artifacts:

- prompts SHA-256: `b9f218b8d744803c30aad7f52dee06eaa10d2fce2191668b54b0be02faff02e3`
- fixture lock: `fixture/fixture-lock.json`
- acceptance lock: `acceptance/acceptance-lock.json`
- control tag: `experiment-control-v1` at `6e2812c0e181502cb1aafbc5fa3e31761b4b54ed`
- treatment tag: `experiment-treatment-v1` at `ac0895c23c4c811cf10e5af5b42efcde12c14849`

The full raw telemetry and judgment packages remain in Git history. They are not needed
to understand the design or canonical disposition and are intentionally not duplicated
in the current tree.
