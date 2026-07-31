# Reference implementation: `semantic-test-corpus` (GitHub Copilot)

**Status: implemented reference.** AI attempts source-only v1 scenarios; invalid observed
slots remain measurable for deterministic per-case validation.
Deterministic parent code owns staging verification, promotion, migration execution, the
expected-output oracle, traces, and mutant scoring.

## Components

| Role | Implementation |
| --- | --- |
| Skill router | [`.github/skills/semantic-test-corpus/SKILL.md`](../../.github/skills/semantic-test-corpus/SKILL.md) |
| Custom agent | [`.github/agents/semantic-scenario-stager.agent.md`](../../.github/agents/semantic-scenario-stager.agent.md), identity `semantic-scenario-stager` |
| Model | `claude-haiku-4.5` |
| Agent tools | Five namespaced `semantic-corpus/*` MCP tools only |
| Trusted launcher | [`tools/semantic-corpus-mcp/launcher.mjs`](../../tools/semantic-corpus-mcp/launcher.mjs) |
| MCP server | [`tools/semantic-corpus-mcp/server.mjs`](../../tools/semantic-corpus-mcp/server.mjs), never configured directly |
| Tests | [`tests/semantic-corpus-mcp/`](../../tests/semantic-corpus-mcp/) |

The agent profile has no generic `read`, `edit`, `search`, `execute`, `web`, or `agent`
tool. Omitting `agent` is the structural recursion guard. All corpus capability comes
from the local MCP process.

## Trusted launcher and confinement

The custom-agent MCP configuration invokes `launcher.mjs`, not `server.mjs`. Before
starting MCP, the launcher:

1. reads the merged benchmark arm contract and v1/scenario/staging schemas;
2. creates a fresh disposable run outside and disjoint from the repository;
3. copies only the public contract allowlist and records each SHA-256 in an immutable
   contract manifest;
4. derives the immutable run request, which pins the manifest hash, request hash, run
   metadata, schemas, limits, and the registered target of exactly 60;
5. creates fresh server and cleanup tokens plus an ephemeral Ed25519 launch keypair
   certified by an OS-protected per-user launcher authority outside the candidate root;
6. rejects symlinks, junctions, and reparse roots;
7. applies and probes read-only contract/config ACLs on Windows or modes on POSIX, while
   proving staging remains writable; and
8. signs the fixed sandbox IDs, request hash, nonce/expiry, denied roots, and source,
   launcher, server, and Node-executable hashes; passes the envelope and authority-certified
   run public key over separate inherited descriptors with one-use replay state; and
9. launches the trusted server under Node's permission model with read access only to
   the hash-attested MCP sources, config, contract, and staging, and write access
   only to staging.

The launcher also rejects trusted server sources that import network, child-process,
worker, VM, or related execution modules. Node child, worker, add-on, and WASI
permissions remain denied. The server ignores ambient config/token values. It verifies the inherited Ed25519
attestation, parent process, expiry, one-use nonce, executable/source hashes, fixed layout,
permission allowlist, read/write denial, root identities, and request/config hashes before
serving MCP. No caller-provided `sandboxKind` string is accepted as confinement evidence.

Required run metadata is supplied through the parent environment:

```powershell
$env:SEMANTIC_CORPUS_STATE_PATH = "C:\benchmark-state\B01-A4.json"
$env:SEMANTIC_CORPUS_CLEANUP_TOKEN_PATH = "C:\benchmark-state\B01-A4.cleanup.cap"
$env:SEMANTIC_CORPUS_SANDBOX_PARENT = "C:\benchmark-runs"
$env:SEMANTIC_CORPUS_RUN_ID = "B01-A4"
$env:SEMANTIC_CORPUS_ARM_ID = "4"
$env:SEMANTIC_CORPUS_BLOCK_ID = "B01"
$env:SEMANTIC_CORPUS_SEED = "20260729"
```

The cleanup capability path is parent-owned and outside both the state bundle and
sandbox. State and token files are runtime artifacts and must not be committed. Missing,
relative, repository-contained, writable-contract, reparse, permission-model, or source
attestation failures stop before MCP initialization.

## Immutable request and schema dialect

The benchmark launcher derives `corpus-contract/request.json` from the merged
[`arm-contract.json`](../../experiments/semantic-test-corpus/design/arm-contract.json)
and public schemas. The current benchmark request always has `targetCount: 60` and
returns the logical path `staging/<run-id>.json`.

The generic request validator permits the documented 40-60 range, but only the 40 and
60 boundaries are regression-tested; the benchmark integration is fixed at 60.

The supported safe schema dialect accepts the actual merged draft-2020-12 documents:

