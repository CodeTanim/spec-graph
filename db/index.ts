import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

type DatabaseDeploymentEnvironment = "production" | "preview" | "development";

function runtimeDeploymentEnvironment(): DatabaseDeploymentEnvironment {
  const vercelEnvironment = process.env.VERCEL_ENV?.trim();
  if (
    vercelEnvironment === "production" ||
    vercelEnvironment === "preview" ||
    vercelEnvironment === "development"
  ) {
    return vercelEnvironment;
  }

  return process.env.NODE_ENV === "production" ? "production" : "development";
}

export function assertDatabaseDeploymentEnvironment(
  expected = process.env.DATABASE_DEPLOYMENT_ENVIRONMENT?.trim(),
  actual = runtimeDeploymentEnvironment(),
) {
  if (!expected) return;
  if (
    expected !== "production" &&
    expected !== "preview" &&
    expected !== "development"
  ) {
    throw new Error(
      "DATABASE_DEPLOYMENT_ENVIRONMENT must be production, preview, or development.",
    );
  }
  if (expected !== actual) {
    throw new Error(
      `Database environment mismatch: this database is marked ${expected}, but the app is running in ${actual}.`,
    );
  }
}

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

  assertDatabaseDeploymentEnvironment();

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
