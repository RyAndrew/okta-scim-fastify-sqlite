// ---------------------------------------------------------------------------
// SQLite backend configuration. Every setting is required; there are no defaults.
// (Server, auth, TLS and audit settings belong to scim-fastify-core.)
// ---------------------------------------------------------------------------

import type { Env } from 'scim-fastify-core';

export type PasswordStorage = 'plaintext' | 'bcrypt';

export interface SqliteConfig {
  /** The user and group store. Separate from core's AUDIT_DB_PATH. */
  dbPath: string;
  passwordStorage: PasswordStorage;
  /** bcrypt cost factor. Only when `passwordStorage` is `bcrypt`. */
  bcryptCost: number | null;
}

export function loadSqliteConfig(env: Env): SqliteConfig {
  const passwordStorage = env.requireEnum(
    'SQLITE_PASSWORD_STORAGE',
    'How passwords sent by the SCIM client are stored: plaintext (demo and testing only) | bcrypt.',
    ['plaintext', 'bcrypt'] as const,
  );

  return {
    dbPath: env.require(
      'SQLITE_DB_PATH',
      'Path of the SQLite file holding users and groups. Created if missing. Use a different file from AUDIT_DB_PATH.',
    ),
    passwordStorage,
    bcryptCost:
      passwordStorage === 'bcrypt'
        ? env.requireInt(
            'SQLITE_BCRYPT_COST',
            'bcrypt cost factor (work = 2^cost), 10 to 15; 12 is a sensible choice. Required when SQLITE_PASSWORD_STORAGE=bcrypt.',
            10,
            15,
          )
        : null,
  };
}
