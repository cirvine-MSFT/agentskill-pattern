# Research: semantic acceptance-test corpus generation for a deterministic config migration

**Date of research:** 2026-07-29

**Scope of this document:** `docs/research/semantic-corpus-generation.md` and its companion
[`semantic-corpus-evidence.csv`](./semantic-corpus-evidence.csv) only. This is a candidate
**reference** for the [Agent Skill Pattern](../agent-skill-pattern.md) — it evaluates whether, and
where, a bounded AI subagent task fits inside a deterministic configuration-migration test
pipeline. It does not modify [`prior-art.md`](./prior-art.md), [`evidence.csv`](./evidence.csv),
[`search-log.md`](./search-log.md), the README, any Skill/agent definition, `experiments/`, or any
report. Every substantive external claim below is backed by a row in `semantic-corpus-evidence.csv`
and was verified by fetching the primary source directly (arXiv API, vendor docs, NIST, GitHub
project READMEs, or the author's own institutional copy); two rows (QuickCheck and Csmith) confirm
publication metadata directly against the ACM DOI but draw their quoted abstract text from a
secondary academic mirror because ACM paywalls the abstract itself — flagged accordingly in the CSV.

## 1. The concern this reference exists to settle

The task under study: migrate configuration records from a v1 schema to a v2 schema under a fixed,
documented set of mapping rules and cross-field/domain invariants. Two pieces of code are load-bearing
and must be trustworthy:

1. **The migration implementation** — the script that actually transforms v1 records to v2.
2. **The expected-output oracle** — the script that computes, for a given v1 input, what the
   *correct* v2 output (or error) is supposed to be, so a test can compare actual vs. expected.

The open question is **only**: what, if anything, should an AI subagent contribute to the
corpus that exercises these two scripts? Specifically, is it safe to delegate the generation of the
*test fixtures themselves* to an AI, and separately, is it safe to delegate computation of *expected
results* to an AI. These are different questions with different answers.

## 2. Recommendation

> **The migration implementation and the expected-output oracle must both be deterministic
> scripts.** An AI subagent's only role, if used at all, is to help **design semantically diverse
> source fixtures and scenario metadata** — candidate v1 inputs, edge cases, and a label describing
> what each is meant to exercise — drawn from the v1/v2 schemas, the mapping rules, cross-field/domain
> invariants, legacy examples, and bug history. The AI **never** computes or writes an expected
> output or expected error for any fixture it proposes, and this must be enforced by a real access
> boundary — an isolated staging location the subagent's tools cannot see out of, not merely by
> omitting an "oracle" tool from its allowlist (§6). A deterministic reference oracle, built from the
> same mapping-rule specification the migration script implements and given its own independent trust
> chain (executable spec, hand-reviewed golden cases, metamorphic invariants, and — where feasible —
> an independently written differential implementation; §7), computes every expected result. Corpus
> effectiveness — whether the fixtures the AI helped design actually exercise the rules that matter —
> is measured after the fact from the migration/oracle scripts' own **execution traces** (which rule
> or path actually fired), not from the AI's self-reported labels, and scored with **mutation
> testing**: seed deliberate faults ("hidden mutants") into the migration implementation and confirm
> the corpus's oracle comparisons catch them. Whether the AI step is worth its cost is an empirical
> question, decided against a **strong deterministic baseline** that already includes decision
> tables, covering arrays, boundary/equivalence partitioning, constraint/SMT-based generation, and
> schema/grammar-based generation (§3.2) — not an assumed gap.

