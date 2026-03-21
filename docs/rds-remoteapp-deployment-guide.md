# RDS RemoteApp Deployment Guide

Audience: MSP platform engineers deploying `entra-ca-manager` for internal staff via Windows
Remote Desktop Services (RDS) or Azure Virtual Desktop (AVD).

This guide covers running the app as a shared Windows Service and publishing it to staff as a
RemoteApp shortcut — no desktop packaging, no installer, no code changes required.

---

## Overview

The app is a Node.js HTTP server serving a browser-based UI. In an RDS/AVD environment the
recommended model is:

1. Run one instance of the Node.js server as a **shared Windows Service** on a host the RDS
   session hosts can reach.
2. Publish a **RemoteApp** that launches Edge in app mode pointing at the service URL.

Staff see a native-feeling window in their taskbar with no browser chrome. Updates to the app
are invisible to users — they get the latest version on their next session without reinstalling
anything.

---

## Architecture

```
┌─────────────────────────────────┐
│   RDS Session Hosts (or AVD)    │
│                                 │
│  User session → RemoteApp       │
│  msedge.exe --app=https://cam   │  ──────────► App Service Host
│  --profile-directory=CAManager  │              node src/server.js :3000
└─────────────────────────────────┘              │
                                                 ▼
                                          Redis (optional, recommended)
                                          Shared session state
```

The app server can run on:

- The RDS session host itself (simplest, suitable for a single-host setup)
- A dedicated Windows server on the same network (recommended for multi-host RDS farms)
- A Docker container — see [docker-deployment-guide.md](docker-deployment-guide.md)

---

## 1) Prerequisites