- `$schema` and `$id`;
- recursively closed objects;
- schema-valued `additionalProperties`, such as arbitrary feature-flag names whose
  values must be boolean;
- optional bounds on arrays, strings, and numbers;
- `const`, scalar `enum`, patterns, numeric constraints, and bounded `anyOf`.

The merged staging schema deliberately accepts zero through 60 observed slot values.
`write_scenario` captures malformed safe JSON attempts and a bounded reason record when
needed, including when the remaining aggregate artifact budget cannot retain a raw
attempt. Expected outputs, traces, and diagnostics are omitted. After finalization, the
merged scenario and v1 validators classify each slot; only valid unique cases promote.

## Narrow tools and output

| Tool | Capability |
| --- | --- |
| `read_request` | Read the immutable launcher-derived request and retained hashes. |
| `list_contract_files` | List bounded regular files under the attested read-only contract root. |
| `read_contract_file` | Read one exact relative contract path. |
| `write_scenario` | Atomically capture one bounded observed source-only slot, including a safe malformed-attempt record. |
| `finalize_staging` | Publish exactly once for the observed 0-60 slots and report per-case validation totals. |

Finalization publishes canonical UTF-8 JSON bytes, with recursively sorted object keys,
LF termination, at:

```text
staging/<run-id>.json
```

The payload exactly matches the merged staging schema:

```json
{
  "formatVersion": 1,
  "generator": {
    "armId": 4,
    "blockId": "B01",
    "seed": 20260729
  },
  "cases": []
}
```

`cases` contains exactly the observed zero through 60 submissions. Invalid records are
retained, never corrected after finalization, and promotion later reports valid cases
against the fixed denominator of 60. The tool returns exactly five fields:

```json
{
  "stagingPath": "staging/B01-A4.json",
  "payloadSha256": "<sha256-of-exact-canonical-bytes>",
  "submittedCases": 59,
  "promotableCases": 57,
  "errorCount": 2
}
```

## Parent verification and promotion

The parent must not trust the delegated summary. It re-verifies the exact returned hash,
canonical bytes, retained request and manifest hashes, observed count, and the merged
staging/v1 validators:

```powershell
$env:SEMANTIC_CORPUS_CLEANUP_TOKEN = Get-Content `
  C:\benchmark-state\B01-A4.cleanup.cap -Raw
node tools\semantic-corpus-mcp\launcher.mjs verify `
  --state C:\benchmark-state\B01-A4.json `
  --payload-sha256 <returned-payload-sha256>
```

Promotion evaluates each slot independently and reports promoted cases over 60. The
parent then computes oracle results, traces, and mutant scores outside the worker identity.

## Lifetime lock and authorized recovery

Server startup atomically creates `corpus-staging/.corpus.lock` and retains its open
handle for the full MCP lifetime. Every request, read, write, validation, and final
publication verifies the same open handle, file identity, owner bytes, nonce, and
request hash.

A contender fails after the bounded wait interval. If the owner terminates abruptly,
the lock remains. Once it is old enough, every server still returns `LOCK_STALE`; no
server removes or steals it.

The trusted launcher state is signed with the out-of-band parent-only cleanup
capability. Only an explicit launcher recovery verifies that authorization, the exact
root identities, trusted-source hashes, request hash, local hostname, stale interval,
dead owner PID, and unchanged lock identity. Recovery holds a separate exclusive
interlock, removes only dead-owner temporary files, quarantines the identity-verified
stale lock, and then starts the same confined server:

```powershell
$env:SEMANTIC_CORPUS_CLEANUP_TOKEN = Get-Content `
  C:\benchmark-state\B01-A4.cleanup.cap -Raw
node tools\semantic-corpus-mcp\launcher.mjs resume `
  --state C:\benchmark-state\B01-A4.json
```

After parent verification and promotion, the parent orchestrator destroys the
disposable run root and its separately owned state/capability files. The launcher does
not expose a recursive-delete command driven by a caller-selected state path.

## Validation

Run with Node 20 or later:

```powershell
$tests = (Get-ChildItem tests\semantic-corpus-mcp -Filter *.test.mjs).FullName
node --test $tests
```

The suite uses the real merged arm contract and schemas. It covers launcher startup and
failure, Windows/POSIX access policy probes, permission-model MCP startup, full
initialize/list/read/write/finalize flow, exact canonical output and parent hash
verification, real v1 integration, 0/59/mixed-malformed/60-valid and
aggregate-budget-bounded publication, normalized
`file.read`/`file.write`/`staging.validate` events through the merged isolation verifier,
forged/path-tampered/expired/replayed/executable-mismatched startup, traversal and reparse
authority-key forgery, write-once publication, bounded contention, abrupt termination, fail-closed stale
locks, and authorized cleanup/resume.
