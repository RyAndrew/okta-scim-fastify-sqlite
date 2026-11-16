// ---------------------------------------------------------------------------
// SCIM user ⇄ SQLite rows. The single source of truth for the mapping.
//
// - Every attribute core knows is stored, each in its own column; emails,
//   phoneNumbers and addresses go to child tables, one row per entry, in order.
// - Written exactly as sent: an absent attribute is NULL / has no child rows.
//   Nothing is defaulted (an absent `active` stays absent).
// - Read back from the columns; NULL means the attribute is absent.
// ---------------------------------------------------------------------------

import {
  KNOWN_USER_ATTRIBUTE_PATHS,
  SCIM_SCHEMA_ENTERPRISE_USER,
  ScimAddress,
  ScimErrors,
  ScimMultiValue,
  StoredUser,
  UserAttributePath,
  UserAttributes,
} from 'scim-fastify-core';

const ENT = SCIM_SCHEMA_ENTERPRISE_USER;

/** Single-valued attribute path → users column. */
const COLUMNS: ReadonlyArray<readonly [UserAttributePath, string]> = [
  ['userName', 'user_name'],
  ['externalId', 'external_id'],
  ['displayName', 'display_name'],
  ['nickName', 'nick_name'],
  ['profileUrl', 'profile_url'],
  ['title', 'title'],
  ['userType', 'user_type'],
  ['preferredLanguage', 'preferred_language'],
  ['locale', 'locale'],
  ['timezone', 'timezone'],
  ['active', 'active'],
  ['name.formatted', 'name_formatted'],
  ['name.familyName', 'name_family_name'],
  ['name.givenName', 'name_given_name'],
  ['name.middleName', 'name_middle_name'],
  ['name.honorificPrefix', 'name_honorific_prefix'],
  ['name.honorificSuffix', 'name_honorific_suffix'],
  [`${ENT}:employeeNumber`, 'ent_employee_number'],
  [`${ENT}:costCenter`, 'ent_cost_center'],
  [`${ENT}:organization`, 'ent_organization'],
  [`${ENT}:division`, 'ent_division'],
  [`${ENT}:department`, 'ent_department'],
];

const MULTI_VALUED = ['emails', 'phoneNumbers', 'addresses'] as const;

/** Every path core can validate; this backend stores them all. */
export const USER_ATTRIBUTES = [...KNOWN_USER_ATTRIBUTE_PATHS] as UserAttributePath[];

// Fail at load time if core gains an attribute this mapping does not store
{
  const mapped = new Set<string>([...COLUMNS.map(([path]) => path), ...MULTI_VALUED]);
  const missing = USER_ATTRIBUTES.filter((p) => !mapped.has(p));
  if (missing.length > 0) {
    throw new Error(`mapping.ts does not map these core attributes: ${missing.join(', ')}`);
  }
}

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

export type UserRow = Record<string, string | number | null> & {
  id: string;
  created_at: string;
  updated_at: string;
};

export interface MultiValueRow {
  user_id: string;
  position: number;
  value: string;
  display: string | null;
  type: string | null;
  is_primary: number | null;
}

export interface AddressRow {
  user_id: string;
  position: number;
  formatted: string | null;
  street_address: string | null;
  locality: string | null;
  region: string | null;
  postal_code: string | null;
  country: string | null;
  type: string | null;
  is_primary: number | null;
}

export interface ChildRows {
  user_emails: MultiValueRow[];
  user_phone_numbers: MultiValueRow[];
  user_addresses: AddressRow[];
}

export const CHILD_TABLES = ['user_emails', 'user_phone_numbers', 'user_addresses'] as const;

const ADDRESS_COLUMNS: ReadonlyArray<readonly [keyof ScimAddress, keyof AddressRow]> = [
  ['formatted', 'formatted'],
  ['streetAddress', 'street_address'],
  ['locality', 'locality'],
  ['region', 'region'],
  ['postalCode', 'postal_code'],
  ['country', 'country'],
];

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

type Loose = Record<string, unknown>;

function split(path: string): [parent: string | null, key: string] {
  if (path.startsWith(`${ENT}:`)) return [ENT, path.slice(ENT.length + 1)];
  const dot = path.indexOf('.');
  return dot === -1 ? [null, path] : [path.slice(0, dot), path.slice(dot + 1)];
}

