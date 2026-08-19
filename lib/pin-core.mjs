/**
 * dsh-pin core: pure pin bookkeeping for the DSH sidebar session list.
 *
 * No DOM, no host APIs, no timers — every decision is computed from plain
 * snapshot data so the logic is unit-testable in Node and gets inlined
 * verbatim into the browser bundle by scripts/build-client.mjs (keep the
 * syntax plain: `export function` / `export const` only, no imports).
 *
 * The app renders each workspace group's sessions in a browser-local display
 * order (the workspace view store's `sessionOrderByAccount`), which is
 * initialized from the host's durable session account but is otherwise
 * sticky; in the default "updated" sort mode activity promotion applies.
 * The host's `insertSessionBefore` is DOM-insertBefore semantics:
 * `insertBefore(X, A)` places X AT A's position. To put X back at its
 * original index, X must be inserted before the element that FOLLOWED X
 * originally (`after`); the preceding element (`before`) is only a fallback.
 *
 * Two pin levels:
 * - "local": pin a session to the top of ITS workspace (host + display
 *   reorder; the mode is switched to "manual" so the position is visible).
 *   Multiple local pins stack at the workspace top in most-recently-pinned
 *   order; unpinning re-inserts ONLY that session into the CURRENT order at
 *   its remembered slot, so it can never disturb the other pins. When the
 *   last local pin is removed the sort mode is restored.
 * - "top": pin a session ABOVE ALL WORKSPACES. A display-level pin: the row
 *   is lifted into a pinned tray rendered above every workspace group (its
 *   in-group row is hidden by CSS). No host order or display order is
 *   touched at all — un-pin is a plain record removal and the row reappears
 *   exactly where it was. Records are per-browser (localStorage); the DSH
 *   host has no global-pins concept. Ungrouped sessions can be top-pinned
 *   too (there is no workspace to move).
 *
 * Records (persisted by the browser half in localStorage; the store key is
 * kept at v3 and the record shape is forward/backward compatible — v3
 * records carry `localOrder` instead of `localBefore`/`localAfter`, and
 * `localRestorePos` derives the slot from it):
 * {
 *   sessions: { [sessionId]:
 *     | { kind: "local", ws: workspaceId,
 *         hostBefore: sessionId | null,    // durable account at pin time
 *         hostAfter: sessionId | null,
 *         localBefore: sessionId | null,   // display account at pin time
 *         localAfter: sessionId | null,
 *         localOrder: sessionId[] | null,  // legacy (v3): display order snapshot
 *         prevOrderBy: string | null }     // view sort mode at pin time
 *     | { kind: "top", ws: workspaceId | null, pinnedAt?: number } },
 *   workspaces: { [workspaceId]: { before: workspaceId | null, after: workspaceId | null } }
 * }
 *
 * @module dsh-pin/pin-core
 */

/** localStorage key of the persisted pin records (kept at v3: records stay compatible). */
export const STORE_KEY = "dsh-pin.records.v3";

/**
 * Read and validate persisted records. Any corruption degrades to an empty
 * store — pinning must never take the sidebar down.
 * @param storage - a localStorage-like object (getItem/setItem).
 * @returns a validated, owned records object.
 */
export function loadRecords(storage) {
	const empty = { sessions: {}, workspaces: {} };
	try {
		const raw = storage.getItem(STORE_KEY);
		if (raw === null || raw === undefined) return empty;
		const parsed = JSON.parse(raw);
		if (parsed === null || typeof parsed !== "object") return empty;
		const records = { sessions: {}, workspaces: {} };
		for (const [sid, rec] of Object.entries(parsed.sessions ?? {})) {
			if (!isSessionRecord(rec)) continue;
			records.sessions[sid] = rec;
		}
		for (const [wid, rec] of Object.entries(parsed.workspaces ?? {})) {
			if (!isPosition(rec)) continue;
			records.workspaces[wid] = rec;
		}
		return records;
	} catch {
		return empty;
	}
}

/** Persist records; storage failures are swallowed (pinning still works for the session). */
export function saveRecords(storage, records) {
	try {
		storage.setItem(STORE_KEY, JSON.stringify(records));
	} catch {
		/* private mode / quota — non-fatal */
	}
}

/** { before, after } position pair (each string or null). */
function isPosition(p) {
	return p !== null && typeof p === "object" &&
		(p.before === null || typeof p.before === "string") &&
		(p.after === null || typeof p.after === "string");
}

function isNullableString(v) {
	return v === null || v === undefined || typeof v === "string";
}

