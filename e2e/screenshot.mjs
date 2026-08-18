/**
 * Screenshot capture for the dsh-pin README (CDP-driven, no physical mouse).
 *
 * 1. screenshot-2.png: hover a session row -> the two pin buttons appear.
 * 2. screenshot-1.png: after a top-pin -> the session sits in a pinned tray
 *    ABOVE all workspace groups (its in-group row is hidden).
 * Restores the pin afterwards (round trip).
 *
 * Run: node e2e/screenshot.mjs [baseUrl] [outDir]
 */
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { rmSync, mkdirSync, writeFileSync } from "node:fs";

const CHROME = process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const BASE = process.argv[2] || "http://127.0.0.1:3081";
const OUT = process.argv[3] || "E:\\PythonFiles\\dsh-pin\\assets";
const CDP_PORT = Number(process.env.CDP_PORT || 9354);
const USER_DATA = "E:\\tmp\\chrome-dsh-pin-shot-cdp";

rmSync(USER_DATA, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${USER_DATA}`, "--no-first-run", "--window-size=1500,1000", "--force-device-scale-factor=1", "about:blank"], { stdio: "ignore" });

async function getJson(p) { const r = await fetch(`http://127.0.0.1:${CDP_PORT}${p}`); return r.json(); }
let targets = null;
for (let i = 0; i < 80; i++) { try { targets = await getJson("/json"); break; } catch { await sleep(400); } }
let page = targets.find((t) => t.type === "page");
if (!page) { const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?about:blank`, { method: "PUT" }); page = await r.json(); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.addEventListener("open", res, { once: true }); ws.addEventListener("error", rej, { once: true }); });
let idc = 0;
const pending = new Map();
ws.addEventListener("message", (ev) => {
	const m = JSON.parse(ev.data);
	if (m.id !== undefined && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); }
});
const send = (method, params = {}) => new Promise((res, rej) => { const id = ++idc; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); });
async function ev(expr) { const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails)); return r.result?.value; }
async function shot(file) {
	const r = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
	writeFileSync(file, Buffer.from(r.data, "base64"));
	console.log("shot", file);
}

try {
	await send("Page.enable");
	await send("Runtime.enable");
	await send("Emulation.setDeviceMetricsOverride", { width: 1500, height: 1000, deviceScaleFactor: 1, mobile: false });
	await send("Page.navigate", { url: BASE + "/" });
	for (let i = 0; i < 60; i++) { await sleep(500); if (await ev(`document.querySelectorAll("div[role='treeitem']").length`) > 0) break; }
	await sleep(2000);

	// Pick a mid-list session row of the auto-expanded workspace (not the first one).
	const rowInfo = await ev(`(() => {
		const rows = [...document.querySelectorAll("div[role='treeitem']")].filter(r => !r.hasAttribute('aria-expanded') && r.querySelector('[data-dsh-pin="sess-top"]'));
		if (rows.length < 3) return null;
		const row = rows[rows.length - 1];
		const b = row.getBoundingClientRect();
		return { title: (row.textContent || "").trim().slice(0, 24), x: Math.round(b.left + b.width * 0.5), y: Math.round(b.top + b.height / 2), w: Math.round(b.width) };
	})()`);
	if (!rowInfo) throw new Error("no session row with pin buttons found");
	console.log("target row:", JSON.stringify(rowInfo));

	// Hover -> the row actions (pin buttons) appear.
	await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: rowInfo.x, y: rowInfo.y });
	await sleep(500);
	await shot(`${OUT}\\screenshot-2.png`);

	// Top-pin the hovered row: it is lifted into the tray above all workspaces.
	await ev(`(() => { const all = document.querySelectorAll('[data-dsh-pin="sess-top"]'); all[all.length - 1].click(); })()`);
	await sleep(1500);
	// Hover the tray row (above every workspace group) — shows its un-pin button.
	const pinned = await ev(`(() => {
		const row = document.querySelector('[data-dsh-pin="tray-row"]');
		if (!row) return null;
		const r = row.getBoundingClientRect();
		return { x: Math.round(r.left + r.width * 0.5), y: Math.round(r.top + r.height / 2) };
	})()`);
	if (!pinned) throw new Error("tray row not found after top-pin");
	await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: pinned.x, y: pinned.y });
	await sleep(500);
	await shot(`${OUT}\\screenshot-1.png`);

	// Round-trip back: un-pin from the tray, verify the record cleared.
	await ev(`document.querySelector('[data-dsh-pin="tray-unpin"]')?.click()`);
	await sleep(1500);
	const rec = await ev(`localStorage.getItem("dsh-pin.records.v3")`);
	console.log("record after un-pin:", rec ?? "(empty)");
} finally {
	try { ws.close(); } catch { /* */ }
	try { await new Promise((res) => spawn("taskkill", ["/PID", String(chrome.pid), "/T", "/F"], { stdio: "ignore" }).on("exit", res)); } catch { /* */ }
	process.exit(0);
}
