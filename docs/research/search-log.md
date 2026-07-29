# Search log — prior-art research for the Agent Skill + cheap-model subagent composition

**Date searched (original pass):** 2026-07-28
**Date searched (completeness-audit follow-up pass):** 2026-07-28 (same day)
**Researcher:** GitHub Copilot CLI session (autopilot), on behalf of `cirvine-MSFT/agentskill-pattern`
**Scope of this log:** every fixed query and direct source fetch used to compile `prior-art.md` and `evidence.csv`, plus explicit negative/absence findings. This log intentionally records searches that found *nothing new or nothing on-point*, not only successful ones. §§1–5 record the original research pass; §6 records a same-day completeness-audit follow-up pass that added LangChain Deep Agents and Microsoft Agent Framework and corrected several stale claims — see §6 for what prompted it.

## 1. Composition under investigation

A minimal Agent Skill used purely for progressive-disclosure discovery/routing by a parent LLM, which — when triggered — invokes a custom subagent running on a cheaper/smaller model, with a narrow tool allowlist, an isolated context window, direct artifact writes, and a compact return value to the parent. Reference target: GitHub Copilot CLI with a GPT-5.6 Sol parent and a Claude Haiku 4.5 specialist subagent.

## 2. Source catalogs searched

| Catalog / surface | How searched |
| --- | --- |
| Anthropic (`anthropic.com/engineering`, `claude.com/blog`, `code.claude.com/docs`, `platform.claude.com/docs`) | Direct fetch of engineering blog posts and product docs; web search to locate exact URLs |
| Agent Skills open specification (`agentskills.io`) | Direct fetch of specification page |
| GitHub / GitHub Copilot (`docs.github.com`, `github.blog/changelog`) | Direct fetch of CLI/SDK custom-agent docs, Agent Skills concept and how-to docs, supported-models reference, billing/pricing reference, and the GPT-5.6 changelog post |
| OpenAI Agents SDK (`openai.github.io/openai-agents-python`) | Direct fetch of Agents, Handoffs, and Agent-orchestration pages |
| LangChain / LangGraph — base library (`docs.langchain.com/oss/python/langchain`) | Direct fetch of Multi-agent, Subagents, and (attempted, redirected) LangGraph multi-agent concept pages; web search to resolve moved URLs; re-fetched in the §6 follow-up to confirm the page is unchanged and to capture a Tip box pointing to Deep Agents |
| **LangChain Deep Agents harness (`docs.langchain.com/oss/python/deepagents`) — added in the §6 follow-up** | Direct fetch of the Overview, Subagents, Skills, and Comparison-with-Claude-Agent-SDK pages |
| Google Agent Development Kit (`adk.dev`, formerly `google.github.io/adk-docs`) | Direct fetch of workflows/multi-agent, collaboration, and Skills pages (redirects followed); fetched the `google/adk-docs` GitHub commit history for `docs/skills/index.md` via the GitHub REST API to verify the page's original publication date |
| Microsoft AutoGen (`microsoft.github.io/autogen`) | Direct fetch of the Handoffs design-pattern page |
| Microsoft Semantic Kernel (`learn.microsoft.com/semantic-kernel`) | Direct fetch of Handoff Agent Orchestration page |
| Microsoft Azure Architecture Center (`learn.microsoft.com/azure/architecture`) | Direct fetch of the AI Agent Orchestration Patterns guide |
| **Microsoft Agent Framework (`learn.microsoft.com/en-us/agent-framework`) — added in the §6 follow-up** | Direct fetch of the documentation hub, Agent Skills, Workflows overview, Workflow orchestrations index, Handoff orchestration, Agents-as-Tools ("journey" section), and Agent Harness pages; web search used to locate the exact current Handoff/Agents-as-Tools URLs before fetching them directly |
| CrewAI (`docs.crewai.com`) | Direct fetch of the Agents, Skills, and Agent Capabilities concepts pages (redirects followed to versioned `v1.15.8` URLs); fetched the `crewAIInc/crewAI` GitHub PR history and the `1.15.8` release metadata via the GitHub REST/search API to verify the Skills doc's rewrite date and the docs version's release date |
| arXiv | Direct fetch of abstract/HTML pages for FrugalGPT (2305.05176), RouteLLM (2406.18665), AutoGen (2308.08155), and a lazy-tool-loading preprint (2604.21816) |
| Independent research (Chroma) | Direct fetch of the "Context Rot" research report |
| Gray literature / community (blogs, Reddit-quoting blogs) | General web search only; individually fetched two representative posts (`youcanbuildthings.com`, `eesel.ai`) to verify quotes rather than trusting search-summary prose |

