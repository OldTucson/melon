import "server-only";

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { getServerEnv } from "@/lib/env/server";
import * as schema from "@/lib/db/schema";

const queryClient = postgres(getServerEnv().DATABASE_URL);

export const db = drizzle(queryClient, { schema });

export const closeDatabase = () => queryClient.end();
