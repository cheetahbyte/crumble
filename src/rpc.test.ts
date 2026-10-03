import assert from "node:assert/strict";
import { test } from "node:test";
import { splitRecords } from "./rpc.ts";

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
