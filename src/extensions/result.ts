export function toolResult(value: unknown) {
	return { content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }], details: undefined };
}
