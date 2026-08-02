# Agent Skill Pattern

**Agent Skill Pattern** is repository-local terminology for composing established
agent mechanisms:

1. a small, progressively disclosed Agent **Skill** recognizes a bounded subtask;
2. the parent delegates that subtask to a separate, usually cheaper custom agent;
3. the worker receives a narrow tool surface and isolated context;
4. the worker writes the artifact directly and returns compact status.

The name describes this wiring, not a novel primitive. See
[`docs/agent-skill-pattern.md`](docs/agent-skill-pattern.md) for the detailed
architecture and [`docs/research/prior-art.md`](docs/research/prior-art.md) for the
evidence and terminology review.

## When it may fit

Use the pattern only for a repeatable, well-bounded task that does not need the
parent's full history and can be evaluated independently. Delegation can isolate
working context and move work to a cheaper model, but it adds routing, tool, latency,
and reliability costs. Model price alone is not evidence that the complete workflow is
cheaper or good enough.

| Role | Responsibility |
| --- | --- |
| Harness | Exposes Skills and agents and performs delegation. |
| Parent | Owns the main task and decides whether the Skill applies. |
| Skill | Provides progressive discovery and routing instructions only. |
| Worker | Performs the bounded subtask with minimal tools, writes the artifact, and returns compact status. |

Editable architecture diagrams and rendered PNGs are in
[`docs/diagrams/`](docs/diagrams/).

## Implementations

| Use case | Components | Status |
| --- | --- | --- |
| ASCII art | [`ascii-art` Skill](.github/skills/ascii-art/SKILL.md), [agent](.github/agents/ascii-art.agent.md), [notes](docs/reference-implementations/ascii-art.md) | Implemented; controlled benchmark was faster but costlier and lower quality. |
| Semantic test corpus | [`semantic-test-corpus` Skill](.github/skills/semantic-test-corpus/SKILL.md), [agents](.github/agents/semantic-test-corpus.agent.md), [confined MCP](tools/semantic-corpus-mcp/), [notes](docs/reference-implementations/semantic-test-corpus.md) | Implemented; controlled benchmark saved AI credits and parent context but lost held-out quality and reliability. |
| Release-note synthesis | [`release-note-synthesis` Skill](.github/skills/release-note-synthesis/SKILL.md), [agent](.github/agents/release-note-haiku.agent.md), [two-tool MCP](tools/release-note-mcp/) | Feasibility only; runtime wiring failed before semantic quality could be tested. |
| Action-item extraction | [retained v3 Skill and agent](experiments/action-item-extraction/candidate/) | Feasibility only; context isolation worked, but held-out tuple quality and grounding failed. |
| Feature documentation | [`feature-documentation` Skill](.github/skills/feature-documentation/SKILL.md), [fixed-Haiku agent](.github/agents/feature-documentation-haiku.agent.md), [preregistered experiment](experiments/documentation-delegation/) | Preregistered design only; zero AI observations and no execution authorization. |
| Unit-test authoring | [fixed-Haiku candidate Skill and agent](experiments/unit-test-delegation/candidate/), [preregistered experiment](experiments/unit-test-delegation/) | Preregistered design only; zero AI observations and no execution authorization. |

## What the experiments found

The compact [experiment index](experiments/README.md) is the canonical cross-study
summary. Each study retains one concise protocol and one canonical report.

- **Semantic corpus:** the target GPT-parent-to-Haiku-worker arm used 38.8% fewer
  combined AI credits and 58.0% less parent cumulative input than GPT inline, but
  used 88.0% more total model tokens, took 72.0% longer, missed held-out path and
  mutant-quality floors, and was treatment-adherent in only 1/12 units.
- **ASCII:** treatment finished 54.9% faster among 20 complete pairs, but used 69.7%
  more combined AI credits and 53.9% more parent cumulative input, with deterministic
  pass 25 percentage points lower and blinded overall quality 0.883 points lower.
- **Release notes:** the Skill and worker were reached, but canonical MCP tools never
  executed and no draft artifact was produced. Semantic quality was never tested.
- **Action items:** the v3 mechanics isolated transcript/file work from the parent, but
  the three excluded pilots averaged 0.462 tuple F1 and failed the 100% grounding
  requirement.

Quality was assessed by repository-owned deterministic external evaluators and, for
ASCII, blinded artifact judging. The parent model did not grade its own output.
Release-note and action-item runs were excluded feasibility probes without valid
control arms; they are not controlled evidence. No main study followed any probe.

AI credits are the runtime's available usage measure, not a portable dollar cost.
Combined values include parent and worker usage and exclude evaluator/judge usage
unless explicitly stated.

## Repository map

| Path | Purpose |
| --- | --- |
| [`.github/skills/`](.github/skills/) and [`.github/agents/`](.github/agents/) | Live routing Skills and custom agents |
| [`tools/`](tools/) and [`tests/`](tests/) | Confined MCP implementations and tests |
| [`docs/`](docs/) | Pattern, diagrams, prior art, and implementation notes |
| [`experiments/`](experiments/) | Protocols, canonical results, and retained reproducibility source |

The repository intentionally excludes raw event streams, copied runtime payloads,
per-run evidence bundles, generated dashboards, and obsolete one-shot harnesses.
Negative findings, limitations, preregistered dispositions, and the Git history that
contains the original evidence packages remain explicit.

## Status

The pattern remains a research pattern, not a validated optimization. The controlled
studies did not establish a positive quality-adjusted efficiency result, the feasibility
probes did not authorize confirmation, and no main study was run.

Released under the [MIT License](LICENSE).
