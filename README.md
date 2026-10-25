# Agent Runner · 执行监控台

**把本机所有 Agent 的执行任务收进同一条看板的开源小工具。** 无构建、纯静态前端（原生 HTML/CSS/JS，零依赖、零打包），Node 只做本地数据桥接。两种打开方式：双击 `index.html` 用内置演示数据离线浏览；或 `node scripts/serve.mjs` 起本地服务，只读采集本机 Qoder CN / Codex / WorkBuddy / Trae CN / Claude Code 五个 Agent 的真实会话。MIT 许可，见 [LICENSE](LICENSE)。

```bash
# 离线演示（无需任何安装）
open index.html            # macOS；Windows 直接双击

# 本机真实数据（默认 127.0.0.1:8796，只读）
node scripts/serve.mjs     # 然后 http://127.0.0.1:8796
```

> **隐私边界**：真实模式读的是各 Agent 自己的会话存储（含提示词、路径、代码片段），服务只绑 `127.0.0.1`、没有账号体系——不要把这些入口暴露到局域网或公网。仓库里只有演示数据；`assets/version.js` 与 `CHANGELOG.md` 是版本与发版说明的单一事实源。

把本机所有 Agent 的任务收进同一个视图：左侧按 Agent 切换，列表按真实工作区分组（含「默认工作区」），可全局按更新时间 / 创建时间 / 执行时间排序；任务看板是独立页面与独立面板；点进详情能直接切换到任何 Agent 的任何任务。详情页 7 个面板回答谁在跑、架构怎样、每个 Agent 的任务与提示词、用过什么工具、进度如何、结果落在哪里、是否待验证；顶栏版本标记标出当前软件版本，点开看本次更新说明。通过 Nginx 或本地 Node 服务打开时，默认采集本机真实会话（Qoder CN / Codex / WorkBuddy / Trae CN / Claude Code），只读且仅监听 `127.0.0.1`。双击 `index.html` 仍可用打包的演示数据离线浏览，不需要构建。

内置一套 4 个 Agent、16 个任务的仿真日志（562 条事件：8 已完成 / 4 运行中 / 3 失败 / 1 已取消），用于 `file://` 离线演示和确定性回归；真实模式的数据来自各 Agent 自己的会话存储，不经过这套仿真数据。

> 执行日志的线索式时间线、详情页看板与验收门的**组织方式参考了 DSH 的产品设计**，不是 DSH 插件运行时：本页不安装、不执行 `dsh-task-board` / `dsh-llm-verifier`，也不读取 DSH 的 Host 账本。

## 1. 怎么用

### 本地服务（推荐）

```bash
node scripts/serve.mjs            # 默认 http://127.0.0.1:8796
node scripts/serve.mjs --port 8898
```

不带 `OBS_DATA_DIR` 启动时是**真实数据模式**：服务端只读扫描本机 5 个 Agent 的会话存储，列表只返回元数据，点开任务时再懒加载日志。目录位置可用 `OBS_QODER_DIR` / `OBS_CODEX_DIR` / `OBS_WORKBUDDY_DB` / `OBS_TRAE_DIR` / `OBS_CLAUDE_DIR` 覆盖。

想复现演示数据：

```bash
OBS_DATA_DIR=data node scripts/serve.mjs --port 8796
```

### 挂到本机 Nginx（可选）

开发机上把它挂到了 80 端口的本地代理下，两个地址等价（换机器部署见 §5.5）：

- `http://agent-runner.localhost/`
- `http://localhost/agent-runner/`

```bash
scripts/service.sh start        # 默认 127.0.0.1:8796，日志在 .run/agent-runner.log
scripts/service.sh status
```

`agent-runner.localhost` 由 Nginx 直接托管静态文件，`/api/` 反代到 8796；`localhost/agent-runner/` 整站反代到同一个后端。两个入口共用同一份数据与桥接。

### 找任务的路径

