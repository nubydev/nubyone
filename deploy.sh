#!/usr/bin/env bash
set -euo pipefail

#######################################################################
#  NUBYONE — ONE-SHOT VPS DEPLOYMENT
#
#  Installs everything needed and brings the server live at
#  https://<DOMAIN> (port 443) on a fresh Ubuntu 22.04 / 24.04 VPS.
#
#  Usage (from your VPS as a normal sudo-capable user):
#    sudo bash deploy.sh
#
#  Re-running is safe — every step is idempotent.
#######################################################################

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  USER CONFIG
#
#  Two ways to supply these values (pick ONE):
#
#  (A) Edit directly here — recommended for a private repo where the
#      values can be committed safely.  Just change the strings below
#      and run:  sudo bash deploy.sh
#
#  (B) Pass as environment variables — useful when you prefer not to
#      commit secrets even in a private repo:
#        DOMAIN=manage.example.com \
#        LE_EMAIL=you@example.com  \
#        GITHUB_TOKEN=ghp_xxx      \
#        ADMIN_PASS=YourPassword   \
#        sudo -E bash deploy.sh
#
#  Values set via environment variables always take priority over the
#  defaults written here.
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

DOMAIN="${DOMAIN:-nubyone.ydns.eu}"          # e.g. manage.example.com — A record must point to this VPS
LE_EMAIL="${LE_EMAIL:-nubyone@gmail.com}"     # Let's Encrypt renewal notifications

GITHUB_TOKEN="${GITHUB_TOKEN:-token-here}" # GitHub classic personal access token (repo scope)
GITHUB_REPO="${GITHUB_REPO:-nubydev/nubyone}"
GITHUB_BRANCH="${GITHUB_BRANCH:-main}"

ADMIN_PASS="${ADMIN_PASS:-Neki999}"  # Initial admin password — change in the UI after first login

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  TOOLCHAIN VERSIONS
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

# Go 1.25.0 — plain build SDK (matches go.mod requirement)
GO_PLAIN_VERSION="1.25.0"

# Go 1.26.2 — garble build SDK (garble must be compiled against the exact SDK version)
GO_GARBLE_VERSION="1.26.2"

GARBLE_VERSION="v0.16.0"

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
#  INTERNAL CONFIG — do not edit below unless you know what you're doing
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

INT_PORT=15443          # internal Bun port (nginx proxies 443 → this)
DEPLOY_DIR="/opt/nubyone"
SERVICE="nubyone"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'
info()  { echo -e "${GREEN}[✔]${NC} $*"; }
warn()  { echo -e "${YELLOW}[!]${NC} $*"; }
step()  { echo -e "\n${CYAN}${BOLD}━━━ $* ━━━${NC}"; }
die()   { echo -e "${RED}[✘]${NC} $*"; exit 1; }

# Retry a flaky network command a few times with backoff before giving up.
# Bun's installer opens many concurrent sockets; on constrained VPS network
# stacks (low ulimits, conntrack limits, flaky egress) this can intermittently
# fail with errors like "FailedToOpenSocket". Retrying + capping concurrency
# and raising the file-descriptor limit fixes the vast majority of cases.
retry() {
  local attempts="$1"; shift
  local delay=3
  local n=1
  until "$@"; do
    if (( n >= attempts )); then
      warn "Command failed after ${attempts} attempts: $*"
      return 1
    fi
    warn "Attempt ${n}/${attempts} failed, retrying in ${delay}s..."
    sleep "$delay"
    ((n++))
    delay=$(( delay * 2 ))
  done
}

bun_install() {
  local dir="$1"
  ulimit -n 65536 2>/dev/null || true
  retry 4 bash -c "cd '${dir}' && BUN_INSTALL_NETWORK_CONCURRENCY=8 bun install --network-concurrency 8 2>&1 | tail -20"
}

# ── Pre-flight ────────────────────────────────────────────────────────
[[ $EUID -ne 0 ]] && die "Run as root:  sudo bash deploy.sh"
[[ -z "$DOMAIN" || "$DOMAIN" == "yourdomain.com" ]] \
  && die "DOMAIN is not set. Edit it at the top of deploy.sh OR pass: DOMAIN=your.domain sudo -E bash deploy.sh"
[[ -z "$LE_EMAIL" || "$LE_EMAIL" == "you@example.com" ]] \
  && die "LE_EMAIL is not set. Edit it at the top of deploy.sh OR pass: LE_EMAIL=you@example.com sudo -E bash deploy.sh"
[[ -z "$GITHUB_TOKEN" || "$GITHUB_TOKEN" == "token-here" ]] \
  && die "GITHUB_TOKEN is not set. Edit it at the top of deploy.sh OR pass: GITHUB_TOKEN=ghp_xxx sudo -E bash deploy.sh"

