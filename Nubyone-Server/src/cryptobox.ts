// Server-side mirror of Nubyone-Client/cmd/agent/cryptobox/cryptobox.go.
// Must stay byte-for-byte compatible with the Go implementation.
//
// v2 wire format (raw bytes → base64-RawStd, no padding):
//
//   outer_prefix(4) | 0x02 | chacha_nonce(12) | ChaCha20-Poly1305( inner_blob ) + tag(16)
//
//   inner_blob:
//     inner_prefix(4) | 0x02 | aes_nonce(12) | AES-256-GCM( XOR(pt) ) + tag(16)
//     XOR mask key: 64 bytes HKDF-derived
//
// Layer order is INVERTED vs v1: ChaCha20-Poly1305 is now the outer layer,
// AES-256-GCM is the inner layer.
//
// HKDF-SHA256 key derivation:
//   IKM  = p1_bytes || p2_bytes || p3_bytes || CODE_KEY || namespace
//   salt = SHA-256("n2-s|" + namespace)
//   info = "n2|" + label
//
// Outer ChaCha key: info = "n2|n2-cha|" + label
// Outer prefix:     info = "n2|n2-bpo|" + namespace
// Inner AES key:    info = "n2|n2-aes|" + label
// Inner prefix:     info = "n2|n2-bp|" + namespace
// XOR mask key:     info = "n2|n2-msk|" + label
//
// IMPORTANT: The server only issues blobs under "config/..." labels
// (host-agnostic). Per-host blobs ("host/...") can only be sealed by the
// running agent because the server does not know the machine identity.

import { hkdfSync, randomBytes, createHash, createCipheriv, createDecipheriv } from "crypto";
import { chacha20poly1305 } from "@noble/ciphers/chacha.js";

// CODE_KEY must match the codeKey byte literal in cryptobox.go exactly.
// Stored as 16 single-byte entries matching the ck0..ck15 split in Go.
const _ck = [
  0xfb, // ck0
  0x9b, // ck1
  0x23, // ck2
  0x8f, // ck3
  0x0f, // ck4
  0xd2, // ck5
  0x79, // ck6
  0xd9, // ck7
  0x99, // ck8
  0xfe, // ck9
  0x51, // ck10
  0xbe, // ck11
  0xc7, // ck12
  0x18, // ck13
  0x7b, // ck14
  0x82, // ck15
];
const CODE_KEY = Buffer.from(_ck);

const VERSION     = 0x02;
const PREFIX_LEN  = 4;
const CHACHA_NONCE = 12;
const AES_NONCE   = 12;
const KEY_LEN     = 32;
const TAG_LEN     = 16;
const MASK_LEN    = 64;
const NAMESPACE   = "n2/bld";

export interface BuildSecret {
  p1: string; // 8 raw bytes as 16 hex chars
  p2: string;
  p3: string;
}

/** Generate a fresh per-build set of secret parts (3 × 8 random bytes, hex). */
export function generateBuildSecret(): BuildSecret {
  return {
    p1: randomBytes(8).toString("hex"),
    p2: randomBytes(8).toString("hex"),
    p3: randomBytes(8).toString("hex"),
  };
}

function assembleIKM(s: BuildSecret): Buffer {
  const b1 = Buffer.from(s.p1, "hex");
  const b2 = Buffer.from(s.p2, "hex");
  const b3 = Buffer.from(s.p3, "hex");
  if (b1.length < 4 || b2.length < 4 || b3.length < 4) {
    throw new Error("cryptobox: each part must be >= 4 bytes (8 hex chars)");
  }
  return Buffer.concat([b1, b2, b3, CODE_KEY]);
}

function deriveKey(s: BuildSecret, label: string, length: number): Buffer {
  const ikm  = Buffer.concat([assembleIKM(s), Buffer.from(NAMESPACE)]);
  const salt = createHash("sha256").update("n2-s|" + NAMESPACE).digest();
  const info = Buffer.from("n2|" + label);
  return Buffer.from(hkdfSync("sha256", ikm, salt, info, length));
}

function xorMask(data: Buffer, mask: Buffer): void {
  if (!mask.length) return;
  for (let i = 0; i < data.length; i++) data[i] ^= mask[i % mask.length];
}

function decodeBase64(s: string): Buffer {
  const norm = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad  = norm.length % 4 === 0 ? norm : norm + "=".repeat(4 - norm.length % 4);
  return Buffer.from(pad, "base64");
}

// ── Inner layer: AES-256-GCM + XOR pre-mask ───────────────────────────────
// (Outer layer is ChaCha20-Poly1305 — layer order inverted vs v1)

