import type { Db } from '../db.js';

export async function audit(
  c: Db,
  userId: number | null,
  action: string,
  entity: string,
  entityId: string | number | null,
  detail?: Record<string, unknown>
): Promise<void> {
  await c.query('insert into audit_log(user_id, action, entity, entity_id, detail) values ($1,$2,$3,$4,$5)', [
    userId,
    action,
    entity,
    entityId === null ? null : String(entityId),
    detail ? JSON.stringify(detail) : null
  ]);
}
