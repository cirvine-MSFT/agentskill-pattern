# Grounded action-item extraction feasibility protocol

## Question

Can a Skill-discovered GPT-5.6 Sol parent delegate one meeting transcript to a fixed
Claude Haiku 4.5 worker that reads the transcript once, writes one grounded structured
ledger once, and returns compact status without passing transcript or ledger content
through the parent?

The later five-arm concept reserved a deterministic floor, GPT inline, GPT-to-GPT,
explicit GPT-to-Haiku, and Skill-discovered GPT-to-Haiku. Only excluded target-arm
feasibility units ran. There is no valid control or confirmatory comparison.

## Candidate boundary

The retained v3 candidate in [`candidate/`](candidate/) routes exactly once to a
fixed-Haiku worker. The runtime maps the declared `read`/`edit` surface to exactly one
whole-transcript `view` and one sentinel-replacing `edit`. The parent may not view the
transcript or view/edit the ledger. Shell, search, MCP, recursion, extra delegation,
retry, and evaluator access are forbidden.

Each action item requires owner, normalized action, due date, status, condition,
criticality, and exact prefixed source citations. Suggestions, negated work, fully
rescinded work, and decisions without an assigned commitment are omitted. Material
ambiguity is recorded rather than invented.

## External scoring

Repository-owned deterministic evaluation used one-to-one tuple matching and measured:

- tuple precision, recall, and F1;
- owner/action/date/status/condition/criticality accuracy;
- rescission, reassignment, and date-change handling;
- unsupported commitments and unsupported critical actions;
- schema validity, duplicates, and exact source grounding.

Gold remained outside model-readable candidate roots. The parent did not grade output.

## Iterations and frozen gates

| Version | Purpose | Frozen failure rule |
| --- | --- | --- |
| v1 | Discover runtime file-tool identifiers | Any unknown tool or missing read/write permanently stops the line |
| v2 | Correct to CLI `task,view,edit` and sentinel replacement | Missing required distinct parent/worker tool-schema evidence is NO-GO |
| v3 | Prospectively correct the warning rule and require exact line citations | Three fresh A4 pilots must all pass mechanism, quality, grounding, and budget gates |

V3 GO required 3/3 operational/adherent runs, exactly one worker view/edit, no
unsupported critical action, valid schema/compact return/isolation, mean tuple F1 at
least 0.85 with every run at least 0.75, 100% source grounding, at most 40,000 model
tokens, and at most 180 seconds per run. Passing would only authorize a separate main
preregistration. No retries or threshold changes were allowed.