1. **按 Agent**：左侧选 `qoder-cn`、`codex`、`workbuddy`、`trae-cn`、`claude-code`，列表默认按工作区分组；没有任何 cwd 的任务进入「默认工作区」。
2. **按工作区**：列表上方可切「按工作区分组 / 不分组 · 全局排序」，也可用工作区下拉只看某个目录。
3. **按时间**：每个 Agent 和「全部任务」都支持最近更新、最近创建、最近执行、耗时最长、消耗最高五种排序。
4. **看板**：左侧「任务看板」是独立页面，六列覆盖全部任务；可再按 Agent、工作区、关键词过滤。
5. **详情**：点任务进入 `#/task/<taskId>`；详情头部有跨 Agent 任务切换器，并可用「上一条 / 下一条」在同一 Agent 内翻任务。刷新后仍停在同一页。
6. **重命名 / 补充说明**：离线模式或真实模式下都可从顶栏「＋ 载入日志」导入本地 `.jsonl`，归到 `local` Agent；导入只存浏览器内存。

真实模式是只读的：会话由各 Agent 自己写入，页面不会修改原始记录，也不提供 `/api/live/events` 追加。

### 连 Multica（本地桥接）

```bash
node scripts/serve.mjs            # 默认 http://127.0.0.1:8796
node scripts/serve.mjs --port 8898
```

然后从 `http://127.0.0.1:8796` 打开页面。这个脚本同时托管静态文件、推送实时数据并代理 Multica CLI：

- 只绑定 `127.0.0.1`，不对外网开放。
- Multica token 只由本机 CLI 从 `~/.multica/config.json` 读取，浏览器拿不到。
- 桥接离线时，关联与派发按钮禁用；本地子任务仍可记录。
- 关联成功后页面每 30 秒轮询一次父 issue 的子任务变化；也可手动点「刷新子任务」。

## 2. 详情页回答的 7 个问题

详情页共 7 个通栏面板，按提问顺序排列：

| 问题 | 面板 | 看什么 |
|---|---|---|
| ① 运行架构怎样 | ① 运行架构（整行置顶） | 分层 SVG：主会话 → advisor / fork 路由 → subagents → 产物区 → 验收门，连线标真实决策次数、派发回路与结算路径；悬停 / 点击节点出检查器：该 Agent 的任务内容、提示词、执行进度与最近 9 条日志，运行中随数据刷新 |
| ② 有多少 Agent 在跑 | ② 有多少 Agent 在执行 | 每个 Agent 的角色（主 / router / advisor / subagent）、模型、状态、token、成本、错误数、被干预次数 |
| ③ 每个 Agent 在做什么、收到什么指令 | ③ 任务与提示词 | 主 Agent 与每个 subagent 的任务内容与提示词逐条摊开，标注提示词来源；日志没记录就明说「未记录」，不按标题补写 |
| ④ 用过什么工具、查过什么 | ④ 工作痕迹 | 从事件流归纳技能 / MCP 工具 / 产出 / 网页查阅 / 来源，逐条带次数与结果摘要；链接与图片地址去掉签名参数，只留主机与路径 |
| ⑤ 任务看板 | ⑤ 任务看板 | 当前任务与已派发子任务各在哪一列；六列口径见 §2.5 |
| ⑥ Subagent 进度如何 | ⑥ 执行进度 | 甘特时间线 + 计划步骤：每个 Agent 的活跃区间、✗ 报错点、◆ 干预点；计划步骤按 owner 是否完成打勾 |
| ⑦ 结果放在哪里、是否待验证 | ⑦ 生成的结果放在哪里 + 是否待验证 | 产物表：类型、落点路径、生成者、发布时间、✓ 通过 / ✗ 未通过 / ⏳ 待验证与验证证据；未过和待验证会进「收工遗留」 |

详情头部还有一个跨 Agent 任务切换器（按 Agent 分组列出全部任务，带工作区与更新时间）和同 Agent 上一条 / 下一条按钮；切换任务不会返回列表。

判定口径：

- **任务状态**优先取主 Agent 的 `agent_finished`：`shipped` / `done` 显示为已完成，`failed`、`canceled` 原样显示。没有结束事件但已有 `session_summary` 也算已完成；两者都没有才是运行中。
- **产物验证**对同一 `target` 取最后一次 `verification`。没有验证事件、或判定值不是 `pass` / `fail`，一律算待验证，不默认通过。
- 未通过和待验证的产物不会被描述成可交付；失败任务的计划步骤也不会因为主 Agent 结束就被打成完成。
- 运行中任务的耗时标「日志跨度」，表示首末事件的时间差，不是实际 wall clock。
- 合成事件（关联、子任务、记忆）只追加到日志和事件流，不参与历史任务的耗时、成本与状态派生。

