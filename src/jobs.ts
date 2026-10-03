import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

export type JobStatus = "running" | "waiting" | "done" | "failed";

export interface Job {
	id: string;
	project: string;
	brief: string;
	status: JobStatus;
	question: string | null;
	summary: string | null;
	error: string | null;
	createdAt: number;
	updatedAt: number;
}

export type JobPatch = Partial<Pick<Job, "status" | "question" | "summary" | "error">>;

interface JobRow {
	id: string;
	project: string;
	brief: string;
	status: string;
	question: string | null;
	summary: string | null;
	error: string | null;
	created_at: number;
	updated_at: number;
}

const STATUSES: readonly string[] = ["running", "waiting", "done", "failed"];

function toJob(row: JobRow): Job {
	if (!STATUSES.includes(row.status)) throw new Error(`Job ${row.id} has unknown status ${row.status}`);
	return {
		id: row.id,
		project: row.project,
		brief: row.brief,
		status: row.status as JobStatus,
		question: row.question,
		summary: row.summary,
		error: row.error,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

export class JobStore {
	private db: DatabaseSync;

	constructor(path: string) {
		this.db = new DatabaseSync(path);
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS jobs (
				id TEXT PRIMARY KEY,
				project TEXT NOT NULL,
				brief TEXT NOT NULL,
				status TEXT NOT NULL,
				question TEXT,
				summary TEXT,
				error TEXT,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			)
		`);
	}

	create(project: string, brief: string): Job {
		const id = randomUUID().slice(0, 8);
		const now = Date.now();
		this.db
			.prepare("INSERT INTO jobs (id, project, brief, status, created_at, updated_at) VALUES (?, ?, ?, 'running', ?, ?)")
			.run(id, project, brief, now, now);
		return this.require(id);
	}

	get(id: string): Job | undefined {
		const row = this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as JobRow | undefined;
		return row ? toJob(row) : undefined;
	}

	require(id: string): Job {
		const job = this.get(id);
		if (!job) throw new Error(`No job with id ${id}`);
		return job;
	}

	list(): Job[] {
		const rows = this.db.prepare("SELECT * FROM jobs ORDER BY created_at DESC").all() as unknown as JobRow[];
		return rows.map(toJob);
	}

	update(id: string, patch: JobPatch): Job {
		const current = this.require(id);
		const next = { ...current, ...patch };
		this.db
			.prepare("UPDATE jobs SET status = ?, question = ?, summary = ?, error = ?, updated_at = ? WHERE id = ?")
			.run(next.status, next.question, next.summary, next.error, Date.now(), id);
		return this.require(id);
	}

	close(): void {
		this.db.close();
	}
}
