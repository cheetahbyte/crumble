/** Memory and procedures land in every prompt, so obvious credentials are refused at save time. */
export function containsSecret(value: string): boolean {
	return /-----BEGIN .*PRIVATE KEY|\bsk-[\w-]{20,}|\bgh[pousr]_\w{20,}|\bAKIA[0-9A-Z]{16}\b|\bxox[abprs]-[\w-]{10,}|\b(?:password|passwd|api[_ -]?key|access[_ -]?token|secret)\s*[:=]\s*\S+/i.test(value);
}
