import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { generateVisualization } from "../../scripts/generate-v5-visualization.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const repositoryRoot = resolve(root, "..", "..");

test("protocol-v5 visualization is deterministic and current", () => {
  const first = generateVisualization();
  const second = generateVisualization();
  assert.equal(first.files.size, 4);
  for (const [path, bytes] of first.files) {
    assert.ok(bytes.equals(second.files.get(path)));
    assert.ok(bytes.equals(readFileSync(path)));
  }
});

test("dashboard is self-contained, Clawpilot-themed, responsive, and keyboard accessible", () => {
  const dashboard = readFileSync(resolve(root, "results", "v5-results-dashboard.html"), "utf8");
  assert.match(dashboard, /^<!doctype html>/u);
  assert.doesNotMatch(dashboard, /https?:\/\//u);
  assert.match(dashboard, /const param = new URLSearchParams\(window\.location\.search\)/u);
  assert.ok(dashboard.indexOf("new URLSearchParams") < dashboard.lastIndexOf("<script>"));
  assert.match(dashboard, /--cp-bg: #f7f4ef/u);
  assert.match(dashboard, /html\[data-theme="dark"\]/u);
  assert.match(dashboard, /font-family: "Segoe UI", Aptos, Calibri/u);
  assert.match(dashboard, /@media \(max-width: 560px\)/u);
  assert.match(dashboard, /role="tablist"/u);
  assert.equal((dashboard.match(/<button[^>]+role="tab"/gu) ?? []).length, 4);
  assert.equal((dashboard.match(/<section[^>]+role="tabpanel"/gu) ?? []).length, 4);
  assert.match(dashboard, /"ArrowLeft", "ArrowRight", "Home", "End"/u);
  assert.match(dashboard, /aria-live="polite"/u);
  assert.doesNotMatch(dashboard, /<script[^>]+src=/u);
  assert.doesNotMatch(dashboard, /<link[^>]+stylesheet/u);
});

test("dashboard values and verdicts are rendered from the canonical summary", () => {
  const { summary } = generateVisualization();
  const dashboard = readFileSync(resolve(root, "results", "v5-results-dashboard.html"), "utf8");
  assert.match(dashboard, /-38\.8%/u);
  assert.match(dashboard, /-58\.0%/u);
  assert.match(dashboard, /\+88\.0%/u);
  assert.match(dashboard, /\+72\.0%/u);
  assert.match(dashboard, /Combined efficiency signal: not met/u);
  for (const arm of summary.arms) {
    assert.match(dashboard, new RegExp(`A${arm.armId}`, "u"));
    assert.match(dashboard, new RegExp(`${arm.flow.successfulDisposition}/12`, "u"));
  }
  assert.equal(summary.targetArmDecisionRule.positiveEfficiencySignal, false);
  assert.deepEqual(summary.targetArmDecisionRule.qualityPasses, {
    promotionRate: true,
    pathCoverage: false,
    mutantKillRate: false
  });
});

test("SVG fallbacks expose equivalent text and accessible names without external assets", () => {
  const paths = [
    resolve(root, "results", "v5-charts", "a5-vs-a1-tradeoffs.svg"),
    resolve(root, "results", "v5-charts", "all-arm-comparison.svg"),
    resolve(root, "results", "v5-charts", "a5-reliability-funnel.svg")
  ];
  for (const path of paths) {
    const svg = readFileSync(path, "utf8");
    const [, widthText, heightText] = svg.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/u);
    const width = Number(widthText);
    const height = Number(heightText);
    assert.match(svg, /^<svg /u);
    assert.match(svg, /role="img"/u);
    assert.match(svg, /aria-labelledby="title description"/u);
    assert.match(svg, /<title id="title">[^<]+<\/title>/u);
    assert.match(svg, /<desc id="description">[^<]+<\/desc>/u);
    assert.doesNotMatch(svg, /<image\b/u);
    assert.doesNotMatch(svg, /\bhref=/u);
    assert.match(svg, /Source: v5-final-summary\.json/u);
    assert.match(svg, /\.good \{ fill: #16a34a; \}/u);
    assert.match(svg, /\.bad \{ fill: #dc2626; \}/u);
    for (const match of svg.matchAll(/\bx="([\d.]+)"/gu)) {
      assert.ok(Number(match[1]) <= width, `${path} has x=${match[1]} outside ${width}`);
    }
    for (const match of svg.matchAll(/\by="([\d.]+)"/gu)) {
      assert.ok(Number(match[1]) <= height, `${path} has y=${match[1]} outside ${height}`);
    }
    for (const match of svg.matchAll(/<rect\b[^>]*\bx="([\d.]+)"[^>]*\bwidth="([\d.]+)"/gu)) {
      assert.ok(Number(match[1]) + Number(match[2]) <= width,
        `${path} has a rectangle outside ${width}`);
    }
  }
});

test("repository navigation links to the dashboard and static charts", () => {
  const files = [
    resolve(root, "report.md"),
    resolve(root, "README.md"),
    resolve(repositoryRoot, "docs", "reference-implementations", "semantic-test-corpus.md"),
    resolve(repositoryRoot, "README.md")
  ].map((path) => readFileSync(path, "utf8"));
  for (const content of files) {
    assert.match(content, /v5-results-dashboard\.html/u);
  }
  assert.match(files[0], /v5-charts\/a5-vs-a1-tradeoffs\.svg/u);
  assert.match(files[0], /v5-charts\/all-arm-comparison\.svg/u);
  assert.match(files[0], /v5-charts\/a5-reliability-funnel\.svg/u);
});