function isSessionRecord(rec) {
	if (rec === null || typeof rec !== "object") return false;
	if (rec.kind === "top") {
		if (typeof rec.ws !== "string" && rec.ws !== null) return false;
		if (rec.pinnedAt !== undefined && typeof rec.pinnedAt !== "number") return false;
		return true;
	}
	if (rec.kind !== "local") return false;
	if (typeof rec.ws !== "string") return false;
	if (!isNullableString(rec.hostBefore) || !isNullableString(rec.hostAfter)) return false;
	if (!isNullableString(rec.localBefore) || !isNullableString(rec.localAfter)) return false;
	if (!isNullableString(rec.prevOrderBy)) return false;
	if (rec.localOrder !== null && rec.localOrder !== undefined && !Array.isArray(rec.localOrder)) return false;
	return true;
}

/**
 * Sidebar visibility rule (mirrors the workspace browser): subagent
 * children render under their parent's catalog, archived sessions render
 * nowhere, blank sessions render only while selected.
 * @param summary - { id, blank, origin }.
 * @param currentId - selected session id.
 * @param archived - archive set.
 * @returns whether the row renders.
 */
export function isSessionVisible(summary, currentId, archived) {
	if (!summary || typeof summary.id !== "string") return false;
	if (summary.origin === "subagent") return false;
	if (archived && archived.has && archived.has(summary.id)) return false;
	return !summary.blank || summary.id === currentId;
}

/** The workspace whose session account contains the session. @returns item or null (ungrouped). */
export function workspaceOf(workspaces, sessionId) {
	if (!Array.isArray(workspaces)) return null;
	for (const ws of workspaces) {
		if (ws && Array.isArray(ws.sessionIds) && ws.sessionIds.includes(sessionId)) return ws;
	}
	return null;
}

/**
 * The exact position of `id` in a manual order list as neighbor anchors.
 * @returns { before: id|null, after: id|null } — null = absent boundary.
 */
export function positionOf(ids, id) {
	if (!Array.isArray(ids)) return { before: null, after: null };
	const i = ids.indexOf(id);
	if (i < 0) return { before: null, after: null };
	return {
		before: i > 0 ? ids[i - 1] : null,
		after: i < ids.length - 1 ? ids[i + 1] : null
	};
}

/**
 * The displayed session order of one workspace: the browser-local display
 * account when present, else the host's durable account.
 * @param view - the workspace view store state (or null while unreadable).
 * @param ws - workspace item.
 * @returns a fresh array of session ids in display order.
 */
export function localOrderOf(view, ws) {
	const stored = view && view.sessionOrderByAccount ? view.sessionOrderByAccount[ws.workspaceId] : undefined;
	return Array.isArray(stored) && stored.length > 0 ? [...stored] : [...ws.sessionIds];
}

/**
 * Resolve the insert-before anchor that restores a remembered position:
 * prefer the element that FOLLOWED the item originally (exact restore),
 * fall back to the preceding element (one slot earlier), else append.
 * @param ids - the current order list.
 * @param rec - { before, after } (nulls allowed) or null.
 * @returns the anchor id, or undefined (= append to the end).
 */
export function restoreAnchor(ids, rec) {
	if (!Array.isArray(ids) || !rec) return undefined;
	if (rec.after !== null && rec.after !== undefined) {
		if (ids.includes(rec.after)) return rec.after;
		return rec.before !== null && rec.before !== undefined && ids.includes(rec.before) ? rec.before : undefined;
	}
	// The item was last in its list: the exact restore is an append.
	return undefined;
}

/**
 * Re-insert `id` into the CURRENT order list at its remembered slot (pure,
 * multi-pin safe: only this id moves). This operates on the whole display
 * array (the browser `setSessionOrder`), not the host's insertBefore, so the
 * PRECEDING neighbour is the primary anchor: pinning other sessions moves
 * them to the front, so a remembered follower may itself sit at the top and
 * "insert before it" would wrongly yank the item to the front; the preceding
 * neighbour (unless it too was pinned) still marks the item's home slot.
 * Fallback = before the remembered follower; if neither anchor survives, a
 * leading original goes to the front and everything else appends.
 * @param ids - the current order list (may or may not contain id).
 * @param id - the id to (re)insert.
 * @param before - remembered preceding id (null = item was first).
 * @param after - remembered following id (null = item was last).
 * @returns a fresh array with id restored.
 */
