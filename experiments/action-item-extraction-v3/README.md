# Action-item extraction v3 excluded pilot

**Status: immutable NO-GO.** The three preregistered A4 units ran exactly once in
frozen order after the outcome-independent LF checkout correction. All starts
remain in intent-to-treat. Protocol ID: `action-item-extraction-v3`. This
namespace is separate from immutable v1 and v2 inputs, IDs, sessions, schedules,
hashes, evidence, thresholds, and dispositions.

V2 remains immutable at PR #27 / merge
`9f3add6986105dd18ac1b4ed8f3cdf2edd639f5a`: its one excluded development unit
matched 12/12 tuples with precision, recall, and F1 of 1.00; handled rescission,
reassignment, and date changes; produced zero unsupported commitments; used one
worker view and one worker edit with no parent file calls; returned valid,
compact, isolated output; consumed 38,410 model tokens and 55.08 seconds. V2
remains NO-GO because its debug logs lacked the then-required distinct
parent/worker `Tools:` blocks. Its 1/12 source-grounding result remains unchanged.
No v2 pilot ran.

## Frozen v3 scope

- Exactly three fresh excluded-pilot transcripts and evaluator-only gold
  inventories, all under fresh v3 IDs.
- A4 only: GPT-5.6 Sol routes once to fixed Claude Haiku 4.5.
- CLI 1.0.77 with global
  `--available-tools=task,view,edit --allow-all-tools --disable-builtin-mcps`.
- Exactly one worker whole-transcript view and one worker sentinel-replacing
  edit; zero parent transcript or ledger calls and no other worker tools.
- Exact bracketed transcript-line citations required for every tuple.
- No A0-A3 AI observation, development observation, or main observation exists.

## Excluded-pilot result

| Run | Exact mechanism | Tuple F1 | Grounding | Model tokens | AIU credits | Wall time | Disposition |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| `PILOT-ACTION-V3-A4-2F6C` | Yes | 0.385 | 21.43% | 39,274 | 12.035535 | 48.491s | Measured failure: ambiguity policy |
| `PILOT-ACTION-V3-A4-71D9` | Yes | 0.231 | 7.14% | 38,375 | 11.266770 | 55.999s | Measured failure: ambiguity policy |
| `PILOT-ACTION-V3-A4-C845` | No | 0.769 | 7.14% | 40,815 | 12.212910 | 67.044s | Measured failure: warning rule, ambiguity policy, token ceiling |

All runs used one successful worker view and one successful worker edit with
zero parent file calls. Schema, compact return, and candidate isolation passed
3/3. The aggregate mean tuple F1 was 0.462, source grounding was not 100%, two
runs produced an unsupported critical action, and one run exceeded 40,000 model
tokens. The frozen aggregate disposition is NO-GO, which authorizes no further
AI execution.

The immutable raw events, usage, ledgers, reconstructed scores, hashes, start
index, summary, and derived report are under
[`results/excluded-pilot-v3`](results/excluded-pilot-v3/).

## Deterministic commands

From this directory:

```powershell
npm run evidence:check
npm run report
node --test ..\..\tests\action-item-v3-checkout.test.mjs
```

`npm run fixtures` and `npm run freeze` are write-once and produced the checked-in
foundation. `npm run pilot -- --execute` was the sole AI lifecycle entry point
and cannot be invoked again because the runtime and evidence roots now exist.
The checkout regression creates and removes a temporary checkout with
`core.autocrlf=true`; it does not invoke the lifecycle entry point.

See [protocol-amendment-v3.md](protocol-amendment-v3.md),
[design/execution-plan.json](design/execution-plan.json), and
[design/no-run-attestation.json](design/no-run-attestation.json).
