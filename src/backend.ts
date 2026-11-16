// ---------------------------------------------------------------------------
// SQLite backend for scim-fastify-core: users, and groups (groups.ts).
//
// SQLite is the store itself: every read goes to the database, nothing is
// cached. Ids are generated UUIDs. Every database operation is reported
// through context.audit; passwords never appear in audit params.
// ---------------------------------------------------------------------------

import { randomUUID } from 'crypto';
import {
  BackendAudit,
  BackendContext,
  BackendModule,
  BackendOperation,
  ScimErrors,
  ScimUserBackend,
  StoredUser,
  UserAttributes,
  UserLookup,
  UserPage,
  UserQuery,
  UserUpdate,
} from 'scim-fastify-core';
import { SqliteConfig, loadSqliteConfig } from './config';
import { SqliteGroupBackend } from './groups';
import {
  AddressRow,
  CHILD_TABLES,
  ChildRows,
  MultiValueRow,
  USER_ATTRIBUTES,
  UserRow,
  rowToStoredUser,
  userToChildRows,
  userToColumns,
} from './mapping';
import { encodePassword } from './passwords';
import { Db, openDb, initSchema } from './schema';
import { toScimError, withoutSql } from './sqlite-errors';

/** Columns read for a user: everything except the password and the JSON copy. */
const USER_SELECT = [
  'id',
  'user_name',
  'external_id',
  'display_name',
  'nick_name',
  'profile_url',
  'title',
  'user_type',
  'preferred_language',
  'locale',
  'timezone',
  'active',
  'name_formatted',
  'name_family_name',
  'name_given_name',
  'name_middle_name',
  'name_honorific_prefix',
  'name_honorific_suffix',
  'ent_employee_number',
  'ent_cost_center',
  'ent_organization',
  'ent_division',
  'ent_department',
  'created_at',
  'updated_at',
].map((c) => `users.${c}`);

/**
 * Runs `fn` audited, and turns SQLite errors into SCIM errors after recording them.
 * Database errors are cleaned *before* the audit records them (see `withoutSql`).
 */
export function audited(audit: BackendAudit) {
  return async <T>(operation: BackendOperation, fn: () => Promise<T>): Promise<T> => {
    try {
      return await audit.run(operation, () =>
        fn().catch((err: unknown) => {
          throw withoutSql(err);
        }),
      );
    } catch (err) {
      throw toScimError(err);
    }
  };
}

const now = (): string => new Date().toISOString();

// ---------------------------------------------------------------------------

export class SqliteBackend implements ScimUserBackend {
  readonly attributes = USER_ATTRIBUTES;
  readonly lookups = ['id', 'userName', 'externalId', 'email'] as const;
  readonly groups: SqliteGroupBackend;

  private readonly db: Db;
  private readonly run: ReturnType<typeof audited>;

