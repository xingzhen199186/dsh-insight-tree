# Changelog

本仓库所有用户可见变更记录于此处。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [Unreleased]

暂无。

## [0.1.1] - 2026-09-07

### 变更
- 「插件树」折叠胶囊展开后支持点击面板外空白处收起（`pointerdown` 外部关闭，面板/胶囊内点击不受影响、不阻断页面其他交互）。
- 「插件树」折叠胶囊移除点击后焦点内环（`inset 2px` 蓝环沿按钮左右两侧/斜边显示，导致“两侧竖直线颜色很深”）：鼠标点击展开/收起不再出现两侧深粗蓝线（展开=图1 状态、收起=图4 状态）；保留 hover/展开的斜边线、装饰线与右侧竖线蓝反馈。
- 「插件树」折叠胶囊交互颜色层级重构为主流产品标准：默认中性 → hover 8% 主色 tint（外壳不再整块变实心蓝，装饰线为完整实线）→ 展开激活态 12% tint + 文本/装饰线/连接片钉蓝（鼠标移开仍保持激活识别）→ 展开+悬停 16% tint；键盘聚焦与指针悬停解耦（聚焦仅显示 2px 内环，不再联动整块变色）。
- 「插件树」折叠胶囊精修：内侧细线角度改为几何常量推导，与切角严格平行（原硬编码 `62deg` 与 22%/78% 切角实际斜率偏差约 9°）；中性表面改用 DSH 主题 CSS 变量（`--dsw-alias-bg-base/border-l2/label-*`，暗色主题下不再发白刺眼）；悬停/聚焦强调色保持原钉蓝 `#2864d7`（不随 DSH 近黑品牌色 `--dsw-alias-brand-primary` 变黑）；外层投影改 `drop-shadow` 贴切角轮廓；新增键盘 focus 内环、`aria-pressed`、字距/行高微调。
- 新增上游来源与版本核验：并行读取 awesome-dsh-plugin、npm registry 和 GitHub 元数据，显示来源、历史版本、适配判断与最新兼容版本；支持一键升级及历史版本降级。
- 更新前备份 Profile 配置与锁文件，失败自动恢复；对未声明适配范围且偏离兼容候选的版本，在 UI 与服务端以 `409` 要求二次确认。
- 修复插件详情操作区同时显示“暂时关闭”和“重新启用”的问题：按当前状态仅显示一个互斥操作，卸载保持独立。
- 兼容性文案明确标出宿主对象与版本，例如“适配当前 DSH 本体 `@deepseek-ai/dsh@0.1.2-rc.1`”，避免将插件自身版本与 DSH 本体版本混淆。
- 修复上游历史版本把 `@deepseek-ai/dsh-*` 配套包版本误当成 DSH 本体版本比较的问题；现在优先使用当前 Profile 的实际配套包版本，缺少上下文时显示暂时无法确认，不再误报为不适配。
- 修正上游版本摘要文案：明确区分“当前插件”“最新插件”和“最新兼容插件”；三者相同时收敛为“已是最新兼容版本”。
- 明确独立诊断边界：正常打开 DSH 不自动弹出；用户可在 DSH 运行或未运行时通过命令行单独启动；只有确认启动失败与插件有关时才自动打开。

## [0.1.0] - 2026-09-06

> 首个发布候选版本。此前本地迭代（含 0.2.0 阶段）均未对外发布，已合并进本版；报告 schema 为 v3。

### 新增
- 「设置 → 插件 → 插件树」面板：DSH 版本（运行时读取，来源标注）、Profile、插件树、依赖/被依赖、能力标签、版本兼容性、问题影响与推荐动作。
- Loader 真实运行状态：直读 `ctx.loader`，展示 `active / failed / pending / unloading / 无存活根`；结构行（group/include/isolate/容器）通过 `isStructuralLoaderEntry` 排除，`pending` 为 info 不告警。
- 会话活动：host-only `ctx.sessionProjections` 投影（按事件/工具名折叠，持久可重放，`activity.source` 标注来源）。
- 诊断导出：JSON / Markdown / CSV（导出脱敏，`Content-Disposition: attachment` 附件下载）。
- 多 Profile 对比：`/compare` + 面板「Profile 对比」表。
- 插件搜索 / 筛选 / 行内详情（展开/收起、动作按钮、Loader 状态、发现项建议）。
- 状态点按严重度着色：正常=绿、本轮使用=蓝、warning/degraded/`pending`=黄、blocking/failed/blocked=红（核心包红/黄保护）。
- 启停安全：YAML round-trip + `--patch + --dump-config` dry-run，备份 + `rollbackCommand` + 操作锁；核心 `@deepseek-ai/*` 拒绝。
- 可选访问令牌：`Config.token` + `/bootstrap` + CSP/nosniff；loopback-only 路由。
- 独立启动诊断（DSH 未运行时）：每插件行可选中/展开详情，行内「暂时关闭/重新启用/卸载插件」（备份 + 回滚命令）；`/report` `/copy` `/export`。
- 对话页「本轮活动」浮层（导航栏右侧可展开/收起，按当前会话隔离，5s 自动刷新）。

### 变更
- 报告 schema 升级至 v3（`schemaVersion`、`versionSource`、`loader`、`activity`、`ruleVersion`）。
- README 改写为对外产品版（兼容性表：DeepSeek 工具链 0.1.2-rc.1 / Node `^22.19.0 || >=24.0.0` / DSH Web 客户端包 + 无头主机逻辑）。

### 依赖
- 运行时：`zod`、`js-yaml`；可选 peer：`@deepseek-ai/cordis-plugin-loader`、`@deepseek-ai/dsh-session-projection`。
- 开发依赖对齐 DSH `0.1.2-rc.1` 线（client-runtime 用 npm 最高 `0.1.1-rc.2`）。

> 历史备注：更早的本地版本（原名 dsh-explorer、报告 schema v2、曾暂标 0.2.0）均未对外发布，不在此列档；详见 git 历史与知识库单条目。
