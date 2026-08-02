# Excluded documentation pilot execution protocol

**Status:** runner engineering only; zero observations and zero frozen IDs consumed.

This protocol adds an execution mechanism without changing the preregistered fixture,
schedule, prompt, model, tool, ID, evaluator, schema, threshold, source hash, or generated
candidate/evaluator bytes. The preregistration remains authoritative.

This outcome-independent amendment is permitted prospectively because no pilot session,
usage row, lifecycle reservation, result root, or frozen ID exists. It repairs only how
the already-frozen runner separates and observes execution. Once any pilot unit starts,
the same changes would be post-treatment and are not permitted.

## Authorization sequence

1. Merge and review this prospective runner amendment while the no-run attestation
   remains true.
2. Select two absent external roots on storage with durable retention and restricted
   access.
3. Provide a hash-pinned Windows-capable launcher implementing
   `--candidate-root <root> --network <deny|copilot-control-plane> -- <command>`.
4. Run `--preflight` to inspect the exact CLI surface, frozen hashes, unused IDs, fresh
   paths, launcher bytes, runner digest, and proposed resource bindings.
5. From a clean local `main` exactly equal to freshly fetched canonical `main`, invoke
   the exact `--execute` command once. Do not resume, retry, substitute, reorder, or
   reuse a frozen ID.

The merge plus explicit invocation is the authorization boundary. At execution the
runner creates a four-hour nonce in immutable memory and binds it to the exact current
main commit, runner package digest, frozen source/order, CLI executable, session store,
external roots, and launcher bytes. It writes the authorization record and hash before
the first slot. This repository does not require unavailable branch protection or a
second principal, and no second approval PR is needed. Changing any frozen design byte
or runner mechanism invalidates preflight and requires a new prospective reviewed
amendment while zero units remain started. A pilot GO never authorizes main observations.

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

The candidate launch receives no evidence, evaluator, source-repository, schedule,
session-store, sibling-output, hidden-test, gold, or result path through arguments or
environment. The runner freezes policy from the public manifest before launch and never
trusts or rereads the model-writable manifest afterward. It hashes every input and
allows only the source and documentation targets to differ after termination.

Before each candidate model call, runner-authored negative controls execute through the
same launcher and must fail reads of the repository, schedule, session store,
artifact/evaluator roots, and sibling sentinel while succeeding inside the candidate.
Self-attested isolation booleans are not accepted. Process arguments and environment are
inspected before spawn. Authenticated telemetry then rejects unexpected tools, escaped
paths, and coordinator-path references. The exact frozen parent tool lists retain
`bash`; web/search, MCP, remote export, custom instruction, auto-update, and unrelated
integration surfaces are disabled.

Candidate network policy permits required Copilot control-plane connectivity rather than
claiming impossible full denial. Evaluator execution remains separately network-denied
and receives the candidate plus hidden evaluator root only after candidate termination.
The parent cannot grade or repair worker documentation.

These controls are practical fail-closed separation and observed adherence evidence on
the Windows host. They are not an independently enforced hostile sandbox, do not prove
kernel-level filesystem isolation, and make no compliance or complete network-isolation
claim. A malicious launcher, CLI, or runtime is outside this experiment's threat model.

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
