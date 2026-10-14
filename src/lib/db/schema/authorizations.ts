import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  date,
  foreignKey,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { patterns } from "./patterns";
import { users } from "./users";

export const authorizationScopes = ["system", "custom"] as const;
export const authorizationFieldStatuses = ["active", "archived"] as const;
export const authorizationKinds = [
  "standard",
  "field_exclusive",
  "global_buyout",
] as const;
export const authorizationStatuses = ["active", "void"] as const;

export const authorizationScopeEnum = pgEnum(
  "authorization_scope",
  authorizationScopes,
);
export const authorizationFieldStatusEnum = pgEnum(
  "authorization_field_status",
  authorizationFieldStatuses,
);
export const authorizationKindEnum = pgEnum(
  "authorization_kind",
  authorizationKinds,
);
export const authorizationStatusEnum = pgEnum(
  "authorization_status",
  authorizationStatuses,
);

export const authorizationFields = pgTable(
  "authorization_fields",
  {
    id: uuid("id").primaryKey(),
    ownerId: uuid("owner_id").references(() => users.id),
    scope: authorizationScopeEnum("scope").notNull(),
    name: text("name").notNull(),
    normalizedName: text("normalized_name").notNull(),
    status: authorizationFieldStatusEnum("status")
      .notNull()
      .default("active"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (table) => [
    check(
      "authorization_fields_scope_owner_check",
      sql`(${table.scope} = 'system' and ${table.ownerId} is null) or (${table.scope} = 'custom' and ${table.ownerId} is not null)`,
    ),
    uniqueIndex("authorization_fields_system_name_unique")
      .on(table.normalizedName)
      .where(sql`${table.scope} = 'system'`),
    uniqueIndex("authorization_fields_owner_name_unique")
      .on(table.ownerId, table.normalizedName)
      .where(sql`${table.scope} = 'custom'`),
  ],
);

export const authorizations = pgTable(
  "authorizations",
  {
    id: uuid("id").primaryKey(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id),
    patternId: uuid("pattern_id").notNull(),
    operationId: uuid("operation_id").notNull(),
    kind: authorizationKindEnum("kind").notNull(),
    fieldId: uuid("field_id").references(() => authorizationFields.id),
    fieldNameSnapshot: text("field_name_snapshot"),
    licenseeName: text("licensee_name").notNull(),
    priceFen: bigint("price_fen", { mode: "bigint" }).notNull(),
    authorizedOn: date("authorized_on", { mode: "string" }).notNull(),
    note: text("note"),
    status: authorizationStatusEnum("status").notNull().default("active"),
    version: integer("version").notNull().default(0),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "authorizations_owner_pattern_fk",
      columns: [table.ownerId, table.patternId],
      foreignColumns: [patterns.ownerId, patterns.id],
    }),
    check(
      "authorizations_kind_field_check",
      sql`(${table.kind} = 'global_buyout' and ${table.fieldId} is null and ${table.fieldNameSnapshot} is null) or (${table.kind} <> 'global_buyout' and ${table.fieldId} is not null and ${table.fieldNameSnapshot} is not null)`,
    ),
    check("authorizations_price_nonnegative", sql`${table.priceFen} >= 0`),
    unique("authorizations_owner_operation_unique").on(
      table.ownerId,
      table.operationId,
    ),
    index("authorizations_owner_pattern_status_date_idx").on(
      table.ownerId,
      table.patternId,
      table.status,
      table.authorizedOn.desc(),
    ),
    index("authorizations_owner_status_date_idx").on(
      table.ownerId,
      table.status,
      table.authorizedOn,
    ),
    index("authorizations_owner_field_status_date_idx").on(
      table.ownerId,
      table.fieldId,
      table.status,
      table.authorizedOn,
    ),
    index("authorizations_owner_kind_status_idx").on(
      table.ownerId,
      table.kind,
      table.status,
    ),
    uniqueIndex("authorizations_active_buyout_unique")
      .on(table.ownerId, table.patternId)
      .where(
        sql`${table.status} = 'active' and ${table.kind} = 'global_buyout'`,
      ),
    uniqueIndex("authorizations_active_field_exclusive_unique")
      .on(table.ownerId, table.patternId, table.fieldId)
      .where(
        sql`${table.status} = 'active' and ${table.kind} = 'field_exclusive'`,
      ),
  ],
);

