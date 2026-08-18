/**
 * dsh-pin browser E2E (headless Chrome over CDP).
 *
 * Drives the real host in headless Chrome and verifies the browser half
 * end to end:
 *   1. the style tag + pin buttons are injected into the sidebar session rows
 *   2. a local pin moves a session to the top of its workspace (RPC + record)
 *   3. a SECOND local pin stacks on top — both sessions stay pinned
 *   4. un-pinning one restores ITS slot without disturbing the other pin
 *   5. un-pinning the last one restores the exact original order + sort mode
 *   6. a top pin lifts the session into a tray ABOVE all workspaces:
 *      in-group row hidden, no order/workspace changes, tray row opens the
 *      session, un-pinning from the tray restores everything
 *
 * Run:  node e2e/browser-e2e.mjs [baseUrl]
 * The host must already be running on the base URL (default http://127.0.0.1:3081).
 * NOTE: CDP port defaults to 9444 — Windows (Hyper-V/WSL) excludes the
 * 9245-9344 TCP range, which includes the old default 9333.
 */
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { mkdirSync, rmSync } from "node:fs";

const CHROME = process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const BASE = (process.argv[2] || "http://127.0.0.1:3081").replace(/\/$/, "");
const CDP_PORT = Number(process.env.CDP_PORT || 9444);
const USER_DATA = "E:\\tmp\\chrome-dsh-pin-e2e";

let failures = 0;
function check(name, cond, extra = "") {
	const ok = Boolean(cond);
	if (!ok) failures += 1;
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? `  (${extra})` : ""}`);
	return ok;
}

rmSync(USER_DATA, { recursive: true, force: true });
mkdirSync(USER_DATA, { recursive: true });
const chrome = spawn(CHROME, [
	"--headless=new",
	`--remote-debugging-port=${CDP_PORT}`,
	`--user-data-dir=${USER_DATA}`,
	"--no-first-run",
	"--no-default-browser-check",
	"--disable-background-networking",
	"--window-size=1680,1050",
	"about:blank"
], { stdio: "ignore" });

async function getJson(path) {
	const r = await fetch(`http://127.0.0.1:${CDP_PORT}${path}`);
	return r.json();
}