## 2.5 任务看板：独立页面 + 详情独立面板

看板不再缝在架构图里，有两条入口：

- **全局看板**：左侧「任务看板」进入 `#/board`，六列铺开全部任务（含已完成），支持按 Agent、工作区、任务 ID / 标题过滤；每列可切 10 / 25 / 50 / 全部条数，默认 25 条，超出折叠成「展开剩余 N 条」，展开后可收起。
- **任务看板面板**：详情页 ⑤ 只放当前任务和它派发的子任务，脚注显示「子任务 n/N 完成」。

六列与判定口径：

| 列 | 进入条件 |
|---|---|
| 待办 | `todo` / `backlog` / `pending` |
| 进行中 | `running`，或其他未命中下列规则的状态 |
| 待确认 | 已完成，但仍有产物未验证（`completed` + `pending > 0`） |
| 已完成 | 已完成且没有待验证产物 |
| 已停止 / 取消 | `canceled` / `cancelled` / `idle` / `archived` / `stopped` / `paused` / `blocked` |
| 失败 | `failed` |

取消和停止的任务不会混进失败列。子任务状态 `backlog` → 待办，`todo` → 待办，`in_progress` / `in_review` / `blocked` → 进行中，`done` / `completed` → 已完成，`cancelled` → 已停止 / 取消。

**设计参考而非运行时**：看板「列由结算推导、子任务树级联、验收门拦截完成声明」这套组织方式，参考了社区包 `@linxin666/dsh-client-ui-task-board` 0.4.8（Apache-2.0）的产品设计。本页没有安装或执行该插件，不持有 DSH Host 账本，也不调用 `dsh-llm-verifier`；看板列和验收门里的通过 / 未过 / 待验证计数来自本页自己的 `verification` 事件，不能当作插件的真实裁判结论。

## 3. 协作：关联、派发、记忆

- **一键关联**：为当前任务新建 Multica 父 issue，自动写 `work-space` / 状态 / 类型标签、任务元数据和一段记忆评论；也可以搜索并关联已有 issue。
- **子任务派发**：在已关联的父 issue 下创建 child issue，支持标题、描述、负责人（Multica agent）、阶段和初始状态。未关联时只能「仅记录本地」。
- **状态同步**：改本地子任务状态会回写 child issue；「刷新子任务」会拉回外部新增的 child 和状态变化；父 issue 状态也可在面板里更新。
- **关联记忆**：生成包含 `task_id`、父 issue、子任务进度和更新协议的文本，可复制，也可写入父 issue 评论。其他 Agent 拿到这段上下文能接上同一任务。
- **解除关联**：只删除浏览器本地记录，不删远端 issue。

协作字段与映射：

| 项 | 值 |
|---|---|
| 父 issue 元数据 | `task_id`、`task_dir`、`runner_agent`、`runner_repo`、`runner_link_source` |
| child issue 元数据 | `runner_parent_task_id`、`runner_parent_issue`、`runner_origin=subtask` |
| 子任务状态 | `backlog` / `todo` / `in_progress` / `in_review` / `blocked` / `done` / `cancelled` |
| 本地持久化 | `localStorage` 键 `agentRunner.state.v2`，含 links / subtasks / events / versions |

## 4. 执行日志（线索式时间线，参考 DSH 设计）

每条日志显示时间、来源 Agent、类型、摘要，可展开原始 JSON。界面组织参考 DSH 的线索视图，**不依赖 DSH 运行时**：数据全部来自本页自己的事件模型（仿真 JSONL 或真实会话解析结果）。

- 运行中任务从尾部开始逐步放出，模拟实时滚动；放完后显示“已跟上最新日志，等待新事件”。
- 控制条支持暂停 / 继续、重播、0.5×–4× 和即时速度、跟随滚动、跳到底部。
- 按 Agent、事件类型、关键词筛选，计数同步变化。
- 用户上滚会自动关闭跟随，手动开启后回到底部。
- 本地协作与桥接事件即时追加，带「合成」标记；历史日志保持原样。
- 真实模式打开任务时，服务端才按需读取并解析该会话文件；大日志只载入最近事件，并在面板注明。

## 5. 数据与日志格式

页面有两种数据模式，界面与派生逻辑相同。

