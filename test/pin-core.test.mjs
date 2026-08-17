/**
 * dsh-pin core logic tests (Node, zero dependencies): pin/unpin planning,
 * restore-anchor resolution, visibility, records persistence.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
	STORE_KEY,
	loadRecords,
	saveRecords,
	isSessionVisible,
	positionOf,
	workspaceOf,
	localOrderOf,
	restoreAnchor,
	planSessionPin,
	planWorkspacePin
} from "../lib/pin-core.mjs";

const WS_A = { workspaceId: "wsA", sessionIds: ["s1", "s2", "s3"] };
const WS_B = { workspaceId: "wsB", sessionIds: ["s4", "s5"] };
const WORKSPACES = [WS_A, WS_B];

function byId(overrides = {}) {
	const base = {
		s1: { id: "s1", blank: false, origin: undefined },
		s2: { id: "s2", blank: false, origin: undefined },
		s3: { id: "s3", blank: false, origin: undefined },
		s4: { id: "s4", blank: false, origin: undefined },
		s5: { id: "s5", blank: false, origin: undefined },
		blank1: { id: "blank1", blank: true, origin: undefined },
		sub1: { id: "sub1", blank: false, origin: "subagent" }
	};
	return new Map(Object.entries({ ...base, ...overrides }).map(([id, s]) => [id, s]));
}

function state({ workspaces = WORKSPACES, records = null, view = null } = {}) {
	return { workspaces, records: records ?? { sessions: {}, workspaces: {} }, view };
}

test("positionOf: neighbor anchors", () => {
	assert.deepEqual(positionOf(["s1", "s2", "s3"], "s2"), { before: "s1", after: "s3" });
	assert.deepEqual(positionOf(["s1", "s2", "s3"], "s1"), { before: null, after: "s2" });
	assert.deepEqual(positionOf(["s1", "s2", "s3"], "s3"), { before: "s2", after: null });
	assert.deepEqual(positionOf(["s1", "s2", "s3"], "zz"), { before: null, after: null });
});

test("isSessionVisible mirrors the sidebar rule", () => {
	const s = byId();
	const archived = new Set(["s3"]);
	assert.equal(isSessionVisible(s.get("s1"), "s2", archived), true);
	assert.equal(isSessionVisible(s.get("s3"), "s2", archived), false, "archived is hidden");
	assert.equal(isSessionVisible(s.get("sub1"), "s2", archived), false, "subagent hidden from groups");
	assert.equal(isSessionVisible(s.get("blank1"), "s2", archived), false, "blank hidden unless current");
	assert.equal(isSessionVisible(s.get("blank1"), "blank1", archived), true, "current blank (provisional New Session) visible");
});

test("workspaceOf finds the accounting workspace", () => {
	assert.equal(workspaceOf(WORKSPACES, "s5").workspaceId, "wsB");
	assert.equal(workspaceOf(WORKSPACES, "ghost"), null);
});

test("localOrderOf prefers the display account, falls back to the host account", () => {
	assert.deepEqual(localOrderOf(null, WS_A), ["s1", "s2", "s3"]);
	assert.deepEqual(localOrderOf({ sessionOrderByAccount: {} }, WS_A), ["s1", "s2", "s3"]);
	assert.deepEqual(localOrderOf({ sessionOrderByAccount: { wsA: ["s3", "s1", "s2"] } }, WS_A), ["s3", "s1", "s2"]);
	assert.deepEqual(localOrderOf({ sessionOrderByAccount: { wsA: [] } }, WS_A), ["s1", "s2", "s3"], "empty account falls back");
});

test("restoreAnchor: exact via after, fallback via before, else append", () => {
	assert.equal(restoreAnchor(["s1", "s2", "s3"], { before: "s1", after: "s3" }), "s3");
	assert.equal(restoreAnchor(["s1", "s2", "s3"], { before: "s1", after: "ghost" }), "s1");
	assert.equal(restoreAnchor(["s1", "s2", "s3"], { before: "ghost", after: "ghost" }), undefined);
	assert.equal(restoreAnchor(["s1", "s2", "s3"], { before: "s2", after: null }), undefined, "was last -> append");
	assert.equal(restoreAnchor(["s1", "s2", "s3"], null), undefined);
	assert.equal(restoreAnchor(null, { before: "s1", after: "s2" }), undefined);
});

test("planSessionPin local: pin remembers exact host + local positions", () => {
	const plan = planSessionPin(state({ view: { orderBy: "manual" } }), "local", "s3");
	assert.equal(plan.kind, "pin");
	assert.equal(plan.ws, "wsA");
	assert.equal(plan.hostAnchor, "s1", "host: insert before the first account entry");
	assert.equal(plan.wsAnchor, null);
	assert.deepEqual(plan.newLocalOrder, ["s3", "s1", "s2"]);
	assert.equal(plan.modeSwitch, false, "already manual");
	assert.deepEqual(plan.record, { kind: "local", ws: "wsA", hostBefore: "s2", hostAfter: null, localOrder: ["s1", "s2", "s3"], wsBefore: null, wsAfter: null });
});

test("planSessionPin local: updated mode switches to manual", () => {
	const plan = planSessionPin(state({ view: { orderBy: "updated" } }), "local", "s3");
	assert.equal(plan.kind, "pin");
	assert.equal(plan.modeSwitch, true);
});

test("planSessionPin: at local top without record -> move-end", () => {
	const plan = planSessionPin(state({ view: { orderBy: "manual" } }), "local", "s1");
	assert.equal(plan.kind, "move-end");
	assert.deepEqual(plan.newLocalOrder, ["s2", "s3", "s1"]);
});

test("planSessionPin: at local top with record -> unpin", () => {
	const rec = { kind: "local", ws: "wsA", hostBefore: null, hostAfter: "s2", localOrder: ["s1", "s2", "s3"], wsBefore: null, wsAfter: null };
	const plan = planSessionPin(state({ view: {}, records: { sessions: { s1: rec }, workspaces: {} } }), "local", "s1");
	assert.equal(plan.kind, "unpin");
	assert.equal(plan.restore, rec);
});

test("planSessionPin: ungrouped is unsupported", () => {
	const st = state({ workspaces: [{ workspaceId: "wsA", sessionIds: ["s2"] }] });
	assert.equal(planSessionPin(st, "local", "s1").kind, "unsupported");
});

test("planSessionPin top: workspace first + session to the front", () => {
	const plan = planSessionPin(state({ view: { orderBy: "manual" } }), "top", "s5");
	assert.equal(plan.kind, "pin");
	assert.equal(plan.wsAnchor, "wsA", "workspace goes before the first");
	assert.equal(plan.hostAnchor, "s4");
	assert.deepEqual(plan.newLocalOrder, ["s5", "s4"]);
	assert.deepEqual(plan.record, {
		kind: "top",
		ws: "wsB",
		hostBefore: "s4",
		hostAfter: null,
		localOrder: ["s4", "s5"],
		wsBefore: "wsA",
		wsAfter: null
	});
});

test("planSessionPin top: no workspace move when already first", () => {
	const plan = planSessionPin(state({ view: {} }), "top", "s2");
	assert.equal(plan.kind, "pin");
	assert.equal(plan.wsAnchor, null);
	assert.deepEqual(plan.record.wsBefore, null);
	assert.deepEqual(plan.record.wsAfter, "wsB");
});

test("planSessionPin top: at the very top with record -> unpin", () => {
	const rec = {
		kind: "top",
		ws: "wsA",
		hostBefore: null,
		hostAfter: "s2",
		localOrder: ["s1", "s2", "s3"],
		wsBefore: "wsB",
		wsAfter: null
	};
	const plan = planSessionPin(state({ view: {}, records: { sessions: { s1: rec }, workspaces: {} } }), "top", "s1");
	assert.equal(plan.kind, "unpin");
	assert.equal(plan.restore, rec);
});

test("planSessionPin top: at the very top without record -> move-end", () => {
	const plan = planSessionPin(state({ view: {} }), "top", "s1");
	assert.equal(plan.kind, "move-end");
});

test("planWorkspacePin: pin / unpin / noop", () => {
	const pin = planWorkspacePin(state(), "wsB");
	assert.equal(pin.kind, "pin");
	assert.equal(pin.before, "wsA");
	assert.deepEqual(pin.record, { before: "wsA", after: null });
	assert.equal(planWorkspacePin(state(), "wsA").kind, "noop");
	const st = state({ records: { sessions: {}, workspaces: { wsA: { before: "wsB", after: null } } } });
	assert.deepEqual(planWorkspacePin(st, "wsA"), { kind: "unpin", restore: { before: "wsB", after: null } });
	assert.equal(planWorkspacePin(state(), "ghost").kind, "unsupported");
});

test("round-trip local: pin then un-pin restores the exact host + local order", () => {
	const host = ["s1", "s2", "s3"];
	const recs = { sessions: {}, workspaces: {} };
	const st = () => state({
		workspaces: [{ workspaceId: "wsA", sessionIds: [...host] }],
		records: recs,
		view: { orderBy: "manual", sessionOrderByAccount: { wsA: [...host] } }
	});
	const pin = planSessionPin(st(), "local", "s3");
	assert.equal(pin.kind, "pin");
	recs.sessions.s3 = pin.record;
	// apply: host insertBefore(s3, s1)
	host.splice(host.indexOf("s3"), 1);
	host.splice(host.indexOf(pin.hostAnchor), 0, "s3");
	assert.deepEqual(host, ["s3", "s1", "s2"]);
	const unpin = planSessionPin(st(), "local", "s3");
	assert.equal(unpin.kind, "unpin");
	const anchor = restoreAnchor(host, unpin.restore);
	host.splice(host.indexOf("s3"), 1);
	if (anchor) host.splice(host.indexOf(anchor), 0, "s3");
	else host.push("s3");
	delete recs.sessions.s3;
	assert.deepEqual(host, ["s1", "s2", "s3"], "s3 restored to its exact original index");
});

test("round-trip top: workspace + session both restored", () => {
	const wsOrder = ["wsA", "wsB"];
	const hostB = ["s4", "s5"];
	const recs = { sessions: {}, workspaces: {} };
	const st = () => state({
		workspaces: wsOrder.map((id) => (id === "wsA" ? { workspaceId: "wsA", sessionIds: ["s1", "s2"] } : { workspaceId: "wsB", sessionIds: [...hostB] })),
		records: recs,
		view: { orderBy: "manual", sessionOrderByAccount: { wsB: [...hostB] } }
	});
	const pin = planSessionPin(st(), "top", "s5");
	assert.equal(pin.kind, "pin");
	recs.sessions.s5 = pin.record;
	// apply: session to front of wsB, then wsB to the front
	hostB.splice(hostB.indexOf("s5"), 1);
	hostB.splice(hostB.indexOf(pin.hostAnchor), 0, "s5");
	wsOrder.splice(wsOrder.indexOf("wsB"), 1);
	wsOrder.splice(wsOrder.indexOf(pin.wsAnchor), 0, "wsB");
	assert.deepEqual(wsOrder, ["wsB", "wsA"]);
	assert.deepEqual(hostB, ["s5", "s4"]);
	const unpin = planSessionPin(st(), "top", "s5");
	assert.equal(unpin.kind, "unpin");
	const r = unpin.restore;
	// restore session in wsB
	hostB.splice(hostB.indexOf("s5"), 1);
	const a1 = restoreAnchor(hostB, { before: r.hostBefore, after: r.hostAfter });
	if (a1) hostB.splice(hostB.indexOf(a1), 0, "s5");
	else hostB.push("s5");
	// restore workspace
	wsOrder.splice(wsOrder.indexOf("wsB"), 1);
	const a2 = restoreAnchor(wsOrder, { before: r.wsBefore, after: r.wsAfter });
	if (a2) wsOrder.splice(wsOrder.indexOf(a2), 0, "wsB");
	else wsOrder.push("wsB");
	delete recs.sessions.s5;
	assert.deepEqual(hostB, ["s4", "s5"]);
	assert.deepEqual(wsOrder, ["wsA", "wsB"]);
});

test("records round-trip through storage with validation", () => {
	const mem = (() => {
		const m = new Map();
		return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
	})();
	assert.deepEqual(loadRecords(mem), { sessions: {}, workspaces: {} });
	const rec = {
		sessions: {
			s1: {
				kind: "top",
				ws: "wsA",
				hostBefore: null,
				hostAfter: "s2",
				localOrder: ["s1", "s2", "s3"],
				wsBefore: "wsB",
				wsAfter: null
			}
		},
		workspaces: { wsA: { before: "wsB", after: null } }
	};
	saveRecords(mem, rec);
	assert.deepEqual(loadRecords(mem), rec);
	assert.equal(STORE_KEY, "dsh-pin.records.v3");
	mem.setItem(STORE_KEY, "{corrupt json");
	assert.deepEqual(loadRecords(mem), { sessions: {}, workspaces: {} }, "corrupt store degrades to empty");
	mem.setItem(STORE_KEY, JSON.stringify({ sessions: { s1: { kind: "bogus" } }, workspaces: { wsA: { before: 42 } } }));
	assert.deepEqual(loadRecords(mem), { sessions: {}, workspaces: {} }, "invalid records dropped");
});