echo -e "${GREEN}${BOLD}"
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║           NUBYONE  VPS DEPLOYMENT                        ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo -e "${NC}"
echo -e "  Target:  ${CYAN}https://${DOMAIN}${NC}"
echo    "  Deploy:  ${DEPLOY_DIR}"
echo ""

# ── Step 1: System packages ──────────────────────────────────────────
step "Installing system packages"
apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
  curl wget git unzip build-essential pkg-config \
  nginx certbot python3-certbot-nginx \
  osslsigncode libssl-dev \
  upx-ucl \
  ufw ca-certificates gnupg lsb-release
info "System packages installed"

# Verify UPX landed correctly — it is required for compressed agent EXEs
if command -v upx &>/dev/null; then
  info "upx: $(upx --version 2>&1 | head -1)"
else
  warn "upx not found after install — agent EXEs will be uncompressed (~15 MB instead of ~5 MB)"
fi

# ── Step 2: Go 1.25.0 — plain build SDK ─────────────────────────────
step "Installing Go ${GO_PLAIN_VERSION} (plain build SDK)"
export PATH=$PATH:/usr/local/go/bin

install_go_sdk() {
  local version="$1"
  local target_dir="/root/sdk/go${version}"
  if [[ -x "${target_dir}/bin/go" ]]; then
    info "Go ${version} already installed at ${target_dir}"
    return
  fi
  local arch
  arch=$(dpkg --print-architecture)
  case "$arch" in
    amd64) arch="amd64" ;;
    arm64) arch="arm64" ;;
    *) die "Unsupported CPU architecture: ${arch}" ;;
  esac
  info "Downloading Go ${version} (linux-${arch})..."
  wget -q "https://go.dev/dl/go${version}.linux-${arch}.tar.gz" -O "/tmp/go${version}.tar.gz" \
    || die "Failed to download Go ${version}. Check https://go.dev/dl/"
  mkdir -p /root/sdk
  tar -C /root/sdk -xzf "/tmp/go${version}.tar.gz"
  mv "/root/sdk/go" "${target_dir}"
  rm "/tmp/go${version}.tar.gz"
  info "Go ${version} installed at ${target_dir}"
}

install_go_sdk "$GO_PLAIN_VERSION"
install_go_sdk "$GO_GARBLE_VERSION"

# Also install Go 1.26.2 as the system-wide go for garble compilation
if ! /usr/local/go/bin/go version 2>/dev/null | grep -q "go${GO_GARBLE_VERSION}"; then
  info "Setting Go ${GO_GARBLE_VERSION} as system go at /usr/local/go..."
  rm -rf /usr/local/go
  cp -a "/root/sdk/go${GO_GARBLE_VERSION}" /usr/local/go
  echo 'export PATH=$PATH:/usr/local/go/bin' > /etc/profile.d/go.sh
  chmod +x /etc/profile.d/go.sh
fi
export PATH="/usr/local/go/bin:$PATH"
info "System go: $(go version)"
info "Plain SDK: $(/root/sdk/go${GO_PLAIN_VERSION}/bin/go version)"
info "Garble SDK: $(/root/sdk/go${GO_GARBLE_VERSION}/bin/go version)"

# ── Step 3: garble obfuscator ────────────────────────────────────────
step "Installing garble ${GARBLE_VERSION}"
export GOPATH="/root/go"
mkdir -p /root/go/bin
export PATH="/root/go/bin:/usr/local/go/bin:${PATH}"

# Always verify the installed garble version matches; reinstall if different or missing.
INSTALLED_GARBLE_VER=$(garble version 2>/dev/null | grep -oP 'v[0-9]+\.[0-9]+\.[0-9]+' | head -1 || true)
if [[ "$INSTALLED_GARBLE_VER" == "$GARBLE_VERSION" ]]; then
  info "garble ${GARBLE_VERSION} already installed at $(command -v garble)"
else
  info "Building garble ${GARBLE_VERSION} from source using Go ${GO_GARBLE_VERSION}..."
  GOROOT="/root/sdk/go${GO_GARBLE_VERSION}" \
  GOPATH=/root/go \
  GOPROXY="https://proxy.golang.org,direct" \
  GOTELEMETRY=off \
  GOTOOLCHAIN=local \
    "/root/sdk/go${GO_GARBLE_VERSION}/bin/go" install "mvdan.cc/garble@${GARBLE_VERSION}" 2>&1 \
    && info "garble installed: $(garble version 2>/dev/null || echo 'check /root/go/bin/garble')" \
    || { warn "garble install failed — agent EXEs will be unobfuscated and larger (~15 MB vs ~5 MB)"; }
fi

# Confirm the binary landed where the server expects it
[[ -x /root/go/bin/garble ]] \
  && info "garble binary confirmed at /root/go/bin/garble" \
  || warn "garble binary NOT found at /root/go/bin/garble — run: GOPATH=/root/go GOROOT=/root/sdk/go${GO_GARBLE_VERSION} /root/sdk/go${GO_GARBLE_VERSION}/bin/go install mvdan.cc/garble@${GARBLE_VERSION}"