This follows directly from the test oracle problem literature. The supported claim from that
literature is narrower than "correctness is always harder than input generation" — it is that test
oracle automation is a **documented bottleneck** on overall test automation, distinct from and not
solved by input-generation automation:
([Barr, Harman, McMinn, Shahbaz & Yoo 2015](http://www0.cs.ucl.ac.uk/staff/m.harman/tse-oracle.pdf),
row 1 — "the challenge of distinguishing the corresponding desired, correct behaviour from
potentially incorrect behavior is called the 'test oracle problem.' ... Test oracle automation is
important to remove a current bottleneck that inhibits greater overall test automation"). Even the
academic alternative to a full formal oracle, metamorphic testing, still requires a programmatically
defined, non-hallucinated relation between inputs and outputs, not an LLM's guess
([Segura, Fraser, Sanchez & Ruiz-Cortes 2016](https://eprints.whiterose.ac.uk/id/eprint/110335/),
row 2). And the two most on-point papers found in this research — one written specifically to make
the case *for* LLM-generated oracles — both name oracle deficiency and data leakage as open,
unresolved risks rather than solved problems
([Molina & Gorla 2024](https://arxiv.org/abs/2405.12766), row 3;
[Bodicoat et al. 2026](https://arxiv.org/abs/2601.05542), row 4). For a migration whose correctness
criterion is a **known, documented, deterministic mapping**, there is no reason to accept that risk:
the oracle can and should be computed by a script built directly from the specification — but, per §7
below, "a script" is not by itself a guarantee of oracle correctness; the script itself needs its own
trust chain (§7), and any isolation this pattern relies on to keep AI output away from that script
needs to be a real access boundary, not an assumption about which tools an agent was told to use (§6).

## 3. What scripts already do well — and what remains genuinely hard for scripts alone

### 3.1 Deterministic corpus generation is a mature, solved problem for *validity*

Given a JSON Schema, generating syntactically valid, schema-conformant example instances is an
existing, off-the-shelf, deterministic capability:

- **`hypothesis-jsonschema`** turns a JSON Schema directly into a
  [Hypothesis](https://hypothesis.readthedocs.io) property-based-testing strategy: "a Hypothesis
  strategy for generating data that matches some JSON schema... `from_schema`... takes a JSON schema
  and returns a strategy for allowed JSON objects"
  ([README](https://github.com/python-jsonschema/hypothesis-jsonschema/blob/master/README.md),
  row 6). Property-based testing itself traces to
  [QuickCheck](https://dl.acm.org/doi/10.1145/351240.351266) (Claessen & Hughes, 2000, row 5):
  generate many inputs automatically and check declared properties, rather than hand-authoring
  example-based expectations.
- **`json-schema-faker`** independently confirms the same capability with a different
  implementation: "Generate valid JSON data from JSON Schema definitions... Deterministic output via
  seeded PRNG... Composition keywords: `allOf`, `anyOf`, `oneOf`, `not`, `if`/`then`/`else`... `$ref`
  resolution with cycle detection" ([README](https://github.com/json-schema-faker/json-schema-faker),
  row 7).
- JSON Schema itself natively supports embedding illustrative examples via the non-validating
  `examples` annotation keyword
  ([Understanding JSON Schema](https://json-schema.org/understanding-json-schema/reference/annotations),
  row 8) — a place scenario-design output can land without inventing new file formats.

**Two deterministic tools already produce schema-valid instances at zero cost.** They do not,
however, know that (for example) "a v1 record with a null `region` and a non-US `country` should hit
mapping rule 14, not the default branch" — that is domain/scenario *semantics*, not schema syntax.

### 3.2 A strong deterministic baseline already covers most of the corpus-design space — mechanically

Where the concern is which *combinations* of fields to exercise rather than which individual values
are valid, combinatorial testing is a mature, deterministic, well-tooled technique: "the key insight
underlying t-way combinatorial testing is that not every parameter contributes to every fault and
most faults are caused by interactions between a relatively small number of parameters"
([Kuhn, Kacker & Lei, NIST SP 800-142, 2010](https://www.nist.gov/publications/practical-combinatorial-testing),
row 9). Microsoft's own **PICT** is a first-party, open-source implementation of exactly this:
"PICT generates a compact set of parameter value choices that represent the test cases you should use
to get comprehensive combinatorial coverage of your parameters"
([microsoft/pict README](https://github.com/microsoft/pict), row 10). Grammar-based generation
(producing syntactically valid structures by construction, rather than mutating raw bytes) is the
same idea applied to structured formats and is independently well-established
([Zeller et al., *The Fuzzing Book*](https://www.fuzzingbook.org/html/GrammarFuzzer.html), row 11);
**Csmith** demonstrates its real-world payoff at scale, finding "more than 325 previously unknown
bugs" in production C compilers through constraint-aware random generation with no LLM involved
([Yang, Chen, Eide & Regehr, PLDI 2011](https://dl.acm.org/doi/10.1145/1993498.1993532), row 12).

This is not the full deterministic baseline, and this report treats it as an error to compare an AI
subagent only against schema-valid generation and covering arrays — a rule-driven configuration
migration has at least three more established, deterministic, non-AI techniques available before any
domain-semantic gap can be claimed:

- **Decision table testing, equivalence partitioning, and boundary value analysis** are standardized
  black-box test design techniques for deriving test cases directly from a documented set of input
  conditions and their corresponding actions — precisely the shape of a mapping-rule specification
  ("decision table testing derives test cases from a table of input-condition combinations and their
  corresponding documented actions/outputs"; equivalence partitioning and boundary value analysis
  systematically cover partitions and their edges) ([ISTQB Foundation Level black-box test
  techniques](https://glossary.istqb.org/en_US/term/decision-table-testing), row 25). If the mapping
  rules are already written down as conditions and actions, a decision-table-driven generator can
  derive fixtures from them mechanically, with no AI step.
- **Constraint/SMT-based (symbolic) test generation** is a mature, deterministic technique for
  automatically producing high-coverage inputs from a program or specification's own logical
  constraints, and has been used to *deterministically crosscheck two nominally-equivalent
  implementations* — precisely the v1/v2 comparison shape of this migration —
  ("we used KLEE to crosscheck purportedly identical BUSYBOX and COREUTILS utilities, finding
  functional correctness errors" — [Cadar, Dunbar & Engler, OSDI 2008](https://web.stanford.edu/~engler/klee-osdi-2008.pdf),
  row 24).
- **Differential testing** — running two or more comparable implementations on the same generated
  inputs and flagging divergent outputs — is the same generator/oracle split this report recommends,
  documented as an established industrial technique since 1998
  ([McKeeman](https://www.cs.tufts.edu/comp/150FP/archive/bill-mckeeman/DifferentailTesting.pdf),
  row 20); see §7 for how an independently-written differential v2 implementation can serve as part
  of the oracle's own trust chain, not only as a corpus-generation technique.

**A large share of this corpus can plausibly be produced by combining these deterministic techniques
alone**, with no AI subagent: a declared parameter model of the v1/v2 field space fed to a covering-
array generator, a decision-table generator driven directly by the mapping-rule specification, and a
constraint-solver-driven generator all mechanically produce fixtures. This report's position (§3.3,
§5) is that an AI subagent should be evaluated **empirically against this full baseline**, not against
a strawman of schema-validity generation alone — see §8 for the evaluation design that makes this
comparison explicit.

### 3.3 What the deterministic baseline plausibly still misses — an empirical question, not an assumption

Combinatorial, decision-table, constraint-solver, and schema-driven generation are all driven by a
*declared* model of the fields, rules, or constraints — they only cover what someone has already
written down in machine-readable form. Where this report believes an AI subagent may plausibly add
value is **reading** unstructured or semi-structured material that is not already reduced to a
parameter/constraint model — the v1/v2 schemas, the mapping-rule specification's prose, cross-field/
domain invariants, a sample of legacy production examples, and the bug tracker's migration-related
history — and **proposing** fixtures and scenario metadata that correspond to what a purely
model-driven generator would not know to prioritize, because the relevant fact (a regulatory nuance,
a specific historical bug, an undocumented cross-field interaction someone only wrote up in a bug
comment) was never encoded into the declared model in the first place. This is squarely a language-
and-domain-understanding task, not a computation task.

**This report does not assert this gap is real or valuable — it asserts the gap is plausible and must
be measured.** §8's evaluation design exists specifically to test whether an AI subagent's proposed
fixtures add hidden-mutant kills or documented rule/invariant coverage (per execution traces, §3.3
below is not itself a coverage metric) *beyond* the full deterministic baseline in §3.2, run to the
same corpus size and cost budget. If the deterministic baseline alone — especially the decision-table
generator, which is driven directly by the same mapping-rule specification — already achieves the
target kill rate and coverage, this report's recommendation is to **not** add an AI subagent step at
all; see §9.

### 3.4 Search-based and hybrid generation: an instructive precedent for the AI's proper role

Search-based test generation (metaheuristic search over the input space guided by a fitness function,
e.g. **EvoSuite**) is a mature, deterministic-algorithm alternative that predates LLM-based approaches
([McMinn 2004](https://philmcminn.com/publications/mcminn2004.pdf), row 16;
[EvoSuite](https://www.evosuite.org/), row 17). The most useful precedent for *how* to bound an AI's
contribution comes from **CodaMosa**, which combines deterministic search-based testing with an LLM
specifically to break through coverage plateaus: "CODAMOSA conducts SBST until its coverage
improvements stall, then asks Codex to provide example test cases for under-covered functions. These
examples help SBST redirect its search" ([Lemieux, Inala, Lahiri & Sen, ICSE 2023](https://www.microsoft.com/en-us/research/publication/codamosa-escaping-coverage-plateaus-in-test-generation-with-pre-trained-large-language-models/),
row 18). The LLM proposes candidate inputs; a deterministic process still drives and validates the
search. This is the same shape recommended here: AI proposes fixtures/scenarios, a deterministic
process (schema validation, the migration script, the reference oracle, mutation testing) validates
and scores them.

### 3.5 LLM test/data generation: real, measured capability — and named failure modes

Direct LLM test generation is empirically capable but comes with well-documented failure modes that
map onto this project's specific risk list:

- **Redundancy/low diversity** (near-duplicate fixtures, not novel scenarios) is measurable, not
  assumed: TestPilot's own evaluation found "92.8% of TestPilot's generated tests have no more than
  50% similarity with existing tests (as measured by normalized edit distance), with none of them
  being exact copies," while also noting effectiveness "does not fundamentally depend on the specific
  model" but is influenced by model size
  ([Schafer, Nadi, Eghbali & Tip 2023/2024](https://arxiv.org/abs/2302.06527), row 19) — directly
  usable as this report's **duplicate/novelty** metric definition (§8). This is a different concern
  from training-data **leakage** below, and this report no longer conflates the two.
- **Invalid cases and oracle hallucination** are two of the risks this report treats as most serious:
  an AI-proposed fixture that doesn't even parse under the v1 schema wastes corpus slots (mitigated by
  requiring every AI-proposed fixture to pass schema validation before acceptance — a deterministic
  gate, not a judgment call); an AI-proposed *expected output* would inherit exactly the oracle
  deficiencies and hallucination risk both LLM-oracle papers name as unresolved (rows 3–4) — which is
  why the oracle is scripted, full stop, the AI is never asked to produce one, and (per the correction
  in §6) that separation is enforced by a real access boundary rather than by the AI simply not being
  *asked* to write one.
- **Leakage (training-data contamination)** is a distinct risk from redundancy: an LLM's proposed
  fixtures could closely mirror material it saw during training — including, in principle, this
  project's own mapping rules or golden cases if any were public before the model's training cutoff.
  Molina & Gorla name "data leakages" as an open threat (row 3) without a resolution; edit-distance
  similarity scoring (used for redundancy, above) does **not** detect this, because a leaked fixture
  may be textually novel relative to the existing corpus while still having been memorized from
  training data elsewhere. Detecting it requires either a dedicated contamination-auditing methodology
  (for example, guided-instruction probing, which reports 92–100% accuracy at detecting whether a
  given LLM was trained on specific reference material —
  [Golchin & Surdeanu 2023](https://arxiv.org/abs/2308.08493), row 26) or, more simply for this
  project's scale, constructing the held-out golden-case set and any preregistered "trap" scenarios
  from **private or newly authored material created after the subagent model's training cutoff**, so
  that no amount of memorization could explain a match. See §8 for how this is built into the
  evaluation design.
- **Cost** is the dimension this pattern already tracks for every reference in this repository (see
  [Observability and measurement](../agent-skill-pattern.md#observability-and-measurement)): parent
  vs. delegated-subagent credit/token consumption, measured, not inferred.

## 4. Decision table: deterministic generator vs. AI vs. hybrid, by requirement type

| Requirement | Deterministic script/tool | AI subagent | Recommended owner |
| --- | --- | --- | --- |
| Schema-valid instance generation (types, formats, required fields) | `hypothesis-jsonschema` / `json-schema-faker` (rows 6–7) generate conformant instances directly from the schema | Not needed — this is a solved, mechanical problem | **Script** |
| Rule/condition-driven fixture derivation (mapping rules already expressed as conditions → actions) | Decision table testing derives fixtures mechanically from the documented condition/action table (row 25) | Can help transcribe prose rules into a condition/action table if one doesn't yet exist, but does not need to derive fixtures from it once it exists | **Script**, AI only for spec transcription if needed |
| Partition/boundary coverage of ordered or categorical fields | Equivalence partitioning and boundary value analysis mechanically derive representative and edge values (row 25) | Not needed | **Script** |
| Parameter-combination coverage (which field-value tuples to include) | PICT / covering arrays mechanically cover t-way interactions from a declared parameter model (rows 9–10) | Can suggest which interactions are domain-meaningful, but does not need to compute the combinations itself | **Script**, informed by AI-flagged priority interactions |
| Constraint-driven/differential input generation and v1-vs-v2 crosschecking | Symbolic execution + SMT solving generates constraint-satisfying inputs and can deterministically crosscheck two implementations (row 24); differential testing is the same split at a coarser grain (row 20) | Not needed for generation; may still help identify *which* constraints are worth crosschecking | **Script** |
| Domain-meaningful scenario selection not reducible to any of the above (real-world/legacy/bug-history cases not yet encoded in any declared model, rule table, or constraint set) | Cannot infer meaning from unstructured prose/history alone | Reads schemas, mapping-rule prose, invariants, legacy examples, and bug history to propose fixtures and label their intent | **AI**, gated by deterministic validation and value measured empirically against the full deterministic baseline (§3.3, §8) |
| Scenario metadata / rationale (why a fixture matters, what rule it targets) | N/A — this is descriptive/semantic content, and is not itself a coverage claim (see next row) | Drafts a short, structured rationale per fixture | **AI**, reviewed as documentation, never trusted as a coverage measurement |
| Semantic rule/path coverage measurement (which rules/paths a corpus actually exercises) | Instrument the deterministic migration/oracle scripts to emit the rule/path ID each executes, and score coverage from those execution traces (§8) | Cannot substitute for a trace — an AI's own label of intent is not evidence the fixture actually took that path | **Script**, from execution traces only |
| Expected v2 output / expected error for a given v1 input | Reference oracle computed directly from the mapping-rule specification, with its own trust chain (§7) | Must never be used — inherits the oracle problem and named LLM-oracle hallucination/deficiency risk (rows 1, 3–4) | **Script, exclusively**, isolated by a real access boundary (§6), not by tool-name omission alone |
| Migration implementation itself | The system under test; deterministic by requirement of this task | Out of scope entirely | **Script, exclusively** |
| Corpus effectiveness measurement (did the fixtures actually exercise the rules?) | Mutation testing: seed faults into the migration implementation, confirm the corpus's oracle comparisons catch them (rows 13–15) — this measures the *corpus's* effectiveness, not the oracle's own correctness (§7) | Cannot substitute for measured kill rate | **Script** |
| Duplicate/novelty scoring of AI-proposed fixtures | Normalized edit distance / similarity scoring against existing corpus and reference set (row 19's method) | The AI produces candidates; it does not score its own diversity | **Script**, over AI output |
| Training-data leakage/contamination detection | Contamination-auditing methodology (row 26), and/or held-out material authored privately or after the model's training cutoff | Cannot self-report whether it has memorized reference material | **Script/process**, distinct from duplicate/novelty scoring |
| Escaping coverage plateaus after initial generation stalls | Deterministic search-based generation alone can plateau (row 16–17) | LLM-suggested candidates to redirect search, validated deterministically (CodaMosa pattern, row 18) | **Hybrid**, script-validated |

## 5. Closest prior art and non-novelty language

Consistent with this repository's existing convention
([README §Research and prior art](../../README.md#research-and-prior-art),
[prior-art.md](./prior-art.md)), **this reference makes no claim of a novel technique**. Every
individual element already exists as documented, independently citable prior art:

- **Deterministic schema-driven instance generation** is exactly what `hypothesis-jsonschema` and
  `json-schema-faker` already do (rows 6–7) — this reference does not propose a new generator, it
  recommends using one of these (or an equivalent) as-is.
- **Combinatorial/covering-array test design** is exactly NIST's and Microsoft PICT's documented
  technique (rows 9–10) — again, use as-is, not reinvent.
- **The pattern of an LLM proposing candidate inputs while a deterministic process drives and
  validates search** is CodaMosa's own documented contribution (row 18) — the closest single
  structural match found in this research for "AI proposes, script decides." This reference's
  recommendation is a scenario-design-level analogue of the exact same shape: AI proposes fixtures/
  scenario metadata; deterministic validation, the reference oracle, and mutation-testing kill rate
  decide whether they're kept and how good they are.
- **Keeping the oracle deterministic while using a search/generation process for inputs** is the same
  split already present in the combinatorial-testing literature itself — NIST's own guide discusses
  "the use of formal models of software to determine the expected results for each set of test
  inputs" as a topic distinct from input generation (row 9) — and is reinforced, not contradicted, by
  every LLM-oracle paper found in this research (rows 1, 3–4), which treat oracle automation as an
  open problem specifically *because* generating inputs is comparatively easy and generating trusted
  expected outputs is not.
- **The AI-subagent role itself** — a bounded, narrow-tool, isolated-context custom agent invoked by a
  minimal routing Skill — is not something this document re-argues; it inherits the composition,
  terminology caveats, and closest-match analysis already established in this repository's
  [`prior-art.md`](./prior-art.md) (LangChain Deep Agents as the closest documented structural match)
  and [`agent-skill-pattern.md`](../agent-skill-pattern.md). This document adds a **new candidate task
  shape** (semantic corpus/scenario design for a deterministic migration) to evaluate against that
  existing pattern definition — it does not revisit or modify the pattern definition itself.

**What this reference specifically does not find prior art for:** a named, evaluated composition of
(a) AI-proposed domain-semantic scenario design, (b) deterministic schema/combinatorial validation of
the proposals, and (c) mutation-testing kill rate as the acceptance metric for the proposals,
applied specifically to configuration-schema migration testing. Its individual parts are all
independently documented (as cited above); their combination for this specific purpose was not found
during this research pass and is not asserted to exist elsewhere.

## 6. Reference contract recommendations

Following this repository's existing Skill/subagent contract shape
([Direct artifact write and compact return](../agent-skill-pattern.md#direct-artifact-write-and-compact-return)),
**with one correction to this pattern's usual isolation reasoning**: GitHub Copilot's own
documentation confirms that a custom agent's `tools` field is "a list of tool names the custom agent
can use... If unset, defaults to all tools"
([Custom agents configuration](https://docs.github.com/en/copilot/reference/custom-agents-configuration),
row 23) — tool names are not scoped to a directory or path. A generic `edit`/`read` tool entry
therefore does **not**, by itself, stop a subagent from writing to an oracle/expected-output location
elsewhere in the same repository; omitting an "oracle tool" from the allowlist is not a real access
boundary when the tools present can already reach that path. This report does not repeat this
repository's existing [recursive-delegation
protection](../agent-skill-pattern.md#recursive-delegation-protection) claim (which is about omitting
a *delegation* tool, a different and still-valid claim) as if it also covered path isolation — it
does not, and this reference does not reuse that reasoning for the oracle boundary.

- **Inputs to the subagent:** the v1 schema, the v2 schema, the mapping-rule specification, documented
  cross-field/domain invariants, a bounded sample of legacy v1 examples, and a bounded excerpt of
  migration-related bug history. All read-only.
- **Outputs from the subagent:** a set of candidate v1 source fixtures (schema-conformant JSON) plus
  structured scenario metadata per fixture (a short label/rationale naming the rule, invariant, or
  history item each fixture is meant to exercise). **No expected v2 output or expected error is ever
  part of the subagent's output.**
- **Isolation architecture (the actual access boundary):** the subagent must write into a location its
  tools have no path to escape — in practice, one of:
  1. a **separate staging repository or worktree** that contains no copy of the oracle, the migration
     implementation, or any golden/expected-output file, so a generic `edit`/`read` tool simply has
     nothing sensitive to reach; or
  2. a **purpose-built, path-constrained tool** exposed via this platform's documented `mcp-servers`
     mechanism (row 23), scoped in its own implementation — not by prompt instruction — to a single
     fixtures/scenario-metadata directory.
  A prose instruction telling the subagent "never write expected output" is retained as a
  defense-in-depth second layer, per this repository's existing structural-first, prose-second
  guard design — but it is explicitly **not** the primary control here, unlike the recursive-
  delegation case where tool-name omission alone is sufficient.
- **Parent-side promotion step:** the parent (not the subagent) validates the staged fixtures against
  the v1 schema and the deterministic baseline's own checks, and only then promotes accepted fixtures
  into the corpus location the reference oracle and migration script read from. The subagent never
  writes directly into that shared location.
- **Direct-write / compact-return behavior:** the subagent writes the fixture set and scenario
  metadata directly to its isolated staging location and returns a compact status (fixture count,
  staging path, one-line summary) — no fixture content streamed back through the parent, consistent
  with this pattern's existing contract; promotion into the shared corpus location is the parent's
  own subsequent, deterministic step, not part of the subagent's direct-write claim.
- **No expected-output generation, ever:** the subagent's tool allowlist and its isolation boundary
  (above) jointly ensure it cannot reach an expected-results location; its instructions additionally
  state this explicitly as the second, defense-in-depth layer.

## 7. Oracle trust and validation

Mutation testing of the migration implementation (§8) measures whether a **corpus** is effective at
catching migration bugs. It does **not** by itself establish that the **reference oracle** itself
computes correct expected results — a mutant-killing corpus paired with a subtly wrong oracle will
simply agree with the wrong oracle and report success. The oracle needs its own, separate trust chain:

- **An executable, reviewed specification.** The mapping-rule specification should exist as a
  reviewed, version-controlled artifact (not only prose) that the oracle script is built from and that
  a human reviewer signs off on independently of any test result — the oracle's correctness claim
  rests on this review, not on tests passing against itself.
- **Hand-reviewed golden cases.** A small, human-authored and human-reviewed set of v1→v2 input/output
  pairs, derived by a person reading the specification (not generated by any script or AI), serves as
  a ground-truth check that the oracle's own computed output matches what a domain expert independently
  worked out by hand for at least a representative sample.
- **Metamorphic invariants.** Where a full independent expected-output check is impractical for every
  fixture, metamorphic relations between related inputs and outputs (for example, "reordering
  independent v1 fields must not change the v2 result") provide an oracle-adjacent check that does not
  require enumerating every individual expected value, per the established technique surveyed in row 2
  — but, as row 2 itself makes clear, the relations must still be explicitly and deterministically
  defined, never inferred by an LLM at test time.
- **An independent differential implementation, where feasible.** If a second, independently written
  implementation of the v1→v2 mapping can be produced (for example, by a different engineer working
  only from the specification, not from the first implementation's code), running both implementations
  against the same corpus and flagging divergences is the differential-testing technique documented in
  row 20, and in the constraint/SMT literature's own use of symbolic execution to "crosscheck
  purportedly identical" implementations (row 24). This is the strongest available check on the oracle
  itself, and should be used wherever the mapping is complex enough to justify the cost of a second
  implementation; where it is not feasible, the golden-case and metamorphic-invariant checks above are
  the fallback, not a full substitute.

Only once the oracle has this trust chain does hidden-mutant kill rate (§8) mean what it is intended
to mean: a measure of the *corpus's* ability to expose real migration defects, checked against a
reference that has itself been independently validated rather than merely asserted to be correct
because it is a script.

## 8. Evaluation design recommendation

Five arms, run against the same fixed set of migration mapping rules and the same held-out mutant
set (mutants not visible to any arm during corpus construction). The first four are a **partial
factorial design** separating *delegation* (subagent vs. inline) from *model tier* (parent model vs.
cheap/small model), plus the deterministic baseline as a control:

1. **Script-only baseline.** The full deterministic baseline from §3.2: decision-table-driven
   generation from the mapping-rule specification, schema-driven generation (rows 6–7), combinatorial
   coverage (rows 9–10), and constraint/SMT-based generation where feasible (row 24) over the declared
   v1/v2 parameter model, with no AI-authored scenario-design layer.
2. **Parent model, inline.** The primary/parent model performs the scenario-design task directly in
   its own session (no delegation to a subagent), consuming its own context and credits for the full
   task.
3. **Parent model, delegated.** The same parent model, but invoked as an isolated subagent per this
   repository's Agent Skill Pattern and this reference's contract (§6) — isolates the effect of
   delegation (context isolation, narrow tool allowlist, staging boundary) independent of model tier,
   since the model is unchanged from arm 2.
4. **Cheap/small model, inline.** A smaller/cheaper model performs the scenario-design task directly
   in the primary session, if and only if the harness in use supports selecting a non-default model
   for the primary session's inline work. **Limitation:** several harnesses, including this
   repository's reference GitHub Copilot CLI setup, do not expose an inline model swap independent of
   delegation — if the evaluator's harness cannot run this arm, this must be stated explicitly as a
   **partial-factorial limitation**, and arm 5 below (delegated cheap model) should not be
   misinterpreted as isolating model tier on its own when arm 4 is missing.
5. **Cheap/small model, delegated.** A narrow-tool, isolated-context subagent (per §6) on a smaller/
   cheaper model performs the same scenario-design task — this is the configuration this repository's
   Agent Skill Pattern recommends by default, and the one most existing references in this repository
   (e.g. `ascii-art`) already use.

Comparing arm 2 vs. arm 3 isolates the effect of delegation/isolation holding model tier fixed; arm 3
vs. arm 5 isolates the effect of model tier holding delegation fixed (when arm 4 is available, arm 2
vs. arm 4 provides the same model-tier isolation without delegation, as a cross-check). All four AI
arms are compared against arm 1 to answer the empirical question in §3.3: does any AI configuration
add hidden-mutant kills or documented rule/invariant coverage beyond the deterministic baseline alone.

**Metrics, all measured, none inferred:**

- **Deterministic validity** — % of proposed fixtures that pass v1 schema validation unmodified.
- **Semantic rule/path coverage** — % of documented mapping rules and cross-field/domain invariants
  actually exercised, measured **from the deterministic migration/oracle scripts' own execution
  traces** (instrument each script to emit the rule or path ID it executes for a given fixture), never
  from the AI-authored scenario metadata's self-reported labels. Scenario metadata may be used only as
  an explanatory cross-reference to independently check *why* a human reviewer believes a fixture was
  proposed, not as the coverage measurement itself.
- **Hidden-mutant kill rate** — % of a held-out set of deliberately seeded faults in the migration
  implementation that the corpus's reference-oracle comparisons detect, per PIT's own
  killed/survived/no-coverage taxonomy (row 15) adapted to this project's language/tooling. Per §7,
  this measures corpus effectiveness against an oracle whose own correctness has been separately
  validated — it is not itself an oracle-correctness check.
- **Diagnostic coverage** — % of the mapping specification's distinct documented error/rejection
  conditions that have at least one fixture producing that specific error (again via execution trace,
  not scenario-label self-report).
- **Duplicate/novelty detection** — normalized edit distance (or equivalent similarity measure) among
  proposed fixtures and against the existing corpus, per TestPilot's own method (row 19); flag
  near-duplicates above a fixed similarity threshold. This metric detects redundancy, not leakage —
  see the next metric.
- **Contamination/leakage auditing** — a separate check from duplicate/novelty detection: apply a
  contamination-auditing methodology (row 26) to the AI arms, and/or preregister a held-out set of
  golden cases and "trap" scenarios authored privately or after the subagent model's training cutoff,
  so a suspiciously accurate or verbatim match against material the AI was never given as input is a
  meaningful signal rather than an assumed non-issue.
- **Parent/total credits and tokens** — parent cumulative input and total nano-AIU (or this
  environment's equivalent), split by arm, matching this repository's existing
  [Observability and measurement](../agent-skill-pattern.md#observability-and-measurement) convention
  of keeping measured cost separate from any inferred-savings narrative.
- **Quality** — blinded human (or fixed-rubric) review of a sample of proposed scenario rationales for
  relevance and correctness of the rule/invariant they claim to target.
- **Latency** — wall-clock time per arm to produce a corpus of fixed target size.

Preregister the target mutant set, the mapping-rule/invariant checklist used for semantic coverage,
the similarity threshold for duplicate/novelty detection, and the contamination-auditing protocol
**before** running any arm, per §9 below.

## 9. Risks and preregistration guidance

- **Invalid or off-schema fixtures.** Mitigate with a mandatory deterministic schema-validation gate
  between AI proposal and corpus acceptance; report the pre-gate invalid rate as its own metric rather
  than silently filtering it out.
- **Redundancy (near-duplicates).** Score every arm's output with the same similarity metric (row 19)
  against the same reference set; a delegated-cheap-model arm that "wins" on fixture count but not on
  unique-rule coverage should be reported as such, not averaged away.
- **Oracle hallucination.** Mitigated by an **isolation architecture that is a real access boundary**
  (§6) — a staging repository/worktree or a path-constrained tool the subagent's tools cannot escape —
  combined with the oracle's own separate trust chain (§7). This report does not claim this is
  "structurally prevented" by tool-name omission alone: as row 23 documents, a generic `edit`/`read`
  tool is not path-scoped, so the boundary must be architectural (a location the tools cannot reach),
  not a matter of which tool names happen to be listed. This remains the single highest-severity risk
  this reference exists to close off, per rows 1 and 3–4.
- **Leakage (training-data contamination), distinct from redundancy.** An AI-proposed fixture that
  closely reproduces material the model saw during training (rather than a genuinely new scenario, and
  rather than a mere near-duplicate of the existing corpus) is not detected by edit-distance similarity
  scoring alone. Mitigate with a dedicated contamination-auditing methodology (row 26) applied to the
  AI arms, and by constructing golden cases and any preregistered "trap" scenarios from material
  authored privately or after the subagent model's training cutoff, so a suspicious match cannot be
  explained by memorization of publicly available prior work.
- **Oracle correctness (separate from corpus effectiveness).** A high hidden-mutant kill rate only
  means the corpus is effective against *whatever oracle it was scored against*. Mitigate per §7:
  require the oracle's own trust chain (reviewed executable spec, hand-reviewed golden cases,
  metamorphic invariants, and an independent differential implementation where feasible) before
  treating kill-rate results as evidence about real migration correctness rather than internal
  self-consistency.
- **AI-authored coverage claims mistaken for measured coverage.** Mitigate by scoring semantic
  rule/path coverage exclusively from the deterministic migration/oracle scripts' own execution traces
  (§8); treat any AI-authored scenario label as an explanatory annotation to be spot-checked by a human
  reviewer, never as the coverage number itself.
- **Partial factorial design.** If the evaluation harness cannot run arm 4 (cheap/small model, inline)
  independently of delegation, state this limitation explicitly in any report of results, and do not
  present the arm 3 vs. arm 5 comparison as if it cleanly isolated model tier when the arm 2 vs. arm 4
  cross-check is unavailable.
- **Cost asymmetry.** Report parent vs. subagent credit/token consumption per arm exactly as this
  repository's existing benchmark does (see
  [README §Benchmark](../../README.md#benchmark) for the format), and do not claim an efficiency
  benefit unless a preregistered marker is actually met — the existing `ascii-art` benchmark's
  experience in this same repository is a direct, in-repository precedent for **not** assuming a
  cheaper model produces a net efficiency win.
- **Preregistration guidance.** Before running any evaluation arm, fix and publish: (a) the mutant
  set and mutation operators used for hidden-mutant kill rate, (b) the full checklist of mapping rules
  and cross-field/domain invariants used for semantic coverage scoring (and confirmation that coverage
  will be scored from execution traces, not scenario labels), (c) the similarity metric and threshold
  used for duplicate/novelty detection, (d) the contamination-auditing protocol and/or held-out
  privately-authored material used for leakage detection, (e) the oracle's own trust-chain artifacts
  (reviewed spec, golden cases, metamorphic invariants, and differential implementation if used) as
  reviewed and signed off *before* any arm is scored against that oracle, and (f) the fixed target
  corpus size used for the latency comparison. Any metric not on this preregistered list that is
  reported later should be clearly labeled exploratory, matching this repository's existing practice
  of keeping measured, preregistered results distinct from directional/inferred ones.

## 10. Summary

A strong deterministic baseline — schema-driven generation, decision tables, covering arrays,
boundary/equivalence partitioning, and constraint/SMT-based generation — already covers most of the
corpus-design space and should be measured, not assumed away. Where an AI subagent may plausibly add
value is reading unstructured material (mapping-rule prose, legacy examples, bug history) not yet
reduced to any declared model, and proposing fixtures and scenario metadata from it — but this value
must be demonstrated empirically, against the full deterministic baseline, using coverage measured
from execution traces rather than the AI's own labels. The AI is never suited to anything involving
the expected-output oracle, which must remain a deterministic script with its own independently
validated trust chain (§7), isolated from the AI subagent by a real access boundary rather than by
tool-name omission (§6), with mutation testing measuring the resulting corpus's effectiveness against
that independently-validated oracle — not the oracle's own correctness.

