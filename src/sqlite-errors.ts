// ---------------------------------------------------------------------------
// SQLite error → SCIM error. Only recognised errors get a specific status;
// everything else is a 500 carrying the SQLite message.
// ---------------------------------------------------------------------------

import { ScimBackendError, ScimErrors } from 'scim-fastify-core';

const UNIQUE_MESSAGES: Record<string, string> = {
  'users.user_name': 'A user with this userName already exists.',
  'groups.display_name': 'A group with this displayName already exists.',
};

/**
 * Knex prefixes a driver error's message with the SQL statement and its bound
 * values ("insert into users ... values (..., '<password hash>', ...) - <message>").
 * Those values include password hashes and profile data, so strip the prefix
 * before the error reaches the audit row, the log or the client.
 * SQLite's own messages do not contain " - ".
 */
export function withoutSql(err: unknown): unknown {
  if (err instanceof ScimBackendError || !(err instanceof Error)) return err;
  const cut = err.message.lastIndexOf(' - ');
  if (cut !== -1) err.message = err.message.slice(cut + 3);
  return err;
}

export function toScimError(err: unknown): ScimBackendError {
  if (err instanceof ScimBackendError) return err;

  const code = (err as { code?: unknown }).code;
  const message = err instanceof Error ? err.message : String(err);

  if (code === 'SQLITE_CONSTRAINT_UNIQUE' || code === 'SQLITE_CONSTRAINT_PRIMARYKEY') {
    const column = /constraint failed: (\S+)/.exec(message)?.[1];
    const detail = column !== undefined ? UNIQUE_MESSAGES[column] : undefined;
    if (detail) return ScimErrors.uniqueness(detail);
  }
  if (code === 'SQLITE_CONSTRAINT_FOREIGNKEY') {
    return ScimErrors.invalidValue('A referenced user does not exist.');
  }
  return ScimErrors.backend(`SQLite error: ${message}`);
}
