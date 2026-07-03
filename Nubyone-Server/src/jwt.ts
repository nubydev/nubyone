// Ed25519 JWT signing for build-time identity sealing.
//
// No external dependencies — uses Node's built-in crypto module.
//
// JWT format (EdDSA / RFC 8037):
//   base64url(header) . base64url(payload) . base64url(signature)
//
// The server generates an Ed25519 keypair once and persists it in
// DATA_DIR/server-keypair.json. The raw 32-byte public key is embedded
// into every agent build via -ldflags -X. The agent verifies the JWT
// signature on startup using crypto/ed25519 (stdlib — no extra deps).
//
// Why JWT helps here (it is signing, not encryption):
//   - Tamper detection: if anyone patches the binary's build claims
//     (server URL, build ID, expiry) the Ed25519 signature fails.
//   - Server attribution: proves this binary was signed by THIS server's key.
//   - No password needed: agent only holds the public key.
//   - Expiry: builds can have a time-to-live so old agents prompt renewal.

import { createPrivateKey, createPublicKey, generateKeyPairSync, sign as cryptoSign } from "crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import path from "path";

export interface ServerKeypair {
  /** PKCS8 DER, base64 — used server-side for signing only. */
  privateKeyB64: string;
  /** SPKI DER, base64 — not transmitted; kept for reference. */
  publicKeySpkiB64: string;
  /** Raw 32-byte Ed25519 public key, base64-Std — injected into every build. */
  publicKeyRawB64: string;
  createdAt: string;
}

/** Returns the server's Ed25519 keypair, generating and persisting it on
 *  first call. The file is stored in DATA_DIR as server-keypair.json. */
export function getOrCreateServerKeypair(dataDir: string): ServerKeypair {
  const file = path.join(dataDir, "server-keypair.json");
  if (existsSync(file)) {
    try {
      const kp = JSON.parse(readFileSync(file, "utf-8")) as ServerKeypair;
      if (kp.privateKeyB64 && kp.publicKeyRawB64) return kp;
    } catch {
      // fall through and regenerate
    }
  }

  const { privateKey, publicKey } = generateKeyPairSync("ed25519", {
    privateKeyEncoding: { type: "pkcs8",  format: "der" },
    publicKeyEncoding:  { type: "spki",   format: "der" },
  });

  const privDer = Buffer.isBuffer(privateKey) ? privateKey : Buffer.from(privateKey as unknown as ArrayBuffer);
  const pubDer  = Buffer.isBuffer(publicKey)  ? publicKey  : Buffer.from(publicKey  as unknown as ArrayBuffer);

  // Ed25519 SPKI DER: algorithm identifier (12 bytes) + BIT STRING header (2 bytes)
  // + raw public key (32 bytes) = 44 bytes total.  The last 32 bytes are the key.
  const rawPub = pubDer.subarray(pubDer.length - 32);

  const kp: ServerKeypair = {
    privateKeyB64:    privDer.toString("base64"),
    publicKeySpkiB64: pubDer.toString("base64"),
    publicKeyRawB64:  rawPub.toString("base64"),
    createdAt:        new Date().toISOString(),
  };

  mkdirSync(dataDir, { recursive: true });
  writeFileSync(file, JSON.stringify(kp, null, 2), { mode: 0o600 });
  console.log("[jwt] Generated new server Ed25519 keypair →", file);
  return kp;
}

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export interface BuildClaims {
  buildId:   string;
  serverURL: string;
  buildTag?: string;
  /** Seconds from epoch. Default: now + 365 days. */
  exp?: number;
}

/** Sign a build-identity JWT using the server's Ed25519 private key.
 *  Returns a compact JWS token (header.payload.signature). */
export function signBuildJWT(kp: ServerKeypair, claims: BuildClaims): string {
  const header  = b64url(Buffer.from(JSON.stringify({ alg: "EdDSA", typ: "JWT" })));
  const now     = Math.floor(Date.now() / 1000);
  const payload = b64url(Buffer.from(JSON.stringify({
    iss: "zc-server",
    aud: "zc-agent",
    sub: claims.buildId,
    iat: now,
    exp: claims.exp ?? now + 365 * 24 * 3600,
    srv: claims.serverURL,
    tag: claims.buildTag ?? "",
  })));

  const msg        = Buffer.from(header + "." + payload);
  const privKeyObj = createPrivateKey({ key: Buffer.from(kp.privateKeyB64, "base64"), format: "der", type: "pkcs8" });
  const sig        = cryptoSign(null, msg, privKeyObj);

  return header + "." + payload + "." + b64url(sig);
}
