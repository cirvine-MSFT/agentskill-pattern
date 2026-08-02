# Feature documentation delegation v2 excluded-pilot result

**Disposition: NO-GO. The v2 experiment stops permanently; main remains
forbidden.**

The frozen preflight passed from canonical repository head
`41ce9a2e90263a2303799f34fbd02e8988e40a02`, source root
`69c37c0c5918ca2abec96924e7863b3a903a00e9f7e199576caf46e18efbbcf4`,
authorization payload
`83221aa333c4e87485e38f7cae102f845a20ae46b92b3d96bfac7377df153f24`,
and authorization-index manifest
`00869a62fc634605f5c56bdd6d89b556b20281c775ee4475fa19c534fd52c3b1`.
GitHub Copilot CLI 1.0.77, Node 22.14.0, npm 10.9.2, the authoritative
read-only session store, all 12 unused parent/study-worker identities, absent
authorized roots, unexpired authorization, exact index bytes, and frozen order
were verified before execution.

The first exact command reached a pre-start setup failure because the external
candidate parent directory did not exist. The runner removed its partial root
and consumed no identity. After creating only that parent directory, a second
preflight again proved zero consumed identities and absent authorized roots.
The same committed command then started the frozen lifecycle. No observation
was retried, tuned, or substituted.

## Arm and pair results

| Pair | A1 control | A2 Sonnet treatment | Valid pair |
| --- | --- | --- | --- |
| V2P-01 | Not started; all metrics null | Timeout; feature 0/2; docs 0/0/0/0.4; unsupported claims 0 | No |
| V2P-02 | Not started; all metrics null | Not started; all metrics null | No |
| V2P-03 | Not started; all metrics null | Not started; all metrics null | No |
| V2P-04 | Not started; all metrics null | Not started; all metrics null | No |
| V2P-05 | Not started; all metrics null | Not started; all metrics null | No |
| V2P-06 | Not started; all metrics null | Not started; all metrics null | No |

A1 started 0/6 and completed 0/6. A2 started 1/6 and completed 0/6.
All 12 scheduled slots received exactly one terminal disposition. The only
started observation was `V2P-01-A2-15f62ce532`; the frozen external evaluator
ran twice with zero AI credits and reproduced feature score 0, documentation
correctness 0, coverage 0, executability 0, format 0.4, and zero unsupported
claims. Neither the production source nor documentation target changed.

## Usage, context, and timing

The started A2 observation settled 33 usage rows. Three attributable parent
rows used 14.614800 credits, 31,167 input tokens, 1,899 output tokens, 31,167
cumulative input tokens, 12,795 peak input tokens, and 35.176 seconds of active
model time. Thirty rows from nonconforming sub-agent activity used 36.568600
credits, 223,201 input tokens, 22,539 output tokens, and 227.769 summed active
seconds. Total observed usage was 51.183400 credits and 278,806 model tokens.

The frozen worker and combined fields remain null because no unique authorized
worker could be attributed; treating the extra rows as the specified Sonnet
worker would fabricate evidence. Event wall time was 159.538 seconds and the
sub-agent activity window was 245.982 seconds.

## Routing, adherence, and gate

The treatment did not follow the frozen route. Evidence recorded three Skill
loads, 14 task starts, 14 sub-agent starts, 11 sub-agent completions, and no
terminal result. Observed models were `gpt-5.6-sol` and
`claude-haiku-4.5`; `claude-sonnet-4.6` was not observed. There was no unique
named Sonnet task, complete target replacement, compact terminal JSON, or
worker control-plane identity. Usage was therefore unattributed and adherence
failed.

Missing required worker attribution made evidence integrity impossible after
the first started observation, so the frozen runner stopped later starts and
retained the remaining 11 slots as not started. The gate returned NO-GO with
0/6 valid pairs because evidence integrity failed, fewer than five valid pairs
completed, the started A2 lacked mandatory routing evidence, and usage was not
completely partitioned.

Raw events, usage rows, candidates, prompts, evaluators, and diagnostics remain
outside the repository. The 71-file private evidence package is bound by root
`91a3d44a96d8f301ad913838d29dd972bb762541ac86fce8dc3ebe556e997e94`.
Two independent evidence reproductions matched that root, the frozen gate,
summary, dispositions, and all observation hashes. Held-out main execution
remains forbidden; this NO-GO authorizes no further run.
