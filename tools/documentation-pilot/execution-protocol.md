# Excluded documentation pilot execution protocol

**Status:** runner engineering only; zero observations and zero frozen IDs consumed.

This protocol adds an execution mechanism without changing the preregistered fixture,
schedule, prompt, model, tool, ID, evaluator, schema, threshold, source hash, or generated
candidate/evaluator bytes. The preregistration remains authoritative.

## Authorization sequence

1. Merge and independently review the runner while the no-run attestation remains true.
2. Select two absent external roots on storage with durable retention and restricted
   access.
3. Provide a reviewed isolation launcher and its SHA-256. Its self-test must prove denied
   network access, candidate-only parent/worker filesystem access, and evaluator
   separation.
4. Run `--preflight` to obtain the reviewed runner digest and exact hashed bindings.
5. Merge a separate approval JSON under `tools/documentation-pilot/authorizations/`.
   It must bind the reviewed runner source commit and package digest, CLI executable,
   session store path, roots, launcher, frozen order, and an expiry.
6. Rerun `--preflight --authorization-file <committed-json>`.
7. Issue a new explicit authorization for that exact `--execute --authorization-file`
   command and execute once. Do not resume, retry, substitute, reorder, or reuse a
   frozen ID.

The runner verifies that its current package digest equals the digest at the separately
reviewed source commit named by the approval. It also fetches canonical
`cirvine-MSFT/agentskill-pattern` `main`, requires GitHub's branch-protection API to
confirm a positive required-approval count, stale-review dismissal, and administrator
enforcement, and requires the approval bytes to match that protected branch exactly. It
resolves the commit that introduced the approval to its merged pull request, fetches all
review pages, and verifies the pull request retains the configured count of latest
approvals on its final head SHA. A local commit cannot self-authorize execution.
Changing any frozen design byte or runner mechanism invalidates preflight and requires
review plus a new approval. A pilot GO never authorizes main observations.

## Lifecycle and isolation

Before the first process spawn, the runner verifies all frozen source and generated
hashes, clean Git state, exact CLI/model/tool pins, absent roots, unused IDs, and frozen
order. It then writes a permanent slot reservation. Candidate and evaluator digests are
checked before the candidate Git root is initialized.

The parent receives the exact shared and arm prompt bytes, its frozen session ID,
GPT-5.6 Sol with medium effort, and an exact tool allowlist. A1 receives
`read,edit,bash`; A2 additionally receives `skill,task`. All MCP servers are disabled.
A2 telemetry must show the frozen Skill, exact worker handoff, one fixed-Haiku worker
session, only allowlisted reads, target-only edits, one compact return, and no parent
target access after the first worker edit.

The candidate launcher denies network and all filesystem access outside that candidate.
After termination, the evaluator launcher receives the candidate plus the separate
hidden evaluator root. The parent cannot grade or repair worker documentation.

## Settlement and disposition

Usage is read from exact frozen parent/worker IDs and task attribution fields after
three stable snapshots. Unknown rows, missing actors, invalid values, wrong models, or
missing required worker usage fail settlement closed. Parent and worker credits, tokens,
durations, tools, results, terminal state, and wall timing remain separate before
combined fields are calculated.

Authoritative settled parent usage establishes the start boundary. JSONL model-call
signals never establish ITT on their own. Ambiguous telemetry or missing usage produces
a start-unverifiable stop rather than a guessed start. Every proven post-start error
remains ITT with available evidence and zero retries. A pre-model-call failure is
recorded as unavailable but the runner still consumes its slot to enforce the stricter
no-retry pilot authorization. Hash, isolation, privacy, start, usage, process, or
evaluation failures stop later slots. External deterministic evaluation runs after every
proven or potentially started parent and is reproduced twice before the pilot
calculation.

Pilot GO requires all four frozen observations to start exactly once, evaluate, settle
usage, capture terminal state, reproduce twice, and satisfy both A2 routing,
read/edit confinement, compact return, and parent no-review gates. Any failed conjunct
produces NO-GO.

## Retention and publication

Raw private evidence is write-once and hash-bound in the durable artifact root. A
repository result PR may later contain only independently reviewed concise canonical
records and the minimum adherence excerpts. It must not contain full conversations,
local usage databases, credentials, usernames, environment values, or machine paths.
