# Unit-test delegation v2 excluded-pilot result

**Disposition: NO-GO. The v2 experiment stops permanently; main remains
forbidden.**

The exact guarded preflight passed from canonical repository head
`57cfe2524663a32d932e843c28bd9c0034d6237a` with frozen source root
`0fa265c778446a2c6e46ffb7cff413abd0193a85dabb866d580daa7abd5bbd86`.
GitHub Copilot CLI 1.0.77, Node 22.14.0, npm 10.9.2, the authoritative local
session store, all six unused identities, the absent external private root, and
the frozen order were verified before execution. The deterministic no-run suite
and fresh `core.autocrlf=true` checkout/npm regression each passed twice.

The lifecycle started the first P12 pair in frozen order. A1 completed. A2
produced a correct feature and a complete test artifact, but the frozen audit
classified a pre-worker `node --test test\conventions.test.js` command as parent
access to the delegated target. That diagnostic is an evidence-integrity stop in
the frozen runner, so P13 and P11 were retained as not started. No observation
was retried, substituted, tuned, or continued.

## Started pair

| Measure | P12 A1 control | P12 A2 Sonnet treatment |
| --- | ---: | ---: |
| Status | Complete | Delegation failure |
| Parent / worker / combined credits | 47.295700 / 0 / 47.295700 | 42.091475 / 12.547710 / 54.639185 |
| Parent / worker / combined nano-AIU | 47,295,700,000 / 0 / 47,295,700,000 | 42,091,475,000 / 12,547,710,000 / 54,639,185,000 |
| Parent input / output tokens | 156,719 / 9,561 | 210,876 / 6,486 |
| Worker input / output tokens | 0 / 0 | 17,636 / 4,684 |
| Parent / worker / total model tokens | 166,280 / 0 / 166,280 | 217,362 / 22,320 / 239,682 |
| Parent cumulative / peak input | 156,719 / 18,717 | 210,876 / 20,998 |
| Parent / worker active time | 214.528 s / 0 | 81.224 s / 48.695 s |
| Parent wait / wall time | 0 / 231.393 s | 51.497 s / 151.830 s |
| Hidden feature cases | 5/5 | 5/5 |
| Candidate / gold test pass | Pass / pass | Pass / fail |
| Mutants killed | 4/4 | 4/4 |
| Branch / statement coverage | 100% / 100% | 100% / 100% |
| Assertions / isolation | 18 / pass | 53 / pass |
| Trivial / test-quality composite | Yes / 0.875 | No / 0.875 |
| Operational reliability / adherence | 1 / 1 | 0 / 0 |

For the only started pair, A2 used 15.5% more combined credits, 11.0% fewer
parent credits, 44.1% more total model tokens, 34.6% more parent cumulative
input, 12.2% more parent peak input, and 34.4% less wall time. Both arms passed
all hidden feature cases and killed all mutants. A2's tests passed the candidate
but failed against gold, so the frozen evaluator recorded a false positive.

## Routing, tools, and gate

A1 made 17 parent calls (8 view, 9 PowerShell) and no worker calls. A2 made 20
parent calls (6 view, 12 PowerShell, 1 Skill, 1 task) and the worker made exactly
4 calls (3 reads and 1 direct edit). Evidence observed exactly one successful
`unit-test-authoring` Skill load, one named `unit-test-author-sonnet-v2`
delegation, parent model `gpt-5.6-sol`, worker model `claude-sonnet-4.6`, the
frozen envelope, permitted worker paths, one target replacement, the compact
terminal line, and no parent tools after worker start. Adherence nevertheless
failed on the frozen target-access classification described above.

Only 1/6 scheduled observations completed operationally, with zero valid pairs
and zero valid treatments. Both started units stayed inside the 90-credit,
300,000-token, and 360-second envelopes. The frozen gate returned NO-GO because
the operational-completion and valid-pair minima were not met, valid-pair
feature noninferiority was unavailable, fewer than two adherent A2
candidate/gold passes existed, and valid-A2 mutant kill was unavailable.

Raw events, usage rows, candidate repositories, prompts, and diagnostics remain
outside the repository. The 79-file private evidence package is bound by root
`a1bf0c08b6fac803180fbabe68f6eef8101da65e9aa8780e9f4676bd84d7de7d`.
Two independent reproductions matched this root, both started observations, the
frozen gate, the paired summary, and all observation hashes. Only the
runner-produced sanitized summaries and their hashes are published. Held-out
main execution remains forbidden.
