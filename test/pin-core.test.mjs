/**
 * dsh-pin core logic tests (Node, zero dependencies): pin/unpin planning,
 * multi-pin stacks, restore-position resolution, visibility, records
 * persistence.
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
	restoreInList,
	localRestorePos,
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

test("restoreInList: predecessor first, follower fallback, boundary + stale anchors", () => {
	assert.deepEqual(restoreInList(["s1", "s2", "s3"], "s3", "s2", null), ["s1", "s2", "s3"], "was last -> back after predecessor");
	assert.deepEqual(restoreInList(["s3", "s1", "s2"], "s3", null, "s1"), ["s3", "s1", "s2"], "was first -> front");
	assert.deepEqual(restoreInList(["s5", "s3", "s1", "s4"], "s3", "s1", "s5"), ["s5", "s1", "s3", "s4"], "predecessor wins even if the follower was pinned to the top");
	assert.deepEqual(restoreInList(["s5", "s4", "s3"], "s3", "gone", "s4"), ["s5", "s3", "s4"], "predecessor missing -> before follower");
	assert.deepEqual(restoreInList(["s2", "s3"], "s1", null, "gone"), ["s1", "s2", "s3"], "no anchors, was first -> front");
	assert.deepEqual(restoreInList(["s1", "s2"], "s3", "gone", "gone"), ["s1", "s2", "s3"], "no anchors, not first -> append");
	assert.deepEqual(restoreInList(["s1", "s2", "s3"], "s9", "s1", "s2"), ["s1", "s9", "s2", "s3"], "id absent -> still inserted at its slot");
	assert.deepEqual(restoreInList(null, "s1", "s2", "s3"), ["s1"], "non-list input degrades");
});

test("localRestorePos: v4 anchors, legacy v3 localOrder fallback, absent", () => {
	assert.deepEqual(localRestorePos({ localBefore: "a", localAfter: "b" }, "x"), { before: "a", after: "b" });
	assert.deepEqual(localRestorePos({ localBefore: null, localAfter: "b" }, "x"), { before: null, after: "b" });
	assert.deepEqual(localRestorePos({ localOrder: ["a", "x", "b"] }, "x"), { before: "a", after: "b" }, "legacy full order");
	assert.deepEqual(localRestorePos({ localOrder: ["x", "a", "b"] }, "x"), { before: null, after: "a" }, "legacy, was first");
	assert.deepEqual(localRestorePos({}, "x"), { before: null, after: null }, "no anchors at all");
	assert.deepEqual(localRestorePos(null, "x"), { before: null, after: null });
});

test("planSessionPin local: pin remembers exact host + local positions", () => {
	const plan = planSessionPin(state({ view: { orderBy: "manual" } }), "local", "s3");
	assert.equal(plan.kind, "pin");
	assert.equal(plan.scope, "local");
	assert.equal(plan.ws, "wsA");
	assert.equal(plan.hostAnchor, "s1", "host: insert before the first account entry");
	assert.deepEqual(plan.newLocalOrder, ["s3", "s1", "s2"]);
	assert.equal(plan.modeSwitch, false, "already manual");
	assert.deepEqual(plan.record, {
		kind: "local",
		ws: "wsA",
		hostBefore: "s2",
		hostAfter: null,
		localBefore: "s2",
		localAfter: null,
		localOrder: ["s1", "s2", "s3"],
		prevOrderBy: "manual"
	});
});

test("planSessionPin local: updated mode switches to manual and remembers it", () => {
	const plan = planSessionPin(state({ view: { orderBy: "updated" } }), "local", "s3");
	assert.equal(plan.kind, "pin");
	assert.equal(plan.modeSwitch, true);
	assert.equal(plan.record.prevOrderBy, "updated");
});

test("planSessionPin: at the top without a record -> pin in place (no move-end)", () => {
	const plan = planSessionPin(state({ view: { orderBy: "manual" } }), "local", "s1");
	assert.equal(plan.kind, "pin");
	assert.deepEqual(plan.newLocalOrder, ["s1", "s2", "s3"], "already first: no visible move");
	assert.equal(plan.record.localBefore, null);
	assert.equal(plan.record.localAfter, "s2");
});

test("planSessionPin: recorded session anywhere -> unpin (multi-pin: not only the top)", () => {
	const rec = {
		kind: "local",
		ws: "wsA",
		hostBefore: "s1",
		hostAfter: null,
		localBefore: "s1",
		localAfter: null,
		localOrder: ["s3", "s1", "s2"],
		prevOrderBy: "manual",
		wsBefore: null,
		wsAfter: null
	};
	const st = state({
		workspaces: [{ workspaceId: "wsA", sessionIds: ["s3", "s1", "s2"] }],
		records: { sessions: { s2: rec }, workspaces: {} },
		view: { orderBy: "manual", sessionOrderByAccount: { wsA: ["s3", "s1", "s2"] } }
	});
	const plan = planSessionPin(st, "local", "s2");
	assert.equal(plan.kind, "unpin");
	assert.equal(plan.restore, rec);
	assert.deepEqual(plan.newLocalOrder, ["s3", "s1", "s2"], "re-insert at its remembered slot");
	assert.equal(plan.restoreOrderBy, null, "manual was the pre-pin mode: nothing to restore");
});

test("planSessionPin: unpin of the last pin restores the previous sort mode", () => {
	const rec = {
		kind: "local",
		ws: "wsA",
		hostBefore: "s2",
		hostAfter: null,
		localBefore: "s2",
		localAfter: null,
		localOrder: ["s1", "s2", "s3"],
		prevOrderBy: "updated",
		wsBefore: null,
		wsAfter: null
	};
	const st = state({
		records: { sessions: { s3: rec }, workspaces: {} },
		view: { orderBy: "manual" }
	});
	const plan = planSessionPin(st, "local", "s3");
	assert.equal(plan.kind, "unpin");
	assert.equal(plan.restoreOrderBy, "updated");
});

test("planSessionPin: unpin with other pins left keeps manual mode", () => {
	const mk = (sid, before, after) => ({
		kind: "local", ws: "wsA", hostBefore: before, hostAfter: after,
		localBefore: before, localAfter: after, localOrder: null, prevOrderBy: "updated",
		wsBefore: null, wsAfter: null
	});
	const st = state({
		records: { sessions: { s3: mk("s3", "s2", null), s2: mk("s2", "s1", null) }, workspaces: {} },
		view: { orderBy: "manual" }
	});
	const plan = planSessionPin(st, "local", "s3");
	assert.equal(plan.kind, "unpin");
	assert.equal(plan.restoreOrderBy, null, "s2 still pinned: stay manual");
});

test("planSessionPin: clicking the other scope re-pins and replaces the record", () => {
	const rec = {
		kind: "local",
		ws: "wsA",
		hostBefore: null,
		hostAfter: "s2",
		localBefore: null,
		localAfter: "s2",
		localOrder: ["s1", "s2", "s3"],
		prevOrderBy: "manual"
	};
	const st = state({
		records: { sessions: { s1: rec }, workspaces: {} },
		view: { orderBy: "manual" }
	});
	const plan = planSessionPin(st, "top", "s1");
	assert.equal(plan.kind, "pin", "kind mismatch is a re-pin, not an unpin");
	assert.equal(plan.scope, "top");
	assert.deepEqual(plan.record, { kind: "top", ws: "wsA" }, "top pin is display-level: no anchors");
});

test("planSessionPin: ungrouped is unsupported", () => {
	const st = state({ workspaces: [{ workspaceId: "wsA", sessionIds: ["s2"] }] });
	assert.equal(planSessionPin(st, "local", "s1").kind, "unsupported");
});

test("planSessionPin top: display pin into the global tray, no order touched", () => {
	const plan = planSessionPin(state({ view: { orderBy: "manual" } }), "top", "s5");
	assert.equal(plan.kind, "pin");
	assert.equal(plan.scope, "top");
	assert.equal(plan.hostAnchor, undefined, "no host reorder");
	assert.equal(plan.wsAnchor, undefined, "no workspace reorder");
	assert.equal(plan.newLocalOrder, undefined, "no display reorder");
	assert.equal(plan.modeSwitch, undefined, "no sort-mode switch");
	assert.deepEqual(plan.record, { kind: "top", ws: "wsB" });
});

test("planSessionPin top: ungrouped sessions can be top-pinned", () => {
	const st = state({ workspaces: [{ workspaceId: "wsA", sessionIds: ["s2"] }] });
	const plan = planSessionPin(st, "top", "s1");
	assert.equal(plan.kind, "pin");
	assert.equal(plan.scope, "top");
	assert.deepEqual(plan.record, { kind: "top", ws: null }, "no accounting workspace");
});

test("planSessionPin top: recorded session unpins regardless of position", () => {
	const rec = { kind: "top", ws: "wsB", pinnedAt: 123 };
	const st = state({
		workspaces: [
			{ workspaceId: "wsB", sessionIds: ["s4", "s5"] },
			{ workspaceId: "wsA", sessionIds: ["s1", "s2"] }
		],
		records: { sessions: { s5: rec }, workspaces: {} },
		view: { orderBy: "manual", sessionOrderByAccount: { wsB: ["s4", "s5"] } }
	});
	const plan = planSessionPin(st, "top", "s5");
	assert.equal(plan.kind, "unpin");
	assert.equal(plan.scope, "top");
	assert.equal(plan.restore, rec);
	assert.equal(plan.newLocalOrder, undefined, "unpin restores nothing — orders were never touched");
});

test("planWorkspacePin: pin / in-place pin / unpin / unsupported", () => {
	const pin = planWorkspacePin(state(), "wsB");
	assert.equal(pin.kind, "pin");
	assert.equal(pin.before, "wsA");
	assert.deepEqual(pin.record, { before: "wsA", after: null });
	const inPlace = planWorkspacePin(state(), "wsA");
	assert.equal(inPlace.kind, "pin");
	assert.equal(inPlace.before, null, "already first: record without a move");
	assert.deepEqual(inPlace.record, { before: null, after: "wsB" });
	const st = state({ records: { sessions: {}, workspaces: { wsA: { before: "wsB", after: null } } } });
	assert.deepEqual(planWorkspacePin(st, "wsA"), { kind: "unpin", restore: { before: "wsB", after: null } });
	const st2 = state({
		workspaces: [
			{ workspaceId: "wsC", sessionIds: ["s9"] },
			{ workspaceId: "wsB", sessionIds: ["s4"] },
			{ workspaceId: "wsA", sessionIds: ["s1"] }
		],
		records: { sessions: {}, workspaces: { wsB: { before: "wsA", after: null } } }
	});
	assert.equal(planWorkspacePin(st2, "wsB").kind, "unpin", "recorded workspace unpins even when not first");
	assert.equal(planWorkspacePin(state(), "ghost").kind, "unsupported");
});

test("round-trip local: pin then unpin restores the exact host + local order", () => {
	const host = ["s1", "s2", "s3"];
	const local = ["s1", "s2", "s3"];
	const recs = { sessions: {}, workspaces: {} };
	const st = () => state({
		workspaces: [{ workspaceId: "wsA", sessionIds: [...host] }],
		records: recs,
		view: { orderBy: "manual", sessionOrderByAccount: { wsA: [...local] } }
	});
	const pin = planSessionPin(st(), "local", "s3");
	assert.equal(pin.kind, "pin");
	recs.sessions.s3 = pin.record;
	// apply: host insertBefore(s3, s1); local: s3 to the front
	host.splice(host.indexOf("s3"), 1);
	host.splice(host.indexOf(pin.hostAnchor), 0, "s3");
	local.splice(local.indexOf("s3"), 1);
	local.splice(0, 0, "s3");
	assert.deepEqual(host, ["s3", "s1", "s2"]);
	assert.deepEqual(local, ["s3", "s1", "s2"]);
	const unpin = planSessionPin(st(), "local", "s3");
	assert.equal(unpin.kind, "unpin");
	const anchor = restoreAnchor(host, unpin.restore);
	host.splice(host.indexOf("s3"), 1);
	if (anchor) host.splice(host.indexOf(anchor), 0, "s3");
	else host.push("s3");
	// client applies the display order as a whole-array set
	local.splice(0, local.length, ...unpin.newLocalOrder);
	delete recs.sessions.s3;
	assert.deepEqual(host, ["s1", "s2", "s3"], "s3 restored to its exact original index");
	assert.deepEqual(local, ["s1", "s2", "s3"], "display order restored exactly");
});

test("round-trip multi-pin: two pins stay pinned; unpinning one restores it without disturbing the other", () => {
	const host = ["s1", "s2", "s3"];
	const local = ["s1", "s2", "s3"];
	const recs = { sessions: {}, workspaces: {} };
	const st = () => state({
		workspaces: [{ workspaceId: "wsA", sessionIds: [...host] }],
		records: recs,
		view: { orderBy: "manual", sessionOrderByAccount: { wsA: [...local] } }
	});
	const p1 = planSessionPin(st(), "local", "s3");
	recs.sessions.s3 = p1.record;
	host.splice(host.indexOf("s3"), 1);
	host.splice(host.indexOf(p1.hostAnchor), 0, "s3");
	local.splice(local.indexOf("s3"), 1);
	local.splice(0, 0, "s3");
	assert.deepEqual(local, ["s3", "s1", "s2"]);

	const p2 = planSessionPin(st(), "local", "s2");
	assert.equal(p2.kind, "pin");
	recs.sessions.s2 = p2.record;
	host.splice(host.indexOf("s2"), 1);
	host.splice(host.indexOf(p2.hostAnchor), 0, "s2");
	local.splice(local.indexOf("s2"), 1);
	local.splice(0, 0, "s2");
	assert.deepEqual(local, ["s2", "s3", "s1"], "newest pin on top");
	assert.equal(recs.sessions.s3 !== undefined && recs.sessions.s2 !== undefined, true, "both records kept");

	const u = planSessionPin(st(), "local", "s2");
	assert.equal(u.kind, "unpin");
	const anchor = restoreAnchor(host, u.restore);
	host.splice(host.indexOf("s2"), 1);
	if (anchor) host.splice(host.indexOf(anchor), 0, "s2");
	else host.push("s2");
	local.splice(0, local.length, ...u.newLocalOrder);
	delete recs.sessions.s2;
	assert.deepEqual(local, ["s3", "s1", "s2"], "s2 back to its pre-pin slot; s3 keeps its top slot");
	assert.equal(recs.sessions.s3 !== undefined, true, "s3's pin untouched");
});

test("round-trip top: pure display pin — no order changes at all", () => {
	const host = ["s4", "s5"];
	const wsOrder = ["wsA", "wsB"];
	const recs = { sessions: {}, workspaces: {} };
	const st = () => state({
		workspaces: wsOrder.map((id) => (id === "wsA" ? { workspaceId: "wsA", sessionIds: ["s1", "s2"] } : { workspaceId: "wsB", sessionIds: [...host] })),
		records: recs,
		view: { orderBy: "updated", sessionOrderByAccount: { wsB: [...host] } }
	});
	const pin = planSessionPin(st(), "top", "s5");
	assert.equal(pin.kind, "pin");
	assert.equal(pin.scope, "top");
	recs.sessions.s5 = pin.record;
	// no RPC / order changes to apply — the tray + hidden row are display only
	assert.deepEqual(host, ["s4", "s5"], "host account untouched");
	assert.deepEqual(wsOrder, ["wsA", "wsB"], "workspace order untouched");
	assert.deepEqual(st().view.sessionOrderByAccount.wsB, ["s4", "s5"], "display order untouched");

	const unpin = planSessionPin(st(), "top", "s5");
	assert.equal(unpin.kind, "unpin");
	assert.equal(unpin.scope, "top");
	delete recs.sessions.s5;
	assert.deepEqual(host, ["s4", "s5"]);
	assert.deepEqual(wsOrder, ["wsA", "wsB"]);
});

test("top pin stack: several sessions pin above all workspaces; unpin removes one only", () => {
	const recs = { sessions: {}, workspaces: {} };
	const st = () => state({
		workspaces: [{ workspaceId: "wsA", sessionIds: ["s1", "s2"] }],
		records: recs,
		view: { orderBy: "updated" }
	});
	recs.sessions.s1 = planSessionPin(st(), "top", "s1").record;
	recs.sessions.s2 = planSessionPin(st(), "top", "s2").record;
	assert.deepEqual(Object.keys(recs.sessions).sort(), ["s1", "s2"], "both pinned at once");
	// unpinning s1 leaves s2 pinned
	assert.equal(planSessionPin(st(), "top", "s1").kind, "unpin");
	delete recs.sessions.s1;
	assert.equal(recs.sessions.s2 !== undefined, true, "s2's pin untouched");
	assert.equal(planSessionPin(st(), "top", "s2").kind, "unpin", "s2 still toggleable");
});

test("legacy v3 record (localOrder only) still unpins to its original slot", () => {
	const rec = {
		kind: "local",
		ws: "wsA",
		hostBefore: "s2",
		hostAfter: null,
		localOrder: ["s1", "s2", "s3"],
		wsBefore: null,
		wsAfter: null
	};
	const st = state({
		workspaces: [{ workspaceId: "wsA", sessionIds: ["s3", "s1", "s2"] }],
		records: { sessions: { s3: rec }, workspaces: {} },
		view: { orderBy: "manual", sessionOrderByAccount: { wsA: ["s3", "s1", "s2"] } }
	});
	const plan = planSessionPin(st, "local", "s3");
	assert.equal(plan.kind, "unpin");
	assert.deepEqual(plan.newLocalOrder, ["s1", "s2", "s3"], "slot derived from the legacy snapshot");
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
				localBefore: null,
				localAfter: "s2",
				localOrder: ["s1", "s2", "s3"],
				prevOrderBy: "updated",
				wsBefore: "wsB",
				wsAfter: null
			},
			s2: {
				kind: "local",
				ws: "wsA",
				hostBefore: "s1",
				hostAfter: null,
				localOrder: ["s1", "s2", "s3"]
			}
		},
		workspaces: { wsA: { before: "wsB", after: null } }
	};
	saveRecords(mem, rec);
	assert.deepEqual(loadRecords(mem), rec, "v4 + legacy v3 records both survive the round trip");
	assert.equal(STORE_KEY, "dsh-pin.records.v3");
	mem.setItem(STORE_KEY, "{corrupt json");
	assert.deepEqual(loadRecords(mem), { sessions: {}, workspaces: {} }, "corrupt store degrades to empty");
	mem.setItem(STORE_KEY, JSON.stringify({
		sessions: {
			s1: { kind: "bogus" },
			s2: { kind: "local", ws: "wsA", hostBefore: 42 },
			s3: { kind: "local", ws: "wsA", localOrder: "not-an-array" }
		},
		workspaces: { wsA: { before: 42 } }
	}));
	assert.deepEqual(loadRecords(mem), { sessions: {}, workspaces: {} }, "invalid records dropped");
});