grep -q '^GOPATH=' /etc/environment 2>/dev/null || echo "GOPATH=/root/go" >> /etc/environment
grep -q '/root/go/bin' /etc/profile.d/go.sh 2>/dev/null \
  || echo 'export GOPATH=/root/go; export PATH="/root/go/bin:$PATH"' >> /etc/profile.d/go.sh

# ── Step 4: Bun ──────────────────────────────────────────────────────
step "Installing Bun"
export BUN_INSTALL="/root/.bun"
export PATH="${BUN_INSTALL}/bin:$PATH"

if command -v bun &>/dev/null; then
  info "Bun $(bun --version) already installed"
else
  curl -fsSL https://bun.sh/install | bash
  export PATH="${BUN_INSTALL}/bin:$PATH"
  info "Bun $(bun --version) installed"
fi
ln -sf "$(command -v bun)" /usr/local/bin/bun 2>/dev/null || true
info "bun → /usr/local/bin/bun"

# ── Step 5: Clone / update repository ───────────────────────────────
step "Cloning repository"
CLONE_URL="https://${GITHUB_TOKEN}@github.com/${GITHUB_REPO}.git"
mkdir -p "$DEPLOY_DIR"

if [[ -d "${DEPLOY_DIR}/.git" ]]; then
  info "Updating existing clone..."
  git -C "$DEPLOY_DIR" remote set-url origin "$CLONE_URL"
  git -C "$DEPLOY_DIR" fetch --quiet origin
  git -C "$DEPLOY_DIR" reset --hard "origin/${GITHUB_BRANCH}"
  git -C "$DEPLOY_DIR" clean -fd --quiet
else
  info "Cloning ${GITHUB_REPO} → ${DEPLOY_DIR}..."
  git clone --branch "$GITHUB_BRANCH" --depth 1 "$CLONE_URL" "$DEPLOY_DIR"
fi
# Remove token from stored remote so it doesn't appear in git log
git -C "$DEPLOY_DIR" remote set-url origin "https://github.com/${GITHUB_REPO}.git"
info "Repository ready at ${DEPLOY_DIR}"

# ── Step 6: Install Node packages and build CSS ──────────────────────
step "Installing packages and building CSS"
SERVER_DIR="${DEPLOY_DIR}/Nubyone-Server"
[[ -d "$SERVER_DIR" ]] || die "Nubyone-Server not found at ${SERVER_DIR}"

bun_install "$SERVER_DIR"
info "Bun packages installed"

(cd "$SERVER_DIR" && bun run build:css)
info "Tailwind CSS built"

# ── Step 7: Pre-fetch Go modules & sync vendor directory ─────────────
step "Pre-fetching Go modules"
CLIENT_DIR="${DEPLOY_DIR}/Nubyone-Client"
if [[ -d "$CLIENT_DIR" ]]; then
  local_go="/root/sdk/go${GO_PLAIN_VERSION}/bin/go"
  common_env=(
    GOROOT="/root/sdk/go${GO_PLAIN_VERSION}"
    GOPATH="/root/go"
    GOCACHE="${DEPLOY_DIR}/.cache/go-build"
    GONOSUMDB="*" GOTELEMETRY="off" GOTOOLCHAIN="local"
  )

  # Download modules into the module cache
  ( cd "$CLIENT_DIR" && env "${common_env[@]}" "$local_go" mod download 2>&1 | tail -5 ) \
    && info "Go modules cached" \
    || warn "go mod download had warnings (non-fatal)"

  # Regenerate vendor/modules.txt with the exact SDK that will build the agent.
  # Without this, Go 1.25 rejects a modules.txt generated by a different toolchain
  # and fails with "inconsistent vendoring" even when the entries look correct.
  ( cd "$CLIENT_DIR" && env "${common_env[@]}" "$local_go" mod vendor 2>&1 | tail -5 ) \
    && info "vendor directory synced (go mod vendor)" \
    || warn "go mod vendor had warnings (non-fatal)"
fi

# ── Step 8: Generate JWT secret and create data dir ──────────────────
step "Generating secrets and creating data directories"
JWT_SECRET=$(openssl rand -hex 48)
mkdir -p "${DEPLOY_DIR}/.cache/go-build" \
         "${SERVER_DIR}/data" \
         "${SERVER_DIR}/builds" \
         /root/go
info "Directories created, JWT secret generated"

# ── Step 9: systemd service ──────────────────────────────────────────
step "Creating systemd service"
cat > "/etc/systemd/system/${SERVICE}.service" <<EOF
[Unit]
Description=Nubyone Remote Management Server
Documentation=https://github.com/${GITHUB_REPO}
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${SERVER_DIR}

