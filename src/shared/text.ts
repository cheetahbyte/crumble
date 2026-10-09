export function assertText(value: string, label: string, max: number): void {
	if (typeof value !== "string" || value.trim().length === 0 || value.length > max) {
		throw new Error(`${label} must contain 1 to ${max} characters`);
	}
}
