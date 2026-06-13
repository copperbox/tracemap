# SAML Auth + Team-Scoped Editing -- Implementation Plan

Status: proposed (design only, no code written yet)
Date: 2026-06-12

## Goal

Add Okta SAML SSO. Authenticated users can view the whole map. They can EDIT
only services owned by a team they have an editor grant for. AD group
membership (federated into Okta, sent in the SAML assertion) is the source of
truth for what each user can edit.

## Decisions locked

1. Reads are open to any authenticated user; only writes are team-scoped.
2. AD group -> access is an explicit DB mapping table (admin-managed), not
   name-convention parsing.
3. Session is a stateless JWT in an httpOnly cookie (no Redis / session table).
4. SAML for browser login; the app's own DB authorizes each request.

## Why SAML authenticates but does not authorize

A SAML assertion is a one-time, browser-delivered proof of identity + group
membership. It is not a per-request credential. So:

```
  Browser
    | (1) GET /api/auth/login           SP-initiated
    v
  API  --(2) 302 to Okta with AuthnRequest-->  Okta (federated w/ AD)
                                                  |
    <--(3) user authenticates, Okta POSTs --------+
           SAML assertion to /api/auth/saml/acs
    |
    | (4) API validates assertion, reads `groups` attribute,
    |     maps groups -> effective grants, mints session JWT,
    |     Set-Cookie (httpOnly, Secure, SameSite=Lax), 302 to app
    v
  SPA --(5) every /api/* call carries the cookie; API verifies JWT,
            attaches req.user = { sub, email, admin, editTeams[] }
```

The OTLP collector (port 4318) is NOT part of this. It is machine-to-machine
telemetry ingestion and must keep its own auth (bearer token / mTLS / network
isolation). Only the management API (config.port, default 4000) gets SAML.

## Dependencies to add (server)

- `@node-saml/node-saml`  -- build AuthnRequest, validate the POSTed assertion
- `@fastify/cookie`       -- read/set the session cookie
- `@fastify/jwt`          -- sign/verify the session JWT (reads it from cookie)

No new infra. All three are pure libraries.

## Config / env (extend server/src/config.ts)

```
auth: {
  enabled:        process.env.AUTH_ENABLED === 'true',     // rollout flag
  jwtSecret:      process.env.AUTH_JWT_SECRET,              // required when enabled
  sessionTtlSec:  Number(process.env.AUTH_SESSION_TTL_SEC ?? 8 * 3600),
  appBaseUrl:     process.env.APP_BASE_URL,                 // SPA origin, for redirects + CORS
  saml: {
    entryPoint:   process.env.SAML_ENTRY_POINT,   // Okta SSO URL
    issuer:       process.env.SAML_ISSUER,        // SP entity id (our app)
    callbackUrl:  process.env.SAML_CALLBACK_URL,  // .../api/auth/saml/acs
    idpCert:      process.env.SAML_IDP_CERT,      // Okta signing cert (PEM)
    groupsAttr:   process.env.SAML_GROUPS_ATTR ?? 'groups',
  },
  bootstrapAdminGroup: process.env.AUTH_BOOTSTRAP_ADMIN_GROUP, // seed first admin
}
```

When `AUTH_ENABLED` is false the app behaves exactly as today (fully open), so
this ships dark and is flipped on per environment.

## Database migration: server/src/db/migrations/002_auth.sql

All additive -- no changes to existing tables, safe for prod.

