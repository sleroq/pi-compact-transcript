import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { harness, lines, row, tagTheme } from "./helpers.ts";

const config = { type: "custom", customType: "compact-transcript-config", data: { toolGrouping: "turn" } };
function message(id: string, role: string, content: unknown = []) {
	return { type: "message", id, message: { role, content } };
}
function call(id: string, name = "read") {
	return { type: "toolCall", id, name, arguments: {} };
}
const failure = { isError: true, content: [{ type: "text", text: "failed" }] };

test("live turns group different tools and failures across commentary and retries", async () => {
	const h = harness({ theme: tagTheme });
	h.setBranch([config]);
	await h.startSession();
	await h.emit("message_start", { message: { role: "user" } });
	await h.emit("agent_start");
	try {
		const a = await h.start("a", "read");
		await h.finish("a", failure);
		await h.assistantText();
		await h.emit("agent_end");
		await h.emit("agent_start");
		const b = h.component("b", "bash", {});
		await h.emit("tool_execution_start", { toolCallId: "b", toolName: "bash", args: {} });
		assert.deepEqual(lines(a), []);
		assert.match(row(b), /<error>[◆◇] <\/error><dim>2 tool calls · 1 failed<\/dim>/);
		await h.finish("b");
		assert.equal(h.renderSummary({ reads: 1 }), undefined);
		for (const c of [a, b]) c.setExpanded(true);
		assert.ok(lines(a).length > 0 && lines(b).length > 0);
		for (const c of [a, b]) c.setExpanded(false);
		assert.deepEqual(lines(a), []);
		assert.match(row(b), /2 tool calls/);
		await h.emit("agent_settled");
		await h.emit("agent_start");
		const c = await h.start("c", "grep");
		await h.finish("c");
		assert.match(row(c), /1 tool call/);
		assert.match(row(b), /2 tool calls/);
	} finally { await h.emit("session_shutdown"); }
});

test("history uses user and custom message boundaries, including on tree navigation", async () => {
	const h = harness();
	const branch = [config, message("u1", "user"), message("m1", "assistant", [call("a")]),
		message("m2", "assistant", [call("b", "bash")]), message("u2", "custom"),
		message("m3", "assistant", [call("c")]),
		{ type: "custom", customType: "compact-transcript-activity", data: { toolCallId: "a", status: "Checked files" } }];
	h.setBranch(branch);
	await h.startSession("resume");
	try {
		const a = h.restore("a", "read", {}, failure);
		const b = h.restore("b", "bash");
		const c = h.restore("c", "read");
		assert.deepEqual(lines(a), []);
		assert.equal(row(b), "◆ 2 tool calls · Checked files · 1 failed");
		assert.equal(row(c), "◆ 1 tool call");
		h.setBranch(branch.slice(0, 3));
		await h.emit("session_tree");
		assert.equal(row(h.restore("a", "read")), "◆ 1 tool call");
	} finally { await h.emit("session_shutdown"); }
});

test("live and final activity requests include only reasoning text exposed alongside tool calls", async () => {
	const h = harness();
	const requests: string[] = [];
	Object.assign(h.ctx, {
		modelRegistry: {
			find: () => ({ id: "test" }),
			streamSimple(_model: { id: string }, context: { messages: { content: string }[] }) {
				requests.push(context.messages[0].content);
				return { result: async () => ({ stopReason: "stop", content: [{ type: "text", text: "Checked files" }] }) };
			},
		},
	});
	h.setBranch([{ ...config, data: { ...config.data, activitySummary: true } }]);
	await h.startSession();
	await h.emit("agent_start");
	try {
		await h.emit("message_end", { message: { role: "assistant", content: [
			{ type: "thinking", thinking: "Inspect config first", thinkingSignature: "private signature" },
			{ type: "thinking", thinking: "redacted thinking", redacted: true },
			call("a"),
		] } });
		await h.start("a", "read");
		await h.finish("a");
		await h.emit("message_end", { message: { role: "assistant", content: [
			{ type: "thinking", thinking: "Check defaults next" },
			{ type: "text", text: "Not reasoning" },
			...Array.from({ length: 4 }, (_, i) => call(`b${i}`)),
		] } });
		for (let i = 0; i < 4; i++) {
			await h.start(`b${i}`, "read");
			await h.finish(`b${i}`);
		}
		await h.emit("agent_settled");
		await setImmediate();

		assert.deepEqual(requests.map((payload) => {
			const { phase, reasoning } = JSON.parse(payload);
			return { phase, reasoning };
		}), [
			{ phase: "live", reasoning: ["Inspect config first", "Check defaults next"] },
			{ phase: "finished", reasoning: ["Inspect config first", "Check defaults next"] },
		]);
		assert.doesNotMatch(requests.join("\n"), /private signature|redacted thinking|Not reasoning/);
	} finally { await h.emit("session_shutdown"); }
});

