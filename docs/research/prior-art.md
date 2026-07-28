# Prior-art research: Agent Skill + cost-tiered subagent composition

**Date of research:** 2026-07-28
**Scope of this document:** `docs/research/**` only. This report, `evidence.csv`, and `search-log.md` are companion artifacts — every substantive claim below is backed by a row in [`evidence.csv`](./evidence.csv), and every search performed (including negative results) is logged in [`search-log.md`](./search-log.md).

## 1. Purpose and scope

This report surveys prior art relevant to a specific, composed pattern:

> A minimal **Agent Skill** is used *only* for progressive-disclosure discovery and routing by a parent LLM. When triggered, it invokes a **custom subagent** running on a cheaper/smaller model, with a **narrow tool allowlist**, an **isolated context window**, the ability to **write artifacts directly** (rather than streaming large content through the parent), and a **compact return value** back to the parent — all in service of reducing the parent model's token/credit consumption. The reference implementation targets **GitHub Copilot**, with **GPT-5.6 Sol** as the parent/orchestrator model and **Claude Haiku 4.5** as the specialist subagent model.

The goal of this research is narrow and evidentiary: to establish what has already been documented, by whom, and how it does or does not overlap with the composition above — **not** to assess patentability, novelty, or freedom to operate, and **not** to recommend an implementation. Legal clearance is explicitly out of scope.

## 2. Methodology

- **First-party sources first.** For every vendor/framework in scope (Anthropic/Claude, GitHub Copilot, OpenAI Agents SDK, Google ADK, Microsoft AutoGen/Semantic Kernel/Azure Architecture Center, LangChain/LangGraph, CrewAI), the primary product or engineering documentation was fetched directly rather than relied upon via search-summary text.
- **Academic sources verified at the source.** Claims from FrugalGPT, RouteLLM, and AutoGen are drawn from the papers' own abstracts (fetched from arXiv), not from secondary summaries.
- **Gray literature clearly labeled.** Two informal/community sources are cited to establish that no settled naming convention exists for this composition; both are explicitly flagged as gray literature with lower confidence than first-party docs, and one is used specifically to illustrate a conflation this report intentionally avoids (see §5).
- **One low-confidence preprint flagged, not treated as established.** A very recent, non-peer-reviewed arXiv preprint on tool-schema overhead is cited only as a directional signal, with an explicit low-confidence flag (see §6).
- **Every row in `evidence.csv` records:** component/claim, title, org/author, URL, publication or last-updated date (or "accessed" date where a vendor doc has no visible revision date), source type, an exact quote or a clearly-labeled faithful paraphrase, a relevance tag (`direct` / `partial` / `component-only`), a confidence tag, and caveats.
- **Full query and catalog list** is in [`search-log.md`](./search-log.md), including explicit negative-result findings (no canonical name found, no direct academic measurement found for tool-schema token cost in isolation, etc.).

## 3. Closest prior art, by source

### 3.1 Anthropic / Claude — Agent Skills and Subagents (documented as *separate* mechanisms)

Anthropic documents **Agent Skills** and **Subagents** as two distinct, complementary features, and its own blog is explicit that they solve different problems:

