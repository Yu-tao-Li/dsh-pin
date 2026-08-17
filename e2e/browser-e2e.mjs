/**
 * dsh-pin browser E2E (headless Chrome over CDP).
 *
 * Drives the real scratch host (http://127.0.0.1:3081) in headless Chrome and
 * verifies the browser half end to end:
 *   1. the style tag + pin buttons are injected into the sidebar session rows
 *   2. a local pin moves a session to the top of its workspace (RPC + record)
 *   3. clicking again un-pins and restores the original order
 *
 * Run:  node test/browser-e2e.mjs [baseUrl]
 * The scratch host must already be running on the base URL (default :3081).
 */
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { mkdirSync, rmSync } from "node:fs";

const CHROME = process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const BASE = (process.argv[2] || "http://127.0.0.1:3081").replace(/\/$/, "");
const CDP_PORT = Number(process.env.CDP_PORT || 9333);
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

try {
	await send("Page.enable");
	await send("Runtime.enable");
	await send("Page.navigate", { url: BASE + "/" });

	// Wait for session rows that carry a local-pin button (the real "plugin is live" signal).
	// If the current workspace is collapsed, expand the first workspace group and retry.
	let status = null;
	for (let round = 0; round < 3; round++) {
		for (let i = 0; i < 60; i++) {
			await sleep(500);
			status = await probe();
			if (status.rows > 0 && status.pins > 0) break;
		}
		if (status.pins > 0) break;
		// No pinned rows yet: try expanding the first collapsed workspace group.
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
		// The group renders a synthetic "New Session" row above the account rows;
		// compare the first REAL session row (the one carrying a local-pin button).
		// Normalized: digits stripped so relative time labels can't break the comparison.
		const firstTitle = () => evaluate(`(() => {
			const r = [...document.querySelectorAll("div[role='treeitem']")].find(r => r.querySelector('[data-dsh-pin="sess-local"]'));
			return r ? (r.textContent || "").replace(/\\d+/g, "").trim() : null;
		})()`);
		const firstBefore = await firstTitle();

		// Click the local-pin on the LAST session row (a non-top session) to pin it to the front.
		const clicked = await evaluate(`(() => {
			const btns = [...document.querySelectorAll('[data-dsh-pin="sess-local"]')];
			if (!btns.length) return false;
			btns[btns.length - 1].click();
			return true;
		})()`);
		check("pin click dispatched", clicked === true);
		await sleep(1500);

		const firstAfterPin = await firstTitle();
		const after = await evaluate(`JSON.stringify({
			records: localStorage.getItem('dsh-pin.records.v3'),
			pressed: [...document.querySelectorAll('[data-dsh-pin="sess-local"][data-pressed="true"]')].length,
			indicators: document.querySelectorAll('[data-dsh-pin="indicator"]').length
		})`);
		const afterObj = JSON.parse(after);
		check("pinned row moved to front", firstBefore !== null && firstAfterPin !== null && firstAfterPin !== firstBefore,
			`before="${firstBefore}" after="${firstAfterPin}"`);
		check("pin record persisted", Boolean(afterObj.records), afterObj.records ?? "no record");
		check("top row shows pressed + indicator", afterObj.pressed >= 1 && afterObj.indicators >= 1,
			`pressed=${afterObj.pressed} indicators=${afterObj.indicators}`);

		// Un-pin: click the same (now top, pressed) button again â†?restores original order.
		await evaluate(`(() => {
			const b = document.querySelector('[data-dsh-pin="sess-local"][data-pressed="true"]');
			if (b) b.click();
			return !!b;
		})()`);
		await sleep(1500);
		const restored = await evaluate(`JSON.stringify({
			records: localStorage.getItem('dsh-pin.records.v3'),
			pressed: [...document.querySelectorAll('[data-dsh-pin="sess-local"][data-pressed="true"]')].length
		})`);
		const restoredObj = JSON.parse(restored);
		const firstRestored = await firstTitle();
		check("un-pin restores original front row", firstRestored === firstBefore,
			`restored="${firstRestored}" expected="${firstBefore}"`);
		const recObj = restoredObj.records ? JSON.parse(restoredObj.records) : null;
		const emptyRecords = !recObj || (Object.keys(recObj.sessions ?? {}).length === 0 && Object.keys(recObj.workspaces ?? {}).length === 0);
		check("un-pin clears record", emptyRecords, restoredObj.records ?? "(empty)");

		// ---- top pin: move the session's whole workspace to the very top of the list ----
		const wsOrder = () => evaluate(`JSON.stringify([...document.querySelectorAll("div[role='treeitem'][aria-expanded]")].map(r => (r.textContent || "").replace(/\\d+/g, "").trim().slice(0, 24)))`);
		const wsBefore = await wsOrder();
		const topClicked = await evaluate(`(() => {
			const b = document.querySelector('[data-dsh-pin="sess-top"]');
			if (!b) return false;
			b.click();
			return true;
		})()`);
		check("top-pin click dispatched", topClicked === true);
		await sleep(1500);

		const wsAfter = await wsOrder();
		check("workspace moved to the very top", JSON.stringify(wsAfter) !== JSON.stringify(wsBefore) && wsAfter.length > 0,
			`before=${JSON.stringify(wsBefore)} after=${JSON.stringify(wsAfter)}`);
		const topState = await evaluate(`JSON.stringify({
			records: localStorage.getItem('dsh-pin.records.v3'),
			pressedTop: [...document.querySelectorAll('[data-dsh-pin="sess-top"][data-pressed="true"]')].length
		})`);
		const topStateObj = JSON.parse(topState);
		const topRec = topStateObj.records ? JSON.parse(topStateObj.records) : null;
		const topRecorded = topRec && Object.values(topRec.sessions ?? {}).some((r) => r.kind === "top");
		check("top pin recorded (kind=top) + pressed", Boolean(topRecorded) && topStateObj.pressedTop >= 1,
			topStateObj.records ?? "(none)");

		// Un-pin the top pin: restores session position AND workspace order.
		await evaluate(`(() => {
			const b = document.querySelector('[data-dsh-pin="sess-top"][data-pressed="true"]');
			if (b) b.click();
			return !!b;
		})()`);
		await sleep(1500);
		const wsRestored = await wsOrder();
		const topRecAfter = await evaluate(`localStorage.getItem('dsh-pin.records.v3')`);
		const recAfterObj = topRecAfter ? JSON.parse(topRecAfter) : null;
		const cleared = !recAfterObj || Object.keys(recAfterObj.sessions ?? {}).length === 0;
		check("top un-pin restores workspace order", JSON.stringify(wsRestored) === JSON.stringify(wsBefore),
			`restored=${JSON.stringify(wsRestored)} expected=${JSON.stringify(wsBefore)}`);
		check("top un-pin clears record", cleared, topRecAfter ?? "(empty)");
	} else {
		check("pin interaction skipped (no buttons)", false);
	}
} catch (error) {
	check("e2e completed without exception", false, String(error?.message ?? error));
} finally {
	if (consoleLog.length > 0) {
		console.log("--- browser console ---");
		for (const line of consoleLog.slice(-30)) console.log(line);
	}
	try { ws.close(); } catch { /* */ }
	try { await new Promise((res) => spawn("taskkill", ["/PID", String(chrome.pid), "/T", "/F"], { stdio: "ignore" }).on("exit", res)); } catch { try { chrome.kill(); } catch { /* */ } }
}

console.log(failures === 0 ? "\nE2E: all checks passed" : `\nE2E: ${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);

async function probe() {
	return JSON.parse(await evaluate(`JSON.stringify({
		rows: document.querySelectorAll("div[role='treeitem']").length,
		pins: document.querySelectorAll('[data-dsh-pin]').length,
		style: !!document.querySelector('style[data-plugin="dsh-pin"]')
	})`));
}
