# 发布流程:GitHub + 插件商城(dshmarket)

对照 dsh-computer-use-win 的发布实践与 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)
(插件商城 [dshmarket](https://github.com/dsh-market/dsh-market) 的数据源)的 `contributing.md` 仿建。

## 仓库要求(CI 自动检查)

- `package.json` 声明 `dsh.bundle` manifest ✅(本仓库已声明;纯客户端插件也必须带 `dsh.bundle`,
  只有 `dsh.client` 会被拒);
- 仓库**创建满 1 天**且**提交数 ≥ 10**;
- 仓库带 [`dsh-plugin`](https://github.com/topics/dsh-plugin) topic;
- 真实可用代码,非占位仓库。

## 流程

### 第 1 步:推 GitHub(✅ 已完成 2026-07-26)

- 仓库:<https://github.com/Yu-tao-Li/dsh-pin>(public)
- topic `dsh-plugin` 已添加
- CI(ubuntu-latest:单测 + bundle 同步校验)

```powershell
gh repo create dsh-pin --public --source . --push
gh repo edit Yu-tao-Li/dsh-pin --add-topic dsh-plugin
```

### 第 2 步:凑够提交数(≥10)

功能迭代、文档、测试、CI 各是一笔自然提交;不要把空提交当填充(CI 会看仓库真实性)。

### 第 3 步:等够"仓库年龄"(≥1 天)

今天推、明天(或更晚)再提收录 PR,避免白跑 CI。

### 第 4 步:提收录 PR(满 1 天 + ≥10 提交后)

```bash
git clone https://github.com/awesome-dsh-plugin/awesome-dsh-plugin
cd awesome-dsh-plugin
# 1) 收录条目(内容见本仓库 publish/awesome-list-entry.yml)
mkdir -p data/plugins
cp <本仓库>/publish/awesome-list-entry.yml data/plugins/Yu-tao-Li__dsh-pin.yml
# 2) 重新生成 README(必须,CI 会校验)
npm ci
node scripts/generate-readme.mjs
# 3) 提交 + 推送 + 开 PR
git add data/plugins/Yu-tao-Li__dsh-pin.yml README.md README.zh.md
git commit -m "Add Yu-tao-Li/dsh-pin"
git push origin HEAD
gh pr create --repo awesome-dsh-plugin/awesome-dsh-plugin \
  --title "Add Yu-tao-Li/dsh-pin" \
  --body "Pin DSH sidebar conversations: pin to top of workspace, or to the very top of the list, with exact restore."
```

### 第 5 步:CI 会检查什么(失败就在同一分支推修复)

1. `dsh.bundle` —— 从本仓库 `package.json` 拉取校验 ✅(已声明);
2. 仓库年龄 / 提交数 —— 1 天 / 10 次(第 2、3 步);
3. `awesome-lint` + 站点构建 —— 双语一致、分隔符、日期。

### 第 6 步(合并后,自动)

网站与 dshmarket 自动重建,插件上架。用户侧:

```powershell
dsh plugin --profile web add github:Yu-tao-Li/dsh-pin
# 或在 DSH 设置里的插件市场(dshmarket)搜索 "dsh-pin" 一键安装
```

## 可选加分项

- **npm 发布**:`npm publish`(包名 `dsh-pin` 是否被占用需先 `npm search dsh-pin` 确认;
  发布后条目 `npm:` 字段生效,安装免构建授权)。
- **GitHub Release tarball**:`npm pack` 出 tgz 挂 Release,条目里加
  `tarball: https://github.com/Yu-tao-Li/dsh-pin/releases/latest/download/dsh-pin-<ver>.tgz`。

## 安全提醒

- 上架 ≠ 安全审查(列表官方免责声明)。插件以用户权限在用户浏览器运行;
  README 已写明风险边界(只写顺序 + 本地记录,依赖应用内部结构的适配风险)。
- GitHub token 只存在 `E:\PythonFiles\.secrets\` 与 git 凭据管理器,**不在仓库内**
  (`.gitignore` 已排除 `.secrets/`)。
