import "./scripts/load-env";
import { defineConfig } from "drizzle-kit";
import { databaseUrl } from "./lib/db/config";

export default defineConfig({
  dialect: "sqlite",
  schema: "./lib/db/schema.ts",
  out: "./drizzle",
  dbCredentials: { url: databaseUrl() },
});
