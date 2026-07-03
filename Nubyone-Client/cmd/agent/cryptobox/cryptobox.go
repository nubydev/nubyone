// Package cryptobox provides a "sealed blob" facility for the Nubyone
// agent. Only sensitive build-time values (server URL, build IDs, agent
// tokens) are encrypted — NOT the whole binary.
//
// # Encryption layers — v2 (outer → inner)
//
//  1. ChaCha20-Poly1305 (outer) — independently derived key, randomised
//     12-byte nonce, authenticated with associated data "n2o|<label>".
//  2. AES-256-GCM (inner) — same structure, AAD "n2i|<label>".
//  3. XOR pre-mask — HKDF-derived 64-byte key applied before AES-GCM seal.
//
// Layer order is inverted versus v1 (was AES outer / ChaCha inner).
// Either AEAD layer failing → ErrAuthFailed (tampered or wrong key).
//
// # Key material
//
//   - P1, P2, P3 — three 8-byte hex strings injected via -ldflags -X.
//     No single part reconstructs the key.
//   - codeKey — 16 bytes split across eight [2]byte variables compiled into
//     the binary. Garble -literals obfuscates each pair independently, so
//     no contiguous 16-byte constant appears in the stripped binary.
//     Requires disassembly + 8-site reassembly to extract.
//   - IKM = P1||P2||P3||ck0..ck7 [+hostIdentity if "host/" label]
//     ||namespace
//
// # Key isolation (memory scraping protection)
//
// The full IKM is assembled in a single fixed-capacity allocation inside
// assembleIKM(), used immediately by deriveKey() for HKDF extraction, and
// then zeroed via zeroize() before deriveKey() returns. Derived AEAD keys
// are similarly zeroed with defer after each AEAD operation.
//
// # Blob wire format (raw bytes, then base64-RawStd) — version 2
//
//      outer_prefix(4) | 0x02 | chacha_nonce(12) | ChaCha20-Poly1305( inner_blob ) + tag(16)
//
//      inner_blob:
//        inner_prefix(4) | 0x02 | aes_nonce(12) | AES-256-GCM( XOR(pt) ) + tag(16)
//
// Both prefixes are HKDF-derived per-build (no fixed magic bytes — no
// pattern-matching oracle in `strings` output).
//
// # JWT identity
//
// BuildJWT and ServerPublicKey (in config/config.go) carry an Ed25519-signed
// JWT issued by the server at build time. The agent verifies the signature
// on startup using VerifyBuildJWT() (crypto/ed25519, stdlib only).
package cryptobox

import (
        "crypto/aes"
        "crypto/cipher"
        "crypto/rand"
        "crypto/sha256"
        "encoding/base64"
        "encoding/hex"
        "errors"
        "io"
        "os"
        "runtime"
        "strings"
        "sync"

        "golang.org/x/crypto/chacha20poly1305"
        "golang.org/x/crypto/hkdf"
)

// P1, P2, P3 — three 8-byte (16 hex-char) parts of the per-build secret.
// Injected at build time:
//
//      -X core/cmd/agent/cryptobox.P1=<16 hex chars>
//      -X core/cmd/agent/cryptobox.P2=<16 hex chars>
//      -X core/cmd/agent/cryptobox.P3=<16 hex chars>
var P1 = ""
var P2 = ""
var P3 = ""

// codeKey is split across sixteen [1]byte single-byte variables.
//
// Garble -literals obfuscates each [1]byte independently at compile time —
// 16 separate obfuscation sites, the maximum possible granularity.
// No contiguous key constant survives in the stripped binary.
// Extraction requires disassembly of all 16 sites and manual reassembly.
// Assembly order: ck0||ck1||...||ck15 = original codeKey.
var (
        ck0  = [1]byte{0xfb}
        ck1  = [1]byte{0x9b}
        ck2  = [1]byte{0x23}
        ck3  = [1]byte{0x8f}
        ck4  = [1]byte{0x0f}
        ck5  = [1]byte{0xd2}
        ck6  = [1]byte{0x79}
        ck7  = [1]byte{0xd9}
        ck8  = [1]byte{0x99}
        ck9  = [1]byte{0xfe}
        ck10 = [1]byte{0x51}
        ck11 = [1]byte{0xbe}
        ck12 = [1]byte{0xc7}
        ck13 = [1]byte{0x18}
        ck14 = [1]byte{0x7b}
        ck15 = [1]byte{0x82}
)

