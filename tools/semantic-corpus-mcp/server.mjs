#!/usr/bin/env node

import { writeSync } from "node:fs";
import { createInterface } from "node:readline";
import { CorpusService } from "./lib.mjs";
import { createDispatcher } from "./protocol.mjs";

let service;
try {
  service = await CorpusService.create({
    audit: async (event) => {
      writeSync(5, `${JSON.stringify(event)}\n`);
    },
  });
} catch (error) {
  const code = error?.code ?? "INTERNAL_ERROR";
  const message = error instanceof Error ? error.message : "unknown startup error";
  process.stderr.write(`${code}: ${message}\n`);
  process.exit(78);
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

const dispatch = createDispatcher(service, send);

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
let queue = Promise.resolve();
input.on("line", (line) => {
  queue = queue.then(async () => {
    if (Buffer.byteLength(line, "utf8") > 1024 * 1024) {
      send({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Message exceeds 1 MiB" },
      });
      return;
    }
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      return;
    }
    await dispatch(message);
  }).catch(() => {
    send({ jsonrpc: "2.0", id: null, error: { code: -32603, message: "Internal error" } });
  });
});

input.on("close", () => {
  queue.then(() => service.close()).catch((error) => {
    process.stderr.write(`LOCK_RELEASE_FAILED: ${error.message}\n`);
    process.exitCode = 1;
  });
});
