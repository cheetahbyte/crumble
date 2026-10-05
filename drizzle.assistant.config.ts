import { defineConfig } from "drizzle-kit";

export default defineConfig({
	dialect: "sqlite",
	schema: "./src/db/assistant-schema.ts",
	out: "./drizzle/assistant",
});
