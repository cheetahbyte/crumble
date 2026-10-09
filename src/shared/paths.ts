import { lstatSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";

/** Lowercase slug used for tenant IDs, project workspaces, and job IDs. */
export const SLUG = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/;

export function isWithin(parent: string, child: string): boolean {
	const rel = relative(parent, child);
	return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

/** Throws when path is a symbolic link; a missing path is allowed. */
export function rejectSymlink(path: string, label: string): void {
	try {
		if (lstatSync(path).isSymbolicLink()) throw new Error(`${label} must not be a symbolic link`);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}

export function validateTimezone(timezone: string): string {
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: timezone });
	} catch {
		throw new Error(`Invalid timezone ${JSON.stringify(timezone)}: expected an IANA timezone`);
	}
	return timezone;
}
