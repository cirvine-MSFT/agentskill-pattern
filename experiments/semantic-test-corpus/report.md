# Semantic test-corpus protocol-v5 benchmark report

**Result: the target Agent Skill Pattern arm did not satisfy the preregistered
positive-efficiency signal.** In all 12 complete randomized blocks, A5 used
38.8% fewer AI credits/nano-AIU
and 58% less
parent cumulative input than GPT inline, but used
88% more total model tokens,
took 72% longer, missed the path and
mutant-quality floors, had 0/12 strict successes, and was treatment-adherent in only
1/12 units.

> **Evidence boundary.** These are local, unsigned, descriptive-only point estimates.
> There is no detached trust anchor or compliance proof. No p-values, confidence
> intervals, significance, causal inference, or population generalization are supported.
> Unavailable telemetry remains null with its recorded reason; absent telemetry is never
> inferred.

Machine-readable sources:

- [immutable protocol-v5 package](results/v5-b01/)
- [final summary JSON](results/v5-final-summary.json)
- [per-arm endpoint CSV](results/v5-final-arm-summary.csv)
- [canonical descriptive results](results/v5-b01/analysis/descriptive-results.json)

Result visualizations:

- [self-contained protocol-v5 dashboard](results/v5-results-dashboard.html)
- [A5 versus A1 efficiency/context tradeoffs](results/v5-charts/a5-vs-a1-tradeoffs.svg)
- [all-arm reliability, quality, credits, tokens, and wall comparison](results/v5-charts/all-arm-comparison.svg)
- [A5 reliability funnel and failure anatomy](results/v5-charts/a5-reliability-funnel.svg)

## Design, integrity, and ITT accounting

The benchmark contains 12 randomized complete blocks and 72 units: 60 AI units and
12 deterministic units. Every slot reached a final disposition; there were zero
missing slots, retries, or protocol deviations. All 39 measured failures crossed
the durable start boundary and remain in the intent-to-treat analysis with
deterministic quality scoring. No started unit was dropped or replaced.

| Frozen item | Value |
| --- | --- |
| Evidence merge commit | `58642d097ffab46fe5452380fbe7d8c66a183577` |
| Closure SHA-256 | `d0d86f7f43b20ef3bd95cdc76929cd74973d77e5c0867acf2e8ca0ebd114433c` |
| Package aggregate SHA-256 | `613dcf903e59273b9dae27f7d7684609c9c0e6af46af83c75d25e76c188350e3` |
| Blocks / units | 12 / 72 |
| AI / deterministic units | 60 / 12 |
| Missing / retries / protocol deviations | 0 / 0 / 0 |
| Measured failures included in ITT | 39 |

## Arms and reliability

| Arm | Execution |
| ---: | --- |
| A0 | deterministic script |
| A1 | GPT-5.6 Sol inline |
| A2 | GPT parent -> inherited GPT worker |
| A3 | Haiku inline |
| A4 | Haiku parent -> inherited Haiku worker |
| A5 | GPT parent -> fixed Haiku worker |

| Arm | Strict success | Treatment-adherent | Operational success | Quality source | Failure categories |
| ---: | ---: | ---: | ---: | --- | --- |
| A0 | 12/12 | 12/12 | 12/12 | 12 full / 0 partial | none |
| A1 | 10/12 | 10/12 | 12/12 | 10 full / 2 partial | budget=2 |
| A2 | 11/12 | 11/12 | 12/12 | 11 full / 1 partial | budget=1 |
| A3 | 0/12 | 0/12 | 6/12 | 0 full / 12 partial | budget=12; mechanism=11; partial-staging=1; terminal=11 |
| A4 | 0/12 | 1/12 | 10/12 | 0 full / 12 partial | budget=11; mechanism=11; partial-staging=1; post-start-infrastructure=11; skill-order=3; task-bytes=11; terminal=12 |
| A5 | 0/12 | 1/12 | 10/12 | 0 full / 12 partial | budget=11; mechanism=9; partial-staging=1; terminal=10 |

