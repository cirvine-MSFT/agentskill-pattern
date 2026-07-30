# Reference implementation: `semantic-test-corpus` (GitHub Copilot)

**Status: implemented reference.** This reference applies the Agent Skill Pattern to
semantic acceptance-test source-scenario design for a deterministic configuration
migration. AI is limited to proposing source inputs and explanatory metadata. The
migration, expected-output oracle, validation, promotion, execution tracing, and mutant
scoring remain deterministic parent-owned operations.

## Components

| Role | Implementation |
| --- | --- |
| Skill router | [`.github/skills/semantic-test-corpus/SKILL.md`](../../.github/skills/semantic-test-corpus/SKILL.md) |
| Custom agent | [`.github/agents/semantic-test-corpus.agent.md`](../../.github/agents/semantic-test-corpus.agent.md) |
| Model | `claude-haiku-4.5` |
| Agent tools | Four namespaced `semantic-corpus/*` MCP tools only |
| MCP server | [`tools/semantic-corpus-mcp/server.mjs`](../../tools/semantic-corpus-mcp/server.mjs), Node 20+, dependency-free local stdio |
| Tests | [`tests/semantic-corpus-mcp/`](../../tests/semantic-corpus-mcp/) |

The custom-agent profile follows GitHub's
[custom agent configuration](https://docs.github.com/en/copilot/reference/custom-agents-configuration):
`target: github-copilot`, `user-invocable: false`, a local MCP server, and an explicit
namespaced tool allowlist. It exposes no generic `read`, `edit`, `search`, `execute`,
`web`, or `agent` tool. Omitting `agent` is the structural recursion guard.

## Fixed capability boundary

The MCP process derives exactly two roots from its process working directory:

| Root | Agent capability |
| --- | --- |
| `corpus-contract/` | List and read regular files only |
| `corpus-staging/` | Write source scenarios and one manifest only |

The parent creates clean roots before delegation. The server never accepts a root path
or output path from the model. Scenario IDs map to
`corpus-staging/scenarios/<id>.json`; the manifest always maps to
`corpus-staging/manifest.json`. There is no staging read/list tool and no contract write
tool.

This is stronger than prompt-only path restrictions or a separate worktree. Every
accepted contract path must be relative, NFC-normalized, ASCII, `/`-separated, and exact
case. Absolute paths, drive paths, UNC paths, `.`/`..`, empty segments, alternate
separators, Unicode separator lookalikes, and case aliases are rejected. Each existing
component is checked with `lstat` and `realpath`; symlinks, Windows junctions, and other
redirections are rejected at the fixed root and below it. Resolved paths must remain
inside the corresponding fixed root.

Writes use server-selected destinations and write-once atomic publication: a bounded
JSON document is written to an exclusive temporary file in the destination directory,
flushed, and hard-linked into its final name. Publication cannot replace an existing
file, and failed temporary files are removed. Server requests are serialized so
concurrent calls cannot race the 60-scenario limit.

## Narrow MCP tools

| Tool | Contract |
| --- | --- |
| `list_contract_files` | Returns at most 200 bounded regular files under `corpus-contract/`; any redirection or unexpected filesystem object fails the whole call. |
| `read_contract_file` | Reads one exact listed path, limited to 256 KiB. |
| `write_scenario_input` | Accepts a lowercase slug ID and one bounded JSON object; writes at most 64 KiB to the fixed scenarios directory. |
| `write_scenario_manifest` | Accepts metadata for 40-60 scenarios whose IDs must exactly match staged files; writes the fixed manifest once. |

The server implements MCP JSON-RPC over stdio for `initialize`, `ping`, `tools/list`,
and `tools/call`. It emits only protocol messages on stdout and has no shell or process
execution capability.

## Structural output exclusion

Scenario input validation recursively enforces depth, node, object-key, array-item,
string, document-size, and scenario-count limits. It rejects fields representing:

- expected outputs, expected results, or expected errors;
- oracle outputs or oracle results;
- migration source, implementation, scripts, or paths; and
- dangerous prototype fields.

Path-shaped input fields receive the same relative-path checks and additionally reject
expected-output, oracle, migration-source, and existing test/fixture directory segments.
Manifest objects have a closed schema: only scenario ID, category, rationale, and
contract references are model-supplied. The server generates each staging file path.
Unexpected fields are errors rather than silently ignored data.

These checks prevent the model from smuggling an expected result or migration artifact
through a differently named output file or extra manifest field. They do not claim that
AI-authored rationale is a coverage result: rationale records intent only.

## Parent workflow

1. Create clean `corpus-contract/` and `corpus-staging/` directories in the invocation
   working directory.
2. Populate the contract with bounded v1/v2 schemas, mapping rules, cross-field/domain
   invariants, legacy examples, and migration bug history. Do not expose migration
   source, expected outputs, oracle artifacts, existing test directories, or mutants.
3. Prepare deterministic schema, duplicate, promotion, trusted-oracle, trace, and mutant
   validators before delegation.
4. Invoke the named `semantic-test-corpus` agent with a target from 40 through 60 and an
   explicit category set. There is no inline fallback.
5. After its terse path/count/status return, validate every staged source input.
6. Promote only accepted source inputs. The deterministic oracle then computes expected
   outcomes, and deterministic traces and hidden mutants measure corpus effectiveness.

The agent never computes expected output, promotes a candidate, executes the migration,
runs the oracle, or sees the mutant set. If the deterministic baseline already matches
or exceeds the AI-assisted corpus, omit the AI step.

## Defense in depth

The MCP server is the primary path capability boundary because its API cannot name
arbitrary roots or output paths. Production use should still add an OS boundary:

- run the local MCP process in a container, restricted VM, or enforceable sandbox with
  only `corpus-contract/` mounted read-only and `corpus-staging/` mounted writable;
- apply filesystem ACLs that deny the MCP identity access to migration source, oracle
  artifacts, expected results, existing tests, sibling worktrees, and parent paths; and
- use a dedicated temporary working directory rather than a repository root.

These controls limit damage from runtime, filesystem, or platform defects. They are
defense in depth, not substitutes for the server's fixed-root API. In particular, a bare
worktree, generic file tools, or Windows path-denial settings that are not enforced do
not establish the required boundary.

## Validation

Run the dependency-free suite with Node 20 or later:

```powershell
$tests = (Get-ChildItem tests\semantic-corpus-mcp -Filter *.test.mjs).FullName
node --test $tests
```

The suite exercises normal reads/writes; MCP initialization, discovery, and calls;
traversal, absolute, alternate-separator, Unicode, and case attacks; symlink, junction,
reparse, and root redirection; forbidden fields and paths; payload and count limits;
write-once atomicity; and the custom-agent MCP/tool allowlist.
