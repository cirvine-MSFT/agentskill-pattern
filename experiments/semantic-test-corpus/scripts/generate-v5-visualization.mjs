#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const summaryPath = resolve(root, "results", "v5-final-summary.json");
const outputs = {
  dashboard: resolve(root, "results", "v5-results-dashboard.html"),
  tradeoffs: resolve(root, "results", "v5-charts", "a5-vs-a1-tradeoffs.svg"),
  arms: resolve(root, "results", "v5-charts", "all-arm-comparison.svg"),
  funnel: resolve(root, "results", "v5-charts", "a5-reliability-funnel.svg")
};

const shortLabels = [
  "A0 deterministic",
  "A1 GPT inline",
  "A2 GPT to GPT",
  "A3 Haiku inline",
  "A4 Haiku to Haiku",
  "A5 GPT to Haiku"
];

function readSummary() {
  const summary = JSON.parse(readFileSync(summaryPath, "utf8"));
  assert.equal(summary.protocolId, "semantic-test-corpus-execution-v5");
  assert.equal(summary.execution.randomizedCompleteBlocks, 12);
  assert.equal(summary.arms.length, 6);
  assert.equal(summary.targetContrasts.length, 5);
  return summary;
}

function htmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function xmlEscape(value) {
  return htmlEscape(value).replaceAll("'", "&apos;");
}

function fixed(value, digits = 1) {
  return Number(value).toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  });
}

function percent(value, digits = 1) {
  return `${fixed(value * 100, digits)}%`;
}

function signedPercent(value, digits = 1) {
  const rounded = Number(value.toFixed(digits));
  return `${rounded > 0 ? "+" : ""}${fixed(rounded, digits)}%`;
}

function signedPoints(value, digits = 1) {
  const points = Number((value * 100).toFixed(digits));
  return `${points > 0 ? "+" : ""}${fixed(points, digits)} pp`;
}

function count(value, denominator = 12) {
  return `${value}/${denominator}`;
}

function mean(summary, armId, endpoint) {
  return summary.arms[armId].endpointStatistics[endpoint].mean;
}

function contrast(summary, armId, endpoint) {
  const item = summary.targetContrasts.find((candidate) => candidate.referenceArm === armId);
  assert.ok(item, `Missing A5 contrast against A${armId}`);
  return item.endpoints[endpoint];
}

function tone(value, lowerIsBetter) {
  if (Math.abs(value) < 0.05) return "neutral";
  return lowerIsBetter ? (value < 0 ? "good" : "bad") : (value > 0 ? "good" : "bad");
}

function metricCard(label, value, className, note) {
  return `<article class="card metric-card">
          <div class="metric-label">${htmlEscape(label)}</div>
          <div class="metric-value ${className}">${htmlEscape(value)}</div>
          <p>${htmlEscape(note)}</p>
        </article>`;
}

