import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as schema from "./schema";

export function createDb(connectionString: string) {
  return drizzle(neon(connectionString), { schema });
}

let database: ReturnType<typeof createDb> | undefined;

export function getDb(): ReturnType<typeof createDb> {
  if (database) return database;

  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) {
    throw new Error("DATABASE_URL is required to use SpecGraph persistence.");
  }

  database = createDb(connectionString);
  return database;
}

export type SpecGraphDb = ReturnType<typeof createDb>;
