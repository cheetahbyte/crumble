import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { InferSelectModel } from "drizzle-orm";
import type { plugins } from "./db/assistant-schema.ts";
import { isWithin, SLUG as TENANT_ID } from "./paths.ts";
import { dockerPluginExecutor, pluginDataPath, type PluginExecutor } from "./plugin-executor.ts";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
/** Pre-SQLite registry file, imported once and then renamed. */
const LEGACY_REGISTRY = "plugins.json";
const MAX_SOURCE_FILES = 2_000;
const MAX_SOURCE_BYTES = 20 * 1024 * 1024;
const VERSION = /^[a-f0-9]{16}$/;

export interface PluginManagerOptions {
	db: DatabaseSync;
	rootDir: string;
	workspacesDir: string;
	image: string;
	tenantId: string;
	disabled?: boolean;
	executor?: PluginExecutor;
}

export interface PluginInfo {
	name: string;
	description: string;
	instructions?: string;
	status: "enabled" | "disabled" | "error";
	version?: string;
	entry?: string;
	error?: string;
}

const ManifestSchema = Type.Object({
	name: Type.String(), description: Type.String(), instructions: Type.Optional(Type.String()), entry: Type.String(),
}, { additionalProperties: true });
const LegacyRecordSchema = Type.Object({
	...ManifestSchema.properties,
	version: Type.String(), history: Type.Array(Type.String()), enabled: Type.Boolean(), lastError: Type.Optional(Type.String()),
}, { additionalProperties: true });
const LegacyRegistrySchema = Type.Object({ plugins: Type.Record(Type.String(), Type.Unknown()) }, { additionalProperties: true });

type Manifest = Static<typeof ManifestSchema>;
type PluginRecord = Static<typeof LegacyRecordSchema>;
type PluginRow = InferSelectModel<typeof plugins>;

function toRecord(row: PluginRow): PluginRecord {
	return {
		name: row.name,
		description: row.description,
		...(row.instructions !== null ? { instructions: row.instructions } : {}),
		entry: row.entry,
		version: row.version,
		history: JSON.parse(row.history_json) as string[],
		enabled: row.enabled === 1,
		...(row.last_error !== null ? { lastError: row.last_error } : {}),
	};
}

interface ValidatedSnapshot {
	directory: string;
	manifest: Manifest;
}

function shortError(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return message.replace(/[\r\n]+/g, " ").slice(0, 300);
}

async function assertNoSymlinks(path: string): Promise<void> {
	const info = await lstat(path);
	if (info.isSymbolicLink()) throw new Error(`symbolic links are not allowed: ${path}`);
	if (info.isDirectory()) {
		for (const name of await readdir(path)) await assertNoSymlinks(join(path, name));
	}
}

async function digestTree(path: string): Promise<string> {
	const hash = createHash("sha256");
	const walk = async (dir: string, prefix = "") => {
		const names = (await readdir(dir)).sort();
		for (const name of names) {
			const full = join(dir, name);
			const rel = prefix ? `${prefix}/${name}` : name;
			const info = await lstat(full);
			if (info.isDirectory()) {
				hash.update(`dir:${rel}\0`);
				await walk(full, rel);
			} else if (info.isFile()) {
				hash.update(`file:${rel}\0`);
				hash.update(await readFile(full));
			} else throw new Error(`unsupported file type: ${rel}`);
		}
	};
	await walk(path);
	return hash.digest("hex").slice(0, 16);
}

function parseManifest(value: unknown): Manifest {
	if (!Value.Check(ManifestSchema, value)) {
		if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("plugin.json must be an object");
		const first = Value.Errors(ManifestSchema, value)[0];
		const path = String(first?.instancePath ?? "");
		if (path.endsWith("/name")) throw new Error("plugin name must be a lowercase slug");
		if (path.endsWith("/description")) throw new Error("plugin description must be non-empty");
		if (path.endsWith("/entry")) throw new Error("plugin entry must be a relative path");
		if (path.endsWith("/instructions")) throw new Error("plugin instructions must be a string");
		throw new Error("plugin.json must be an object");
	}
	const raw = value as Static<typeof ManifestSchema>;
	if (!SLUG.test(raw.name)) throw new Error("plugin name must be a lowercase slug");
	if (raw.description.trim() === "") throw new Error("plugin description must be non-empty");
	if (raw.entry.trim() === "" || isAbsolute(raw.entry)) throw new Error("plugin entry must be a relative path");
	const entry = raw.entry.replaceAll("\\", "/");
	if (entry.split("/").some((part) => part === ".." || part === "")) throw new Error("plugin entry must stay inside the plugin directory");
	return {
		name: raw.name,
		description: raw.description.trim(),
		...(typeof raw.instructions === "string" && raw.instructions.trim() ? { instructions: raw.instructions.trim() } : {}),
		entry,
	};
}

