const starter = (exportName) => `"use strict";

function ${exportName}(input) {
  throw new Error("Not implemented");
}

module.exports = { ${exportName} };
`;

function defineTask(value) {
  return Object.freeze({
    ...value,
    candidate: Object.freeze({
      ...value.candidate,
      starter: starter(value.exportName)
    })
  });
}

export const tasks = Object.freeze([
  defineTask({
    id: "P11",
    phase: "pilot",
    category: "structured-text-parsing",
    exportName: "parseAllocationSpec",
    candidate: {
      title: "Allocation specification parser",
      requirements: `Implement parseAllocationSpec(text) in src/feature.js.

The input is UTF-8 text containing allocation records. Ignore blank lines and lines whose
first nonspace character is "#". Every other line has exactly three pipe-delimited fields:
ACCOUNT | AMOUNT | TAGS. ACCOUNT is trimmed, must match [A-Z][A-Z0-9_-]{2,11}, and must
be unique. AMOUNT is a positive decimal with exactly two fractional digits and must convert
to safe integer cents without rounding. TAGS is a comma-separated nonempty list of unique
lowercase identifiers matching [a-z][a-z0-9-]*; trim around individual tags but preserve
their source order.

Return { allocations, totalCents }. Each allocation is
{ line, account, amountCents, tags }, where line is the one-based physical line number.
Reject malformed records, duplicates, unsafe totals, invalid text types, and CR-only line
endings with descriptive TypeErrors. Do not read files or use packages.`,
      changedFiles: ["src/feature.js"],
      nearbyTests: ["test/conventions.test.js"],
      targetTest: "test/feature.test.js"
    },
    gold: `"use strict";
function parseAllocationSpec(text) {
  if (typeof text !== "string") throw new TypeError("text must be a string");
  if (/\\r(?!\\n)/u.test(text)) throw new TypeError("CR-only line ending");
  const allocations = [];
  const accounts = new Set();
  let totalCents = 0;
  text.split(/\\r?\\n/u).forEach((source, index) => {
    if (source.trim() === "" || source.trimStart().startsWith("#")) return;
    const fields = source.split("|");
    if (fields.length !== 3) throw new TypeError("record must contain three fields");
    const account = fields[0].trim();
    if (!/^[A-Z][A-Z0-9_-]{2,11}$/u.test(account)) throw new TypeError("invalid account");
    if (accounts.has(account)) throw new TypeError("duplicate account");
    accounts.add(account);
    const amount = fields[1].trim();
    if (!/^\\d+\\.\\d{2}$/u.test(amount)) throw new TypeError("invalid amount");
    const amountCents = Number(amount.replace(".", ""));
    if (!Number.isSafeInteger(amountCents) || amountCents <= 0) throw new TypeError("invalid amount");
    const rawTags = fields[2].split(",").map((tag) => tag.trim());
    if (!rawTags.length || rawTags.some((tag) => !/^[a-z][a-z0-9-]*$/u.test(tag))
      || new Set(rawTags).size !== rawTags.length) throw new TypeError("invalid or duplicate tag");
    totalCents += amountCents;
    if (!Number.isSafeInteger(totalCents)) throw new TypeError("unsafe total");
    allocations.push({ line: index + 1, account, amountCents, tags: rawTags });
  });
  return { allocations, totalCents };
}
module.exports = { parseAllocationSpec };
`,
    hiddenCases: [
      { name: "comments and physical lines", input: "# heading\r\n\r\n OPS_1 | 12.30 | qa, core \r\nDEV-2|0.70|edge", expected: { allocations: [{ line: 3, account: "OPS_1", amountCents: 1230, tags: ["qa", "core"] }, { line: 4, account: "DEV-2", amountCents: 70, tags: ["edge"] }], totalCents: 1300 } },
      { name: "duplicate account", input: "OPS|1.00|a\nOPS|2.00|b", error: "duplicate account" },
      { name: "fraction precision", input: "OPS|1.2|a", error: "amount" },
      { name: "duplicate tag", input: "OPS|1.00|a,a", error: "duplicate tag" },
      { name: "cr only", input: "OPS|1.00|a\rDEV|2.00|b", error: "CR-only" }
    ],
    mutants: [
      { id: "physical-line-zero-based", find: "line: index + 1", replace: "line: index" },
      { id: "allow-rounded-amount", find: "if (!/^\\d+\\.\\d{2}$/u.test(amount))", replace: "if (!/^\\d+(?:\\.\\d+)?$/u.test(amount))" },
      { id: "ignore-account-duplicates", find: "if (accounts.has(account)) throw new TypeError(\"duplicate account\");", replace: "" },
      { id: "sort-tags", find: "tags: rawTags", replace: "tags: rawTags.sort()" }
    ]
  }),
  defineTask({
    id: "P12",
    phase: "pilot",
    category: "pricing-calculation",
    exportName: "quoteProtection",
    candidate: {
      title: "Multi-year protection quote",
      requirements: `Implement quoteProtection(input) in src/feature.js.

Input contains deviceValueCents, termYears, deviceAgeMonths, riskBand, deductibleCents,
and optional loyaltyBasisPoints (default 0). Money fields are safe nonnegative integers,
deviceValueCents is positive, termYears is 1 through 5, age is 0 through 120, riskBand is
"low", "standard", or "high", deductible cannot exceed device value, and loyalty is
0 through 2000.

Year-one gross premium is Math.round(deviceValueCents * risk rate / 10000), using rates
800, 1150, and 1600 basis points. Add an age surcharge of 1200 cents at 36-71 months or
2500 cents at 72+ months. Subtract Math.floor(gross * loyalty / 10000), then subtract the
deductible, clamping the net premium at zero. Each later year's gross base is the previous
year's gross base increased by 5% with Math.round; surcharge, loyalty, and deductible are
then applied again. Return { years, totalCents }, with year records containing year,
grossCents, loyaltyDiscountCents, deductibleCents, and premiumCents. Do not mutate input.`,
      changedFiles: ["src/feature.js"],
      nearbyTests: ["test/conventions.test.js"],
      targetTest: "test/feature.test.js"
    },
    gold: `"use strict";
const rates = { low: 800, standard: 1150, high: 1600 };
function integer(value, name, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new TypeError("invalid " + name);
}
function quoteProtection(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError("invalid input");
  integer(input.deviceValueCents, "deviceValueCents", 1, Number.MAX_SAFE_INTEGER);
  integer(input.termYears, "termYears", 1, 5);
  integer(input.deviceAgeMonths, "deviceAgeMonths", 0, 120);
  integer(input.deductibleCents, "deductibleCents", 0, input.deviceValueCents);
  const loyalty = input.loyaltyBasisPoints ?? 0;
  integer(loyalty, "loyaltyBasisPoints", 0, 2000);
  if (!Object.hasOwn(rates, input.riskBand)) throw new TypeError("invalid riskBand");
  const surcharge = input.deviceAgeMonths >= 72 ? 2500 : input.deviceAgeMonths >= 36 ? 1200 : 0;
  let base = Math.round(input.deviceValueCents * rates[input.riskBand] / 10000);
  const years = [];
  let totalCents = 0;
  for (let year = 1; year <= input.termYears; year += 1) {
    if (year > 1) base = Math.round(base * 10500 / 10000);
    const grossCents = base + surcharge;
    const loyaltyDiscountCents = Math.floor(grossCents * loyalty / 10000);
    const premiumCents = Math.max(0, grossCents - loyaltyDiscountCents - input.deductibleCents);
    years.push({ year, grossCents, loyaltyDiscountCents, deductibleCents: input.deductibleCents, premiumCents });
    totalCents += premiumCents;
    if (!Number.isSafeInteger(totalCents)) throw new TypeError("unsafe total");
  }
  return { years, totalCents };
}
module.exports = { quoteProtection };
`,
    hiddenCases: [
      { name: "standard two year quote", input: { deviceValueCents: 100000, termYears: 2, deviceAgeMonths: 40, riskBand: "standard", deductibleCents: 2000, loyaltyBasisPoints: 1000 }, expected: { years: [{ year: 1, grossCents: 12700, loyaltyDiscountCents: 1270, deductibleCents: 2000, premiumCents: 9430 }, { year: 2, grossCents: 13275, loyaltyDiscountCents: 1327, deductibleCents: 2000, premiumCents: 9948 }], totalCents: 19378 } },
      { name: "deductible clamps", input: { deviceValueCents: 10000, termYears: 1, deviceAgeMonths: 0, riskBand: "low", deductibleCents: 10000 }, expected: { years: [{ year: 1, grossCents: 800, loyaltyDiscountCents: 0, deductibleCents: 10000, premiumCents: 0 }], totalCents: 0 } },
      { name: "old device surcharge", input: { deviceValueCents: 20000, termYears: 1, deviceAgeMonths: 72, riskBand: "high", deductibleCents: 0 }, expected: { years: [{ year: 1, grossCents: 5700, loyaltyDiscountCents: 0, deductibleCents: 0, premiumCents: 5700 }], totalCents: 5700 } },
      { name: "invalid risk", input: { deviceValueCents: 1, termYears: 1, deviceAgeMonths: 0, riskBand: "extreme", deductibleCents: 0 }, error: "riskBand" },
      { name: "deductible too large", input: { deviceValueCents: 100, termYears: 1, deviceAgeMonths: 0, riskBand: "low", deductibleCents: 101 }, error: "deductible" }
    ],
    mutants: [
      { id: "loyalty-rounds", find: "Math.floor(grossCents * loyalty / 10000)", replace: "Math.round(grossCents * loyalty / 10000)" },
      { id: "no-premium-clamp", find: "Math.max(0, grossCents - loyaltyDiscountCents - input.deductibleCents)", replace: "grossCents - loyaltyDiscountCents - input.deductibleCents" },
      { id: "flat-later-years", find: "if (year > 1) base = Math.round(base * 10500 / 10000);", replace: "" },
      { id: "age-boundary-late", find: "input.deviceAgeMonths >= 72", replace: "input.deviceAgeMonths > 72" }
    ]
  }),
  defineTask({
    id: "P13",
    phase: "pilot",
    category: "event-reduction",
    exportName: "reduceReview",
    candidate: {
      title: "Document review event reducer",
      requirements: `Implement reduceReview(initial, events) in src/feature.js.

Initial is { state, version, updatedAt, processedEventIds, assignee, severity, resolution }.
State is open, triaged, resolved, or closed; version is nonnegative; updatedAt is an ISO
instant; processedEventIds contains unique nonempty strings. Events contain id, type, at
and optional fields. Previously processed IDs are ignored before validating other event
fields. A new ID repeated within this batch is an error. New timestamps cannot move
backward.

Legal operations are: open + assign (nonblank assignee) remains open; open + triage
(severity low/medium/high) becomes triaged; triaged + resolve (nonblank resolution)
becomes resolved; resolved + reopen becomes triaged and clears resolution; resolved +
close becomes closed. Each accepted event appends its ID, updates updatedAt, and increments
version. Preserve unknown initial properties, return fresh arrays/objects, and do not mutate
inputs. Reject malformed initial state, events, timestamps, or illegal transitions.`,
      changedFiles: ["src/feature.js"],
      nearbyTests: ["test/conventions.test.js"],
      targetTest: "test/feature.test.js"
    },
    gold: `"use strict";
const states = new Set(["open", "triaged", "resolved", "closed"]);
function instant(value) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new TypeError("invalid timestamp");
  return Date.parse(value);
}
function reduceReview(initial, events) {
  if (!initial || typeof initial !== "object" || !states.has(initial.state)
    || !Number.isSafeInteger(initial.version) || initial.version < 0
    || !Array.isArray(initial.processedEventIds)
    || initial.processedEventIds.some((id) => typeof id !== "string" || !id)
    || new Set(initial.processedEventIds).size !== initial.processedEventIds.length) throw new TypeError("invalid initial");
  if (!Array.isArray(events)) throw new TypeError("events must be an array");
  let result = { ...initial, processedEventIds: [...initial.processedEventIds] };
  let time = instant(initial.updatedAt);
  const old = new Set(initial.processedEventIds);
  const seen = new Set(initial.processedEventIds);
  for (const event of events) {
    if (!event || typeof event.id !== "string" || !event.id) throw new TypeError("invalid event id");
    if (old.has(event.id)) continue;
    if (seen.has(event.id)) throw new Error("duplicate new event");
    seen.add(event.id);
    const eventTime = instant(event.at);
    if (eventTime < time) throw new Error("timestamp moved backward");
    if (result.state === "open" && event.type === "assign") {
      if (typeof event.assignee !== "string" || !event.assignee.trim()) throw new TypeError("invalid assignee");
      result.assignee = event.assignee;
    } else if (result.state === "open" && event.type === "triage") {
      if (!["low", "medium", "high"].includes(event.severity)) throw new TypeError("invalid severity");
      result.state = "triaged"; result.severity = event.severity;
    } else if (result.state === "triaged" && event.type === "resolve") {
      if (typeof event.resolution !== "string" || !event.resolution.trim()) throw new TypeError("invalid resolution");
      result.state = "resolved"; result.resolution = event.resolution;
    } else if (result.state === "resolved" && event.type === "reopen") {
      result.state = "triaged"; result.resolution = null;
    } else if (result.state === "resolved" && event.type === "close") result.state = "closed";
    else throw new Error("illegal transition");
    result.version += 1; result.updatedAt = event.at; time = eventTime; result.processedEventIds.push(event.id);
  }
  return result;
}
module.exports = { reduceReview };
`,
    hiddenCases: [
      { name: "complete workflow", input: [{ state: "open", version: 2, updatedAt: "2026-01-01T00:00:00Z", processedEventIds: [], assignee: null, severity: null, resolution: null, owner: "team-a" }, [{ id: "a", type: "assign", assignee: "sam", at: "2026-01-01T00:00:00Z" }, { id: "b", type: "triage", severity: "high", at: "2026-01-02T00:00:00Z" }, { id: "c", type: "resolve", resolution: "fixed", at: "2026-01-03T00:00:00Z" }]], spread: true, expected: { state: "resolved", version: 5, updatedAt: "2026-01-03T00:00:00Z", processedEventIds: ["a", "b", "c"], assignee: "sam", severity: "high", resolution: "fixed", owner: "team-a" } },
      { name: "old event ignored first", input: [{ state: "open", version: 1, updatedAt: "2026-01-02T00:00:00Z", processedEventIds: ["old"], assignee: null, severity: null, resolution: null }, [{ id: "old", type: "bogus", at: "bad" }]], spread: true, expected: { state: "open", version: 1, updatedAt: "2026-01-02T00:00:00Z", processedEventIds: ["old"], assignee: null, severity: null, resolution: null } },
      { name: "same batch duplicate", input: [{ state: "open", version: 0, updatedAt: "2026-01-01T00:00:00Z", processedEventIds: [], assignee: null, severity: null, resolution: null }, [{ id: "x", type: "assign", assignee: "a", at: "2026-01-01T00:00:00Z" }, { id: "x", type: "triage", severity: "low", at: "2026-01-01T00:00:00Z" }]], spread: true, error: "duplicate" },
      { name: "reopen clears resolution", input: [{ state: "resolved", version: 1, updatedAt: "2026-01-01T00:00:00Z", processedEventIds: [], assignee: "a", severity: "medium", resolution: "done" }, [{ id: "r", type: "reopen", at: "2026-01-02T00:00:00Z" }]], spread: true, expected: { state: "triaged", version: 2, updatedAt: "2026-01-02T00:00:00Z", processedEventIds: ["r"], assignee: "a", severity: "medium", resolution: null } },
      { name: "timestamp regression", input: [{ state: "open", version: 0, updatedAt: "2026-01-02T00:00:00Z", processedEventIds: [], assignee: null, severity: null, resolution: null }, [{ id: "x", type: "assign", assignee: "a", at: "2026-01-01T00:00:00Z" }]], spread: true, error: "timestamp" }
    ],
    mutants: [
      { id: "ignore-new-duplicates", find: "if (seen.has(event.id)) throw new Error(\"duplicate new event\");", replace: "if (seen.has(event.id)) continue;" },
      { id: "allow-time-regression", find: "if (eventTime < time) throw new Error(\"timestamp moved backward\");", replace: "" },
      { id: "reopen-keeps-resolution", find: "result.state = \"triaged\"; result.resolution = null;", replace: "result.state = \"triaged\";" },
      { id: "drop-extra-properties", find: "let result = { ...initial, processedEventIds: [...initial.processedEventIds] };", replace: "let result = { state: initial.state, version: initial.version, updatedAt: initial.updatedAt, processedEventIds: [...initial.processedEventIds] };" }
    ]
  }),
  defineTask({
    id: "M11",
    phase: "main",
    category: "capacity-allocation",
    exportName: "allocateCapacity",
    candidate: {
      title: "Priority capacity allocator",
      requirements: `Implement allocateCapacity(input) in src/feature.js.

Input has capacity (a nonnegative safe integer) and requests. Each request has a unique
nonblank id, integer priority from 0 through 9, positive requested units, nonnegative
minimum units not exceeding requested units, and optional group (default "default").
Process requests by descending priority, then source order. A request receives zero when
remaining capacity is below its minimum; otherwise it receives min(requested, remaining).
Group totals are accumulated for allocations greater than zero.

Return { allocations, groupTotals, used, remaining }. allocations must be in original
source order and contain { id, requested, minimum, allocated, shortfall, priority, group }.
groupTotals is a null-prototype object with keys inserted when first allocated in processing
order. Validate overflow, duplicate IDs, malformed groups, and all numeric fields. Do not
mutate the input or sort its requests array in place.`,
      changedFiles: ["src/feature.js"],
      nearbyTests: ["test/conventions.test.js"],
      targetTest: "test/feature.test.js"
    },
    gold: `"use strict";
function nat(value, name, min, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new TypeError("invalid " + name);
}
function allocateCapacity(input) {
  if (!input || typeof input !== "object" || !Array.isArray(input.requests)) throw new TypeError("invalid input");
  nat(input.capacity, "capacity", 0);
  const ids = new Set();
  const prepared = input.requests.map((request, index) => {
    if (!request || typeof request.id !== "string" || !request.id.trim() || ids.has(request.id)) throw new TypeError("invalid or duplicate id");
    ids.add(request.id);
    nat(request.priority, "priority", 0, 9);
    nat(request.requested, "requested", 1);
    nat(request.minimum, "minimum", 0, request.requested);
    const group = request.group ?? "default";
    if (typeof group !== "string" || !group.trim()) throw new TypeError("invalid group");
    return { ...request, group, index };
  });
  const processing = [...prepared].sort((a, b) => b.priority - a.priority || a.index - b.index);
  const allocated = new Map(); const groupTotals = Object.create(null);
  let remaining = input.capacity;
  for (const request of processing) {
    const amount = remaining < request.minimum ? 0 : Math.min(request.requested, remaining);
    allocated.set(request.id, amount); remaining -= amount;
    if (amount > 0) {
      groupTotals[request.group] = (groupTotals[request.group] ?? 0) + amount;
      if (!Number.isSafeInteger(groupTotals[request.group])) throw new TypeError("group total overflow");
    }
  }
  const allocations = prepared.map((request) => ({
    id: request.id, requested: request.requested, minimum: request.minimum,
    allocated: allocated.get(request.id), shortfall: request.requested - allocated.get(request.id),
    priority: request.priority, group: request.group
  }));
  return { allocations, groupTotals, used: input.capacity - remaining, remaining };
}
module.exports = { allocateCapacity };
`,
    hiddenCases: [
      { name: "priority and minimum", input: { capacity: 8, requests: [{ id: "a", priority: 1, requested: 5, minimum: 3, group: "x" }, { id: "b", priority: 9, requested: 6, minimum: 6, group: "y" }, { id: "c", priority: 1, requested: 2, minimum: 1, group: "x" }] }, expected: { allocations: [{ id: "a", requested: 5, minimum: 3, allocated: 0, shortfall: 5, priority: 1, group: "x" }, { id: "b", requested: 6, minimum: 6, allocated: 6, shortfall: 0, priority: 9, group: "y" }, { id: "c", requested: 2, minimum: 1, allocated: 2, shortfall: 0, priority: 1, group: "x" }], groupTotals: { y: 6, x: 2 }, used: 8, remaining: 0 } },
      { name: "partial above minimum", input: { capacity: 4, requests: [{ id: "a", priority: 0, requested: 7, minimum: 3 }] }, expected: { allocations: [{ id: "a", requested: 7, minimum: 3, allocated: 4, shortfall: 3, priority: 0, group: "default" }], groupTotals: { default: 4 }, used: 4, remaining: 0 } },
      { name: "source order ties", input: { capacity: 3, requests: [{ id: "a", priority: 2, requested: 3, minimum: 1 }, { id: "b", priority: 2, requested: 3, minimum: 1 }] }, expected: { allocations: [{ id: "a", requested: 3, minimum: 1, allocated: 3, shortfall: 0, priority: 2, group: "default" }, { id: "b", requested: 3, minimum: 1, allocated: 0, shortfall: 3, priority: 2, group: "default" }], groupTotals: { default: 3 }, used: 3, remaining: 0 } },
      { name: "capacity exactly minimum", input: { capacity: 3, requests: [{ id: "a", priority: 0, requested: 5, minimum: 3 }] }, expected: { allocations: [{ id: "a", requested: 5, minimum: 3, allocated: 3, shortfall: 2, priority: 0, group: "default" }], groupTotals: { default: 3 }, used: 3, remaining: 0 } },
      { name: "duplicate id", input: { capacity: 1, requests: [{ id: "a", priority: 0, requested: 1, minimum: 0 }, { id: "a", priority: 1, requested: 1, minimum: 0 }] }, error: "duplicate" },
      { name: "minimum exceeds request", input: { capacity: 1, requests: [{ id: "a", priority: 0, requested: 1, minimum: 2 }] }, error: "minimum" }
    ],
    mutants: [
      { id: "ascending-priority", find: "b.priority - a.priority", replace: "a.priority - b.priority" },
      { id: "ignore-minimum", find: "remaining < request.minimum ? 0 : Math.min(request.requested, remaining)", replace: "Math.min(request.requested, remaining)" },
      { id: "processing-order-output", find: "const allocations = prepared.map", replace: "const allocations = processing.map" },
      { id: "minimum-exclusive", find: "remaining < request.minimum", replace: "remaining <= request.minimum" }
    ]
  }),
  defineTask({
    id: "M12",
    phase: "main",
    category: "metered-billing",
    exportName: "billMeteredUsage",
    candidate: {
      title: "Progressive metered usage billing",
      requirements: `Implement billMeteredUsage(input) in src/feature.js.

Input has units, freeUnits (default 0), tiers, optional subtotalCapCents, and taxBasisPoints
(default 0). units/freeUnits are nonnegative safe integers. tiers is nonempty and strictly
ascending by startUnit; the first startUnit is 1. Each tier has a nonnegative unitCents.
After free units, billable units are charged progressively: a tier charges units from its
start through the unit before the next tier starts. Ignore tiers above billable usage.

Return { units, freeUnitsApplied, billableUnits, lines, uncappedSubtotalCents,
subtotalCents, capDiscountCents, taxCents, totalCents }. Each nonempty line contains
{ startUnit, endUnit, units, unitCents, amountCents }. Apply the optional nonnegative cap
to subtotal, then calculate tax with Math.round. Detect arithmetic overflow, reject
malformed tiers and percentages outside 0..10000, and do not mutate input.`,
      changedFiles: ["src/feature.js"],
      nearbyTests: ["test/conventions.test.js"],
      targetTest: "test/feature.test.js"
    },
    gold: `"use strict";
function nat(value, name, min = 0, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new TypeError("invalid " + name);
}
function billMeteredUsage(input) {
  if (!input || typeof input !== "object" || !Array.isArray(input.tiers) || input.tiers.length === 0) throw new TypeError("invalid input");
  nat(input.units, "units"); const freeUnits = input.freeUnits ?? 0; nat(freeUnits, "freeUnits");
  const taxBasisPoints = input.taxBasisPoints ?? 0; nat(taxBasisPoints, "taxBasisPoints", 0, 10000);
  const cap = input.subtotalCapCents ?? Number.MAX_SAFE_INTEGER; nat(cap, "subtotalCapCents");
  let previous = 0;
  for (const tier of input.tiers) {
    if (!tier || typeof tier !== "object") throw new TypeError("invalid tier");
    nat(tier.startUnit, "startUnit", 1); nat(tier.unitCents, "unitCents");
    if (tier.startUnit <= previous || (previous === 0 && tier.startUnit !== 1)) throw new TypeError("tiers must ascend from one");
    previous = tier.startUnit;
  }
  const freeUnitsApplied = Math.min(input.units, freeUnits);
  const billableUnits = input.units - freeUnitsApplied;
  const lines = []; let uncappedSubtotalCents = 0;
  input.tiers.forEach((tier, index) => {
    const next = input.tiers[index + 1]?.startUnit ?? billableUnits + 1;
    const count = Math.max(0, Math.min(billableUnits + 1, next) - tier.startUnit);
    if (count === 0) return;
    const amountCents = count * tier.unitCents;
    if (!Number.isSafeInteger(amountCents)) throw new TypeError("amount overflow");
    uncappedSubtotalCents += amountCents;
    if (!Number.isSafeInteger(uncappedSubtotalCents)) throw new TypeError("subtotal overflow");
    lines.push({ startUnit: tier.startUnit, endUnit: tier.startUnit + count - 1, units: count, unitCents: tier.unitCents, amountCents });
  });
  const subtotalCents = Math.min(cap, uncappedSubtotalCents);
  const capDiscountCents = uncappedSubtotalCents - subtotalCents;
  const taxCents = Math.round(subtotalCents * taxBasisPoints / 10000);
  return { units: input.units, freeUnitsApplied, billableUnits, lines, uncappedSubtotalCents, subtotalCents, capDiscountCents, taxCents, totalCents: subtotalCents + taxCents };
}
module.exports = { billMeteredUsage };
`,
    hiddenCases: [
      { name: "progressive tiers and free units", input: { units: 16, freeUnits: 2, tiers: [{ startUnit: 1, unitCents: 10 }, { startUnit: 6, unitCents: 7 }, { startUnit: 11, unitCents: 4 }], taxBasisPoints: 750 }, expected: { units: 16, freeUnitsApplied: 2, billableUnits: 14, lines: [{ startUnit: 1, endUnit: 5, units: 5, unitCents: 10, amountCents: 50 }, { startUnit: 6, endUnit: 10, units: 5, unitCents: 7, amountCents: 35 }, { startUnit: 11, endUnit: 14, units: 4, unitCents: 4, amountCents: 16 }], uncappedSubtotalCents: 101, subtotalCents: 101, capDiscountCents: 0, taxCents: 8, totalCents: 109 } },
      { name: "cap before tax", input: { units: 3, tiers: [{ startUnit: 1, unitCents: 100 }], subtotalCapCents: 250, taxBasisPoints: 1000 }, expected: { units: 3, freeUnitsApplied: 0, billableUnits: 3, lines: [{ startUnit: 1, endUnit: 3, units: 3, unitCents: 100, amountCents: 300 }], uncappedSubtotalCents: 300, subtotalCents: 250, capDiscountCents: 50, taxCents: 25, totalCents: 275 } },
      { name: "all usage free", input: { units: 3, freeUnits: 9, tiers: [{ startUnit: 1, unitCents: 5 }] }, expected: { units: 3, freeUnitsApplied: 3, billableUnits: 0, lines: [], uncappedSubtotalCents: 0, subtotalCents: 0, capDiscountCents: 0, taxCents: 0, totalCents: 0 } },
      { name: "bad first tier", input: { units: 1, tiers: [{ startUnit: 2, unitCents: 1 }] }, error: "ascend" },
      { name: "duplicate tier", input: { units: 1, tiers: [{ startUnit: 1, unitCents: 1 }, { startUnit: 1, unitCents: 2 }] }, error: "ascend" }
    ],
    mutants: [
      { id: "whole-volume-rate", find: "const count = Math.max(0, Math.min(billableUnits + 1, next) - tier.startUnit);", replace: "const count = tier.startUnit <= billableUnits && index === input.tiers.findLastIndex((entry) => entry.startUnit <= billableUnits) ? billableUnits : 0;" },
      { id: "tax-before-cap", find: "Math.round(subtotalCents * taxBasisPoints / 10000)", replace: "Math.round(uncappedSubtotalCents * taxBasisPoints / 10000)" },
      { id: "free-units-not-clamped", find: "Math.min(input.units, freeUnits)", replace: "freeUnits" },
      { id: "tier-off-by-one", find: "Math.min(billableUnits + 1, next)", replace: "Math.min(billableUnits, next)" }
    ]
  }),
  defineTask({
    id: "M13",
    phase: "main",
    category: "reconciliation",
    exportName: "reconcileReceipts",
    candidate: {
      title: "Receipt-to-deposit reconciliation",
      requirements: `Implement reconcileReceipts(receipts, deposits, toleranceCents = 0) in
src/feature.js.

Receipts have unique nonblank id, nonblank batch, kind "sale" or "refund", and positive
safe-integer cents. Net each batch as sales minus refunds. Deposits have unique nonblank
id, nonblank batch, and nonnegative safe-integer cents. Multiple deposits for one batch
are not invalid; they form a duplicate-deposit classification and are excluded from
matched/mismatched. toleranceCents is a nonnegative safe integer.

Return { matched, mismatched, missing, unexpected, duplicateDeposits, receiptNetCents,
depositTotalCents }. For receipt batches, classify duplicate deposits first, then missing,
then matched when absolute variance is within tolerance, otherwise mismatched. A deposit
batch with no receipt is unexpected, including all of its lines. Each classification row
must include batch and relevant totals/IDs. Sort arrays by batch and then id where present.
Reject malformed inputs and arithmetic overflow; never mutate inputs.`,
      changedFiles: ["src/feature.js"],
      nearbyTests: ["test/conventions.test.js"],
      targetTest: "test/feature.test.js"
    },
    gold: `"use strict";
function money(value, name, min) {
  if (!Number.isSafeInteger(value) || value < min) throw new TypeError("invalid " + name);
}
function reconcileReceipts(receipts, deposits, toleranceCents = 0) {
  if (!Array.isArray(receipts) || !Array.isArray(deposits)) throw new TypeError("inputs must be arrays");
  money(toleranceCents, "tolerance", 0);
  const receiptIds = new Set(); const nets = new Map(); let receiptNetCents = 0;
  for (const receipt of receipts) {
    if (!receipt || typeof receipt.id !== "string" || !receipt.id.trim() || receiptIds.has(receipt.id)
      || typeof receipt.batch !== "string" || !receipt.batch.trim()
      || !["sale", "refund"].includes(receipt.kind)) throw new TypeError("invalid or duplicate receipt");
    receiptIds.add(receipt.id); money(receipt.cents, "receipt cents", 1);
    const signed = receipt.kind === "sale" ? receipt.cents : -receipt.cents;
    nets.set(receipt.batch, (nets.get(receipt.batch) ?? 0) + signed);
    receiptNetCents += signed;
    if (!Number.isSafeInteger(nets.get(receipt.batch)) || !Number.isSafeInteger(receiptNetCents)) throw new TypeError("receipt overflow");
  }
  const depositIds = new Set(); const byBatch = new Map(); let depositTotalCents = 0;
  for (const deposit of deposits) {
    if (!deposit || typeof deposit.id !== "string" || !deposit.id.trim() || depositIds.has(deposit.id)
      || typeof deposit.batch !== "string" || !deposit.batch.trim()) throw new TypeError("invalid or duplicate deposit");
    depositIds.add(deposit.id); money(deposit.cents, "deposit cents", 0);
    if (!byBatch.has(deposit.batch)) byBatch.set(deposit.batch, []);
    byBatch.get(deposit.batch).push(deposit);
    depositTotalCents += deposit.cents;
    if (!Number.isSafeInteger(depositTotalCents)) throw new TypeError("deposit overflow");
  }
  const result = { matched: [], mismatched: [], missing: [], unexpected: [], duplicateDeposits: [], receiptNetCents, depositTotalCents };
  for (const [batch, receiptCents] of nets) {
    const lines = byBatch.get(batch) ?? [];
    if (lines.length > 1) result.duplicateDeposits.push({ batch, receiptCents, depositIds: lines.map((line) => line.id).sort(), depositCents: lines.reduce((sum, line) => sum + line.cents, 0) });
    else if (lines.length === 0) result.missing.push({ batch, receiptCents });
    else {
      const varianceCents = lines[0].cents - receiptCents;
      const row = { batch, receiptCents, depositId: lines[0].id, depositCents: lines[0].cents, varianceCents };
      result[Math.abs(varianceCents) <= toleranceCents ? "matched" : "mismatched"].push(row);
    }
  }
  for (const [batch, lines] of byBatch) if (!nets.has(batch)) {
    for (const line of lines) result.unexpected.push({ batch, depositId: line.id, depositCents: line.cents });
  }
  for (const key of ["matched", "mismatched", "missing", "unexpected", "duplicateDeposits"]) {
    result[key].sort((a, b) => a.batch.localeCompare(b.batch) || (a.depositId ?? "").localeCompare(b.depositId ?? ""));
  }
  return result;
}
module.exports = { reconcileReceipts };
`,
    hiddenCases: [
      { name: "all classifications", input: [[{ id: "r1", batch: "a", kind: "sale", cents: 1000 }, { id: "r2", batch: "a", kind: "refund", cents: 100 }, { id: "r3", batch: "b", kind: "sale", cents: 500 }, { id: "r4", batch: "c", kind: "sale", cents: 200 }], [{ id: "d1", batch: "a", cents: 905 }, { id: "d2", batch: "c", cents: 100 }, { id: "d3", batch: "c", cents: 100 }, { id: "d4", batch: "z", cents: 9 }], 5], spread: true, expected: { matched: [{ batch: "a", receiptCents: 900, depositId: "d1", depositCents: 905, varianceCents: 5 }], mismatched: [], missing: [{ batch: "b", receiptCents: 500 }], unexpected: [{ batch: "z", depositId: "d4", depositCents: 9 }], duplicateDeposits: [{ batch: "c", receiptCents: 200, depositIds: ["d2", "d3"], depositCents: 200 }], receiptNetCents: 1600, depositTotalCents: 1114 } },
      { name: "negative net mismatch", input: [[{ id: "r", batch: "a", kind: "refund", cents: 100 }], [{ id: "d", batch: "a", cents: 0 }], 0], spread: true, expected: { matched: [], mismatched: [{ batch: "a", receiptCents: -100, depositId: "d", depositCents: 0, varianceCents: 100 }], missing: [], unexpected: [], duplicateDeposits: [], receiptNetCents: -100, depositTotalCents: 0 } },
      { name: "unexpected sorted by id", input: [[], [{ id: "b", batch: "x", cents: 1 }, { id: "a", batch: "x", cents: 2 }]], spread: true, expected: { matched: [], mismatched: [], missing: [], unexpected: [{ batch: "x", depositId: "a", depositCents: 2 }, { batch: "x", depositId: "b", depositCents: 1 }], duplicateDeposits: [], receiptNetCents: 0, depositTotalCents: 3 } },
      { name: "duplicate receipt id", input: [[{ id: "r", batch: "a", kind: "sale", cents: 1 }, { id: "r", batch: "b", kind: "sale", cents: 1 }], []], spread: true, error: "duplicate receipt" },
      { name: "negative deposit", input: [[], [{ id: "d", batch: "a", cents: -1 }]], spread: true, error: "deposit cents" }
    ],
    mutants: [
      { id: "refund-added", find: "receipt.kind === \"sale\" ? receipt.cents : -receipt.cents", replace: "receipt.cents" },
      { id: "exclusive-tolerance", find: "Math.abs(varianceCents) <= toleranceCents", replace: "Math.abs(varianceCents) < toleranceCents" },
      { id: "duplicates-matched", find: "if (lines.length > 1) result.duplicateDeposits.push", replace: "if (lines.length > 2) result.duplicateDeposits.push" },
      { id: "unexpected-unsorted", find: "result[key].sort((a, b) => a.batch.localeCompare(b.batch) || (a.depositId ?? \"\").localeCompare(b.depositId ?? \"\"));", replace: "if (key !== \"unexpected\") result[key].sort((a, b) => a.batch.localeCompare(b.batch));" }
    ]
  }),
  defineTask({
    id: "M14",
    phase: "main",
    category: "dependency-planning",
    exportName: "planBuildLayers",
    candidate: {
      title: "Deterministic dependency build planner",
      requirements: `Implement planBuildLayers(items) in src/feature.js.

items is an array of build units. Each unit has a unique nonblank id, deps (an array of
unique nonblank IDs), and integer priority from -9 through 9. IDs are case-sensitive.
Reject self-dependencies, missing dependency IDs, duplicate IDs/dependencies, and cycles.

Produce dependency layers. A unit belongs to the earliest layer after all of its
dependencies have appeared. Within each layer sort by descending priority and then id
using code-point order. Return { layers, order, dependents }, where layers is an array of
arrays of IDs, order is the flattened layer order, and dependents is a null-prototype
object mapping every ID to its direct dependent IDs sorted by the same priority/id rule.
The planner must be deterministic regardless of input ordering except where priority and
id define the result. Do not mutate item or deps arrays. Error messages for cycles must
contain "cycle" and list all still-blocked IDs in sorted order.`,
      changedFiles: ["src/feature.js"],
      nearbyTests: ["test/conventions.test.js"],
      targetTest: "test/feature.test.js"
    },
    gold: `"use strict";
function planBuildLayers(items) {
  if (!Array.isArray(items)) throw new TypeError("items must be an array");
  const byId = new Map();
  for (const item of items) {
    if (!item || typeof item.id !== "string" || !item.id.trim() || byId.has(item.id)
      || !Array.isArray(item.deps) || !Number.isSafeInteger(item.priority)
      || item.priority < -9 || item.priority > 9) throw new TypeError("invalid or duplicate item");
    if (item.deps.some((dep) => typeof dep !== "string" || !dep.trim())
      || new Set(item.deps).size !== item.deps.length) throw new TypeError("invalid or duplicate dependency");
    byId.set(item.id, { id: item.id, deps: [...item.deps], priority: item.priority });
  }
  for (const item of byId.values()) {
    if (item.deps.includes(item.id)) throw new TypeError("self dependency");
    for (const dep of item.deps) if (!byId.has(dep)) throw new TypeError("missing dependency " + dep);
  }
  const compare = (left, right) => right.priority - left.priority || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  const dependents = Object.create(null);
  for (const id of [...byId.keys()].sort()) dependents[id] = [];
  for (const item of byId.values()) for (const dep of item.deps) dependents[dep].push(item.id);
  for (const ids of Object.values(dependents)) ids.sort((a, b) => compare(byId.get(a), byId.get(b)));
  const remaining = new Set(byId.keys()); const complete = new Set(); const layers = [];
  while (remaining.size > 0) {
    const ready = [...remaining].map((id) => byId.get(id))
      .filter((item) => item.deps.every((dep) => complete.has(dep))).sort(compare);
    if (ready.length === 0) {
      const blocked = [...remaining].sort();
      throw new Error("cycle: " + blocked.join(","));
    }
    layers.push(ready.map((item) => item.id));
    for (const item of ready) { remaining.delete(item.id); complete.add(item.id); }
  }
  return { layers, order: layers.flat(), dependents };
}
module.exports = { planBuildLayers };
`,
    hiddenCases: [
      { name: "layers and tie ordering", input: [{ id: "app", deps: ["lib", "cfg"], priority: 3 }, { id: "cfg", deps: [], priority: 1 }, { id: "lib", deps: ["core"], priority: 8 }, { id: "core", deps: [], priority: 1 }, { id: "docs", deps: [], priority: -1 }], expected: { layers: [["cfg", "core", "docs"], ["lib"], ["app"]], order: ["cfg", "core", "docs", "lib", "app"], dependents: { app: [], cfg: ["app"], core: ["lib"], docs: [], lib: ["app"] } } },
      { name: "priority orders ready units", input: [{ id: "low", deps: [], priority: -2 }, { id: "high", deps: [], priority: 8 }, { id: "mid", deps: [], priority: 0 }], expected: { layers: [["high", "mid", "low"]], order: ["high", "mid", "low"], dependents: { high: [], low: [], mid: [] } } },
      { name: "dependent priority sort", input: [{ id: "root", deps: [], priority: 0 }, { id: "b", deps: ["root"], priority: 2 }, { id: "a", deps: ["root"], priority: 2 }, { id: "z", deps: ["root"], priority: 5 }], expected: { layers: [["root"], ["z", "a", "b"]], order: ["root", "z", "a", "b"], dependents: { a: [], b: [], root: ["z", "a", "b"], z: [] } } },
      { name: "missing dependency", input: [{ id: "a", deps: ["x"], priority: 0 }], error: "missing dependency" },
      { name: "cycle lists blocked", input: [{ id: "b", deps: ["a"], priority: 0 }, { id: "a", deps: ["b"], priority: 0 }], error: "cycle: a,b" }
    ],
    mutants: [
      { id: "ascending-priority", find: "right.priority - left.priority", replace: "left.priority - right.priority" },
      { id: "same-layer-dependencies", find: "for (const item of ready) { remaining.delete(item.id); complete.add(item.id); }", replace: "for (const item of ready) remaining.delete(item.id);" },
      { id: "ignore-missing", find: "for (const dep of item.deps) if (!byId.has(dep)) throw new TypeError(\"missing dependency \" + dep);", replace: "" },
      { id: "dependents-lexical-only", find: "ids.sort((a, b) => compare(byId.get(a), byId.get(b)))", replace: "ids.sort()"}
    ]
  })
]);

export function getTask(id) {
  const task = tasks.find((entry) => entry.id === id);
  if (!task) throw new Error(`unknown task ${id}`);
  return task;
}

export function createMutant(task, mutant) {
  const matches = task.gold.split(mutant.find).length - 1;
  if (matches !== 1) throw new Error(`${task.id}/${mutant.id} expected one mutation site, found ${matches}`);
  return task.gold.replace(mutant.find, mutant.replace);
}