function getPath(user: UserAttributes, path: string): unknown {
  const [parent, key] = split(path);
  const source = user as unknown as Loose;
  return parent === null ? source[key] : (source[parent] as Loose | undefined)?.[key];
}

function setPath(user: Loose, path: string, value: unknown): void {
  const [parent, key] = split(path);
  if (parent === null) user[key] = value;
  else ((user[parent] ??= {}) as Loose)[key] = value;
}

const toBit = (value: boolean | undefined): number | null =>
  value === undefined ? null : value ? 1 : 0;

// ---------------------------------------------------------------------------
// SCIM → rows
// ---------------------------------------------------------------------------

/** Every mapped users column, NULL where the attribute is absent. */
export function userToColumns(user: UserAttributes): Record<string, string | number | null> {
  const columns: Record<string, string | number | null> = {};
  for (const [path, column] of COLUMNS) {
    const value = getPath(user, path);
    columns[column] =
      value === undefined ? null : typeof value === 'boolean' ? toBit(value) : (value as string);
  }
  columns.profile_json = JSON.stringify(user);
  return columns;
}

export function userToChildRows(userId: string, user: UserAttributes): ChildRows {
  const multi = (entries: ScimMultiValue[] | undefined): MultiValueRow[] =>
    (entries ?? []).map((e, position) => ({
      user_id: userId,
      position,
      value: e.value,
      display: e.display ?? null,
      type: e.type ?? null,
      is_primary: toBit(e.primary),
    }));

  return {
    user_emails: multi(user.emails),
    user_phone_numbers: multi(user.phoneNumbers),
    user_addresses: (user.addresses ?? []).map((a, position) => {
      const row: AddressRow = {
        user_id: userId,
        position,
        formatted: null,
        street_address: null,
        locality: null,
        region: null,
        postal_code: null,
        country: null,
        type: a.type ?? null,
        is_primary: toBit(a.primary),
      };
      for (const [attr, column] of ADDRESS_COLUMNS) {
        (row as unknown as Loose)[column] = a[attr] ?? null;
      }
      return row;
    }),
  };
}

// ---------------------------------------------------------------------------
// Rows → SCIM
// ---------------------------------------------------------------------------

function multiFromRows(rows: MultiValueRow[]): ScimMultiValue[] {
  return rows.map((r) => {
    const entry: ScimMultiValue = { value: r.value };
    if (r.display !== null) entry.display = r.display;
    if (r.type !== null) entry.type = r.type;
    if (r.is_primary !== null) entry.primary = r.is_primary === 1;
    return entry;
  });
}

function addressesFromRows(rows: AddressRow[]): ScimAddress[] {
  return rows.map((r) => {
    const entry: ScimAddress = {};
    for (const [attr, column] of ADDRESS_COLUMNS) {
      const value = r[column];
      if (value !== null) (entry as Loose)[attr] = value;
    }
    if (r.type !== null) entry.type = r.type;
    if (r.is_primary !== null) entry.primary = r.is_primary === 1;
    return entry;
  });
}

export function rowToStoredUser(row: UserRow, children: ChildRows): StoredUser {
  if (!row.created_at || !row.updated_at) {
    throw ScimErrors.backend(`User ${row.id} has no created_at/updated_at.`);
  }
  const user: Loose = { id: row.id, created: row.created_at, lastModified: row.updated_at };

  for (const [path, column] of COLUMNS) {
    const value = row[column];
    if (value === null || value === undefined) continue;
    setPath(user, path, path === 'active' ? value === 1 : value);
  }

  const sorted = <T extends { position: number }>(rows: T[]) =>
    [...rows].sort((a, b) => a.position - b.position);
  if (children.user_emails.length > 0) user.emails = multiFromRows(sorted(children.user_emails));
  if (children.user_phone_numbers.length > 0) {
    user.phoneNumbers = multiFromRows(sorted(children.user_phone_numbers));
  }
  if (children.user_addresses.length > 0) {
    user.addresses = addressesFromRows(sorted(children.user_addresses));
  }

  return user as unknown as StoredUser;
}