# Server config
Environment="PORT=${INT_PORT}"
Environment="HOST=127.0.0.1"
Environment="ADMIN_USER=anon_"
Environment="ADMIN_PASS=${ADMIN_PASS}"
Environment="JWT_SECRET=${JWT_SECRET}"
Environment="NUBYONE_AUTH_COOKIE_SECURE=true"
Environment="NUBYONE_PUBLIC_URL=https://${DOMAIN}"
Environment="NUBYONE_DATA_DIR=${SERVER_DIR}/data"
Environment="NODE_ENV=production"

# Go toolchain — two SDKs present:
#   go${GO_PLAIN_VERSION}  at /root/sdk/go${GO_PLAIN_VERSION}  — plain builds (matches go.mod)
#   go${GO_GARBLE_VERSION}  at /root/sdk/go${GO_GARBLE_VERSION}  — garble obfuscated builds
# server.ts auto-selects the right one; GOTOOLCHAIN=local prevents any network download.
Environment="HOME=/root"
Environment="GOPATH=/root/go"
Environment="GOCACHE=${DEPLOY_DIR}/.cache/go-build"
Environment="GOTELEMETRY=off"
Environment="GONOSUMDB=*"
Environment="GOTOOLCHAIN=local"
Environment="PATH=/root/go/bin:/usr/local/go/bin:/usr/local/bin:/usr/bin:/sbin:/bin"

ExecStart=/usr/local/bin/bun run src/index.ts
Restart=always
RestartSec=5
StartLimitIntervalSec=60
StartLimitBurst=5

StandardOutput=journal
StandardError=journal
SyslogIdentifier=${SERVICE}

[Install]
WantedBy=multi-user.target
EOF
info "Service file: /etc/systemd/system/${SERVICE}.service"

# ── Step 10: nginx — ACME port-80 challenge ──────────────────────────
step "Configuring nginx for Let's Encrypt (port 80)"
mkdir -p /var/www/html/.well-known/acme-challenge

cat > /etc/nginx/sites-available/nubyone-acme <<'NGINX'
server {
    listen 80;
    listen [::]:80;
    server_name _;

    location /.well-known/acme-challenge/ {
        root /var/www/html;
        allow all;
    }
    location / { return 444; }
}
NGINX

rm -f /etc/nginx/sites-enabled/default
ln -sf /etc/nginx/sites-available/nubyone-acme /etc/nginx/sites-enabled/nubyone-acme
nginx -t && systemctl reload nginx
info "nginx ACME challenge server active on port 80"

# ── Step 11: Let's Encrypt certificate ──────────────────────────────
step "Obtaining SSL certificate for ${DOMAIN}"
if [[ -f "/etc/letsencrypt/live/${DOMAIN}/fullchain.pem" ]]; then
  warn "Certificate already exists — skipping (run: certbot renew)"
else
  certbot certonly \
    --webroot \
    --webroot-path /var/www/html \
    --non-interactive \
    --agree-tos \
    --email "$LE_EMAIL" \
    -d "$DOMAIN" \
    || die "certbot failed for ${DOMAIN}. Check DNS A record points to this VPS and port 80 is open."
  info "Certificate obtained for ${DOMAIN}"
fi

# ── Step 12: nginx SSL reverse proxy ────────────────────────────────
step "Writing nginx SSL config for https://${DOMAIN}"

# WebSocket upgrade map — only add once
if ! grep -q "connection_upgrade" /etc/nginx/nginx.conf; then
  sed -i '/http {/a \    map $http_upgrade $connection_upgrade {\n        default upgrade;\n        '"''"' close;\n    }' /etc/nginx/nginx.conf
  info "WebSocket upgrade map added to nginx.conf"
fi

cat > "/etc/nginx/sites-available/${SERVICE}" <<NGINX
# Nubyone — https://${DOMAIN}
# Proxies 443 → 127.0.0.1:${INT_PORT}

# ── Catch-all: reject HTTPS connections for unknown hostnames (e.g. raw IP) ──
# Without this, nginx picks the first SSL server block when SNI doesn't match,
# serving the domain cert for the wrong hostname → browser "danger" warning.
server {
    listen 443 ssl http2 default_server;
    listen [::]:443 ssl http2 default_server;
    server_name _;

    ssl_certificate     /etc/letsencrypt/live/${DOMAIN}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${DOMAIN}/privkey.pem;

    return 444;
}

