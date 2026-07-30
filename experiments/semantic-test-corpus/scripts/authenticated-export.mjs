import { createHash, createPublicKey, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateJsonSchema } from "../validators/json-schema.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const schemaDir = resolve(root, "schemas");
const exportSchema = JSON.parse(readFileSync(resolve(schemaDir, "platform-export.schema.json"), "utf8"));
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function parseTimestamp(value, label) {
  if (!RFC3339.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} must be an RFC 3339 UTC timestamp`);
  }
  return Date.parse(value);
}

export function authenticateExport(payloadBytes, signatureBytes, publicKeyPem) {
  const publicKey = createPublicKey(publicKeyPem);
  if (publicKey.asymmetricKeyType !== "ed25519") {
    throw new Error("Platform evidence key must be Ed25519");
  }
  if (!verify(null, payloadBytes, publicKey, signatureBytes)) {
    throw new Error("Platform evidence signature is invalid");
  }

  let payload;
  try {
    payload = JSON.parse(payloadBytes);
  } catch (error) {
    throw new Error(`Signed platform payload is not JSON: ${error.message}`);
  }
  const errors = validateJsonSchema(payload, exportSchema, { schemaDir });
  if (errors.length > 0) {
    throw new Error(`Signed platform payload failed schema validation: ${errors[0].path} ${errors[0].message}`);
  }

  const exportedAt = parseTimestamp(payload.exportedAt, "exportedAt");
  const capturedAt = parseTimestamp(payload.capturedAt, "capturedAt");
  if (capturedAt > exportedAt) throw new Error("capturedAt cannot be later than exportedAt");
  const eventIds = new Set();
  for (const event of payload.events) {
    if (eventIds.has(event.eventId)) throw new Error(`Duplicate signed eventId: ${event.eventId}`);
    eventIds.add(event.eventId);
    const timestamp = parseTimestamp(event.timestamp, `event ${event.eventId} timestamp`);
    if (timestamp > exportedAt) throw new Error(`Event ${event.eventId} occurs after exportedAt`);
  }

  const keyDer = publicKey.export({ type: "spki", format: "der" });
  return {
    payload,
    authentication: {
      algorithm: "Ed25519",
      payloadSha256: sha256(payloadBytes),
      signatureSha256: sha256(signatureBytes),
      publicKeySha256: sha256(keyDer)
    }
  };
}

export function readAuthenticatedExport({ payloadPath, signaturePath, publicKeyPath }) {
  return authenticateExport(
    readFileSync(resolve(payloadPath)),
    readFileSync(resolve(signaturePath)),
    readFileSync(resolve(publicKeyPath))
  );
}
