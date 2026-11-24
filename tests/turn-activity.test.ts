import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { createTurnActivity } from "../extensions/turn-activity.ts";

test("activity refreshes after five calls, backs off during bursts, and refreshes again at finish", async (t) => {
	t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
	const requests: Array<{ completed: number; final: boolean; recent: readonly string[] }> = [];
	const published: Array<[string, boolean]> = [];
	const activity = createTurnActivity(async (snapshot) => {
		requests.push(snapshot);
		return snapshot.final ? "Finished checking\nfiles" : "Checking files";
	}, (line, final) => published.push([line, final]));
	function completeCall(i: number) {
		const call = { toolCallId: `parent/${i}`, toolName: "read" };
		const args = { path: "/private/project/index.ts", content: "secret" };
		activity.start({ ...call, args });
		activity.complete({ ...call, isError: false });
	}

	for (let i = 0; i < 4; i++) completeCall(i);
	assert.equal(requests.length, 0);
	completeCall(4);
	await setImmediate();
	assert.deepEqual(requests[0].recent, Array(5).fill("read index.ts"));
	assert.deepEqual(published, [["Checking files", false]]);

	for (let i = 5; i < 19; i++) completeCall(i);
	t.mock.timers.tick(14_999);
	assert.equal(requests.length, 1);
	t.mock.timers.tick(1);
	await setImmediate();
	assert.equal(requests[1].completed, 19);

	activity.finish();
	await setImmediate();
	assert.deepEqual(requests.map(({ completed, final }) => [completed, final]), [[5, false], [19, false], [19, true]]);
	assert.deepEqual(published.at(-1), ["Finished checking files", true]);
});

test("finishing waits for the in-flight request without publishing stale live text", async () => {
	const live = Promise.withResolvers<string>();
	const requests: boolean[] = [];
	const published: string[] = [];
	const activity = createTurnActivity(async ({ final }) => {
		requests.push(final);
		return final ? "Checked files" : live.promise;
	}, (line) => published.push(line));

	for (let i = 0; i < 5; i++) activity.complete({ toolName: "read", toolCallId: `call-${i}`, isError: false });
	activity.finish();
	assert.deepEqual(requests, [false]);
	live.resolve("Checking files");
	await setImmediate();
	assert.deepEqual(requests, [false, true]);
	assert.deepEqual(published, ["Checked files"]);
});

test("a failed model call leaves the count alone, and cancellation suppresses late results", async () => {
	const published: string[] = [];
	const fail = createTurnActivity(async () => {
		throw new Error("provider unavailable");
	}, (line) => published.push(line));
	const pending = Promise.withResolvers<string>();
	const cancel = createTurnActivity(() => pending.promise, (line) => published.push(line));
	const call = { toolCallId: "a", toolName: "read", isError: false };

	fail.complete(call);
	fail.finish();
	cancel.complete(call);
	cancel.finish();
	cancel.cancel();
	pending.resolve("Too late");
	await setImmediate();
	assert.deepEqual(published, []);
});