```sql
-- People who have logged in at least once.
CREATE TABLE users (
  id           SERIAL PRIMARY KEY,
  saml_subject TEXT NOT NULL UNIQUE,      -- Okta nameID
  email        TEXT,
  display_name TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login   TIMESTAMPTZ
);

-- Maps an AD/Okta group to a role, optionally scoped to one team.
--   role = 'admin'  -> team_id NULL, global
--   role = 'editor' -> team_id required, edits services in that team
--   role = 'viewer' -> implicit default for any authenticated user (not stored)
CREATE TABLE group_grants (
  ad_group  TEXT NOT NULL,
  role      TEXT NOT NULL CHECK (role IN ('admin', 'editor')),
  team_id   INT REFERENCES teams(id) ON DELETE CASCADE,
  CONSTRAINT editor_needs_team CHECK (role = 'admin' OR team_id IS NOT NULL),
  PRIMARY KEY (ad_group, role, team_id)
);
CREATE INDEX group_grants_group_idx ON group_grants (ad_group);

-- Optional but recommended: audit who changed what.
CREATE TABLE edit_audit (
  id         BIGSERIAL PRIMARY KEY,
  user_id    INT REFERENCES users(id),
  action     TEXT NOT NULL,     -- 'service.patch' | 'service.merge' | 'dep.add' | ...
  target     TEXT NOT NULL,     -- service id / team id
  detail     JSONB,
  at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

`migrate.ts` already picks up new sorted `*.sql` files automatically -- no runner
change needed.

## Effective grants (computed at login, baked into the JWT)

```
type Grants = {
  sub: string;            // saml subject / user id
  email?: string;
  name?: string;
  admin: boolean;         // any group mapped to role 'admin'
  editTeams: number[];    // team_ids from all 'editor' grants
};
```

At ACS time:
1. Validate assertion, extract nameID + `groups` (an array).
2. Upsert `users` (update last_login).
3. `SELECT role, team_id FROM group_grants WHERE ad_group = ANY($groups)`.
4. Also honor `AUTH_BOOTSTRAP_ADMIN_GROUP` so the very first admin exists before
   any rows are in `group_grants`.
5. Reduce to `Grants`, sign as JWT (exp = sessionTtlSec), set cookie.

Tradeoff (already accepted): grants are a snapshot. An AD change takes effect on
the user's next login / token expiry (default 8h). Logout clears the cookie.

## New file layout (server/src/auth/)

```
server/src/auth/
  config-check.ts   -- assert required env when AUTH_ENABLED
  saml.ts           -- node-saml instance; getAuthorizeUrl(), validatePostResponse()
  grants.ts         -- groups[] -> Grants (the group_grants lookup + reduce)
  jwt.ts            -- sign/verify session token, cookie name/options
  routes.ts         -- /api/auth/login, /saml/acs, /me, /logout
  middleware.ts     -- requireAuth preHandler; requireAdmin; canEditService()
  middleware.test.ts
  grants.test.ts
```

### Auth routes (server/src/auth/routes.ts)

- `GET  /api/auth/login`     -> 302 to Okta (SP-initiated)
- `POST /api/auth/saml/acs`  -> validate, mint JWT cookie, 302 to APP_BASE_URL
- `GET  /api/auth/me`        -> `{ user: Grants } | 401`  (SPA uses this to gate UI)
- `POST /api/auth/logout`    -> clear cookie, 204

### Middleware (server/src/auth/middleware.ts)

```
requireAuth(req, reply):     verify cookie JWT -> req.user, else 401
requireAdmin(req, reply):    requireAuth + req.user.admin, else 403

canEditService(user, svc):   user.admin
                          || (svc.team_id != null
                              && user.editTeams.includes(svc.team_id))