export function restoreInList(ids, id, before, after) {
	const rest = (Array.isArray(ids) ? ids : []).filter((x) => x !== id);
	let i;
	if (before !== null && before !== undefined && rest.includes(before)) i = rest.indexOf(before) + 1;
	else if (after !== null && after !== undefined && rest.includes(after)) i = rest.indexOf(after);
	else i = before === null || before === undefined ? 0 : rest.length;
	rest.splice(i, 0, id);
	return rest;
}

/**
 * The display-order slot a pin record remembers, tolerating legacy v3
 * records that stored a full `localOrder` snapshot instead of neighbor
 * anchors.
 * @param rec - a session pin record (or null).
 * @param sessionId - the session the record belongs to.
 * @returns { before: id|null, after: id|null }.
 */
export function localRestorePos(rec, sessionId) {
	if (!rec) return { before: null, after: null };
	if (rec.localBefore !== undefined || rec.localAfter !== undefined) {
		return { before: rec.localBefore ?? null, after: rec.localAfter ?? null };
	}
	if (Array.isArray(rec.localOrder)) return positionOf(rec.localOrder, sessionId);
	return { before: null, after: null };
}

/**
 * Plan a session pin click ("pin to the top of this workspace" or "pin
 * above all workspaces").
 *
 * Record-based toggle: a session with a record of the clicked kind unpins
 * (local: re-inserted into the CURRENT order at its remembered slot; top:
 * the record is simply removed and the row reappears in place). Re-pinning
 * with the other scope replaces the record.
 *
 * @param state - { workspaces, records, view } (view: the app's view-store state).
 * @param kind - "local" | "top".
 * @returns one of:
 *  - { kind: "unsupported" }                     local pin of an ungrouped session
 *  - { kind: "pin", scope: "top", record }       display pin into the global tray
 *  - { kind: "pin", scope: "local", ws, hostAnchor, newLocalOrder, modeSwitch, record }
 *  - { kind: "unpin", scope: "top", restore }
 *  - { kind: "unpin", scope: "local", restore, newLocalOrder, restoreOrderBy }
 */
export function planSessionPin(state, kind, sessionId) {
	const { workspaces, records, view } = state;
	const ws = workspaceOf(workspaces, sessionId);
	const rec = (records.sessions ?? {})[sessionId];

	// "top" pin: a display-level pin into the tray above all workspace
	// groups. No order is touched at all (works for ungrouped sessions too).
	if (kind === "top") {
		if (rec && rec.kind === "top") return { kind: "unpin", scope: "top", restore: rec };
		return { kind: "pin", scope: "top", record: { kind: "top", ws: ws ? ws.workspaceId : null } };
	}

	// "local" pin: needs an accounting workspace (ungrouped has no manual order)
	if (!ws) return { kind: "unsupported" };
	const order = localOrderOf(view, ws);
	const atLocalTop = order.length > 0 && order[0] === sessionId;

	if (rec && rec.kind === "local") {
		const pos = localRestorePos(rec, sessionId);
		const remaining = Object.entries(records.sessions ?? {})
			.filter(([sid, r]) => sid !== sessionId && r && r.kind === "local").length;
		const restoreOrderBy =
			remaining === 0 && rec.prevOrderBy && rec.prevOrderBy !== "manual" ? rec.prevOrderBy : null;
		return {
			kind: "unpin",
			scope: "local",
			restore: rec,
			newLocalOrder: restoreInList(order, sessionId, pos.before, pos.after),
			restoreOrderBy
		};
	}

	// pin (or re-pin with the other scope: the old record is simply replaced).
	// A session already at the local top pins in place — the click is a mark,
	// never a surprise move.
	const posHost = positionOf(ws.sessionIds, sessionId);
	const posLocal = positionOf(order, sessionId);
	return {
		kind: "pin",
		scope: "local",
		ws: ws.workspaceId,
		hostAnchor: atLocalTop ? null : ws.sessionIds.find((id) => id !== sessionId) ?? null,
		newLocalOrder: atLocalTop ? [...order] : [sessionId, ...order.filter((x) => x !== sessionId)],
		modeSwitch: (view && view.orderBy ? view.orderBy : "updated") !== "manual",
		record: {
			kind: "local",
			ws: ws.workspaceId,
			hostBefore: posHost.before,
			hostAfter: posHost.after,
			localBefore: posLocal.before,
			localAfter: posLocal.after,
			localOrder: order,
			prevOrderBy: view && view.orderBy ? view.orderBy : "updated"
		}
	};
}
