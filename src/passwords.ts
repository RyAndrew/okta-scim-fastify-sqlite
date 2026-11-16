// ---------------------------------------------------------------------------
// Password storage: plaintext (demo and testing only) or a bcrypt hash.
// The stored value is never returned to a client or written to the audit log.
// ---------------------------------------------------------------------------

import { hash } from 'bcryptjs';
import { ScimErrors } from 'scim-fastify-core';
import type { SqliteConfig } from './config';

/** bcrypt reads only the first 72 bytes of its input. */
const BCRYPT_MAX_BYTES = 72;

export async function encodePassword(config: SqliteConfig, password: string): Promise<string> {
  if (config.passwordStorage === 'plaintext') return password;

  // A longer password would be truncated silently and the rest ignored
  if (Buffer.byteLength(password, 'utf8') > BCRYPT_MAX_BYTES) {
    throw ScimErrors.invalidValue(
      `Password is longer than ${BCRYPT_MAX_BYTES} bytes, the most bcrypt can store.`,
    );
  }
  return hash(password, config.bcryptCost!);
}