const (
        buildNamespace = "n2/bld"
        version2       = 0x02
        prefixLen      = 4
        chachaNonceLen = chacha20poly1305.NonceSize // 12
        aesNonceLen    = 12                         // GCM standard
        aesKeyLen      = 32                         // AES-256
        maskKeyLen     = 64                         // XOR pre-mask, 64 bytes
)

var (
        ErrNoSecret   = errors.New("cryptobox: no build secret injected")
        ErrBadFormat  = errors.New("cryptobox: bad sealed blob format")
        ErrBadVersion = errors.New("cryptobox: unsupported sealed blob version")
        ErrAuthFailed = errors.New("cryptobox: authentication failed (tampered or wrong key)")
)

// zeroize overwrites b with zeros in a way the compiler cannot eliminate.
// runtime.KeepAlive forces the compiler to treat the backing array as live
// at the call site, preventing dead-code elimination of the write loop even
// after inlining. This is the standard Go pattern for ephemeral key zeroing.
func zeroize(b []byte) {
        for i := range b {
                b[i] = 0
        }
        runtime.KeepAlive(b)
}

// assembleIKM builds the HKDF input key material from the three injected hex
// parts and the sixteen codeKey single-byte variables.
//
// The 160-byte fixed capacity is large enough to hold P1||P2||P3||codeKey
// (40 bytes) plus the host-identity suffix (~32 bytes) and namespace (6 bytes)
// that deriveKey appends — so append() never reallocates the backing array.
// This guarantees that zeroize() in deriveKey() always reaches the full IKM.
//
// The decoded b1/b2/b3 slices are zeroed immediately after copying into ikm,
// narrowing the window during which per-build secret bytes are in memory.
func assembleIKM() ([]byte, error) {
        if strings.TrimSpace(P1) == "" || strings.TrimSpace(P2) == "" || strings.TrimSpace(P3) == "" {
                return nil, ErrNoSecret
        }
        b1, e1 := hex.DecodeString(strings.TrimSpace(P1))
        b2, e2 := hex.DecodeString(strings.TrimSpace(P2))
        b3, e3 := hex.DecodeString(strings.TrimSpace(P3))
        if e1 != nil || e2 != nil || e3 != nil || len(b1) < 4 || len(b2) < 4 || len(b3) < 4 {
                return nil, ErrNoSecret
        }

        ikm := make([]byte, 0, 160)
        ikm = append(ikm, b1...)
        ikm = append(ikm, b2...)
        ikm = append(ikm, b3...)
        // Assemble codeKey from sixteen single-byte variables — maximum garble
        // -literals granularity. Each [1]byte is obfuscated at a separate site;
        // no contiguous key constant survives to the stripped binary.
        ikm = append(ikm, ck0[:]...)
        ikm = append(ikm, ck1[:]...)
        ikm = append(ikm, ck2[:]...)
        ikm = append(ikm, ck3[:]...)
        ikm = append(ikm, ck4[:]...)
        ikm = append(ikm, ck5[:]...)
        ikm = append(ikm, ck6[:]...)
        ikm = append(ikm, ck7[:]...)
        ikm = append(ikm, ck8[:]...)
        ikm = append(ikm, ck9[:]...)
        ikm = append(ikm, ck10[:]...)
        ikm = append(ikm, ck11[:]...)
        ikm = append(ikm, ck12[:]...)
        ikm = append(ikm, ck13[:]...)
        ikm = append(ikm, ck14[:]...)
        ikm = append(ikm, ck15[:]...)

        // Zero the decoded hex parts now — their bytes are already in ikm.
        zeroize(b1)
        zeroize(b2)
        zeroize(b3)

        return ikm, nil
}

// HasSecret reports whether all three build-secret parts are injected.
func HasSecret() bool {
        return strings.TrimSpace(P1) != "" &&
                strings.TrimSpace(P2) != "" &&
                strings.TrimSpace(P3) != ""
}

func hostIdentity() string {
        host, _ := os.Hostname()
        return strings.Join([]string{strings.TrimSpace(host), runtime.GOOS, runtime.GOARCH}, "|")
}

func labelBindsToHost(label string) bool {
        return strings.HasPrefix(label, "host/")
}

