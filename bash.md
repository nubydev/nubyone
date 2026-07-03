# Nubyone — VPS Deployment Guide

> You do **not** need to log in as `root`. Any user with `sudo` access works.

---

## Before you start

Make sure your VPS has:
- Ubuntu 22.04 or 24.04
- A domain (e.g. `manage.example.com`) with its **DNS A record already pointing to the VPS IP**
- Port **80** and **443** open in your provider's firewall panel (Hostinger / DigitalOcean / etc.)
- SSH access as a normal user (e.g. `john@123.45.67.89`)

---

## Step 1 — SSH into your VPS

```bash
ssh youruser@your-vps-ip
```

---

## Step 2 — Download deploy.sh onto the VPS

```bash
curl -H "Authorization: token YOUR_GITHUB_TOKEN" \
  -L https://raw.githubusercontent.com/iamfontane/nubyone/main/deploy.sh \
  -o deploy.sh
```

> Replace `YOUR_GITHUB_TOKEN` with your GitHub classic personal access token (repo scope).
> The repo is private so the token is required to download the file.

---

## Step 3 — Run the installer

> ⚠️ The domain hardcoded in `deploy.sh` is `nubyone.ydns.org` — this is **wrong**.  
> Always override it with `DOMAIN=nubyone.ydns.eu` on the command line, as shown below.

**One-time command (copy-paste this exactly):**

```bash
DOMAIN=nubyone.ydns.eu LE_EMAIL=nubyone@gmail.com sudo -E bash deploy.sh
```

That's the only command you need. No file editing required.

The script takes **3–5 minutes** on a fresh VPS. When it finishes you will see:

```
╔══════════════════════════════════════════════════════════════╗
║              DEPLOYMENT COMPLETE  🚀                         ║
╚══════════════════════════════════════════════════════════════╝

  URL:      https://yourdomain.com
  Login:    admin / YourPassword

  Auto-deploy: Tag-watcher polls GitHub every 5 minutes.
    To go live → push a git tag from your machine:
      git tag v1.0.0 && git push origin v1.0.0
```

---

## Step 4 — Verify the build environment is ready

Once the server is live, confirm agent builds will work:

```bash
curl -s https://yourdomain.com/api/health/build | python3 -m json.tool
```

Expected response when everything is fully installed:

```json
{
  "ok": true,
  "plain_build_ready": true,
  "garble_build_ready": true,
  "message": "All good — garble + plain builds available."
}
```

---

## How tag-based auto-deployment works

After the first `sudo bash deploy.sh`, a **tag-watcher** is running on your VPS as a
systemd timer. Every 5 minutes it checks GitHub for a new tag. When it sees one it hasn't
deployed yet, it automatically pulls that tag, rebuilds, and restarts the server.

**Your release workflow from your local machine:**

```bash
# 1. Commit and push your code
git add .
git commit -m "feat: new feature"
git push origin main

# 2. Create and push a version tag — this triggers auto-deploy
git tag v1.2.0
git push origin v1.2.0
```

Within 5 minutes the VPS will pick it up and deploy it automatically.

**To deploy immediately** (without waiting for the timer):

```bash
sudo bash /opt/nubyone/update.sh          # deploys latest tag
sudo bash /opt/nubyone/update.sh v1.1.0   # deploys a specific older tag
```

**If a new version breaks the server**, `update.sh` automatically rolls back to the
previously working tag before exiting with an error.

---

## Useful day-to-day commands

| Task | Command |
|------|---------|
| View live server logs | `sudo journalctl -u nubyone -f` |
| View tag-watcher logs | `sudo journalctl -u nubyone-tag-watch -f` |
| Check timer schedule | `systemctl list-timers \| grep nubyone` |
| See currently deployed tag | `cat /opt/nubyone/.deployed-tag` |
| Restart server | `sudo systemctl restart nubyone` |
| Stop tag-watcher | `sudo systemctl stop nubyone-tag-watch.timer` |
| Re-enable tag-watcher | `sudo systemctl start nubyone-tag-watch.timer` |
| Renew SSL cert manually | `sudo certbot renew` |
| Test + reload nginx | `sudo nginx -t && sudo systemctl reload nginx` |

---

## Troubleshooting

**Service won't start — check logs:**
```bash
sudo journalctl -u nubyone -n 80 --no-pager
```

**Tag-watcher not firing:**
```bash
systemctl list-timers | grep nubyone
sudo journalctl -u nubyone-tag-watch -n 40 --no-pager
```

**Manually check for new tags right now:**
```bash
sudo bash /opt/nubyone/tag-watch.sh
```

**nginx config error:**
```bash
sudo nginx -t
sudo journalctl -u nginx -n 40 --no-pager
```

**SSL cert failed** (DNS not propagated yet — wait 5–10 min, then):
```bash
sudo certbot certonly --webroot --webroot-path /var/www/html \
  --email you@example.com --agree-tos --non-interactive \
  -d yourdomain.com
sudo systemctl reload nginx
```

**Agent builds failing after deploy:**
```bash
curl -s https://yourdomain.com/api/health/build | python3 -m json.tool
```
Check which SDK paths show `"found": false`. Options:
1. **In the UI** — log into Nubyone, go to Builder, click **Install Toolchains** in the Build Output panel header. It streams live progress and takes 2–4 min.
2. **On the VPS** — `sudo bash /opt/nubyone/scripts/setup-toolchains.sh`
3. **Re-run the full installer** — `sudo bash deploy.sh` (idempotent, skips already-completed steps).

The server also runs `setup-toolchains.sh` automatically on every startup, so a simple `sudo systemctl restart nubyone` after the first deploy will trigger the install if toolchains are missing.

---

## Re-running deploy.sh is always safe

Every step checks if it's already done before doing anything. If the script failed
halfway, fix the issue and run `sudo bash deploy.sh` again — completed steps are skipped.

---

## File layout on the VPS

```
/opt/nubyone/
├── .env                  ← GitHub token + config (root-only, chmod 600)
├── .deployed-tag         ← currently running tag (e.g. "v1.2.0")
├── .cache/go-build/      ← Go build cache (speeds up agent builds)
├── update.sh             ← deploy a tag manually (chmod 700)
├── tag-watch.sh          ← called by systemd timer every 5 min
├── Nubyone-Server/    ← server source + data/
└── Nubyone-Client/    ← Go agent source
```
