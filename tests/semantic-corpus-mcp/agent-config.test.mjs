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
  assert.doesNotMatch(frontmatter, /^model:/m);
  assert.match(frontmatter, /^user-invocable: false$/m);
  assert.match(frontmatter, /^\s+type: local$/m);
  assert.match(frontmatter, /^\s+command: node$/m);
  assert.match(
    frontmatter,
    /^\s+args: \["tools\/semantic-corpus-mcp\/server\.mjs"\]$/m,
  );

  const allowed = [
    "semantic-corpus/list_contract_files",
    "semantic-corpus/read_contract_file",
    "semantic-corpus/write_scenario_input",
    "semantic-corpus/write_scenario_manifest",
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
  assert.match(agent, /Never produce, infer, request, encode, or\s+describe an expected output/);
  assert.match(agent, /Do not\s+attempt to .*delegate to another agent/s);
  assert.match(agent, /self-hash, exact target count/);
  assert.match(skill, /never\s+generate scenarios inline/i);
  assert.match(skill, /container, enforceable OS sandbox, or dedicated ACL/i);
  assert.match(skill, /fails before MCP\s+initialization otherwise/i);
  assert.match(skill, /evaluator-only deterministic code may snapshot/i);
  assert.match(skill, /parent must not\s+read, package, validate, or copy the corpus/i);
  assert.match(skill, /trusted oracle/i);
  assert.match(skill, /mutant scoring/i);
  assert.match(skill, /inherits the caller\/session model/i);
});