server {
    listen 80;
    listen [::]:80;
    server_name ${DOMAIN};

    location /.well-known/acme-challenge/ {
        root /var/www/html;
        allow all;
    }
    location / {
        return 301 https://\$host\$request_uri;
    }
}

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name ${DOMAIN};

    ssl_certificate     /etc/letsencrypt/live/${DOMAIN}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${DOMAIN}/privkey.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_ciphers         ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305;
    ssl_prefer_server_ciphers off;
    ssl_session_cache   shared:SSL:10m;
    ssl_session_timeout 1d;
    ssl_session_tickets off;

    # OCSP stapling — server fetches & caches the cert's revocation status so
    # browsers don't have to do a live OCSP lookup on every visit.  Without this,
    # Firefox and some Chromium builds treat the cert as unverified and show
    # the "danger / not private" interstitial until the user adds an exception.
    ssl_stapling        on;
    ssl_stapling_verify on;
    ssl_trusted_certificate /etc/letsencrypt/live/${DOMAIN}/chain.pem;
    resolver            8.8.8.8 8.8.4.4 valid=300s;
    resolver_timeout    5s;

    add_header Strict-Transport-Security "max-age=63072000" always;
    add_header X-Frame-Options SAMEORIGIN always;
    add_header X-Content-Type-Options nosniff always;

    # Allow large uploads (agent binaries, signing certs)
    client_max_body_size 256m;

    location / {
        proxy_pass         http://127.0.0.1:${INT_PORT};
        proxy_http_version 1.1;

        # WebSocket support — required for agents, console, and notifications
        proxy_set_header   Upgrade    \$http_upgrade;
        proxy_set_header   Connection \$connection_upgrade;

        proxy_set_header   Host              \$http_host;
        proxy_set_header   X-Real-IP         \$remote_addr;
        proxy_set_header   X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto https;
        proxy_set_header   X-Forwarded-Host  \$http_host;

        # Long timeouts — agents hold persistent WebSocket connections
        proxy_read_timeout    300s;
        proxy_send_timeout    300s;
        proxy_connect_timeout 10s;

        proxy_buffering off;
        proxy_cache     off;
    }
}
NGINX

rm -f /etc/nginx/sites-enabled/nubyone-acme
ln -sf "/etc/nginx/sites-available/${SERVICE}" "/etc/nginx/sites-enabled/${SERVICE}"
nginx -t || die "nginx config test failed — check output above"
systemctl reload nginx
info "nginx SSL proxy active: https://${DOMAIN} → 127.0.0.1:${INT_PORT}"

# ── Step 13: Auto-renew certificates ─────────────────────────────────
step "Configuring automatic SSL renewal"
systemctl enable certbot.timer 2>/dev/null || true
systemctl start  certbot.timer 2>/dev/null || true
cat > /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh <<'HOOK'
#!/bin/bash
systemctl reload nginx
HOOK
chmod +x /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh
info "Auto-renewal timer active (runs twice daily)"

# ── Step 14: Firewall ─────────────────────────────────────────────────
step "Configuring firewall (ufw)"
ufw allow 22/tcp   comment "SSH"         2>/dev/null || true
ufw allow 80/tcp   comment "HTTP/ACME"   2>/dev/null || true
ufw allow 443/tcp  comment "HTTPS"       2>/dev/null || true
echo "y" | ufw enable 2>/dev/null || true
ufw status verbose
info "Firewall: SSH (22), HTTP (80), HTTPS (443) open"

# ── Step 15: Enable and start service ────────────────────────────────
step "Starting Nubyone"
systemctl daemon-reload
systemctl enable  "$SERVICE"
systemctl restart "$SERVICE"
sleep 4
if systemctl is-active --quiet "$SERVICE"; then
  info "nubyone is running"
else
  warn "Service may have failed — check logs:"
  warn "  journalctl -u ${SERVICE} -n 60 --no-pager"
fi

# ── Step 16: Write secure .env config ────────────────────────────────
step "Writing secure config file"
cat > "${DEPLOY_DIR}/.env" <<ENVCFG
GITHUB_TOKEN=${GITHUB_TOKEN}
GITHUB_REPO=${GITHUB_REPO}
GITHUB_BRANCH=${GITHUB_BRANCH}
DEPLOY_DIR=${DEPLOY_DIR}
SERVER_DIR=${SERVER_DIR}
CLIENT_DIR=${CLIENT_DIR}
SERVICE=${SERVICE}
DOMAIN=${DOMAIN}
NUBYONE_PUBLIC_URL=https://${DOMAIN}
GO_PLAIN_VERSION=${GO_PLAIN_VERSION}
GO_GARBLE_VERSION=${GO_GARBLE_VERSION}
ENVCFG
chmod 600 "${DEPLOY_DIR}/.env"
info "Config saved: ${DEPLOY_DIR}/.env (root-only)"

# Record which ref was just deployed (used by tag-watcher to detect new tags)
INITIAL_TAG=$(git -C "${DEPLOY_DIR}" describe --tags --abbrev=0 2>/dev/null || echo "")
echo "${INITIAL_TAG}" > "${DEPLOY_DIR}/.deployed-tag"
info "Initial deployed tag: ${INITIAL_TAG:-'(no tags yet — watcher will deploy first tag that appears)'}"

# ── Step 17: Write update.sh (tag-aware) ─────────────────────────────
step "Writing update script"
cat > "${DEPLOY_DIR}/update.sh" <<'UPDSH_EOF'
#!/usr/bin/env bash
# update.sh — Pull latest code (tag or branch) and restart Nubyone.
#
# Usage:
#   sudo bash /opt/nubyone/update.sh               # pull latest (tag if exists, else branch)
#   sudo bash /opt/nubyone/update.sh v1.2.0        # pull a specific tag
#   sudo GITHUB_TOKEN=ghp_xxx bash /opt/nubyone/update.sh   # override token from .env
#
set -euo pipefail