A1 and A2 failed only their strict model-token budget in 2/12 and 1/12 units,
respectively; every unit still produced an authenticated 60-scenario snapshot.
A3-A5 were operationally much stronger than their strict dispositions imply, but
their treatment/budget contracts were not: A3 was 0/12 adherent and 6/12
operationally successful; A4 and A5 were each 1/12 adherent and 10/12 operationally
successful. A4/A5 also had one partial terminal failure each (34 and 32 staged
scenarios), while one additional A5 snapshot contained 59 scenarios. Exact-task,
Skill ordering/provenance, terminal-return, duplicate-write, and budget failures are
retained rather than normalized away.

## Quality and diversity

Each cell is mean (median; range; denominator). Quality includes every started unit.

| Metric | A0 | A1 | A2 | A3 | A4 | A5 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Promotion rate | 100% (100%; 100%-100%; n=12) | 100% (100%; 100%-100%; n=12) | 100% (100%; 100%-100%; n=12) | 100% (100%; 100%-100%; n=12) | 96.4% (100%; 56.7%-100%; n=12) | 96% (100%; 53.3%-100%; n=12) |
| Rule coverage | 100% (100%; 100%-100%; n=12) | 100% (100%; 100%-100%; n=12) | 100% (100%; 100%-100%; n=12) | 100% (100%; 100%-100%; n=12) | 100% (100%; 100%-100%; n=12) | 100% (100%; 100%-100%; n=12) |
| Path coverage | 87.6% (88.1%; 80.6%-94%; n=12) | 97.1% (97%; 95.5%-98.5%; n=12) | 97.4% (98.5%; 94%-98.5%; n=12) | 73.9% (73.9%; 68.7%-77.6%; n=12) | 74.6% (74.6%; 68.7%-86.6%; n=12) | 75.9% (76.1%; 70.1%-83.6%; n=12) |
| Invariant coverage | 99.4% (100%; 93.3%-100%; n=12) | 100% (100%; 100%-100%; n=12) | 100% (100%; 100%-100%; n=12) | 100% (100%; 100%-100%; n=12) | 100% (100%; 100%-100%; n=12) | 100% (100%; 100%-100%; n=12) |
| Diagnostic coverage | 96.7% (100%; 80%-100%; n=12) | 100% (100%; 100%-100%; n=12) | 100% (100%; 100%-100%; n=12) | 66.7% (60%; 40%-100%; n=12) | 66.7% (60%; 40%-100%; n=12) | 73.3% (70%; 40%-100%; n=12) |
| Mutant kill rate | 65.4% (66.7%; 60.6%-69.7%; n=12) | 95.5% (95.5%; 93.9%-97%; n=12) | 95.5% (97%; 90.9%-97%; n=12) | 48.2% (48.5%; 42.4%-54.5%; n=12) | 49.7% (48.5%; 42.4%-72.7%; n=12) | 51.5% (51.5%; 42.4%-63.6%; n=12) |

| Metric | A0 | A1 | A2 | A3 | A4 | A5 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Semantic unique signatures | 34.2 (34; 32-37; n=12) | 48.5 (49.5; 40-55; n=12) | 53 (52; 47-60; n=12) | 52.8 (55; 40-58; n=12) | 52.9 (55.5; 33-60; n=12) | 53.1 (54; 30-60; n=12) |
| Semantic duplicate cases | 25.8 (26; 23-28; n=12) | 11.5 (10.5; 5-20; n=12) | 7 (8; 0-13; n=12) | 7.3 (5; 2-20; n=12) | 4.9 (3.5; 0-11; n=12) | 4.5 (5; 0-8; n=12) |
| Exact duplicate cases | 0 (0; 0-0; n=12) | 0 (0; 0-0; n=12) | 0 (0; 0-0; n=12) | 0 (0; 0-0; n=12) | 0 (0; 0-0; n=12) | 0 (0; 0-0; n=12) |
| Mean pairwise Jaccard distance | 0.364 (0.362; 0.346-0.379; n=12) | 0.435 (0.435; 0.366-0.504; n=12) | 0.483 (0.475; 0.435-0.55; n=12) | 0.476 (0.476; 0.436-0.507; n=12) | 0.481 (0.487; 0.441-0.513; n=12) | 0.49 (0.487; 0.456-0.527; n=12) |