```

When `config.auth.enabled` is false, `requireAuth` is a no-op that injects a
synthetic superuser, preserving today's open behavior behind the flag.

## Endpoint enforcement matrix

Wire `requireAuth` globally in `apiRoutes` (one preHandler). Then per route:

| Method + path                                  | File              | Rule                                        |
|------------------------------------------------|-------------------|---------------------------------------------|
| GET  /topology, /services, /services/:id, etc. | (read routes)     | requireAuth only (read-all)                 |
| GET  /teams                                    | teams.ts          | requireAuth only                            |
| GET  /health                                   | routes.ts         | public (no auth) -- liveness probe          |
| POST /teams                                    | teams.ts          | requireAdmin                                |
| PATCH /services/:id (metadata)                 | serviceEdit.ts    | canEditService(user, svc)                   |
| PATCH /services/:id (changes team_id)          | serviceEdit.ts    | admin only (see escalation note)            |
| POST /services/:id/dependencies                | serviceEdit.ts    | canEditService on :id                       |
| DELETE /services/:id/dependencies/:targetId    | serviceEdit.ts    | canEditService on :id                       |
| POST /services/:id/merge                       | serviceMerge.ts   | canEditService on BOTH :id and sourceId     |
| /api/auth/*                                     | auth/routes.ts    | per route above                             |

Each write route loads the target service's `team_id` (already does an existence
`SELECT` in serviceEdit/serviceMerge -- extend it to also return `team_id`) and
calls `canEditService` before mutating. On failure return 403. Write to
`edit_audit` on success.

### Escalation note (important)

`PATCH /services/:id` currently accepts `teamId` / `teamName`, i.e. a service can
be RE-ASSIGNED to a different team, and `teamName` can CREATE a team. If a plain
editor could do that, they could pull any service into their own team and then
edit it, or mint teams. Rules:

- Changing `team_id` (reassignment) -> **admin only**.
- Creating a team via `teamName` -> **admin only** (same as POST /teams).
- A team editor may patch display_name / description / type / slo on services
  already in their team, nothing else.

(If you later want editors to reassign, relax to "editor on BOTH source and
destination team" -- but admin-only is the safe default. Flag for your call.)

Services with `team_id = NULL` (newly discovered, unassigned) are editable by
admins only until an admin assigns them an owner.

## Frontend changes (web)

1. `web/src/api/client.ts`
   - add `credentials: 'include'` to both `get` and `send`.
   - on 401, redirect: `window.location.href = '/api/auth/login'`.
   - add `me: () => get<Grants>('/auth/me')` and `logout`.

2. Session/grants context
   - new `web/src/auth/useAuth.ts` -> fetches `/api/auth/me` once, exposes
     `{ user, canEdit(teamId) }` where
     `canEdit = (t) => user.admin || user.editTeams.includes(t)`.

3. Gate edit UI (server still enforces; this is UX only)
   - `TeamFrame.tsx` MERGE button: render only when `canEdit(team.id)`.
   - `EditServiceModal.tsx`: open in read-only / hide save unless
     `canEdit(service.teamId)`; hide team reassignment unless `user.admin`.
   - dependency add/remove controls: gate on `canEdit(service.teamId)`.
   - team-create UI: admin only.

4. `TopBar.tsx`: show signed-in user + logout.

## CORS / cookies

Cookies + credentials cannot be used with `origin: true` (wildcard). In
`server/src/index.ts`:

```
await api.register(cors, { origin: config.auth.appBaseUrl, credentials: true });
await api.register(cookie);
await api.register(jwt, { secret: config.auth.jwtSecret, cookie: { cookieName: 'tm_session', signed: false } });
```

Cookie flags: `httpOnly`, `secure` (prod), `sameSite: 'lax'`, `path: '/'`.
In dev, the Vite proxy already serves API under same origin (`/api`), so SameSite
is a non-issue locally; lock origin in staging/prod.

## OTLP collector (do NOT regress)

`otlpRoutes` on port 4318 stays separate. If it needs protection, add a static
`OTLP_INGEST_TOKEN` bearer check in `otlp/routes.ts` -- independent of SAML.
Telemetry senders are services, not humans, and must never hit the SSO flow.

## Rollout (production safety)

1. Ship all of the above with `AUTH_ENABLED=false` -> zero behavior change.
2. Run migration `002_auth.sql` (additive, safe).
3. Configure the Okta SAML app; set SAML_* env + `AUTH_JWT_SECRET`.
4. Seed admins: set `AUTH_BOOTSTRAP_ADMIN_GROUP` to a known AD group, OR insert
   `group_grants` rows.
5. Populate `group_grants` (group -> team editor) for each team.
6. Flip `AUTH_ENABLED=true` in staging, verify, then prod.
7. Removing the bootstrap group later: once real admin rows exist, unset
   `AUTH_BOOTSTRAP_ADMIN_GROUP`.

## Okta-side checklist (for whoever administers Okta)

- Create a SAML 2.0 app integration.
- Single sign-on URL (ACS) = `https://<api-host>/api/auth/saml/acs`.
- Audience (SP entity id) = `SAML_ISSUER`.
- Add a Group Attribute Statement named `groups`, filtered (e.g. regex
  `^TRACEMAP-`) so only relevant AD groups are sent.
- Ensure AD groups are imported into Okta (Okta AD agent) and assigned to the app.
- Share the IdP signing cert (PEM) -> `SAML_IDP_CERT`.

## Tests to add

- `grants.test.ts`: groups[] + group_grants rows -> correct Grants (admin,
  editor teams, bootstrap group, empty/unknown groups -> viewer-only).
- `middleware.test.ts`: canEditService matrix (admin, editor-own-team,
  editor-other-team, null team, viewer).
- `saml.ts`: assertion validation happy path + rejected (bad signature,
  expired, wrong audience) using a fixture assertion.
- Route tests: each write endpoint returns 403 for an editor of the wrong team
  and 200 for the right team / admin; reassignment requires admin; merge needs
  both services' teams.
- Flag-off test: `AUTH_ENABLED=false` leaves all routes open (regression guard).

## Files touched (summary)

New:
- `server/src/db/migrations/002_auth.sql`
- `server/src/auth/{saml,grants,jwt,routes,middleware,config-check}.ts` + tests
- `web/src/auth/useAuth.ts`

Modified:
- `server/src/config.ts`            (auth config block)
- `server/src/index.ts`             (cookie/jwt plugins, locked CORS, register auth routes)
- `server/src/api/routes.ts`        (global requireAuth preHandler; /health stays public)
- `server/src/api/serviceEdit.ts`   (canEditService + admin-only reassignment + audit)
- `server/src/api/serviceMerge.ts`  (canEditService on both + audit)
- `server/src/api/teams.ts`         (POST -> requireAdmin)
- `web/src/api/client.ts`           (credentials, 401 redirect, me/logout)
- `web/src/features/map/TeamFrame.tsx`, `EditServiceModal.tsx`, `TopBar.tsx` (gate UI)
- `README.md`                       (auth setup + env vars)

## Open questions (still your call)

1. Reassignment: admin-only (default here) vs "editor on both teams"?
2. Should `/health` stay fully public, or just unauthenticated from the LAN?
3. Do you want the `edit_audit` table now, or defer it?
4. Token TTL: 8h default OK, or shorter for faster deprovisioning?
