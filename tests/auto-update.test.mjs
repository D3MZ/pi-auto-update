import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import autoUpdate from "../extensions/auto-update.ts";

async function harness(t) {
	const agent = await mkdtemp(path.join(tmpdir(), "auto-update-hook-"));
	await writeFile(path.join(agent, "settings.json"), '{"packages":[]}');
	const original = { PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, PI_OFFLINE: process.env.PI_OFFLINE,
		PI_AUTO_UPDATE: process.env.PI_AUTO_UPDATE };
	process.env.PI_CODING_AGENT_DIR = agent;
	delete process.env.PI_OFFLINE; delete process.env.PI_AUTO_UPDATE;
	t.after(async () => {
		for (const [key, value] of Object.entries(original)) {
			if (value === undefined) delete process.env[key]; else process.env[key] = value;
		}
		await rm(agent, { recursive: true, force: true });
	});
	const handlers = new Map(), commands = new Map(), notifications = [], entries = [], statuses = [];
	autoUpdate({
		on: (name, handler) => handlers.set(name, handler), registerCommand: (name, command) => commands.set(name, command),
		appendEntry: (...args) => entries.push(args),
		exec: () => { throw new Error("Unconditional Pi updates must never be invoked"); },
	});
	const ctx = { cwd: "/untrusted/project", hasUI: true, ui: {
		notify: (...args) => notifications.push(args), setStatus: (...args) => statuses.push(args),
	} };
	return { agent, handlers, commands, notifications, entries, statuses, ctx };
}

test("startup safely completes without unconditional updater commands", async (t) => {
	const h = await harness(t);
	await h.handlers.get("session_start")({ reason: "startup" }, h.ctx);
	assert.match(h.notifications.at(-1)[0], /security update completed/);
	assert.ok(h.entries.some(([name]) => name === "auto-update-security-report"));
	assert.deepEqual(h.statuses.at(-1), ["pi-auto-update", undefined]);
});

test("replacement events and duplicate startup notifications do not rerun updates", async (t) => {
	const h = await harness(t);
	for (const reason of ["reload", "new", "resume", "fork", "startup", "startup"]) {
		await h.handlers.get("session_start")({ reason }, h.ctx);
	}
	assert.equal(h.notifications.length, 1);
});

test("offline means no network even for the manual command", async (t) => {
	const h = await harness(t); process.env.PI_OFFLINE = "1";
	await h.handlers.get("session_start")({ reason: "startup" }, h.ctx);
	assert.match(h.notifications.at(-1)[0], /skipped: offline/);
	await h.commands.get("auto-update-now").handler("", h.ctx);
	assert.match(h.notifications.at(-1)[0], /blocked: offline/);
	assert.equal(h.entries.length, 0);
});

test("manual invocation overrides automatic disable but never bypasses the gate", async (t) => {
	const h = await harness(t); process.env.PI_AUTO_UPDATE = "0";
	await h.handlers.get("session_start")({ reason: "startup" }, h.ctx);
	assert.match(h.notifications.at(-1)[0], /disabled/);
	await h.commands.get("auto-update-now").handler("", h.ctx);
	assert.match(h.notifications.at(-1)[0], /completed/);
});

test("manual concurrent checks are coalesced and shutdown is safe", async (t) => {
	const h = await harness(t);
	await Promise.all([h.commands.get("auto-update-now").handler("", h.ctx), h.commands.get("auto-update-now").handler("", h.ctx)]);
	assert.equal(h.entries.filter(([name]) => name === "auto-update-security-report").length, 1);
	await h.handlers.get("session_shutdown")({}, h.ctx);
});

test("failures are reported without aborting startup", async (t) => {
	const h = await harness(t);
	await writeFile(path.join(h.agent, "settings.json"), "malformed json");
	await h.handlers.get("session_start")({ reason: "startup" }, h.ctx);
	assert.match(h.notifications.at(-1)[0], /blocked:/);
	assert.equal(h.notifications.at(-1)[1], "warning");
});
