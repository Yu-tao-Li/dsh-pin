window.__ModuleLoader__.load({
	id: "dsh-pin",
	factory: () => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		/*__PIN_CORE__*/

		//#region styles
		const CSS = `
.dsh-pin-btn{cursor:pointer;width:20px;height:20px;flex:none;display:inline-flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-tertiary,#8b929c);background:transparent;border:none;border-radius:4px;padding:0;transition:color .12s ease,background .12s ease}
.dsh-pin-btn:hover{color:var(--dsw-alias-label-primary,#17191c);background:var(--dsw-alias-interactive-bg-hover,#eef1f4)}
.dsh-pin-btn[data-pressed="true"],.dsh-pin-btn[data-pressed="true"]:hover{color:var(--dsw-alias-brand-primary,#1677ff)}
.dsh-pin-btn[data-feedback="ok"]{color:#2aa86f}
.dsh-pin-btn[data-feedback="err"]{color:var(--dsw-alias-state-error-primary,#d4380d)}
.dsh-pin-btn[data-feedback="noop"]{color:var(--dsw-alias-brand-primary,#1677ff)}
.dsh-pin-indicator{width:16px;height:20px;flex:none;display:inline-flex;align-items:center;justify-content:center;color:var(--dsw-alias-brand-primary,#1677ff)}
.dsh-pin-tray{display:flex;flex-direction:column;padding:0 0 3px}
.dsh-pin-tray-head{color:var(--dsw-alias-label-tertiary,#8b929c);font-size:11px;line-height:16px;padding:2px 10px 1px;letter-spacing:.04em;user-select:none}
.dsh-pin-tray-row{cursor:pointer;height:32px;display:flex;align-items:center;user-select:none;color:var(--dsw-alias-label-primary,#17191c);border-radius:8px;padding:0 8px}
.dsh-pin-tray-row:hover{background:var(--dsw-alias-interactive-bg-hover,#eef1f4)}
.dsh-pin-tray-title{flex:1;min-width:0;margin:0 6px 0 4px;font-size:14px;line-height:20px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-pin-tray-row .dsh-pin-btn{opacity:0;transition:opacity .1s ease}
.dsh-pin-tray-row:hover .dsh-pin-btn{opacity:1}
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
		const ICON_X = ["M18 6 6 18", "m6 6 12 12"];
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
				top: ZH ? "置顶到所有工作区最上面(再点一次取消置顶)" : "Pin above all workspaces (click again to unpin)",
				pinned: ZH ? "已置顶" : "Pinned",
				unpin: ZH ? "取消置顶" : "Unpin",
				tray: ZH ? "已置顶" : "Pinned"
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
				for (const [id, s] of Object.entries(sess.byId ?? {})) bySessionId.set(id, { id, blank: s.blank, origin: s.origin, displayTitle: s.displayTitle });
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

			/** Drop records for sessions/workspaces that no longer exist (deleted/archived away). */
			function pruneRecords(st) {
				let changed = false;
				for (const sid of Object.keys(records.sessions)) {
					if (!st.bySessionId.has(sid)) { delete records.sessions[sid]; changed = true; }
				}
				for (const wid of Object.keys(records.workspaces)) {
					if (!st.workspaces.some((w) => w.workspaceId === wid)) { delete records.workspaces[wid]; changed = true; }
				}
				if (changed) saveRecords(window.localStorage, records);
			}

			// ---- DOM injection ----
			const injected = new WeakMap(); // session row -> { btnLocal, btnTop, indicator }

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

			// ---- the global pin tray (above every workspace group) ----
			let trayKey = "";
			function renderTray(st) {
				// the main session tree is the role=tree that holds workspace header rows
				const trees = [...document.querySelectorAll("div[role='tree']")];
				const mainTree = trees.find((t) => t.querySelector("div[role='treeitem'][aria-expanded]"));
				const existing = document.querySelector('[data-dsh-pin="tray"]');
				const pinned = Object.entries(st.records.sessions ?? {})
					.filter(([sid, r]) => r && r.kind === "top" && st.bySessionId.has(sid))
					.sort((a, b) => (b[1].pinnedAt ?? 0) - (a[1].pinnedAt ?? 0));
				if (!mainTree || pinned.length === 0) {
					if (existing) existing.remove();
					trayKey = "";
					return;
				}
				const key = pinned.map(([sid]) => sid).join(",");
				let tray = existing;
				if (!tray || !tray.isConnected) {
					tray = document.createElement("div");
					tray.dataset.dshPin = "tray";
					tray.className = "dsh-pin-tray";
					mainTree.parentNode.insertBefore(tray, mainTree);
				}
				if (trayKey === key && tray.childElementCount > 1) return;
				trayKey = key;
				tray.textContent = "";
				const head = document.createElement("div");
				head.className = "dsh-pin-tray-head";
				head.dataset.dshPin = "tray-head";
				head.textContent = `${T.tray} · ${pinned.length}`;
				tray.appendChild(head);
				for (const [sid] of pinned) {
					const summary = st.bySessionId.get(sid);
					const row = document.createElement("div");
					row.className = "dsh-pin-tray-row";
					row.dataset.dshPin = "tray-row";
					const ind = document.createElement("span");
					ind.className = "dsh-pin-indicator";
					ind.appendChild(makeSvg(ICON_PIN, 12));
					const title = document.createElement("span");
					title.className = "dsh-pin-tray-title";
					title.textContent = summary?.displayTitle || sid.slice(0, 8);
					const unpin = makeButton("tray-unpin", T.unpin, makeSvg(ICON_X, 12), () => {
						clearSessionRecord(sid);
						flash(unpin, "ok");
						scheduleSync();
					});
					row.append(ind, title, unpin);
					row.addEventListener("click", () => {
						try { sessionsApi.open(sid); } catch (error) { console.error("[dsh-pin] open failed:", error); }
					});
					tray.appendChild(row);
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

			// ---- session pin actions ----
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

					// top pin = display-level: the session is lifted into the tray
					// above all workspaces; no host/display order is touched.
					if (plan.kind === "pin" && plan.scope === "top") {
						setSessionRecord(sessionId, { ...plan.record, pinnedAt: Date.now() });
						flash(btn, "ok");
						return;
					}
					if (plan.kind === "unpin" && plan.scope === "top") {
						const r = plan.restore;
						// Migration: legacy (pre-tray) top records also moved the
						// host account, the local order and the workspace — undo those.
						if (r.hostBefore !== undefined || r.wsBefore !== undefined) {
							const owner = workspaceOf(st.workspaces, sessionId);
							const hostAnchor = restoreAnchor(owner ? owner.sessionIds : [], { before: r.hostBefore, after: r.hostAfter });
							await api.insertSessionBefore(r.ws, sessionId, hostAnchor ?? undefined);
							if (r.wsBefore !== null || r.wsAfter !== null) {
								const wsAnchor = restoreAnchor(st.workspaces.map((w) => w.workspaceId), { before: r.wsBefore, after: r.wsAfter });
								await api.insertBefore(r.ws, wsAnchor ?? undefined);
							}
							const pos = localRestorePos(r, sessionId);
							if (actions) {
								const order = localOrderOf(readViewState(), { workspaceId: r.ws, sessionIds: owner ? owner.sessionIds : [] });
								actions.setSessionOrder(r.ws, restoreInList(order, sessionId, pos.before, pos.after));
								const remaining = Object.entries(st.records.sessions).filter(([sid, x]) => sid !== sessionId && x && x.kind === "local").length;
								if (remaining === 0 && r.prevOrderBy && r.prevOrderBy !== "manual") actions.setOrderBy(r.prevOrderBy);
							}
						}
						clearSessionRecord(sessionId);
						flash(btn, "ok");
						return;
					}

					if (plan.kind === "pin") {
						await api.insertSessionBefore(plan.ws, sessionId, plan.hostAnchor ?? undefined);
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
						if (actions) {
							actions.setSessionOrder(r.ws, plan.newLocalOrder);
							if (plan.restoreOrderBy) actions.setOrderBy(plan.restoreOrderBy);
						}
						clearSessionRecord(sessionId);
						flash(btn, "ok");
						return;
					}
					flash(btn, "err");
				} catch (error) {
					console.error("[dsh-pin] pin action failed:", error);
					flash(btn, "err");
				}
			}

			function decorateSessionRow(row, st) {
				const props = rowProps(row, isSessionProps);
				if (!props) return;
				const node = props.node;
				// Top-pinned sessions live in the global tray: hide the in-group row.
				const rec = st.records.sessions[node.id];
				if (rec && rec.kind === "top") {
					row.style.display = "none";
					return;
				}
				row.style.display = "";
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
				// A session is pinned iff its record exists — independent of its
				// current stack position, so several pinned sessions all stay
				// highlighted at once. (Top-pinned rows are hidden; the tray
				// carries their marker.)
				const localPinned = Boolean(rec && rec.kind === "local");
				inj.btnLocal.dataset.pressed = localPinned ? "true" : "false";
				inj.btnTop.dataset.pressed = "false";
				updateIndicator(row, inj, localPinned);
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
				pruneRecords(st);
				const rows = document.querySelectorAll("div[role='treeitem']");
				let sawWorkspaceHeader = false;
				for (const row of rows) {
					if (row.hasAttribute("aria-expanded")) {
						sawWorkspaceHeader = true; // workspace headers: no injected buttons
						continue;
					}
					decorateSessionRow(row, st);
				}
				if (!sawWorkspaceHeader) {
					for (const row of rows) removeInjected(row);
					const tray = document.querySelector('[data-dsh-pin="tray"]');
					if (tray) { tray.remove(); trayKey = ""; }
					return;
				}
				renderTray(st);
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
				document.querySelector('[data-dsh-pin="tray"]')?.remove();
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
