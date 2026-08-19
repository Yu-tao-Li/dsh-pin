[English](README.en.md)

# dsh-pin

[![CI](https://github.com/Yu-tao-Li/dsh-pin/actions/workflows/ci.yml/badge.svg)](https://github.com/Yu-tao-Li/dsh-pin/actions/workflows/ci.yml)
[![version](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fapi.github.com%2Frepos%2FYu-tao-Li%2Fdsh-pin%2Freleases%2Flatest&query=%24.tag_name&label=version&color=blue&prefix=v)](https://github.com/Yu-tao-Li/dsh-pin/releases)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![platform](https://img.shields.io/badge/platform-Web%20GUI-lightgrey)](#安装)
[![stars](https://img.shields.io/github/stars/Yu-tao-Li/dsh-pin?style=social)](https://github.com/Yu-tao-Li/dsh-pin)

**给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的侧边栏会话加上「置顶」**——悬停任意会话,两个按钮:📌 置顶到本工作区、⌃⌃ **置顶到所有工作区最上面**(会话进入侧边栏顶部的全局置顶区,悬浮在所有工作区组之上,组内原行自动隐藏);**支持同时置顶多个会话**;再点一次(或点置顶区的 ✕)取消置顶,**精确还原**该会话被置顶前的位置,不影响其他置顶会话。

| ① 置顶到所有工作区最上面:会话进入列表顶部的「已置顶」区(所有工作区组之上),组内原行隐藏;点置顶区里的行直接打开会话,✕ 取消 | ② 悬停会话行:📌 工作区内置顶 / ⌃⌃ 全局置顶,随时可点 |
|---|---|
| ![1](assets/screenshot-1.png) | ![2](assets/screenshot-2.png) |

## 特性

- **两级置顶(一个图标一个操作)**——📌 把会话置顶到**本工作区**内(持久顺序,全局生效);⌃⌃ 把会话**置顶到所有工作区最上面**:会话进入侧边栏顶部的全局置顶区(悬浮在所有工作区组之上,组内原行隐藏),点击置顶区里的行直接打开该会话。两个按钮只出现在会话行上,各对应唯一一个操作。
- **多会话置顶**——可以同时置顶多个会话:工作区内置顶的在组内顶部依次堆叠,全局置顶的在置顶区里按最近置顶排序,各自保留 📌 标记与按钮高亮。点另一个按钮(📌↔⌃⌃)可改换置顶级别。
- **精确还原(多置顶安全)**——取消工作区内置顶时**只移动该会话**回到它被置顶前在**当前列表**中的位置(按 `before`/`after` 双锚点,前邻居优先),不会把整份旧快照盖回去、也不会挤掉仍在置顶的其他会话;宿主持久顺序与浏览器显示顺序**双双还原**;锚点失效时逐级回退(追到末尾),绝不丢位置。若它曾是唯一置顶,还会把排序模式切回置顶前的模式(如「最近更新」)。全局置顶是纯显示级置顶(不动任何顺序),取消即恢复,零副作用。旧版本(曾把全局置顶实现为“移动工作区”)遗留的置顶记录在取消时会自动回滚当时的顺序改动。
- **沿用宿主官方顺序 API**——工作区内置顶走 `workspace.insertSessionBefore` / `workspace.insertBefore`,与应用自带拖拽排序同一条通道;顺序持久化在 DSH 工作区注册表里,所有浏览器/客户端可见。**不改 DSH 本体,零运行时依赖**。
- **跟随应用的排序语义**——应用默认「最近更新」排序(按活跃度,且该模式下应用自己禁用拖拽)。dsh-pin 工作区内置顶时会自动切到「手动排序」让置顶可见;置顶状态(📌 标记、按钮高亮)实时同步。
- **诚实的边界**——「未分组」会话可以全局置顶,但无法工作区内置顶(该桶按应用设计没有手动顺序);平铺列表(“In one list”)没有手动顺序,按钮自动隐藏;RPC 失败有红色反馈;存储损坏自动降级为空。

## 安装

```powershell
# 从 GitHub(--profile 指定装进哪个 profile)
dsh plugin --profile web add github:Yu-tao-Li/dsh-pin
# 或在 DSH 设置的插件市场(dshmarket)搜索 dsh-pin
```

重启 `dsh web` 生效。按钮出现在侧边栏会话行的悬停菜单里(⋯ 左侧)。

> 纯客户端插件:服务端半个是 no-op,所有排序走宿主现成的 RPC;不新增任何 HTTP 路由,无端口、无后端。

## 工作原理

```
侧边栏会话行(React)
   │  悬停 → 注入 📌 / ⌃⌃ 按钮(DOM,不侵入 React 树;MutationObserver 自愈)
   ▼
dsh-pin 客户端 bundle(本仓库 lib/client.js)
   ├─ React fiber 读取行身份(session id / workspace id)
   ├─ 读取应用视图存储(localStorage "dsh.workspace.view.v5"):当前排序模式 + 显示顺序
   ├─ pin-core(纯函数,25 个单测覆盖):计划 pin / unpin,计算双锚点,多置顶安全还原
   └─ 执行
        ├─ 全局置顶区  渲染在所有工作区组之上的「已置顶」托盘(显示级,置顶行在组内隐藏)
        ├─ 宿主 RPC  workspace.insertSessionBefore / insertBefore   ← 工作区内置顶的持久顺序
        ├─ 应用存储   setSessionOrder / setOrderBy(必要时切手动排序)  ← 显示顺序
        └─ 本地记录   localStorage "dsh-pin.records.v3"(每个置顶会话一条)
```

- **记录**存在浏览器 localStorage(每个浏览器各自记住“是谁帮我置顶的”);**工作区内置顶的顺序**存在宿主工作区注册表(全局生效)。
- **全局置顶**是纯显示级:不动任何持久顺序/工作区顺序,取消即还原;置顶区行点击 = 打开该会话(等效侧边栏点击)。
- 置顶判定 = 记录存在(与当前堆叠位置无关,所以多个置顶会话同时高亮);每个会话至多一条记录,点 📌↔⌃⌃ 切换级别会改写记录并记住当时离开的位置。

## 安全与限制

- 只写两类状态:宿主工作区/会话**顺序**(官方 API,可随时手动拖回)与浏览器本地记录;不碰会话内容、不碰凭据、不新增网络端点。
- **全局置顶是每浏览器生效**(DSH 宿主没有“全局置顶会话”的概念);工作区内置顶是全局持久的。
- 仅 Web GUI 可用(TUI/Headless 没有侧边栏);「未分组」桶支持全局置顶但不支持工作区内置顶;平铺模式不支持(应用设计)。
- 工作区内置顶的还原依赖原相邻会话仍存在;相邻会话被归档/删除时按回退规则放置(末尾或前一邻居处),不会静默丢失。
- 依赖应用内部结构(React fiber 行身份、视图存储键名 `dsh.workspace.view.v5`):DSH 大版本升级后若结构变化,按钮可能失效——此时升级/等待本仓库适配即可,不影响应用本身。

## 开发

```
lib/pin-core.mjs        纯逻辑核心(Node 可测;构建时内联进 bundle)
lib/client.js           客户端 bundle(已构建,勿手改;由 build 生成)
src/client-src.js       客户端源码(/*__PIN_CORE__*/ 占位符)
scripts/build-client.mjs  构建(含语法校验)+ --check(校验已提交 bundle 同步)
test/pin-core.test.mjs  25 个单测(node:test,零依赖)
e2e/browser-e2e.mjs     无头 CDP 端到端(需要一台跑着 dsh web 的实例)
e2e/screenshot.mjs      README 截图脚本
```

```powershell
npm test            # 单测
npm run build       # 重新生成 lib/client.js
npm run check       # 校验 bundle 与源码同步(CI 用)
npm run e2e         # 对 http://127.0.0.1:3081 的 scratch 实例做端到端
```

CI(`.github/workflows/ci.yml`)在每次 push/PR 时跑单测 + bundle 同步校验。E2E 需要 Windows + 运行中的 DSH 实例,不进 CI(手动跑)。

## 许可

MIT,见 [LICENSE](LICENSE)。