Promotion alone is not sufficient. A5's mean promotion was
96%, but its mean path
coverage was 75.9% and
mutant kill was 51.5%,
both materially below A0. Promotion verifies accepted structure; trace coverage and
mutation testing measure whether those accepted scenarios exercise and detect the
behavior the corpus exists to test. Treatment adherence separately verifies that the
claimed mechanism was actually followed.

## Cost, context, and completions

Each cell is mean (median; range; n). Nano-AIU is shown in billions.

| Metric | A0 | A1 | A2 | A3 | A4 | A5 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Parent AI credits | 0 (0; 0-0; n=12) | 43.324 (42.787; 41.494-48.397; n=12) | 9.592 (9.231; 9.15-13.678; n=12) | 17.391 (16.678; 15.805-21.179; n=12) | 2.258 (2.339; 1.646-2.67; n=12) | 9.251 (9.234; 9.199-9.483; n=12) |
| Worker AI credits | 0 (0; 0-0; n=12) | 0 (0; 0-0; n=12) | 40.169 (39.762; 39.292-43.598; n=12) | 0 (0; 0-0; n=12) | 17.137 (17.592; 8.88-20.516; n=12) | 17.256 (17.012; 9.041-24.297; n=12) |
| Total AI credits | 0 (0; 0-0; n=12) | 43.324 (42.787; 41.494-48.397; n=12) | 49.761 (49.137; 48.564-53.1; n=12) | 17.391 (16.678; 15.805-21.179; n=12) | 19.395 (19.822; 11.348-23.123; n=12) | 26.507 (26.253; 18.239-33.532; n=12) |
| Parent nano-AIU (B) | 0 (0; 0-0; n=12) | 43.324 (42.787; 41.494-48.397; n=12) | 9.592 (9.231; 9.15-13.678; n=12) | 17.391 (16.678; 15.805-21.179; n=12) | 2.258 (2.339; 1.646-2.67; n=12) | 9.251 (9.234; 9.199-9.483; n=12) |
| Worker nano-AIU (B) | 0 (0; 0-0; n=12) | 0 (0; 0-0; n=12) | 40.169 (39.762; 39.292-43.598; n=12) | 0 (0; 0-0; n=12) | 17.137 (17.592; 8.88-20.516; n=12) | 17.256 (17.012; 9.041-24.297; n=12) |
| Total nano-AIU (B) | 0 (0; 0-0; n=12) | 43.324 (42.787; 41.494-48.397; n=12) | 49.761 (49.137; 48.564-53.1; n=12) | 17.391 (16.678; 15.805-21.179; n=12) | 19.395 (19.822; 11.348-23.123; n=12) | 26.507 (26.253; 18.239-33.532; n=12) |
| Parent cumulative input | 0 (0; 0-0; n=12) | 76,899.5 (70,566.5; 69,861-111,588; n=12) | 32,283.9 (32,283; 32,231-32,318; n=12) | 135,863 (117,376.5; 114,151-234,337; n=12) | 31,424.5 (34,326.5; 22,467-34,719; n=12) | 32,310.7 (32,301.5; 32,285-32,419; n=12) |
| Parent peak input | 0 (0; 0-0; n=12) | 23,820.3 (23,760; 23,406-24,756; n=12) | 11,208.3 (11,204.5; 11,189-11,230; n=12) | 34,109.3 (34,132; 33,179-35,546; n=12) | 12,226.1 (12,269; 11,820-12,650; n=12) | 11,224 (11,216.5; 11,208-11,321; n=12) |

