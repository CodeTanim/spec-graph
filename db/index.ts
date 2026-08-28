import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

export function createDb(connectionString: string) {
  const client = postgres(connectionString, {
    max: 1,
    prepare: false,
  });
  return drizzle(client, { schema });
}

let database: ReturnType<typeof createDb> | undefined;

export function getDb(): ReturnType<typeof createDb> {
  if (database) return database;

  const connectionString = [
    process.env.DATABASE_URL,
    process.env.POSTGRES_URL,
  ]
    .map((value) => value?.trim())
    .find(Boolean);
  if (!connectionString) {
    throw new Error(
      "DATABASE_URL or POSTGRES_URL is required to use SpecGraph persistence.",
    );
  }

  database = createDb(connectionString);
  return database;
}

export type SpecGraphDb = ReturnType<typeof createDb>;
