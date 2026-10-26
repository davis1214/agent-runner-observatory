---
tags: [index, task, agent-orchestration, observability, frontend, multica, nginx, sse, real-data]
created: 2026-10-25
updated: 2026-10-25
status: done
parent: ../INDEX.md
children:
  - assets
  - data
  - deploy
  - prototype
  - scripts
  - tests
inventory:
  - index.html: 监控台入口（Agent 侧栏 + 全部任务 + 工作区分组 + 独立看板 + 任务详情）
  - README.md: 用法 / 7 问映射 / 真实数据 / 协作 / 日志 / Schema / 验收 / 边界
  - CHANGELOG.md: 发版说明（与 assets/version.js 同步）
  - agent-observatory.html: v1 单文件看板（旧版，保留对照）
  - assets/app.css: 设计系统、双栏布局、分组与看板、检查器 / 痕迹 / 版本标记样式、响应式
  - assets/app.js: 列表、工作区分组、时间排序、哈希路由、详情任务切换、本地日志导入、版本标记、看板每列条数与泳道收纳
  - assets/observatory.js: 日志解析 + 模型派生 + 7 面板渲染（含提示词面板、工作痕迹、架构节点检查器）
  - assets/version.js: 版本单一事实源（releases v1→v5.0.1），顶栏版本标记与弹层读这里
  - assets/screenshot-all-tasks.png: README 截图：全部任务列表（演示数据）
  - assets/screenshot-task-detail.png: README 截图：任务详情 7 面板（演示数据）
  - assets/screenshot-board.png: README 截图：六列看板（演示数据）
  - assets/store.js: 本地关联 / 子任务 / 合成事件（localStorage v2）
  - assets/multica.js: 同源桥接客户端（/api/bridge/*）
  - assets/collab.js: Multica 关联 / 子任务派发 / 状态同步 / 记忆
  - assets/livelog.js: 线索式执行日志（动态放出 / 重播 / 筛选；参考 DSH 设计，不依赖其运行时）
  - assets/livedata.js: 实时数据订阅（SSE + 快照原位刷新）
  - assets/task-board-arch.png: v3 架构图局部截图（历史留档，现行看板已独立成页/面板）
  - data/dataset.js: 内嵌演示数据集（window.OBS_DATASET）
  - data/catalog.json: 演示数据元数据（4 个 Agent / 16 个任务）
  - data/sessions/: 16 份演示任务日志（qoder-cn / codex / workbuddy / trae-cn 各 4，562 事件）
  - data/sample-session.jsonl: v1 样例日志
  - scripts/gen-dataset.mjs: 确定性演示数据生成器
  - scripts/real-data.mjs: 本机真实会话采集（Qoder CN / Codex / WorkBuddy / Trae CN / Claude Code，全工作区，只读；附件净化 + subagent 展开）
  - scripts/serve.mjs: 静态服务 + 真实数据 API + 演示 SSE / 事件摄取 + Multica CLI 桥接（仅 127.0.0.1，默认 8796）
  - scripts/service.sh: 本地服务 start / stop / restart / status
  - scripts/enable-nginx.sh: 生成索引并重载本机 80 端口 Nginx
  - deploy/nginx.conf.example: 通用 Nginx 部署配置
  - tests/acceptance.mjs: 演示数据 Playwright 验收（1555 断言）
  - tests/real-acceptance.mjs: 本机真实数据验收（100 断言）
  - tests/live-http.mjs: HTTP 实时数据验收（16 断言）
  - tests/fixtures/: 导入边界夹具 + stub Multica CLI
  - prototype/interaction-v6/: 交互重设计提案（v6 demo：主题聚合 / 需要我关注 / 执行段 / 详情抽屉，待用户验证）
  - reference-similar-projects.md: 同类项目调研对比（10+ 个开源观测工具，六维对比 + 差异化定位 + 可借鉴项）
---

# Agent 执行观测台 — INDEX

> 把本机多个 Agent 的执行任务汇总到同一条看板，避免漏任务：按 Agent 查全部任务，再按工作区分组（含默认分组），支持按执行 / 创建 / 最后更新时间排序；详情 7 个面板回答谁在跑、运行架构、每个 Agent 的任务与提示词、工作痕迹（技能 / MCP / 产出 / 网页 / 来源）、子 Agent 进度、结果落点、验证状态。v4 接入本机真实会话数据（Qoder CN / Codex / WorkBuddy / Trae CN / Claude Code，覆盖全部工作区，只读）；v5 新增任务与提示词面板、工作痕迹面板、架构节点检查器（悬停预览 / 点击固定）、看板泳道收纳与顶栏版本标记。执行日志的线索式组织参考 DSH 的产品设计，不是 DSH 插件运行时。

## 导航

- [index.html](index.html) — 监控台主入口，双击打开即用
- `http://agent-runner.localhost/` / `http://localhost/agent-runner/` — Nginx 入口
- [README.md](README.md) — 用法、7 问映射、真实数据来源、协作流程、Schema、部署、验收结果、已知边界
- [CHANGELOG.md](CHANGELOG.md) — 发版说明，与 [assets/version.js](assets/version.js) 同步
- [agent-observatory.html](agent-observatory.html) — v1 单文件看板，保留对照
- [scripts/real-data.mjs](scripts/real-data.mjs) — 本机真实会话采集
- [scripts/serve.mjs](scripts/serve.mjs) — 静态服务 + 真实数据 API + Multica 桥接
- [scripts/service.sh](scripts/service.sh) — 本地服务启停
- [tests/acceptance.mjs](tests/acceptance.mjs) — 演示数据功能验收
- [tests/real-acceptance.mjs](tests/real-acceptance.mjs) — 真实数据功能验收
- [tests/live-http.mjs](tests/live-http.mjs) — HTTP 实时数据验收
- [prototype/interaction-v6/index.html](prototype/interaction-v6/index.html) — v6 交互 demo（主题聚合视图，待验证）+ [DESIGN.md](prototype/interaction-v6/DESIGN.md) 设计哲学
- [reference-similar-projects.md](reference-similar-projects.md) — 同类项目调研对比（claude-hud / abtop / task-viewer / AgentSight 等 10+ 个，六维对比）

## 路由

| 关键词 | 原因 | 落点 |
|---|---|---|
| 打开监控台 / 看某 Agent 的全部任务 | 主入口与按 Agent 视图 | `index.html`、`index.html#/agent/<agentId>` |
| 默认工作区 / 按工作区分组 / 折叠分组 | Agent 视图的分组与默认桶 | `README.md` §2 + `assets/app.js` |
| 按执行时间 / 创建时间 / 最后更新时间排序 | 单 Agent 与全机两种排序入口 | `index.html#/agent/<agentId>`、`index.html#/all` |
| 全机任务汇总 / 跨 Agent 找任务 | 全部任务视图 | `index.html#/all` |
| 任务看板 / 六列分桶 / 独立面板 | 全局看板页与详情内看板面板 | `index.html#/board` + `assets/observatory.js` |
| 看板泳道收纳 / 每列条数 / 展开收起 | v5 收纳交互与口径 | `README.md` §2.5 + `assets/app.js` |
| 某 Agent 的任务与提示词 | v5 提示词面板（缺记录直说未记录） | `README.md` §2 + `assets/observatory.js` |
| 工作痕迹 / 技能 MCP 网页 来源 | v5 痕迹归纳与签名参数净化 | `README.md` §2 + `assets/observatory.js` |
| 架构节点检查器 / 悬停预览 / 点击固定 | v5 检查器交互 | `README.md` §2 + `assets/observatory.js` |
| 当前软件版本 / 更新说明 | v5 顶栏版本标记（单一事实源） | `assets/version.js` + `CHANGELOG.md` |
| 看某任务的主 Agent、Subagent、进度、产物、验证 | 单任务详情深链 | `index.html#/task/<taskId>` |
| 详情里切换到其他任务 / 前后导航 | 详情任务切换器 | `README.md` §2 + `assets/app.js` |
| 真实数据从哪来 / 加新 Agent 数据源 | 本机会话路径与采集边界 | `README.md` §5.1 + `scripts/real-data.mjs` |
| 关联 Multica / 派发子任务 / 写记忆 / 同步状态 | 协作面板与桥接 | `README.md` §3 + `scripts/serve.mjs` |
| 动态执行日志 / 线索式时间线 | 日志面板行为（参考 DSH 设计，非运行时） | `README.md` §4 + `assets/livelog.js` |
| 界面怎么用 / 5 个面板各回答什么 | 用法与判定口径 | `README.md` §1–§2 |
| 日志格式 / 加新演示任务 / 重新生成数据 | Schema 与确定性生成器 | `README.md` §5.2 + `scripts/gen-dataset.mjs` |
| Nginx 部署 / 实时刷新 / 事件摄取 | 两个本地入口、真实模式只读、演示模式可写 | `README.md` §5.5 + `scripts/service.sh` + `scripts/enable-nginx.sh` |
| 功能验收 / 回归 / 看截图 | 1555 演示 + 100 真实 + 16 实时 = 1671 项断言 | `tests/acceptance.mjs` + `tests/real-acceptance.mjs` + `tests/live-http.mjs` |
| 旧版单任务看板 | 留档对照 | `agent-observatory.html` |

## 核心关注

观测先于优化：没有执行日志和看板，成本、路由判对率都是嘴说。产品目标只有一句——**把所有 Agent 的任务汇总到同一条看板，不漏任务**。为此 v4 把入口拆成三个稳定维度：

- **Agent 维度**：侧栏列出本机 5 个 Agent 及任务数，进入后只看到该 Agent 的全部任务，再按工作区分组，没有工作区归属的任务落在「默认工作区」桶。
- **工作区维度**：同一 Agent 跨项目工作区并列展示，可折叠、可筛选计数，避免只在当前 workspace 里找任务。
- **时间维度**：单 Agent 支持按执行时间 / 创建时间排序；全机列表支持按创建时间 / 最后更新时间排序，先把最近活跃的任务顶上来。

详情层回答主 / 子 Agent、进度、产物、验证，并提供任务切换器与前后导航，不必退回列表再点。任务看板既是独立页面（`#/board`，六列分桶、泳道可收纳），也是详情里的独立面板，不依赖架构图。真实数据只读本机会话文件，服务只监听回环地址。

v5 把「这个 Agent 到底在干什么」落到可核对的层面：任务与提示词面板逐条摊开主 / 子 Agent 的指令（缺记录明说未记录，不按标题补写）；工作痕迹面板只统计日志里真实出现的技能、MCP、网页与附件，链接剥掉签名参数；架构节点检查器让悬停 / 点击节点即可看到该 Agent 的任务、提示词、进度与最近日志。提示词与痕迹的归纳规则同时被 vm 单测和真实数据验收覆盖。

验证纪律写进了渲染逻辑：未通过和待验证的产物不算可交付；未知或缺失的验证判定按待验证处理；失败任务的计划步骤不会因为主 Agent 结束就打成完成；合成协作事件只进日志，不改写历史耗时、成本与状态。看板层沿用 DSH 任务板的产品语义，但不冒充 DSH 运行时或真实裁判。

## 关联

- 起因：2026-10-25 对 JEV / Fable 短视频产品形态的分析（对话内，未单独成文）
- 上游：[v1 单文件看板](agent-observatory.html)（同一套 Schema 与 5 面板）
- 真实数据源：本机 Qoder CN / Codex / WorkBuddy / Trae CN / Claude Code 的会话与状态文件（只读，路径见 README §5.1）
- 外部系统：本地 Multica（`:3000` 前端 / `:8080` 后端），经 [scripts/serve.mjs](scripts/serve.mjs) 代理 CLI
- 部署入口：本机 `~/.localhost-proxy` 的 80 端口 Nginx（`agent-runner.localhost` 静态托管 + API 反代，`localhost/agent-runner/` 整站反代）
- 下游：真实采集扩到更多 Agent；用 hooks 补进程级事件；再用真实任务校准成本与判对率

## 总结复盘

- 2026-10-25 v5 交付：详情页扩到 7 个面板——「任务与提示词」（主 Agent 与每个 subagent 的任务内容、提示词与来源，缺记录明说未记录）、「工作痕迹」（技能 / MCP / 产出 / 网页查阅 / 来源，链接与图片只留主机与路径）；「运行架构」整行置顶并新增节点检查器（悬停预览、点击 / Enter / 空格固定，任务、提示词、进度、最近 9 条日志）；全局看板改泳道收纳（已完成任务进「已完成」列，每列默认 25 条，超出折叠「展开剩余 N 条」）；顶栏新增版本标记，单一事实源在 `assets/version.js`，与 `CHANGELOG.md` 同步。
- 2026-10-25 v5 检查器修复（验收驱动）：悬停预览时鼠标移向检查器里的「固定此 Agent」会触发 mouseleave → 重渲染 → 按钮被瞬掉，鼠标和键盘都用不到；改成指针 / 焦点进入检查器时保持预览、恢复动作延后一个宏任务，按钮可点、Tab 可固定。
- 2026-10-25 v5 验收：演示回归 1555/1555（+295：7 面板顺序、提示词行数 = Agent 数、痕迹四块结构、检查器悬停 / 点击 / 键盘、版本标记、看板收纳、vm 单测补提示词与痕迹归纳），真实数据 100/100（+23：看板段改 v5 泳道口径，新增提示词 / 痕迹 / 检查器段——扫 qoder 真实任务验证技能 / 网页 / 附件 / subagent 痕迹、链接无签名参数、附件事件只含文件名 + 域名、提示词非空），HTTP 实时 16/16，三套合计 1671 项 0 失败。
- 2026-10-25 v5 测试环境坑：vm 沙箱默认没有 `URL` 全局，`safeLink` / `hostOf` 全落空导致痕迹断言误报——沙箱要显式注入 `URL`，让 vm 环境贴近浏览器。
- 2026-10-25 v4 交付：接入本机真实会话数据，覆盖 Qoder CN / Codex / WorkBuddy / Trae CN / Claude Code 与全部工作区；Agent 视图按工作区分组并单列默认分组；支持执行 / 创建时间排序与全机创建 / 最后更新时间排序；新增 `#/board` 独立看板页与详情看板面板；详情页加入任务切换器与前后导航；执行日志文案统一为「参考 DSH 产品设计」，明确不依赖其运行时。
- 2026-10-25 v4 数据修复：Codex 恢复会话会新建 rollout 文件但复用原 session id，导致任务 id 重复、详情串线、搜索出现多行同一任务；现在用文件名里的恢复 UUID 加后缀，并加全局去重兜底，验收新增「任务 ID 全局唯一」断言。
- 2026-10-25 v4 验收：演示回归 1260/1260，真实数据 77/77，HTTP 实时 16/16，合计 1353 项断言 0 失败；真实验收期间冻结 UI 的 SSE 应用层，保证排序 / 分组断言与首屏快照一致。
- 2026-10-25 v3 交付：4 个 Agent × 4 个任务的仿真数据集（562 条事件），全部任务视图，子任务派发与 Multica 双向同步，线索式日志，Playwright 1107 项断言 0 失败。
- 2026-10-25 v3.1：读过 `@linxin666/dsh-client-ui-task-board` 0.4.8 源码后，把六列看板、子任务分列、验收门和 run/cron 派发回路接进架构图；新增 158 项断言，总验收 1265/1265。
- 2026-10-25 v3.2：挂到本机 80 端口 Nginx（`agent-runner.localhost` + `localhost/agent-runner/`），Node 8796 提供 SSE 与事件摄取；服务端每 1.5 秒比对数据文件 revision，页面原位刷新。新增 `live-http` 16 项断言，两套合计 1281/1281。
- 在线协作使用 stub CLI 验收，覆盖新建 / 关联 / 派发 / 状态回写 / 外部同步 / 父状态 / 记忆 / 解除关联；真实 Multica 写入仍需在测试 workspace 人工确认。
- 边界仍在前端和数据源：真实模式只读本机会话文件，不拦截 Agent 进程，没有 hooks 级事件；成本与路由判对率无法验证；本地关联只存在浏览器；看板层是产品语义参考，不是 DSH 插件运行时。
- 部署边界：Nginx 入口修改了本机共享的 `~/.localhost-proxy/nginx.conf`，已备份并校验语法；重载需要管理员权限，未在自动流程里执行。Node 服务目前由 `service.sh` 以 nohup 拉起，重启机器后要重新 start。
- 插件最值得抄的不是列 UI，而是「列由结算推导 + 执行记录 + 子任务级联 + 验收门拦截完成声明」这四件事的组合。

## 任务清单

- done：v1 单文件看板（5 面板 + 样例日志）
- done：v2 监控台（Agent 侧栏 + 任务列表 + 详情深链 + 本地导入）
- done：v3 加入 trae-cn + 全部任务视图（4 Agent / 16 任务）
- done：Multica 一键关联 / 子任务派发 / 状态同步 / 关联记忆
- done：线索式动态执行日志（组织方式参考 DSH 产品设计）
- done：dsh-task-board 看板语义 / 子任务分列 / 验收门接入（后独立成面板与页面）
- done：Playwright 演示验收 1260/1260（含 stub 桥接在线协作与看板实时分列）
- done：Nginx 双入口（`agent-runner.localhost` / `localhost/agent-runner/`）+ SSE 实时刷新 + 事件摄取
- done：HTTP 实时验收 16/16
- done：v4 真实数据接入（5 Agent / 全工作区 / 默认分组 / 只读）
- done：v4 工作区分组、执行与创建时间排序、全机创建与最后更新时间排序
- done：v4 独立任务看板页 `#/board` + 详情看板面板
- done：v4 详情任务切换器与前后导航
- done：v4 文案纠正（DSH 仅为设计参考）+ Codex 重复任务 ID 修复
- done：v4 真实数据验收 77/77，三套合计 1353/1353
- done：v5 任务与提示词面板 + 工作痕迹面板（技能 / MCP / 产出 / 网页 / 来源，链接去签名）
- done：v5 运行架构整行置顶 + 架构节点检查器（悬停预览 / 点击 / Enter / 空格固定）+ 检查器可点性修复
- done：v5 全局看板泳道收纳（已完成进泳道、每列 10/25/50/全部、展开剩余 / 收起）
- done：v5 顶栏版本标记（`assets/version.js` 单一事实源 + CHANGELOG 同步）
- done：v5 验收扩到 1555 + 100 + 16 = 1671 项断言 0 失败
- done：v5.0.1 README 改版（问题-价值-差异化开头 + 三张演示截图）+ 同类项目调研对比（reference-similar-projects.md）+ GitHub 开源发布
- todo：把 8796 服务做成 LaunchAgent 自启（当前 `service.sh` 手动启动）
- todo：真实 Multica workspace 写入验收
- todo：Claude Code hooks logger（PreToolUse / PostToolUse / failure）
- todo：真实采集扩到更多 Agent（Cursor / Windsurf 等）
- todo：20 个真实任务跑批，统计每决策成本 + 路由判对率

## 变更清单

- 2026-10-25 建目录：Schema + 仿真日志 + 单文件看板 v1（node 无头 + 浏览器快照验证）
- 2026-10-25 v2：新增 `index.html` + `assets/` 三件套 + 12 任务数据集 + 生成器 + 694 断言验收；修复审计问题
- 2026-10-25 文档回填：README 重写为 v2 用法 / 口径 / 验收；修正 v1 样例 fork 计数（41 → 6）与平均决策耗时
- 2026-10-25 v3：新增 trae-cn、全部任务视图、`store.js` / `multica.js` / `collab.js` / `livelog.js`、`serve.mjs` 桥接、16 任务数据集（562 事件）；验收扩至 1107 断言
- 2026-10-25 v3 修正：侧栏桥接状态、跟进滚动状态同步、Agent 过滤条结构；文档回填 4 Agent / 16 任务 / stub 验收边界
- 2026-10-25 v3.1：阅读 `@linxin666/dsh-client-ui-task-board` 0.4.8 源码；架构图新增看板列、子任务卡、验收门、run/cron 派发与 settle/verdict 回写；补 158 项断言至 1265，归档 `assets/task-board-arch.png`
- 2026-10-25 v3.2：新增 `assets/livedata.js`、`scripts/service.sh`、`scripts/enable-nginx.sh`、`deploy/nginx.conf.example`、`tests/live-http.mjs`；`serve.mjs` 默认端口改 8796 并增加 `/api/live/dataset|stream|events`；前端 API 基址改相对路径以兼容子路径部署；本机 Nginx 增加两个入口；验收 1265 + 16 = 1281
- 2026-10-25 v4：新增 `scripts/real-data.mjs`（5 Agent / 全工作区只读采集）与 `tests/real-acceptance.mjs`；`serve.mjs` 真实模式默认启用并新增 `/api/live/task` 懒加载详情；前端加入工作区分组 / 默认分组 / 时间排序 / 独立看板页 `#/board` / 详情看板面板 / 任务切换器；修复 Codex 恢复会话重复 id；README 与 INDEX 全面改写为真实数据口径，DSH 统一表述为设计参考；验收 1260 + 77 + 16 = 1353
- 2026-10-25 v5：`observatory.js` 新增 `collectTrace`（痕迹归纳）与提示词捕获（main 取首条 user_message、subagent 取 spawn 事件、回退首条 user_message）、`archInspectorHtml` / `promptPanelHtml` / `tracePanelHtml` / `wireArchitecture`，`renderPanels` 重排为 7 面板；`app.js` 看板页加每列条数选择器与泳道展开 / 收起、顶栏加 `versionChip` / `versionPopover`；新增 `assets/version.js`（版本单一事实源）与 `CHANGELOG.md`；`real-data.mjs` 补附件净化（只留文件名 + 域名）与 Claude Code 用户消息附件、subagent 展开；验收扩到 1555 + 100 + 16 = 1671；修复检查器「固定此 Agent」按钮在悬停预览下被瞬掉的问题
- 2026-10-26 v5.0.1（开源运营）：README 开头重写为「它解决什么问题 → 为什么不是又一个 Claude Code 面板 → 适合谁」结构，配三张演示截图（全部任务 / 任务详情 / 六列看板，`assets/screenshot-*.png`）；`tests/acceptance.mjs` 版本断言从硬编码 `5.0.0` 改为动态读 `OBS_VERSION.releases[0]`，避免每次发版误报；GitHub 仓库同步（README / CHANGELOG / version.js / acceptance.mjs / INDEX / 三张截图）
- 2026-10-26 v5.0.2（bug 修复 + 交互提案）：`real-data.mjs` 过滤 Codex 附属线程（auto-review 壳：无用户活动 / 无产物 → `meta.stub`），修复 eos-index 假「运行中 ×5」；Codex / Claude fallback 标题时间改本地格式（原 UTC 差 8 小时）；三套验收 1555 + 99 + 18 全绿。新增 `prototype/interaction-v6/`（ask-matt 路由到 /prototype 流程）：主题聚合视图 demo + DESIGN.md 设计哲学（三层漏斗 / 管理动作优先 / 未确认的完成不是完成 / 附属线程不是任务），待用户验证后改进正式代码。用户反馈「版本号没显示在页面上」→ 排查确认正式版顶栏 chip 一直在渲染（HTTP / file:// 双验证），根因指向长时间开着的旧标签页 / 旧缓存：`serve.mjs` 静态响应 no-cache 升级 no-store、live-http 加 2 条缓存头断言；v6 demo 顶栏补「版本 v5.0.1 · demo」标记；`assets/version.js` 正式发 v5.0.2（发版与 INDEX 记录对齐），8796 常驻服务已用双 fork 守护方式重启生效
