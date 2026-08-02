const moduleStarter = (symbol) => `export function ${symbol}() {
  throw new Error("not implemented");
}
`;

const cliStarter = `import process from "node:process";

process.stderr.write("not implemented\\n");
process.exitCode = 1;
`;

const variant = (id, requirements, facts, checks) => ({id, requirements, facts, checks});

function moduleFixture({
  id,
  title,
  symbol,
  docTarget,
  baseRequirements,
  variants,
  doc,
  unchangedArgs = []
}) {
  return {
    id,
    title,
    kind: "module",
    sourcePath: "src/index.mjs",
    docTarget,
    starter: moduleStarter(symbol),
    unchangedArgs,
    baseRequirements,
    variants,
    doc: {
      headings: ["Overview", "API", "Examples", "Errors"],
      symbols: [symbol, ...doc.symbols],
      baseFacts: doc.baseFacts,
      minExecutable: 2,
      forbiddenClaims: doc.forbiddenClaims
    }
  };
}

function cliFixture({id, title, docTarget, baseRequirements, variants, doc}) {
  return {
    id,
    title,
    kind: "cli",
    sourcePath: "src/cli.mjs",
    docTarget,
    starter: cliStarter,
    unchangedArgs: [],
    baseRequirements,
    variants,
    doc: {
      headings: ["Synopsis", "Options", "Examples", "Exit behavior"],
      symbols: doc.symbols,
      baseFacts: doc.baseFacts,
      minExecutable: 2,
      forbiddenClaims: doc.forbiddenClaims
    }
  };
}