### 5.1 真实数据（`serve.mjs` 默认）

服务端只读扫描本机会话存储，列表只返回元数据；点开任务时才按需读取和解析原始日志。

| Agent | 本机存储 | 读取内容 |
|---|---|---|
| Qoder CN | `~/.qoder-cn/projects/<project>/<sessionId>.jsonl` + `state.json` | 对话、工具调用、产物、subagent 轨迹 |
| Codex | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` | 会话元数据、turn、工具调用、token |
| WorkBuddy | `~/.workbuddy/workbuddy.db`（SQLite）+ `audit-log/*.jsonl` | 会话标题 / cwd / 状态、用量、命令审计 |
| Trae CN | `~/Library/Application Support/Trae CN/User/workspaceStorage/<hash>/state.vscdb` | 工作区对话与状态 |
| Claude Code | `~/.claude/projects/*/*.jsonl` | 对话、工具调用、产物、subagent |

- **工作区**：优先使用会话记录的真实 cwd；Qoder / WorkBuddy 的按会话拆分目录归并到各自的默认根目录；没有 cwd 的任务进入「默认工作区」。
- **状态**：只使用 `running` / `completed` / `idle` / `failed` / `canceled` 五类，不从标题或产物数量推断成功。
- **只读**：真实模式下 `POST /api/live/events` 返回 409，页面不会回写任何原始会话。
- **隐私**：日志里可能包含路径、提示词和代码片段。服务默认只绑 `127.0.0.1`，没有账号体系，不要把这些入口暴露到局域网或公网。
- **任务 ID**：真实任务按「来源 + 会话文件」生成稳定 ID；Codex 恢复会话会追加文件名里的唯一后缀，避免多个任务共用 ID、详情串线。

### 5.2 演示数据（`OBS_DATA_DIR=data` 或 `file://`）

| 文件 | 内容 |
|---|---|
| `data/catalog.json` | Agent 与任务的元数据（标题、仓库、模型、状态、成本） |
| `data/sessions/*.jsonl` | 16 份任务日志（4 Agent × 4 任务；562 条事件） |
| `data/dataset.js` | 把同一份数据打包成 `window.OBS_DATASET`，让 `file://` 不用 fetch 也能加载 |
| `data/sample-session.jsonl` | v1 单文件看板用的旧样例，保留对照 |

重新生成演示数据（确定性，不联网）：

```bash
node scripts/gen-dataset.mjs
```

脚本会重写 `data/sessions/`、`data/dataset.js`、`data/catalog.json`，并打印每个任务的 Agent 数、fork 次数和验证分布。

### 日志 Schema

JSONL 一行一个事件：

```
{ ts, seq, src, type, data }
```

`src` 是事件发出者（`main` / `router` / `advisor` / 各 subagent id）。真实日志使用 17 类事件：

- 会话：`session_start`、`plan`、`merge`、`session_summary`
- Agent 生命周期：`agent_spawned`、`subagent_state`、`agent_finished`
- 路由层：`fork_decision`、`fork_summary`
- 执行：`tool_call`、`tool_result`、`error`、`retry`
- 复核：`advisor_note`、`advisor_summary`
- 产出：`result_emitted`、`verification`

本地协作额外产生 7 类合成事件：`multica_linked`、`multica_sync`、`multica_subtask`、`subtask_created`、`subtask_status`、`subtask_removed`、`memory_written`。这些事件只进日志，不改写历史派生值。

两条硬约束：

1. 任何写入磁盘的产物必须有一条 `result_emitted`，写清 `path` 落点和 `created_by`。
2. 收工前主会话必须对每个产物发一条 `verification`，带 `method` 和 `evidence`；没发就显示待验证。

解析时坏行只跳过该行，全部无效才提示「没有载入任何日志」，不会新建空 Agent。

## 5.5 Nginx 部署与实时数据

### 请求链路

```
浏览器 ── Nginx :80 ──┬── 静态文件（agent-runner.localhost）
                      └── /api/ ── Node :8796 ──┬─ 真实模式：本机 5 个 Agent 会话存储（只读、详情懒加载）
                                                 ├─ 演示模式：data/
                                                 └─ Multica CLI（token 不出服务端）
```