| Metric | A0 | A1 | A2 | A3 | A4 | A5 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Parent input tokens | 0 (0; 0-0; n=12) | 76,899.5 (70,566.5; 69,861-111,588; n=12) | 32,283.9 (32,283; 32,231-32,318; n=12) | 135,863 (117,376.5; 114,151-234,337; n=12) | 31,424.5 (34,326.5; 22,467-34,719; n=12) | 32,310.7 (32,301.5; 32,285-32,419; n=12) |
| Worker input tokens | 0 (0; 0-0; n=12) | 0 (0; 0-0; n=12) | 56,974.3 (54,300.5; 54,045-85,609; n=12) | 0 (0; 0-0; n=12) | 110,209.8 (105,337.5; 42,542-157,624; n=12) | 112,197.9 (104,623; 42,729-190,743; n=12) |
| Total input tokens | 0 (0; 0-0; n=12) | 76,899.5 (70,566.5; 69,861-111,588; n=12) | 89,258.2 (86,593.5; 86,363-117,923; n=12) | 135,863 (117,376.5; 114,151-234,337; n=12) | 141,634.3 (138,927.5; 76,835-180,100; n=12) | 144,508.6 (136,919.5; 75,022-223,045; n=12) |
| Parent output tokens | 0 (0; 0-0; n=12) | 8,592.3 (8,530.5; 8,179-9,525; n=12) | 384.9 (382.5; 367-402; n=12) | 16,102.7 (15,927; 14,891-18,658; n=12) | 1,304 (1,408.5; 799-1,771; n=12) | 393.1 (389.5; 379-450; n=12) |
| Worker output tokens | 0 (0; 0-0; n=12) | 0 (0; 0-0; n=12) | 8,502.4 (8,426; 8,298-9,060; n=12) | 0 (0; 0-0; n=12) | 16,365.3 (17,168.5; 8,550-18,571; n=12) | 15,819.4 (16,213; 8,610-17,896; n=12) |
| Total output tokens | 0 (0; 0-0; n=12) | 8,592.3 (8,530.5; 8,179-9,525; n=12) | 8,887.3 (8,813; 8,697-9,457; n=12) | 16,102.7 (15,927; 14,891-18,658; n=12) | 17,669.3 (18,496; 9,982-20,281; n=12) | 16,212.5 (16,601; 8,989-18,286; n=12) |
| Parent cached tokens | 0 (0; 0-0; n=12) | 76,883.5 (70,551.5; 69,846-111,567; n=12) | 31,369.1 (32,274; 21,396-32,309; n=12) | 133,795.2 (114,265.5; 111,645-232,459; n=12) | 31,400 (34,300.5; 22,447-34,693; n=12) | 32,301.7 (32,292.5; 32,276-32,410; n=12) |
| Worker cached tokens | 0 (0; 0-0; n=12) | 0 (0; 0-0; n=12) | 56,958.8 (54,285.5; 54,030-85,588; n=12) | 0 (0; 0-0; n=12) | 103,467 (97,596; 33,189-147,706; n=12) | 107,368.9 (99,965; 37,952-184,549; n=12) |
| Total cached tokens | 0 (0; 0-0; n=12) | 76,883.5 (70,551.5; 69,846-111,567; n=12) | 88,327.8 (86,569.5; 75,543-117,893; n=12) | 133,795.2 (114,265.5; 111,645-232,459; n=12) | 134,867 (131,022; 67,456-170,162; n=12) | 139,670.6 (132,260.5; 70,236-216,842; n=12) |
| Parent reasoning tokens | 0 (0; 0-0; n=12) | 877.8 (928; 315-1,650; n=12) | 68.5 (66; 51-86; n=12) | 329 (282; 180-942; n=12) | 830 (921.5; 338-1,295; n=12) | 71.2 (69.5; 55-100; n=12) |
| Worker reasoning tokens | 0 (0; 0-0; n=12) | 0 (0; 0-0; n=12) | 630.3 (645; 181-1,221; n=12) | 0 (0; 0-0; n=12) | 176 (159; 110-386; n=12) | 286.4 (170; 122-893; n=12) |
| Total reasoning tokens | 0 (0; 0-0; n=12) | 877.8 (928; 315-1,650; n=12) | 698.8 (714; 245-1,303; n=12) | 329 (282; 180-942; n=12) | 1,006 (1,091.5; 536-1,445; n=12) | 357.6 (240; 196-956; n=12) |
| Parent model tokens | 0 (0; 0-0; n=12) | 85,491.8 (79,097; 78,040-121,113; n=12) | 32,668.8 (32,660; 32,616-32,717; n=12) | 151,965.7 (133,035; 129,864-250,784; n=12) | 32,728.5 (35,744.5; 23,275-36,429; n=12) | 32,703.8 (32,690.5; 32,672-32,869; n=12) |
| Worker model tokens | 0 (0; 0-0; n=12) | 0 (0; 0-0; n=12) | 65,476.7 (62,726.5; 62,343-94,669; n=12) | 0 (0; 0-0; n=12) | 126,575.2 (121,047; 51,092-176,046; n=12) | 128,017.3 (120,719.5; 51,339-206,778; n=12) |
| Total model tokens | 0 (0; 0-0; n=12) | 85,491.8 (79,097; 78,040-121,113; n=12) | 98,145.5 (95,406.5; 95,060-127,380; n=12) | 151,965.7 (133,035; 129,864-250,784; n=12) | 159,303.7 (156,410.5; 86,817-199,321; n=12) | 160,721.1 (153,420; 84,011-239,462; n=12) |
| Parent completions | 0 (0; 0-0; n=12) | 5.3 (5; 5-7; n=12) | 3 (3; 3-3; n=12) | 6.8 (6; 6-11; n=12) | 2.8 (3; 2-3; n=12) | 3 (3; 3-3; n=12) |
| Worker completions | 0 (0; 0-0; n=12) | 0 (0; 0-0; n=12) | 5.2 (5; 5-7; n=12) | 0 (0; 0-0; n=12) | 6.3 (6; 4-8; n=12) | 6.4 (6; 4-10; n=12) |
| Total completions | 0 (0; 0-0; n=12) | 5.3 (5; 5-7; n=12) | 8.2 (8; 8-10; n=12) | 6.8 (6; 6-11; n=12) | 9 (9; 7-10; n=12) | 9.4 (9; 7-13; n=12) |