- Windows Server with RDS/RemoteApp role configured (or Azure Virtual Desktop app group)
- Node.js LTS (v20 or v22) installed on the app server host
- Microsoft Edge installed on RDS session hosts
- A prepared `.env` file (see [Section 3](#3-environment-configuration))
- An Entra App Registration with the `SSO_REDIRECT_URI` added as a redirect URI (see [Section 4](#4-entra-app-registration))
- Optional but recommended for multi-host: a Redis instance for shared session state

---

## 2) App server setup

### Option A: Native Node.js service (recommended for simplicity)

**Step 1 — Place the app files**

Clone or copy the repository to a permanent directory on the app server, for example:

```
C:\Services\entra-ca-manager\
```

**Step 2 — Install dependencies**

```cmd
cd C:\Services\entra-ca-manager
npm ci --omit=dev
```

**Step 3 — Configure the environment**

Copy `.env.example` to `.env` and fill in production values. See [Section 3](#3-environment-configuration).

**Step 4 — Verify the app starts**

```cmd
node src\server.js
```

Confirm `GET http://127.0.0.1:3000/health` returns a 200 response, then stop it with `Ctrl+C`.

**Step 5 — Install NSSM and register as a Windows Service**

Download [NSSM](https://nssm.cc/download) and place `nssm.exe` in a location on your PATH
(for example `C:\Tools\nssm\`).

```cmd
nssm install entra-ca-manager "C:\Program Files\nodejs\node.exe" "src\server.js"
nssm set entra-ca-manager AppDirectory "C:\Services\entra-ca-manager"
nssm set entra-ca-manager AppEnvironmentExtra ":env file=C:\Services\entra-ca-manager\.env"
nssm set entra-ca-manager Start SERVICE_AUTO_START
nssm set entra-ca-manager AppRestartDelay 5000
sc start entra-ca-manager
```

Verify the service is running:

```cmd
sc query entra-ca-manager
curl http://127.0.0.1:3000/health
```

### Option B: Docker (if Docker Desktop for Windows is available)

See [docker-deployment-guide.md](docker-deployment-guide.md) for full Docker and Compose
instructions. The GHCR-hosted image works without cloning the repository:

```cmd
docker run --name entra-ca-manager --detach ^
  -p 3000:3000 ^
  --env-file C:\Services\entra-ca-manager\.env ^
  -e NODE_ENV=production ^
  -v entra_ca_data:/app/data ^
  ghcr.io/reprodev/entra-ca-manager:latest
```

---

## 3) Environment configuration

Key variables for an RDS deployment:

```env
# Auth — SSO is the standard choice for staff
ENABLE_SSO_LOGIN=true
ENABLE_LOCAL_LOGIN=false
SSO_TENANT_ID=<your-entra-tenant-id>
SSO_CLIENT_ID=<app-registration-client-id>
SSO_CLIENT_SECRET=<app-registration-client-secret>

# This must be a routable HTTPS URL — NOT localhost — so the Entra callback reaches the service
SSO_REDIRECT_URI=https://cam.internal/auth/callback
SSO_POST_LOGOUT_REDIRECT_URI=https://cam.internal

# Session
SESSION_SECRET=<long-random-secret>
SESSION_COOKIE_SECURE=true
SESSION_TTL_HOURS=8

# Redis — required for multi-host RDS farms; recommended for single-host (survives restarts)
REDIS_ENABLED=true
REDIS_REQUIRED=true
REDIS_URL=redis://<redis-host>:6379
REDIS_KEY_PREFIX=cam-rds

# Audit
AUDIT_LOG_ENABLED=true
AUDIT_LOG_SECRET=<long-random-secret>
```

> **Note on `SESSION_COOKIE_SECURE`**: This is automatically set to `true` when
> `SSO_REDIRECT_URI` uses `https://`. Set it explicitly if using local auth only.

For a full list of available variables see `.env.example` in the repository root.

---

## 4) Entra App Registration

The `SSO_REDIRECT_URI` must be registered in your Entra App Registration before SSO will work.

1. In the Azure portal, open **Entra ID** → **App registrations** → your app.
2. Go to **Authentication** → **Redirect URIs**.
3. Add: `https://cam.internal/auth/callback`
4. Under **Implicit grant and hybrid flows**, ensure these are **not** enabled (not required for
   this auth flow).
5. Save.

Replace `cam.internal` with whatever hostname your app server is reachable at from within the
RDS sessions.

---

## 5) Publish as a RemoteApp

### Classic RDS (RemoteApp Manager)

1. Open **Server Manager** → **Remote Desktop Services** → **Collections**.
2. Select your session collection → **RemoteApp Programs** → **Publish RemoteApp Programs**.
3. Click **Add** and browse to:
   ```
   C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe
   ```
4. Set **Command-line arguments**:
   ```
   --app=https://cam.internal --profile-directory=CAManager
   ```
5. Set **RemoteApp program name**: `CA Manager`
6. Optionally assign a custom icon from the `assets/` folder in the repository.
7. Finish the wizard. The RemoteApp will appear in the RD Web Access portal.

### Azure Virtual Desktop (App Group)

```powershell
New-AzWvdApplication `
  -ResourceGroupName "rg-avd" `
  -HostPoolName "hp-msp" `
  -ApplicationGroupName "ag-tools" `
  -Name "CAManager" `
  -FriendlyName "CA Manager" `
  -FilePath "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" `
  -CommandLineSetting Require `
  -CommandLineArguments "--app=https://cam.internal --profile-directory=CAManager" `
  -ShowInPortal $true
```

### Distributing the shortcut via GPO or Intune

Export the `.rdp` file from the RD Web portal and deploy it to staff machines:

- **GPO**: Copy the `.rdp` file to a network share and use a startup script or folder redirection
  to place it in `%USERPROFILE%\Desktop` or the Start Menu.
- **Intune**: Upload the `.rdp` file as a Win32 app or deploy it via a PowerShell remediation
  script.

---

## 6) Multi-user session isolation

Each RDS user gets their own Edge profile via `--profile-directory=CAManager`. This means:

- Session cookies (`cam_sid`) are isolated per user — no cross-user session leakage.
- Each user authenticates independently via SSO.
- Concurrent users on the same session host do not interfere with each other.

> **Important**: Do not omit `--profile-directory`. Without it, multiple concurrent users on the
> same RDS host share an Edge profile and will see each other's sessions.

---

## 7) Multi-host RDS farms

If your RDS farm has more than one session host (or if the app server may restart), enable Redis
so sessions survive host changes and restarts:

```env
REDIS_ENABLED=true
REDIS_REQUIRED=true
REDIS_URL=redis://<shared-redis-host>:6379
```

Without Redis, a user whose RDS session reconnects to a different host will be logged out and
need to re-authenticate. With Redis, the session persists transparently.

**Known limitation**: Account lockout state for local auth users is stored in
`data/local-users.json`, not in Redis. In a multi-host setup where multiple app server instances
share a network-mounted data directory, lockout state is consistent. If each host has its own
copy of the file, lockout state is per-host. This is acceptable for internal MSP staff using SSO
(where local auth is typically disabled).

---

## 8) Rate limiting in RDS environments

The app rate-limits auth endpoints by source IP address. In an RDS environment, all users on the
same session host share the same outbound IP. The default limits are generous for internal use:

| Endpoint | Default limit | Window |
| --- | --- | --- |
| Local login | 12 attempts | 15 min |
| SSO / callback | 30 attempts | 15 min |
| Admin mutations | 45 requests | 15 min |

These defaults are suitable for a team of MSP staff. If needed, adjust via:

```env
AUTH_RATE_LIMIT_SSO_MAX=60
AUTH_RATE_LIMIT_WINDOW_SECONDS=900
```

---

## 9) Upgrade procedure

**Native service:**

```cmd
sc stop entra-ca-manager
# Replace app files (git pull or copy new release)
npm ci --omit=dev
sc start entra-ca-manager
curl http://127.0.0.1:3000/health
```

**Docker:**

```cmd
docker compose -f compose.ghcr.yml pull
docker compose -f compose.ghcr.yml up -d
```

Users do not need to update anything. Their next RemoteApp session will use the new version
automatically.

---

## 10) Why not Electron or Tauri

For reference, the alternatives were evaluated and rejected for this use case:

| Factor | Electron | Tauri | RDS RemoteApp |
| --- | --- | --- | --- |
| New infra needed | No | No | No (RDS already exists) |
| Binary size | ~150 MB | ~10–15 MB | 0 |
| Build toolchain | Node + electron-builder | Rust + Tauri CLI | None |
| Code signing (Windows) | Required | Required | Not required |
| Multi-user RDS | Per-user port conflicts | Same | Native fit |
| App code changes | Shell wrapper needed | Shell wrapper needed | None |
| Managed deployment | MSI/MSIX + Intune pipeline | Same | Publish RemoteApp shortcut |

Electron and Tauri are appropriate when the app needs to run on unmanaged machines or work
offline without a network-accessible server. Neither condition applies here.
