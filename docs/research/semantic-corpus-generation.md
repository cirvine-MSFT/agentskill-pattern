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
> output or expected error for any fixture it proposes. A deterministic reference oracle, built from
> the same mapping-rule specification the migration script implements, computes every expected
> result. Corpus effectiveness — whether the fixtures the AI helped design actually exercise the
> rules that matter — is measured after the fact with **mutation testing**: seed deliberate faults
> ("hidden mutants") into the migration implementation and confirm the corpus's oracle comparisons
> catch them.

This follows directly from the test oracle problem literature: the hard, correctness-defining part
of testing is not enumerating inputs, it is deciding what the *correct* output is
([Barr, Harman, McMinn, Bowes & Yoo 2015](http://www0.cs.ucl.ac.uk/staff/m.harman/tse-oracle.pdf),
row 1 — "the challenge of distinguishing the corresponding desired, correct behaviour from
potentially incorrect behavior is called the 'test oracle problem'"). Even the academic
alternative to a full formal oracle, metamorphic testing, still requires a programmatically defined,
non-hallucinated relation between inputs and outputs, not an LLM's guess
([Segura, Fraser, Sanchez & Ruiz-Cortes 2016](https://eprints.whiterose.ac.uk/id/eprint/110335/),
row 2). And the two most on-point papers found in this research — one written specifically to make
the case *for* LLM-generated oracles — both name oracle deficiency and data leakage as open,
unresolved risks rather than solved problems
([Molina & Gorla 2024](https://arxiv.org/abs/2405.12766), row 3;
[Bodicoat et al. 2026](https://arxiv.org/abs/2601.05542), row 4). For a migration whose correctness
criterion is a **known, documented, deterministic mapping**, there is no reason to accept that risk:
the oracle can and should be computed by a script built directly from the specification.

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

### 3.2 Combinatorial and grammar-based generation bound the space efficiently — mechanically

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

**None of this requires an AI subagent.** A declared parameter model of the v1/v2 field space, fed to
PICT or an equivalent covering-array generator, mechanically produces the combination skeleton of the
corpus.

### 3.3 What scripts alone do *not* give you: which combinations are semantically interesting

Combinatorial and schema-driven generation are blind to *domain* meaning. They will happily cover
every pairwise combination of field values without knowing that a particular triple corresponds to a
regulatory edge case, a documented historical bug, or a scenario that stresses a specific,
easily-miscoded branch of the mapping rules. This is the concrete gap the AI subtask fills: **reading**
the v1/v2 schemas, the mapping-rule specification, cross-field/domain invariants, a sample of legacy
production examples, and the bug tracker's migration-related history, and **proposing** a set of
source fixtures plus scenario metadata (what each fixture is meant to exercise, and why) that a purely
combinatorial or schema-driven generator would not know to prioritize. This is squarely a language-
and-domain-understanding task, not a computation task — which is exactly why it is the one place in
this pipeline where a bounded AI subagent is appropriate.

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

- **Redundancy/low diversity** is measurable, not assumed: TestPilot's own evaluation found "92.8% of
  TestPilot's generated tests have no more than 50% similarity with existing tests (as measured by
  normalized edit distance), with none of them being exact copies," while also noting effectiveness
  "does not fundamentally depend on the specific model" but is influenced by model size
  ([Schafer, Nadi, Eghbali & Tip 2023/2024](https://arxiv.org/abs/2302.06527), row 19) — directly
  usable as this report's redundancy/diversity metric definition.
- **Invalid cases and oracle hallucination** are the two risks this report treats as most serious:
  an AI-proposed fixture that doesn't even parse under the v1 schema wastes corpus slots (mitigated by
  requiring every AI-proposed fixture to pass schema validation before acceptance — a deterministic
  gate, not a judgment call); an AI-proposed *expected output* would inherit exactly the oracle
  deficiencies and hallucination risk both LLM-oracle papers name as unresolved (rows 3–4) — which is
  why the oracle is scripted, full stop, and the AI is never asked to produce one.
- **Leakage** — an LLM proposing fixtures that closely mirror its own training data or, worse,
  memorized examples from this repository's own prior work — is named explicitly as a threat by
  Molina & Gorla (row 3) and is addressed in the evaluation design below (§6) via novelty/diversity
  scoring against a held-out reference set, not by trusting the model's self-report.
- **Cost** is the dimension this pattern already tracks for every reference in this repository (see
  [Observability and measurement](../agent-skill-pattern.md#observability-and-measurement)): parent
  vs. delegated-subagent credit/token consumption, measured, not inferred.

## 4. Decision table: deterministic generator vs. AI vs. hybrid, by requirement type

| Requirement | Deterministic script/tool | AI subagent | Recommended owner |
| --- | --- | --- | --- |
| Schema-valid instance generation (types, formats, required fields) | `hypothesis-jsonschema` / `json-schema-faker` (rows 6–7) generate conformant instances directly from the schema | Not needed — this is a solved, mechanical problem | **Script** |
| Parameter-combination coverage (which field-value tuples to include) | PICT / covering arrays mechanically cover t-way interactions from a declared parameter model (rows 9–10) | Can suggest which interactions are domain-meaningful, but does not need to compute the combinations itself | **Script**, informed by AI-flagged priority interactions |
| Domain-meaningful scenario selection (which combinations correspond to real-world/legacy/bug-history cases) | Cannot infer domain meaning from a schema alone | Reads schemas, mapping rules, invariants, legacy examples, and bug history to propose fixtures and label their intent | **AI**, gated by deterministic validation |
| Scenario metadata / rationale (why a fixture matters, what rule it targets) | N/A — this is descriptive/semantic content | Drafts a short, structured rationale per fixture | **AI**, reviewed, not executed as code |
| Expected v2 output / expected error for a given v1 input | Reference oracle computed directly from the mapping-rule specification | Must never be used — inherits the oracle problem and named LLM-oracle hallucination/deficiency risk (rows 1, 3–4) | **Script, exclusively** |
| Migration implementation itself | The system under test; deterministic by requirement of this task | Out of scope entirely | **Script, exclusively** |
| Corpus effectiveness measurement (did the fixtures actually exercise the rules?) | Mutation testing: seed faults into the migration implementation, confirm the corpus's oracle comparisons catch them (rows 13–15) | Cannot substitute for measured kill rate | **Script** |
| Redundancy/diversity scoring of AI-proposed fixtures | Normalized edit distance / similarity scoring against existing corpus and reference set (row 19's method) | The AI produces candidates; it does not score its own diversity | **Script**, over AI output |
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
([Direct artifact write and compact return](../agent-skill-pattern.md#direct-artifact-write-and-compact-return)):

- **Inputs to the subagent:** the v1 schema, the v2 schema, the mapping-rule specification, documented
  cross-field/domain invariants, a bounded sample of legacy v1 examples, and a bounded excerpt of
  migration-related bug history. All read-only.
- **Outputs from the subagent:** a set of candidate v1 source fixtures (schema-conformant JSON) plus
  structured scenario metadata per fixture (a short label/rationale naming the rule, invariant, or
  history item each fixture is meant to exercise). **No expected v2 output or expected error is ever
  part of the subagent's output** — that is computed exclusively by the deterministic reference oracle,
  run separately, after the fixtures exist.
- **Tools:** read access to schemas/specs/examples/bug history; write access limited to the fixture
  and scenario-metadata files it is producing. No execution of the migration script, no execution of
  the oracle, and no tool that would let it invoke or influence either — mirroring this pattern's
  existing [recursive-delegation protection](../agent-skill-pattern.md#recursive-delegation-protection)
  principle of structural exclusion over prose instruction.
- **Direct-write / compact-return behavior:** the subagent writes the fixture set and scenario
  metadata directly to the corpus location and returns a compact status (fixture count, file path,
  one-line summary) — no fixture content streamed back through the parent, consistent with this
  pattern's existing contract.
- **No expected-output generation, ever:** this is the one hard boundary this reference adds on top of
  the existing pattern contract. The subagent's tool allowlist must not include anything that writes to
  an "expected results" location, and its instructions must state this explicitly as a second,
  defense-in-depth layer — matching this repository's existing structural-first, prose-second guard
  design.

## 7. Evaluation design recommendation

Three arms, run against the same fixed set of migration mapping rules and the same held-out mutant
set (mutants not visible to any arm during corpus construction):

1. **Script-only baseline.** Deterministic schema-driven generation (row 6/7) plus combinatorial
   coverage (row 9/10) over the declared v1/v2 parameter model, with no domain-semantic scenario
   design layer.
2. **Parent-only AI.** The primary/parent model itself performs the scenario-design task in-line
   (no delegation to a subagent), consuming its own context and credits for the full task.
3. **Delegated cheap-model AI.** A narrow-tool, isolated-context subagent (per §6) on a smaller/
   cheaper model performs the same scenario-design task, per this repository's Agent Skill Pattern.

**Metrics, all measured, none inferred:**

- **Deterministic validity** — % of proposed fixtures that pass v1 schema validation unmodified.
- **Semantic rule/path coverage** — % of documented mapping rules and cross-field/domain invariants
  exercised by at least one fixture (traceable via the scenario metadata's rule/invariant labels).
- **Hidden-mutant kill rate** — % of a held-out set of deliberately seeded faults in the migration
  implementation that the corpus's reference-oracle comparisons detect, per PIT's own
  killed/survived/no-coverage taxonomy (row 15) adapted to this project's language/tooling.
- **Diagnostic coverage** — % of the mapping specification's distinct documented error/rejection
  conditions that have at least one fixture producing that specific error, not just "an" error.
- **Redundancy/diversity** — normalized edit distance (or equivalent similarity measure) among
  proposed fixtures and against the existing corpus, per TestPilot's own method (row 19); flag
  near-duplicates above a fixed similarity threshold.
- **Parent/total credits and tokens** — parent cumulative input and total nano-AIU (or this
  environment's equivalent), split by arm, matching this repository's existing
  [Observability and measurement](../agent-skill-pattern.md#observability-and-measurement) convention
  of keeping measured cost separate from any inferred-savings narrative.
- **Quality** — blinded human (or fixed-rubric) review of a sample of proposed scenario rationales for
  relevance and correctness of the rule/invariant they claim to target.
- **Latency** — wall-clock time per arm to produce a corpus of fixed target size.

Preregister the target mutant set, the mapping-rule/invariant checklist used for semantic coverage,
and the similarity threshold for redundancy **before** running any arm, per §8 below.

## 8. Risks and preregistration guidance

- **Invalid or off-schema fixtures.** Mitigate with a mandatory deterministic schema-validation gate
  between AI proposal and corpus acceptance; report the pre-gate invalid rate as its own metric rather
  than silently filtering it out.
- **Redundancy.** Score every arm's output with the same similarity metric (row 19) against the same
  reference set; a delegated-cheap-model arm that "wins" on fixture count but not on unique-rule
  coverage should be reported as such, not averaged away.
- **Oracle hallucination.** Structurally prevented, not merely discouraged, by never granting the
  subagent any tool capable of writing to an expected-results location (§6); this is the single
  highest-severity risk this reference exists to close off, per rows 1 and 3–4.
- **Leakage.** An AI-proposed fixture that closely reproduces a memorized legacy example (rather than
  a genuinely new scenario) understates the corpus's true novelty. Mitigate by scoring proposed
  fixtures for similarity against the legacy-example sample the subagent was given, not only against
  other proposed fixtures.
- **Cost asymmetry.** Report parent vs. subagent credit/token consumption per arm exactly as this
  repository's existing benchmark does (see
  [README §Benchmark](../../README.md#benchmark) for the format), and do not claim an efficiency
  benefit unless a preregistered marker is actually met — the existing `ascii-art` benchmark's
  experience in this same repository is a direct, in-repository precedent for **not** assuming a
  cheaper model produces a net efficiency win.
- **Preregistration guidance.** Before running any evaluation arm, fix and publish: (a) the mutant
  set and mutation operators used for hidden-mutant kill rate, (b) the full checklist of mapping rules
  and cross-field/domain invariants used for semantic coverage scoring, (c) the similarity metric and
  threshold used for redundancy/diversity and leakage scoring, and (d) the fixed target corpus size
  used for the latency comparison. Any metric not on this preregistered list that is reported later
  should be clearly labeled exploratory, matching this repository's existing practice of keeping
  measured, preregistered results distinct from directional/inferred ones.

## 9. Summary

Scripts already solve schema-valid instance generation and combinatorial coverage; they cannot infer
which combinations are domain-meaningful. An AI subagent is well-suited to that one gap — proposing
semantically diverse fixtures and scenario metadata from the schemas, mapping rules, invariants,
legacy examples, and bug history — and poorly suited to anything involving the expected-output
oracle, which must remain a deterministic script built from the mapping-rule specification, with
mutation testing as the deterministic measure of whether the AI's proposed corpus was any good.
