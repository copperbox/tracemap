# SAML sign-in and team-scoped editing: design

Status: proposed. None of this is built, and TraceMap has no authentication
today. See [security](../README.md#security).

Written 2026-06-12, revised 2026-11-18.

## Goal

Add sign-in through a SAML 2.0 identity provider. Okta is the provider this
design must work with, and the one it will be tested against. Only the
[Okta setup](#okta-setup) section is specific to Okta. Another SAML 2.0 provider
that sends a group attribute should work, but supporting others is not a goal.

Signed-in users can view the whole map. They can edit only the services owned by
a team they hold an editor grant for. The groups the identity provider sends in
the SAML assertion decide what each user can edit.

## Decisions

1. Reads are open to any signed-in user. Only writes are scoped to a team.
2. Access comes from an explicit table that maps a group to a role, managed by
   admins. TraceMap does not parse group names.
3. The session is a stateless JWT in an httpOnly cookie. There is no session
   table and no cache.
4. SAML authenticates the browser sign-in. TraceMap's own database authorizes
   each request.

## Why SAML authenticates but does not authorize

A SAML assertion is a one-time proof of identity and group membership that the
browser delivers. It is not a credential for each request. The flow:

```
  Browser
    | (1) GET /api/auth/login              SP-initiated
    v
  API  --(2) 302 with AuthnRequest-->  identity provider (Okta)
                                            |
    <--(3) user signs in, the provider -----+
           POSTs the assertion to /api/auth/saml/acs
    |
    | (4) API validates the assertion, reads the groups attribute,
    |     maps groups to grants, signs a session JWT,
    |     Set-Cookie (httpOnly, Secure, SameSite=Lax), 302 to the app
    v
  SPA --(5) every /api/* call carries the cookie. The API verifies the JWT
            and attaches req.user = { sub, email, admin, editTeams[] }
```

The OTLP collector on port 4318 is not part of this. It takes telemetry from
machines and needs its own protection: a bearer token, mTLS or network
isolation. Only the query API on port 4000 gets SAML.

## Dependencies to add to the server

- `@node-saml/node-saml` builds the AuthnRequest and validates the posted
  assertion.
- `@fastify/cookie` reads and sets the session cookie.
- `@fastify/jwt` signs and verifies the session JWT, reading it from the cookie.

All three are libraries. The design adds no infrastructure.

## Configuration

Extend `server/src/config.ts`:

```
auth: {
  enabled:        process.env.AUTH_ENABLED === 'true',     // rollout flag
  jwtSecret:      process.env.AUTH_JWT_SECRET,              // required when enabled
  sessionTtlSec:  Number(process.env.AUTH_SESSION_TTL_SEC ?? 8 * 3600),
  appBaseUrl:     process.env.APP_BASE_URL,                 // SPA origin, for redirects and CORS
  saml: {
    entryPoint:   process.env.SAML_ENTRY_POINT,   // the provider's single sign-on URL
    issuer:       process.env.SAML_ISSUER,        // SP entity id (this app)
    callbackUrl:  process.env.SAML_CALLBACK_URL,  // .../api/auth/saml/acs
    idpCert:      process.env.SAML_IDP_CERT,      // the provider's signing certificate (PEM)
    groupsAttr:   process.env.SAML_GROUPS_ATTR ?? 'groups',
  },
  bootstrapAdminGroup: process.env.AUTH_BOOTSTRAP_ADMIN_GROUP, // seeds the first admin
}
```

When `AUTH_ENABLED` is false the app behaves as it does today, fully open. The
code can ship switched off and be turned on per deployment.

## Database migration

`server/src/db/migrations/004_auth.sql`. Every statement adds a table and none
changes an existing one. `migrate.ts` applies new `*.sql` files in sorted order,
so the runner needs no change.

```sql
-- People who have signed in at least once.
CREATE TABLE users (
  id           SERIAL PRIMARY KEY,
  saml_subject TEXT NOT NULL UNIQUE,      -- the assertion's NameID
  email        TEXT,
  display_name TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login   TIMESTAMPTZ
);

-- Maps an identity provider group to a role, optionally scoped to one team.
--   role = 'admin'  -> team_id NULL, global
--   role = 'editor' -> team_id required, edits services in that team
-- Every signed-in user is a viewer. That role is not stored.
CREATE TABLE group_grants (
  id         SERIAL PRIMARY KEY,
  idp_group  TEXT NOT NULL,
  role       TEXT NOT NULL CHECK (role IN ('admin', 'editor')),
  team_id    INT REFERENCES teams(id) ON DELETE CASCADE,
  CONSTRAINT editor_needs_team CHECK (role = 'admin' OR team_id IS NOT NULL),
  UNIQUE NULLS NOT DISTINCT (idp_group, role, team_id)
);
CREATE INDEX group_grants_group_idx ON group_grants (idp_group);

-- Who changed what.
CREATE TABLE edit_audit (
  id         BIGSERIAL PRIMARY KEY,
  user_id    INT REFERENCES users(id),
  action     TEXT NOT NULL,     -- 'service.patch' | 'service.merge' | 'dep.add' | ...
  target     TEXT NOT NULL,     -- service id or team id
  detail     JSONB,
  at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

## Effective grants

The server computes a user's grants at sign-in and puts them in the JWT:

```
type Grants = {
  sub: string;            // SAML subject
  email?: string;
  name?: string;
  admin: boolean;         // any group mapped to role 'admin'
  editTeams: number[];    // team ids from every 'editor' grant
};
```

At the assertion consumer service (ACS):

1. Validate the assertion: signature, audience, expiry and `InResponseTo`. Read
   the NameID and the groups attribute, which is a list.
2. Upsert the `users` row and set `last_login`.
3. `SELECT role, team_id FROM group_grants WHERE idp_group = ANY($groups)`.
4. Treat `AUTH_BOOTSTRAP_ADMIN_GROUP` as an admin grant, so the first admin
   exists before `group_grants` has any rows.
5. Reduce the rows to `Grants`, sign the JWT with `exp` set from
   `sessionTtlSec`, and set the cookie.

Grants are a snapshot. A group change at the identity provider takes effect at
the user's next sign-in or when the token expires, 8 hours by default. Signing
out clears the cookie.

## New files in `server/src/auth/`

```
server/src/auth/
  config-check.ts   assert the required env when AUTH_ENABLED
  saml.ts           node-saml instance: getAuthorizeUrl(), validatePostResponse()
  grants.ts         groups[] -> Grants (the group_grants lookup and reduce)
  jwt.ts            sign and verify the session token, cookie name and options
  routes.ts         /api/auth/login, /saml/acs, /me, /logout
  middleware.ts     requireAuth preHandler, requireAdmin, canEditService()
  middleware.test.ts
  grants.test.ts
```

### Auth routes

- `GET  /api/auth/login` redirects to the identity provider (SP-initiated).
- `POST /api/auth/saml/acs` validates the assertion, sets the JWT cookie and
  redirects to `APP_BASE_URL`.
- `GET  /api/auth/me` returns `{ user: Grants }` or 401. The SPA uses it to
  decide which controls to show.
- `POST /api/auth/logout` clears the cookie and returns 204.

### Middleware

```
requireAuth(req, reply):     verify the cookie JWT -> req.user, else 401
requireAdmin(req, reply):    requireAuth and req.user.admin, else 403

canEditService(user, svc):   user.admin
                          || (svc.team_id != null
                              && user.editTeams.includes(svc.team_id))
```

When `config.auth.enabled` is false, `requireAuth` does no check and attaches a
synthetic admin user, which keeps today's open behavior.

## Endpoint enforcement

Register `requireAuth` once as a preHandler for the API routes. Then per route:

| Method and path | File | Rule |
| --- | --- | --- |
| `GET /health` | `api/routes.ts` | Public. It is the liveness probe. |
| `GET /topology`, `/services...`, `/edges...`, `/traces/:traceId`, `/teams` | read routes | `requireAuth` |
| `GET /live`, `/live/structure`, `/live/metrics` | `live/routes.ts` | `requireAuth` |
| `POST /teams` | `api/teams.ts` | `requireAdmin` |
| `PATCH /services/:id`, metadata | `api/serviceEdit.ts` | `canEditService(user, svc)` |
| `PATCH /services/:id`, changing the team | `api/serviceEdit.ts` | Admin only. See below. |
| `POST /services/:id/dependencies` | `api/serviceEdit.ts` | `canEditService` on `:id` |
| `DELETE /services/:id/dependencies/:targetId` | `api/serviceEdit.ts` | `canEditService` on `:id` |
| `POST /services/:id/merge` | `api/serviceMerge.ts` | `canEditService` on both `:id` and the source service |
| `POST /services/:id/unmerge` | `api/serviceMerge.ts` | `canEditService` on `:id` |
| `/auth/*` | `auth/routes.ts` | As listed under auth routes |

Each write route already selects the target service to check that it exists.
Extend that query to return `team_id`, call `canEditService` before changing
anything, and return 403 on failure. Write an `edit_audit` row on success.

### Reassignment

`PATCH /services/:id` accepts `teamId` and `teamName`. A service can therefore
move to another team, and `teamName` can create a team. An editor who could do
either could pull any service into their own team and then edit it. The rules:

- Changing `team_id` is admin only.
- Creating a team through `teamName` is admin only, the same as `POST /teams`.
- A team editor may change the display name, description, type and SLO target of
  services already in their team, and nothing else.

Services with no team, which includes every inferred dependency, are editable by
admins only until an admin assigns them an owner.

### Teams assigned from telemetry

The collector keeps assigning a service to the team named in its `team.name`
resource attribute when the service has no team. That happens at ingest, with no
user, and this design does not change it. Anyone who can write telemetry can
therefore place a new service in an existing team, which is one more reason to
protect the collector.

## Web changes

1. `web/src/api/client.ts`
   - On a 401, redirect with `window.location.href = '/api/auth/login'`.
   - Add `me: () => get<Grants>('/auth/me')` and `logout`.
   - The web app calls `/api` on its own origin, through nginx or the Vite proxy,
     so the browser sends the cookie on `fetch` and on the `EventSource` stream
     with no other change.

2. A new `web/src/auth/useAuth.ts` fetches `/api/auth/me` once and exposes
   `{ user, canEdit(teamId) }`, where
   `canEdit = (t) => user.admin || user.editTeams.includes(t)`.

3. Hide the edit controls a user cannot use. The server still enforces every
   rule, so this only keeps the UI honest.
   - `web/src/features/service/EditServiceModal.tsx`: read-only unless
     `canEdit(service.teamId)`. Team reassignment, merge and unmerge follow the
     rules above.
   - Dependency add and remove controls: `canEdit(service.teamId)`.
   - Creating a team: admins only.

   Merging a team into one node on the map is a view setting in the browser, not
   an edit, and stays available to everyone.

4. `web/src/components/TopBar.tsx` shows the signed-in user and a sign-out
   action.

## CORS and cookies

The API registers CORS with `origin: true` today, which accepts any origin. With
cookies, that would let any site call the API as the signed-in user, so allow
only the app's origin. In `server/src/index.ts`:

```
await api.register(cors, { origin: config.auth.appBaseUrl, credentials: true });
await api.register(cookie);
await api.register(jwt, { secret: config.auth.jwtSecret, cookie: { cookieName: 'tm_session', signed: false } });
```

Cookie flags: `httpOnly`, `secure` outside local development, `sameSite: 'lax'`
and `path: '/'`.

## OTLP collector

`otlpRoutes` on port 4318 stays separate. If it needs protection, add a static
`OTLP_INGEST_TOKEN` bearer check in `otlp/routes.ts`, independent of SAML.
Telemetry senders are services and must never be sent through the sign-in flow.

## Rollout

1. Deploy the code with `AUTH_ENABLED=false`. Nothing changes.
2. Run the migration.
3. Create the SAML app at the identity provider, then set the `SAML_*`
   variables and `AUTH_JWT_SECRET`.
4. Seed the admins: set `AUTH_BOOTSTRAP_ADMIN_GROUP` to a group the first admins
   are in, or insert `group_grants` rows.
5. Add a `group_grants` row for each group that edits a team.
6. Set `AUTH_ENABLED=true` on a test deployment, check it, then turn it on where
   it matters.
7. Unset `AUTH_BOOTSTRAP_ADMIN_GROUP` once real admin rows exist.

## Okta setup

1. Create a SAML 2.0 app integration.
2. Set the single sign-on URL to `https://<api-host>/api/auth/saml/acs`.
3. Set the audience URI (SP entity ID) to the value of `SAML_ISSUER`.
4. Choose a Name ID format and application username that do not change for a
   user. `users.saml_subject` is keyed on the NameID.
5. Add a group attribute statement named `groups`, or the name in
   `SAML_GROUPS_ATTR`. Give it a filter, such as a name prefix, so Okta sends
   only the groups TraceMap uses.
6. Assign the users or groups who should have access to the app.
7. Copy the app's sign-on URL into `SAML_ENTRY_POINT` and its signing
   certificate, as PEM, into `SAML_IDP_CERT`.

## Tests to add

- `grants.test.ts`: groups plus `group_grants` rows give the right `Grants`.
  Cover admin, editor teams, the bootstrap group, and empty or unknown groups,
  which leave a viewer.
- `middleware.test.ts`: the `canEditService` matrix. Admin, editor of the
  service's team, editor of another team, no team, viewer.
- `saml.ts`: a fixture assertion that validates, and ones rejected for a bad
  signature, expiry and the wrong audience.
- Route tests: each write endpoint returns 403 for an editor of the wrong team
  and 200 for the right team or an admin. Reassignment needs an admin. Merge
  needs both services' teams.
- Flag off: `AUTH_ENABLED=false` leaves every route open.

## Files touched

New:

- `server/src/db/migrations/004_auth.sql`
- `server/src/auth/{saml,grants,jwt,routes,middleware,config-check}.ts` and
  tests
- `web/src/auth/useAuth.ts`

Changed:

- `server/src/config.ts`: the auth block
- `server/src/index.ts`: cookie and JWT plugins, locked CORS, auth routes
- `server/src/api/routes.ts`: the `requireAuth` preHandler, with `/health` left
  public
- `server/src/live/routes.ts`: `requireAuth`
- `server/src/api/serviceEdit.ts`: `canEditService`, admin-only reassignment,
  audit
- `server/src/api/serviceMerge.ts`: `canEditService` on both services, audit
- `server/src/api/teams.ts`: `requireAdmin` on `POST`
- `web/src/api/client.ts`: 401 redirect, `me`, `logout`
- `web/src/features/service/EditServiceModal.tsx` and
  `web/src/components/TopBar.tsx`: gated controls, signed-in user
- `README.md` and `docs/configuration.md`: setup and variables

## Open questions

1. Reassignment: admin only, as written here, or allow an editor of both teams?
2. Should `/health` stay public, or answer only on the local network?
3. Build the `edit_audit` table with the first version, or later?
4. Session lifetime: 8 hours, or shorter so removing a user takes effect sooner?
