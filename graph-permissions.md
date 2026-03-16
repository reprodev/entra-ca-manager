# Azure App Registration - Required Permissions

Each client tenant needs an App Registration with Microsoft Graph **application permissions** before it can be connected to CA Manager.

## Setup steps

1. Open Azure portal for the client tenant.
2. Go to `Azure Active Directory -> App registrations -> New registration`.
3. Name the app (example: `CA Manager - MSP Access`).
4. Set account type to **Single tenant**.
5. In `API permissions`, add Microsoft Graph **Application permissions**.
6. Add the permissions listed below.
7. Click **Grant admin consent**.
8. Create a client secret in `Certificates & secrets`.
9. Record:
   - Application (client) ID
   - Directory (tenant) ID
   - Client secret value

## Required application permissions

| Permission | Reason |
|---|---|
| `Policy.Read.All` | Read existing Conditional Access policies |
| `Policy.ReadWrite.ConditionalAccess` | Create/update/delete Conditional Access policies |
| `Directory.Read.All` | Read users, groups, and directory objects |
| `AuditLog.Read.All` | Read sign-in and audit data |
| `Calendars.ReadWrite` | Create/update management reminder events in Outlook calendars |

## Notes

- All permissions above are **application permissions**.
- Admin consent is required in each client tenant.
- Rotate client secrets regularly (recommended max 12 months).
- For stronger security, prefer certificate-based auth over long-lived secrets where possible.
