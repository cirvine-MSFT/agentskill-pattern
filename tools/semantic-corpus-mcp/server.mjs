#!/usr/bin/env node

import { createInterface } from "node:readline";
import {
  callTool,
  CorpusError,
  CorpusService,
  TOOL_DEFINITIONS,
} from "./lib.mjs";

const service = new CorpusService();

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function result(id, value) {
  send({ jsonrpc: "2.0", id, result: value });
}

function protocolError(id, code, message, data) {
  send({
    jsonrpc: "2.0",
    id: id ?? null,
    error: { code, message, ...(data === undefined ? {} : { data }) },
  });
}

async function dispatch(message) {
  if (
    message === null ||
    typeof message !== "object" ||
    Array.isArray(message) ||
    message.jsonrpc !== "2.0" ||
    typeof message.method !== "string"
  ) {
    protocolError(message?.id, -32600, "Invalid Request");
    return;
  }

  const { id, method, params = {} } = message;
  if (method === "notifications/initialized" || method.startsWith("notifications/")) {
    return;
  }
  if (id === undefined) {
    return;
  }

  switch (method) {
    case "initialize":
      result(id, {
        protocolVersion: "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "semantic-corpus", version: "1.0.0" },
      });
      return;
    case "ping":
      result(id, {});
      return;
    case "tools/list":
      result(id, { tools: TOOL_DEFINITIONS });
      return;
    case "tools/call": {
      if (
        params === null ||
        typeof params !== "object" ||
        Array.isArray(params) ||
        typeof params.name !== "string"
      ) {
        protocolError(id, -32602, "Invalid params");
        return;
      }
      try {
        const value = await callTool(service, params.name, params.arguments ?? {});
        result(id, {
          content: [{ type: "text", text: JSON.stringify(value) }],
          structuredContent: value,
          isError: false,
        });
      } catch (error) {
        const code = error instanceof CorpusError ? error.code : "INTERNAL_ERROR";
        const messageText =
          error instanceof CorpusError ? error.message : "The corpus tool failed unexpectedly";
        if (code === "SCHEMA_ERROR" || code === "TOOL_NOT_FOUND") {
          protocolError(id, -32602, messageText, { code });
          return;
        }
        result(id, {
          content: [
            {
              type: "text",
              text: JSON.stringify({ error: { code, message: messageText } }),
            },
          ],
          isError: true,
        });
      }
      return;
    }
    default:
      protocolError(id, -32601, "Method not found");
  }
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
let queue = Promise.resolve();
input.on("line", (line) => {
  queue = queue.then(async () => {
    if (Buffer.byteLength(line, "utf8") > 1024 * 1024) {
      protocolError(null, -32700, "Message exceeds 1 MiB");
      return;
    }
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      protocolError(null, -32700, "Parse error");
      return;
    }
    await dispatch(message);
  }).catch(() => {
    protocolError(null, -32603, "Internal error");
  });
});
