import { callTool, ReleaseNoteError } from "./lib.mjs";

export function createDispatcher(service, send) {
  function result(id, value) {
    send({ jsonrpc: "2.0", id, result: value });
  }

  function protocolError(id, code, message, data) {
    send({ jsonrpc: "2.0", id: id ?? null, error: { code, message, ...(data ? { data } : {}) } });
  }

  return async function dispatch(message) {
    if (
      message === null
      || typeof message !== "object"
      || Array.isArray(message)
      || message.jsonrpc !== "2.0"
      || typeof message.method !== "string"
    ) {
      protocolError(message?.id, -32600, "Invalid Request");
      return;
    }
    const { id, method, params = {} } = message;
    if (method.startsWith("notifications/") || id === undefined) return;
    if (method === "initialize") {
      result(id, {
        protocolVersion: "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "release-notes", version: "1.0.0" },
      });
      return;
    }
    if (method === "ping") {
      result(id, {});
      return;
    }
    if (method === "tools/list") {
      result(id, { tools: service.toolDefinitions });
      return;
    }
    if (method !== "tools/call") {
      protocolError(id, -32601, "Method not found");
      return;
    }
    if (
      params === null
      || typeof params !== "object"
      || Array.isArray(params)
      || typeof params.name !== "string"
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
      const code = error instanceof ReleaseNoteError ? error.code : "INTERNAL_ERROR";
      const message = error instanceof ReleaseNoteError
        ? error.message
        : "The release-note tool failed unexpectedly";
      if (["SCHEMA_ERROR", "TOOL_NOT_FOUND"].includes(code)) {
        protocolError(id, -32602, message, { code });
        return;
      }
      result(id, {
        content: [{ type: "text", text: JSON.stringify({ error: { code, message } }) }],
        isError: true,
      });
    }
  };
}