真实模式不把几百 MB 会话塞进首屏：`/api/live/dataset` 只返回任务元数据与统计，SSE 每 1.5 秒检查一次 revision（服务端最多每 5 秒重建一次 catalog），页面收到变化后原位更新列表。点开任务时才调用 `/api/live/task` 读取该会话，日志过大时只载入最近事件并标记 `partial`。SSE 每 20 秒发一次心跳，断线由浏览器自动重连。

演示模式则 `stat` `catalog.json` 和 16 份 JSONL，用「mtime + 总字节数 + 文件数」算 revision，变化时推 `change`。

### 实时接口

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/live/dataset` | 任务元数据 + Agent + 工作区 + revision，`no-store` |
| GET | `/api/live/task?id=<taskId>` | 单个任务的真实事件、transcript 路径与 partial 标记 |
| GET | `/api/live/stream` | SSE；`ready` 帧带初始 revision，之后每次变化推 `change` |
| POST | `/api/live/events` | 仅演示模式：向某个任务的 JSONL 追加事件，写盘后触发 SSE；真实模式返回 409 |

演示模式下追加事件示例（`taskId` 必须是 catalog 里已有的任务）：

```bash
curl -sS -X POST http://agent-runner.localhost/api/live/events \
  -H 'Content-Type: application/json' \
  -d '{"taskId":"qcn-config-layering","events":[{"src":"main","type":"tool_call","data":{"tool":"live-test"}}]}'
```

服务会补 `ts` 和递增 `seq`，单次最多 500 条，请求体上限 256 KB。`taskId` 走白名单正则并校验 catalog，防止路径穿越。真实模式没有这个写入口，所有日志只由 Agent 自己写入。

### 换一台机器部署

1. 把 `deploy/nginx.conf.example` 的 `root` 改成项目绝对路径，端口按需调整。
2. `PORT=8796 scripts/service.sh start`，Nginx 的 `/api/` 指向同一端口。
3. 项目不依赖构建产物；`file://` 仍可直接打开，Nginx 只是让页面变成同源 Web 服务并支持实时刷新。

### 实时边界

- 只监听本机和磁盘文件，没有账号体系；真实会话含提示词与路径，不要把这些入口暴露到局域网或公网。
- 真实模式的“实时”指本机会话文件变化后秒级刷新，不是拦截 Agent 进程或 hooks 事件。
- 演示模式才允许 `/api/live/events` 写盘；真实模式只读，外部 runner 若要接自己的日志，应走演示数据目录或新增独立数据源。
- 浏览器里的关联、子任务和合成事件仍只存 `localStorage`，不随 SSE 广播给其他浏览器。

## 6. 验收

```bash
node tests/acceptance.mjs        # 演示数据 + stub 桥接
node tests/acceptance.mjs --verbose
node tests/live-http.mjs         # HTTP / SSE 实时链路
node tests/real-acceptance.mjs   # 本机真实会话数据
```

`acceptance.mjs` 用系统 Chrome（headless），先跑 `file://` 离线用例，再自起一个随机端口的桥接 + stub Multica CLI 跑在线协作。数据校验走独立解析器，不经过前端模型代码；模型边界另用 `vm` 单测覆盖。

`live-http.mjs` 复制一份临时数据，自起随机端口的 Node 服务，验证页面能连上 SSE、收到新追加事件并增量刷新，同时检查非法 `taskId` 和未知任务的错误码。

`real-acceptance.mjs` 显式清掉 `OBS_DATA_DIR` / `OBS_SOURCE` 强制走真实模式，自起独立服务读取本机 Qoder / Codex / WorkBuddy / Trae / Claude Code 会话，核对 Agent 与工作区归属、默认分组、时间排序、全局列表、独立看板、详情切换和真实日志懒加载。测试期间会冻结 UI 的 SSE 应用层，避免本机正在写入的会话让断言和快照错位。

最近一次结果：**三套合计 1671 项断言全部通过，0 失败，无 console / page error**（演示回归 1555 + 真实数据 100 + HTTP 实时 16）。

