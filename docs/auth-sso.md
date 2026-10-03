# Authentication, Single Sign-On (SSO), and Workspace Roles

## 1. Overview and Architecture

AIRP provides a unified identity and access management layer behind the `AuthProvider` interface (`packages/common/src/auth.ts`). This interface governs authentication across the incident viewer console, administrative CLI commands, and inter-service API communication.

AIRP adopts **self-hosted Better Auth** as the real, concrete provider behind the `AuthProvider` interface, with the interface retained as the stable seam for future providers.

### Authentication Modes

1. **Better Auth (Self-Hosted Default)**:
   - Self-hosted instance with no per-user pricing (satisfies unlimited-members tiers and the local-first, no-paid-cloud-for-local-dev requirement).
   - Backed by PostgreSQL in production (`DATABASE_URL`) or an in-memory/SQLite adapter during local development and automated testing.
   - Built-in `bearer()`, `organization()`, and `admin()` plugins provide token authentication, organization multi-tenancy, and granular role-based access control.
   - Seamlessly handles `demo-token` for local developer ergonomics.

2. **LocalAuth (Lightweight Local JWT Fallback)**:
   - Uses local HMAC-SHA256 signed JWT tokens.
   - Available when running standalone micro-components offline without database access.

3. **OIDCAuth (Production Enterprise SSO)**:
   - Standards-compliant OpenID Connect (OIDC) authentication.
   - Automatically wired when `OIDC_ISSUER` and `OIDC_CLIENT_ID` environment variables are set.
   - Validates tokens issued by enterprise identity providers (Okta, Azure AD, Google Workspace, Keycloak).

---

## 2. Workspace Roles and Responsibilities

AIRP enforces a four-tier workspace role hierarchy across all APIs and operations:

| Role | Title | Description | Allowed Operations | Restricted (403 Forbidden) |
| :--- | :--- | :--- | :--- | :--- |
| **Owner** | Workspace Owner | Full administrative authority over workspace settings, members, secret rotation, and incident response. | All permissions: settings write/read, members manage/read, secrets rotate, investigations run, operations execute, workspace read. | None |
| **Admin** | Workspace Administrator | Administrative authority to manage settings, invite/remove members, rotate secrets, and run operations. | All permissions: settings write/read, members manage/read, secrets rotate, investigations run, operations execute, workspace read. | None |
| **Member** | Incident Responder / Operator | Operational authority to investigate incidents and execute remediation runbooks. | `investigation:run`, `operation:execute`, `workspace:read`, `workspace:settings:read`, `workspace:members:read` | `workspace:settings:write` (e.g. `ui.theme.accent`), `workspace:members:manage`, `secrets:rotate` |
| **Viewer** | Auditor / Read-Only Observer | Read-only observation of incidents, dashboards, timelines, and metrics. | `workspace:read`, `workspace:settings:read`, `workspace:members:read` | `investigation:run`, `operation:execute`, `workspace:settings:write`, `workspace:members:manage`, `secrets:rotate` |

### Responsibilities Breakdown

1. **Owners and Admins**:
   - Manage workspace-level configuration and feature flags (including UI preferences such as `ui.theme.accent`).
   - Manage workspace member lifecycle (invite new users, update roles, revoke memberships).
   - Execute secret rotation drills (`airp secrets rotate`) and manage encryption keys.
   - Trigger incident investigations and actuate automated remediation actions.

2. **Members**:
   - Investigate ongoing alerts and incidents (`POST /investigate`).
   - Execute operational actions and automated fix proposals.
   - View incident timelines, telemetry, and logs.
   - *Forbidden (403)*: Cannot alter workspace flags/settings, invite or remove team members, or trigger secret rotations.

3. **Viewers**:
   - Strictly read-only access to incident reports, dashboards, and audit logs.
   - *Forbidden (403)*: Cannot execute operations, run investigations, rotate secrets, or modify settings.

### API Layer Enforcement

Role permissions are enforced at the API layer via Better Auth's organization access control and middleware (`createRolePermissionMiddleware`):

```typescript
// Example: Restricting workspace settings update to Owners and Admins
server.post("/api/workspace/settings", {
  preHandler: [createRolePermissionMiddleware(authProvider)("workspace:settings:write")],
}, async (req, reply) => {
  // Only Owners and Admins reach this handler; Members and Viewers receive HTTP 403
  await updateWorkspaceSetting(req.body);
  return reply.send({ status: "updated" });
});
```

When an unauthorized role attempts a restricted endpoint, the API immediately returns `HTTP 403 Forbidden`:

```json
{
  "error": "Forbidden",
  "message": "Role 'member' is not authorized to perform 'workspace:settings:write'",
  "role": "member",
  "permission": "workspace:settings:write"
}
```

---

## 3. Configuration Parameters

| Environment Variable | Description | Default / Mode |
| :--- | :--- | :--- |
| `AUTH_PROVIDER` | Explicit provider selection (`better-auth`, `local`, `oidc`) | Defaults to `better-auth` (or `oidc` if OIDC env vars set) |
| `BETTER_AUTH_SECRET` | Secret key used by Better Auth to sign tokens and sessions | Ephemeral fallback in dev |
| `BETTER_AUTH_URL` | Base URL of the Better Auth instance | `http://localhost:3000` |
| `DATABASE_URL` | PostgreSQL connection string for Better Auth persistent tables | In-memory adapter if unset |
| `OIDC_ISSUER` | Base URL of OpenID Connect identity provider | Unset (enables Better Auth) |
| `OIDC_CLIENT_ID` | OAuth 2.0 / OIDC Client ID registered with the IdP | Required if OIDC enabled |
| `OIDC_CLIENT_SECRET` | Client secret for token exchange / HMAC validation | Optional |
| `SERVICE_ACCOUNT_SECRET`| Secret used to mint short-lived service tokens | Ephemeral fallback if unset |

---

## 4. Enterprise SSO (SAML 2.0) and SCIM Provisioning: Deferred Path

In accordance with architectural planning:
- **SAML 2.0 and SCIM 2.0 are deferred until the first enterprise prospect.**
- Because AIRP uses self-hosted Better Auth, the enterprise migration requires **zero rip-and-replace**: the `@better-auth/sso` plugin natively supports SAML 2.0, OAuth 2.0, and domain-based provider resolution with organization multi-tenancy.
- Downstream services and APIs continue to authenticate strictly against the `AuthProvider` seam without knowing or caring about upstream protocol differences.

---

## 5. Service Accounts and Short-Lived Automation Tokens

Automated platform components (such as CI runners, rollout controllers, and health monitors) authenticate using short-lived tokens minted by the local issuer.

- **Short Lifetime**: Service account tokens default to 300 seconds (5 minutes) expiration.
- **Zero Static Secrets**: No static access keys or tokens are stored in configuration files or code repositories.
- **Minting Function**:
  ```typescript
  const token = mintServiceAccountToken({
    serviceId: "rollout-controller",
    roles: ["automation:actuate"],
    expiresInSeconds: 300,
  });
  ```
