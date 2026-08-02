const moduleStarter = (exports) => `${exports.map((name) =>
  `export function ${name}() {\n  throw new Error("Not implemented");\n}`).join("\n")}`;

const cliStarter = `#!/usr/bin/env node
process.stderr.write("Not implemented\\n");
process.exitCode = 2;
`;

function variants(entries) {
  return entries.map((entry, index) => ({id: `v${index + 1}`, ...entry}));
}

export const mainFixtures = [
  {
    id: "cursor-pagination",
    title: "Add cursor-based pagination to a record library",
    kind: "module",
    sourcePath: "src/index.mjs",
    docTarget: "docs/pagination-guide.md",
    starter: moduleStarter(["paginateRecords"]),
    baseRequirements: [
      "Export paginateRecords(records, options = {}) from src/index.mjs.",
      "Return { items, nextCursor }; never mutate records.",
      "Reject non-array records, non-positive integer limits, and malformed cursors."
    ],
    doc: {
      headings: ["Overview", "API", "Examples", "Errors"],
      symbols: ["paginateRecords", "nextCursor"],
      minExecutable: 2,
      forbiddenClaims: ["network request", "database query", "async iterator"]
    },
    variants: variants([
      {
        requirements: ["The default limit is 2.", "Cursors use the opaque c:<zero-based-index> form."],
        facts: ["default limit is 2", "c:"],
        checks: [
          {call: "paginateRecords", args: [[1, 2, 3, 4], {}], expected: {items: [1, 2], nextCursor: "c:2"}},
          {call: "paginateRecords", args: [[1, 2, 3, 4], {cursor: "c:2"}], expected: {items: [3, 4], nextCursor: null}},
          {call: "paginateRecords", args: ["bad"], error: "array"}
        ]
      },
      {
        requirements: ["The default limit is 3.", "Cursors use the opaque p:<zero-based-index> form."],
        facts: ["default limit is 3", "p:"],
        checks: [
          {call: "paginateRecords", args: [["a", "b", "c", "d"], {}], expected: {items: ["a", "b", "c"], nextCursor: "p:3"}},
          {call: "paginateRecords", args: [["a", "b", "c", "d"], {limit: 1, cursor: "p:3"}], expected: {items: ["d"], nextCursor: null}},
          {call: "paginateRecords", args: [[], {cursor: "c:1"}], error: "cursor"}
        ]
      },
      {
        requirements: ["The default limit is 4.", "Cursors use the opaque next:<zero-based-index> form."],
        facts: ["default limit is 4", "next:"],
        checks: [
          {call: "paginateRecords", args: [[0, 1, 2, 3, 4], {}], expected: {items: [0, 1, 2, 3], nextCursor: "next:4"}},
          {call: "paginateRecords", args: [[0, 1, 2, 3, 4], {cursor: "next:4"}], expected: {items: [4], nextCursor: null}},
          {call: "paginateRecords", args: [[1], {limit: 0}], error: "limit"}
        ]
      }
    ])
  },
  {
    id: "retry-schedule",
    title: "Add deterministic retry scheduling",
    kind: "module",
    sourcePath: "src/index.mjs",
    docTarget: "docs/retry-cookbook.md",
    starter: moduleStarter(["retrySchedule"]),
    baseRequirements: [
      "Export retrySchedule(options) from src/index.mjs.",
      "Return delay milliseconds before each retry, excluding the initial attempt.",
      "Require attempts and baseMs to be positive integers."
    ],
    doc: {
      headings: ["Overview", "API", "Recipes", "Errors"],
      symbols: ["retrySchedule", "attempts", "baseMs"],
      minExecutable: 2,
      forbiddenClaims: ["performs retries", "sleeps", "adds jitter"]
    },
    variants: variants([
      {
        requirements: ["Use exponential growth and cap each delay at 8000 ms."],
        facts: ["exponential", "8000"],
        checks: [
          {call: "retrySchedule", args: [{attempts: 4, baseMs: 500}], expected: [500, 1000, 2000]},
          {call: "retrySchedule", args: [{attempts: 6, baseMs: 2000}], expected: [2000, 4000, 8000, 8000, 8000]}
        ]
      },
      {
        requirements: ["Use linear growth and cap each delay at 5000 ms."],
        facts: ["linear", "5000"],
        checks: [
          {call: "retrySchedule", args: [{attempts: 4, baseMs: 700}], expected: [700, 1400, 2100]},
          {call: "retrySchedule", args: [{attempts: 5, baseMs: 2000}], expected: [2000, 4000, 5000, 5000]}
        ]
      },
      {
        requirements: ["Use constant delays and cap each delay at 3000 ms."],
        facts: ["constant", "3000"],
        checks: [
          {call: "retrySchedule", args: [{attempts: 3, baseMs: 1200}], expected: [1200, 1200]},
          {call: "retrySchedule", args: [{attempts: 3, baseMs: 5000}], expected: [3000, 3000]}
        ]
      }
    ])
  },
  {
    id: "route-template",
    title: "Add route-template matching",
    kind: "module",
    sourcePath: "src/index.mjs",
    docTarget: "docs/route-matching.md",
    starter: moduleStarter(["matchRoute"]),
    baseRequirements: [
      "Export matchRoute(template, path) from src/index.mjs.",
      "A :name segment captures one path segment and returns a decoded params object.",
      "Return null for no match and reject duplicate parameter names."
    ],
    doc: {
      headings: ["Overview", "API", "Examples", "Errors"],
      symbols: ["matchRoute", "template", "params"],
      minExecutable: 2,
      forbiddenClaims: ["wildcard", "regular expression syntax", "query-string parser"]
    },
    variants: variants([
      {
        requirements: ["Literal segments are case-sensitive.", "A single trailing slash is ignored."],
        facts: ["case-sensitive", "trailing slash"],
        checks: [
          {call: "matchRoute", args: ["/users/:id", "/users/a%20b/"], expected: {id: "a b"}},
          {call: "matchRoute", args: ["/Users/:id", "/users/7"], expected: null}
        ]
      },
      {
        requirements: ["Literal segments are case-insensitive.", "A trailing slash is significant."],
        facts: ["case-insensitive", "trailing slash is significant"],
        checks: [
          {call: "matchRoute", args: ["/Users/:id", "/users/7"], expected: {id: "7"}},
          {call: "matchRoute", args: ["/users/:id", "/users/7/"], expected: null}
        ]
      },
      {
        requirements: ["Literal segments are case-sensitive.", "A trailing slash is significant."],
        facts: ["case-sensitive", "trailing slash is significant"],
        checks: [
          {call: "matchRoute", args: ["/team/:team/member/:id", "/team/core/member/9"], expected: {team: "core", id: "9"}},
          {call: "matchRoute", args: ["/team/:id/:id", "/team/a/b"], error: "duplicate"}
        ]
      }
    ])
  },
  {
    id: "configuration-migration",
    title: "Add a configuration migration API",
    kind: "module",
    sourcePath: "src/index.mjs",
    docTarget: "docs/configuration-migration.md",
    starter: moduleStarter(["migrateConfig"]),
    baseRequirements: [
      "Export migrateConfig(v1) from src/index.mjs.",
      "Return a new version: 2 object without mutating the v1 input.",
      "Reject input whose version is not 1."
    ],
    doc: {
      headings: ["Overview", "Migration", "Examples", "Compatibility"],
      symbols: ["migrateConfig", "version"],
      minExecutable: 2,
      forbiddenClaims: ["writes the file", "backward compatible with version 3", "automatic rollback"]
    },
    variants: variants([
      {
        requirements: ["Rename host to server.hostname and port to server.port.", "Default missing port to 8080."],
        facts: ["server.hostname", "8080"],
        checks: [
          {call: "migrateConfig", args: [{version: 1, host: "api", port: 9000}], expected: {version: 2, server: {hostname: "api", port: 9000}}},
          {call: "migrateConfig", args: [{version: 1, host: "api"}], expected: {version: 2, server: {hostname: "api", port: 8080}}}
        ]
      },
      {
        requirements: ["Rename endpoint to service.url and timeoutMs to service.timeout.", "Default missing timeoutMs to 5000."],
        facts: ["service.url", "5000"],
        checks: [
          {call: "migrateConfig", args: [{version: 1, endpoint: "https://x", timeoutMs: 10}], expected: {version: 2, service: {url: "https://x", timeout: 10}}},
          {call: "migrateConfig", args: [{version: 1, endpoint: "https://x"}], expected: {version: 2, service: {url: "https://x", timeout: 5000}}}
        ]
      },
      {
        requirements: ["Rename logLevel to logging.level and jsonLogs to logging.format.", "Map jsonLogs true to json and false or missing to text."],
        facts: ["logging.level", "jsonLogs", "text"],
        checks: [
          {call: "migrateConfig", args: [{version: 1, logLevel: "debug", jsonLogs: true}], expected: {version: 2, logging: {level: "debug", format: "json"}}},
          {call: "migrateConfig", args: [{version: 1, logLevel: "info"}], expected: {version: 2, logging: {level: "info", format: "text"}}}
        ]
      }
    ])
  },
  {
    id: "duration-parser",
    title: "Add strict duration parsing",
    kind: "module",
    sourcePath: "src/index.mjs",
    docTarget: "docs/duration-api.md",
    starter: moduleStarter(["parseDuration"]),
    baseRequirements: [
      "Export parseDuration(value) from src/index.mjs.",
      "Return an integer number of milliseconds.",
      "Reject whitespace, decimals, negative values, unknown units, and unsafe integers."
    ],
    doc: {
      headings: ["Overview", "API", "Examples", "Invalid input"],
      symbols: ["parseDuration", "milliseconds"],
      minExecutable: 2,
      forbiddenClaims: ["ISO 8601", "decimal", "negative duration"]
    },
    variants: variants([
      {
        requirements: ["Accept only integer values suffixed ms, s, or m."],
        facts: ["suffixed ms, s, or m"],
        checks: [
          {call: "parseDuration", args: ["250ms"], expected: 250},
          {call: "parseDuration", args: ["3m"], expected: 180000},
          {call: "parseDuration", args: ["1.5s"], error: "duration"}
        ]
      },
      {
        requirements: ["Accept only integer values suffixed s, m, or h."],
        facts: ["suffixed s, m, or h"],
        checks: [
          {call: "parseDuration", args: ["2h"], expected: 7200000},
          {call: "parseDuration", args: ["30s"], expected: 30000},
          {call: "parseDuration", args: ["1ms"], error: "unit"}
        ]
      },
      {
        requirements: ["Accept only integer values suffixed ms or s; a bare integer string means milliseconds."],
        facts: ["bare integer", "milliseconds"],
        checks: [
          {call: "parseDuration", args: ["99"], expected: 99},
          {call: "parseDuration", args: ["2s"], expected: 2000},
          {call: "parseDuration", args: ["1m"], error: "unit"}
        ]
      }
    ])
  },
  {
    id: "batch-planner",
    title: "Add bounded batch planning",
    kind: "module",
    sourcePath: "src/index.mjs",
    docTarget: "docs/batch-planner-cookbook.md",
    starter: moduleStarter(["planBatches"]),
    baseRequirements: [
      "Export planBatches(items, options) from src/index.mjs.",
      "Return a new array of batches without mutating items.",
      "Reject invalid capacities and items whose weight exceeds capacity."
    ],
    doc: {
      headings: ["Overview", "API", "Cookbook", "Errors"],
      symbols: ["planBatches", "capacity", "weight"],
      minExecutable: 2,
      forbiddenClaims: ["runs concurrently", "uploads", "reorders for optimization"]
    },
    variants: variants([
      {
        requirements: ["Use item.size as weight and preserve input order.", "Default capacity is 10."],
        facts: ["item.size", "default capacity is 10"],
        checks: [
          {call: "planBatches", args: [[{size: 6}, {size: 4}, {size: 5}], {}], expected: [[{size: 6}, {size: 4}], [{size: 5}]]},
          {call: "planBatches", args: [[{size: 11}], {}], error: "capacity"}
        ]
      },
      {
        requirements: ["Use item.weight as weight and preserve input order.", "Default capacity is 8."],
        facts: ["item.weight", "default capacity is 8"],
        checks: [
          {call: "planBatches", args: [[{weight: 3}, {weight: 4}, {weight: 2}], {}], expected: [[{weight: 3}, {weight: 4}], [{weight: 2}]]},
          {call: "planBatches", args: [[{weight: 4}, {weight: 4}], {capacity: 4}], expected: [[{weight: 4}], [{weight: 4}]]}
        ]
      },
      {
        requirements: ["Use item.cost as weight and preserve input order.", "Capacity is required with no default."],
        facts: ["item.cost", "capacity is required"],
        checks: [
          {call: "planBatches", args: [[{cost: 2}, {cost: 5}, {cost: 1}], {capacity: 6}], expected: [[{cost: 2}], [{cost: 5}, {cost: 1}]]},
          {call: "planBatches", args: [[{cost: 1}], {}], error: "capacity"}
        ]
      }
    ])
  },
  {
    id: "config-inspect-cli",
    title: "Add a configuration inspection CLI",
    kind: "cli",
    sourcePath: "src/cli.mjs",
    docTarget: "docs/config-inspect-command.md",
    starter: cliStarter,
    baseRequirements: [
      "Implement node src/cli.mjs config inspect [options].",
      "Print one compact JSON object and a trailing newline to stdout.",
      "Unknown options and invalid values exit 2 with a concise stderr message."
    ],
    doc: {
      headings: ["Synopsis", "Options", "Examples", "Exit codes"],
      symbols: ["config inspect", "--format"],
      minExecutable: 2,
      forbiddenClaims: ["writes configuration", "reads a configuration file", "contacts a server"]
    },
    variants: variants([
      {
        requirements: ["Support --format json only and --port <integer>.", "Port defaults to 3000."],
        facts: ["--port", "defaults to 3000"],
        checks: [
          {args: ["config", "inspect", "--format", "json"], stdout: "{\"port\":3000}\n", exit: 0},
          {args: ["config", "inspect", "--format", "json", "--port", "4100"], stdout: "{\"port\":4100}\n", exit: 0}
        ]
      },
      {
        requirements: ["Support --format json only and --level <name>.", "Level defaults to info."],
        facts: ["--level", "defaults to info"],
        checks: [
          {args: ["config", "inspect", "--format", "json"], stdout: "{\"level\":\"info\"}\n", exit: 0},
          {args: ["config", "inspect", "--format", "json", "--level", "debug"], stdout: "{\"level\":\"debug\"}\n", exit: 0}
        ]
      },
      {
        requirements: ["Support --format json only and repeatable --tag <value>.", "Tags preserve command-line order."],
        facts: ["repeatable --tag", "command-line order"],
        checks: [
          {args: ["config", "inspect", "--format", "json"], stdout: "{\"tags\":[]}\n", exit: 0},
          {args: ["config", "inspect", "--format", "json", "--tag", "a", "--tag", "b"], stdout: "{\"tags\":[\"a\",\"b\"]}\n", exit: 0}
        ]
      }
    ])
  },
  {
    id: "json-redact-cli",
    title: "Add a streaming JSON redaction CLI",
    kind: "cli",
    sourcePath: "src/cli.mjs",
    docTarget: "docs/json-redact-command.md",
    starter: cliStarter,
    baseRequirements: [
      "Implement node src/cli.mjs redact [options].",
      "Read one JSON object from stdin, redact configured top-level keys, and print compact JSON plus newline.",
      "Invalid JSON, missing option values, and unknown options exit 2."
    ],
    doc: {
      headings: ["Synopsis", "Options", "Examples", "Exit codes"],
      symbols: ["redact", "stdin"],
      minExecutable: 2,
      forbiddenClaims: ["nested keys", "regular expressions", "modifies the input file"]
    },
    variants: variants([
      {
        requirements: ["Use repeatable --key <name>.", "Replacement text is [REDACTED]."],
        facts: ["repeatable --key", "[REDACTED]"],
        checks: [
          {args: ["redact", "--key", "token"], stdin: "{\"token\":\"x\",\"ok\":1}", stdout: "{\"token\":\"[REDACTED]\",\"ok\":1}\n", exit: 0},
          {args: ["redact", "--key", "a", "--key", "b"], stdin: "{\"a\":1,\"b\":2}", stdout: "{\"a\":\"[REDACTED]\",\"b\":\"[REDACTED]\"}\n", exit: 0}
        ]
      },
      {
        requirements: ["Use comma-separated --keys <names>.", "Replacement text is ***."],
        facts: ["--keys", "***"],
        checks: [
          {args: ["redact", "--keys", "secret"], stdin: "{\"secret\":true,\"ok\":1}", stdout: "{\"secret\":\"***\",\"ok\":1}\n", exit: 0},
          {args: ["redact", "--keys", "a,b"], stdin: "{\"a\":1,\"b\":2}", stdout: "{\"a\":\"***\",\"b\":\"***\"}\n", exit: 0}
        ]
      },
      {
        requirements: ["Use repeatable --remove <name>.", "Remove matching keys instead of replacing their values."],
        facts: ["repeatable --remove", "remove matching keys"],
        checks: [
          {args: ["redact", "--remove", "token"], stdin: "{\"token\":\"x\",\"ok\":1}", stdout: "{\"ok\":1}\n", exit: 0},
          {args: ["redact", "--remove", "a", "--remove", "b"], stdin: "{\"a\":1,\"b\":2,\"c\":3}", stdout: "{\"c\":3}\n", exit: 0}
        ]
      }
    ])
  }
];