export class PluginManager {
	private readonly db: DatabaseSync;
	private readonly rootDir: string;
	private readonly workspacesDir: string;
	private readonly image: string;
	private readonly tenantId: string;
	private readonly disabled: boolean;
	private readonly executor: PluginExecutor;
	private realRootDir?: string;
	private loadError?: string;
	private malformedRecords: PluginInfo[] = [];
	private initialized?: Promise<void>;

	constructor(options: PluginManagerOptions) {
		this.db = options.db;
		this.rootDir = resolve(options.rootDir);
		this.workspacesDir = resolve(options.workspacesDir);
		this.image = options.image;
		if (!TENANT_ID.test(options.tenantId)) throw new Error("plugin tenant id must be a lowercase slug");
		this.tenantId = options.tenantId;
		this.disabled = options.disabled ?? false;
		this.executor = options.executor ?? dockerPluginExecutor;
	}

	private ready(): Promise<void> {
		this.initialized ??= (async () => {
			await mkdir(this.rootDir, { recursive: true, mode: 0o700 });
			const rootInfo = await lstat(this.rootDir);
			if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new Error("plugin root must be a real directory, not a symlink");
			this.realRootDir = await realpath(this.rootDir);
			const snapshotsRoot = join(this.rootDir, "snapshots");
			await this.assertManagedPath(snapshotsRoot, { allowMissing: true });
			await mkdir(snapshotsRoot, { recursive: true, mode: 0o700 });
			await this.assertManagedPath(snapshotsRoot, { kind: "directory" });
			const dataRoot = join(this.rootDir, "data");
			await this.assertManagedPath(dataRoot, { allowMissing: true });
			const tenantDataRoot = pluginDataPath(this.rootDir, this.tenantId, "_");
			await this.assertManagedPath(tenantDataRoot, { allowMissing: true });
			await mkdir(tenantDataRoot, { recursive: true, mode: 0o700 });
			await this.assertManagedPath(tenantDataRoot, { kind: "directory" });
			await this.importLegacyRegistry();
		})();
		return this.initialized;
	}

	/** Import records from the pre-SQLite plugins.json once, keeping the file as plugins.json.imported. */
	private async importLegacyRegistry(): Promise<void> {
		const registryPath = join(this.rootDir, LEGACY_REGISTRY);
		await this.assertManagedPath(registryPath, { allowMissing: true, kind: "file" });
		let value: unknown;
		try {
			value = JSON.parse(await readFile(registryPath, "utf8"));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.loadError = `could not read plugin registry: ${shortError(error)}`;
			return;
		}
		if (!Value.Check(LegacyRegistrySchema, value)) {
			this.loadError = "plugin registry has an invalid format";
			return;
		}
		for (const [name, record] of Object.entries(value.plugins)) {
			try {
				if (!SLUG.test(name) || !Value.Check(LegacyRecordSchema, record)) throw new Error("invalid plugin record");
				parseManifest(record);
				if (record.name !== name) throw new Error("plugin record name does not match its key");
				if (!VERSION.test(record.version)) throw new Error("invalid plugin version");
				if (!record.history.every((item) => VERSION.test(item))) throw new Error("invalid plugin history");
				if (!this.find(name)) this.save(record);
			} catch (error) {
				this.malformedRecords.push({ name: SLUG.test(name) ? name : "_invalid", description: "Malformed plugin record", status: "error", error: shortError(error) });
			}
		}
		await rename(registryPath, `${registryPath}.imported`);
	}

