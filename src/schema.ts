// ---------------------------------------------------------------------------
// The SQLite store: connection and tables.
//
// - Every SCIM user attribute has its own column; multi-valued attributes
//   (emails, phoneNumbers, addresses) have child tables. These columns are
//   the source of truth for reads.
// - users.profile_json holds the exact profile written in the same
//   transaction, for inspection and export. It is never read back.
// - userName, displayName and email comparisons are case-insensitive
//   (COLLATE NOCASE, ASCII only), as SCIM defines them (caseExact false).
// ---------------------------------------------------------------------------

import Knex, { Knex as KnexInstance } from 'knex';

export type Db = KnexInstance;

const NOCASE_TEXT = 'TEXT COLLATE NOCASE';

export function openDb(filename: string): Db {
  return Knex({
    client: 'better-sqlite3',
    connection: { filename },
    useNullAsDefault: true,
    pool: {
      // SQLite enforces foreign keys only when asked, per connection
      afterCreate: (
        conn: { pragma: (sql: string) => unknown },
        done: (err: Error | null, conn: unknown) => void,
      ) => {
        conn.pragma('foreign_keys = ON');
        done(null, conn);
      },
    },
  });
}

/** Create any missing table. Refuse a database written by the previous (1.x) bridge. */
export async function initSchema(db: Db): Promise<void> {
  // Note: db.schema is a getter that returns a new builder; never keep one and reuse it.

  if ((await db.schema.hasTable('users')) && (await db.schema.hasColumn('users', 'scim_resource'))) {
    throw new Error(
      'The SQLite database was created by the 1.x bridge (users.scim_resource). ' +
        'It is not migrated: point SQLITE_DB_PATH at a new file, or delete the old one.',
    );
  }

  if (!(await db.schema.hasTable('users'))) {
    await db.schema.createTable('users', (t) => {
      t.string('id').primary();
      t.specificType('user_name', `${NOCASE_TEXT} NOT NULL`).unique();
      t.text('external_id').nullable().index();
      t.text('display_name').nullable();
      t.text('nick_name').nullable();
      t.text('profile_url').nullable();
      t.text('title').nullable();
      t.text('user_type').nullable();
      t.text('preferred_language').nullable();
      t.text('locale').nullable();
      t.text('timezone').nullable();
      t.boolean('active').nullable();
      t.text('name_formatted').nullable();
      t.text('name_family_name').nullable();
      t.text('name_given_name').nullable();
      t.text('name_middle_name').nullable();
      t.text('name_honorific_prefix').nullable();
      t.text('name_honorific_suffix').nullable();
      t.text('ent_employee_number').nullable();
      t.text('ent_cost_center').nullable();
      t.text('ent_organization').nullable();
      t.text('ent_division').nullable();
      t.text('ent_department').nullable();
      t.text('password').nullable();
      t.text('profile_json').notNullable();
      t.string('created_at').notNullable().index();
      t.string('updated_at').notNullable();
    });
  }

  for (const table of ['user_emails', 'user_phone_numbers'] as const) {
    if (!(await db.schema.hasTable(table))) {
      await db.schema.createTable(table, (t) => {
        t.string('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
        t.integer('position').notNullable();
        t.specificType('value', `${NOCASE_TEXT} NOT NULL`).index();
        t.text('display').nullable();
        t.text('type').nullable();
        t.boolean('is_primary').nullable();
        t.primary(['user_id', 'position']);
      });
    }
  }

  if (!(await db.schema.hasTable('user_addresses'))) {
    await db.schema.createTable('user_addresses', (t) => {
      t.string('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
      t.integer('position').notNullable();
      t.text('formatted').nullable();
      t.text('street_address').nullable();
      t.text('locality').nullable();
      t.text('region').nullable();
      t.text('postal_code').nullable();
      t.text('country').nullable();
      t.text('type').nullable();
      t.boolean('is_primary').nullable();
      t.primary(['user_id', 'position']);
    });
  }

  if (!(await db.schema.hasTable('groups'))) {
    await db.schema.createTable('groups', (t) => {
      t.string('id').primary();
      t.specificType('display_name', `${NOCASE_TEXT} NOT NULL`).unique();
      t.text('external_id').nullable().index();
      t.string('created_at').notNullable().index();
      t.string('updated_at').notNullable();
    });
  }

  if (!(await db.schema.hasTable('group_members'))) {
    await db.schema.createTable('group_members', (t) => {
      t.string('group_id').notNullable().references('id').inTable('groups').onDelete('CASCADE');
      t.string('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
      t.primary(['group_id', 'user_id']);
      t.index(['user_id']);
    });
  }
}