Premium-request fields are unavailable because the local usage store has no such
field. Credits are the available AI-credit measure and nano-AIU is reported
separately. Cache read and cache write values remain separately available in the
JSON/CSV; the table above reports the canonical combined cached-token endpoint.

## Tools and timing

| Metric | A0 | A1 | A2 | A3 | A4 | A5 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Tool schema count | 0 (0; 0-0; n=12) | unavailable (n=0) | unavailable (n=0) | unavailable (n=0) | unavailable (n=0) | unavailable (n=0) |
| Tool calls | 0 (0; 0-0; n=12) | 64 (64; 64-64; n=12) | 66 (66; 66-66; n=12) | 65 (65; 64-66; n=12) | 64.8 (67; 40-68; n=12) | 64.3 (67; 38-67; n=12) |
| Tool results | 0 (0; 0-0; n=12) | 64 (64; 64-64; n=12) | 66 (66; 66-66; n=12) | 65 (65; 64-66; n=12) | 64.8 (67; 40-68; n=12) | 64.3 (67; 38-67; n=12) |
| Tool-result bytes | 0 (0; 0-0; n=12) | 138,840.3 (138,840; 138,840-138,844; n=12) | 141,667 (141,667; 141,667-141,667; n=12) | 138,844 (138,844; 138,840-138,848; n=12) | 140,033.1 (141,671; 122,008-141,675; n=12) | 139,853.6 (141,671; 120,516-141,671; n=12) |
| Compact-return bytes | 0 (0; 0-0; n=12) | unavailable (n=0) | 53 (53; 53-53; n=12) | unavailable (n=0) | 56.1 (53; 53-88; n=12) | 92.8 (53; 53-500; n=12) |
| Wall seconds | 0.83 (0.81; 0.76-0.98; n=12) | 83.54 (82.11; 72.76-103.24; n=12) | 93.18 (91.39; 85.66-111.74; n=12) | 137.24 (133.41; 125.6-154.81; n=12) | 150.94 (156.31; 90.42-173.31; n=12) | 143.65 (152.29; 84.21-160.76; n=12) |
| Parent active seconds | 0 (0; 0-0; n=12) | 78.27 (76.56; 67.73-98.11; n=12) | 10.13 (9.65; 6.18-16.53; n=12) | 131.96 (128.17; 120.28-149.55; n=12) | 15.27 (15.45; 9.75-22.37; n=12) | 9.86 (9.03; 5.75-20.12; n=12) |
| Worker active seconds | 0 (0; 0-0; n=12) | 0 (0; 0-0; n=12) | 76.86 (76.48; 71.69-95.44; n=12) | 0 (0; 0-0; n=12) | 129.34 (134.83; 69.44-147.37; n=12) | 127.57 (136.6; 69.38-145.6; n=12) |
| Parent wait seconds | 0 (0; 0-0; n=12) | unavailable (n=0) | 82.82 (82.41; 77.69-101.67; n=12) | unavailable (n=0) | 135.4 (141.35; 72.66-154.04; n=12) | 133.58 (142.49; 72.34-152.16; n=12) |
| Parent TTFT ms | 0 (0; 0-0; n=12) | 12,681.7 (13,569.6; 3,811.6-16,966.7; n=12) | 3,075.5 (3,097.2; 1,331.9-5,388.3; n=12) | 1,367.2 (1,330.6; 1,190.7-1,861.2; n=12) | 1,392 (1,336.1; 1,155.4-1,947; n=12) | 2,717.3 (2,896.4; 1,305.6-4,162.5; n=12) |
| Worker TTFT ms | 0 (0; 0-0; n=12) | 0 (0; 0-0; n=12) | 13,685.3 (13,632.6; 12,428.6-14,711.1; n=12) | 0 (0; 0-0; n=12) | 1,352.6 (1,305.9; 1,183.4-1,650.9; n=12) | 1,419.4 (1,340.7; 1,157.2-2,017.1; n=12) |
| Parent inter-token latency ms | 0 (0; 0-0; n=12) | 118.62 (118.62; 0-118.62; n=1) | 7.06 (7.07; 0-7.29; n=3) | 61.66 (61.04; 49.63-77.03; n=12) | 88.95 (85.83; 78.08-104.84; n=12) | 10.74 (6.86; 0-27.31; n=5) |
| Worker inter-token latency ms | 0 (0; 0-0; n=12) | 0 (0; 0-0; n=12) | unavailable (n=0) | 0 (0; 0-0; n=12) | 64.9 (60.73; 50.91-100.55; n=12) | 67.58 (63.16; 46.3-96.65; n=12) |