General web search (Bing-backed AI search tool) was used only to *discover* candidate URLs or to triangulate terminology; every substantive claim used in `prior-art.md` / `evidence.csv` was re-verified by fetching the primary page or paper directly, per the task's verification requirement. Two exceptions are explicitly flagged low-confidence in `evidence.csv`: the arXiv 2604.21816 preprint (title/abstract page only, not independently re-derived in depth) and the `eesel.ai` gray-literature summary (used only to illustrate a conflation of rationales, not as a factual authority).

## 3. Fixed queries run (web search)

1. `Anthropic Agent Skills specification SKILL.md progressive disclosure documentation`
2. `GitHub Copilot CLI custom subagents "agent_type" tool allowlist documentation`
3. `Claude Code subagents feature documentation isolated context separate context window`
4. `FrugalGPT model cascade paper arxiv reduce LLM cost`
5. `RouteLLM learning to route LLM queries arxiv paper`
6. `GitHub Copilot CLI docs create custom subagents .github/agents markdown frontmatter`
7. `GitHub Copilot models GPT-5.6 Sol Claude Haiku 4.5 available models list`
8. `docs.langchain.com langgraph multi-agent overview page`
9. `AutoGen enabling next-gen LLM applications multi-agent conversation arxiv abstract`
10. `LangGraph multi-agent supervisor subgraph documentation site:langchain-ai.github.io`
11. `"context engineering" multi-agent subagent "context window" Anthropic blog subagents section quote`
12. `"skill" triggers "subagent" cheaper model blog "progressive disclosure" routing pattern name`
13. `reddit OR blog "skills" "subagents" pattern name "cheap model" cost savings Claude Code informal terminology`
14. `tool schema token overhead many tools context length degradation paper measurement`
15. `Google ADK Agent Development Kit official Skills documentation SKILL.md metadata-first discovery site:adk.dev OR site:google.github.io`
16. `"adk.dev" Agent Skills "progressive disclosure" SKILL.md documentation`
17. `CrewAI v1.15.8 release changelog date skills feature`
18. `learn.microsoft.com agent-framework handoff orchestration agent-as-tool multi-agent` *(§6 follow-up)*
19. `Microsoft Agent Framework "agent as a tool" AsAIFunction OR as_tool site:learn.microsoft.com` *(§6 follow-up)*

## 4. Direct primary-source fetches (verification pass)