export const pilotFixtures = [
  {
    id: "pilot-slug-codec",
    title: "Add a strict slug codec",
    kind: "module",
    sourcePath: "src/index.mjs",
    docTarget: "docs/slug-codec.md",
    starter: moduleStarter(["toSlug"]),
    baseRequirements: ["Export toSlug(value).", "Lowercase ASCII words and join them with a hyphen.", "Reject empty results."],
    doc: {
      headings: ["Overview", "API", "Examples", "Errors"],
      symbols: ["toSlug"],
      minExecutable: 1,
      forbiddenClaims: ["Unicode transliteration", "URL encoding"]
    },
    variants: variants([{
      requirements: ["Collapse repeated whitespace before joining words."],
      facts: ["repeated whitespace"],
      checks: [
        {call: "toSlug", args: ["Hello   Pilot"], expected: "hello-pilot"},
        {call: "toSlug", args: ["---"], error: "empty"}
      ]
    }])
  },
  {
    id: "pilot-greet-cli",
    title: "Add a deterministic greeting CLI",
    kind: "cli",
    sourcePath: "src/cli.mjs",
    docTarget: "docs/greet-command.md",
    starter: cliStarter,
    baseRequirements: ["Implement node src/cli.mjs greet --name <value>.", "Print one greeting and a newline.", "Missing names exit 2."],
    doc: {
      headings: ["Synopsis", "Options", "Examples", "Exit codes"],
      symbols: ["greet", "--name"],
      minExecutable: 1,
      forbiddenClaims: ["network", "localization"]
    },
    variants: variants([{
      requirements: ["The exact successful output is Hello, <value>!."],
      facts: ["Hello"],
      checks: [{args: ["greet", "--name", "Pilot"], stdout: "Hello, Pilot!\n", exit: 0}]
    }])
  }
];

export function allFixtureVariants() {
  return [
    ...mainFixtures.flatMap((fixture) => fixture.variants.map((variant) => ({phase: "main", fixture, variant}))),
    ...pilotFixtures.flatMap((fixture) => fixture.variants.map((variant) => ({phase: "pilot", fixture, variant})))
  ];
}
