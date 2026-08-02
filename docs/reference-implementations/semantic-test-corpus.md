# Reference implementation: `semantic-test-corpus` (GitHub Copilot)

**Status: implemented reference with completed protocol-v5 case study.** AI proposes
schema-valid v1 source documents. It never computes expected results. Deterministic
parent code owns validation, promotion, migration execution, the expected-output
oracle, traces, and mutant scoring. See the
[final descriptive ITT report](../../experiments/semantic-test-corpus/report.md),
[concise protocol](../../experiments/semantic-test-corpus/protocol.md), and
[cross-study machine-readable summary](../../experiments/results-summary.csv).

## Components

| Role | Implementation |
| --- | --- |
| Skill router | [`.github/skills/semantic-test-corpus/SKILL.md`](../../.github/skills/semantic-test-corpus/SKILL.md) |
| Custom agents | [inherited model](../../.github/agents/semantic-test-corpus.agent.md); [benchmark fixed Haiku](../../.github/agents/semantic-test-corpus-haiku.agent.md) |
| Model | Inherited normally; fixed to `claude-haiku-4.5` only for the target profile |
| Agent tools | Four namespaced `semantic-corpus/*` MCP tools only |
| MCP server | [`tools/semantic-corpus-mcp/server.mjs`](../../tools/semantic-corpus-mcp/server.mjs), dependency-free Node 20+ stdio |
| Tests | [`tests/semantic-corpus-mcp/`](../../tests/semantic-corpus-mcp/) |

The agent profile has no generic `read`, `edit`, `search`, `execute`, `web`, or `agent`
tool. Omitting `agent` is the structural recursion guard. All filesystem capability
comes from the local MCP process.

The normal profile deliberately has no `model` field. The benchmark target profile is
generated from it with only name/model changed. Normalized bytes, MCP tools,
instructions, task bytes, and return contract are identical; observed lifecycle/usage
evidence must authenticate the selected worker model.

## Mandatory launcher boundary

The MCP process **must** run in a container, restricted-mount sandbox, restricted VM, or
dedicated ACL identity. This is a startup requirement, not optional hardening:

- mount or ACL `corpus-contract/` and the sandbox config read-only;
- expose only `corpus-staging/` as writable;
- deny the MCP identity access to repositories, migration source, oracle and expected
  artifacts, existing tests, parent directories, and sibling worktrees; and
- use a disposable run directory, not a repository or bare worktree.

After establishing those grants, the trusted launcher writes an immutable sandbox config
outside both roots and passes its absolute path and a fresh token through
`SEMANTIC_CORPUS_SANDBOX_CONFIG` and `SEMANTIC_CORPUS_SANDBOX_TOKEN`:

```json
{
  "version": 1,
  "sandboxKind": "restricted-mounts",
  "tokenHash": "sha256:<64-lowercase-hex-characters>",
  "requestHash": "<request.json requestHash>",
  "roots": {
    "contract": {
      "path": "C:\\isolated-run\\corpus-contract",
      "access": "read-only",
      "identity": { "device": "123", "fileId": "456" }
    },
    "staging": {
      "path": "C:\\isolated-run\\corpus-staging",
      "access": "read-write",
      "identity": { "device": "123", "fileId": "789" }
    }
  },
  "lock": { "waitTimeoutMs": 5000, "staleAfterMs": 300000 }
}
```

`sandboxKind` is `container`, `restricted-mounts`, or `restricted-acl`. `fileId` is
Node's inode/file-identity value, including the Windows file ID exposed by Node where the
filesystem provides it. The config contains only the token hash; the token comes from
the launcher environment. Roots must be absolute, disjoint, canonical non-reparse
directories with the exact attested device/file identity.

Before emitting an MCP response, the server requires the config and token, verifies the
token hash, launcher-pinned request hash, config identity/content, root identities, and
the immutable request, and confirms that the config and request deny write opens. Contract
reads likewise require write denial for the selected file. It
rechecks config, root, request-file, and opened-file identity around every operation.
Missing, stale, changed, or unverifiable evidence fails closed.

These Node checks are **defense in depth, not a TOCTOU-proof sandbox**. Portable Node
pathname checks cannot provide race-proof `openat`-style confinement on every platform.
The implementation uses `O_NOFOLLOW` where Node exposes it, opens only verified regular
files, rejects symlinks/junctions/case aliases, and rechecks identities before and after
operations. The container, restricted mounts, or ACL boundary remains the primary access
control and must stay effective for the process lifetime.

## Immutable request

The parent writes read-only `corpus-contract/request.json`. It is a closed object with a
self-hash over canonical JSON excluding `requestHash`:

```json
{
  "version": 1,
  "targetCount": 2,
  "scenarios": [
    { "scenarioId": "mapping-null-region", "category": "mapping-rules" },
    { "scenarioId": "cross-field-flags", "category": "cross-field-invariants" }
  ],
  "categories": [
    { "category": "mapping-rules", "minQuota": 1 },
    { "category": "cross-field-invariants", "minQuota": 1 }
  ],
  "maxSizes": {
    "contractFileBytes": 262144,
    "scenarioBytes": 65536,
    "manifestBytes": 262144
  },
  "v1ConfigSchema": {
    "type": "object",
    "additionalProperties": false,
    "required": ["version", "id", "profile"],
    "properties": {
      "version": { "type": "integer", "const": 1 },
      "id": { "type": "string", "minLength": 1, "maxLength": 40 },
      "profile": {
        "type": "object",
        "additionalProperties": false,
        "required": ["region"],
        "properties": {
          "region": { "type": "string", "maxLength": 4, "enum": ["us", "eu"] }
        }
      }
    }
  },
  "requestHash": "<SHA-256 of canonical request without this field>"
}
```

`targetCount` must exactly equal the request-defined scenario list. IDs are unique;
categories are closed and satisfy every minimum quota before delegation. The model cannot
initialize or change the request.

The supported schema dialect is deliberately small: recursively closed objects, bounded
arrays and strings, finite numbers, safe integers, booleans, null, `const`, scalar enums,
numeric bounds, patterns, and bounded `anyOf`. Every object schema must explicitly set
`additionalProperties: false`; unsupported schema keywords are rejected.

This positive schema is the structural output-exclusion control. The write tool accepts
only `scenarioId` plus `config`, and `config` must match the exact v1 schema recursively.
`expectedOutcome`, `oracleVerdict`, punctuation aliases, Unicode-confusable keys, and
nested variants are naturally unknown properties. There is no semantic-name denylist or
unrestricted JSON escape hatch.

## Narrow tools

| Tool | Capability |
| --- | --- |
| `list_contract_files` | List bounded regular files under the attested contract root. |
| `read_contract_file` | Read one exact relative contract path. |
| `write_scenario_input` | Accept only a request-defined `scenarioId` and exact closed-schema `config`; atomically publish the config under the fixed staging path. |
| `write_scenario_manifest` | Accept only the exact request-defined ID/category pairs; validate every staged config, exact count, and quotas, then publish once. |

There is no agent corpus-initialization tool, metadata tool, staging read tool, generic
filesystem tool, free-form summary, rationale, evidence string, path, or output/oracle
field. The JSON-RPC `initialize` method is MCP protocol negotiation, not an agent
capability to initialize corpus state.

## Cross-process staging lock

Every operation atomically acquires `corpus-staging/.corpus.lock` with exclusive-create
semantics. Initialization and request reading, contract reads, scenario count checks,
writes, complete manifest snapshot validation, and publication occur while the lock is
held. The lock records owner PID, hostname, acquisition time, and a random nonce.

Contenders wait only for the launcher-configured bounded interval. A malformed lock fails
closed. A lock older than `staleAfterMs` returns `LOCK_STALE` and is **never removed or
stolen**; the parent must destroy or inspect the disposable run. Release verifies the open
handle and pathname still identify the owner's lock before removal.

Scenario and manifest publication writes a bounded exclusive temporary file in the
destination directory, flushes it, marks it read-only, and hard-links it to a write-once
final name. Existing files are never replaced. Manifest publication reopens and validates
every scenario twice around the snapshot boundary.

## Parent workflow

1. Create a disposable run and establish container, mount, or ACL confinement.
2. Write the closed request and contract; compute its canonical request hash.
3. Record final root identities, write the read-only sandbox config, and launch with a
   fresh matching token.
4. Invoke the `semantic-test-corpus` agent. There is no inline fallback in the reference
   workflow. Controlled benchmarks may instead give an authenticated inline parent the
   same four MCP tools directly; that is an experimental arm, not a fallback.
5. Outside model context, deterministically snapshot exact staged files and authenticated
   tool-error records when a benchmark requires a canonical aggregate artifact. The
   model caller never packages, rereads, validates, or copies the corpus.
6. Independently validate staged v1 documents and promote only accepted inputs.
7. Run the deterministic oracle, migration, traces, and hidden mutants outside the
   agent/MCP identity.
8. Destroy the disposable run, including any stale lock.

## Validation

Run with Node 20 or later:

```powershell
$tests = (Get-ChildItem tests\semantic-corpus-mcp -Filter *.test.mjs).FullName
node --test $tests
```

The suite covers MCP discovery/calls, fail-closed startup, recursively closed schemas,
oracle/expected aliases and confusables, immutable request and sandbox identity, exact
counts/quotas, traversal/case/Unicode/symlink/junction attacks, write-once publication,
stale-lock policy, and two-process count/write/manifest races.
