import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  verify,
} from "node:crypto";
import {
  chmodSync,
  closeSync,
  createReadStream,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

const MAX_BOOT_BYTES = 128 * 1024;
const MAX_LIFETIME_MS = 5 * 60 * 1000;
const authorityRoot = path.join(
  os.userInfo().homedir,
  ".copilot",
  "semantic-corpus-launcher",
);
const authorityPrivateKeyPath = path.join(authorityRoot, "authority-private.der");
export const launcherAuthorityPublicKeyPath = path.join(
  authorityRoot,
  "authority-public.der",
);
const authorityLockPath = path.join(authorityRoot, "authority.lock");

export class AttestationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "AttestationError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new AttestationError(code, message);
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
}

function canonicalBytes(value) {
  return Buffer.from(`${canonicalJson(value)}\n`, "utf8");
}

function assertExactKeys(value, expected, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("LAUNCH_ATTESTATION_INVALID", `${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    fail("LAUNCH_ATTESTATION_INVALID", `${label} has an invalid field set`);
  }
}

export function createLauncherBootEnvelope({
  configPath,
  configSha256,
  config,
  serverToken,
  expectedServerPath,
  expectedServerSha256,
  expectedExecutablePath,
  expectedExecutableSha256,
  expectedLauncherPath,
  expectedLauncherSha256,
  stagingRoot,
  lifetimeMs = 60_000,
  now = Date.now(),
}) {
  if (!Number.isSafeInteger(lifetimeMs) || lifetimeMs < 1000 || lifetimeMs > MAX_LIFETIME_MS) {
    fail("LAUNCH_ATTESTATION_INVALID", "boot lifetime is out of range");
  }
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const authority = launcherAuthority();
  const nonce = cryptoNonce();
  const replayPath = path.join(stagingRoot, `.launch-${nonce}.cap`);
  const replayToken = randomBytes(32).toString("base64url");
  const payload = {
    version: 1,
    configPath,
    configSha256,
    config,
    serverToken,
    expectedServerPath,
    expectedServerSha256,
    expectedExecutablePath,
    expectedExecutableSha256,
    expectedLauncherPath,
    expectedLauncherSha256,
    launcherPid: process.pid,
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + lifetimeMs).toISOString(),
    nonce,
    replayPath,
    replayToken,
  };
  const publicKeyDer = publicKey.export({ type: "spki", format: "der" });
  const signature = sign(null, canonicalBytes(payload), privateKey);
  const envelope = {
    version: 1,
    algorithm: "Ed25519",
    payload,
    authoritySignature: sign(
      null,
      publicKeyDer,
      authority.privateKey,
    ).toString("base64"),
    signature: signature.toString("base64"),
  };
  return {
    bytes: canonicalBytes(envelope),
    publicKeyBytes: publicKeyDer,
    envelope,
    payload,
  };
}

function launcherAuthority() {
  mkdirSync(authorityRoot, { recursive: true, mode: 0o700 });
  let lock;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      lock = openSync(authorityLockPath, "wx", 0o600);
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      if (
        existsSync(authorityPrivateKeyPath) &&
        existsSync(launcherAuthorityPublicKeyPath)
      ) {
        break;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  try {
    if (
      !existsSync(authorityPrivateKeyPath) ||
      !existsSync(launcherAuthorityPublicKeyPath)
    ) {
      if (lock === undefined) {
        fail("LAUNCH_AUTHORITY_UNAVAILABLE", "launcher authority initialization timed out");
      }
      rmSync(authorityPrivateKeyPath, { force: true });
      rmSync(launcherAuthorityPublicKeyPath, { force: true });
      const keys = generateKeyPairSync("ed25519");
      writeFileSync(
        authorityPrivateKeyPath,
        keys.privateKey.export({ type: "pkcs8", format: "der" }),
        { flag: "wx", mode: 0o600 },
      );
      writeFileSync(
        launcherAuthorityPublicKeyPath,
        keys.publicKey.export({ type: "spki", format: "der" }),
        { flag: "wx", mode: 0o600 },
      );
    }
  } finally {
    if (lock !== undefined) {
      closeSync(lock);
      rmSync(authorityLockPath, { force: true });
    }
  }
  chmodSync(authorityPrivateKeyPath, 0o600);
  chmodSync(launcherAuthorityPublicKeyPath, 0o600);
  const privateKey = createPrivateKey({
    key: readFileSync(authorityPrivateKeyPath),
    type: "pkcs8",
    format: "der",
  });
  const publicKeyBytes = readFileSync(launcherAuthorityPublicKeyPath);
  const proof = randomBytes(32);
  if (
    !verify(
      null,
      proof,
      createPublicKey({ key: publicKeyBytes, type: "spki", format: "der" }),
      sign(null, proof, privateKey),
    )
  ) {
    fail("LAUNCH_AUTHORITY_INVALID", "launcher authority keypair is inconsistent");
  }
  return {
    privateKey,
    privateKeyPath: authorityPrivateKeyPath,
    publicKeyBytes,
    publicKeyPath: launcherAuthorityPublicKeyPath,
  };
}

export function launcherAuthorityPaths() {
  const authority = launcherAuthority();
  return {
    privateKeyPath: authority.privateKeyPath,
    publicKeyPath: authority.publicKeyPath,
  };
}

function cryptoNonce() {
  return randomBytes(32).toString("hex");
}

async function readDescriptor(fd) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let length = 0;
    const stream = createReadStream(null, { fd, autoClose: false });
    stream.on("data", (chunk) => {
      length += chunk.length;
      if (length > MAX_BOOT_BYTES) {
        stream.destroy(
          new AttestationError(
            "LAUNCH_ATTESTATION_INVALID",
            `launcher boot descriptor exceeds ${MAX_BOOT_BYTES} bytes`,
          ),
        );
        return;
      }
      chunks.push(chunk);
    });
    stream.once("error", reject);
    stream.once("end", () => resolve(Buffer.concat(chunks)));
  });
}

export function verifyLauncherBootEnvelope(bytes, publicKeyBytes, options = {}) {
  let envelope;
  try {
    envelope = JSON.parse(bytes);
  } catch {
    fail("LAUNCH_ATTESTATION_INVALID", "launcher boot descriptor must contain valid JSON");
  }
  assertExactKeys(
    envelope,
    new Set([
      "version",
      "algorithm",
      "payload",
      "authoritySignature",
      "signature",
    ]),
    "launcher boot envelope",
  );
  if (envelope.version !== 1 || envelope.algorithm !== "Ed25519") {
    fail("LAUNCH_ATTESTATION_INVALID", "launcher boot algorithm or version is unsupported");
  }
  assertExactKeys(
    envelope.payload,
    new Set([
      "version",
      "configPath",
      "configSha256",
      "config",
      "serverToken",
      "expectedServerPath",
      "expectedServerSha256",
      "expectedExecutablePath",
      "expectedExecutableSha256",
      "expectedLauncherPath",
      "expectedLauncherSha256",
      "launcherPid",
      "issuedAt",
      "expiresAt",
      "nonce",
      "replayPath",
      "replayToken",
    ]),
    "launcher boot payload",
  );
  const payload = envelope.payload;
  if (
    payload.version !== 1 ||
    payload.config === null ||
    typeof payload.config !== "object" ||
    Array.isArray(payload.config) ||
    typeof payload.configPath !== "string" ||
    !path.isAbsolute(payload.configPath) ||
    path.resolve(payload.configPath) !== payload.configPath ||
    typeof payload.expectedServerPath !== "string" ||
    !path.isAbsolute(payload.expectedServerPath) ||
    path.resolve(payload.expectedServerPath) !== payload.expectedServerPath ||
    typeof payload.expectedExecutablePath !== "string" ||
    !path.isAbsolute(payload.expectedExecutablePath) ||
    path.resolve(payload.expectedExecutablePath) !== payload.expectedExecutablePath ||
    typeof payload.expectedLauncherPath !== "string" ||
    !path.isAbsolute(payload.expectedLauncherPath) ||
    path.resolve(payload.expectedLauncherPath) !== payload.expectedLauncherPath ||
    !/^[a-f0-9]{64}$/u.test(payload.configSha256 ?? "") ||
    !/^[a-f0-9]{64}$/u.test(payload.expectedServerSha256 ?? "") ||
    !/^[a-f0-9]{64}$/u.test(payload.expectedExecutableSha256 ?? "") ||
    !/^[a-f0-9]{64}$/u.test(payload.expectedLauncherSha256 ?? "") ||
    !/^[A-Za-z0-9_-]{40,128}$/u.test(payload.serverToken ?? "") ||
    !/^[a-f0-9]{64}$/u.test(payload.nonce ?? "") ||
    typeof payload.replayPath !== "string" ||
    !path.isAbsolute(payload.replayPath) ||
    path.resolve(payload.replayPath) !== payload.replayPath ||
    path.basename(payload.replayPath) !== `.launch-${payload.nonce}.cap` ||
    !/^[A-Za-z0-9_-]{40,128}$/u.test(payload.replayToken ?? "") ||
    !Number.isSafeInteger(payload.launcherPid)
  ) {
    fail("LAUNCH_ATTESTATION_INVALID", "launcher boot payload is malformed");
  }
  let publicKey;
  let authorityPublicKey;
  try {
    publicKey = createPublicKey({
      key: publicKeyBytes,
      type: "spki",
      format: "der",
    });
    authorityPublicKey = createPublicKey({
      key: readFileSync(launcherAuthorityPublicKeyPath),
      type: "spki",
      format: "der",
    });
  } catch {
    fail("LAUNCH_ATTESTATION_INVALID", "launcher public key is invalid");
  }
  if (
    authorityPublicKey.asymmetricKeyType !== "ed25519" ||
    !verify(
      null,
      publicKeyBytes,
      authorityPublicKey,
      Buffer.from(envelope.authoritySignature, "base64"),
    ) ||
    publicKey.asymmetricKeyType !== "ed25519" ||
    !verify(
      null,
      canonicalBytes(payload),
      publicKey,
      Buffer.from(envelope.signature, "base64"),
    )
  ) {
    fail("LAUNCH_SIGNATURE_INVALID", "launcher boot signature is invalid");
  }
  const now = options.now ?? Date.now();
  const issuedAt = Date.parse(payload.issuedAt);
  const expiresAt = Date.parse(payload.expiresAt);
  if (
    !Number.isFinite(issuedAt) ||
    !Number.isFinite(expiresAt) ||
    expiresAt <= issuedAt ||
    expiresAt - issuedAt > MAX_LIFETIME_MS ||
    now < issuedAt - 5000 ||
    now > expiresAt
  ) {
    fail("LAUNCH_ATTESTATION_EXPIRED", "launcher boot attestation is outside its lifetime");
  }
  if (
    options.requireParent !== false &&
    payload.launcherPid !== process.ppid
  ) {
    fail("LAUNCH_PARENT_MISMATCH", "launcher boot parent process does not match");
  }
  return payload;
}

export async function readLauncherBootDescriptor(
  envelopeFd = 3,
  publicKeyFd = 4,
  options = {},
) {
  let bytes;
  let publicKeyBytes;
  try {
    [bytes, publicKeyBytes] = await Promise.all([
      readDescriptor(envelopeFd),
      readDescriptor(publicKeyFd),
    ]);
  } catch (error) {
    if (error instanceof AttestationError) throw error;
    fail(
      "LAUNCH_ATTESTATION_REQUIRED",
      "trusted launcher boot descriptor is required",
    );
  }
  if (bytes.length === 0 || publicKeyBytes.length === 0) {
    fail(
      "LAUNCH_ATTESTATION_REQUIRED",
      "trusted launcher boot descriptor is required",
    );
  }
  return verifyLauncherBootEnvelope(bytes, publicKeyBytes, options);
}