export BUN_INSTALL="/root/.bun"
export PATH="/root/.bun/bin:/root/go/bin:/usr/local/go/bin:/usr/local/bin:/usr/bin:/sbin:/bin"
export GOPATH="/root/go"

# ── Preserve any token passed in the environment BEFORE sourcing .env ──
_ENV_TOKEN="${GITHUB_TOKEN:-}"

# Load config written by deploy.sh
ENV_FILE="$(dirname "$0")/.env"
[[ -f "$ENV_FILE" ]] || { echo "ERROR: .env not found at ${ENV_FILE}"; exit 1; }
# shellcheck source=/dev/null
source "$ENV_FILE"

# Env-var token always wins over the one stored in .env
[[ -n "$_ENV_TOKEN" ]] && GITHUB_TOKEN="$_ENV_TOKEN"

# ── Sanity checks ─────────────────────────────────────────────────────
[[ -z "$GITHUB_TOKEN" || "$GITHUB_TOKEN" == "token-here" ]] && {
  echo "ERROR: GITHUB_TOKEN is missing or still set to the placeholder."
  echo "       Run: sudo GITHUB_TOKEN=ghp_xxx bash $(realpath "$0")"
  exit 1
}

# ── Ensure build tools are present ───────────────────────────────────
if [[ ! -x /root/go/bin/garble ]]; then
  echo "==> Installing garble (required for compact agent builds)..."
  GOROOT="/root/sdk/${GO_GARBLE_VERSION:+go${GO_GARBLE_VERSION}}" \
  GOPATH=/root/go \
  GOPROXY="https://proxy.golang.org,direct" \
  GOTELEMETRY=off GOTOOLCHAIN=local \
    "/root/sdk/go${GO_GARBLE_VERSION}/bin/go" install "mvdan.cc/garble@v0.16.0" 2>&1 | tail -5 \
    || echo "WARN: garble install failed — EXEs will be larger"
fi

CLONE_URL="https://${GITHUB_TOKEN}@github.com/${GITHUB_REPO}.git"
TAG_FILE="${DEPLOY_DIR}/.deployed-tag"

# ── Resolve what to pull: tag arg → latest remote tag → branch ────────
if [[ "${1:-}" != "" ]]; then
  # Explicit tag/ref passed as argument
  PULL_MODE="tag"
  TARGET_REF="$1"
  echo "==> Target tag specified: ${TARGET_REF}"
else
  echo "==> Checking for latest tag on GitHub..."
  LATEST_TAG=$(curl -sf \
    -H "Authorization: token ${GITHUB_TOKEN}" \
    -H "Accept: application/vnd.github.v3+json" \
    "https://api.github.com/repos/${GITHUB_REPO}/tags" \
    | grep '"name"' | head -1 | sed 's/.*"name": "\(.*\)".*/\1/' 2>/dev/null || echo "")

  if [[ -n "$LATEST_TAG" ]]; then
    PULL_MODE="tag"
    TARGET_REF="$LATEST_TAG"
    echo "==> Latest tag: ${TARGET_REF}"
  else
    # No tags on this repo — fall back to tracking the branch
    PULL_MODE="branch"
    TARGET_REF="${GITHUB_BRANCH:-main}"
    echo "==> No tags found — pulling latest from branch '${TARGET_REF}'"
  fi
fi

# Skip if already on this tag (branch pulls always proceed)
if [[ "$PULL_MODE" == "tag" ]]; then
  CURRENT_TAG=$(cat "$TAG_FILE" 2>/dev/null || echo "")
  if [[ "$CURRENT_TAG" == "$TARGET_REF" ]]; then
    echo "==> Already on ${TARGET_REF} — nothing to do."
    exit 0
  fi
  echo "==> Updating ${CURRENT_TAG:-'(none)'} → ${TARGET_REF}..."
fi

# ── Pull ──────────────────────────────────────────────────────────────
git -C "${DEPLOY_DIR}" remote set-url origin "${CLONE_URL}"
if [[ "$PULL_MODE" == "tag" ]]; then
  git -C "${DEPLOY_DIR}" fetch --quiet --tags origin
  git -C "${DEPLOY_DIR}" reset --hard "refs/tags/${TARGET_REF}"
else
  git -C "${DEPLOY_DIR}" fetch --quiet origin "${TARGET_REF}"
  git -C "${DEPLOY_DIR}" reset --hard "origin/${TARGET_REF}"
fi
git -C "${DEPLOY_DIR}" clean -fd --quiet
git -C "${DEPLOY_DIR}" remote set-url origin "https://github.com/${GITHUB_REPO}.git"
echo "==> Code updated."