export const mainFixtures = [
  moduleFixture({
    id: "header-preference",
    title: "Implement weighted header preference selection",
    symbol: "selectPreference",
    docTarget: "docs/header-preference-cookbook.md",
    baseRequirements: [
      "Export `selectPreference(header, options = {})`.",
      "Parse comma-separated names with optional `;q=<number>` weights; an omitted weight is 1.",
      "Return the highest-weight eligible name, preserving first appearance for ties.",
      "Reject malformed or out-of-range weights with an error containing `invalid weight`.",
      "Ignore entries below `options.minimum`; return `null` when none remain.",
      "Names are trimmed but otherwise returned as written."
    ],
    variants: [
      variant("r1", ["The default `options.minimum` is 0.25."], ["default minimum is 0.25", "ties preserve first appearance"], [
        {call: "selectPreference", args: ["gzip;q=0.4, br;q=0.8"], expected: "br"},
        {call: "selectPreference", args: ["one;q=0.2, two;q=0.1"], expected: null},
        {call: "selectPreference", args: ["a;q=0.8, b;q=0.8"], expected: "a"},
        {call: "selectPreference", args: ["bad;q=2"], error: "invalid weight"}
      ]),
      variant("r2", ["The default `options.minimum` is 0.5."], ["default minimum is 0.5", "an omitted weight is 1"], [
        {call: "selectPreference", args: ["gzip;q=0.49, identity"], expected: "identity"},
        {call: "selectPreference", args: ["one;q=0.4"], expected: null},
        {call: "selectPreference", args: ["x;q=0.7, y;q=0.6"], expected: "x"},
        {call: "selectPreference", args: ["bad;q=-1"], error: "invalid weight"}
      ]),
      variant("r3", ["The default `options.minimum` is 0."], ["default minimum is 0", "names are returned as written"], [
        {call: "selectPreference", args: [" Alpha ;q=0, beta;q=0"], expected: "Alpha"},
        {call: "selectPreference", args: [""], expected: null},
        {call: "selectPreference", args: ["z"], expected: "z"},
        {call: "selectPreference", args: ["bad;q=nope"], error: "invalid weight"}
      ])
    ],
    doc: {
      symbols: ["options.minimum", "invalid weight"],
      baseFacts: ["omitted weight is 1", "returns null when none remain", "invalid weight"],
      forbiddenClaims: ["wildcard negotiation", "locale-aware matching", "automatic compression"]
    }
  }),
  moduleFixture({
    id: "sliding-window",
    title: "Implement configurable sliding windows",
    symbol: "buildWindows",
    docTarget: "docs/sliding-window-guide.md",
    baseRequirements: [
      "Export `buildWindows(values, options = {})`.",
      "`values` must be an array and `options.size` must be a positive integer.",
      "`options.step` must be a positive integer.",
      "Return new arrays without mutating `values`.",
      "When `options.partial` is false, omit a final short window.",
      "Invalid input throws an error containing `invalid window options`."
    ],
    variants: [
      variant("r1", ["The default step is 1 and default partial is false."], ["default step is 1", "default partial is false"], [
        {call: "buildWindows", args: [[1, 2, 3, 4], {size: 3}], expected: [[1, 2, 3], [2, 3, 4]]},
        {call: "buildWindows", args: [[1, 2, 3], {size: 2, partial: true}], expected: [[1, 2], [2, 3], [3]]},
        {call: "buildWindows", args: [[1], {size: 0}], error: "invalid window options"}
      ]),
      variant("r2", ["The default step is 2 and default partial is true."], ["default step is 2", "default partial is true"], [
        {call: "buildWindows", args: [["a", "b", "c", "d"], {size: 3}], expected: [["a", "b", "c"], ["c", "d"]]},
        {call: "buildWindows", args: [[1, 2, 3, 4], {size: 2, step: 3}], expected: [[1, 2], [4]]},
        {call: "buildWindows", args: ["no", {size: 2}], error: "invalid window options"}
      ]),
      variant("r3", ["The default step is 3 and default partial is false."], ["default step is 3", "short final windows are omitted"], [
        {call: "buildWindows", args: [[1, 2, 3, 4, 5], {size: 2}], expected: [[1, 2], [4, 5]]},
        {call: "buildWindows", args: [[1, 2, 3, 4], {size: 3, partial: true}], expected: [[1, 2, 3], [4]]},
        {call: "buildWindows", args: [[1], {size: 1, step: -1}], error: "invalid window options"}
      ])
    ],
    unchangedArgs: [0],
    doc: {
      symbols: ["options.size", "options.step", "options.partial"],
      baseFacts: ["size must be a positive integer", "values is not mutated", "invalid window options"],
      forbiddenClaims: ["lazy iterator", "streaming input", "in-place mutation"]
    }
  }),
  moduleFixture({
    id: "config-overlay",
    title: "Implement typed configuration overlays",
    symbol: "mergeConfiguration",
    docTarget: "docs/config-overlay-example.md",
    baseRequirements: [
      "Export `mergeConfiguration(base, overlay, options = {})`.",
      "Both inputs must be plain objects; otherwise throw an error containing `plain objects`.",
      "Return a new shallow object and never mutate either input.",
      "Overlay values replace base values.",
      "`options.nullPolicy` controls a `null` overlay value."
    ],
    variants: [
      variant("r1", ["The default null policy is `delete`: remove the key."], ["default null policy is delete", "returns a new shallow object"], [
        {call: "mergeConfiguration", args: [{a: 1, b: 2}, {b: null, c: 3}], expected: {a: 1, c: 3}},
        {call: "mergeConfiguration", args: [{a: 1}, {a: 2}], expected: {a: 2}},
        {call: "mergeConfiguration", args: [[], {}], error: "plain objects"}
      ]),
      variant("r2", ["The default null policy is `preserve`: keep the base value."], ["default null policy is preserve", "overlay values replace base values"], [
        {call: "mergeConfiguration", args: [{a: 1}, {a: null, b: null}], expected: {a: 1}},
        {call: "mergeConfiguration", args: [{a: 1}, {a: null}, {nullPolicy: "delete"}], expected: {}},
        {call: "mergeConfiguration", args: [{}, null], error: "plain objects"}
      ]),
      variant("r3", ["The default null policy is `reject`: throw an error containing `null overlay`."], ["default null policy is reject", "null overlay is an error"], [
        {call: "mergeConfiguration", args: [{a: 1}, {a: null}], error: "null overlay"},
        {call: "mergeConfiguration", args: [{a: 1}, {a: null}, {nullPolicy: "preserve"}], expected: {a: 1}},
        {call: "mergeConfiguration", args: [{}, {x: 4}], expected: {x: 4}}
      ])
    ],
    unchangedArgs: [0, 1],
    doc: {
      symbols: ["options.nullPolicy", "delete", "preserve", "reject"],
      baseFacts: ["inputs are not mutated", "overlay values replace base values", "plain objects"],
      forbiddenClaims: ["deep merge", "schema validation", "environment variable expansion"]
    }
  }),
  moduleFixture({
    id: "settings-upgrade",
    title: "Implement a versioned settings upgrade",
    symbol: "upgradeSettings",
    docTarget: "docs/settings-upgrade-migration.md",
    baseRequirements: [
      "Export `upgradeSettings(settings, options = {})`.",
      "Input must be a plain object; otherwise throw an error containing `settings object`.",
      "Return a new object and leave the input unchanged.",
      "Rename the variant's legacy key to its replacement only when the replacement is absent.",
      "Remove the legacy key and set the variant's version key to 2.",
      "If both legacy and replacement keys exist, throw an error containing `conflicting settings`."
    ],
    variants: [
      variant("r1", ["Rename `colour` to `color`; the version key is `schemaVersion`."], ["rename colour to color", "schemaVersion is set to 2"], [
        {call: "upgradeSettings", args: [{colour: "blue", other: true}], expected: {color: "blue", other: true, schemaVersion: 2}},
        {call: "upgradeSettings", args: [{color: "red"}], expected: {color: "red", schemaVersion: 2}},
        {call: "upgradeSettings", args: [{colour: "a", color: "b"}], error: "conflicting settings"}
      ]),
      variant("r2", ["Rename `endpointUrl` to `endpoint`; the version key is `formatVersion`."], ["rename endpointUrl to endpoint", "formatVersion is set to 2"], [
        {call: "upgradeSettings", args: [{endpointUrl: "/v1"}], expected: {endpoint: "/v1", formatVersion: 2}},
        {call: "upgradeSettings", args: [{enabled: false}], expected: {enabled: false, formatVersion: 2}},
        {call: "upgradeSettings", args: [{endpointUrl: "a", endpoint: "b"}], error: "conflicting settings"}
      ]),
      variant("r3", ["Rename `maxItems` to `limit`; the version key is `revision`."], ["rename maxItems to limit", "revision is set to 2"], [
        {call: "upgradeSettings", args: [{maxItems: 7}], expected: {limit: 7, revision: 2}},
        {call: "upgradeSettings", args: [{limit: 4, revision: 1}], expected: {limit: 4, revision: 2}},
        {call: "upgradeSettings", args: [null], error: "settings object"}
      ])
    ],
    unchangedArgs: [0],
    doc: {
      symbols: ["upgradeSettings", "conflicting settings"],
      baseFacts: ["replacement is absent", "legacy key is removed", "conflicting settings"],
      forbiddenClaims: ["file system migration", "automatic backup", "downgrade support"]
    }
  }),
  moduleFixture({
    id: "retry-budget",
    title: "Implement a budget-aware retry planner",
    symbol: "planRetries",
    docTarget: "docs/retry-budget-cookbook.md",
    baseRequirements: [
      "Export `planRetries(delays, options = {})`.",
      "`delays` must contain non-negative finite numbers.",
      "Return the longest prefix whose cumulative delay fits the budget.",
      "Return `{delays, spent, remaining}` without mutating input.",
      "Invalid input throws an error containing `invalid retry plan`."
    ],
    variants: [
      variant("r1", ["Default budget is 1000 and an exactly exhausted budget is allowed."], ["default budget is 1000", "exact exhaustion is allowed"], [
        {call: "planRetries", args: [[200, 300, 600]], expected: {delays: [200, 300], spent: 500, remaining: 500}},
        {call: "planRetries", args: [[400, 600]], expected: {delays: [400, 600], spent: 1000, remaining: 0}},
        {call: "planRetries", args: [[-1]], error: "invalid retry plan"}
      ]),
      variant("r2", ["Default budget is 750 and an exactly exhausted budget is allowed."], ["default budget is 750", "returns the longest prefix"], [
        {call: "planRetries", args: [[250, 500, 1]], expected: {delays: [250, 500], spent: 750, remaining: 0}},
        {call: "planRetries", args: [[800]], expected: {delays: [], spent: 0, remaining: 750}},
        {call: "planRetries", args: [["5"]], error: "invalid retry plan"}
      ]),
      variant("r3", ["Default budget is 500 and exact exhaustion is excluded unless `options.includeExact` is true."], ["default budget is 500", "options.includeExact enables exact exhaustion"], [
        {call: "planRetries", args: [[200, 300]], expected: {delays: [200], spent: 200, remaining: 300}},
        {call: "planRetries", args: [[200, 300], {includeExact: true}], expected: {delays: [200, 300], spent: 500, remaining: 0}},
        {call: "planRetries", args: [[100], {budget: -1}], error: "invalid retry plan"}
      ])
    ],
    unchangedArgs: [0],
    doc: {
      symbols: ["options.budget", "options.includeExact", "spent", "remaining"],
      baseFacts: ["longest prefix", "input is not mutated", "invalid retry plan"],
      forbiddenClaims: ["network retries", "sleep scheduling", "random jitter"]
    }
  }),
  moduleFixture({
    id: "path-rewrite",
    title: "Implement ordered path rewriting",
    symbol: "rewritePath",
    docTarget: "docs/path-rewrite-guide.md",
    baseRequirements: [
      "Export `rewritePath(path, rules, options = {})`.",
      "Each rule is `{from, to}` and matches only a path-segment prefix.",
      "A match replaces the prefix and preserves the remaining suffix.",
      "Invalid path or rules throw an error containing `invalid rewrite`.",
      "Rules are evaluated in array order."
    ],
    variants: [
      variant("r1", ["Default mode is `first`; stop after the first matching rule."], ["default mode is first", "rules use array order"], [
        {call: "rewritePath", args: ["/api/v1/users", [{from: "/api", to: "/svc"}, {from: "/svc", to: "/internal"}]], expected: "/svc/v1/users"},
        {call: "rewritePath", args: ["/apple", [{from: "/app", to: "/x"}]], expected: "/apple"},
        {call: "rewritePath", args: ["x", []], error: "invalid rewrite"}
      ]),
      variant("r2", ["Default mode is `all`; continue applying later rules to the rewritten path."], ["default mode is all", "matching preserves the suffix"], [
        {call: "rewritePath", args: ["/api/v2", [{from: "/api", to: "/svc"}, {from: "/svc", to: "/internal"}]], expected: "/internal/v2"},
        {call: "rewritePath", args: ["/x", [{from: "/none", to: "/y"}]], expected: "/x"},
        {call: "rewritePath", args: ["/x", [{from: "", to: "/y"}]], error: "invalid rewrite"}
      ]),
      variant("r3", ["Default mode is `first`; `options.caseSensitive` defaults to false."], ["matching is case-insensitive by default", "options.caseSensitive can require exact case"], [
        {call: "rewritePath", args: ["/API/items", [{from: "/api", to: "/svc"}]], expected: "/svc/items"},
        {call: "rewritePath", args: ["/API/items", [{from: "/api", to: "/svc"}], {caseSensitive: true}], expected: "/API/items"},
        {call: "rewritePath", args: ["/api", null], error: "invalid rewrite"}
      ])
    ],
    doc: {
      symbols: ["rules", "options.mode", "options.caseSensitive"],
      baseFacts: ["path-segment prefix", "rules are evaluated in array order", "invalid rewrite"],
      forbiddenClaims: ["regular expressions", "glob patterns", "file system changes"]
    }
  }),
  cliFixture({
    id: "table-project-cli",
    title: "Implement a delimited-table projection CLI",
    docTarget: "docs/table-project-command.md",
    baseRequirements: [
      "Read delimited rows from stdin and write projected rows to stdout.",
      "Require `--columns <comma-separated zero-based indexes>`.",
      "Preserve input row order and requested column order.",
      "Malformed indexes or short rows write `invalid table input` to stderr and exit 2.",
      "Support `--delimiter <character>`."
    ],
    variants: [
      variant("r1", ["Default delimiter is comma and `--header` treats the first row normally."], ["default delimiter is comma", "--columns uses zero-based indexes"], [
        {args: ["--columns", "1,0"], stdin: "a,b\nc,d\n", exit: 0, stdout: "b,a\nd,c\n", stderr: ""},
        {args: ["--columns", "2"], stdin: "a,b\n", exit: 2, stdout: "", stderr: "invalid table input\n"},
        {args: [], stdin: "", exit: 2, stdout: "", stderr: "invalid table input\n"}
      ]),
      variant("r2", ["Default delimiter is tab and `--header` treats the first row normally."], ["default delimiter is tab", "requested column order is preserved"], [
        {args: ["--columns", "0"], stdin: "a\tb\nc\td\n", exit: 0, stdout: "a\nc\n", stderr: ""},
        {args: ["--columns", "1", "--delimiter", "|"], stdin: "a|b\n", exit: 0, stdout: "b\n", stderr: ""},
        {args: ["--columns", "x"], stdin: "", exit: 2, stdout: "", stderr: "invalid table input\n"}
      ]),
      variant("r3", ["Default delimiter is semicolon; `--header` emits the projected first row followed by data."], ["default delimiter is semicolon", "--header includes the projected first row"], [
        {args: ["--columns", "1", "--header"], stdin: "name;age\nAda;37\n", exit: 0, stdout: "age\n37\n", stderr: ""},
        {args: ["--columns", "0"], stdin: "a;b\n", exit: 0, stdout: "a\n", stderr: ""},
        {args: ["--columns", "-1"], stdin: "", exit: 2, stdout: "", stderr: "invalid table input\n"}
      ])
    ],
    doc: {
      symbols: ["--columns", "--delimiter", "--header"],
      baseFacts: ["zero-based indexes", "invalid table input", "exit 2"],
      forbiddenClaims: ["CSV quoting", "automatic type conversion", "file output"]
    }
  }),
  cliFixture({
    id: "token-audit-cli",
    title: "Implement a token audit CLI",
    docTarget: "docs/token-audit-command.md",
    baseRequirements: [
      "Read one JSON array of strings from stdin.",
      "Filter tokens by `--prefix <text>` and `--min-length <integer>`.",
      "Write either one token per line or one JSON array according to `--format text|json`.",
      "Invalid JSON, non-string entries, or invalid options write `invalid token input` to stderr and exit 2.",
      "`--require-match` exits 3 with no stdout when no token remains."
    ],
    variants: [
      variant("r1", ["Default prefix is empty, minimum length is 1, and format is `text`."], ["default format is text", "default minimum length is 1"], [
        {args: ["--prefix", "al"], stdin: "[\"alpha\",\"beta\",\"al\"]", exit: 0, stdout: "alpha\nal\n", stderr: ""},
        {args: ["--min-length", "5", "--format", "json"], stdin: "[\"one\",\"three\"]", exit: 0, stdout: "[\"three\"]\n", stderr: ""},
        {args: [], stdin: "{}", exit: 2, stdout: "", stderr: "invalid token input\n"}
      ]),
      variant("r2", ["Default prefix is `@`, minimum length is 2, and format is `json`."], ["default prefix is @", "default format is json"], [
        {args: [], stdin: "[\"@a\",\"@ok\",\"plain\"]", exit: 0, stdout: "[\"@a\",\"@ok\"]\n", stderr: ""},
        {args: ["--prefix", "x", "--format", "text"], stdin: "[\"x1\",\"y2\"]", exit: 0, stdout: "x1\n", stderr: ""},
        {args: ["--min-length", "-1"], stdin: "[]", exit: 2, stdout: "", stderr: "invalid token input\n"}
      ]),
      variant("r3", ["Default prefix is empty, minimum length is 4, and format is `text`."], ["default minimum length is 4", "--require-match exits 3"], [
        {args: [], stdin: "[\"one\",\"four\",\"seven\"]", exit: 0, stdout: "four\nseven\n", stderr: ""},
        {args: ["--prefix", "z", "--require-match"], stdin: "[\"alpha\"]", exit: 3, stdout: "", stderr: ""},
        {args: ["--format", "xml"], stdin: "[]", exit: 2, stdout: "", stderr: "invalid token input\n"}
      ])
    ],
    doc: {
      symbols: ["--prefix", "--min-length", "--format", "--require-match"],
      baseFacts: ["JSON array of strings", "invalid token input", "exit 2"],
      forbiddenClaims: ["regular expression filtering", "token decryption", "remote audit"]
    }
  })
];