Exposed-tool names were available in every AI unit: inline arms exposed the four
semantic MCP tools, while delegated arms exposed those four plus `skill` and
`task` (means 4 and 6 respectively; n=12 per arm). Complete tool-schema payloads
and authoritative compaction counts were unavailable in all AI units. Compact-return
bytes and parent wait were defined only for delegated arms. TTFT/inter-token fields
have the exact per-arm denominators above; partial availability is not imputed.

| Telemetry field | A1 | A2 | A3 | A4 | A5 |
| --- | --- | --- | --- | --- | --- |
| premiumRequests | 0/12 (assistant_usage_events has no premium-request field) | 0/12 (assistant_usage_events has no premium-request field) | 0/12 (assistant_usage_events has no premium-request field) | 0/12 (assistant_usage_events has no premium-request field) | 0/12 (assistant_usage_events has no premium-request field) |
| toolSchemas | 0/12 (local events do not expose the complete tool schema payload) | 0/12 (local events do not expose the complete tool schema payload) | 0/12 (local events do not expose the complete tool schema payload) | 0/12 (local events do not expose the complete tool schema payload) | 0/12 (local events do not expose the complete tool schema payload) |
| exposedTools | 12/12 | 12/12 | 12/12 | 12/12 | 12/12 |
| compaction | 0/12 (local events do not expose an authoritative compaction counter) | 0/12 (local events do not expose an authoritative compaction counter) | 0/12 (local events do not expose an authoritative compaction counter) | 0/12 (local events do not expose an authoritative compaction counter) | 0/12 (local events do not expose an authoritative compaction counter) |
| reasoningTokens | 12/12 | 12/12 | 12/12 | 12/12 | 12/12 |
| latencyDetails | 1/12 (one or more usage rows omit latency fields) | 0/12 (one or more usage rows omit latency fields) | 12/12 | 12/12 | 5/12 (one or more usage rows omit latency fields) |
| requestMultiplier | 12/12 | 12/12 | 12/12 | 12/12 | 12/12 |
| parentWait | 0/12 (one complete delegated lifecycle is required) | 12/12 | 0/12 (one complete delegated lifecycle is required) | 12/12 | 12/12 |
| sourceReadOnly | 0/12 (portable read-only state is not represented in the source formats) | 0/12 (portable read-only state is not represented in the source formats) | 0/12 (portable read-only state is not represented in the source formats) | 0/12 (portable read-only state is not represented in the source formats) | 0/12 (portable read-only state is not represented in the source formats) |

