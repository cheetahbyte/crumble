import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { dockerPluginExecutor, pluginDataPath, type PluginExecutor } from "./plugin-executor.ts";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const TENANT_ID = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/;
const REGISTRY = "plugins.json";
const MAX_SOURCE_FILES = 2_000;
const MAX_SOURCE_BYTES = 20 * 1024 * 1024;
const VERSION = /^[a-f0-9]{16}$/;

export interface PluginManagerOptions {
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

interface Manifest {
	name: string;
	description: string;
	instructions?: string;
	entry: string;
}

const ManifestSchema = Type.Object({
	name: Type.String(), description: Type.String(), instructions: Type.Optional(Type.String()), entry: Type.String(),
}, { additionalProperties: true });
const PluginRecordSchema = Type.Object({
	name: Type.String(), description: Type.String(), instructions: Type.Optional(Type.String()), entry: Type.String(),
	version: Type.String(), history: Type.Array(Type.String()), enabled: Type.Boolean(), lastError: Type.Optional(Type.String()),
}, { additionalProperties: true });
const RegistrySchema = Type.Object({ plugins: Type.Record(Type.String(), Type.Unknown()) }, { additionalProperties: true });

interface PluginRecord extends Manifest {
	version: string;
	history: string[];
	enabled: boolean;
	lastError?: string;
}

interface RegistryData {
	plugins: Record<string, PluginRecord>;
}

interface ValidatedSnapshot {
	directory: string;
	manifest: Manifest;
}

function shortError(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return message.replace(/[\r\n]+/g, " ").slice(0, 300);
}

function inside(parent: string, child: string): boolean {
	const rel = relative(parent, child);
	return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
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
		const path = String(first && "path" in first ? first.path : "");
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
	private readonly rootDir: string;
	private readonly workspacesDir: string;
	private readonly image: string;
	private readonly tenantId: string;
	private readonly disabled: boolean;
	private readonly executor: PluginExecutor;
	private realRootDir?: string;
	private registry: RegistryData = { plugins: {} };
	private loadError?: string;
	private malformedRecords: PluginInfo[] = [];
	private initialized?: Promise<void>;
	private writeChain: Promise<void> = Promise.resolve();

	constructor(options: PluginManagerOptions) {
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
			const registryPath = join(this.rootDir, REGISTRY);
			await this.assertManagedPath(registryPath, { allowMissing: true, kind: "file" });
			try {
				const value: unknown = JSON.parse(await readFile(registryPath, "utf8"));
				if (Value.Check(RegistrySchema, value)) {
					this.registry.plugins = Object.fromEntries(Object.entries((value as RegistryData).plugins).filter(([name, record]) => {
						try {
							if (!SLUG.test(name) || !Value.Check(PluginRecordSchema, record)) throw new Error("invalid plugin record");
							parseManifest(record);
							const typed = record as Static<typeof PluginRecordSchema>;
							if (typed.name !== name) throw new Error("plugin record name does not match its key");
							if (!VERSION.test(typed.version)) throw new Error("invalid plugin version");
							if (!typed.history.every((item) => VERSION.test(item))) throw new Error("invalid plugin history");
							return true;
						} catch (error) {
							this.malformedRecords.push({ name: SLUG.test(name) ? name : "_invalid", description: "Malformed plugin record", status: "error", error: shortError(error) });
							return false;
						}
					}));
				} else this.loadError = "plugin registry has an invalid format";
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.loadError = `could not read plugin registry: ${shortError(error)}`;
			}
			if (this.disabled) {
				for (const record of Object.values(this.registry.plugins)) record.enabled = false;
			}
		})();
		return this.initialized;
	}

	private persist(): Promise<void> {
		const save = async () => {
			const path = join(this.rootDir, REGISTRY);
			await this.assertManagedPath(this.rootDir, { kind: "directory" });
			await this.assertManagedPath(path, { allowMissing: true, kind: "file" });
			const temporary = `${path}.${randomUUID()}.tmp`;
			await writeFile(temporary, `${JSON.stringify(this.registry, null, 2)}\n`, { mode: 0o600, flag: "wx" });
			await this.assertManagedPath(temporary, { kind: "file" });
			await rename(temporary, path);
			await this.assertManagedPath(path, { kind: "file" });
		};
		this.writeChain = this.writeChain.then(save);
		return this.writeChain;
	}

	private async assertManagedPath(
		path: string,
		options: { allowMissing?: boolean; kind?: "file" | "directory" } = {},
	): Promise<void> {
		const candidate = resolve(path);
		if (!inside(this.rootDir, candidate)) throw new Error(`plugin storage path escapes its root: ${path}`);
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
		if (!inside(canonicalRoot, actual)) throw new Error(`plugin storage path resolves outside its root: ${path}`);
		const info = await lstat(candidate);
		if (options.kind === "file" && !info.isFile()) throw new Error(`plugin storage file is invalid: ${path}`);
		if (options.kind === "directory" && !info.isDirectory()) throw new Error(`plugin storage directory is invalid: ${path}`);
	}

	private async sourceDirectory(sourceRelativePath: string): Promise<string> {
		if (isAbsolute(sourceRelativePath)) throw new Error("plugin source path must be relative to tenant workspaces");
		const source = resolve(this.workspacesDir, sourceRelativePath);
		if (!inside(this.workspacesDir, source)) throw new Error("plugin source path escapes tenant workspaces");
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
		if (!inside(realRoot, await realpath(source))) throw new Error("plugin source resolves outside tenant workspaces");
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
			if (!inside(staging, entryPath)) throw new Error("plugin entry escapes the plugin directory");
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
		if (!inside(snapshotsRoot, snapshotDir)) throw new Error("invalid plugin snapshot path");
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
		const previous = this.registry.plugins[manifest.name];
		const sameVersion = previous?.version === version;
		this.registry.plugins[manifest.name] = {
			...manifest,
			version,
			history: previous ? sameVersion ? previous.history : [...previous.history, previous.version].filter((value, index, all) => all.indexOf(value) === index) : [],
			enabled: this.disabled ? false : sameVersion ? previous.enabled : true,
			...(sameVersion && previous.lastError ? { lastError: previous.lastError } : {}),
		};
		await this.persist();
		return this.toInfo(this.registry.plugins[manifest.name]);
	}

	async list(): Promise<PluginInfo[]> {
		await this.ready();
		const installed = Object.values(this.registry.plugins).map((record) => this.toInfo(record));
		installed.push(...this.malformedRecords);
		if (this.loadError) installed.push({ name: "_registry", description: "Plugin registry", status: "error", error: this.loadError });
		// Surface malformed capability folders without allowing them to prevent manager startup.
		const capabilityRoot = join(this.workspacesDir, "capabilities");
		try {
			for (const name of await readdir(capabilityRoot)) {
				if (this.registry.plugins[name]) continue;
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
		await this.persist();
		return this.toInfo(record);
	}

	async enable(name: string): Promise<PluginInfo> {
		await this.ready();
		if (this.disabled) throw new Error("plugins are disabled by safe mode");
		const record = this.get(name);
		await this.validateSnapshot(record);
		record.enabled = true;
		delete record.lastError;
		await this.persist();
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
		await this.persist();
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
			await this.persist();
			throw new Error(`plugin ${name} failed and was disabled: ${record.lastError}`);
		}
	}

	private get(name: string): PluginRecord {
		if (!SLUG.test(name)) throw new Error(`invalid plugin name: ${name}`);
		const record = this.registry.plugins[name];
		if (!record) throw new Error(`plugin not installed: ${name}`);
		return record;
	}

	private async validateSnapshot(record: Pick<PluginRecord, "name" | "version">): Promise<ValidatedSnapshot> {
		if (!SLUG.test(record.name) || typeof record.version !== "string" || !VERSION.test(record.version)) throw new Error("invalid plugin snapshot version");
		const root = join(this.rootDir, "snapshots");
		const path = resolve(root, record.name, record.version);
		if (!inside(root, path)) throw new Error("invalid plugin snapshot path");
		await this.assertManagedPath(path, { kind: "directory" });
		await assertNoSymlinks(path);
		const manifest = parseManifest(JSON.parse(await readFile(join(path, "plugin.json"), "utf8")));
		if (manifest.name !== record.name) throw new Error("plugin snapshot name does not match its record");
		const entry = resolve(path, manifest.entry);
		if (!inside(path, entry) || !(await lstat(entry)).isFile()) throw new Error("plugin snapshot entry is missing or invalid");
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
