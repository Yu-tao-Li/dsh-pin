[中文](README.md)

# dsh-pin

[![CI](https://github.com/Yu-tao-Li/dsh-pin/actions/workflows/ci.yml/badge.svg)](https://github.com/Yu-tao-Li/dsh-pin/actions/workflows/ci.yml)
[![version](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fapi.github.com%2Frepos%2FYu-tao-Li%2Fdsh-pin%2Freleases%2Flatest&query=%24.tag_name&label=version&color=blue&prefix=v)](https://github.com/Yu-tao-Li/dsh-pin/releases)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![platform](https://img.shields.io/badge/platform-Web%20GUI-lightgrey)](#install)
[![stars](https://img.shields.io/github/stars/Yu-tao-Li/dsh-pin?style=social)](https://github.com/Yu-tao-Li/dsh-pin)

**Pin your DeepSeek Harness sidebar conversations** — hover any session row: 📌 pin to the top of its workspace, or ⌃⌃ **pin above all workspaces** (the session moves into a pinned tray at the very top of the sidebar, floating above every workspace group, and its in-group row is hidden). **Several sessions can be pinned at once.** Click again (or the ✕ in the tray) to un-pin and **restore that session's pre-pin position exactly**, without disturbing the other pins.

| ① Pinned above all workspaces: the session sits in the "Pinned" tray at the top of the sidebar (above every workspace group); its in-group row is hidden — click the tray row to open the session, ✕ to un-pin | ② Hover a session row: 📌 pin within workspace / ⌃⌃ pin above all workspaces, always one click away |
|---|---|
| ![1](assets/screenshot-1.png) | ![2](assets/screenshot-2.png) |

## Features

- **Two-level pinning (one icon, one operation)** — 📌 pins a session to the top of **its workspace** (durable order, visible to every client); ⌃⌃ pins a session **above all workspaces**: the session moves into a pinned tray at the very top of the sidebar, floating above every workspace group (its in-group row is hidden); clicking a tray row opens that session. Both buttons appear only on session rows, each mapping to exactly one operation.
- **Multiple pins** — any number of sessions can be pinned at once: workspace-level pins stack at the top of their group, global pins stack in the tray in most-recently-pinned order, each keeping its 📌 marker and button highlight. Clicking the other button (📌↔⌃⌃) re-pins at the other level.
- **Exact restore (multi-pin safe)** — un-pinning a workspace-level pin moves **only that session** back to the slot it had **in the current list** before it was pinned (recorded `before`/`after` anchors, preceding neighbour preferred): no stale whole-list snapshot is replayed, so the other pinned sessions are never disturbed. Both the host's durable order and the browser's display order are restored; if an anchor is gone it falls back step by step (append to the end) — the position is never silently lost. If it was the last pin, the app's sort mode is switched back to what it was before the pin (e.g. "recently updated"). A global pin is display-level (it never touches any order), so un-pinning it is a side-effect-free removal. Legacy global pins from the pre-tray build (which moved the workspace) are rolled back automatically on un-pin.
- **Built on the host's official order APIs** — workspace-level pinning uses `workspace.insertSessionBefore` / `workspace.insertBefore`, the same channel the app's own drag & drop uses; the order is durable in the DSH workspace registry and visible to every client. **No DSH core changes, zero runtime dependencies.**
- **Respects the app's sort semantics** — the app defaults to "recently updated" order (activity-based; the app itself disables drag & drop in that mode). dsh-pin auto-switches to "manual" order when you pin within a workspace so the pin is visible; pin state (📌 marker, button highlight) stays in sync live.
- **Honest boundaries** — "Ungrouped" sessions can be pinned globally but not within a workspace (that bucket has no manual order by app design); the flat list ("In one list") has no manual order at all, so the buttons hide there; RPC failures flash red; corrupt storage degrades to empty.

## Install

```powershell
# From GitHub (--profile selects the profile to install into)
dsh plugin --profile web add github:Yu-tao-Li/dsh-pin
# Or search dsh-pin in the DSH plugin market (dshmarket)
```

Restart `dsh web` to activate. The buttons appear in the hover actions of sidebar session rows (left of the ⋯ menu).

> Client-only plugin: the server half is a no-op; all reordering goes through the host's existing RPCs. No new HTTP routes, no port, no backend.

## How it works

```
Sidebar session rows (React)
   │  hover → 📌 / ⌃⌃ buttons injected (plain DOM, non-invasive; MutationObserver self-heals)
   ▼
dsh-pin client bundle (this repo's lib/client.js)
   ├─ reads row identity (session id / workspace id) via React fiber
   ├─ reads the app's view store (localStorage "dsh.workspace.view.v5"): sort mode + display order
   ├─ pin-core (pure functions, covered by 25 unit tests): plans pin / unpin, dual anchors, multi-pin-safe restore
   └─ executes
        ├─ global tray  "Pinned" panel rendered above every workspace group (display-level; the pinned row is hidden in its group)
        ├─ host RPC     workspace.insertSessionBefore / insertBefore   ← durable order for workspace-level pins
        ├─ app store    setSessionOrder / setOrderBy (switch to manual if needed)  ← display order
        └─ local        localStorage "dsh-pin.records.v3" (one record per pinned session)
```

- **Records** live in the browser's localStorage (each browser remembers "who pinned what"); **workspace-level pin order** lives in the host's workspace registry (visible everywhere).
- **Global pinning is display-level only**: it touches no durable or workspace order at all — un-pinning is a plain removal. Clicking a tray row opens that session (same as a sidebar click).
- "Pinned" = a record exists for that session (independent of its current stack position — that is what lets several sessions be pinned at once). Each session has at most one record; clicking the other button (📌↔⌃⌃) re-pins it at the other level and remembers the position it leaves.

## Safety & limitations

- Only two kinds of state are written: host workspace/session **order** (official APIs, always re-draggable) and per-browser local records; session content, credentials, and network endpoints are untouched.
- **Global pins are per-browser** (the DSH host has no "globally pinned session" concept); workspace-level pins are durable and global.
- Web GUI only (the TUI/headless have no sidebar); the "Ungrouped" bucket supports global pinning but not within-workspace pinning; flat mode is unsupported (app design).
- Restoring a workspace-level pin relies on the original neighbors still existing; if a neighbor was archived/deleted, fallback placement applies (append, or before the previous neighbor) — never a silent loss.
- Relies on app internals (React fiber row identity, view-store key `dsh.workspace.view.v5`): after a major DSH upgrade the buttons may stop working until this repo adapts — the app itself is unaffected.

## Development

```
lib/pin-core.mjs         pure logic core (Node-testable; inlined into the bundle at build time)
lib/client.js            client bundle (prebuilt — don't edit by hand; generated by build)
src/client-src.js        client source (/*__PIN_CORE__*/ placeholder)
scripts/build-client.mjs build (with syntax check) + --check (verify checked-in bundle is in sync)
test/pin-core.test.mjs   25 unit tests (node:test, zero dependencies)
e2e/browser-e2e.mjs      headless CDP end-to-end (needs a running dsh web instance)
e2e/screenshot.mjs       README screenshot capture
```

```powershell
npm test            # unit tests
npm run build       # regenerate lib/client.js
npm run check       # verify bundle is in sync with source (CI)
npm run e2e         # end-to-end against a scratch instance at http://127.0.0.1:3081
```

CI (`.github/workflows/ci.yml`) runs the unit tests + bundle sync check on every push/PR. The E2E needs Windows + a live DSH instance, so it stays out of CI (run manually).

## License

MIT, see [LICENSE](LICENSE).
