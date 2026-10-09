import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { PiRpc, splitRecords } from "../src/rpc.ts";

test("splitRecords keeps a partial record for the next chunk", () => {
	const first = splitRecords("", '{"a":1}\n{"b"');
	assert.deepEqual(first.lines, ['{"a":1}']);
	const second = splitRecords(first.rest, ":2}\n");
	assert.deepEqual(second.lines, ['{"b":2}']);
	assert.equal(second.rest, "");
});

test("splitRecords splits on LF only and strips a trailing CR", () => {
	const record = JSON.stringify({ text: "line separator inside" });
	const { lines } = splitRecords("", `${record}\r\n`);
	assert.deepEqual(lines, [record]);
});

test("malformed JSON fails RPC requests without throwing from the stdout event", async () => {
	const rpc = new PiRpc(spawn(process.execPath, ["-e", 'process.stdout.write("{bad}\\n"); setInterval(() => {}, 1000)']));
	const failure = await rpc.failure;
	assert.match(failure?.message ?? "", /invalid worker RPC JSON/);
	await rpc.terminate(50);
});

test("RPC requests time out and shutdown escalates when a worker ignores stdin", async () => {
	const rpc = new PiRpc(spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]), { closeGraceMs: 20 });
	await assert.rejects(rpc.request({ type: "prompt" }, 25), /timed out/);
	const started = Date.now();
	await rpc.close(20);
	assert.ok(Date.now() - started < 2_000);
});

test("spawn failure resolves the RPC exit state and rejects pending work", async () => {
	const rpc = new PiRpc(spawn("/definitely/not/a/real/command", []));
	await assert.rejects(rpc.request({ type: "prompt" }), /spawn|ENOENT/i);
	assert.equal(await rpc.exited, null);
});