- `https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills`
- `https://agentskills.io/specification`
- `https://code.claude.com/docs/en/sub-agents`
- `https://claude.com/blog/subagents-in-claude-code`
- `https://claude.com/blog/skills-explained`
- `https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents`
- `https://www.trychroma.com/research/context-rot`
- `https://docs.github.com/en/copilot/how-tos/copilot-sdk/features/custom-agents`
- `https://docs.github.com/en/copilot/how-tos/copilot-cli/use-copilot-cli/invoke-custom-agents`
- `https://docs.github.com/en/copilot/concepts/agents/about-agent-skills`
- `https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-skills`
- `https://docs.github.com/en/copilot/reference/ai-models/supported-models`
- `https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing`
- `https://github.blog/changelog/2026-07-09-openais-gpt-5-6-sol-terra-and-luna-are-now-available-in-github-copilot/`
- `https://openai.github.io/openai-agents-python/handoffs/`
- `https://openai.github.io/openai-agents-python/agents/`
- `https://openai.github.io/openai-agents-python/multi_agent/`
- `https://adk.dev/workflows/` and `https://adk.dev/workflows/collaboration/`
- `https://adk.dev/skills/` (Google ADK Skills — redirects from `https://google.github.io/adk-docs/skills/`)
- `https://developers.googleblog.com/developers-guide-to-building-adk-agents-with-skills/` (Google developer blog walkthrough that links to and quotes the `adk.dev/skills/` reference; used only to locate the primary doc URL, not cited as the source of quotes)
- `https://api.github.com/repos/google/adk-docs/commits?path=docs/skills/index.md` (GitHub REST API — commit history for the ADK Skills doc file, used to verify its original 2026-02-13 publication date and most recent 2026-07-24 revision)
- `https://microsoft.github.io/autogen/stable/user-guide/core-user-guide/design-patterns/handoffs.html`
- `https://learn.microsoft.com/en-us/semantic-kernel/frameworks/agent/agent-orchestration/handoff`
- `https://learn.microsoft.com/en-us/azure/architecture/ai-ml/guide/ai-agent-design-patterns`
- `https://docs.langchain.com/oss/python/langchain/multi-agent`
- `https://docs.langchain.com/oss/python/langchain/multi-agent/subagents`
- `https://docs.crewai.com/v1.15.8/en/concepts/agents.md`
- `https://docs.crewai.com/v1.15.8/en/concepts/skills.md` (CrewAI Skills — SKILL.md format, progressive-disclosure discovery/activation)
- `https://docs.crewai.com/v1.15.8/en/concepts/agent-capabilities.md` (CrewAI Agent Capabilities overview — combined `tools`/`mcps`/`apps`/`skills`/`knowledge_sources` example, used to confirm `skills` and `tools` are documented as independently combinable Agent attributes)
- `https://api.github.com/repos/crewAIInc/crewAI/releases/tags/1.15.8` (GitHub REST API — confirms `1.15.8` was published 2026-07-28T15:06:04Z)
- `https://api.github.com/search/issues?q=repo:crewAIInc/crewAI+%22concepts/skills.mdx%22+in:title,body+type:pr&sort=created&order=asc` (GitHub search API — located PR crewAIInc/crewAI#5189, merged 2026-03-31, which substantially rewrote the Skills concept doc to its current progressive-disclosure/Skills-vs-Tools framing)
- `https://arxiv.org/abs/2305.05176` (FrugalGPT)
- `https://arxiv.org/abs/2406.18665` (RouteLLM)
- `https://arxiv.org/abs/2308.08155` (AutoGen abstract — fetched directly via the arXiv abstract page, same method as FrugalGPT and RouteLLM)
- `https://arxiv.org/abs/2604.21816` (title/abstract page only — Tool Attention / lazy schema loading)
- `https://youcanbuildthings.com/articles/claude-code-subagents-token-usage/`
- `https://www.eesel.ai/blog/subagents-in-claude-code`

Attempted but redirected/unavailable and re-fetched at the resolved URL: `google.github.io/adk-docs/agents/multi-agents/` → `adk.dev/workflows/`; `docs.crewai.com/concepts/agents` → versioned `.md` URL; `langchain-ai.github.io/langgraph/concepts/multi_agent/` (redirect loop, abandoned in favor of `docs.langchain.com/oss/python/langchain/multi-agent`, which covers the same content under LangChain's current docs structure); `learn.microsoft.com/en-us/agent-framework/workflows/index` → `learn.microsoft.com/en-us/agent-framework/workflows/` (301 redirect, re-fetched at the resolved URL per tool policy).

**§6 follow-up pass additions** (all accessed 2026-07-28; see §6 for narrative):

- `https://docs.langchain.com/oss/python/deepagents/overview`
- `https://docs.langchain.com/oss/python/deepagents/subagents`
- `https://docs.langchain.com/oss/python/deepagents/skills`
- `https://docs.langchain.com/oss/python/deepagents/comparison` (Deep Agents vs. Claude Agent SDK — used to corroborate that LangChain itself treats Deep Agents and Claude's harness as the closest cross-vendor comparators; not separately cited as a distinct evidence row beyond this corroboration)
- `https://docs.langchain.com/oss/python/langchain/multi-agent` (re-fetched; confirmed unchanged pattern-comparison table, plus a Tip box — not captured in the original pass — pointing to Deep Agents)
- `https://learn.microsoft.com/en-us/agent-framework/`
- `https://learn.microsoft.com/en-us/agent-framework/agents/skills`
- `https://learn.microsoft.com/en-us/agent-framework/workflows/`
- `https://learn.microsoft.com/en-us/agent-framework/workflows/orchestrations/` (orchestration-pattern index; confirmed the current pattern list is Sequential/Concurrent/Handoff/Group Chat/Magentic — no separately named "Agent-as-Tool" orchestration pattern exists in this index, which is why the Agents-as-Tools page was located separately, below)
- `https://learn.microsoft.com/en-us/agent-framework/workflows/orchestrations/handoff`
- `https://learn.microsoft.com/en-us/agent-framework/journey/agents-as-tools` (located via query 19, since "Agents as Tools" is documented under the "journey" getting-started track rather than under `workflows/orchestrations/`)
- `https://learn.microsoft.com/en-us/agent-framework/agents/harness` (Agent Framework's single-agent "harness" — reviewed to check for any multi-agent/skill cross-reference; none found relevant enough to cite as a distinct evidence row beyond confirming it is a single-agent scaffolding feature, analogous in spirit to Deep Agents being described as an "agent harness")

## 5. Explicit negative / absence results

These are deliberately recorded because the task requires distinguishing "not found" from "not searched":

1. **No canonical or standard name found** for the specific composition under investigation (Skill-as-discovery-layer → triggers a narrow-tool, cheap-model, isolated-context subagent → returns a compact result to the parent) in any vendor documentation, open specification, pattern catalog, or academic source examined. Of the sources reviewed, **Anthropic**, **LangChain** (both its base multi-agent library and its Deep Agents harness), **GitHub Copilot**, **Google ADK**, **CrewAI**, and **Microsoft Agent Framework** — six in total — document *both* a Skill-equivalent progressive-disclosure mechanism *and* a subagent/delegation mechanism, and all six treat "skills" (or an equivalent knowledge-loading mechanism) and "subagents/handoffs/delegation" as **two separate, independently named mechanisms**, not one composed pattern. This is clearest in `docs.langchain.com/oss/python/langchain/multi-agent`, which explicitly lists "Subagents" and "Skills" as sibling rows in its own pattern-comparison table (while, in the same breath, pointing to its own Deep Agents harness as the place where the two are bundled — see §6); for GitHub Copilot it is clearest in the fact that "Custom agents" and "Agent Skills" are documented on separate concept/how-to pages; for Google ADK it is clearest in the fact that its Skills page (`adk.dev/skills/`) and its coordinator/subagent collaboration-modes page (`adk.dev/workflows/collaboration/`) are two entirely separate doc pages with no cross-reference wiring one to the other; for CrewAI it is clearest in the fact that its Skills concept page and its `allow_delegation` agent attribute are documented separately, with no page found that names a single composed pattern spanning both; for Microsoft Agent Framework it is clearest in the fact that its Agent Skills page and its Workflows/Agents-as-Tools/Handoff pages are documented separately, and its own Skills page states outright that "Agent Skills and Agent Framework Workflows... work in fundamentally different ways" (see §6). No page found across any of these six vendors/products names a single composed pattern spanning both.
   **This naming gap is narrower than an absence of capability, and LangChain's Deep Agents harness (added in the §6 follow-up) is the closest documented single-schema composition found:** its `SubAgent` definition combines a `model` override, a `tools` allowlist explicitly framed as "keep this minimal," `skills` whose state is documented as "fully isolated — a subagent's loaded skills are not visible to the parent, and vice versa," filesystem/artifact-write tools, and a structured `response_format` JSON return, all on one object (`evidence.csv` row 35). GitHub Copilot's own `customAgents` SDK configuration reference (`docs.github.com/en/copilot/how-tos/copilot-sdk/features/custom-agents`) documents the same three-field combination (`model`/`tools`/`skills`) with skill content eagerly preloaded (`evidence.csv` row 29); Claude Code's subagent frontmatter documents the identical combination (`evidence.csv` row 3); CrewAI's `Agent` object documents the same shape via `llm`/`tools`/`skills` (`evidence.csv` row 33). GitHub Copilot, Claude Code, and CrewAI remain equivalent prior art *to each other* on this schema-combination point; Deep Agents goes further by additionally isolating skill state and supporting a structured return, which is why this report now foregrounds Deep Agents rather than GitHub Copilot/Claude Code as the closest comparator (see §6). In all four, the `skills` field/argument is a static, developer-configured list of what the agent/subagent *may* draw on (CrewAI's own docs state that in the common `Agent(skills=[...])` usage, listed skills are "automatically discovered and activated" together, not triggered one at a time; Deep Agents' subagent skills remain internally progressive but the *set* is still statically configured) — not the relevance-triggered, progressive-disclosure mechanism that defines Agent Skills elsewhere in each vendor's own docs, so none of the four constitutes the composed pattern in scope on its own; but the underlying capability to combine a cheaper model, a tool allowlist, and skill content on one subagent/agent definition is directly documented in all four vendors' docs, not absent.
   Google ADK independently documents a Skill-equivalent progressive-disclosure layer (`SkillToolset`, L1 metadata → L2 instructions "loaded when the Skill is triggered by the agent" → L3 resources; `evidence.csv` row 32) — a very close match, at the schema level, for Anthropic's own three-tier model — but this ADK Skills mechanism augments the *same* agent that discovered the skill; ADK's separate coordinator/subagent collaboration-mode page was not found to state that triggering a Skill causes the coordinator to invoke a subagent. Google ADK's collaboration page additionally documents explicit context isolation for its `task`/`single_turn`-mode subagents ("operates in its own isolated session branch... cannot see what its peer agents are doing"; `evidence.csv` row 30), which is direct prior art for the "isolated context window" element specifically, alongside Claude Code, GitHub Copilot, LangChain subagents, Deep Agents subagents, and Microsoft Agent Framework's Agents-as-Tools pattern — see `prior-art.md` §4/§8.
   **Microsoft's current framework (Agent Framework) documents both a Skill-equivalent progressive-disclosure mechanism and cost-tiered, isolated delegation (via Agents-as-Tools), but was not found to combine them into a single schema** the way Deep Agents, GitHub Copilot, Claude Code, and CrewAI do — its Agents-as-Tools "Considerations" table covers model/tools/context isolation but does not mention Skills at all (`evidence.csv` row 41). This finding must be kept distinct from Microsoft's *legacy* AutoGen and Semantic Kernel frameworks (superseded by Agent Framework, per Microsoft's own migration guides — `evidence.csv` row 38), for which, as in the original research pass, **no Skill-equivalent progressive-disclosure mechanism was found documented at all** in the pages reviewed. OpenAI's Agents SDK likewise was confirmed in this research to document a subagent/handoff/delegation mechanism only, with no Skill-equivalent progressive-disclosure mechanism found. These three (OpenAI Agents SDK, AutoGen, Semantic Kernel) remain the only sources in this research's scope confirmed to be delegation-only with no Skill-equivalent mechanism found; this is a narrower, more precisely scoped claim than "Microsoft lacks Skills," which is no longer accurate now that Agent Framework's own Skills page is confirmed.
   **None of the sources reviewed — including LangChain Deep Agents', Google ADK's, CrewAI's, and Microsoft Agent Framework's own Skills documentation — document a first-class, named feature in which a Skill's own runtime trigger/activation decision causes the parent to invoke a separate, cost-tiered subagent.** This absence finding is narrowly scoped to that specific outer composition; it is not a claim that no vendor documents a Skill-equivalent discovery mechanism (six now do) or that no vendor documents model/tool/skill composition on one agent object (four now do, with Deep Agents the most complete).
2. **No academic paper found** that studies this composition as a unit. The closest academic matches address only one half each: FrugalGPT and RouteLLM address model cascades/routing between cost tiers (not skill-triggered, not tool-scoped); AutoGen addresses multi-agent conversation/delegation generally (not skill-triggered, not explicitly cost-tiered).
3. **No settled informal/gray-literature term** was found either. Community and blog sources used inconsistent, ad hoc phrases for the cheap-model-routing half alone ("Haiku offload," "cheap model," "worker tier," "subagent model downgrade," "cost-control settings"), and none of these sources discuss pairing that routing with a Skill-based discovery/trigger layer specifically. No source used a name that covers the full composition end-to-end.
4. **No first-party documentation found** that explicitly measures or claims a specific token-count savings figure for *tool-schema minimization alone* (as distinct from overall context-length effects). Anthropic's context-engineering post argues qualitatively that bloated tool sets create "ambiguous decision points" and increase maintenance/context burden, and Chroma's "Context Rot" report measures degradation from overall input length — but neither isolates "each additional unused tool definition costs N tokens and Y% accuracy" as a measured figure. Microsoft Agent Framework's Skills page states an approximate "~100 tokens per skill" figure for its metadata-advertisement stage (`evidence.csv` row 39) — the closest first-party numeric estimate found for *skill* (not tool) schema overhead — but it is presented as rule-of-thumb guidance with no disclosed measurement methodology, so it is treated as a low-rigor directional data point, not a controlled measurement (see `prior-art.md` §6). The one preprint located that attempts to measure/address tool-schema cost directly (arXiv 2604.21816, "Tool Attention Is All You Need") is very recent (April 2026 per its arXiv identifier) and not peer-reviewed; it is flagged as low-confidence/preliminary in `evidence.csv` rather than treated as an established measurement.
5. **Model Context Protocol (MCP)** was noted only in passing (it is referenced by Anthropic's Agent Skills post as a complementary mechanism) and was not independently researched in depth, since it is orthogonal to the tool-allowlist/subagent composition in scope for this report; this is a deliberate scoping choice, not an oversight, and is called out in `prior-art.md`'s Limitations section.
6. **Anthropic's Agent Skills spec explicitly marks `allowed-tools` as "Experimental"** (per `agentskills.io/specification`) — i.e., even the tool-restriction field on the *skill* side of this composition is not yet a stable, finalized mechanism in the canonical spec, separate from whatever tool-scoping a *subagent/custom-agent* definition provides.
7. **No outer Skill-activation-triggers-subagent linkage was found even in LangChain Deep Agents** (added in the §6 follow-up), despite Deep Agents combining more of the target composition's individual elements on one object than any other source reviewed. The trigger for invoking a Deep Agents subagent is the parent's own reasoning over the built-in `task` tool and the subagent's required `description` field, entirely independent of any skill's discovery or activation. This was the single most important open question for the §6 follow-up pass (per the task's instruction to abandon the report's central absence-finding if Deep Agents' docs actually documented this linkage), and the answer, based on the pages fetched, is that they do not.
8. No evidence was found — and none was sought — of any patent, trademark, or freedom-to-operate conflict; that kind of legal clearance is out of scope for this research and is explicitly disclaimed in `prior-art.md`.

## 6. Completeness-audit follow-up (2026-07-28)

A completeness audit of the original research pass (§§1–5 above) reported that this report was missing major first-party prior art and had accumulated some stale claims as earlier corrections were layered in. This section documents exactly what the audit flagged, what was fetched to address it, and what changed as a result.

### 6.1 What the audit flagged

1. **Missing LangChain Deep Agents.** The original pass cited only the base `langchain` package's multi-agent docs (`docs.langchain.com/oss/python/langchain/multi-agent` and `.../subagents`), which document Subagents and Skills as separate patterns. It did not cover LangChain's separate, higher-level **Deep Agents** harness (`docs.langchain.com/oss/python/deepagents/*`), which combines subagent delegation and progressive-disclosure Skills into one configuration surface and is likely the closest structural comparator to the composition in scope.
2. **Missing Microsoft Agent Framework.** The original pass covered only Microsoft's legacy AutoGen and Semantic Kernel frameworks and the Azure Architecture Center, all of which predate or sit alongside Microsoft's current framework. It did not cover **Microsoft Agent Framework** (`learn.microsoft.com/en-us/agent-framework`), the framework Microsoft's own docs point AutoGen and Semantic Kernel users to migrate to, which has its own Agent Skills feature and its own multi-agent orchestration (Workflows, Handoff, Agents-as-Tools) surfaces.
3. **Stale blanket claims about Google ADK, CrewAI, and Microsoft.** Earlier updates to this report had added Skills evidence for ADK (`evidence.csv` row 32) and CrewAI (`evidence.csv` row 33), but not every sentence referencing those vendors elsewhere in the three files had been reconciled. Concretely: `evidence.csv` row 20's caveat still read "CrewAI does not document a skill-style progressive-disclosure discovery layer feeding delegation decisions" — directly contradicted by row 33, added later in the same file. This was a genuine internal inconsistency, now fixed (see §6.4).
4. **An overused "closest" superlative.** Several passages named "GitHub Copilot's and Claude Code's... schemas" as "the closest technical compositions found," which this follow-up pass re-evaluated once Deep Agents was in scope.

### 6.2 New fixed queries run

See queries 18–19 in §3 above (`learn.microsoft.com agent-framework handoff orchestration agent-as-tool multi-agent`; `Microsoft Agent Framework "agent as a tool" AsAIFunction OR as_tool site:learn.microsoft.com`). No new web-search queries were needed to locate the LangChain Deep Agents pages — their URLs were specified directly by the task and fetched without an intermediate search.

### 6.3 New direct primary-source fetches

See the "§6 follow-up pass additions" list in §4 above (11 URLs: 5 LangChain, 6 Microsoft Agent Framework). All were fetched directly and re-quoted into `evidence.csv` rows 34–42; none were relied upon via search-summary text.

### 6.4 Corrections made to the three files

- **`evidence.csv` row 20** (CrewAI `allow_delegation`/`llm`): caveat rewritten to remove the stale "CrewAI does not document a skill-style progressive-disclosure discovery layer" claim (contradicted by row 33) and replaced with an accurate cross-reference to row 33, plus the still-accurate caveat that no evidence ties skill activation to `allow_delegation`.
- **`evidence.csv` rows 34–42** appended (never renumbered rows 1–33, so all pre-existing row references elsewhere remain valid).
- **`prior-art.md` §3** restructured: LangChain Deep Agents inserted as new §3.2 (immediately after Anthropic, ahead of GitHub Copilot), and every subsequent subsection renumbered accordingly (old §3.2 GitHub Copilot → §3.3; old §3.3 OpenAI → §3.4; old §3.4 ADK → §3.5; old §3.5 Microsoft → §3.6, restructured to lead with Agent Framework; old §3.6 LangChain base library → §3.7; old §3.7 CrewAI → §3.8; old §3.8 Academic → §3.9; old §3.9 Context engineering → §3.10; old §3.10 Gray literature → §3.11). All internal `§3.x` cross-references, the `§4` comparison table, and `§7`/`§8` were updated to match and to add Deep Agents and Microsoft Agent Framework as sources.
- **The "closest technical composition" superlative** (`prior-art.md` §4 and §8) rewritten to name LangChain Deep Agents' `SubAgent` schema as the closest documented match, with GitHub Copilot, Claude Code, and CrewAI named as the next tier (equivalent to each other, not to Deep Agents).
- **The "framework-set" conclusion** (`prior-art.md` §7, §8; `search-log.md` §5 item 1) updated to list precisely six frameworks confirmed to document both a Skill-equivalent mechanism and a subagent/delegation mechanism: **Anthropic, GitHub Copilot, LangChain (base library and Deep Agents), Google ADK, CrewAI, and Microsoft Agent Framework** — replacing the prior five-framework count and the ambiguous "Microsoft's AutoGen and Semantic Kernel" phrasing with a framework-specific distinction between Agent Framework (current, has Skills) and AutoGen/Semantic Kernel (legacy, delegation-only, per the pages reviewed).
- **The central absence finding preserved, not abandoned:** per the task's instruction to abandon or rename the claim if Deep Agents' own docs documented the outer Skill-triggers-subagent linkage, this follow-up pass specifically checked for that linkage in the Deep Agents Subagents and Skills pages and did not find it (see §5 item 7 above). The report's narrow conclusion is therefore preserved, but rewritten to state plainly that Deep Agents is a near-exact structural match for the *subagent* side of the composition, and to avoid any "no close composition exists" framing.

### 6.5 Negative results specific to this follow-up

- No source found (Deep Agents included) documenting a Skill's own activation as the cause of a subagent invocation — see §5 item 7.
- No source found combining Microsoft Agent Framework's Agent Skills with its Agents-as-Tools or Handoff orchestration into one schema or one doc page.
- No "Agent-as-Tool" entry exists in Microsoft Agent Framework's own `workflows/orchestrations/` pattern index (Sequential, Concurrent, Handoff, Group Chat, Magentic only); "Agents as Tools" is documented separately, under the framework's "journey" getting-started track, not as a named Workflows orchestration pattern.