	private find(name: string): PluginRecord | undefined {
		const row = this.db.prepare("SELECT * FROM plugins WHERE name = ?").get(name) as PluginRow | undefined;
		return row ? toRecord(row) : undefined;
	}

	private save(record: PluginRecord): void {
		this.db.prepare(`INSERT INTO plugins (name, description, instructions, entry, version, history_json, enabled, last_error)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(name) DO UPDATE SET description = excluded.description, instructions = excluded.instructions, entry = excluded.entry,
				version = excluded.version, history_json = excluded.history_json, enabled = excluded.enabled, last_error = excluded.last_error`)
			.run(record.name, record.description, record.instructions ?? null, record.entry, record.version,
				JSON.stringify(record.history), record.enabled ? 1 : 0, record.lastError ?? null);
	}

	private async assertManagedPath(
		path: string,
		options: { allowMissing?: boolean; kind?: "file" | "directory" } = {},
	): Promise<void> {
		const candidate = resolve(path);
		if (!isWithin(this.rootDir, candidate)) throw new Error(`plugin storage path escapes its root: ${path}`);
		const canonicalRoot = this.realRootDir ?? await realpath(this.rootDir);
		let current = this.rootDir;
		if (candidate !== this.rootDir) {
			for (const component of relative(this.rootDir, candidate).split(sep).filter(Boolean)) {
				current = join(current, component);
				let info;
				try { info = await lstat(current); }
				catch (error) {
					if (options.allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT") return;
					throw error;
				}
				if (info.isSymbolicLink()) throw new Error(`plugin storage cannot contain symlinks: ${current}`);
				if (current !== candidate && !info.isDirectory()) throw new Error(`plugin storage parent is not a directory: ${current}`);
			}
		}
		const actual = await realpath(candidate);
		if (!isWithin(canonicalRoot, actual)) throw new Error(`plugin storage path resolves outside its root: ${path}`);
		const info = await lstat(candidate);
		if (options.kind === "file" && !info.isFile()) throw new Error(`plugin storage file is invalid: ${path}`);
		if (options.kind === "directory" && !info.isDirectory()) throw new Error(`plugin storage directory is invalid: ${path}`);
	}

	private async sourceDirectory(sourceRelativePath: string): Promise<string> {
		if (isAbsolute(sourceRelativePath)) throw new Error("plugin source path must be relative to tenant workspaces");
		const source = resolve(this.workspacesDir, sourceRelativePath);
		if (!isWithin(this.workspacesDir, source)) throw new Error("plugin source path escapes tenant workspaces");
		if ((await lstat(this.workspacesDir)).isSymbolicLink()) throw new Error("tenant workspaces directory cannot be a symbolic link");
		const realRoot = await realpath(this.workspacesDir);
		let current = this.workspacesDir;
		for (const part of relative(this.workspacesDir, source).split(sep).filter(Boolean)) {
			current = join(current, part);
			if ((await lstat(current)).isSymbolicLink()) throw new Error(`symbolic links are not allowed: ${current}`);
		}
		await assertNoSymlinks(source);
		const info = await lstat(source);
		if (!info.isDirectory()) throw new Error("plugin source must be a directory");
		if (!isWithin(realRoot, await realpath(source))) throw new Error("plugin source resolves outside tenant workspaces");
		return source;
	}

	async install(sourceRelativePath: string): Promise<PluginInfo> {
		await this.ready();
		const source = await this.sourceDirectory(sourceRelativePath);
		const staging = join(this.rootDir, "snapshots", `.install-${randomUUID()}`);
		await mkdir(staging, { recursive: true, mode: 0o700 });
		await this.assertManagedPath(staging, { kind: "directory" });
		let manifest: Manifest;
		let version: string;
		try {
			await copyTreeBounded(source, staging, { files: 0, bytes: 0 });
			manifest = parseManifest(JSON.parse(await readFile(join(staging, "plugin.json"), "utf8")));
			const entryPath = resolve(staging, manifest.entry);
			if (!isWithin(staging, entryPath)) throw new Error("plugin entry escapes the plugin directory");
			await assertNoSymlinks(entryPath);
			if (!(await lstat(entryPath)).isFile()) throw new Error("plugin entry must be a file");
			await assertNoSymlinks(staging);
			version = await digestTree(staging);
		} catch (error) {
			await rm(staging, { recursive: true, force: true });
			throw error;
		}
		const snapshotsRoot = join(this.rootDir, "snapshots");
		const snapshotDir = join(snapshotsRoot, manifest.name, version);
		if (!isWithin(snapshotsRoot, snapshotDir)) throw new Error("invalid plugin snapshot path");
		await this.assertManagedPath(join(snapshotsRoot, manifest.name), { allowMissing: true });
		await this.assertManagedPath(snapshotDir, { allowMissing: true });
		await mkdir(dirname(snapshotDir), { recursive: true, mode: 0o700 });
		await this.assertManagedPath(dirname(snapshotDir), { kind: "directory" });
		if (await exists(snapshotDir)) {
			await this.assertManagedPath(snapshotDir, { kind: "directory" });
			await rm(staging, { recursive: true, force: true });
		}
		else await rename(staging, snapshotDir);
		await this.assertManagedPath(snapshotDir, { kind: "directory" });
		const previous = this.find(manifest.name);
		const sameVersion = previous?.version === version;
		const record: PluginRecord = {
			...manifest,
			version,
			history: previous ? sameVersion ? previous.history : [...previous.history, previous.version].filter((value, index, all) => all.indexOf(value) === index) : [],
			enabled: this.disabled ? false : sameVersion ? previous.enabled : true,
			...(sameVersion && previous.lastError ? { lastError: previous.lastError } : {}),
		};
		this.save(record);
		return this.toInfo(record);
	}

	async list(): Promise<PluginInfo[]> {
		await this.ready();
		const rows = this.db.prepare("SELECT * FROM plugins").all() as unknown as PluginRow[];
		const installed = rows.map((row) => this.toInfo(toRecord(row)));
		const names = new Set(rows.map((row) => row.name));
		installed.push(...this.malformedRecords);
		if (this.loadError) installed.push({ name: "_registry", description: "Plugin registry", status: "error", error: this.loadError });
		// Surface malformed capability folders without allowing them to prevent manager startup.
		const capabilityRoot = join(this.workspacesDir, "capabilities");
		try {
			for (const name of await readdir(capabilityRoot)) {
				if (names.has(name)) continue;
				try {
					const source = await this.sourceDirectory(join("capabilities", name));
					parseManifest(JSON.parse(await readFile(join(source, "plugin.json"), "utf8")));
				} catch (error) {
					installed.push({ name, description: "Uninstalled capability", status: "error", error: shortError(error) });
				}
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") installed.push({ name: "_capabilities", description: "Capability sources", status: "error", error: shortError(error) });
		}
		return installed.sort((a, b) => a.name.localeCompare(b.name));
	}

	async disable(name: string): Promise<PluginInfo> {
		await this.ready();
		const record = this.get(name);
		record.enabled = false;
		this.save(record);
		return this.toInfo(record);
	}

	async enable(name: string): Promise<PluginInfo> {
		await this.ready();
		if (this.disabled) throw new Error("plugins are disabled by safe mode");
		const record = this.get(name);
		await this.validateSnapshot(record);
		record.enabled = true;
		delete record.lastError;
		this.save(record);
		return this.toInfo(record);
	}

	async rollback(name: string): Promise<PluginInfo> {
		await this.ready();
		if (this.disabled) throw new Error("plugins are disabled by safe mode");
		const record = this.get(name);
		const previous = record.history.at(-1);
		if (!previous) throw new Error(`plugin ${name} has no previous version`);
		const target = await this.validateSnapshot({ name: record.name, version: previous });
		const old = record.version;
		record.description = target.manifest.description;
		record.entry = target.manifest.entry;
		if (target.manifest.instructions === undefined) delete record.instructions;
		else record.instructions = target.manifest.instructions;
		record.version = previous;
		record.history = record.history.slice(0, -1).concat(old);
		delete record.lastError;
		this.save(record);
		return this.toInfo(record);
	}

	async invoke(name: string, input: unknown, signal?: AbortSignal): Promise<string> {
		await this.ready();
		const record = this.get(name);
		if (!record.enabled || this.disabled) throw new Error(`plugin ${name} is disabled`);
		try {
			const snapshot = await this.validateSnapshot(record);
			if (signal?.aborted) throw new Error("plugin invocation aborted");
			const dataDir = pluginDataPath(this.rootDir, this.tenantId, name);
			await this.assertManagedPath(dataDir, { allowMissing: true });
			await mkdir(dataDir, { recursive: true, mode: 0o700 });
			await this.assertManagedPath(dataDir, { kind: "directory" });
			const result = await this.executor({
				snapshotDir: snapshot.directory,
				entry: snapshot.manifest.entry,
				dataDir,
				image: this.image,
				input,
				signal,
			});
			if (signal?.aborted) throw new Error("plugin invocation aborted");
			return result;
		} catch (error) {
			if (signal?.aborted) throw error;
			record.enabled = false;
			record.lastError = shortError(error);
			this.save(record);
			throw new Error(`plugin ${name} failed and was disabled: ${record.lastError}`);
		}
	}

	private get(name: string): PluginRecord {
		if (!SLUG.test(name)) throw new Error(`invalid plugin name: ${name}`);
		const record = this.find(name);
		if (!record) throw new Error(`plugin not installed: ${name}`);
		return record;
	}

	private async validateSnapshot(record: Pick<PluginRecord, "name" | "version">): Promise<ValidatedSnapshot> {
		if (!SLUG.test(record.name) || typeof record.version !== "string" || !VERSION.test(record.version)) throw new Error("invalid plugin snapshot version");
		const root = join(this.rootDir, "snapshots");
		const path = resolve(root, record.name, record.version);
		if (!isWithin(root, path)) throw new Error("invalid plugin snapshot path");
		await this.assertManagedPath(path, { kind: "directory" });
		await assertNoSymlinks(path);
		const manifest = parseManifest(JSON.parse(await readFile(join(path, "plugin.json"), "utf8")));
		if (manifest.name !== record.name) throw new Error("plugin snapshot name does not match its record");
		const entry = resolve(path, manifest.entry);
		if (!isWithin(path, entry) || !(await lstat(entry)).isFile()) throw new Error("plugin snapshot entry is missing or invalid");
		return { directory: path, manifest };
	}

	private toInfo(record: PluginRecord): PluginInfo {
		return {
			name: record.name,
			description: record.description,
			...(record.instructions ? { instructions: record.instructions } : {}),
			status: this.disabled ? "disabled" : record.lastError ? "error" : record.enabled ? "enabled" : "disabled",
			version: record.version,
			entry: record.entry,
			...(record.lastError ? { error: record.lastError } : {}),
		};
	}
}

async function exists(path: string): Promise<boolean> {
	try { await lstat(path); return true; } catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

async function copyTreeBounded(source: string, destination: string, totals: { files: number; bytes: number }): Promise<void> {
	for (const name of await readdir(source)) {
		const from = join(source, name);
		const to = join(destination, name);
		const info = await lstat(from);
		if (info.isSymbolicLink()) throw new Error(`symbolic links are not allowed: ${from}`);
		if (info.isDirectory()) {
			await mkdir(to, { mode: 0o700 });
			await copyTreeBounded(from, to, totals);
		} else if (info.isFile()) {
			totals.files++;
			if (totals.files > MAX_SOURCE_FILES) throw new Error(`plugin source exceeds ${MAX_SOURCE_FILES} files`);
			const handle = await open(from, constants.O_RDONLY | constants.O_NOFOLLOW);
			try {
				const current = await handle.stat();
				if (!current.isFile()) throw new Error(`unsupported file type: ${from}`);
				totals.bytes += current.size;
				if (totals.bytes > MAX_SOURCE_BYTES) throw new Error(`plugin source exceeds ${MAX_SOURCE_BYTES} bytes`);
				const content = await handle.readFile();
				totals.bytes += content.length - current.size;
				if (totals.bytes > MAX_SOURCE_BYTES) throw new Error(`plugin source exceeds ${MAX_SOURCE_BYTES} bytes`);
				await writeFile(to, content, { mode: 0o600, flag: "wx" });
			} finally { await handle.close(); }
		}
		else throw new Error(`unsupported file type: ${from}`);
	}
}