## Target contrasts

Differences are paired within all 12 blocks. Quality columns are A5 minus the
comparator in percentage points; other columns are percent change from the
comparator. Ratios against a zero deterministic cost are undefined.

| Comparator | n | Promotion | Path | Mutant kill | Parent cumulative input | Credits | Total model tokens | Wall |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| A0 | 12 | -4 pp | -11.7 pp | -13.9 pp | n/a | n/a | n/a | +17,281.1% |
| A1 | 12 | -4 pp | -21.3 pp | -43.9 pp | -58% | -38.8% | +88% | +72% |
| A2 | 12 | -4 pp | -21.5 pp | -43.9 pp | +0.1% | -46.7% | +63.8% | +54.2% |
| A3 | 12 | -4 pp | +2 pp | +3.3 pp | -76.2% | +52.4% | +5.8% | +4.7% |
| A4 | 12 | -0.4 pp | +1.2 pp | +1.8 pp | +2.8% | +36.7% | +0.9% | -4.8% |

| Preregistered target | Criterion | Observed | Verdict |
| --- | ---: | ---: | --- |
| Promotion vs A0 | >= -5 pp | -4 pp | met |
| Path coverage vs A0 | >= -3 pp | -11.7 pp | not met |
| Mutant kill vs A0 | >= -5 pp | -13.9 pp | not met |
| Parent cumulative input vs A1 | <= 85% | 42% | met |
| Total nano-AIU vs A1 | <= 90% | 61.2% | met |
| Total credits vs A1 | <= 90% | 61.2% | met |
| Wall time vs A1 (secondary) | <= 80% | 172% | not met |

The three efficiency thresholds against A1 were individually met, but the
preregistered positive signal also required all three quality floors. Because path
coverage and mutant kill failed, the combined signal is **not met**. The secondary
wall target also failed.

## Complete-execution accounting

All 60 AI attempts contribute to the model-usage totals below, including measured
failures. Summed wall time covers all 72 units, including A0. There were no excluded
operational runs.

| Measure | Total | Contributing runs |
| --- | ---: | ---: |
| AI credits | 1,876.523305 | 60 |
| Nano-AIU | 1,876,523,305,000 | 60 |
| Input tokens | 7,057,963 | 60 |
| Output tokens | 809,569 | 60 |
| Reasoning tokens | 39,230 | 60 |
| Model tokens | 7,867,532 | 60 |
| Completions | 464 | 60 |
| Summed wall seconds | 7,321.549 | 72 |
| Summed model duration seconds | 6,951.13 | 60 |
| Tool calls / results | 3,889 / 3,889 | 60 |

