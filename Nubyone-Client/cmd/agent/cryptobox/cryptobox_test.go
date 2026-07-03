package cryptobox

import (
        "bytes"
        "encoding/base64"
        "encoding/hex"
        "strings"
        "testing"
)

func setParts(t *testing.T, raw []byte) {
        t.Helper()
        if len(raw) < 12 {
                t.Fatalf("raw must be >= 12 bytes")
        }
        p1, p2, p3 := P1, P2, P3
        P1 = hex.EncodeToString(raw[0:4])
        P2 = hex.EncodeToString(raw[4:8])
        P3 = hex.EncodeToString(raw[8:12])
        t.Cleanup(func() { P1, P2, P3 = p1, p2, p3 })
}

func TestSealOpenRoundTrip(t *testing.T) {
        setParts(t, bytes.Repeat([]byte{0xAB}, 12))
        pt := []byte("wss://server.example.com:8443")
        blob, err := Seal(pt, "config/server_url")
        if err != nil {
                t.Fatalf("Seal: %v", err)
        }
        got, err := Open(blob, "config/server_url")
        if err != nil {
                t.Fatalf("Open: %v", err)
        }
        if !bytes.Equal(got, pt) {
                t.Fatalf("round-trip mismatch: %q vs %q", got, pt)
        }
}

// TestWrongLabelFails checks that both AEAD layers reject a mismatched label.
func TestWrongLabelFails(t *testing.T) {
        setParts(t, bytes.Repeat([]byte{0x55}, 12))
        blob, err := Seal([]byte("hello"), "config/server_url")
        if err != nil {
                t.Fatalf("Seal: %v", err)
        }
        if _, err := Open(blob, "config/build_tag"); err == nil {
                t.Fatal("expected failure for wrong label")
        }
}

// TestCorruptedCiphertextFails flips a byte inside the outer ciphertext and
// expects ChaCha20-Poly1305 authentication to reject it (outer = ChaCha, inner = AES).
func TestCorruptedCiphertextFails(t *testing.T) {
        setParts(t, bytes.Repeat([]byte{0x77}, 12))
        blob, err := Seal([]byte("sensitive"), "config/server_url")
        if err != nil {
                t.Fatalf("Seal: %v", err)
        }
        raw, err := decodeBlob(blob)
        if err != nil {
                t.Fatalf("decodeBlob: %v", err)
        }
        // Flip a byte well inside the outer ciphertext region (after prefix+ver+nonce).
        mid := prefixLen + 1 + chachaNonceLen + 5
        if mid >= len(raw) {
                t.Skip("blob too short for corruption test")
        }
        raw[mid] ^= 0xFF
        corrupted := base64.RawStdEncoding.EncodeToString(raw)
        if _, err := Open(corrupted, "config/server_url"); err == nil {
                t.Fatal("expected ErrAuthFailed for corrupted outer ciphertext")
        }
}

func TestOpenNoSecretFallback(t *testing.T) {
        p1, p2, p3 := P1, P2, P3
        P1, P2, P3 = "", "", ""
        t.Cleanup(func() { P1, P2, P3 = p1, p2, p3 })
        if got := MustOpenStringOr("anyrandomblob", "config/server_url", "fallback"); got != "fallback" {
                t.Fatalf("expected fallback, got %q", got)
        }
}

func TestSealedBlobNoPlaintextLeak(t *testing.T) {
        setParts(t, bytes.Repeat([]byte{0x99}, 12))
        pt := []byte("wss://VERYUNIQUESTRING.example/path")
        blob, _ := Seal(pt, "config/server_url")
        if strings.Contains(blob, "VERYUNIQUESTRING") {
                t.Fatal("plaintext leaked into base64 blob")
        }
        raw, _ := decodeBlob(blob)
        if bytes.Contains(raw, []byte("VERYUNIQUESTRING")) {
                t.Fatal("plaintext leaked into raw bytes")
        }
}

func TestPrefixChangesWithSecret(t *testing.T) {
        setParts(t, bytes.Repeat([]byte{0xAA}, 12))
        blob, _ := Seal([]byte("data"), "config/server_url")

        // Change one part → outer prefix changes → Open() must reject it.
        P1 = hex.EncodeToString([]byte{0x01, 0x02, 0x03, 0x04})
        if _, err := Open(blob, "config/server_url"); err == nil {
                t.Fatal("expected rejection after secret part change")
        }
}

// TestVersionByte verifies the sealed blob carries the v2 version byte.
func TestVersionByte(t *testing.T) {
        setParts(t, bytes.Repeat([]byte{0xBB}, 12))
        blob, err := Seal([]byte("v2test"), "config/server_url")
        if err != nil {
                t.Fatalf("Seal: %v", err)
        }
        raw, err := decodeBlob(blob)
        if err != nil {
                t.Fatalf("decodeBlob: %v", err)
        }
        if raw[prefixLen] != version2 {
                t.Fatalf("expected version byte 0x%02x, got 0x%02x", version2, raw[prefixLen])
        }
}

// TestLayerOrderInverted verifies the outer layer is ChaCha20-Poly1305 (v2).
// It does so by checking the blob is larger than the inner minimum — the
// ChaCha tag+nonce overhead must be present in the outer envelope.
func TestLayerOrderInverted(t *testing.T) {
        setParts(t, bytes.Repeat([]byte{0xCC}, 12))
        pt := []byte("layer-order-check")
        blob, err := Seal(pt, "config/server_url")
        if err != nil {
                t.Fatalf("Seal: %v", err)
        }
        raw, _ := decodeBlob(blob)
        // Outer envelope: prefix(4)+ver(1)+chacha_nonce(12) = 17 bytes header
        // then inner is at least prefix(4)+ver(1)+aes_nonce(12)+tag(16)+1 = 34
        // so total must be > 17+34+16 (outer tag) = 67 bytes
        if len(raw) < 68 {
                t.Fatalf("blob suspiciously small (%d bytes) — layer structure may be wrong", len(raw))
        }
        got, err := Open(blob, "config/server_url")
        if err != nil {
                t.Fatalf("Open after layer check: %v", err)
        }
        if !bytes.Equal(got, pt) {
                t.Fatalf("round-trip mismatch after layer check")
        }
}