| 范围 | 断言数 | 验了什么 |
|---|---|---|
| 数据完整性 | 176 | 16 份日志可独立解析，Agent / fork / 验证分布 / 成本与 catalog 一致 |
| 模型边界 | 18 | 状态归一化、坏时间戳、合成事件排序与耗时隔离、缺验证兜底；v5 提示词捕获（main 首条 user_message / spawn 事件 / 回退）与痕迹归纳（技能 / MCP / 网页 / 来源、链接去签名） |
| 页面骨架 | 31 | 4 个 Agent 侧栏、角标、全部任务入口、默认路由、统计与列表 |
| 全部任务视图 | 20 | 16 行、默认顺序、统计、Agent 过滤、状态过滤、搜索、成本排序 |
| 单 Agent 视图 | 24 | 4 个 Agent 的任务集合、页头、筛选、搜索、排序、跨 Agent 切换重置 |
| 导航与深链 | 18 | `#/agent`、`#/task`、`#/all`、`#/board`、刷新保持、返回、未知 id 回退 |
| 16 个任务详情 | 985 | 标题、状态、元信息、Agent 卡、架构图、六列看板（独立面板）、验收门、甘特、计划、产物与验证逐项核对；v5 追加 7 面板顺序与通栏 / 架构面板置顶、提示词面板行数 = Agent 数、痕迹四块结构与汇总条、检查器默认态 |
| 架构节点检查器 | 16 | 悬停预览、移开恢复、点击固定、Enter / 空格固定、提示词行联动固定、检查器内固定按钮、四区内容、重渲染后选择保留 |
| 顶栏版本标记 | 10 | 版本号与 `assets/version.js` 单一事实源一致、弹层说明与历史版本、Escape / 点击别处关闭 |
| 详情页交互 | 11 | 任务切换器、前后导航、跨 Agent 跳转与看板同步 |
| 线索式执行日志 | 29 | 动态放出、暂停继续、重播、即时模式、跟随滚动、三类筛选、合成标记（组织方式参考 DSH，不依赖其运行时） |
| 协作面板离线 | 33 | 禁用态与原因、本地子任务增删改、看板列同步、合成日志、localStorage 持久化 |
| 本地 JSONL 导入 | 19 | 混合坏行、全坏文件、待验证兜底、local Agent 生成 |
| 全局看板泳道收纳 | 19 | 已完成任务进泳道、每列 10 / 25 / 全部切换、超出折叠「展开剩余」、展开后收起、脚注同步 |
| 桥接直接 API | 53 | status / agents / issues / issue / link / subtask / PATCH / memory 与错误码 |
| 协作面板在线 | 79 | 新建与已有 issue 关联、派发 child、状态回写、外部同步、父状态、记忆、解除关联、看板分列 |
| 响应式 | 12 | 820px / 390px 无页面级横向滚动，协作与日志面板改为单列 |
| 运行期错误 | 2 | 全程无 `pageerror` / `console.error` |
| HTTP 实时数据 | 16 | SSE 连接、快照结构、事件追加、页面增量刷新、非法请求拒绝 |
| 真实数据 API | 28 | 5 个 Agent、工作区归属、默认分组、状态分布、任务 ID 全局唯一、懒加载详情 |
| 真实数据 UI · 分组 | 11 | 按工作区分组、默认分组、组内计数与折叠 |
| 真实数据 UI · 排序 | 3 | 工作区过滤、按执行时间 / 创建时间排序 |
| 真实数据 UI · 全局 | 8 | 全机任务列表、按创建 / 最后更新时间排序、行数与角标一致 |
| 真实数据 UI · 看板 | 16 | 独立看板页六列分桶、列计数与可见数、每列 25 条上限、done 列展开 / 收起、切「全部」全量渲染、取消不混失败列 |
| 真实数据 UI · 详情 | 16 | 详情任务切换、前后导航、真实 transcript 懒加载与线索流渲染 |
| 真实数据 UI · 提示词与痕迹 | 16 | 真实任务扫出技能 / 网页 / 附件 / subagent 痕迹、痕迹四块与汇总计数、链接无签名参数、附件事件只含文件名 + 域名、提示词来自日志且非空、检查器悬停 / 点击 |
| 真实数据运行期 | 2 | 全程无 `pageerror` / `console.error` |

截图写到 `/tmp/agent-runner-acceptance/`（演示）和 `/tmp/agent-runner-real-acceptance/`（真实数据），包含分组列表、全局看板、详情切换和移动端布局；`assets/task-board-arch.png` 是 v3 架构图局部截图，仅作历史留档。