// deriveKey stretches the assembled IKM into `length` bytes using HKDF-SHA256.
//
// The IKM is zeroed immediately after HKDF extraction, before returning.
// Because assembleIKM() pre-allocates 160 bytes capacity, the host-identity
// and namespace appends below never trigger a reallocation — zeroize() always
// zeroes the same backing array that holds the full assembled IKM.
func deriveKey(label string, length int) ([]byte, error) {
        ikm, err := assembleIKM()
        if err != nil {
                return nil, err
        }

        if labelBindsToHost(label) {
                ikm = append(ikm, []byte(hostIdentity())...)
        }
        ikm = append(ikm, []byte(buildNamespace)...)

        salt := sha256.Sum256([]byte("n2-s|" + buildNamespace))
        info := []byte("n2|" + label)
        r := hkdf.New(sha256.New, ikm, salt[:], info)
        out := make([]byte, length)
        _, err = io.ReadFull(r, out)

        // Zero the IKM before returning regardless of HKDF outcome.
        zeroize(ikm)

        if err != nil {
                return nil, err
        }
        return out, nil
}

func xorMask(data, mask []byte) {
        if len(mask) == 0 {
                return
        }
        for i := range data {
                data[i] ^= mask[i%len(mask)]
        }
}

func decodeBlob(s string) ([]byte, error) {
        for _, enc := range []*base64.Encoding{
                base64.RawStdEncoding,
                base64.StdEncoding,
                base64.RawURLEncoding,
                base64.URLEncoding,
        } {
                if b, err := enc.DecodeString(s); err == nil {
                        return b, nil
                }
        }
        return nil, ErrBadFormat
}

// ── Inner layer: AES-256-GCM + XOR pre-mask ──────────────────────────────────
// (In v2 this is the INNER layer; ChaCha20-Poly1305 wraps it as the outer.)

func sealInner(plaintext []byte, label string) ([]byte, error) {
        innerPfx, err := deriveKey("n2-bp|"+buildNamespace, prefixLen)
        if err != nil {
                return nil, err
        }
        defer zeroize(innerPfx)

        aeadKey, err := deriveKey("n2-aes|"+label, aesKeyLen)
        if err != nil {
                return nil, err
        }
        defer zeroize(aeadKey)

        maskKey, err := deriveKey("n2-msk|"+label, maskKeyLen)
        if err != nil {
                return nil, err
        }
        defer zeroize(maskKey)

        block, err := aes.NewCipher(aeadKey)
        if err != nil {
                return nil, err
        }
        gcm, err := cipher.NewGCM(block)
        if err != nil {
                return nil, err
        }

        nonce := make([]byte, aesNonceLen)
        if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
                return nil, err
        }

        masked := make([]byte, len(plaintext))
        copy(masked, plaintext)
        xorMask(masked, maskKey)

        ad := []byte("n2i|" + label)
        ct := gcm.Seal(nil, nonce, masked, ad)

        out := make([]byte, 0, prefixLen+1+aesNonceLen+len(ct))
        out = append(out, innerPfx...)
        out = append(out, version2)
        out = append(out, nonce...)
        out = append(out, ct...)
        return out, nil
}

func openInner(raw []byte, label string) ([]byte, error) {
        minLen := prefixLen + 1 + aesNonceLen + 16 + 1
        if len(raw) < minLen {
                return nil, ErrBadFormat
        }
        if raw[prefixLen] != version2 {
                return nil, ErrBadVersion
        }

        expectedPfx, err := deriveKey("n2-bp|"+buildNamespace, prefixLen)
        if err != nil {
                return nil, err
        }
        defer zeroize(expectedPfx)

        for i := 0; i < prefixLen; i++ {
                if raw[i] != expectedPfx[i] {
                        return nil, ErrBadFormat
                }
        }

        nonce := raw[prefixLen+1 : prefixLen+1+aesNonceLen]
        ct := raw[prefixLen+1+aesNonceLen:]

        aeadKey, err := deriveKey("n2-aes|"+label, aesKeyLen)
        if err != nil {
                return nil, err
        }
        defer zeroize(aeadKey)

        maskKey, err := deriveKey("n2-msk|"+label, maskKeyLen)
        if err != nil {
                return nil, err
        }
        defer zeroize(maskKey)

        block, err := aes.NewCipher(aeadKey)
        if err != nil {
                return nil, err
        }
        gcm, err := cipher.NewGCM(block)
        if err != nil {
                return nil, err
        }

        ad := []byte("n2i|" + label)
        pt, err := gcm.Open(nil, nonce, ct, ad)
        if err != nil {
                return nil, ErrAuthFailed
        }
        xorMask(pt, maskKey)
        return pt, nil
}