let targets = null;
for (let i = 0; i < 80; i++) {
	try { targets = await getJson("/json"); break; } catch { await sleep(400); }
}
if (!targets) { console.error("FAIL: Chrome DevTools endpoint never came up"); process.exit(2); }
let page = targets.find((t) => t.type === "page");
if (!page) {
	const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?about:blank`, { method: "PUT" });
	page = await r.json();
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.addEventListener("open", res, { once: true }); ws.addEventListener("error", rej, { once: true }); });
let idc = 0;
const pending = new Map();
const consoleLog = [];
ws.addEventListener("message", (ev) => {
	const msg = JSON.parse(typeof ev.data === "string" ? ev.data : ev.data.toString());
	if (msg.id !== undefined && pending.has(msg.id)) {
		const { res, rej } = pending.get(msg.id);
		pending.delete(msg.id);
		msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
	} else if (msg.method === "Runtime.consoleAPICalled") {
		const text = (msg.params.args ?? []).map((a) => a.value ?? a.description ?? "").join(" ");
		consoleLog.push(`[${msg.params.type}] ${text}`);
	} else if (msg.method === "Runtime.exceptionThrown") {
		consoleLog.push("[exception] " + (msg.params.exceptionDetails?.exception?.description ?? JSON.stringify(msg.params.exceptionDetails)));
	}
});
function send(method, params = {}) {
	const id = ++idc;
	ws.send(JSON.stringify({ id, method, params }));
	return new Promise((res, rej) => pending.set(id, { res, rej }));
}
async function evaluate(expression) {
	const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
	if (r.exceptionDetails) throw new Error("eval exception: " + JSON.stringify(r.exceptionDetails.exception?.description ?? r.exceptionDetails));
	return r.result?.value;
}

/* Page-side helpers: session ids of the first EXPANDED workspace group, via
 * the same React-fiber props the plugin uses. The currently selected session
 * is excluded from order comparisons (in "updated" sort mode the active
 * session is promoted on activity and would jitter the snapshot). */
const PAGE_HELPERS = `
window.__dshPinE2E = {
	_rows(all) {
		const rows = [...document.querySelectorAll("div[role='treeitem']")];
		const out = [];
		let inGroup = false;
		for (const row of rows) {
			if (row.hasAttribute("aria-expanded")) {
				if (inGroup) break;
				inGroup = row.getAttribute("aria-expanded") === "true";
				continue;
			}
			if (!inGroup) continue;
			if (!all && getComputedStyle(row).display === "none") continue;
			let fiber = null;
			for (const k of Object.keys(row)) if (k.startsWith("__reactFiber$")) { fiber = row[k]; break; }
			let id = null;
			for (let i = 0; fiber && i < 24; i++) {
				const p = fiber.memoizedProps;
				if (p && p.node && typeof p.node === "object" && typeof p.node.id === "string" && typeof p.node.updatedAt === "number") { id = p.node.id; break; }
				fiber = fiber.return;
			}
			if (id && row.querySelector('[data-dsh-pin="sess-local"]')) {
				out.push({ id, selected: row.getAttribute("aria-selected") === "true" });
			}
		}
		return out;
	},
	rowIds() {
		const sel = (this._rows().find((r) => r.selected) || {}).id || null;
		return this._rows().filter((r) => r.id !== sel).map((r) => r.id);
	},
	allRowIds() {
		return this._rows(true).map((r) => r.id);
	},
	isRowVisible(id) {
		const rows = [...document.querySelectorAll("div[role='treeitem']")];
		const el = rows.find((row) => {
			if (row.hasAttribute("aria-expanded")) return false;
			let fiber = null;
			for (const k of Object.keys(row)) if (k.startsWith("__reactFiber$")) { fiber = row[k]; break; }
			for (let i = 0; fiber && i < 24; i++) {
				const p = fiber.memoizedProps;
				if (p && p.node && typeof p.node === "object" && p.node.id === id) return true;
				fiber = fiber.return;
			}
			return false;
		});
		return el ? getComputedStyle(el).display !== "none" : null;
	},
	trayRows() {
		return [...document.querySelectorAll('[data-dsh-pin="tray-row"]')].map((r) => (r.querySelector(".dsh-pin-tray-title") || r).textContent.trim());
	},
	clickTrayRow() {
		const r = document.querySelector('[data-dsh-pin="tray-row"]');
		if (!r) return false;
		r.click();
		return true;
	},
	clickTrayUnpin() {
		const b = document.querySelector('[data-dsh-pin="tray-unpin"]');
		if (!b) return false;
		b.click();
		return true;
	},
	clickPin(id, kind) {
		const rows = [...document.querySelectorAll("div[role='treeitem']")];
		const el = rows.find((row) => {
			if (row.hasAttribute("aria-expanded")) return false;
			let fiber = null;
			for (const k of Object.keys(row)) if (k.startsWith("__reactFiber$")) { fiber = row[k]; break; }
			for (let i = 0; fiber && i < 24; i++) {
				const p = fiber.memoizedProps;
				if (p && p.node && typeof p.node === "object" && p.node.id === id) return true;
				fiber = fiber.return;
			}
			return false;
		});
		const b = el && el.querySelector('[data-dsh-pin="' + kind + '"]');
		if (!b) return false;
		b.click();
		return true;
	},
	state() {
		const view = JSON.parse(localStorage.getItem("dsh.workspace.view.v5") || "null");
		const records = JSON.parse(localStorage.getItem("dsh-pin.records.v3") || "null");
		const current = JSON.parse(localStorage.getItem("dsh.sessions.current") || "null");
		return {
			orderBy: view ? view.orderBy : null,
			recordCount: records ? Object.keys(records.sessions || {}).length : 0,
			recordKinds: records ? Object.values(records.sessions || {}).map((r) => r.kind) : [],
			pressedLocal: document.querySelectorAll('[data-dsh-pin="sess-local"][data-pressed="true"]').length,
			pressedTop: document.querySelectorAll('[data-dsh-pin="sess-top"][data-pressed="true"]').length,
			indicators: document.querySelectorAll('[data-dsh-pin="indicator"]').length,
			trayCount: document.querySelectorAll('[data-dsh-pin="tray-row"]').length,
			currentSession: current ? current.sessionId || null : null
		};
	},
	wsOrder() {
		return [...document.querySelectorAll("div[role='treeitem'][aria-expanded]")].map((r) => (r.textContent || "").replace(/\\d+/g, "").trim().slice(0, 24));
	}
};
"loaded"
`;

try {
	await send("Page.enable");
	await send("Runtime.enable");
	await send("Page.navigate", { url: BASE + "/" });

	// Wait for session rows that carry a local-pin button (the real "plugin is live" signal).
	// If the first workspace is collapsed, expand the first collapsed group and retry.
	let status = null;
	for (let round = 0; round < 3; round++) {
		for (let i = 0; i < 60; i++) {
			await sleep(500);
			status = await probe();
			if (status.rows > 0 && status.pins > 0) break;
		}
		if (status.pins > 0) break;
		const expanded = await evaluate(`(() => {
			const h = document.querySelector("div[role='treeitem'][aria-expanded='false']");
			if (!h) return false;
			h.click(); return true;
		})()`);
		if (!expanded) break;
		await sleep(1200);
	}
	status = await probe();

	check("style tag injected", status.style === true, `style=${status.style}`);
	check("session rows present", status.rows > 0, `rows=${status.rows}`);
	check("pin buttons injected", status.pins > 0, `pins=${status.pins}`);

	if (status.pins > 0) {
		await evaluate(PAGE_HELPERS);
		await sleep(400);
		const baseline = await evaluate("window.__dshPinE2E.rowIds()");
		const baseState = await evaluate("window.__dshPinE2E.state()");
		check(">=3 non-selected sessions to exercise multi-pin", baseline.length >= 3, `rows=${baseline.length} orderBy=${baseState.orderBy}`);
		if (baseline.length >= 3) {
			const [xA, yA] = [baseline[1], baseline[2]];

			// --- pin X (local): to the front, one record ---
			check("pin click X dispatched", await evaluate(`window.__dshPinE2E.clickPin(${JSON.stringify(xA)}, "sess-local")`) === true);
			await sleep(1200);
			let order = await evaluate("window.__dshPinE2E.rowIds()");
			let st = await evaluate("window.__dshPinE2E.state()");
			check("pin X: X at front, 1 record/pressed/indicator", order[0] === xA && st.recordCount === 1 && st.pressedLocal === 1 && st.indicators === 1,
				`order0=${order[0] === xA} rec=${st.recordCount} pressed=${st.pressedLocal} ind=${st.indicators}`);
			const orderAfterPinX = order;

			// --- pin Y (local): multi-pin stack, BOTH stay pinned ---
			check("pin click Y dispatched", await evaluate(`window.__dshPinE2E.clickPin(${JSON.stringify(yA)}, "sess-local")`) === true);
			await sleep(1200);
			order = await evaluate("window.__dshPinE2E.rowIds()");
			st = await evaluate("window.__dshPinE2E.state()");
			check("pin Y over X: Y front, X second", order[0] === yA && order[1] === xA, `order=[${order.slice(0, 3).join(",")}]`);
			check("both sessions pinned at once (2 records/pressed/indicators)", st.recordCount === 2 && st.pressedLocal === 2 && st.indicators === 2,
				`rec=${st.recordCount} pressed=${st.pressedLocal} ind=${st.indicators} kinds=${st.recordKinds}`);

			// --- unpin Y: its own slot restored, X keeps its pin ---
			check("unpin click Y dispatched", await evaluate(`window.__dshPinE2E.clickPin(${JSON.stringify(yA)}, "sess-local")`) === true);
			await sleep(1200);
			order = await evaluate("window.__dshPinE2E.rowIds()");
			st = await evaluate("window.__dshPinE2E.state()");
			const yIdx = orderAfterPinX.indexOf(yA);
			check("unpin Y: back to its pre-pin slot, X stays pinned at front",
				order[0] === xA && order[yIdx] === yA, `order=[${order.slice(0, 4).join(",")}] yIdx=${yIdx}`);
			check("unpin Y: one record left (X's)", st.recordCount === 1 && st.pressedLocal === 1 && st.indicators === 1,
				`rec=${st.recordCount} pressed=${st.pressedLocal} ind=${st.indicators}`);

			// --- unpin X: exact original order + sort mode restored ---
			check("unpin click X dispatched", await evaluate(`window.__dshPinE2E.clickPin(${JSON.stringify(xA)}, "sess-local")`) === true);
			await sleep(1200);
			order = await evaluate("window.__dshPinE2E.rowIds()");
			st = await evaluate("window.__dshPinE2E.state()");
			check("unpin X: exact original order restored", JSON.stringify(order) === JSON.stringify(baseline),
				`restored=[${order.slice(0, 4).join(",")}] baseline=[${baseline.slice(0, 4).join(",")}]`);
			check("unpin X: records cleared, sort mode restored", st.recordCount === 0 && st.orderBy === baseState.orderBy,
				`rec=${st.recordCount} orderBy=${st.orderBy} baseline=${baseState.orderBy}`);
		}

		// ---- top pin: pin the session ABOVE ALL WORKSPACES (global tray) ----
		const wsBefore = await evaluate("window.__dshPinE2E.wsOrder()");
		const orderBefore = await evaluate("window.__dshPinE2E.allRowIds()");
		const firstRow = (await evaluate("window.__dshPinE2E.rowIds()"))[0];
		const topClicked = firstRow ? await evaluate(`window.__dshPinE2E.clickPin(${JSON.stringify(firstRow)}, "sess-top")`) : false;
		check("top-pin click dispatched", topClicked === true);
		await sleep(1200);

		const wsAfter = await evaluate("window.__dshPinE2E.wsOrder()");
		const orderAfter = await evaluate("window.__dshPinE2E.allRowIds()");
		const topState = await evaluate("window.__dshPinE2E.state()");
		const trayTitles = await evaluate("window.__dshPinE2E.trayRows()");
		check("tray appeared above all workspaces with the pinned session",
			topState.trayCount === 1 && trayTitles.length === 1 && trayTitles[0].length > 0,
			`tray=${topState.trayCount} titles=${JSON.stringify(trayTitles)}`);
		check("pinned row hidden from its group", await evaluate(`window.__dshPinE2E.isRowVisible(${JSON.stringify(firstRow)})`) === false,
			"row still visible in its group");
		check("workspace order unchanged", JSON.stringify(wsAfter) === JSON.stringify(wsBefore),
			`before=${JSON.stringify(wsBefore)} after=${JSON.stringify(wsAfter)}`);
		check("session order unchanged (display-level pin)", JSON.stringify(orderAfter) === JSON.stringify(orderBefore));
		check("top pin recorded (kind=top), no local/pressed state",
			topState.recordCount === 1 && topState.recordKinds.includes("top") && topState.pressedLocal === 0,
			`rec=${topState.recordCount} kinds=${topState.recordKinds} pressedLocal=${topState.pressedLocal}`);

		// Clicking the tray row opens that session.
		check("tray row click dispatched", await evaluate("window.__dshPinE2E.clickTrayRow()") === true);
		await sleep(1500);
		const stOpen = await evaluate("window.__dshPinE2E.state()");
		check("tray row click opened the session", stOpen.currentSession === firstRow,
			`current=${stOpen.currentSession} expected=${firstRow}`);

		// Un-pin from the tray: row reappears in place, tray gone, nothing moved.
		check("tray un-pin click dispatched", await evaluate("window.__dshPinE2E.clickTrayUnpin()") === true);
		await sleep(1200);
		const st2 = await evaluate("window.__dshPinE2E.state()");
		const orderRestored = await evaluate("window.__dshPinE2E.allRowIds()");
		check("top un-pin: row visible again + tray gone",
			(await evaluate(`window.__dshPinE2E.isRowVisible(${JSON.stringify(firstRow)})`)) === true && st2.trayCount === 0,
			`tray=${st2.trayCount}`);
		// The tray-row click made the session current (the provisional blank
		// "New Session" row vanishes, freeing one render-cap slot) — so a NEW
		// row may appear. Verify no reordering: every session present before
		// keeps its relative order.
		const rel = (arr) => arr.filter((x) => x !== firstRow);
		const relBefore = rel(orderBefore);
		const relAfter = rel(orderRestored);
		const common = relBefore.filter((x) => relAfter.includes(x));
		const relKept = relAfter.filter((x) => common.includes(x));
		check("top un-pin: no reordering of existing rows + record cleared",
			JSON.stringify(relKept) === JSON.stringify(common) && st2.recordCount === 0,
			`rec=${st2.recordCount}\n  before=${JSON.stringify(relBefore)}\n  after=${JSON.stringify(relAfter)}`);
	} else {
		check("pin interaction skipped (no buttons)", false);
	}
} catch (error) {
	check("e2e completed without exception", false, String(error?.message ?? error));
} finally {
	if (consoleLog.length > 0) {
		console.log("--- browser console (last 20) ---");
		for (const line of consoleLog.slice(-20)) console.log(line);
	}
	try { ws.close(); } catch { /* */ }
	try { await new Promise((res) => spawn("taskkill", ["/PID", String(chrome.pid), "/T", "/F"], { stdio: "ignore" }).on("exit", res)); } catch { try { chrome.kill(); } catch { /* */ } }
}

console.log(failures === 0 ? "\nE2E: all checks passed" : `\nE2E: ${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);

async function probe() {
	return JSON.parse(await evaluate(`JSON.stringify({
		rows: document.querySelectorAll("div[role='treeitem']").length,
		pins: document.querySelectorAll('[data-dsh-pin="sess-local"]').length,
		style: !!document.querySelector('style[data-plugin="dsh-pin"]')
	})`));
}