export const pilotFixtures = [
  moduleFixture({
    id: "label-fold",
    title: "Implement label folding",
    symbol: "foldLabel",
    docTarget: "docs/label-fold-guide.md",
    baseRequirements: [
      "Export `foldLabel(value)`.",
      "Trim outer whitespace, lowercase ASCII letters, and replace each run of spaces or underscores with one dash.",
      "Reject a non-string or empty result with an error containing `invalid label`."
    ],
    variants: [variant("p1", ["Digits are preserved."], ["digits are preserved", "spaces and underscores become one dash"], [
      {call: "foldLabel", args: ["  Build__42 Ready "], expected: "build-42-ready"},
      {call: "foldLabel", args: ["___"], error: "invalid label"}
    ])],
    doc: {
      symbols: ["invalid label"],
      baseFacts: ["outer whitespace", "invalid label"],
      forbiddenClaims: ["Unicode transliteration", "URL encoding"]
    }
  }),
  cliFixture({
    id: "sum-lines-cli",
    title: "Implement a numeric line sum CLI",
    docTarget: "docs/sum-lines-command.md",
    baseRequirements: [
      "Read newline-separated finite numbers from stdin and print their sum plus a newline.",
      "Ignore blank lines.",
      "`--precision <integer>` controls fixed decimal places.",
      "Invalid input writes `invalid number` to stderr and exits 2."
    ],
    variants: [variant("p1", ["Default precision is 2."], ["default precision is 2", "blank lines are ignored"], [
      {args: [], stdin: "1\n2.5\n\n", exit: 0, stdout: "3.50\n", stderr: ""},
      {args: [], stdin: "x\n", exit: 2, stdout: "", stderr: "invalid number\n"}
    ])],
    doc: {
      symbols: ["--precision"],
      baseFacts: ["newline-separated finite numbers", "invalid number", "exit 2"],
      forbiddenClaims: ["currency conversion", "file input"]
    }
  }),
  moduleFixture({
    id: "environment-pick",
    title: "Implement environment key selection",
    symbol: "pickEnvironment",
    docTarget: "docs/environment-pick-example.md",
    baseRequirements: [
      "Export `pickEnvironment(environment, prefix)`.",
      "Return a new object containing keys beginning with the prefix, with that prefix removed.",
      "Reject invalid objects or an empty prefix with an error containing `invalid environment selection`."
    ],
    variants: [variant("p1", ["Key matching is case-sensitive."], ["matching is case-sensitive", "the prefix is removed"], [
      {call: "pickEnvironment", args: [{APP_PORT: "80", APP_MODE: "dev", app_x: "n"}, "APP_"], expected: {PORT: "80", MODE: "dev"}},
      {call: "pickEnvironment", args: [{}, ""], error: "invalid environment selection"}
    ])],
    unchangedArgs: [0],
    doc: {
      symbols: ["prefix"],
      baseFacts: ["returns a new object", "invalid environment selection"],
      forbiddenClaims: ["process.env mutation", "case-insensitive matching"]
    }
  }),
  moduleFixture({
    id: "chunk-view",
    title: "Implement fixed chunk views",
    symbol: "chunkView",
    docTarget: "docs/chunk-view-guide.md",
    baseRequirements: [
      "Export `chunkView(values, size)`.",
      "Return consecutive copied arrays, including a final short chunk.",
      "Reject non-arrays or non-positive integer sizes with an error containing `invalid chunk`."
    ],
    variants: [variant("p1", ["An empty input returns an empty array."], ["final short chunk is included", "empty input returns an empty array"], [
      {call: "chunkView", args: [[1, 2, 3, 4, 5], 2], expected: [[1, 2], [3, 4], [5]]},
      {call: "chunkView", args: [[], 2], expected: []},
      {call: "chunkView", args: [[1], 0], error: "invalid chunk"}
    ])],
    unchangedArgs: [0],
    doc: {
      symbols: ["size"],
      baseFacts: ["consecutive copied arrays", "invalid chunk"],
      forbiddenClaims: ["lazy chunks", "input mutation"]
    }
  }),
  cliFixture({
    id: "color-map-cli",
    title: "Implement a color map CLI",
    docTarget: "docs/color-map-command.md",
    baseRequirements: [
      "Accept color names as positional arguments.",
      "Write one `name=hex` line per recognized color.",
      "`--strict` makes an unknown color write `unknown color` to stderr and exit 2.",
      "Without `--strict`, silently omit unknown colors."
    ],
    variants: [variant("p1", ["Recognize `red=#ff0000`, `green=#00ff00`, and `blue=#0000ff`."], ["red is #ff0000", "--strict exits 2 for unknown colors"], [
      {args: ["red", "blue"], stdin: "", exit: 0, stdout: "red=#ff0000\nblue=#0000ff\n", stderr: ""},
      {args: ["--strict", "purple"], stdin: "", exit: 2, stdout: "", stderr: "unknown color\n"}
    ])],
    doc: {
      symbols: ["--strict"],
      baseFacts: ["name=hex", "unknown colors are omitted"],
      forbiddenClaims: ["CSS parsing", "custom palettes"]
    }
  }),
  moduleFixture({
    id: "config-alias",
    title: "Implement configuration aliases",
    symbol: "applyAliases",
    docTarget: "docs/config-alias-migration.md",
    baseRequirements: [
      "Export `applyAliases(config, aliases)`.",
      "Return a new object where an old key moves to its alias target only when the target is absent.",
      "Remove moved old keys.",
      "Reject conflicting old and target keys with an error containing `alias conflict`."
    ],
    variants: [variant("p1", ["Aliases are a plain object mapping old keys to target keys."], ["aliases map old keys to target keys", "conflicts throw alias conflict"], [
      {call: "applyAliases", args: [{old: 1, keep: 2}, {old: "new"}], expected: {new: 1, keep: 2}},
      {call: "applyAliases", args: [{old: 1, new: 2}, {old: "new"}], error: "alias conflict"}
    ])],
    unchangedArgs: [0, 1],
    doc: {
      symbols: ["aliases", "alias conflict"],
      baseFacts: ["returns a new object", "remove moved old keys"],
      forbiddenClaims: ["nested keys", "schema migration"]
    }
  })
];

export function allFixtureVariants() {
  return [
    ...mainFixtures.flatMap((fixture) =>
      fixture.variants.map((item) => ({fixture, variant: item, phase: "main"}))),
    ...pilotFixtures.flatMap((fixture) =>
      fixture.variants.map((item) => ({fixture, variant: item, phase: "pilot"})))
  ];
}
