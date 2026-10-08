import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

export const userRole = pgEnum("user_role", ["admin", "user"]);
export const userStatus = pgEnum("user_status", ["active", "disabled"]);
export const themePreference = pgEnum("theme_preference", [
  "system",
  "light",
  "dark",
]);

export const users = pgTable("users", {
  id: uuid("id").primaryKey(),
  email: text("email").notNull().unique(),
  displayName: text("display_name").notNull(),
  passwordHash: text("password_hash").notNull(),
  role: userRole("role").notNull().default("user"),
  status: userStatus("status").notNull().default("active"),
  mustChangePassword: boolean("must_change_password").notNull().default(true),
  themePreference: themePreference("theme_preference")
    .notNull()
    .default("system"),
  // Stable drizzle-kit cannot serialize bigint literals while generating SQL.
  syncSeq: bigint("sync_seq", { mode: "bigint" }).notNull().default(sql`0`),
  sessionVersion: integer("session_version").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
