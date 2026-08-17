window.__ModuleLoader__.load({
	id: "dsh-pin",
	factory: () => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

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
const STORE_KEY = "dsh-pin.records.v3";

/**
 * Read and validate persisted records. Any corruption degrades to an empty
 * store — pinning must never take the sidebar down.
 * @param storage - a localStorage-like object (getItem/setItem).
 * @returns a validated, owned records object.
 */
function loadRecords(storage) {
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
function saveRecords(storage, records) {
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
function isSessionVisible(summary, currentId, archived) {
	if (!summary || typeof summary.id !== "string") return false;
	if (summary.origin === "subagent") return false;
	if (archived && archived.has && archived.has(summary.id)) return false;
	return !summary.blank || summary.id === currentId;
}

/** The workspace whose session account contains the session. @returns item or null (ungrouped). */
function workspaceOf(workspaces, sessionId) {
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
function positionOf(ids, id) {
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
function localOrderOf(view, ws) {
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
function restoreAnchor(ids, rec) {
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
function planSessionPin(state, kind, sessionId) {
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
function planWorkspacePin(state, workspaceId) {
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


		//#region styles
		const CSS = `
.dsh-pin-btn{cursor:pointer;width:20px;height:20px;flex:none;display:inline-flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-tertiary,#8b929c);background:transparent;border:none;border-radius:4px;padding:0;transition:color .12s ease,background .12s ease}
.dsh-pin-btn:hover{color:var(--dsw-alias-label-primary,#17191c);background:var(--dsw-alias-interactive-bg-hover,#eef1f4)}
.dsh-pin-btn[data-pressed="true"],.dsh-pin-btn[data-pressed="true"]:hover{color:var(--dsw-alias-brand-primary,#1677ff)}
.dsh-pin-btn[data-feedback="ok"]{color:#2aa86f}
.dsh-pin-btn[data-feedback="err"]{color:var(--dsw-alias-state-error-primary,#d4380d)}
.dsh-pin-btn[data-feedback="noop"]{color:var(--dsw-alias-brand-primary,#1677ff)}
.dsh-pin-indicator{width:16px;height:20px;flex:none;display:inline-flex;align-items:center;justify-content:center;color:var(--dsw-alias-brand-primary,#1677ff)}
`;
		//#endregion

		//#region icons (plain DOM, no React)
		const SVG_NS = "http://www.w3.org/2000/svg";
		function makeSvg(paths, size) {
			const el = document.createElementNS(SVG_NS, "svg");
			el.setAttribute("width", String(size));
			el.setAttribute("height", String(size));
			el.setAttribute("viewBox", "0 0 24 24");
			el.setAttribute("fill", "none");
			el.setAttribute("stroke", "currentColor");
			el.setAttribute("stroke-width", "1.8");
			el.setAttribute("stroke-linecap", "round");
			el.setAttribute("stroke-linejoin", "round");
			el.setAttribute("aria-hidden", "true");
			for (const d of paths) {
				const p = document.createElementNS(SVG_NS, "path");
				p.setAttribute("d", d);
				el.appendChild(p);
			}
			return el;
		}
		const ICON_PIN = [
			"M12 17v5",
			"M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1z"
		];
		const ICON_TOP = ["m17 11-5-5-5 5", "m17 18-5-5-5 5"];
		//#endregion

		//#region react-fiber introspection (row identity + view-store actions)
		/** The React fiber attached to a DOM node (works for the shell's React instance). */
		function reactFiber(el) {
			for (const k of Object.keys(el)) if (k.startsWith("__reactFiber$")) return el[k];
			return null;
		}
		/** Walk up the fiber tree to the nearest component whose props satisfy pred. */
		function rowProps(el, pred, depth = 24) {
			let fiber = reactFiber(el);
			for (let i = 0; fiber && i < depth; i++) {
				const props = fiber.memoizedProps;
				if (props && pred(props)) return props;
				fiber = fiber.return;
			}
			return null;
		}
		const isSessionProps = (p) => p !== null && typeof p === "object" && p.node && typeof p.node === "object" && typeof p.node.id === "string" && typeof p.node.updatedAt === "number";
		const isWorkspaceProps = (p) => p !== null && typeof p === "object" && p.group && typeof p.group === "object" && typeof p.group.workspaceId === "string";
		/** The workspace browser's view-store actions (setSessionOrder/setOrderBy) via its slot props. */
		const isViewActionsProps = (p) => p !== null && typeof p === "object" && p.actions && typeof p.actions.setSessionOrder === "function" && typeof p.actions.setOrderBy === "function";
		//#endregion

		const inject = ["workspaces", "sessions"];

		//#region browser half
		function apply(ctx) {
			const api = ctx.workspaces;
			const sessionsApi = ctx.sessions;
			if (typeof api?.insertSessionBefore !== "function" || typeof api?.insertBefore !== "function") {
				console.error("[dsh-pin] workspaces service unavailable; plugin inactive");
				return;
			}
			const ZH = /zh/i.test(document.documentElement.lang || navigator.language || "");
			const T = {
				local: ZH ? "置顶到本工作区(再点一次取消置顶)" : "Pin to top of this workspace (click again to unpin)",
				top: ZH ? "置顶到列表最上面(再点一次取消置顶)" : "Pin to the very top of the list (click again to unpin)",
				ws: ZH ? "将工作区置顶到最上面(再点一次取消置顶)" : "Pin this workspace to the top (click again to unpin)",
				pinned: ZH ? "已置顶" : "Pinned"
			};

			// ---- style tag ----
			const style = document.createElement("style");
			style.dataset.plugin = "dsh-pin";
			style.textContent = CSS;
			document.head.appendChild(style);

			// ---- persisted pin records + live list state ----
			const records = loadRecords(window.localStorage);
			const wsListFeed = api.list;
			const sessListFeed = sessionsApi?.list;
			const safeGet = (feed) => { try { return feed?.getSnapshot?.() ?? null; } catch { return null; } };
			let wsSnap = safeGet(wsListFeed);
			let sessSnap = safeGet(sessListFeed);
			const subs = [];
			for (const feed of [wsListFeed, sessListFeed]) {
				if (feed && typeof feed.subscribe === "function") {
					try { subs.push(feed.subscribe(() => { wsSnap = safeGet(wsListFeed); sessSnap = safeGet(sessListFeed); scheduleSync(); })); } catch { /* non-fatal */ }
				}
			}

			function currentState() {
				const ws = wsSnap ?? safeGet(wsListFeed);
				const sess = sessSnap ?? safeGet(sessListFeed);
				if (!ws || !sess) return null;
				const bySessionId = new Map();
				for (const [id, s] of Object.entries(sess.byId ?? {})) bySessionId.set(id, { id, blank: s.blank, origin: s.origin });
				return {
					workspaces: ws.items ?? [],
					bySessionId,
					currentId: sess.current,
					archived: new Set(ws.archivedSessionIds ?? []),
					records
				};
			}

			// ---- the app's workspace-view store (display order + sort mode) ----
			// Persisted synchronously to localStorage on every change; the store
			// actions are reached through the workspace browser's slot props.
			const VIEW_STORE_KEY = "dsh.workspace.view.v5";
			function readViewState() {
				try {
					const raw = window.localStorage.getItem(VIEW_STORE_KEY);
					const view = raw ? JSON.parse(raw) : null;
					if (view && typeof view === "object") return view;
				} catch { /* non-fatal */ }
				return null;
			}
			function viewActions(row) {
				const props = rowProps(row, isViewActionsProps);
				return props ? props.actions : null;
			}

			function setSessionRecord(sessionId, rec) { records.sessions[sessionId] = rec; saveRecords(window.localStorage, records); }
			function clearSessionRecord(sessionId) { delete records.sessions[sessionId]; saveRecords(window.localStorage, records); }
			function setWorkspaceRecord(workspaceId, rec) { records.workspaces[workspaceId] = rec; saveRecords(window.localStorage, records); }
			function clearWorkspaceRecord(workspaceId) { delete records.workspaces[workspaceId]; saveRecords(window.localStorage, records); }
			function restoreAnchor(ids, rec) {
				if (!Array.isArray(ids)) return undefined;
				if (rec && rec.after !== null && rec.after !== undefined && ids.includes(rec.after)) return rec.after;
				if (rec && rec.before !== null && rec.before !== undefined && ids.includes(rec.before)) return rec.before;
				return undefined;
			}

			// ---- DOM injection ----
			const injected = new WeakMap(); // session row -> { btnLocal, btnTop, indicator }
			const wsInjected = new WeakMap(); // workspace row -> { btnWs }

			function makeButton(kind, label, icon, onActivate) {
				const btn = document.createElement("button");
				btn.type = "button";
				btn.className = "dsh-pin-btn";
				btn.dataset.dshPin = kind;
				btn.dataset.kind = kind;
				btn.dataset.pressed = "false";
				btn.title = label;
				btn.setAttribute("aria-label", label);
				btn.appendChild(icon);
				btn.addEventListener("click", (e) => {
					e.stopPropagation();
					e.preventDefault();
					onActivate(btn);
				});
				return btn;
			}
			function flash(btn, kind) {
				if (!btn) return;
				btn.dataset.feedback = kind;
				clearTimeout(btn._dshPinT);
				btn._dshPinT = setTimeout(() => { delete btn.dataset.feedback; }, 900);
			}
			function buttonOf(row, kind) {
				return row.querySelector(`[data-dsh-pin="${kind}"]`);
			}
			function removeInjected(row) {
				for (const sel of ["[data-dsh-pin='sess-local']", "[data-dsh-pin='sess-top']", "[data-dsh-pin='indicator']"]) {
					row.querySelector(sel)?.remove();
				}
			}

			function updateIndicator(row, inj, show) {
				if (show && !inj.indicator?.isConnected) {
					const el = document.createElement("span");
					el.className = "dsh-pin-indicator";
					el.dataset.dshPin = "indicator";
					el.title = T.pinned;
					el.setAttribute("aria-hidden", "true");
					el.appendChild(makeSvg(ICON_PIN, 12));
					row.insertBefore(el, row.firstChild);
					inj.indicator = el;
				} else if (!show && inj.indicator) {
					inj.indicator.remove();
					inj.indicator = null;
				}
			}

			// ---- session pin actions (host account + local display order) ----
			async function onSessionPin(kind, row) {
				const btn = buttonOf(row, kind);
				const st = currentState();
				const props = rowProps(row, isSessionProps);
				if (!st || !props) return;
				const sessionId = props.node.id;
				const view = readViewState();
				const plan = planSessionPin({ workspaces: st.workspaces, records: st.records, view }, kind === "sess-top" ? "top" : "local", sessionId);
				try {
					if (plan.kind === "unsupported") { flash(btn, "noop"); return; }
					const actions = viewActions(row);
					if (plan.kind === "pin") {
						await api.insertSessionBefore(plan.ws, sessionId, plan.hostAnchor ?? undefined);
						if (plan.wsAnchor) await api.insertBefore(plan.ws, plan.wsAnchor);
						if (actions) {
							actions.setSessionOrder(plan.ws, plan.newLocalOrder);
							if (plan.modeSwitch) actions.setOrderBy("manual");
						}
						setSessionRecord(sessionId, plan.record);
						flash(btn, "ok");
						return;
					}
					if (plan.kind === "unpin") {
						const r = plan.restore;
						const owner = workspaceOf(st.workspaces, sessionId);
						const hostAnchor = restoreAnchor(owner ? owner.sessionIds : [], { before: r.hostBefore, after: r.hostAfter });
						await api.insertSessionBefore(r.ws, sessionId, hostAnchor ?? undefined);
						if (r.wsBefore !== null || r.wsAfter !== null) {
							const wsAnchor = restoreAnchor(st.workspaces.map((w) => w.workspaceId), { before: r.wsBefore, after: r.wsAfter });
							await api.insertBefore(r.ws, wsAnchor ?? undefined);
						}
						if (actions && Array.isArray(r.localOrder)) actions.setSessionOrder(r.ws, r.localOrder);
						clearSessionRecord(sessionId);
						flash(btn, "ok");
						return;
					}
					// move-end: at the top without a record (plain toggle off)
					const ws = workspaceOf(st.workspaces, sessionId);
					await api.insertSessionBefore(ws.workspaceId, sessionId, undefined);
					if (actions) actions.setSessionOrder(ws.workspaceId, plan.newLocalOrder);
					flash(btn, "ok");
				} catch (error) {
					console.error("[dsh-pin] pin action failed:", error);
					flash(btn, "err");
				}
			}

			// ---- workspace pin (durable registry display order, mode-independent) ----
			async function onWorkspacePin(row) {
				const btn = buttonOf(row, "ws-top");
				const st = currentState();
				const props = rowProps(row, isWorkspaceProps);
				if (!st || !props || !btn) return;
				const workspaceId = props.group.workspaceId;
				const plan = planWorkspacePin(st, workspaceId);
				try {
					if (plan.kind === "unsupported" || plan.kind === "noop") { flash(btn, "noop"); return; }
					if (plan.kind === "pin") {
						await api.insertBefore(workspaceId, plan.before ?? undefined);
						setWorkspaceRecord(workspaceId, plan.record);
						flash(btn, "ok");
						return;
					}
					if (plan.kind === "unpin") {
						const anchor = restoreAnchor(st.workspaces.map((w) => w.workspaceId), plan.restore);
						await api.insertBefore(workspaceId, anchor);
						clearWorkspaceRecord(workspaceId);
						flash(btn, "ok");
						return;
					}
					flash(btn, "noop");
				} catch (error) {
					console.error("[dsh-pin] workspace pin failed:", error);
					flash(btn, "err");
				}
			}

			function decorateSessionRow(row, st) {
				const props = rowProps(row, isSessionProps);
				if (!props) return;
				const node = props.node;
				const ws = node.blank ? null : workspaceOf(st.workspaces, node.id);
				const anchor = row.querySelector("button[aria-label]");
				if (!ws || !anchor) { removeInjected(row); return; }
				const container = anchor.parentElement;
				let inj = injected.get(row);
				if (!inj || !inj.btnLocal?.isConnected || !inj.btnTop?.isConnected) {
					inj = {
						btnLocal: makeButton("sess-local", T.local, makeSvg(ICON_PIN, 14), () => onSessionPin("sess-local", row)),
						btnTop: makeButton("sess-top", T.top, makeSvg(ICON_TOP, 14), () => onSessionPin("sess-top", row)),
						indicator: null
					};
					container.insertBefore(inj.btnLocal, anchor);
					container.insertBefore(inj.btnTop, anchor);
					injected.set(row, inj);
				}
				const view = readViewState();
				const firstWsId = st.workspaces.length > 0 ? st.workspaces[0].workspaceId : undefined;
				const atLocalTop = localOrderOf(view, ws)[0] === node.id;
				const rec = st.records.sessions[node.id];
				const localPinned = Boolean(rec && rec.kind === "local" && atLocalTop);
				const topPinned = Boolean(rec && rec.kind === "top" && atLocalTop && firstWsId === ws.workspaceId);
				inj.btnLocal.dataset.pressed = localPinned ? "true" : "false";
				inj.btnTop.dataset.pressed = topPinned ? "true" : "false";
				updateIndicator(row, inj, localPinned || topPinned);
			}

			function decorateWorkspaceRow(row, st) {
				const props = rowProps(row, isWorkspaceProps);
				if (!props) return;
				const workspaceId = props.group.workspaceId;
				const anchor = row.querySelector("button[aria-label]");
				if (!anchor) return;
				const container = anchor.parentElement;
				let inj = wsInjected.get(row);
				if (!inj || !inj.btnWs?.isConnected) {
					inj = { btnWs: makeButton("ws-top", T.ws, makeSvg(ICON_TOP, 14), () => onWorkspacePin(row)) };
					container.insertBefore(inj.btnWs, anchor);
					wsInjected.set(row, inj);
				}
				const firstWsId = st.workspaces.length > 0 ? st.workspaces[0].workspaceId : undefined;
				inj.btnWs.dataset.pressed = firstWsId === workspaceId && (st.records.workspaces ?? {})[workspaceId] !== undefined ? "true" : "false";
			}

			// ---- sync driver ----
			let syncTimer = null;
			function scheduleSync() {
				if (syncTimer !== null) return;
				syncTimer = setTimeout(() => {
					syncTimer = null;
					try { sync(); } catch (error) { console.error("[dsh-pin] sync failed:", error); }
				}, 60);
			}
			function sync() {
				if (!document.body) return;
				const st = currentState();
				if (st === null) return;
				const rows = document.querySelectorAll("div[role='treeitem']");
				let sawWorkspaceHeader = false;
				for (const row of rows) {
					if (row.hasAttribute("aria-expanded")) {
						sawWorkspaceHeader = true;
						decorateWorkspaceRow(row, st);
					} else {
						decorateSessionRow(row, st);
					}
				}
				if (!sawWorkspaceHeader) for (const row of rows) removeInjected(row);
			}

			const observer = new MutationObserver((mutations) => {
				for (const m of mutations) {
					if (m.target.nodeType !== 1) continue;
					const t = m.target;
					if (typeof t.closest === "function" && t.closest("div[role='treeitem'],div[role='tree']")) {
						scheduleSync();
						return;
					}
				}
			});
			observer.observe(document.body, {
				childList: true,
				subtree: true,
				attributes: true,
				attributeFilter: ["aria-selected", "aria-expanded"]
			});
			const interval = setInterval(scheduleSync, 1500);

			ctx.effect(() => () => {
				style.remove();
				observer.disconnect();
				clearInterval(interval);
				if (syncTimer !== null) clearTimeout(syncTimer);
				for (const u of subs) { try { u(); } catch { /* non-fatal */ } }
			}, "dsh-pin: cleanup");

			scheduleSync();
		}
		//#endregion

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map
