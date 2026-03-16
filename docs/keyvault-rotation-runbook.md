# Key Vault + Secret Rotation Runbook

## Goal

Run CA Manager with secrets sourced from Azure Key Vault using managed identity, then rotate them safely.

## 1) Enable managed identity

For Azure App Service:

1. Open App Service -> **Identity**.
2. Enable **System assigned** managed identity.
3. Save and capture the principal object ID.

## 2) Grant Key Vault access

In Key Vault:

1. Add access policy or RBAC role for the App Service managed identity.
2. Minimum required:
   - `Key Vault Secrets User` (read secrets)

## 3) Configure app settings

Set:

```env
ENABLE_KEYVAULT_SECRETS=true
KEYVAULT_URL=https://<your-vault-name>.vault.azure.net/
KEYVAULT_SECRET_MAPPINGS=SESSION_SECRET=ca-session-secret,SSO_CLIENT_SECRET=ca-sso-client-secret,AZURE_CLIENT_SECRET=ca-graph-client-secret
KEYVAULT_OVERRIDE_EXISTING=false
KEYVAULT_TIMEOUT_MS=10000
```

Optional Redis distributed mode:

```env
REDIS_ENABLED=true
REDIS_URL=rediss://<redis-endpoint>:6380
REDIS_REQUIRED=true
REDIS_KEY_PREFIX=cam-prod
```

## 4) Rotation workflow (recommended)

1. Create a new secret version in Key Vault.
2. Confirm secret metadata and expiration policy.
3. Restart App Service (or trigger a controlled deployment recycle).
4. Verify startup log indicates Key Vault hydration success.
5. Validate auth flows and admin mutation operations.
6. Re-run smoke checks:
   - `GET /health`
   - sign-in path test
   - `npm run e2e:auth:hardening` in pipeline/staging

## 5) Emergency rotation

For suspected secret compromise:

1. Rotate secret in Key Vault immediately.
2. Restart all app instances.
3. Force session invalidation by rotating `SESSION_SECRET`.
4. Review audit logs and incident-response checklist.

## 6) Governance guidance

- enforce secret expiry policies
- alert on near-expiry secrets
- keep mapping list under change control
- avoid storing plaintext credentials in repo or tickets