# ── Rebuild ───────────────────────────────────────────────────────────
echo "==> Installing packages and rebuilding CSS..."
bun_install "${SERVER_DIR}"
(cd "${SERVER_DIR}" && bun run build:css)

echo "==> Syncing Go vendor directory..."
if [[ -d "${CLIENT_DIR}" ]]; then
  ( cd "${CLIENT_DIR}" && \
    GOROOT="/root/sdk/go${GO_PLAIN_VERSION}" \
    GOPATH="/root/go" \
    GOCACHE="${DEPLOY_DIR}/.cache/go-build" \
    GONOSUMDB="*" GOTELEMETRY="off" GOTOOLCHAIN="local" \
    "/root/sdk/go${GO_PLAIN_VERSION}/bin/go" mod vendor 2>/dev/null | tail -3 || true )
fi

# ── Restart ───────────────────────────────────────────────────────────
echo "==> Restarting nubyone service..."
systemctl restart "${SERVICE}"
sleep 4

if systemctl is-active --quiet "${SERVICE}"; then
  [[ "$PULL_MODE" == "tag" ]] && echo "${TARGET_REF}" > "$TAG_FILE"
  echo ""
  echo "Done. https://${DOMAIN} is now running."
  echo "Logs: journalctl -u ${SERVICE} -f"
else
  echo "ERROR: Service failed to start! Check logs:"
  echo "  journalctl -u ${SERVICE} -n 60 --no-pager"
  exit 1
fi
UPDSH_EOF
chmod 700 "${DEPLOY_DIR}/update.sh"
info "Update script: ${DEPLOY_DIR}/update.sh"

# ── Step 18: Write reset-admin.sh (emergency credential reset) ───────
step "Writing reset-admin script"
cat > "${DEPLOY_DIR}/reset-admin.sh" <<'RESETSH_EOF'
#!/usr/bin/env bash
# reset-admin.sh — Reset the admin account to the credentials in .env / env vars.
#
# Run this any time you are locked out or the password is out of sync:
#   sudo bash /opt/nubyone/reset-admin.sh
#
# Optionally override credentials on the fly:
#   sudo ADMIN_USER=anon_ ADMIN_PASS=NewPass123 bash /opt/nubyone/reset-admin.sh
set -euo pipefail

export BUN_INSTALL="/root/.bun"
export PATH="/root/.bun/bin:/usr/local/bin:/usr/bin:/sbin:/bin"

# ── Load .env (values set in the environment always win) ──────────────
_ENV_USER="${ADMIN_USER:-}"
_ENV_PASS="${ADMIN_PASS:-}"

ENV_FILE="$(dirname "$0")/.env"
[[ -f "$ENV_FILE" ]] && source "$ENV_FILE"

[[ -n "$_ENV_USER" ]] && ADMIN_USER="$_ENV_USER"
[[ -n "$_ENV_PASS" ]] && ADMIN_PASS="$_ENV_PASS"

ADMIN_USER="${ADMIN_USER:-admin}"
ADMIN_PASS="${ADMIN_PASS:-}"

[[ -z "$ADMIN_PASS" ]] && {
  echo "ERROR: ADMIN_PASS is not set."
  echo "       Run: sudo ADMIN_PASS=YourNewPassword bash $(realpath "$0")"
  exit 1
}

DB_PATH="${SERVER_DIR}/data/nubyone.db"
[[ -f "$DB_PATH" ]] || { echo "ERROR: database not found at ${DB_PATH}"; exit 1; }

echo "==> Hashing new password..."
HASH=$(ADMIN_PASS="$ADMIN_PASS" bun -e \
  "const p=process.env.ADMIN_PASS; const h=await require('bun').password.hash(p); process.stdout.write(h)")

echo "==> Updating admin account in database..."
# Update the existing admin-role row if it exists, otherwise insert fresh.
EXISTING=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM users WHERE username='${ADMIN_USER}'")
if [[ "$EXISTING" -gt 0 ]]; then
  sqlite3 "$DB_PATH" "UPDATE users SET password_hash='${HASH}' WHERE username='${ADMIN_USER}'"
  echo "    Updated password for existing user: ${ADMIN_USER}"
else
  sqlite3 "$DB_PATH" \
    "INSERT INTO users (username, password_hash, role, created_by) VALUES ('${ADMIN_USER}','${HASH}','admin','reset-admin.sh')"
  echo "    Created new admin user: ${ADMIN_USER}"
fi

echo ""
echo "Done. Restart the service to apply:"
echo "  systemctl restart nubyone"
echo ""
echo "Login: ${ADMIN_USER} / ${ADMIN_PASS}"
RESETSH_EOF
chmod 700 "${DEPLOY_DIR}/reset-admin.sh"
info "Reset script: ${DEPLOY_DIR}/reset-admin.sh"

# ── Step 19: Tag-watcher (systemd timer, polls every 5 min) ──────────
step "Setting up tag-watcher (auto-deploy on new git tag)"