The closure's complete-execution wall total uses lifecycle attempt elapsed time.
Per-arm wall point estimates use the canonical local-evidence/deterministic timing
endpoint and sum to 7,312.581 seconds;
the 8.968
second source-boundary difference is retained rather than silently reconciled.

## Direct answer to the hypothesis

**Observed facts.** Relative to GPT inline, the skill-routed fixed-Haiku arm reduced
AI credits/nano-AIU by 38.8%
and parent cumulative input by
58%.
It did not reduce total context/token use or wall time: total model tokens rose
88%, total input rose
87.9%, and wall time rose
72%. It preserved mean promotion within
the -5 pp floor, but not path coverage or mutant kill, and strict reliability was
0/12 with only 1/12 treatment adherence.

**Interpretation.** This benchmark does not support the central hypothesis as a
combined quality/reliability-and-efficiency claim. The low parent cumulative and
peak context in delegated arms is consistent with context isolation doing its
intended parent-side job. The fixed Haiku worker also lowered credit/nano-AIU cost
relative to GPT workers. However, worker context made total token use larger and
delegation/wait made wall time longer. Tool restriction cannot be credited as a
cause because the design did not isolate tool-surface size from model and delegation
effects; likewise, the observed overhead pattern is descriptive, not a causal
estimate. Delegation did not dominate credit cost, but it did coincide with worse
total-token and latency efficiency.

The strong deterministic script is the practical winner for this benchmark: 12/12
strict and operational success, 100% promotion, higher path coverage and mutant kill
than A5, and no AI cost. That makes an AI corpus-proposal step unsupported for this
specific, fully specified migration benchmark. It does not invalidate AI-assisted
test design generally, especially where important semantics exist only in
unstructured material not encoded in deterministic rules.

## Relation to the ASCII case study

The separate ASCII benchmark had 20 complete ITT pairs and found
the skill-routed treatment used 55.5% more
nano-AIU and 53.9% more parent
cumulative input, while wall latency was
54.9% lower and quality was worse.
This corpus benchmark shows a different credit/parent-context direction but worse
wall latency and incomplete quality/reliability preservation. The tasks are not
pooled: task scale and structure may moderate delegation economics, but these two
case studies support only that hypothesis, not a general law.

## Limitations

- The evidence and package are local and unsigned; hashes establish byte identity,
  not an independent trust anchor, signature, or sandbox/compliance proof.
- The protocol permits descriptive ITT analysis only. No p-values, confidence
  intervals, significance, causal effects, or population generalization are claimed.
- Full candidate worktrees, staging payloads, prompts, raw JSONL events, and opaque
  payloads remain external. Their source bytes are hash-bound by the committed
  manifest but are not independently inspectable from this repository.
- Premium requests, full tool schemas, authoritative compaction counts, portable
  source-read-only state, and some latency details are unavailable. Null values and
  reasons are retained; no absent field is inferred.
- Treatment adherence was especially poor in A3-A5. Partial authenticated quality
  is valid ITT evidence, but it is not equivalent to successful execution of the
  intended treatment mechanism.

## Reproduction

From `experiments/semantic-test-corpus`:

```powershell
npm run report:v5
npm run report:v5:check
npm run visualize:v5
npm run visualize:v5:check
npm test
npm run evidence:v5:verify
```

`report:v5` verifies the immutable package, re-derives every table from committed
canonical artifacts, asserts the closure/package hashes and complete-execution
totals, and writes the Markdown/JSON/CSV outputs. `report:v5:check` regenerates in
memory and requires byte-for-byte equality. `visualize:v5` derives the dashboard and
SVG charts only from `results/v5-final-summary.json`; `visualize:v5:check` requires
all four generated files to remain byte-for-byte current.
