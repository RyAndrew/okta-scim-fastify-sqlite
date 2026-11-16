# CLAUDE.md

SCIM 2.0 → SQLite bridge. Okta (or any SCIM client) provisions users and groups over HTTPS; this repo is a thin backend module for `scim-fastify-core` 2.0 that stores them in a local SQLite file. Useful for demos, testing and simple deployments.

## Commands

```sh
npm run dev     # tsx watch src/index.ts
npm run build   # tsc → dist/
npm start       # node dist/index.js
```

No tests or linter here. Type-check with `npx tsc --noEmit`. Core has tests (`npm test` in `../okta-scim-fastify-core`).

`better-sqlite3` is a native module. npm here blocks install scripts unless allowed; it is approved in `package.json` (`allowScripts`). After a Node upgrade run `npm rebuild better-sqlite3`.

## Runtime requirements

- `.env` (see [.env.example](.env.example)), loaded by core. **Every variable is required; there are no defaults.** Startup fails once with the full list of missing/invalid ones.
  - Core: `HOST`, `PORT`, `LOG_LEVEL`, `API_KEY`, `SSL_CERT_PATH`, `SSL_KEY_PATH`, `AUDIT_DB_PATH`, `SCIM_UNSUPPORTED_ATTRIBUTES` (`reject`|`ignore`), `SCIM_DEFAULT_COUNT`, `SCIM_MAX_COUNT`.
  - Backend: `SQLITE_DB_PATH` (the store; keep it separate from `AUDIT_DB_PATH`), `SQLITE_PASSWORD_STORAGE` (`plaintext`|`bcrypt`), `SQLITE_BCRYPT_COST` (10–15, required only with `bcrypt`).
- `init()` creates missing tables and refuses a database written by the 1.x bridge (`users.scim_resource`); there is no migration.

## Core dependency

`scim-fastify-core` is a local `file:../okta-scim-fastify-core` dependency, consumed from its `dist/`; **rebuild core (`npm run build` there) after changing it**. Core owns the HTTPS server, auth, routes (`/Users`, and `/Groups` because this backend provides `groups`), discovery, validation, filter parsing, PATCH application (for groups: turned into a membership delta), password separation, read-after-write and audit storage. The contract is `../okta-scim-fastify-core/docs/backend-contract.md`.

## Architecture

```
index.ts         startScimServer(sqliteModule)   (core)
backend.ts       SqliteBackend implements ScimUserBackend (+ .groups); exports the module; audited() wrapper
groups.ts        SqliteGroupBackend implements ScimGroupBackend
schema.ts        Knex connection (foreign_keys ON) and table creation
mapping.ts       SCIM user ⇄ columns and child rows (single source of truth)
passwords.ts     plaintext | bcrypt
sqlite-errors.ts SQLite error → ScimBackendError; strips Knex's SQL+bindings prefix
```

Tables: `users` (one column per attribute, `password`, `profile_json`), `user_emails`, `user_phone_numbers`, `user_addresses` (ordered by `position`), `groups`, `group_members`. Child rows and memberships are removed by `ON DELETE CASCADE`.

## Key design rules

- **Bridge, not a decision layer.** Write what was sent, clear it, or fail with a clear error. No defaults: an absent `active` stays absent.
- **Columns are the source of truth.** Every attribute core knows is declared and stored in its own column / child table. `profile_json` is the profile written in the same transaction, for inspection; it is never read back.
- **Ids** are generated UUIDs (never `externalId`).
- **Lookups:** users by `id`, `userName`, `externalId`, `email` (any of the user's emails); groups by `id`, `displayName`, `externalId`. `userName`, `displayName` and email values are `COLLATE NOCASE` (ASCII case-insensitive), unique for `userName` and `displayName`. `externalId` is exact.
- **Lists** page natively: `ORDER BY created_at DESC, id ASC LIMIT/OFFSET`.
- **Updates:** a user update rewrites every column and child row in one transaction; absent → NULL. Group membership arrives as `{ replace }` or `{ add, remove }` and is applied in one transaction; member ids that are not users → 400 naming them.
- **Passwords:** stored only when sent; `bcrypt` rejects passwords over 72 bytes (400) instead of truncating. The stored value is never selected for reads, returned, or put in audit params (`passwordSet: true` only).
- **Audit:** every database operation goes through `context.audit.run` via `audited()`. Knex puts the SQL **and bound values** (password hashes, profile data) in error messages; `withoutSql()` strips them before the audit row, the log or the client sees the error. Keep that order.
- **Errors:** UNIQUE on `users.user_name` / `groups.display_name` → 409; FOREIGN KEY → 400; anything else → 500 with the SQLite message.
- **Knex gotcha:** `db.schema` is a getter that returns a new builder. Never keep one and reuse it (a reused builder silently skips table creation).