- **Agent Skills** use a three-level progressive-disclosure model — metadata (loaded at startup), skill body (loaded on trigger), and bundled resources (loaded on demand) — specifically so that "an unlimited number of skills" can be made available without consuming context until one is actually invoked ([Equipping agents for the real world with Agent Skills](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills), 2025-10-16, updated 2025-12-18). This is the direct antecedent of the "minimal skill used only for discovery/routing" half of the composition in scope.
- The open [Agent Skills specification](https://agentskills.io/specification) formalizes `SKILL.md` frontmatter (`name`, `description`, and an **experimental** `allowed-tools` field) as a portable format independent of any one vendor.
- **Subagents**, per Claude Code's own docs, run in "a separate context window from the main conversation," can be restricted to "a specific set of tools," and can be assigned a **different, often cheaper, model** than the primary agent — explicitly for cost/latency control ([Create custom subagents](https://code.claude.com/docs/en/sub-agents)).
- Anthropic's own comparison post states Skills are "knowledge and instructions," while Subagents are "isolated workers with their own context" — i.e., Anthropic itself treats these as two separate primitives, not one named composition ([Skills explained](https://claude.com/blog/skills-explained)).

**Relevance:** direct component-level prior art for *both halves* of the composition (skill-based progressive disclosure; subagent-based isolated, tool-restricted, cost-tiered delegation) — but not for the two wired together as a single pattern.

### 3.2 GitHub Copilot — custom agents / sub-agent orchestration (the reference platform)

GitHub's own docs describe **custom agents** that the parent model can invoke as isolated sub-agents, each with its own scoped tool list and instructions ([Custom agents and sub-agent orchestration](https://docs.github.com/en/copilot/how-tos/copilot-sdk/features/custom-agents)). Copilot CLI documentation confirms that "the model may, at its own judgment, delegate part of a task to a custom agent," with agent profiles defining tools and behavior independently of the parent ([Invoking custom agents](https://docs.github.com/en/copilot/how-tos/copilot-cli/use-copilot-cli/invoke-custom-agents)).

Both models named in the target composition are confirmed generally available in Copilot: **GPT-5.6 Sol** and **Claude Haiku 4.5** ([Supported AI models in GitHub Copilot](https://docs.github.com/en/copilot/reference/ai-models/supported-models)). GitHub's changelog positions Sol as the highest-reasoning (and by implication priciest) tier of the GPT-5.6 family ([changelog, 2026-07-09](https://github.blog/changelog/2026-07-09-openais-gpt-5-6-sol-terra-and-luna-are-now-available-in-github-copilot/)).

**Measured pricing (not inferred):** GitHub's own billing reference lists per-token prices directly: GPT-5.6 Sol is priced well above Claude Haiku 4.5 at the ≤272K context tier ([Models and pricing for GitHub Copilot](https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing)). This is the strongest first-party, dated, *measured* evidence for the "cheaper specialist model" economic rationale in the target composition — see `evidence.csv` row 9 for the exact figures quoted at time of research.

**Relevance:** direct architectural prior art for the parent→custom-subagent mechanism this repository is built on, and direct, measured confirmation of the cost differential between the two named models. GitHub's docs do not, however, describe a named "skill triggers subagent" composition either — the skill and custom-agent mechanisms are documented as separate features.

### 3.3 OpenAI Agents SDK — Handoffs and Agents-as-tools

OpenAI's SDK documents two related but distinct multi-agent mechanisms: **Handoffs**, where control fully transfers to another agent (represented internally as a callable tool) ([Handoffs](https://openai.github.io/openai-agents-python/handoffs/)), and **Agents-as-tools**, where a "manager" agent retains control and calls specialist agents as tools, receiving their output back into its own context ([Agent orchestration](https://openai.github.io/openai-agents-python/multi_agent/)). Each agent can be assigned an independent `model`, permitting a cheaper model for a specialist ([Agents](https://openai.github.io/openai-agents-python/agents/)).

**Relevance:** partial — the agents-as-tools pattern (parent retains control, specialist returns a result, per-agent model choice) is architecturally close to the "compact return to parent" and "cheaper specialist model" elements, but OpenAI's docs have no analog to Anthropic-style progressive-disclosure Skills as the *trigger* mechanism.

### 3.4 Google Agent Development Kit (ADK) — coordinator/sub-agent "modes"

Google's ADK documents a coordinator agent delegating to sub-agents, with an explicit `mode` parameter controlling how much of the sub-agent's interaction/output flows back to the coordinator (e.g., a scoped, single-turn mode vs. a full conversational hand-off) ([Build collaborative agent teams](https://adk.dev/workflows/collaboration/)).

**Relevance:** partial — the scoped-return-value concept overlaps with "compact return," but ADK has no Skill-like progressive-disclosure discovery layer documented as its trigger.

### 3.5 Microsoft — AutoGen, Semantic Kernel, Azure Architecture Center

- **AutoGen** documents a "Handoffs" design pattern and explicitly attributes the handoff concept's lineage to OpenAI's experimental "Swarm" project, not to Microsoft itself ([Handoffs (AutoGen Core)](https://microsoft.github.io/autogen/stable/user-guide/core-user-guide/design-patterns/handoffs.html)) — useful component-level lineage evidence, but not on point for the skill+cost-tier composition.
- **Semantic Kernel**'s Handoff Orchestration is explicitly marked **experimental** and lets agents transfer control based on conversational context ([Handoff Agent Orchestration](https://learn.microsoft.com/en-us/semantic-kernel/frameworks/agent/agent-orchestration/handoff)).
- Azure's **Architecture Center** frames multi-agent orchestration as justified only above a stated complexity threshold — i.e., a single agent with tools is the recommended default, and multi-agent delegation is presented as an escalation, not a default pattern ([AI Agent Orchestration Patterns](https://learn.microsoft.com/en-us/azure/architecture/ai-ml/guide/ai-agent-design-patterns)).

**Relevance:** component-only to partial. None of these Microsoft sources document a Skill-style discovery/trigger layer feeding a cost-tiered subagent.

### 3.6 LangChain / LangGraph — the clearest documented separation of "Skills" and "Subagents"

LangChain's own multi-agent documentation is the single clearest piece of first-party evidence that **"Skills" and "Subagents" are treated as two separate, independently named patterns** by at least one major agent framework, not components of one composed pattern: its overview page lists "Subagents" and "Skills" as distinct rows in a pattern-comparison table ([Multi-agent](https://docs.langchain.com/oss/python/langchain/multi-agent)). Its dedicated Subagents page describes them as stateless, tool-invoked, and context-isolated from the main conversation ([Subagents](https://docs.langchain.com/oss/python/langchain/multi-agent/subagents)) — closely matching the "isolated context" element of the target composition.

**Relevance:** direct — this is the strongest single piece of evidence supporting the terminology conclusion in §7: an established framework explicitly documents these as two separate mechanisms, reinforcing that no canonical combined name exists.

### 3.7 CrewAI — per-agent delegation and per-agent LLM choice

CrewAI agents can delegate tasks to other agents via an `allow_delegation` flag, and each agent can be configured with an independent `llm`, permitting a cheaper model for a delegate agent ([Agents](https://docs.crewai.com/v1.15.8/en/concepts/agents.md)).

**Relevance:** partial — supports the "different agents, different model tiers" element; no Skill-style discovery/trigger layer documented.

### 3.8 Academic literature — cost routing and multi-agent frameworks (component-level only)

- **FrugalGPT** demonstrates that cascading across LLMs of different cost tiers can match or exceed the accuracy of always using the most expensive model, while cutting cost by up to 98% in some experiments ([arXiv:2305.05176](https://arxiv.org/abs/2305.05176), 2023-05-09).
- **RouteLLM** shows a learned router that dynamically chooses between a strong and weak model can cut serving costs by more than 2x with limited quality loss ([arXiv:2406.18665](https://arxiv.org/abs/2406.18665), 2024-06-26; ICLR 2025 poster).
- **AutoGen** presents an open-source framework for customizable, conversable multi-agent applications ([arXiv:2308.08155](https://arxiv.org/abs/2308.08155), 2023-08-16).

**Relevance:** component-only. These papers substantiate the general principle that routing between model cost tiers reduces spend without necessarily sacrificing quality, and that multi-agent conversation frameworks are an established research area — but none study a Skill-triggered discovery/trigger layer as part of the routing decision, and none focus on tool-schema/context minimization specifically.

### 3.9 Context engineering and tool-schema minimization (measured vs. inferred — see §5–6)

- Anthropic's own context-engineering guidance argues that curating a small, high-signal tool set is a **context-engineering** concern — bloated tool sets create "ambiguous decision points" for the model — distinct from access-control framing ([Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)).
- Chroma's **Context Rot** report provides controlled measurements showing that LLM performance degrades non-uniformly as input length grows, even on simple tasks, across 18 models tested ([Context Rot](https://www.trychroma.com/research/context-rot)) — supporting the general "more context/tokens can hurt, not just cost more" rationale, though it measures overall input length rather than tool-schema tokens specifically.
- A very recent, non-peer-reviewed preprint proposes "dynamic tool gating and lazy schema loading" specifically to reduce per-turn tool/MCP schema token overhead ([arXiv:2604.21816](https://arxiv.org/abs/2604.21816), 2026-04) — the closest match found to a direct, quantified claim about tool-schema cost, but flagged low-confidence (see §6).

### 3.10 Gray literature — no settled informal name found

Two representative community sources were fetched directly (not merely summarized via search):

- A practitioner blog post with a concrete token/pricing breakdown recommends running "planner" agents on a stronger model and "worker" subagents on Haiku-tier models to control spend ([Why Claude Code Subagents Burn So Many Tokens](https://youcanbuildthings.com/articles/claude-code-subagents-token-usage/)) — directly on point for the cost-routing rationale, medium confidence as an informal source.
- A second blog post describes subagents informally as "a team of specialists" with restricted tool access, explicitly citing **both** improved focus and improved safety in the same breath ([A practical guide to subagents in Claude Code](https://www.eesel.ai/blog/subagents-in-claude-code)) — cited specifically to illustrate the conflation this report intentionally avoids (§5), and marked low confidence.

Beyond these two, extensive searching (see `search-log.md` §5) found no consistent informal name for the composed pattern.

## 4. Overlap and differences vs. the proposed composition

| Element of the composition | Closest documented prior art | Gap / difference |
| --- | --- | --- |
| Minimal skill used only for discovery/routing (progressive disclosure) | Anthropic Agent Skills (metadata → body → bundled resources) | Anthropic's own skills are typically documented as carrying task instructions/knowledge, not purely as a trigger; using a skill *exclusively* as a thin routing layer is a usage choice, not a separately documented sub-feature |
| Custom subagent on a cheaper/smaller model | Claude Code subagents (explicit cost-routing intent); OpenAI per-agent `model`; CrewAI per-agent `llm`; RouteLLM/FrugalGPT (cost-tier routing, generally) | Well established as a component in isolation across multiple ecosystems |
| Narrow tool allowlist on the subagent | Claude Code subagents; GitHub Copilot custom agents; Agent Skills spec's experimental `allowed-tools` | Documented in every framework surveyed, but framed primarily as scoping capability/expertise, not consistently framed as a token-minimization technique (see §5) |
| Isolated context window | Claude Code subagents; LangChain Subagents (explicitly "stateless...context isolation") | Well established |
| Direct artifact writes by the subagent (bypassing the parent's context) | Not explicitly documented as a named feature in any source reviewed | This is an implementation detail/usage pattern rather than a documented vendor feature; it follows logically from "isolated context + tool access" but was not found named or measured anywhere |
| Compact return value to the parent | OpenAI Agents-as-tools (specialist's output returns into manager context); Google ADK scoped `mode` | Established as a design option, but no source frames it as a deliberate token/credit-reduction technique specifically for the parent's context, only as an interaction-pattern option |
| The skill and subagent wired together end-to-end as one pattern | None found | This is the central gap: every framework documents "skills" and "subagents/delegation" as separate, sibling mechanisms (most explicitly, LangChain's own docs) |

## 5. Context minimization vs. least privilege/safety — a deliberate distinction

The task underlying this composition asks specifically that tool restriction be understood as **context minimization**: fewer tool definitions/schemas loaded into the subagent's prompt means fewer tokens spent on schemas, fewer choices for the model to reason over, and typically more compact tool outputs — as distinct from **least privilege/safety**, i.e., restricting tools to prevent unwanted or unsafe actions. Both are legitimate benefits, but they are different justifications, and sources vary in which one (or both) they foreground:

- Anthropic's context-engineering guidance foregrounds the **context-minimization** framing: it discusses tool-set bloat primarily as a problem of ambiguous decision points and finite "context budget," not primarily as a safety control (`evidence.csv` row 24).
- Claude Code's subagent docs and GitHub Copilot's custom-agent docs describe tool restriction mainly as **scoping capability/expertise** for a subagent — this is adjacent to both framings but does not explicitly separate them (`evidence.csv` rows 3, 6).
- The `eesel.ai` gray-literature post is quoted specifically because it **conflates** the two rationales in a single sentence — restricted tool access described as improving both "focus" and "safety" simultaneously (`evidence.csv` row 28). This is included deliberately to demonstrate why this report treats them as separate claims rather than assuming the sources already do.

**Conclusion on this point:** the context-minimization rationale for tool restriction is supported qualitatively by first-party sources (Anthropic's context-engineering post) but is **not accompanied by a precise, verified, first-party measurement** of how many tokens a given tool schema costs, or how much accuracy improves per removed tool. The least-privilege/safety rationale is well established as a separate, secondary benefit across the security literature generally, but that literature was not the focus of this search and is not itself cited here as a primary claim.

## 6. Measured vs. inferred: schema-token cost claims

Per the task's requirement to flag which schema-token claims are measured versus inferred:

- **Measured (first-party, dated, directly quoted):** the per-token price differential between GPT-5.6 Sol and Claude Haiku 4.5 in GitHub Copilot's own billing documentation (`evidence.csv` row 9). This is a real, dated, vendor-published number, not an estimate.
- **Measured, but about input length generally, not tool schemas specifically:** Chroma's Context Rot report measures performance degradation as a function of total input tokens, across 18 models, in controlled conditions (`evidence.csv` row 25). This substantiates "more tokens in context can hurt," but does not isolate tool-schema tokens as a variable.
- **Inferred / qualitative, not a number:** Anthropic's context-engineering guidance argues that large tool sets increase ambiguity and consume context budget, but does not publish a specific token-per-tool-schema figure (`evidence.csv` row 24).
- **Preliminary and unverified (flagged explicitly low-confidence):** the arXiv 2604.21816 preprint is the only source found that directly proposes measuring/eliminating a "tools tax" from schema loading, but it is a very recent (April 2026), non-peer-reviewed preprint, verified here only at the title/abstract level, and should not be treated as an established result (`evidence.csv` row 26).

**Net assessment:** the claim "a narrower tool allowlist reduces the subagent's context/token footprint" is well supported directionally by first-party qualitative guidance and by general context-length-degradation research, and the cost differential between the two named models is directly measured — but a precise, verified, first-party quantification of *tool-schema-specific* token savings was not found in any peer-reviewed or vendor-published source at the time of this research.

## 7. Terminology recommendation

No source examined — vendor documentation, open specification, pattern catalog, academic paper, or gray literature — uses a single, settled name for the full composition described in §1 (skill-as-discovery/trigger, feeding a cost-tiered, tool-restricted, context-isolated subagent, with a compact return). The clearest evidence for this is LangChain's own documentation, which lists "Subagents" and "Skills" as two separate rows in its multi-agent pattern comparison, rather than as one pattern (`evidence.csv` row 18).

Consistent with the evidence gathered, this report recommends describing the pattern as:

> **A repository-local composition of established mechanisms** — a progressive-disclosure Agent Skill used as a discovery/trigger layer, combined with a cost-tiered, tool-restricted, context-isolated custom subagent — **for which no canonical or industry-standard name was found in the sources searched.**

This is a terminology observation, not a novelty claim (see §8).

## 8. Conclusion

The individual mechanisms that make up this composition are each well precedented:

- Progressive-disclosure Agent Skills as a low-context discovery/trigger layer are documented by Anthropic and formalized in the open Agent Skills specification.
- Subagents/custom agents with isolated context, tool restriction, and independent (often cheaper) model selection are documented across Anthropic/Claude Code, GitHub Copilot, OpenAI's Agents SDK, Google's ADK, CrewAI, and (via Handoffs) Microsoft's AutoGen and Semantic Kernel.
- Routing across model cost tiers to reduce spend while preserving acceptable quality is supported by academic work (FrugalGPT, RouteLLM) as a general principle.

However, **no source found documents these elements combined into one named, first-class pattern.** Every framework surveyed that documents both a skill-like mechanism and a subagent/delegation mechanism treats them as separate, independently described features. Based on the evidence gathered, this composition is best characterized as **a repository-local composition of established mechanisms; no canonical name was found in the sources searched.**

This report makes **no claim of novelty, no claim of being "first," and no claim or assessment of freedom to operate.** It documents what was found (and explicitly, what was not found) as of the search date below, using the fixed queries and source catalogs logged in `search-log.md`. Absence of a documented prior combination is evidence of absence only within the scope, catalogs, and time searched — it is not proof that no such combination has been described elsewhere, and should not be relied upon for legal or IP purposes.

## 9. Limitations

- **Point-in-time snapshot.** Model availability (GPT-5.6 Sol, Claude Haiku 4.5) and their listed prices in GitHub Copilot are current as of the access date (2026-07-28) and are subject to change; the pricing figures cited are a snapshot, not a permanent fact.
- **Search scope, not exhaustive coverage.** Sources were selected to match the categories the task specified (Anthropic/Claude, GitHub Copilot, OpenAI Agents SDK, Google ADK, Microsoft orchestration frameworks, LangChain/LangGraph, CrewAI, relevant academic papers, context-engineering research, and gray literature on informal naming). Frameworks and papers outside these categories were not systematically searched.
- **One preprint is explicitly low-confidence.** arXiv 2604.21816 is very recent, non-peer-reviewed, and was verified only at the title/abstract level; it should not be treated as an established measurement (see §6).
- **Gray-literature sources are informal.** The two blog posts cited are individual practitioners' observations, not authoritative or peer-reviewed; they are included only to establish the absence of a settled informal name and to illustrate a conflation of rationales this report deliberately avoids (§5).
- **MCP (Model Context Protocol) was not independently researched.** It is mentioned only in passing where it appeared in an Anthropic source, since it is orthogonal to the specific skill+subagent composition in scope.
- **No legal analysis performed.** This report does not assess patents, trademarks, or freedom to operate, and none of its conclusions should be interpreted as legal advice or clearance.
- **Tool-schema token cost is not precisely quantified by any high-confidence, first-party source found.** See §6 for the full measured-vs-inferred breakdown.

## 10. Related artifacts

- [`evidence.csv`](./evidence.csv) — one row per source, with exact quotes/paraphrases, relevance, confidence, and caveats.
- [`search-log.md`](./search-log.md) — fixed queries, source catalogs searched, date searched, and explicit negative-result findings.
