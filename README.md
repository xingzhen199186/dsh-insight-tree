# DSH Insight Tree

DSH Insight Tree 是一个面向 DeepSeek Harness（DSH）的运行可观测与故障诊断插件。
它把 Profile 配置、实际安装包、Loader 运行状态、会话活动和上游版本信息合并成一份可解释的报告，
再以插件树、当前会话活动和独立诊断页呈现给用户。

它不是插件市场，也不是第三方插件安全审计器。它回答的是：

- 当前 Profile 安装了什么、装配了什么？
- 插件是否真的被 Loader 加载，当前处于什么阶段？
- 当前插件与 DSH 本体及配套包是否兼容？
- 本轮会话实际使用了哪些插件能力？
- 启动失败时，问题是否能归因到某个非核心插件？

当前版本：`0.1.0`。仓库目前为 `private: true`，尚未发布到 npm 或 GitHub。

## 包形态

这是一个单 npm 包，包含四个使用面：

- **Host 入口**：`lib/index.js`，负责报告生成、路由、Loader/Session 接入和操作接口；
- **Client bundle**：`lib/client.js`，由 DSH Web 注入导航栏插件树和本轮活动界面；
- **独立诊断命令**：`dsh-insight-tree-diagnose`，对应 `bin/diagnose.mjs`；
- **失败包装命令**：`dsh-insight-tree-web`，对应 `bin/web-with-diagnostics.mjs`；
- **DSH 装配声明**：`cordis.patch.yml`，把插件接入 DSH 的 bundle/Loader 链路。

运行时依赖包括 `js-yaml`、`semver` 和 `zod`；Loader、Session Projection、Session Query 等
DSH 组件以 peer dependency 接入，缺少可选组件时插件会降级而不是直接崩溃。

## 设计思路

插件的核心不是某一个页面，而是一条“证据汇总”链路：

```text
Profile / package.json / node_modules / cordis.patch.yml
                         |
                         v
              DSH Loader / Fiber 状态
                         |
                         v
            Session Projection / Query
                         |
                         v
                 InsightTreeReport
                   /      |      \
                  v       v       v
               插件树  本轮活动  独立诊断
```

报告模型位于 `src/model.ts`，当前 schema 为 v3。所有界面都消费这份报告，避免运行中页面、
独立诊断页和导出结果各自维护一套不一致的判断逻辑。

### 六个观察维度

1. **安装**：Profile 的 `package.json`、实际 `node_modules` 和包元数据。
2. **装配**：`dsh.profile.bundles` 与 `cordis.patch.yml` 中的 Loader 装配关系。
3. **加载**：`ctx.loader` 暴露的真实条目，以及对应的 Fiber 阶段。
4. **兼容**：DSH 本体版本、配套 DSH 包版本和 npm 发布版本的 semver 判断。
5. **使用**：当前会话的 `session/event`、持久投影和历史会话查询。
6. **上游**：插件目录、npm packument 和 GitHub 元数据；网络不可用时使用缓存或明确标注离线。

判断时遵循几个原则：

- 运行时 Loader 证据优先于静态声明；
- 实际安装版本优先于 Profile spec，配置中的 `dshVersion` 只作 fallback；
- 明确的工具 owner 优先，无法确认时标记为未确认，不伪装成精确归属；
- 独立诊断没有 Loader 运行证据，因此不会虚构“当前正在运行”的状态；
- 缺少必要上下文时显示“暂时无法确认”，不把未知误报为“不适配”。

## 版本与兼容性语义

页面中的“当前插件”“最新插件”“最新兼容插件”都指插件自身版本，不是 DSH 本体版本。
例如：

```text
当前插件 2.10.3　npm: dsh-pocket　已是最新兼容版本
```

DSH 本体会单独显示，例如：

```text
适配当前 DSH 本体 @deepseek-ai/dsh@0.1.2-rc.1
```

兼容性按依赖类型分别判断：

- `@deepseek-ai/dsh` 或 `engines.dsh`：比较当前实际安装的 DSH 本体版本；
- `@deepseek-ai/dsh-*`：比较当前 Profile 中实际安装的对应配套包版本；
- 缺少配套包上下文或范围无法解析：显示 `unknown`，并说明暂时无法确认。

因此，安装另一个 DSH 本体版本后，报告会重新计算适配状态；同一个插件版本可能在不同 DSH
本体或不同配套包组合下得到不同结论。

## 用户界面与运行边界

### DSH 内部

正常打开 DSH 时不会自动打开独立诊断页面。用户可以在 DSH 内打开：

- **插件树**：导航栏右侧的结构、能力、依赖、兼容性和 Loader 状态；
- **本轮活动**：当前对话中实际出现的插件活动，只绑定当前 session。