**验收边界**：在线写操作使用 `tests/fixtures/stub-multica`，状态落在临时 JSON 文件，不触碰真实 Multica 工作区；真实 CLI 只做过只读连通性检查。真实数据验收只读本机会话文件，不验证 Agent 进程拦截或 hooks。要验证真实 Multica 写入，需要人工在一个测试 workspace 里跑一次并确认结果。

## 7. 文件结构

```
index.html                 监控台外壳（侧栏 + 顶栏 + 视图容器）
assets/app.css             设计系统、双栏布局、详情面板、协作与日志样式
assets/app.js              列表、筛选、哈希路由、详情渲染、日志导入、版本标记与看板收纳
assets/observatory.js      日志解析、模型派生、7 个面板渲染（window.Observatory）
assets/store.js            本地关联 / 子任务 / 合成事件的 localStorage 层
assets/multica.js          桥接客户端（只访问同源 /api/bridge/*）
assets/collab.js           协作面板：关联、派发、同步、记忆
assets/livelog.js          线索式执行日志（动态放出 / 重播 / 筛选；参考 DSH 设计，不依赖其运行时）
assets/livedata.js         实时数据订阅（SSE 通知 + 快照原位刷新）
assets/version.js          版本单一事实源（releases v1→v5.0.0），顶栏版本标记读这里
CHANGELOG.md               发版说明，与 assets/version.js 同步维护
assets/task-board-arch.png v3 架构图局部截图（历史留档；现行看板已独立成面板）
data/dataset.js            内嵌演示数据集（window.OBS_DATASET）
data/catalog.json          演示数据的元数据版本
data/sessions/*.jsonl      16 份演示任务日志
data/sample-session.jsonl  v1 单文件看板样例
scripts/gen-dataset.mjs    确定性演示数据生成器
scripts/real-data.mjs      本机真实会话采集（Qoder / Codex / WorkBuddy / Trae / Claude Code，只读）
scripts/serve.mjs          静态服务 + 实时 SSE + 真实数据 API + Multica CLI 桥接（仅 127.0.0.1）
scripts/service.sh         本地服务 start / stop / restart / status（默认 8796）
scripts/enable-nginx.sh    重载本机 80 端口 Nginx 并验证两个入口
deploy/nginx.conf.example  通用 Nginx 部署配置
tests/acceptance.mjs       Playwright 演示数据 + stub 桥接功能验收
tests/real-acceptance.mjs  Playwright 真实数据验收（工作区 / 排序 / 看板 / 详情切换）
tests/live-http.mjs        HTTP 实时数据验收
tests/fixtures/            导入边界夹具 + stub Multica CLI
agent-observatory.html     v1 单文件看板（旧版，保留对照）
```

## 8. 边界与下一步

- **真实数据只读、只在本机**：服务默认只绑 `127.0.0.1`，没有鉴权；真实会话可能含私有提示词、路径和代码，不要暴露到局域网或公网。
- **不是 Agent 进程监控**：列表与刷新来自会话文件（SQLite / JSONL / state.vscdb），不是 hooks 或进程级事件；Agent 正在写入时会话可能处于 `running`，但拿不到实时 stdout。
- **成本字段不完整**：真实会话大多没有账单字段，`cost` 为 0，能读到的 credits / token 才展示；不要把它当账单对账。
- **本地状态在浏览器里**：换浏览器或清 localStorage 会丢失关联和子任务记录；远端 issue 不受影响。
- **真实写入未验收**：在线协作只对着 stub CLI 验过；真实 Multica 的标签、阶段、状态映射还需要在测试 workspace 跑一轮。
- **看板是设计参考**：复用了 `dsh-task-board` 的列由结算推导、子任务级联与验收门语义，但没有安装插件、没有 Host 账本、也没有调用真实裁判；要验证插件本身，需在 DSH 里安装后跑真实任务。
- **下一步**：补 Claude Code / Codex hooks 实时事件；把 8796 服务做成 LaunchAgent 自启；跑一批真实任务校准成本与判对率；在测试 workspace 验证一次真实 Multica 写入。
- **开源发布**：v5.0.0 起以 MIT 许可发布在 GitHub（`davis1214/agent-runner-observatory`）；发布前已审计——仓库只含演示数据与代码，`.run/`（本机服务日志、截图、临时脚本）不进仓库，真实会话的提示词、路径与签名 URL 不出本机。