function renderDashboard(summary) {
  const a5 = summary.arms[5];
  const a1 = contrast(summary, 1, "totalAiCredits");
  const parent = contrast(summary, 1, "parentCumulativeInputTokens");
  const tokens = contrast(summary, 1, "totalModelTokens");
  const wall = contrast(summary, 1, "wallMs");
  const path = contrast(summary, 1, "pathCoverage");
  const mutant = contrast(summary, 1, "mutantKillRate");
  const decision = summary.targetArmDecisionRule;
  const verdict = decision.positiveEfficiencySignal ? "met" : "not met";
  const headline = decision.positiveEfficiencySignal
    ? "The end-to-end efficiency bet held."
    : "The architecture worked. The end-to-end bet did not.";
  const contrastData = Object.fromEntries(summary.targetContrasts.map((item) => [
    `A${item.referenceArm}`,
    [
      ["Promotion", signedPoints(item.endpoints.promotionRate.meanDifference), tone(item.endpoints.promotionRate.meanDifference, false)],
      ["Path coverage", signedPoints(item.endpoints.pathCoverage.meanDifference), tone(item.endpoints.pathCoverage.meanDifference, false)],
      ["Mutant kill", signedPoints(item.endpoints.mutantKillRate.meanDifference), tone(item.endpoints.mutantKillRate.meanDifference, false)],
      ["Credits", item.endpoints.totalAiCredits.percentChange === null ? "n/a" : signedPercent(item.endpoints.totalAiCredits.percentChange), tone(item.endpoints.totalAiCredits.percentChange ?? 0, true)],
      ["Parent input", item.endpoints.parentCumulativeInputTokens.percentChange === null ? "n/a" : signedPercent(item.endpoints.parentCumulativeInputTokens.percentChange), tone(item.endpoints.parentCumulativeInputTokens.percentChange ?? 0, true)],
      ["Model tokens", item.endpoints.totalModelTokens.percentChange === null ? "n/a" : signedPercent(item.endpoints.totalModelTokens.percentChange), tone(item.endpoints.totalModelTokens.percentChange ?? 0, true)],
      ["Wall time", signedPercent(item.endpoints.wallMs.percentChange), tone(item.endpoints.wallMs.percentChange, true)]
    ]
  ]));
  const armRows = summary.arms.map((arm) => `<tr${arm.armId === 5 ? ' class="target"' : ""}>
              <th scope="row">${htmlEscape(shortLabels[arm.armId])}</th>
              <td>${count(arm.flow.successfulDisposition)}</td>
              <td>${count(arm.flow.operationallySuccessful)}</td>
              <td>${fixed(mean(summary, arm.armId, "totalAiCredits"), 2)}</td>
              <td>${percent(mean(summary, arm.armId, "pathCoverage"))}</td>
              <td>${percent(mean(summary, arm.armId, "mutantKillRate"))}</td>
              <td>${fixed(mean(summary, arm.armId, "totalModelTokens") / 1000, 1)}k</td>
              <td>${fixed(mean(summary, arm.armId, "wallMs") / 1000, 1)}s</td>
            </tr>`).join("\n");
  const qualityThresholds = [
    ["Promotion vs A0", decision.qualityComparisons.promotionRate.difference, decision.preregisteredRule.qualityFloors.promotionRateDifferenceMinimum, decision.qualityPasses.promotionRate],
    ["Path coverage vs A0", decision.qualityComparisons.pathCoverage.difference, decision.preregisteredRule.qualityFloors.pathCoverageDifferenceMinimum, decision.qualityPasses.pathCoverage],
    ["Mutant kill vs A0", decision.qualityComparisons.mutantKillRate.difference, decision.preregisteredRule.qualityFloors.mutantKillRateDifferenceMinimum, decision.qualityPasses.mutantKillRate]
  ];
  const efficiencyThresholds = [
    ["Parent cumulative input vs A1", decision.efficiency.parentCumulativeInputTokensRatio, decision.preregisteredRule.positiveEfficiencySignalRequires.parentCumulativeInputTokensRatioMaximum, decision.efficiencyPasses.parentCumulativeInputTokens],
    ["Total nano-AIU vs A1", decision.efficiency.totalNanoAiuRatio, decision.preregisteredRule.positiveEfficiencySignalRequires.totalNanoAiuRatioMaximum, decision.efficiencyPasses.totalNanoAiu],
    ["Total credits vs A1", decision.efficiency.totalAiCreditsRatio, decision.preregisteredRule.positiveEfficiencySignalRequires.totalAiCreditsRatioMaximum, decision.efficiencyPasses.totalAiCredits],
    ["Wall time vs A1 (secondary)", decision.secondaryWallTarget.ratio, decision.preregisteredRule.secondaryWallTarget.ratioMaximum, decision.secondaryWallTarget.met]
  ];
  const thresholdRows = [
    ...qualityThresholds.map(([label, observed, threshold, met]) => [
      label,
      `>= ${signedPoints(threshold)}`,
      signedPoints(observed),
      met
    ]),
    ...efficiencyThresholds.map(([label, observed, threshold, met]) => [
      label,
      `<= ${percent(threshold, 0)} of comparator`,
      `${percent(observed, 1)} of comparator`,
      met
    ])
  ].map(([label, criterion, observed, met]) => `<tr>
              <th scope="row">${htmlEscape(label)}</th>
              <td>${htmlEscape(criterion)}</td>
              <td>${htmlEscape(observed)}</td>
              <td><span class="pill ${met ? "good" : "bad"}">${met ? "met" : "not met"}</span></td>
            </tr>`).join("\n");
  const failureRows = Object.entries(a5.failureCategories)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([category, value]) => `<li><strong>${htmlEscape(category)}</strong><span>${count(value)}</span></li>`)
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Semantic corpus protocol-v5 results</title>
  <link rel="icon" href="data:,">
  <script>
  (() => {
    const param = new URLSearchParams(window.location.search).get("scoutTheme");
    const theme =
      param || (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    document.documentElement.setAttribute("data-theme", theme);
  })();
  </script>
  <style>
    :root {
      color-scheme: light;
      --cp-bg: #f7f4ef;
      --cp-bg-elevated: #fcfbf8;
      --cp-surface: #ffffff;
      --cp-surface-soft: #f5f5f5;
      --cp-border: #dedede;
      --cp-border-strong: #919191;
      --cp-text: #242424;
      --cp-text-muted: #5c5c5c;
      --cp-text-soft: #6f6f6f;
      --cp-accent: #b11f4b;
      --cp-accent-hover: #9a1a41;
      --cp-accent-soft: rgba(177, 31, 75, 0.08);
      --cp-accent-fg: #ffffff;
      --cp-success: #16a34a;
      --cp-danger: #dc2626;
      --cp-warning: #f59e0b;
      --cp-link: #0078d4;
      --cp-shadow: 0 18px 48px rgba(0, 0, 0, 0.12);
      --cp-overlay: rgba(255, 255, 255, 0.8);
      --cp-panel: rgba(255, 255, 255, 0.86);
      --cp-panel-strong: rgba(255, 255, 255, 0.96);
      --cp-sheen: rgba(255, 255, 255, 0.55);
      --cp-highlight: rgba(177, 31, 75, 0.12);
    }
    html[data-theme="dark"] {
      color-scheme: dark;
      --cp-bg: #3d3b3a;
      --cp-bg-elevated: #343231;
      --cp-surface: #292929;
      --cp-surface-soft: #2e2e2e;
      --cp-border: #474747;
      --cp-border-strong: #5f5f5f;
      --cp-text: #dedede;
      --cp-text-muted: #919191;
      --cp-text-soft: #b0b0b0;
      --cp-accent: #fd8ea1;
      --cp-accent-hover: #fb7b91;
      --cp-accent-soft: rgba(253, 142, 161, 0.14);
      --cp-accent-fg: #1a1a1a;
      --cp-success: #4ade80;
      --cp-danger: #f87171;
      --cp-warning: #fbbf24;
      --cp-link: #4da6ff;
      --cp-shadow: 0 18px 48px rgba(0, 0, 0, 0.32);
      --cp-overlay: rgba(41, 41, 41, 0.88);
      --cp-panel: rgba(41, 41, 41, 0.72);
      --cp-panel-strong: rgba(41, 41, 41, 0.96);
      --cp-sheen: rgba(255, 255, 255, 0.04);
      --cp-highlight: rgba(253, 142, 161, 0.12);
    }
    * { box-sizing: border-box; }
    body { margin: 0; background: var(--cp-bg); color: var(--cp-text); font-family: "Segoe UI", Aptos, Calibri, -apple-system, BlinkMacSystemFont, sans-serif; }
    button, select { font: inherit; }
    a { color: var(--cp-link); }
    a:focus-visible, button:focus-visible, select:focus-visible { outline: 3px solid var(--cp-accent); outline-offset: 3px; }
    .shell { width: min(1180px, calc(100% - 32px)); margin: 0 auto; padding: 32px 0 64px; }
    .eyebrow { color: var(--cp-accent); font-size: .78rem; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
    h1 { max-width: 920px; margin: 12px 0 16px; font-size: clamp(2.1rem, 6vw, 4.3rem); line-height: 1; }
    h2 { margin: 0 0 8px; font-size: clamp(1.45rem, 3vw, 2.1rem); }
    h3 { margin: 0 0 8px; }
    p { color: var(--cp-text-muted); line-height: 1.55; }
    .lead { max-width: 900px; margin: 0; font-size: 1.1rem; }
    .evidence { margin: 24px 0; padding: 16px 18px; border-left: 4px solid var(--cp-warning); background: var(--cp-surface); }
    .evidence p { margin: 0; }
    .verdict { display: grid; grid-template-columns: auto 1fr; gap: 14px; align-items: center; margin: 20px 0; padding: 18px; border: 1px solid var(--cp-danger); border-radius: .625rem; background: var(--cp-surface); }
    .verdict-mark { display: grid; width: 38px; height: 38px; place-items: center; border: 2px solid var(--cp-danger); border-radius: 50%; color: var(--cp-danger); font-weight: 800; }
    .verdict p { margin: 3px 0 0; }
    .tabs { display: flex; flex-wrap: wrap; gap: 8px; margin: 28px 0; }
    .tab { padding: 10px 14px; border: 1px solid var(--cp-border); border-radius: .625rem; background: var(--cp-surface); color: var(--cp-text); cursor: pointer; }
    .tab:hover { border-color: var(--cp-border-strong); }
    .tab[aria-selected="true"] { border-color: var(--cp-accent); background: var(--cp-accent); color: var(--cp-accent-fg); }
    [role="tabpanel"][hidden] { display: none; }
    .grid { display: grid; grid-template-columns: repeat(12, 1fr); gap: 16px; }
    .card { grid-column: span 4; padding: 20px; border: 1px solid var(--cp-border); border-radius: 16px; background: var(--cp-surface); box-shadow: 0 0 2px var(--cp-border), 0 1px 2px var(--cp-border); }
    .wide { grid-column: 1 / -1; }
    .metric-label { color: var(--cp-text-muted); font-size: .82rem; }
    .metric-value { margin: 6px 0 2px; font-size: clamp(1.8rem, 4vw, 2.8rem); font-weight: 750; }
    .metric-card p { margin-bottom: 0; font-size: .88rem; }
    .good { color: var(--cp-success); }
    .bad { color: var(--cp-danger); }
    .neutral { color: var(--cp-text); }
    .section-head { margin: 36px 0 16px; }
    .section-head p { max-width: 760px; margin: 0; }
    .table-wrap { overflow-x: auto; }
    table { width: 100%; min-width: 760px; border-collapse: collapse; }
    th, td { padding: 11px 10px; border-bottom: 1px solid var(--cp-border); text-align: right; font-size: .86rem; }
    th:first-child { text-align: left; }
    thead th { color: var(--cp-text-muted); }
    tr.target { background: var(--cp-accent-soft); }
    .pill { display: inline-flex; padding: 3px 8px; border: 1px solid currentColor; border-radius: .625rem; font-size: .75rem; font-weight: 700; }
    .funnel { display: grid; gap: 12px; }
    .funnel-row { display: grid; grid-template-columns: 150px 1fr 64px; gap: 12px; align-items: center; }
    .track { height: 16px; overflow: hidden; border: 1px solid var(--cp-border); border-radius: .625rem; background: var(--cp-surface-soft); }
    .fill { height: 100%; width: calc(var(--value) * 1%); background: var(--cp-accent); }
    .failures { display: grid; gap: 0; margin: 0; padding: 0; list-style: none; }
    .failures li { display: flex; justify-content: space-between; gap: 16px; padding: 12px 0; border-bottom: 1px solid var(--cp-border); }
    .comparison-controls { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
    select { padding: 9px 12px; border: 1px solid var(--cp-border); border-radius: .625rem; background: var(--cp-surface); color: var(--cp-text); }
    .contrast-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-top: 16px; }
    .contrast { padding: 14px; border: 1px solid var(--cp-border); border-radius: .625rem; background: var(--cp-surface-soft); }
    .contrast strong { display: block; margin-top: 5px; font-size: 1.3rem; }
    .chart-links { display: grid; gap: 8px; padding-left: 20px; }
    footer { margin-top: 42px; padding-top: 18px; border-top: 1px solid var(--cp-border); color: var(--cp-text-muted); font-size: .82rem; }
    .mono { font-family: Consolas, "Courier New", Courier, monospace; }
    @media (max-width: 820px) {
      .card { grid-column: span 6; }
      .contrast-grid { grid-template-columns: repeat(2, 1fr); }
    }
    @media (max-width: 560px) {
      .shell { width: min(100% - 20px, 1180px); padding-top: 20px; }
      .card { grid-column: 1 / -1; }
      .contrast-grid { grid-template-columns: 1fr; }
      .funnel-row { grid-template-columns: 110px 1fr 52px; }
    }
  </style>
</head>
<body>
  <main class="shell">
    <div class="eyebrow">Semantic corpus benchmark / ${summary.execution.randomizedCompleteBlocks} blocks / ${summary.execution.scheduledUnits} units</div>
    <h1>${htmlEscape(headline)}</h1>
    <p class="lead">A5 moved work out of the GPT parent's context and reduced credits, but total model tokens, latency, behavioral quality, and strict reliability were worse.</p>
    <aside class="evidence" aria-label="Evidence limitations"><p><strong>Evidence boundary:</strong> ${htmlEscape(summary.limitations.join(" "))}</p></aside>
    <div class="verdict">
      <div class="verdict-mark" aria-hidden="true">!</div>
      <div><strong>Combined efficiency signal: ${htmlEscape(verdict)}</strong><p>The three efficiency thresholds passed, but the preregistered signal also required every quality floor.</p></div>
    </div>

    <nav class="tabs" role="tablist" aria-label="Dashboard views">
      <button class="tab" id="tab-overview" role="tab" aria-selected="true" aria-controls="overview" tabindex="0">Executive view</button>
      <button class="tab" id="tab-reliability" role="tab" aria-selected="false" aria-controls="reliability" tabindex="-1">Reliability</button>
      <button class="tab" id="tab-arms" role="tab" aria-selected="false" aria-controls="arms" tabindex="-1">All arms</button>
      <button class="tab" id="tab-thresholds" role="tab" aria-selected="false" aria-controls="thresholds" tabindex="-1">Thresholds</button>
    </nav>

    <section id="overview" role="tabpanel" aria-labelledby="tab-overview">
      <div class="grid">
        ${metricCard("AI credits vs A1", signedPercent(a1.percentChange), "good", "A5 used fewer credits than GPT inline.")}
        ${metricCard("Parent cumulative input vs A1", signedPercent(parent.percentChange), "good", "The parent-side context boundary worked.")}
        ${metricCard("Total model tokens vs A1", signedPercent(tokens.percentChange), "bad", "Context moved into a longer worker loop; it did not disappear.")}
        ${metricCard("Wall time vs A1", signedPercent(wall.percentChange), "bad", "Delegation and worker iteration increased latency.")}
        ${metricCard("Path coverage vs A1", signedPoints(path.meanDifference), "bad", "A5 exercised fewer migration paths.")}
        ${metricCard("Mutant kill vs A1", signedPoints(mutant.meanDifference), "bad", "A5 detected substantially fewer hidden faults.")}
      </div>
      <div class="section-head"><h2>Static chart fallbacks</h2><p>These SVGs render directly on GitHub and carry the same canonical values.</p></div>
      <div class="card wide">
        <ul class="chart-links">
          <li><a href="v5-charts/a5-vs-a1-tradeoffs.svg">A5 versus A1 efficiency and context tradeoffs</a></li>
          <li><a href="v5-charts/all-arm-comparison.svg">All-arm reliability, quality, credits, tokens, and wall comparison</a></li>
          <li><a href="v5-charts/a5-reliability-funnel.svg">A5 reliability funnel and failure anatomy</a></li>
        </ul>
      </div>
    </section>

    <section id="reliability" role="tabpanel" aria-labelledby="tab-reliability" hidden>
      <div class="grid">
        <article class="card wide">
          <h2>A5 reliability funnel</h2>
          <div class="funnel">
            <div class="funnel-row"><span>Started</span><div class="track"><div class="fill" style="--value: ${a5.flow.started / 12 * 100}"></div></div><strong>${count(a5.flow.started)}</strong></div>
            <div class="funnel-row"><span>Operational</span><div class="track"><div class="fill" style="--value: ${a5.flow.operationallySuccessful / 12 * 100}"></div></div><strong>${count(a5.flow.operationallySuccessful)}</strong></div>
            <div class="funnel-row"><span>Adherent</span><div class="track"><div class="fill" style="--value: ${a5.flow.treatmentAdherent / 12 * 100}"></div></div><strong>${count(a5.flow.treatmentAdherent)}</strong></div>
            <div class="funnel-row"><span>Strict success</span><div class="track"><div class="fill" style="--value: ${a5.flow.successfulDisposition / 12 * 100}"></div></div><strong>${count(a5.flow.successfulDisposition)}</strong></div>
          </div>
        </article>
        <article class="card wide">
          <h2>Main failure categories</h2>
          <ul class="failures">${failureRows}</ul>
          <p>Categories can overlap within a run. Partial authenticated snapshots remain in the intent-to-treat analysis.</p>
        </article>
      </div>
    </section>

    <section id="arms" role="tabpanel" aria-labelledby="tab-arms" hidden>
      <div class="section-head"><h2>All six arms</h2><p>A0 was the practical winner for this fully specified task; A5 is highlighted.</p></div>
      <div class="card wide table-wrap">
        <table>
          <thead><tr><th scope="col">Arm</th><th scope="col">Strict</th><th scope="col">Operational</th><th scope="col">Credits</th><th scope="col">Path</th><th scope="col">Mutant kill</th><th scope="col">Model tokens</th><th scope="col">Wall</th></tr></thead>
          <tbody>${armRows}</tbody>
        </table>
      </div>
      <div class="section-head">
        <div><h2>Inspect A5 against a comparator</h2><p>Quality values are percentage-point differences. Efficiency values are percent changes.</p></div>
      </div>
      <div class="comparison-controls"><label for="comparator">Comparator</label><select id="comparator">${summary.targetContrasts.map((item) => `<option value="A${item.referenceArm}"${item.referenceArm === 1 ? " selected" : ""}>${htmlEscape(shortLabels[item.referenceArm])}</option>`).join("")}</select></div>
      <div id="contrast-grid" class="contrast-grid" aria-live="polite"></div>
    </section>

    <section id="thresholds" role="tabpanel" aria-labelledby="tab-thresholds" hidden>
      <div class="section-head"><h2>Preregistered decision rule: ${htmlEscape(verdict)}</h2><p>Every verdict below is generated from the canonical decision-rule object.</p></div>
      <div class="card wide table-wrap">
        <table>
          <thead><tr><th scope="col">Target</th><th scope="col">Criterion</th><th scope="col">Observed</th><th scope="col">Verdict</th></tr></thead>
          <tbody>${thresholdRows}</tbody>
        </table>
      </div>
    </section>

    <footer>Canonical source: <a href="v5-final-summary.json">v5-final-summary.json</a>. Local, unsigned, descriptive-only evidence; no significance, causal, compliance, or population-generalization claim. Evidence merge <span class="mono">${htmlEscape(summary.generatedFrom.defaultBranchEvidenceMergeCommit)}</span>.</footer>
  </main>
  <script>
    const tabs = [...document.querySelectorAll('[role="tab"]')];
    const panels = [...document.querySelectorAll('[role="tabpanel"]')];
    function activateTab(tab, focus = false) {
      tabs.forEach((item) => {
        const selected = item === tab;
        item.setAttribute("aria-selected", String(selected));
        item.tabIndex = selected ? 0 : -1;
      });
      panels.forEach((panel) => { panel.hidden = panel.id !== tab.getAttribute("aria-controls"); });
      if (focus) tab.focus();
    }
    tabs.forEach((tab, index) => {
      tab.addEventListener("click", () => activateTab(tab));
      tab.addEventListener("keydown", (event) => {
        const keys = ["ArrowLeft", "ArrowRight", "Home", "End"];
        if (!keys.includes(event.key)) return;
        event.preventDefault();
        const next = event.key === "Home" ? 0
          : event.key === "End" ? tabs.length - 1
          : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
        activateTab(tabs[next], true);
      });
    });
    const contrasts = ${JSON.stringify(contrastData)};
    const comparator = document.getElementById("comparator");
    const contrastGrid = document.getElementById("contrast-grid");
    function renderContrasts() {
      contrastGrid.replaceChildren(...contrasts[comparator.value].map(([label, value, className]) => {
        const item = document.createElement("div");
        item.className = "contrast";
        const name = document.createElement("span");
        name.className = "metric-label";
        name.textContent = label;
        const result = document.createElement("strong");
        result.className = className;
        result.textContent = value;
        item.append(name, result);
        return item;
      }));
    }
    comparator.addEventListener("change", renderContrasts);
    renderContrasts();
  </script>
</body>
</html>
`;
}

function svgDocument({ width, height, title, description, body }) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title description">
  <title id="title">${xmlEscape(title)}</title>
  <desc id="description">${xmlEscape(description)}</desc>
  <style>
    text { font-family: "Segoe UI", Aptos, Calibri, sans-serif; fill: #242424; }
    .title { font-size: 26px; font-weight: 700; }
    .subtitle { font-size: 14px; fill: #5c5c5c; }
    .label { font-size: 14px; font-weight: 600; }
    .value { font-size: 14px; font-weight: 700; }
    .small { font-size: 12px; fill: #5c5c5c; }
    .good { fill: #16a34a; }
    .bad { fill: #dc2626; }
    .neutral { fill: #5c5c5c; }
    .track { fill: #f5f5f5; stroke: #919191; }
    .accent { fill: #b11f4b; }
    .line { stroke: #dedede; }
  </style>
  <rect width="${width}" height="${height}" fill="#f7f4ef"/>
${body}
</svg>
`;
}

function renderTradeoffs(summary) {
  const rows = [
    ["AI credits", contrast(summary, 1, "totalAiCredits").percentChange, "%"],
    ["Parent cumulative input", contrast(summary, 1, "parentCumulativeInputTokens").percentChange, "%"],
    ["Total model tokens", contrast(summary, 1, "totalModelTokens").percentChange, "%"],
    ["Wall time", contrast(summary, 1, "wallMs").percentChange, "%"],
    ["Path coverage", contrast(summary, 1, "pathCoverage").meanDifference * 100, "pp"],
    ["Mutant kill", contrast(summary, 1, "mutantKillRate").meanDifference * 100, "pp"]
  ];
  const max = 100;
  const center = 540;
  const scale = 4;
  const body = rows.map(([label, value, unit], index) => {
    const y = 130 + index * 62;
    const width = Math.min(Math.abs(value), max) * scale;
    const x = value < 0 ? center - width : center;
    const className = (unit === "%" ? value < 0 : value > 0) ? "good" : "bad";
    const formatted = `${value > 0 ? "+" : ""}${fixed(value, 1)}${unit}`;
    return `  <text x="28" y="${y + 5}" class="label">${xmlEscape(label)}</text>
  <rect x="140" y="${y - 15}" width="800" height="28" rx="6" class="track"/>
  <rect x="${x}" y="${y - 15}" width="${width}" height="28" rx="4" class="${className}"/>
  <text x="${value < 0 ? x - 10 : x + width + 10}" y="${y + 5}" text-anchor="${value < 0 ? "end" : "start"}" class="value">${xmlEscape(formatted)}</text>`;
  }).join("\n");
  return svgDocument({
    width: 980,
    height: 540,
    title: "A5 versus A1 efficiency and context tradeoffs",
    description: `A5 changed credits by ${signedPercent(rows[0][1])}, parent input by ${signedPercent(rows[1][1])}, total model tokens by ${signedPercent(rows[2][1])}, wall time by ${signedPercent(rows[3][1])}, path coverage by ${signedPoints(rows[4][1] / 100)}, and mutant kill by ${signedPoints(rows[5][1] / 100)} versus A1.`,
    body: `  <text x="28" y="42" class="title">A5 vs A1: cheaper parent, larger system</text>
  <text x="28" y="68" class="subtitle">Left is lower; right is higher. Quality rows use percentage points.</text>
  <line x1="${center}" y1="94" x2="${center}" y2="492" stroke="#919191" stroke-width="2"/>
  <text x="${center - 10}" y="92" text-anchor="end" class="small">lower</text>
  <text x="${center + 10}" y="92" class="small">higher</text>
${body}
  <text x="28" y="520" class="small">Source: v5-final-summary.json. Local, unsigned, descriptive-only.</text>`
  });
}

function renderAllArms(summary) {
  const columns = [
    ["Strict", (arm) => count(arm.flow.successfulDisposition)],
    ["Path", (arm) => percent(arm.endpointStatistics.pathCoverage.mean)],
    ["Mutant", (arm) => percent(arm.endpointStatistics.mutantKillRate.mean)],
    ["Credits", (arm) => fixed(arm.endpointStatistics.totalAiCredits.mean, 2)],
    ["Tokens", (arm) => `${fixed(arm.endpointStatistics.totalModelTokens.mean / 1000, 1)}k`],
    ["Wall", (arm) => `${fixed(arm.endpointStatistics.wallMs.mean / 1000, 1)}s`]
  ];
  const header = columns.map(([label], index) =>
    `  <text x="${430 + index * 100}" y="108" text-anchor="end" class="label">${xmlEscape(label)}</text>`
  ).join("\n");
  const rows = summary.arms.map((arm, index) => {
    const y = 155 + index * 58;
    const values = columns.map(([, format], column) =>
      `  <text x="${430 + column * 100}" y="${y}" text-anchor="end" class="value">${xmlEscape(format(arm))}</text>`
    ).join("\n");
    return `  <rect x="24" y="${y - 30}" width="922" height="44" rx="6" fill="${arm.armId === 5 ? "#f7e8ed" : "#ffffff"}" stroke="#dedede"/>
  <text x="42" y="${y}" class="label">${xmlEscape(shortLabels[arm.armId])}</text>
${values}`;
  }).join("\n");
  const description = summary.arms.map((arm) =>
    `${shortLabels[arm.armId]}: strict ${count(arm.flow.successfulDisposition)}, path ${percent(arm.endpointStatistics.pathCoverage.mean)}, mutant ${percent(arm.endpointStatistics.mutantKillRate.mean)}, credits ${fixed(arm.endpointStatistics.totalAiCredits.mean, 2)}, tokens ${fixed(arm.endpointStatistics.totalModelTokens.mean / 1000, 1)} thousand, wall ${fixed(arm.endpointStatistics.wallMs.mean / 1000, 1)} seconds.`
  ).join(" ");
  return svgDocument({
    width: 980,
    height: 550,
    title: "All-arm reliability, quality, credits, tokens, and wall comparison",
    description,
    body: `  <text x="28" y="42" class="title">All six protocol-v5 arms</text>
  <text x="28" y="68" class="subtitle">Mean endpoint values across 12 complete randomized blocks; A5 is highlighted.</text>
${header}
${rows}
  <text x="28" y="525" class="small">Source: v5-final-summary.json. Local, unsigned, descriptive-only.</text>`
  });
}

function renderFunnel(summary) {
  const arm = summary.arms[5];
  const funnel = [
    ["Started", arm.flow.started],
    ["Operational", arm.flow.operationallySuccessful],
    ["Treatment-adherent", arm.flow.treatmentAdherent],
    ["Strict success", arm.flow.successfulDisposition]
  ];
  const funnelRows = funnel.map(([label, value], index) => {
    const y = 132 + index * 66;
    return `  <text x="28" y="${y + 6}" class="label">${xmlEscape(label)}</text>
  <rect x="190" y="${y - 16}" width="340" height="30" rx="6" class="track"/>
  <rect x="190" y="${y - 16}" width="${340 * value / 12}" height="30" rx="6" class="accent"/>
  <text x="548" y="${y + 6}" class="value">${count(value)}</text>`;
  }).join("\n");
  const failures = Object.entries(arm.failureCategories)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
  const failureRows = failures.map(([label, value], index) => {
    const y = 148 + index * 64;
    return `  <text x="640" y="${y}" class="label">${xmlEscape(label)}</text>
  <rect x="760" y="${y - 20}" width="150" height="26" rx="6" class="track"/>
  <rect x="760" y="${y - 20}" width="${150 * value / 12}" height="26" rx="6" class="bad"/>
  <text x="926" y="${y}" class="value">${count(value)}</text>`;
  }).join("\n");
  return svgDocument({
    width: 980,
    height: 470,
    title: "A5 reliability funnel and main failure anatomy",
    description: `A5 started ${count(arm.flow.started)}, was operational in ${count(arm.flow.operationallySuccessful)}, treatment-adherent in ${count(arm.flow.treatmentAdherent)}, and strictly successful in ${count(arm.flow.successfulDisposition)}. Failure categories were ${failures.map(([name, value]) => `${name} ${count(value)}`).join(", ")}. Categories can overlap.`,
    body: `  <text x="28" y="42" class="title">A5 reliability collapsed after operational execution</text>
  <text x="28" y="68" class="subtitle">Funnel counts and overlapping failure categories across 12 runs.</text>
  <text x="28" y="96" class="label">Reliability funnel</text>
  <text x="640" y="96" class="label">Failure anatomy</text>
${funnelRows}
${failureRows}
  <text x="28" y="446" class="small">Source: v5-final-summary.json. Partial authenticated snapshots remain in ITT.</text>`
  });
}

export function generateVisualization() {
  const summary = readSummary();
  return {
    summary,
    files: new Map([
      [outputs.dashboard, Buffer.from(renderDashboard(summary), "utf8")],
      [outputs.tradeoffs, Buffer.from(renderTradeoffs(summary), "utf8")],
      [outputs.arms, Buffer.from(renderAllArms(summary), "utf8")],
      [outputs.funnel, Buffer.from(renderFunnel(summary), "utf8")]
    ])
  };
}

function writeOrCheck(check) {
  const { files } = generateVisualization();
  for (const [path, bytes] of files) {
    if (check) {
      assert.ok(readFileSync(path).equals(bytes), `${path} is stale; run npm run visualize:v5`);
      continue;
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes("--check");
  writeOrCheck(check);
  console.log(check
    ? "Protocol-v5 visualization is byte-for-byte current."
    : "Generated protocol-v5 dashboard and SVG charts.");
}
