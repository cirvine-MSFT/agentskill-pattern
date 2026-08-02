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
    id: "P01",
    phase: "pilot",
    category: "pricing-validation",
    exportName: "applyAdjustments",
    candidate: {
      title: "Sequential invoice adjustments",
      requirements: `Implement applyAdjustments(input) in src/feature.js.

Input is { subtotalCents, adjustments }. subtotalCents must be a nonnegative safe
integer. adjustments must be an array. Each enabled adjustment is applied in order:
- { type: "fixed", cents } subtracts a nonnegative safe integer number of cents.
- { type: "percent", basisPoints } subtracts Math.round(current * basisPoints / 10000);
  basisPoints is an integer from 0 through 10000.
Disabled entries ({ enabled: false }) are ignored but otherwise validated only for
object shape and type. The running amount cannot fall below zero.

Return { subtotalCents, totalAdjustmentCents, finalCents, applied }, where applied
contains { index, type, amountCents, beforeCents, afterCents } for enabled entries.
Reject malformed input and unsupported adjustment types with descriptive TypeErrors.`,
      changedFiles: ["src/feature.js"],
      nearbyTests: ["test/conventions.test.js"],
      targetTest: "test/feature.test.js"
    },
    gold: `"use strict";
function integer(value, name, min, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new TypeError(name + " must be an integer in range");
}
function applyAdjustments(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError("input must be an object");
  integer(input.subtotalCents, "subtotalCents", 0);
  if (!Array.isArray(input.adjustments)) throw new TypeError("adjustments must be an array");
  let current = input.subtotalCents;
  const applied = [];
  input.adjustments.forEach((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new TypeError("adjustment must be an object");
    if (entry.type !== "fixed" && entry.type !== "percent") throw new TypeError("unsupported adjustment type");
    if (entry.enabled === false) return;
    let amount;
    if (entry.type === "fixed") {
      integer(entry.cents, "cents", 0);
      amount = entry.cents;
    } else {
      integer(entry.basisPoints, "basisPoints", 0, 10000);
      amount = Math.round(current * entry.basisPoints / 10000);
    }
    const before = current;
    current = Math.max(0, current - amount);
    applied.push({ index, type: entry.type, amountCents: before - current, beforeCents: before, afterCents: current });
  });
  return { subtotalCents: input.subtotalCents, totalAdjustmentCents: input.subtotalCents - current, finalCents: current, applied };
}
module.exports = { applyAdjustments };
`,
    hiddenCases: [
      { name: "sequential rounding", input: { subtotalCents: 1001, adjustments: [{ type: "percent", basisPoints: 3333 }, { type: "percent", basisPoints: 5000 }, { type: "fixed", cents: 10 }] }, expected: { subtotalCents: 1001, totalAdjustmentCents: 678, finalCents: 323, applied: [{ index: 0, type: "percent", amountCents: 334, beforeCents: 1001, afterCents: 667 }, { index: 1, type: "percent", amountCents: 334, beforeCents: 667, afterCents: 333 }, { index: 2, type: "fixed", amountCents: 10, beforeCents: 333, afterCents: 323 }] } },
      { name: "clamps fixed", input: { subtotalCents: 50, adjustments: [{ type: "fixed", cents: 80 }] }, expected: { subtotalCents: 50, totalAdjustmentCents: 50, finalCents: 0, applied: [{ index: 0, type: "fixed", amountCents: 50, beforeCents: 50, afterCents: 0 }] } },
      { name: "disabled unsupported still rejects", input: { subtotalCents: 50, adjustments: [{ type: "bogus", enabled: false }] }, error: "unsupported" },
      { name: "invalid basis points", input: { subtotalCents: 50, adjustments: [{ type: "percent", basisPoints: 10001 }] }, error: "basisPoints" }
    ],
    mutants: [
      { id: "percent-floor", find: "Math.round(current * entry.basisPoints / 10000)", replace: "Math.floor(current * entry.basisPoints / 10000)" },
      { id: "nonsequential-percent", find: "Math.round(current * entry.basisPoints / 10000)", replace: "Math.round(input.subtotalCents * entry.basisPoints / 10000)" },
      { id: "no-clamp", find: "Math.max(0, current - amount)", replace: "current - amount" },
      { id: "skip-type-validation", find: "if (entry.type !== \"fixed\" && entry.type !== \"percent\") throw new TypeError(\"unsupported adjustment type\");", replace: "" }
    ]
  }),
  defineTask({
    id: "P02",
    phase: "pilot",
    category: "state-transitions",
    exportName: "transitionReservation",
    candidate: {
      title: "Inventory reservation state machine",
      requirements: `Implement transitionReservation(reservation, event) in src/feature.js.

A reservation is { state, quantity, version }. quantity is a positive safe integer,
version is a nonnegative safe integer, and state is pending, confirmed, released, or
expired. Events are { type, expectedVersion } and may include availableQuantity.
expectedVersion must equal reservation.version or throw an Error containing "version".
Allowed transitions are pending+confirm -> confirmed when availableQuantity >= quantity;
pending+release -> released; pending+expire -> expired; confirmed+release -> released.
Insufficient inventory throws an Error containing "inventory". Any other transition
throws an Error containing "transition".

Return a new reservation with version incremented by one and do not mutate either input.`,
      changedFiles: ["src/feature.js"],
      nearbyTests: ["test/conventions.test.js"],
      targetTest: "test/feature.test.js"
    },
    gold: `"use strict";
const states = new Set(["pending", "confirmed", "released", "expired"]);
function transitionReservation(reservation, event) {
  if (!reservation || typeof reservation !== "object" || Array.isArray(reservation)) throw new TypeError("reservation must be an object");
  if (!event || typeof event !== "object" || Array.isArray(event)) throw new TypeError("event must be an object");
  if (!states.has(reservation.state)) throw new TypeError("invalid state");
  if (!Number.isSafeInteger(reservation.quantity) || reservation.quantity <= 0) throw new TypeError("invalid quantity");
  if (!Number.isSafeInteger(reservation.version) || reservation.version < 0) throw new TypeError("invalid version");
  if (event.expectedVersion !== reservation.version) throw new Error("version conflict");
  let state;
  if (reservation.state === "pending" && event.type === "confirm") {
    if (!Number.isSafeInteger(event.availableQuantity) || event.availableQuantity < reservation.quantity) throw new Error("insufficient inventory");
    state = "confirmed";
  } else if (reservation.state === "pending" && event.type === "release") state = "released";
  else if (reservation.state === "pending" && event.type === "expire") state = "expired";
  else if (reservation.state === "confirmed" && event.type === "release") state = "released";
  else throw new Error("invalid transition");
  return { ...reservation, state, version: reservation.version + 1 };
}
module.exports = { transitionReservation };
`,
    hiddenCases: [
      { name: "confirm exact stock", input: [{ state: "pending", quantity: 3, version: 2, owner: "acct-1" }, { type: "confirm", expectedVersion: 2, availableQuantity: 3 }], spread: true, expected: { state: "confirmed", quantity: 3, version: 3, owner: "acct-1" } },
      { name: "confirmed release", input: [{ state: "confirmed", quantity: 2, version: 0 }, { type: "release", expectedVersion: 0 }], spread: true, expected: { state: "released", quantity: 2, version: 1 } },
      { name: "version conflict", input: [{ state: "pending", quantity: 1, version: 2 }, { type: "release", expectedVersion: 1 }], spread: true, error: "version" },
      { name: "insufficient", input: [{ state: "pending", quantity: 4, version: 0 }, { type: "confirm", expectedVersion: 0, availableQuantity: 3 }], spread: true, error: "inventory" },
      { name: "terminal transition", input: [{ state: "released", quantity: 1, version: 0 }, { type: "expire", expectedVersion: 0 }], spread: true, error: "transition" }
    ],
    mutants: [
      { id: "version-not-incremented", find: "version: reservation.version + 1", replace: "version: reservation.version" },
      { id: "stock-strict", find: "event.availableQuantity < reservation.quantity", replace: "event.availableQuantity <= reservation.quantity" },
      { id: "permit-terminal", find: "else throw new Error(\"invalid transition\");", replace: "else state = event.type === \"expire\" ? \"expired\" : reservation.state;" },
      { id: "drop-extra-fields", find: "return { ...reservation, state, version: reservation.version + 1 };", replace: "return { state, quantity: reservation.quantity, version: reservation.version + 1 };" }
    ]
  }),
  defineTask({
    id: "M01",
    phase: "main",
    category: "parsing-validation",
    exportName: "parseTable",
    candidate: {
      title: "Quoted delimited-record parser",
      requirements: `Implement parseTable(text, options = {}) in src/feature.js.

Parse a complete in-memory delimited table. delimiter defaults to comma and must be one
non-newline character. The first nonblank row is the header. Support CRLF/LF, quoted
fields, delimiters and newlines inside quotes, and doubled quote escapes. Trim
unquoted fields but preserve quoted whitespace. Reject an unclosed quote, quote inside
an unquoted field, duplicate/blank headers, or a data row with the wrong field count.
Skip wholly blank physical rows outside quotes.

Return an array of null-prototype records keyed by headers. Empty fields are empty
strings. Do not use external packages.`,
      changedFiles: ["src/feature.js"],
      nearbyTests: ["test/conventions.test.js"],
      targetTest: "test/feature.test.js"
    },
    gold: `"use strict";
function parseTable(text, options = {}) {
  if (typeof text !== "string") throw new TypeError("text must be a string");
  const delimiter = options.delimiter ?? ",";
  if (typeof delimiter !== "string" || delimiter.length !== 1 || delimiter === "\\n" || delimiter === "\\r" || delimiter === "\\"") throw new TypeError("invalid delimiter");
  const rows = []; let row = []; let value = ""; let quoted = false; let wasQuoted = false; let afterQuote = false;
  const pushField = () => { row.push(wasQuoted ? value : value.trim()); value = ""; wasQuoted = false; afterQuote = false; };
  const pushRow = () => { pushField(); if (row.some((field) => field !== "")) rows.push(row); row = []; };
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === "\\"" && text[index + 1] === "\\"") { value += "\\""; index += 1; }
      else if (char === "\\"") { quoted = false; afterQuote = true; }
      else value += char;
    } else if (afterQuote) {
      if (char === delimiter) pushField();
      else if (char === "\\n") pushRow();
      else if (char === "\\r" && text[index + 1] === "\\n") { pushRow(); index += 1; }
      else if (!/\\s/u.test(char)) throw new Error("unexpected content after quote");
    } else if (char === "\\"" && value.length === 0) { quoted = true; wasQuoted = true; }
    else if (char === "\\"") throw new Error("quote inside unquoted field");
    else if (char === delimiter) pushField();
    else if (char === "\\n") pushRow();
    else if (char === "\\r" && text[index + 1] === "\\n") { pushRow(); index += 1; }
    else value += char;
  }
  if (quoted) throw new Error("unclosed quote");
  if (value.length || row.length || wasQuoted || afterQuote) pushRow();
  if (!rows.length) return [];
  const headers = rows.shift();
  if (headers.some((header) => header === "") || new Set(headers).size !== headers.length) throw new Error("invalid headers");
  return rows.map((fields) => {
    if (fields.length !== headers.length) throw new Error("wrong field count");
    const record = Object.create(null);
    headers.forEach((header, index) => { record[header] = fields[index]; });
    return record;
  });
}
module.exports = { parseTable };
`,
    hiddenCases: [
      { name: "quoted delimiter", input: ['name,note\nAda,"x,y"'], spread: true, expected: [{ name: "Ada", note: "x,y" }], nullPrototype: true },
      { name: "quoted newline and escape", input: ['id,text\r\n1,"a""b\nline"'], spread: true, expected: [{ id: "1", text: 'a"b\nline' }], nullPrototype: true },
      { name: "trim distinction", input: ['a,b\n x ," y "'], spread: true, expected: [{ a: "x", b: " y " }], nullPrototype: true },
      { name: "duplicate header", input: ["a,a\n1,2"], spread: true, error: "headers" },
      { name: "wrong columns", input: ["a,b\n1"], spread: true, error: "field count" },
      { name: "unclosed", input: ['a\n"x'], spread: true, error: "unclosed" }
    ],
    mutants: [
      { id: "no-unquoted-trim", find: "wasQuoted ? value : value.trim()", replace: "value" },
      { id: "lose-escaped-quote", find: "value += \"\\\"\"; index += 1;", replace: "index += 1;" },
      { id: "allow-duplicate-header", find: " || new Set(headers).size !== headers.length", replace: "" },
      { id: "allow-short-row", find: "if (fields.length !== headers.length) throw new Error(\"wrong field count\");", replace: "" }
    ]
  }),
  defineTask({
    id: "M02",
    phase: "main",
    category: "pricing-rules",
    exportName: "priceOrder",
    candidate: {
      title: "Tiered order pricing",
      requirements: `Implement priceOrder(order) in src/feature.js.

order has items and optional discountBasisPoints (default 0), discountCapCents (default
unlimited), and taxBasisPoints (default 0). Each item has sku, quantity, and tiers.
Validate safe integer money/quantities and unique nonblank SKUs. tiers is a nonempty
ascending list of { minQuantity, unitCents }; minQuantity starts at 1. Choose the tier
with the greatest minQuantity <= item quantity and price the entire item quantity at
that unit price.

Apply the order discount to subtotal using Math.floor, capped by discountCapCents, then
tax the discounted amount using Math.round. Return item lines plus subtotalCents,
discountCents, taxableCents, taxCents, and totalCents. Do not mutate input.`,
      changedFiles: ["src/feature.js"],
      nearbyTests: ["test/conventions.test.js"],
      targetTest: "test/feature.test.js"
    },
    gold: `"use strict";
function nat(value, name, min = 0, max = Number.MAX_SAFE_INTEGER) { if (!Number.isSafeInteger(value) || value < min || value > max) throw new TypeError("invalid " + name); }
function priceOrder(order) {
  if (!order || typeof order !== "object" || !Array.isArray(order.items)) throw new TypeError("invalid order");
  const discountBasisPoints = order.discountBasisPoints ?? 0;
  const discountCapCents = order.discountCapCents ?? Number.MAX_SAFE_INTEGER;
  const taxBasisPoints = order.taxBasisPoints ?? 0;
  nat(discountBasisPoints, "discountBasisPoints", 0, 10000); nat(discountCapCents, "discountCapCents"); nat(taxBasisPoints, "taxBasisPoints", 0, 10000);
  const seen = new Set();
  const lines = order.items.map((item) => {
    if (!item || typeof item.sku !== "string" || item.sku.trim() === "" || seen.has(item.sku)) throw new TypeError("invalid or duplicate sku");
    seen.add(item.sku); nat(item.quantity, "quantity", 1);
    if (!Array.isArray(item.tiers) || !item.tiers.length) throw new TypeError("invalid tiers");
    let previous = 0; let unitCents;
    for (const tier of item.tiers) {
      nat(tier.minQuantity, "minQuantity", 1); nat(tier.unitCents, "unitCents");
      if (tier.minQuantity <= previous || (previous === 0 && tier.minQuantity !== 1)) throw new TypeError("tiers must be ascending from one");
      previous = tier.minQuantity;
      if (tier.minQuantity <= item.quantity) unitCents = tier.unitCents;
    }
    const lineTotalCents = item.quantity * unitCents;
    nat(lineTotalCents, "lineTotalCents");
    return { sku: item.sku, quantity: item.quantity, unitCents, lineTotalCents };
  });
  const subtotalCents = lines.reduce((sum, line) => sum + line.lineTotalCents, 0);
  nat(subtotalCents, "subtotalCents");
  const discountCents = Math.min(discountCapCents, Math.floor(subtotalCents * discountBasisPoints / 10000));
  const taxableCents = subtotalCents - discountCents;
  const taxCents = Math.round(taxableCents * taxBasisPoints / 10000);
  return { lines, subtotalCents, discountCents, taxableCents, taxCents, totalCents: taxableCents + taxCents };
}
module.exports = { priceOrder };
`,
    hiddenCases: [
      { name: "tier whole quantity", input: [{ items: [{ sku: "A", quantity: 10, tiers: [{ minQuantity: 1, unitCents: 100 }, { minQuantity: 10, unitCents: 80 }] }] }], spread: true, expected: { lines: [{ sku: "A", quantity: 10, unitCents: 80, lineTotalCents: 800 }], subtotalCents: 800, discountCents: 0, taxableCents: 800, taxCents: 0, totalCents: 800 } },
      { name: "discount cap and tax", input: [{ items: [{ sku: "A", quantity: 3, tiers: [{ minQuantity: 1, unitCents: 333 }] }], discountBasisPoints: 2500, discountCapCents: 200, taxBasisPoints: 725 }], spread: true, expected: { lines: [{ sku: "A", quantity: 3, unitCents: 333, lineTotalCents: 999 }], subtotalCents: 999, discountCents: 200, taxableCents: 799, taxCents: 58, totalCents: 857 } },
      { name: "discount floors", input: [{ items: [{ sku: "A", quantity: 3, tiers: [{ minQuantity: 1, unitCents: 333 }] }], discountBasisPoints: 2500 }], spread: true, expected: { lines: [{ sku: "A", quantity: 3, unitCents: 333, lineTotalCents: 999 }], subtotalCents: 999, discountCents: 249, taxableCents: 750, taxCents: 0, totalCents: 750 } },
      { name: "duplicate sku", input: [{ items: [{ sku: "A", quantity: 1, tiers: [{ minQuantity: 1, unitCents: 1 }] }, { sku: "A", quantity: 1, tiers: [{ minQuantity: 1, unitCents: 1 }] }] }], spread: true, error: "duplicate" },
      { name: "bad tier start", input: [{ items: [{ sku: "A", quantity: 2, tiers: [{ minQuantity: 2, unitCents: 10 }] }] }], spread: true, error: "tiers" }
    ],
    mutants: [
      { id: "incremental-tier", find: "const lineTotalCents = item.quantity * unitCents;", replace: "const lineTotalCents = item.tiers.reduce((sum, tier, index) => sum + Math.max(0, Math.min(item.quantity, (item.tiers[index + 1]?.minQuantity ?? item.quantity + 1) - 1) - tier.minQuantity + 1) * tier.unitCents, 0);" },
      { id: "discount-round", find: "Math.floor(subtotalCents * discountBasisPoints / 10000)", replace: "Math.round(subtotalCents * discountBasisPoints / 10000)" },
      { id: "tax-before-discount", find: "Math.round(taxableCents * taxBasisPoints / 10000)", replace: "Math.round(subtotalCents * taxBasisPoints / 10000)" },
      { id: "ignore-cap", find: "Math.min(discountCapCents, Math.floor(subtotalCents * discountBasisPoints / 10000))", replace: "Math.floor(subtotalCents * discountBasisPoints / 10000)" }
    ]
  }),
  defineTask({
    id: "M03",
    phase: "main",
    category: "policy-evaluation",
    exportName: "evaluatePolicy",
    candidate: {
      title: "Ordered access-policy evaluator",
      requirements: `Implement evaluatePolicy(request, rules) in src/feature.js.

request is { action, resource, attributes }. Rules have id, effect ("allow" or "deny"),
actions, resources, and optional conditions. actions/resources are nonempty string arrays;
"*" matches anything and a single trailing "*" is a prefix wildcard. Conditions map an
attribute name to either a scalar exact value or { in: [...] }. A rule matches when
action, resource, and every condition match.

All matching rule IDs are returned in source order. Any matching deny wins; otherwise
any matching allow permits; otherwise deny by default. Return
{ allowed, decision, matchedRuleIds, reason }, with reason "explicit-deny",
"explicit-allow", or "default-deny". Validate duplicate IDs and malformed patterns.
Do not mutate inputs.`,
      changedFiles: ["src/feature.js"],
      nearbyTests: ["test/conventions.test.js"],
      targetTest: "test/feature.test.js"
    },
    gold: `"use strict";
function patternMatches(pattern, value) {
  if (pattern === "*") return true;
  const star = pattern.indexOf("*");
  if (star < 0) return pattern === value;
  if (star !== pattern.length - 1 || pattern.indexOf("*", star + 1) >= 0) throw new TypeError("invalid wildcard");
  return value.startsWith(pattern.slice(0, -1));
}
function evaluatePolicy(request, rules) {
  if (!request || typeof request.action !== "string" || typeof request.resource !== "string" || !request.attributes || typeof request.attributes !== "object") throw new TypeError("invalid request");
  if (!Array.isArray(rules)) throw new TypeError("rules must be an array");
  const seen = new Set(); const matched = [];
  for (const rule of rules) {
    if (!rule || typeof rule.id !== "string" || !rule.id || seen.has(rule.id)) throw new TypeError("invalid or duplicate rule id");
    seen.add(rule.id);
    if (rule.effect !== "allow" && rule.effect !== "deny") throw new TypeError("invalid effect");
    if (!Array.isArray(rule.actions) || !rule.actions.length || !Array.isArray(rule.resources) || !rule.resources.length) throw new TypeError("invalid patterns");
    const action = rule.actions.some((pattern) => patternMatches(pattern, request.action));
    const resource = rule.resources.some((pattern) => patternMatches(pattern, request.resource));
    const conditions = Object.entries(rule.conditions ?? {}).every(([key, expected]) => {
      const actual = request.attributes[key];
      return expected && typeof expected === "object" && !Array.isArray(expected)
        ? Array.isArray(expected.in) && expected.in.some((value) => Object.is(value, actual))
        : Object.is(expected, actual);
    });
    if (action && resource && conditions) matched.push(rule);
  }
  const denied = matched.some((rule) => rule.effect === "deny");
  const allowed = !denied && matched.some((rule) => rule.effect === "allow");
  return { allowed, decision: allowed ? "allow" : "deny", matchedRuleIds: matched.map((rule) => rule.id), reason: denied ? "explicit-deny" : allowed ? "explicit-allow" : "default-deny" };
}
module.exports = { evaluatePolicy };
`,
    hiddenCases: [
      { name: "deny precedence", input: [{ action: "repo:write", resource: "org/a", attributes: { region: "eu" } }, [{ id: "a", effect: "allow", actions: ["repo:*"], resources: ["org/*"] }, { id: "d", effect: "deny", actions: ["repo:write"], resources: ["*"], conditions: { region: { in: ["eu", "cn"] } } }]], spread: true, expected: { allowed: false, decision: "deny", matchedRuleIds: ["a", "d"], reason: "explicit-deny" } },
      { name: "default deny", input: [{ action: "read", resource: "x", attributes: {} }, [{ id: "a", effect: "allow", actions: ["write"], resources: ["*"] }]], spread: true, expected: { allowed: false, decision: "deny", matchedRuleIds: [], reason: "default-deny" } },
      { name: "wildcard is prefix only", input: [{ action: "xrepo:write", resource: "x", attributes: {} }, [{ id: "a", effect: "allow", actions: ["repo:*"], resources: ["*"] }]], spread: true, expected: { allowed: false, decision: "deny", matchedRuleIds: [], reason: "default-deny" } },
      { name: "scalar exact type", input: [{ action: "read", resource: "x", attributes: { level: "1" } }, [{ id: "a", effect: "allow", actions: ["*"], resources: ["*"], conditions: { level: 1 } }]], spread: true, expected: { allowed: false, decision: "deny", matchedRuleIds: [], reason: "default-deny" } },
      { name: "invalid wildcard", input: [{ action: "read", resource: "x", attributes: {} }, [{ id: "a", effect: "allow", actions: ["r*d"], resources: ["*"] }]], spread: true, error: "wildcard" },
      { name: "duplicate id", input: [{ action: "read", resource: "x", attributes: {} }, [{ id: "a", effect: "allow", actions: ["*"], resources: ["*"] }, { id: "a", effect: "deny", actions: ["*"], resources: ["*"] }]], spread: true, error: "duplicate" }
    ],
    mutants: [
      { id: "allow-overrides-deny", find: "const allowed = !denied && matched.some((rule) => rule.effect === \"allow\");", replace: "const allowed = matched.some((rule) => rule.effect === \"allow\");" },
      { id: "substring-prefix", find: "return value.startsWith(pattern.slice(0, -1));", replace: "return value.includes(pattern.slice(0, -1));" },
      { id: "coercive-condition", find: "Object.is(expected, actual)", replace: "expected == actual" },
      { id: "default-allow", find: "const allowed = !denied && matched.some((rule) => rule.effect === \"allow\");", replace: "const allowed = !denied && (matched.length === 0 || matched.some((rule) => rule.effect === \"allow\"));" }
    ]
  }),
  defineTask({
    id: "M04",
    phase: "main",
    category: "state-reduction",
    exportName: "reduceShipment",
    candidate: {
      title: "Shipment event reducer",
      requirements: `Implement reduceShipment(initial, events) in src/feature.js.

Initial is { state, updatedAt, version, processedEventIds } with state created, packed,
dispatched, delivered, or returned; updatedAt is an ISO instant; version is nonnegative;
and processedEventIds is an array of unique strings. Events have id, type, and at.
Ignore already-processed event IDs without otherwise validating their timestamp/type.
New events must have unique IDs, nondecreasing timestamps, and legal transitions:
created+pack -> packed, packed+dispatch -> dispatched, dispatched+deliver -> delivered,
and delivered+return -> returned. Illegal transitions throw.

Return a new state with each accepted event ID appended, updatedAt set to its timestamp,
and version incremented. Inputs must not be mutated. Reject duplicate new IDs even when
they appear later in the same batch.`,
      changedFiles: ["src/feature.js"],
      nearbyTests: ["test/conventions.test.js"],
      targetTest: "test/feature.test.js"
    },
    gold: `"use strict";
const next = { created: { pack: "packed" }, packed: { dispatch: "dispatched" }, dispatched: { deliver: "delivered" }, delivered: { return: "returned" }, returned: {} };
function instant(value) { const time = Date.parse(value); if (typeof value !== "string" || !Number.isFinite(time)) throw new TypeError("invalid timestamp"); return time; }
function reduceShipment(initial, events) {
  if (!initial || !Object.hasOwn(next, initial.state) || !Number.isSafeInteger(initial.version) || initial.version < 0 || !Array.isArray(initial.processedEventIds) || new Set(initial.processedEventIds).size !== initial.processedEventIds.length) throw new TypeError("invalid initial shipment");
  if (!Array.isArray(events)) throw new TypeError("events must be an array");
  let state = initial.state; let updatedAt = initial.updatedAt; let version = initial.version; let time = instant(updatedAt);
  const ids = [...initial.processedEventIds]; const seen = new Set(ids);
  for (const event of events) {
    if (!event || typeof event.id !== "string" || !event.id) throw new TypeError("invalid event id");
    if (seen.has(event.id)) {
      if (initial.processedEventIds.includes(event.id)) continue;
      throw new Error("duplicate new event id");
    }
    seen.add(event.id);
    const eventTime = instant(event.at);
    if (eventTime < time) throw new Error("event timestamp out of order");
    const target = next[state][event.type];
    if (!target) throw new Error("illegal transition");
    state = target; updatedAt = event.at; time = eventTime; version += 1; ids.push(event.id);
  }
  return { ...initial, state, updatedAt, version, processedEventIds: ids };
}
module.exports = { reduceShipment };
`,
    hiddenCases: [
      { name: "full lifecycle", input: [{ state: "created", updatedAt: "2026-01-01T00:00:00Z", version: 1, processedEventIds: [] }, [{ id: "1", type: "pack", at: "2026-01-01T00:00:00Z" }, { id: "2", type: "dispatch", at: "2026-01-02T00:00:00Z" }, { id: "3", type: "deliver", at: "2026-01-03T00:00:00Z" }]], spread: true, expected: { state: "delivered", updatedAt: "2026-01-03T00:00:00Z", version: 4, processedEventIds: ["1", "2", "3"] } },
      { name: "old duplicate ignored", input: [{ state: "packed", updatedAt: "2026-01-02T00:00:00Z", version: 2, processedEventIds: ["1"] }, [{ id: "1", type: "bogus", at: "bad" }, { id: "2", type: "dispatch", at: "2026-01-03T00:00:00Z" }]], spread: true, expected: { state: "dispatched", updatedAt: "2026-01-03T00:00:00Z", version: 3, processedEventIds: ["1", "2"] } },
      { name: "same batch duplicate", input: [{ state: "created", updatedAt: "2026-01-01T00:00:00Z", version: 0, processedEventIds: [] }, [{ id: "x", type: "pack", at: "2026-01-02T00:00:00Z" }, { id: "x", type: "dispatch", at: "2026-01-03T00:00:00Z" }]], spread: true, error: "duplicate" },
      { name: "time regression", input: [{ state: "created", updatedAt: "2026-01-02T00:00:00Z", version: 0, processedEventIds: [] }, [{ id: "x", type: "pack", at: "2026-01-01T00:00:00Z" }]], spread: true, error: "timestamp" },
      { name: "illegal skip", input: [{ state: "created", updatedAt: "2026-01-01T00:00:00Z", version: 0, processedEventIds: [] }, [{ id: "x", type: "dispatch", at: "2026-01-02T00:00:00Z" }]], spread: true, error: "transition" }
    ],
    mutants: [
      { id: "duplicate-all-ignored", find: "if (initial.processedEventIds.includes(event.id)) continue;\n      throw new Error(\"duplicate new event id\");", replace: "continue;" },
      { id: "allow-time-regression", find: "if (eventTime < time) throw new Error(\"event timestamp out of order\");", replace: "" },
      { id: "version-once", find: "version += 1;", replace: "version = initial.version + 1;" },
      { id: "mutate-id-list", find: "const ids = [...initial.processedEventIds];", replace: "const ids = initial.processedEventIds;" }
    ]
  }),
  defineTask({
    id: "M05",
    phase: "main",
    category: "scheduling-validation",
    exportName: "planOccurrences",
    candidate: {
      title: "Recurring business-day planner",
      requirements: `Implement planOccurrences(input) in src/feature.js.

Input has startDate ("YYYY-MM-DD"), count (1..100), intervalDays (positive integer),
optional weekdaysOnly (default false), and optional excludedDates (unique ISO dates).
The start is the first candidate. For each emitted occurrence, advance by intervalDays
calendar days from that emitted date. If weekdaysOnly is true, roll Saturday/Sunday
forward to Monday. Then roll forward one day at a time through excluded dates; each roll
must again honor weekends. This rolling does not change the interval anchor: the next
candidate advances from the final emitted date.

Return ISO date strings. Use UTC calendar arithmetic, reject impossible dates and
duplicate exclusions, and never mutate input.`,
      changedFiles: ["src/feature.js"],
      nearbyTests: ["test/conventions.test.js"],
      targetTest: "test/feature.test.js"
    },
    gold: `"use strict";
function parseDate(value) {
  if (typeof value !== "string" || !/^\\d{4}-\\d{2}-\\d{2}$/u.test(value)) throw new TypeError("invalid date");
  const date = new Date(value + "T00:00:00Z");
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new TypeError("invalid date");
  return date;
}
function format(date) { return date.toISOString().slice(0, 10); }
function add(date, days) { const result = new Date(date); result.setUTCDate(result.getUTCDate() + days); return result; }
function planOccurrences(input) {
  if (!input || typeof input !== "object") throw new TypeError("invalid input");
  if (!Number.isSafeInteger(input.count) || input.count < 1 || input.count > 100) throw new TypeError("invalid count");
  if (!Number.isSafeInteger(input.intervalDays) || input.intervalDays < 1) throw new TypeError("invalid intervalDays");
  let candidate = parseDate(input.startDate);
  const exclusions = input.excludedDates ?? [];
  if (!Array.isArray(exclusions) || new Set(exclusions).size !== exclusions.length) throw new TypeError("invalid or duplicate exclusions");
  exclusions.forEach(parseDate); const excluded = new Set(exclusions); const output = [];
  const roll = (date) => {
    let current = date;
    while ((input.weekdaysOnly === true && (current.getUTCDay() === 0 || current.getUTCDay() === 6)) || excluded.has(format(current))) current = add(current, 1);
    return current;
  };
  for (let index = 0; index < input.count; index += 1) {
    const emitted = roll(candidate);
    output.push(format(emitted));
    candidate = add(emitted, input.intervalDays);
  }
  return output;
}
module.exports = { planOccurrences };
`,
    hiddenCases: [
      { name: "weekend rolls", input: [{ startDate: "2026-08-01", count: 3, intervalDays: 1, weekdaysOnly: true }], spread: true, expected: ["2026-08-03", "2026-08-04", "2026-08-05"] },
      { name: "exclusion into weekend", input: [{ startDate: "2026-07-31", count: 2, intervalDays: 1, weekdaysOnly: true, excludedDates: ["2026-07-31"] }], spread: true, expected: ["2026-08-03", "2026-08-04"] },
      { name: "leap date", input: [{ startDate: "2028-02-28", count: 3, intervalDays: 1 }], spread: true, expected: ["2028-02-28", "2028-02-29", "2028-03-01"] },
      { name: "impossible date", input: [{ startDate: "2026-02-29", count: 1, intervalDays: 1 }], spread: true, error: "date" },
      { name: "duplicate exclusion", input: [{ startDate: "2026-01-01", count: 1, intervalDays: 1, excludedDates: ["2026-01-02", "2026-01-02"] }], spread: true, error: "duplicate" }
    ],
    mutants: [
      { id: "anchor-unrolled-date", find: "candidate = add(emitted, input.intervalDays);", replace: "candidate = add(candidate, input.intervalDays);" },
      { id: "saturday-only", find: "current.getUTCDay() === 0 || current.getUTCDay() === 6", replace: "current.getUTCDay() === 6" },
      { id: "off-by-one-add", find: "result.setUTCDate(result.getUTCDate() + days);", replace: "result.setUTCDate(result.getUTCDate() + days + 1);" },
      { id: "allow-duplicate-exclusions", find: " || new Set(exclusions).size !== exclusions.length", replace: "" }
    ]
  }),
  defineTask({
    id: "M06",
    phase: "main",
    category: "reconciliation",
    exportName: "reconcileLedger",
    candidate: {
      title: "Ledger-to-settlement reconciliation",
      requirements: `Implement reconcileLedger(entries, settlements, toleranceCents = 0).

Ledger entries have unique id, nonblank reference, direction ("debit" or "credit"), and
positive integer cents. Net each reference as debits minus credits. Settlement lines
have unique id, nonblank reference, and nonnegative integer cents. At most one
settlement may exist per reference; duplicates are reported, not thrown.

Return { matched, mismatched, missing, unexpected, duplicateSettlements, ledgerNetCents,
settlementTotalCents }. Classify each ledger reference: duplicate settlement first;
missing if none; matched when absolute difference <= tolerance; otherwise mismatched.
Settlement-only references are unexpected. Sort every array by reference then id.
Reject malformed data and invalid tolerance; do not mutate input.`,
      changedFiles: ["src/feature.js"],
      nearbyTests: ["test/conventions.test.js"],
      targetTest: "test/feature.test.js"
    },
    gold: `"use strict";
function money(value, name, min) { if (!Number.isSafeInteger(value) || value < min) throw new TypeError("invalid " + name); }
function reconcileLedger(entries, settlements, toleranceCents = 0) {
  if (!Array.isArray(entries) || !Array.isArray(settlements)) throw new TypeError("inputs must be arrays");
  money(toleranceCents, "tolerance", 0);
  const entryIds = new Set(); const ledger = new Map();
  for (const entry of entries) {
    if (!entry || typeof entry.id !== "string" || !entry.id || entryIds.has(entry.id) || typeof entry.reference !== "string" || !entry.reference.trim() || (entry.direction !== "debit" && entry.direction !== "credit")) throw new TypeError("invalid ledger entry");
    entryIds.add(entry.id); money(entry.cents, "entry cents", 1);
    ledger.set(entry.reference, (ledger.get(entry.reference) ?? 0) + (entry.direction === "debit" ? entry.cents : -entry.cents));
  }
  const settlementIds = new Set(); const byReference = new Map();
  for (const line of settlements) {
    if (!line || typeof line.id !== "string" || !line.id || settlementIds.has(line.id) || typeof line.reference !== "string" || !line.reference.trim()) throw new TypeError("invalid settlement");
    settlementIds.add(line.id); money(line.cents, "settlement cents", 0);
    const list = byReference.get(line.reference) ?? []; list.push({ ...line }); byReference.set(line.reference, list);
  }
  const result = { matched: [], mismatched: [], missing: [], unexpected: [], duplicateSettlements: [], ledgerNetCents: [...ledger.values()].reduce((a, b) => a + b, 0), settlementTotalCents: settlements.reduce((sum, line) => sum + line.cents, 0) };
  for (const [reference, expectedCents] of ledger) {
    const lines = byReference.get(reference) ?? [];
    if (lines.length > 1) result.duplicateSettlements.push(...lines.map((line) => ({ reference, id: line.id, cents: line.cents })));
    else if (!lines.length) result.missing.push({ reference, expectedCents });
    else {
      const actualCents = lines[0].cents; const differenceCents = actualCents - expectedCents;
      const item = { reference, settlementId: lines[0].id, expectedCents, actualCents, differenceCents };
      result[Math.abs(differenceCents) <= toleranceCents ? "matched" : "mismatched"].push(item);
    }
  }
  for (const [reference, lines] of byReference) if (!ledger.has(reference)) result.unexpected.push(...lines.map((line) => ({ reference, id: line.id, cents: line.cents })));
  const compare = (a, b) => a.reference.localeCompare(b.reference) || (a.id ?? a.settlementId ?? "").localeCompare(b.id ?? b.settlementId ?? "");
  for (const key of ["matched", "mismatched", "missing", "unexpected", "duplicateSettlements"]) result[key].sort(compare);
  return result;
}
module.exports = { reconcileLedger };
`,
    hiddenCases: [
      { name: "net and tolerance", input: [[{ id: "e1", reference: "A", direction: "debit", cents: 100 }, { id: "e2", reference: "A", direction: "credit", cents: 20 }], [{ id: "s1", reference: "A", cents: 81 }], 1], spread: true, expected: { matched: [{ reference: "A", settlementId: "s1", expectedCents: 80, actualCents: 81, differenceCents: 1 }], mismatched: [], missing: [], unexpected: [], duplicateSettlements: [], ledgerNetCents: 80, settlementTotalCents: 81 } },
      { name: "all classifications", input: [[{ id: "1", reference: "B", direction: "debit", cents: 10 }, { id: "2", reference: "A", direction: "debit", cents: 20 }, { id: "3", reference: "C", direction: "debit", cents: 30 }], [{ id: "z", reference: "A", cents: 10 }, { id: "x", reference: "B", cents: 10 }, { id: "y", reference: "B", cents: 10 }, { id: "u", reference: "D", cents: 5 }]], spread: true, expected: { matched: [], mismatched: [{ reference: "A", settlementId: "z", expectedCents: 20, actualCents: 10, differenceCents: -10 }], missing: [{ reference: "C", expectedCents: 30 }], unexpected: [{ reference: "D", id: "u", cents: 5 }], duplicateSettlements: [{ reference: "B", id: "x", cents: 10 }, { reference: "B", id: "y", cents: 10 }], ledgerNetCents: 60, settlementTotalCents: 35 } },
      { name: "duplicate entry id", input: [[{ id: "e", reference: "A", direction: "debit", cents: 1 }, { id: "e", reference: "B", direction: "debit", cents: 1 }], []], spread: true, error: "ledger" },
      { name: "zero entry invalid", input: [[{ id: "e", reference: "A", direction: "debit", cents: 0 }], []], spread: true, error: "entry cents" }
    ],
    mutants: [
      { id: "credit-added", find: "entry.direction === \"debit\" ? entry.cents : -entry.cents", replace: "entry.cents" },
      { id: "strict-tolerance", find: "Math.abs(differenceCents) <= toleranceCents", replace: "Math.abs(differenceCents) < toleranceCents" },
      { id: "duplicate-first-wins", find: "if (lines.length > 1) result.duplicateSettlements.push(...lines.map((line) => ({ reference, id: line.id, cents: line.cents })));", replace: "if (lines.length > 1) result.matched.push({ reference, settlementId: lines[0].id, expectedCents, actualCents: lines[0].cents, differenceCents: lines[0].cents - expectedCents });" },
      { id: "omit-unexpected", find: "for (const [reference, lines] of byReference) if (!ledger.has(reference)) result.unexpected.push(...lines.map((line) => ({ reference, id: line.id, cents: line.cents })));", replace: "" }
    ]
  })
]);

export function getTask(id) {
  const task = tasks.find((entry) => entry.id === id);
  if (!task) throw new Error(`unknown task ${id}`);
  return task;
}

export function createMutant(task, mutant) {
  if (!task.gold.includes(mutant.find)) throw new Error(`${task.id}/${mutant.id} mutation anchor missing`);
  const source = task.gold.replace(mutant.find, mutant.replace);
  if (source === task.gold) throw new Error(`${task.id}/${mutant.id} did not change source`);
  return source;
}
