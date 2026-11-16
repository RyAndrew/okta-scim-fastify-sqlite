// ---------------------------------------------------------------------------
// SQLite group backend. Members are users; membership changes arrive from
// core as deltas (MemberChange) and are applied in one transaction.
// A member id that is not a user is a 400 naming the id, never skipped.
// ---------------------------------------------------------------------------

import { randomUUID } from 'crypto';
import {
  GroupAttributes,
  GroupLookup,
  GroupPage,
  GroupQuery,
  GroupUpdate,
  ScimBackendError,
  ScimErrors,
  ScimGroupBackend,
  StoredGroup,
} from 'scim-fastify-core';
import type { audited } from './backend';
import type { Db } from './schema';

interface GroupRow {
  id: string;
  display_name: string;
  external_id: string | null;
  created_at: string;
  updated_at: string;
}

/** Stay well under SQLite's bound-parameter limit. */
const CHUNK = 500;

function chunks<T>(items: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += CHUNK) out.push(items.slice(i, i + CHUNK));
  return out;
}

const now = (): string => new Date().toISOString();

export class SqliteGroupBackend implements ScimGroupBackend {
  readonly attributes = ['displayName', 'externalId', 'members'] as const;
  readonly lookups = ['id', 'displayName', 'externalId'] as const;

  constructor(
    private readonly db: Db,
    private readonly run: ReturnType<typeof audited>,
  ) {}

  // ── Read ─────────────────────────────────────────────────────────────────

  async getGroup(id: string, { includeMembers }: { includeMembers: boolean }): Promise<StoredGroup | null> {
    return this.run({ operation: 'select', target: `groups/${id}`, params: { includeMembers } }, async () => {
      const row = await this.db<GroupRow>('groups').where({ id }).first();
      if (!row) return null;
      const members = includeMembers ? await this.readMembers([id]) : null;
      return toStoredGroup(row, members?.get(id));
    });
  }

  async listGroups(query: GroupQuery): Promise<GroupPage> {
    const { lookup, startIndex, count, includeMembers } = query;
    return this.run(
      { operation: 'select', target: 'groups', params: { lookup, startIndex, count, includeMembers } },
      async () => {
        const base = () => applyLookup(this.db('groups'), lookup);

        const [{ total }] = await base().count<{ total: number }[]>({ total: '*' });
        if (count === 0) return { groups: [], totalResults: Number(total) };

        const rows: GroupRow[] = await base()
          .select('*')
          .orderBy([
            { column: 'created_at', order: 'desc' },
            { column: 'id', order: 'asc' },
          ])
          .limit(count)
          .offset(startIndex - 1);

        const members = includeMembers ? await this.readMembers(rows.map((r) => r.id)) : null;
        return {
          groups: rows.map((r) => toStoredGroup(r, members?.get(r.id))),
          totalResults: Number(total),
        };
      },
    );
  }

  // ── Write ────────────────────────────────────────────────────────────────

  async createGroup(group: GroupAttributes, memberIds: string[]): Promise<string> {
    const id = randomUUID();
    const ts = now();
    await this.run(
      { operation: 'insert', target: `groups/${id}`, params: { group, members: memberIds.length } },
      () =>
        this.db.transaction(async (trx) => {
          await trx('groups').insert({
            id,
            display_name: group.displayName,
            external_id: group.externalId ?? null,
            created_at: ts,
            updated_at: ts,
          });
          await requireUsers(trx, memberIds);
          await insertMembers(trx, id, memberIds);
        }),
    );
    return id;
  }

  async updateGroup(id: string, { group, members }: GroupUpdate): Promise<void> {
    const summary =
      members === undefined
        ? undefined
        : 'replace' in members
          ? { replace: members.replace.length }
          : { add: members.add.length, remove: members.remove.length };

    await this.run(
      { operation: 'update', target: `groups/${id}`, params: { group, members: summary } },
      () =>
        this.db.transaction(async (trx) => {
          const changed = await trx('groups').where({ id }).update({
            display_name: group.displayName,
            external_id: group.externalId ?? null,
            updated_at: now(),
          });
          if (changed === 0) throw groupNotFound(id);
          if (members === undefined) return;

          if ('replace' in members) {
            await requireUsers(trx, members.replace);
            await trx('group_members').where({ group_id: id }).delete();
            await insertMembers(trx, id, members.replace);
          } else {
            await requireUsers(trx, members.add);
            await insertMembers(trx, id, members.add);
            for (const part of chunks(members.remove)) {
              await trx('group_members').where({ group_id: id }).whereIn('user_id', part).delete();
            }
          }
        }),
    );
  }

  async deleteGroup(id: string): Promise<void> {
    await this.run({ operation: 'delete', target: `groups/${id}` }, async () => {
      const deleted = await this.db('groups').where({ id }).delete();
      if (deleted === 0) throw groupNotFound(id);
    });
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private async readMembers(groupIds: string[]): Promise<Map<string, { value: string; display: string }[]>> {
    const out = new Map(groupIds.map((id) => [id, [] as { value: string; display: string }[]]));
    for (const part of chunks(groupIds)) {
      const rows: { group_id: string; user_id: string; user_name: string }[] = await this.db('group_members')
        .join('users', 'users.id', 'group_members.user_id')
        .whereIn('group_members.group_id', part)
        .select('group_members.group_id', 'group_members.user_id', 'users.user_name')
        .orderBy('users.user_name');
      for (const r of rows) out.get(r.group_id)!.push({ value: r.user_id, display: r.user_name });
    }
    return out;
  }
}

// ---------------------------------------------------------------------------

const groupNotFound = (id: string) => new ScimBackendError(404, `Group ${id} not found.`);

function applyLookup(builder: ReturnType<Db>, lookup: GroupLookup | undefined) {
  if (!lookup) return builder;
  switch (lookup.by) {
    case 'id':
      return builder.where('id', lookup.value);
    case 'displayName':
      return builder.where('display_name', lookup.value); // NOCASE column
    case 'externalId':
      return builder.where('external_id', lookup.value);
  }
}

function toStoredGroup(row: GroupRow, members: { value: string; display: string }[] | undefined): StoredGroup {
  const group: StoredGroup = {
    id: row.id,
    displayName: row.display_name,
    created: row.created_at,
    lastModified: row.updated_at,
  };
  if (row.external_id !== null) group.externalId = row.external_id;
  if (members !== undefined) group.members = members;
  return group;
}

/** Reject member ids that are not users, naming them (the FK would not say which). */
async function requireUsers(trx: Db, ids: readonly string[]): Promise<void> {
  const found = new Set<string>();
  for (const part of chunks(ids)) {
    const rows: { id: string }[] = await trx('users').whereIn('id', part).select('id');
    rows.forEach((r) => found.add(r.id));
  }
  const unknown = ids.filter((id) => !found.has(id));
  if (unknown.length > 0) {
    throw ScimErrors.invalidValue(`These members are not users: ${unknown.join(', ')}.`);
  }
}

async function insertMembers(trx: Db, groupId: string, userIds: readonly string[]): Promise<void> {
  for (const part of chunks(userIds)) {
    await trx('group_members')
      .insert(part.map((user_id) => ({ group_id: groupId, user_id })))
      .onConflict(['group_id', 'user_id'])
      .ignore();
  }
}
