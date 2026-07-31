import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const agentPath = fileURLToPath(
  new URL("../../.github/agents/semantic-test-corpus.agent.md", import.meta.url),
);
const skillPath = fileURLToPath(
  new URL("../../.github/skills/semantic-test-corpus/SKILL.md", import.meta.url),
);

test("custom-agent frontmatter exposes only request-bound MCP tools", async () => {
  const text = await readFile(agentPath, "utf8");
  const frontmatter = text.split("---")[1];
  assert.match(frontmatter, /^name: semantic-test-corpus$/m);
  assert.match(frontmatter, /^target: github-copilot$/m);
  assert.match(frontmatter, /^model: claude-haiku-4\.5$/m);
  assert.match(frontmatter, /^user-invocable: false$/m);
  assert.match(frontmatter, /^\s+type: local$/m);
  assert.match(frontmatter, /^\s+command: node$/m);
  assert.match(
    frontmatter,
    /^\s+args: \["tools\/semantic-corpus-mcp\/launcher\.mjs"\]$/m,
  );

  const allowed = [
    "semantic-corpus/read_request",
    "semantic-corpus/list_contract_files",
    "semantic-corpus/read_contract_file",
    "semantic-corpus/write_scenario",
    "semantic-corpus/finalize_staging",
  ];
  const topTools = frontmatter
    .slice(frontmatter.indexOf("tools:"), frontmatter.indexOf("mcp-servers:"))
    .match(/semantic-corpus\/[a-z_]+/g);
  assert.deepEqual(topTools, allowed);
  assert.doesNotMatch(
    frontmatter.slice(frontmatter.indexOf("tools:"), frontmatter.indexOf("mcp-servers:")),
    /^\s+-\s+(read|edit|search|execute|web|agent|\*)$/m,
  );
});

test("agent and Skill preserve deterministic parent ownership and no fallback", async () => {
  const [agent, skill] = await Promise.all([
    readFile(agentPath, "utf8"),
    readFile(skillPath, "utf8"),
  ]);
  assert.match(agent, /Never produce, infer, request, encode, or\s*describe\s+an expected output/);
  assert.match(agent, /Do not\s+attempt to\s+.*delegate to another agent/s);
  assert.match(agent, /self-hash, contract-manifest hash/);
  assert.match(agent, /Design exactly 60 diverse source-only scenarios/);
  assert.match(agent, /compact JSON object returned by `finalize_staging`/);
  assert.match(skill, /never\s+generate scenarios inline/i);
  assert.match(skill, /Invoke only the trusted launcher, never the server directly/i);
  assert.match(skill, /caller-provided sandbox-kind label is not evidence/i);
  assert.match(skill, /fails before MCP initialization/i);
  assert.match(skill, /parent invokes the launcher verifier/i);
  assert.match(skill, /trusted oracle/i);
  assert.match(skill, /mutant scoring/i);
  assert.match(skill, /Stale lifetime locks are never stolen/i);
});