### 独立诊断页

独立页面是一个不依赖完整 DSH Web UI 的静态诊断入口。它可以在 DSH 正在运行或完全未运行时
单独启动，读取 Profile、包元数据和 patch 文件，并提供报告、导出和受保护的配置操作。

手动启动：

```powershell
node bin/diagnose.mjs --profile web --port 3092
```

启动后访问 `http://127.0.0.1:3092/`。也可以使用已安装的命令：

```powershell
dsh-insight-tree-diagnose --profile web --port 3092
```

DSH 启动失败时，推荐使用包装命令：

```powershell
dsh-insight-tree-web --profile web
```

包装命令会转发 `dsh web` 的输出，并且只有在错误能够被报告明确归因到非核心插件时，才自动启动
并打开独立诊断页。核心 DSH 本体启动失败不会误弹插件诊断页，只输出手动诊断命令。

## 安全边界

- HTTP 服务只监听 loopback；
- 可通过 `--token` 或插件配置启用请求令牌；
- 导出前会脱敏，支持 JSON、Markdown 和 CSV；
- 禁用、启用和卸载前会备份 Profile 文件，并对 YAML 做 round-trip 校验；
- 修改前执行静态配置 dry-run，失败时保留原文件并返回恢复信息；
- 核心 `@deepseek-ai/*` 包和当前诊断插件拒绝操作；
- 卸载有被依赖插件时会拒绝执行；
- 诊断页不加载完整插件树，也不将静态声明冒充为运行时事实。

## 主要源码

| 文件 | 职责 |
| --- | --- |
| `src/index.ts` | 插件入口、事件统计、投影注册、Loader 快照和路由装配 |
| `src/model.ts` | `InsightTreeReport` 及插件、兼容性、Finding、Activity 类型 |
| `src/discovery.ts` | Profile、包元数据、patch、依赖和报告生成 |
| `src/loader.ts` | Loader 条目到 Fiber 阶段的纯函数映射 |
| `src/activity.ts` | session projection 活动折叠和历史回放辅助 |
| `src/owners.ts` | 工具到插件的显式/稳定归属映射 |
| `src/upstream.ts` | 插件目录、npm/GitHub 元数据和版本兼容判定 |
| `src/rules.ts` | 缺包、重复装配、兼容性和启动影响规则 |
| `src/route.ts` | `/dsh-insight-tree` 报告、会话、导出、对比和操作 API |
| `src/diagnostics.ts` | 判断启动错误是否确实与非核心插件相关 |
| `src/client/index.tsx` | DSH 内的插件树和本轮活动 UI |
| `bin/diagnose.mjs` | 独立诊断 HTTP 服务 |
| `bin/web-with-diagnostics.mjs` | `dsh web` 包装启动器和失败诊断入口 |
| `tests/*.test.mjs` | 报告、Loader、活动、路由、导出、版本和诊断回归测试 |

## 开发与验证

Node 要求：`^22.19.0` 或 `>=24.0.0`。在 Windows 上请使用 PowerShell 中的 Node 22/24，
不要使用 Git Bash 自带的 Node 18。

```powershell
npm install --legacy-peer-deps --no-audit --no-fund
npm run typecheck
npm run build
npm test
node --check bin/diagnose.mjs
node --check bin/web-with-diagnostics.mjs
git diff --check
```

`npm test` 会先构建，再运行 `tests/*.test.mjs`。最近一次完整验证为 `61/61` 通过，另有
typecheck、两个诊断脚本语法检查和 `git diff --check` 通过。

代码变更后，运行中的 DSH Web 需要重启才会加载新的 `lib/`；本机可使用：

```powershell
schtasks /run /tn DSHWebRestart
```

## 当前限制

- Loader、session projection 和 session query 的真实可用性取决于 DSH 主机是否提供对应服务；
  缺失时插件会降级并标注来源。
- 工具事件没有显式 owner 时，只能使用稳定映射或标记为未确认，不能保证精确归因。
- 单元测试不能替代真实 DSH Web 主机上的路由、SSE 回放和视觉验证。
- 上游目录、npm 和 GitHub 信息依赖网络；离线时使用缓存，缓存不可用则明确显示离线状态。

## 相关资料

权威 DSH 架构和插件开发资料位于知识库 X：
`D:\X\X\16-DSH\开发指南和架构文档\`。

本插件的留档位于：
`D:\X\X\16-DSH\plugins\dsh-insight-tree\dsh-insight-tree.md`，总览位于
`D:\X\X\16-DSH\plugins\dsh-plugins-overview\dsh-plugins 总览.md`。