function sealInner(s: BuildSecret, ptBuf: Buffer, label: string): Buffer {
  const innerPfx = deriveKey(s, "n2-bp|" + NAMESPACE, PREFIX_LEN);
  const aeadKey  = deriveKey(s, "n2-aes|" + label, KEY_LEN);
  const maskKey  = deriveKey(s, "n2-msk|" + label, MASK_LEN);
  const nonce    = randomBytes(AES_NONCE);

  const masked = Buffer.from(ptBuf);
  xorMask(masked, maskKey);

  const aad = Buffer.from("n2i|" + label);
  const cipher = createCipheriv("aes-256-gcm", aeadKey, nonce);
  cipher.setAAD(aad);
  const ct  = Buffer.concat([cipher.update(masked), cipher.final()]);
  const tag = cipher.getAuthTag(); // 16 bytes

  return Buffer.concat([innerPfx, Buffer.from([VERSION]), nonce, ct, tag]);
}

function openInner(s: BuildSecret, raw: Buffer, label: string): Buffer {
  const minLen = PREFIX_LEN + 1 + AES_NONCE + TAG_LEN + 1;
  if (raw.length < minLen) throw new Error("cryptobox: inner blob too short");
  if (raw[PREFIX_LEN] !== VERSION) throw new Error("cryptobox: unsupported inner version");

  const expectedPfx = deriveKey(s, "n2-bp|" + NAMESPACE, PREFIX_LEN);
  for (let i = 0; i < PREFIX_LEN; i++) {
    if (raw[i] !== expectedPfx[i]) throw new Error("cryptobox: inner prefix mismatch");
  }

  const nonce     = raw.subarray(PREFIX_LEN + 1, PREFIX_LEN + 1 + AES_NONCE);
  const ctAndTag  = raw.subarray(PREFIX_LEN + 1 + AES_NONCE);
  const tag       = ctAndTag.subarray(ctAndTag.length - TAG_LEN);
  const ct        = ctAndTag.subarray(0, ctAndTag.length - TAG_LEN);

  const aeadKey = deriveKey(s, "n2-aes|" + label, KEY_LEN);
  const maskKey = deriveKey(s, "n2-msk|" + label, MASK_LEN);
  const aad     = Buffer.from("n2i|" + label);

  const decipher = createDecipheriv("aes-256-gcm", aeadKey, nonce);
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  const masked = Buffer.concat([decipher.update(ct), decipher.final()]);
  xorMask(masked, maskKey);
  return masked;
}

// ── Outer layer: ChaCha20-Poly1305 ────────────────────────────────────────
// (Inner layer is AES-256-GCM — layer order inverted vs v1)

/** Seal plaintext using ChaCha20-Poly1305( AES-256-GCM( XOR(pt) ) ).
 *  Returns raw base64 (no padding). label must be identical in open(). */
export function seal(s: BuildSecret, plaintext: string | Uint8Array, label: string): string {
  const ptBuf = typeof plaintext === "string" ? Buffer.from(plaintext) : Buffer.from(plaintext);

  const inner    = sealInner(s, ptBuf, label);
  const outerKey = deriveKey(s, "n2-cha|" + label, KEY_LEN);
  const outerPfx = deriveKey(s, "n2-bpo|" + NAMESPACE, PREFIX_LEN);
  const outerNonce = randomBytes(CHACHA_NONCE);
  const outerAD    = Buffer.from("n2o|" + label);

  const aead   = chacha20poly1305(new Uint8Array(outerKey), new Uint8Array(outerNonce), new Uint8Array(outerAD));
  const sealed = Buffer.from(aead.encrypt(new Uint8Array(inner))); // ct + tag(16)

  const out = Buffer.concat([outerPfx, Buffer.from([VERSION]), outerNonce, sealed]);
  return out.toString("base64").replace(/=+$/, ""); // raw base64, no padding
}

/** Open a sealed blob — used in tests and server-side verification. */
export function open(s: BuildSecret, b64: string, label: string): Buffer {
  const raw = decodeBase64(b64);

  const minOuter = PREFIX_LEN + 1 + CHACHA_NONCE + TAG_LEN + 1;
  if (raw.length < minOuter) throw new Error("cryptobox: outer blob too short");
  if (raw[PREFIX_LEN] !== VERSION) throw new Error("cryptobox: unsupported outer version");

  const expectedPfx = deriveKey(s, "n2-bpo|" + NAMESPACE, PREFIX_LEN);
  for (let i = 0; i < PREFIX_LEN; i++) {
    if (raw[i] !== expectedPfx[i]) throw new Error("cryptobox: outer prefix mismatch");
  }

  const outerNonce = raw.subarray(PREFIX_LEN + 1, PREFIX_LEN + 1 + CHACHA_NONCE);
  const ctAndTag   = raw.subarray(PREFIX_LEN + 1 + CHACHA_NONCE);
  const outerKey   = deriveKey(s, "n2-cha|" + label, KEY_LEN);
  const outerAD    = Buffer.from("n2o|" + label);

  const aead  = chacha20poly1305(new Uint8Array(outerKey), new Uint8Array(outerNonce), new Uint8Array(outerAD));
  const inner = Buffer.from(aead.decrypt(new Uint8Array(ctAndTag)));

  return openInner(s, inner, label);
}
