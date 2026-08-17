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
 * originally (`hostAfter`); the preceding element (`hostBefore`) is only a
 * fallback. `after: null` means "the item was last" (restore = append).
 *
 * Records (persisted by the browser half in localStorage):
 * {
 *   sessions: { [sessionId]: {
 *     kind: "local" | "top",
 *     ws: workspaceId,
 *     hostBefore: sessionId | null,
 *     hostAfter: sessionId | null,
 *     localOrder: sessionId[] | null,     // the display order before pinning
 *     wsBefore: workspaceId | null,       // "top" pins only
 *     wsAfter: workspaceId | null
 *   } },
 *   workspaces: { [workspaceId]: { before: workspaceId | null, after: workspaceId | null } }
 * }
 *
 * @module dsh-pin/pin-core
 */

/** localStorage key of the persisted pin records (bumped per schema change). */
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

function isSessionRecord(rec) {
	if (rec === null || typeof rec !== "object") return false;
	if (rec.kind !== "local" && rec.kind !== "top") return false;
	if (typeof rec.ws !== "string") return false;
	if (rec.hostBefore !== null && rec.hostBefore !== undefined && typeof rec.hostBefore !== "string") return false;
	if (rec.hostAfter !== null && rec.hostAfter !== undefined && typeof rec.hostAfter !== "string") return false;
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
 * Plan a session pin click ("pin to the top of this workspace" or "pin to
 * the very top of the whole list").
 * @param state - { workspaces, records, view } (view: the app's view-store state).
 * @param kind - "local" | "top".
 * @returns one of:
 *  - { kind: "unsupported" }                     ungrouped (no accounting workspace)
 *  - { kind: "pin", ws, hostAnchor, wsAnchor, newLocalOrder, modeSwitch, record }
 *  - { kind: "unpin", restore }                  remember-and-restore
 *  - { kind: "move-end", newLocalOrder }         at the top without a record
 */
export function planSessionPin(state, kind, sessionId) {
	const { workspaces, records, view } = state;
	const ws = workspaceOf(workspaces, sessionId);
	if (!ws) return { kind: "unsupported" };
	const firstWsId = workspaces.length > 0 ? workspaces[0].workspaceId : undefined;
	const order = localOrderOf(view, ws);
	const atLocalTop = order.length > 0 && order[0] === sessionId;
	const atVeryTop = kind === "top" && firstWsId === ws.workspaceId && atLocalTop;
	const rec = (records.sessions ?? {})[sessionId];

	if ((kind === "top" && !atVeryTop) || (kind === "local" && !atLocalTop)) {
		const hostAnchor = ws.sessionIds.find((id) => id !== sessionId) ?? null;
		const wsAnchor = kind === "top" && firstWsId !== undefined && firstWsId !== ws.workspaceId ? firstWsId : null;
		const pos = positionOf(ws.sessionIds, sessionId);
		const wsPos = positionOf(workspaces.map((w) => w.workspaceId), ws.workspaceId);
		return {
			kind: "pin",
			ws: ws.workspaceId,
			hostAnchor,
			wsAnchor,
			newLocalOrder: [sessionId, ...order.filter((x) => x !== sessionId)],
			modeSwitch: (view && view.orderBy ? view.orderBy : "updated") !== "manual",
			record: {
				kind,
				ws: ws.workspaceId,
				hostBefore: pos.before,
				hostAfter: pos.after,
				localOrder: order,
				wsBefore: kind === "top" ? wsPos.before : null,
				wsAfter: kind === "top" ? wsPos.after : null
			}
		};
	}
	if (rec) return { kind: "unpin", restore: rec };
	return { kind: "move-end", newLocalOrder: [...order.filter((x) => x !== sessionId), sessionId] };
}

/**
 * Plan a workspace-header "pin this workspace to the top" click (durable
 * registry display order; independent of the session sort mode).
 * @returns one of:
 *  - { kind: "unsupported" }
 *  - { kind: "pin", before, record }      insertBefore(wid, before)
 *  - { kind: "unpin", restore }           restore remembered position
 *  - { kind: "noop" }                     already first, no record
 */
export function planWorkspacePin(state, workspaceId) {
	const { workspaces, records } = state;
	const ids = workspaces.map((w) => w.workspaceId);
	const i = ids.indexOf(workspaceId);
	if (i < 0) return { kind: "unsupported" };
	if (i === 0) {
		const rec = (records.workspaces ?? {})[workspaceId];
		return rec ? { kind: "unpin", restore: rec } : { kind: "noop" };
	}
	return { kind: "pin", before: ids[0], record: positionOf(ids, workspaceId) };
}
