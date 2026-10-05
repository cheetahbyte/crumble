import { defineConfig } from "drizzle-kit";

export default defineConfig({
	dialect: "sqlite",
	schema: "./src/db/jobs-schema.ts",
	out: "./drizzle/jobs",
});
