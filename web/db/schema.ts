import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';

// Transient usage bookkeeping only. No file, model response, or raw IP is stored.
export const jobs = sqliteTable('specflow_jobs', {
  id: text('id').primaryKey(),
  owner: text('owner').notNull(),
  ipHash: text('ip_hash').notNull(),
  status: text('status').notNull(),
  createdAt: integer('created_at').notNull(),
  expiresAt: integer('expires_at').notNull(),
  errorCode: text('error_code'),
}, table => [
  index('specflow_owner_created').on(table.owner, table.createdAt),
  index('specflow_status_expires').on(table.status, table.expiresAt),
  index('specflow_ip_created').on(table.ipHash, table.createdAt),
]);
