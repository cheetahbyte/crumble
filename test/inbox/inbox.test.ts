import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Inbox } from "#inbox";
import { MemoryStore } from "#memory";
import { openDatabase } from "#db/database";

function withInbox(run: (inbox: Inbox) => void): void {
	const directory = mkdtempSync(join(tmpdir(), "crumble-state-"));
	const stateDb = openDatabase(join(directory, "assistant.db"), "assistant");
	try {
		run(new Inbox(stateDb));
	} finally {
		stateDb.close();
		rmSync(directory, { recursive: true, force: true });
	}
}

test("inbox deduplicates stable IDs and recovers processing requests without replay", () => {
	withInbox((inbox) => {
		assert.equal(inbox.enqueue({ id: "discord:42", text: "do work", source: "discord" }), true);
		assert.equal(inbox.enqueue({ id: "discord:42", text: "duplicate", source: "discord" }), false);
		assert.equal(inbox.nextPending()?.text, "do work");
		assert.equal(inbox.markProcessing("discord:42"), true);
		assert.equal(inbox.markProcessing("discord:42"), false);
		const recovered = inbox.recoverInterrupted();
		assert.equal(recovered.length, 1);
		assert.equal(recovered[0]?.status, "failed");
		assert.match(recovered[0]?.response ?? "", /not replayed automatically/);
		assert.equal(inbox.nextPending(), undefined);
		assert.deepEqual(inbox.pendingDeliveries(), [{
			id: "discord:42",
			response: "Request was interrupted when the application stopped. It was not replayed automatically.",
			source: "discord",
			status: "failed",
		}]);
	});
});

test("inbox claims and outbox deliveries preserve insertion order for equal timestamps", () => {
	const originalNow = Date.now;
	Date.now = () => 1_700_000_000_000;
	try {
		withInbox((inbox) => {
			for (const id of ["z", "y", "x"]) {
				assert.equal(inbox.enqueue({ id, text: `request ${id}`, source: "internal" }), true);
			}

			const claimed: string[] = [];
			for (let i = 0; i < 3; i++) {
				const request = inbox.nextPending();
				assert.ok(request);
				claimed.push(request.id);
				assert.equal(inbox.markProcessing(request.id), true);
				assert.equal(inbox.complete(request.id, `response ${request.id}`), true);
			}

			assert.deepEqual(claimed, ["z", "y", "x"]);
			assert.deepEqual(inbox.pendingDeliveries().map(({ id }) => id), ["z", "y", "x"]);
		});
	} finally {
		Date.now = originalNow;
	}
});

test("completed output is durable until acknowledged", () => {
	const directory = mkdtempSync(join(tmpdir(), "crumble-outbox-"));
	const path = join(directory, "assistant.db");
	let stateDb = openDatabase(path, "assistant");
	let inbox = new Inbox(stateDb);
	try {
		inbox.enqueue({ id: "terminal:1", text: "hello", source: "terminal" });
		inbox.markProcessing("terminal:1");
		assert.equal(inbox.complete("terminal:1", "hello back"), true);
		stateDb.close();
		stateDb = openDatabase(path, "assistant");
		inbox = new Inbox(stateDb);
		assert.deepEqual(inbox.pendingDeliveries(), [{ id: "terminal:1", response: "hello back", source: "terminal", status: "completed" }]);
		assert.equal(inbox.acknowledgeDelivery("terminal:1"), true);
		assert.equal(inbox.acknowledgeDelivery("terminal:1"), false);
		assert.deepEqual(inbox.pendingDeliveries(), []);
	} finally {
		stateDb.close();
		rmSync(directory, { recursive: true, force: true });
	}
});

test("parent and worker connections share a single atomic claim and durable delivery", () => {
	const directory = mkdtempSync(join(tmpdir(), "crumble-shared-state-"));
	const path = join(directory, "assistant.db");
	const parentDb = openDatabase(path, "assistant");
	const parent = new Inbox(parentDb);
	const workerDb = openDatabase(path, "assistant");
	const worker = new Inbox(workerDb);
	try {
		assert.equal(parent.enqueue({ id: "discord:shared", text: "handle this", source: "discord" }), true);
		assert.equal(parent.nextPending()?.id, "discord:shared");
		assert.equal(worker.nextPending()?.id, "discord:shared");
		assert.equal(worker.markProcessing("discord:shared"), true);
		assert.equal(parent.markProcessing("discord:shared"), false);

		new MemoryStore(workerDb).set("learned", "kept in the same tenant");
		assert.equal(new MemoryStore(parentDb).get("learned"), "kept in the same tenant");
		const longResponse = "x".repeat(50_000);
		assert.equal(worker.complete("discord:shared", longResponse), true);
		assert.equal(parent.pendingDeliveries()[0]?.response.length, longResponse.length);
		assert.equal(parent.acknowledgeDelivery("discord:shared"), true);
		assert.deepEqual(worker.pendingDeliveries(), []);
	} finally {
		parentDb.close();
		workerDb.close();
		rmSync(directory, { recursive: true, force: true });
	}
});