// ── Outer layer: ChaCha20-Poly1305 ───────────────────────────────────────────
// (In v2 this is the OUTER layer; AES-256-GCM is the inner.)

// Seal encrypts plaintext using ChaCha20-Poly1305( AES-256-GCM( XOR(pt) ) ).
// Returns raw-base64 (no padding). The label must be identical in Open().
func Seal(plaintext []byte, label string) (string, error) {
        inner, err := sealInner(plaintext, label)
        if err != nil {
                return "", err
        }

        outerKey, err := deriveKey("n2-cha|"+label, chacha20poly1305.KeySize)
        if err != nil {
                return "", err
        }
        defer zeroize(outerKey)

        outerPfx, err := deriveKey("n2-bpo|"+buildNamespace, prefixLen)
        if err != nil {
                return "", err
        }
        defer zeroize(outerPfx)

        aead, err := chacha20poly1305.New(outerKey)
        if err != nil {
                return "", err
        }

        outerNonce := make([]byte, chachaNonceLen)
        if _, err := io.ReadFull(rand.Reader, outerNonce); err != nil {
                return "", err
        }

        outerAD := []byte("n2o|" + label)
        outerCT := aead.Seal(nil, outerNonce, inner, outerAD)

        out := make([]byte, 0, prefixLen+1+chachaNonceLen+len(outerCT))
        out = append(out, outerPfx...)
        out = append(out, version2)
        out = append(out, outerNonce...)
        out = append(out, outerCT...)
        return base64.RawStdEncoding.EncodeToString(out), nil
}

// Open decrypts a blob produced by Seal(). Both layers must authenticate;
// either failing returns ErrAuthFailed.
func Open(b64 string, label string) ([]byte, error) {
        b64 = strings.TrimSpace(b64)
        if b64 == "" {
                return nil, ErrBadFormat
        }
        if !HasSecret() {
                return nil, ErrNoSecret
        }

        outer, err := decodeBlob(b64)
        if err != nil {
                return nil, ErrBadFormat
        }

        if len(outer) < prefixLen+1+chachaNonceLen+16+1 {
                return nil, ErrBadFormat
        }
        if outer[prefixLen] != version2 {
                return nil, ErrBadVersion
        }

        expectedOuterPfx, err := deriveKey("n2-bpo|"+buildNamespace, prefixLen)
        if err != nil {
                return nil, err
        }
        defer zeroize(expectedOuterPfx)

        for i := 0; i < prefixLen; i++ {
                if outer[i] != expectedOuterPfx[i] {
                        return nil, ErrBadFormat
                }
        }

        outerNonce := outer[prefixLen+1 : prefixLen+1+chachaNonceLen]
        outerCT := outer[prefixLen+1+chachaNonceLen:]

        outerKey, err := deriveKey("n2-cha|"+label, chacha20poly1305.KeySize)
        if err != nil {
                return nil, err
        }
        defer zeroize(outerKey)

        aead, err := chacha20poly1305.New(outerKey)
        if err != nil {
                return nil, err
        }

        outerAD := []byte("n2o|" + label)
        inner, err := aead.Open(nil, outerNonce, outerCT, outerAD)
        if err != nil {
                return nil, ErrAuthFailed
        }

        return openInner(inner, label)
}

// OpenString returns the plaintext as a string.
func OpenString(b64 string, label string) (string, error) {
        b, err := Open(b64, label)
        if err != nil {
                return "", err
        }
        return string(b), nil
}

// OpenLazy decrypts on first call and caches the result (including errors).
func OpenLazy(b64 string, label string) func() ([]byte, error) {
        var (
                once sync.Once
                out  []byte
                err  error
        )
        return func() ([]byte, error) {
                once.Do(func() { out, err = Open(b64, label) })
                return out, err
        }
}

// MustOpenStringOr returns the decrypted string or `fallback` on any failure
// (including no secret injected). This is the primary API for config values.
func MustOpenStringOr(b64 string, label string, fallback string) string {
        if strings.TrimSpace(b64) == "" || !HasSecret() {
                return fallback
        }
        if s, err := OpenString(b64, label); err == nil {
                return s
        }
        return fallback
}