  constructor(
    private readonly config: SqliteConfig,
    private readonly context: BackendContext,
  ) {
    this.db = openDb(config.dbPath);
    this.run = audited(context.audit);
    this.groups = new SqliteGroupBackend(this.db, this.run);
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  async init(): Promise<void> {
    await initSchema(this.db);
    await this.db.raw('SELECT 1');
    if (this.config.passwordStorage === 'plaintext') {
      this.context.log.warn(
        'SQLITE_PASSWORD_STORAGE=plaintext: passwords are stored unhashed. Use this for demos and testing only.',
      );
    }
  }

  async close(): Promise<void> {
    await this.db.destroy();
  }

  // ── Read ─────────────────────────────────────────────────────────────────

  async getUser(id: string): Promise<StoredUser | null> {
    return this.run({ operation: 'select', target: `users/${id}` }, async () => {
      const row = await this.db('users').select(USER_SELECT).where('users.id', id).first<UserRow>();
      if (!row) return null;
      return rowToStoredUser(row, await this.readChildren([id]).then((c) => c.get(id)!));
    });
  }

  async listUsers(query: UserQuery): Promise<UserPage> {
    const { lookup, startIndex, count } = query;
    return this.run(
      { operation: 'select', target: 'users', params: { lookup, startIndex, count } },
      async () => {
        const base = () => this.applyLookup(this.db('users'), lookup);

        const [{ total }] = await base().count<{ total: number }[]>({ total: '*' });
        if (count === 0) return { users: [], totalResults: Number(total) };

        // The order core requires: newest first, ties by id
        const rows = await base()
          .select(USER_SELECT)
          .orderBy([
            { column: 'users.created_at', order: 'desc' },
            { column: 'users.id', order: 'asc' },
          ])
          .limit(count)
          .offset(startIndex - 1);

        const children = await this.readChildren(rows.map((r: UserRow) => r.id));
        return {
          users: rows.map((r: UserRow) => rowToStoredUser(r, children.get(r.id)!)),
          totalResults: Number(total),
        };
      },
    );
  }

  // ── Write ────────────────────────────────────────────────────────────────

  async createUser(user: UserAttributes, password: string | undefined): Promise<string> {
    const id = randomUUID();
    const columns = userToColumns(user);
    const children = userToChildRows(id, user);
    const encoded = password !== undefined ? await encodePassword(this.config, password) : null;
    const ts = now();

    await this.run(
      {
        operation: 'insert',
        target: `users/${id}`,
        params: { columns, children, passwordSet: encoded !== null },
      },
      () =>
        this.db.transaction(async (trx) => {
          await trx('users').insert({ id, ...columns, password: encoded, created_at: ts, updated_at: ts });
          await writeChildren(trx, children);
        }),
    );
    return id;
  }

  async updateUser(id: string, { user }: UserUpdate): Promise<void> {
    // SQL can write the whole row atomically, so every column is rewritten
    // and absent attributes become NULL (RFC 7644 §3.5.1)
    const columns = userToColumns(user);
    const children = userToChildRows(id, user);

    await this.run(
      { operation: 'update', target: `users/${id}`, params: { columns, children } },
      () =>
        this.db.transaction(async (trx) => {
          const changed = await trx('users').where({ id }).update({ ...columns, updated_at: now() });
          if (changed === 0) throw ScimErrors.notFound(id);
          for (const table of CHILD_TABLES) await trx(table).where({ user_id: id }).delete();
          await writeChildren(trx, children);
        }),
    );
  }

  async setPassword(id: string, password: string): Promise<void> {
    const encoded = await encodePassword(this.config, password);
    await this.run(
      { operation: 'update', target: `users/${id}`, params: { passwordSet: true } },
      async () => {
        const changed = await this.db('users').where({ id }).update({ password: encoded, updated_at: now() });
        if (changed === 0) throw ScimErrors.notFound(id);
      },
    );
  }

  async deleteUser(id: string): Promise<void> {
    // Child rows and group memberships go by ON DELETE CASCADE
    await this.run({ operation: 'delete', target: `users/${id}` }, async () => {
      const deleted = await this.db('users').where({ id }).delete();
      if (deleted === 0) throw ScimErrors.notFound(id);
    });
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private applyLookup(builder: ReturnType<Db>, lookup: UserLookup | undefined) {
    if (!lookup) return builder;
    switch (lookup.by) {
      case 'id':
        return builder.where('users.id', lookup.value);
      case 'userName':
        return builder.where('users.user_name', lookup.value); // NOCASE column
      case 'externalId':
        return builder.where('users.external_id', lookup.value);
      case 'email':
        // Any of the user's emails; NOCASE column
        return builder.whereExists(
          this.db('user_emails')
            .select(this.db.raw('1'))
            .whereRaw('user_emails.user_id = users.id')
            .andWhere('user_emails.value', lookup.value),
        );
    }
  }

  private async readChildren(ids: string[]): Promise<Map<string, ChildRows>> {
    const out = new Map<string, ChildRows>(
      ids.map((id) => [id, { user_emails: [], user_phone_numbers: [], user_addresses: [] }]),
    );
    if (ids.length === 0) return out;

    const [emails, phones, addresses] = await Promise.all([
      this.db<MultiValueRow>('user_emails').whereIn('user_id', ids),
      this.db<MultiValueRow>('user_phone_numbers').whereIn('user_id', ids),
      this.db<AddressRow>('user_addresses').whereIn('user_id', ids),
    ]);
    for (const r of emails) out.get(r.user_id)!.user_emails.push(r);
    for (const r of phones) out.get(r.user_id)!.user_phone_numbers.push(r);
    for (const r of addresses) out.get(r.user_id)!.user_addresses.push(r);
    return out;
  }
}

async function writeChildren(trx: Db, children: ChildRows): Promise<void> {
  for (const table of CHILD_TABLES) {
    const rows = children[table];
    if (rows.length > 0) await trx(table).insert(rows);
  }
}

// ---------------------------------------------------------------------------

export const sqliteModule: BackendModule<SqliteConfig> = {
  name: 'sqlite',
  loadConfig: loadSqliteConfig,
  create: (config, context) => new SqliteBackend(config, context),
};