cat > "${DEPLOY_DIR}/tag-watch.sh" <<'WATCH_EOF'
#!/usr/bin/env bash
# tag-watch.sh — Run by systemd timer every 5 minutes.
# Checks GitHub for a new tag; if found, calls update.sh to deploy it.
set -euo pipefail

export PATH="/root/go/bin:/usr/local/go/bin:/usr/local/bin:/usr/bin:/sbin:/bin"

ENV_FILE="$(dirname "$0")/.env"
[[ -f "$ENV_FILE" ]] || exit 0
# shellcheck source=/dev/null
source "$ENV_FILE"

TAG_FILE="${DEPLOY_DIR}/.deployed-tag"
CURRENT_TAG=$(cat "$TAG_FILE" 2>/dev/null || echo "")

LATEST_TAG=$(curl -sf \
  -H "Authorization: token ${GITHUB_TOKEN}" \
  -H "Accept: application/vnd.github.v3+json" \
  "https://api.github.com/repos/${GITHUB_REPO}/tags" \
  | grep '"name"' | head -1 | sed 's/.*"name": "\(.*\)".*/\1/' || echo "")

if [[ -z "$LATEST_TAG" ]]; then
  # GitHub unreachable or no tags yet — silently skip
  exit 0
fi

if [[ "$LATEST_TAG" == "$CURRENT_TAG" ]]; then
  # Already on the latest tag — nothing to do
  exit 0
fi

echo "[tag-watch] New tag detected: ${CURRENT_TAG:-'(none)'} → ${LATEST_TAG}"
exec bash "${DEPLOY_DIR}/update.sh" "${LATEST_TAG}"
WATCH_EOF
chmod 700 "${DEPLOY_DIR}/tag-watch.sh"
info "Tag-watcher script: ${DEPLOY_DIR}/tag-watch.sh"

# Systemd one-shot service that tag-watch.timer activates
cat > "/etc/systemd/system/${SERVICE}-tag-watch.service" <<EOF
[Unit]
Description=Nubyone tag-watcher — auto-deploy on new git tag
After=network-online.target

[Service]
Type=oneshot
ExecStart=/bin/bash ${DEPLOY_DIR}/tag-watch.sh
StandardOutput=journal
StandardError=journal
SyslogIdentifier=${SERVICE}-tag-watch
EOF

# Timer: run every 5 minutes, starting 2 minutes after boot
cat > "/etc/systemd/system/${SERVICE}-tag-watch.timer" <<EOF
[Unit]
Description=Nubyone tag-watcher timer (every 5 min)

[Timer]
OnBootSec=2min
OnUnitActiveSec=5min
Persistent=true

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable  "${SERVICE}-tag-watch.timer"
systemctl start   "${SERVICE}-tag-watch.timer"
info "Tag-watcher timer enabled (fires every 5 minutes)"
info "Check: systemctl list-timers | grep nubyone"

# ── Summary ───────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}${BOLD}╔══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}${BOLD}║              DEPLOYMENT COMPLETE  🚀                         ║${NC}"
echo -e "${GREEN}${BOLD}╚══════════════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "  ${CYAN}${BOLD}URL:${NC}      https://${DOMAIN}"
echo -e "  ${CYAN}${BOLD}Login:${NC}    ${ADMIN_USER:-anon_} / ${ADMIN_PASS}"
echo ""
echo -e "  ${CYAN}${BOLD}Toolchain:${NC}"
echo    "    Plain builds  → Go ${GO_PLAIN_VERSION}  at /root/sdk/go${GO_PLAIN_VERSION}"
echo    "    Garble builds → Go ${GO_GARBLE_VERSION}  at /root/sdk/go${GO_GARBLE_VERSION}"
echo    "    garble        → $(command -v garble 2>/dev/null || echo '/root/go/bin/garble (install may have failed)')"
echo    "    upx           → $(command -v upx 2>/dev/null || echo 'not found')"
echo ""
echo -e "  ${CYAN}${BOLD}Auto-deploy:${NC} Tag-watcher polls GitHub every 5 minutes."
echo    "    To go live → push a git tag from your machine:"
echo    "      git tag v1.0.0 && git push origin v1.0.0"
echo    "    Manual deploy → sudo bash ${DEPLOY_DIR}/update.sh [tag]"
echo    "    Watcher logs  → journalctl -u ${SERVICE}-tag-watch -f"
echo ""
echo    "  View server logs:  journalctl -u ${SERVICE} -f"
echo    "  Stop server:       systemctl stop ${SERVICE}"
echo    "  Stop tag-watcher:  systemctl stop ${SERVICE}-tag-watch.timer"
echo ""
echo -e "${YELLOW}  ⚠  Change the admin password in the web UI after first login!${NC}"
echo -e "${YELLOW}  ⚠  ${DEPLOY_DIR}/.env and update.sh contain your GitHub token (chmod 600/700 — already set).${NC}"
echo ""
