/* Agent Runner · 版本信息（UI 读这里）
 * 发版流程：① 在这里加一条 releases（最新放最前）② 同步 CHANGELOG.md 同名条目
 * ③ 跑 tests/acceptance.mjs，脚本会断言顶栏版本号 = releases[0].version。
 */
(function () {
  'use strict';

  const releases = [
    {
      version: '5.0.2',
      released: '2026-10-26',
      headline: '假「运行中」修复 + 缓存加固',
      notes: [
        '修复 Codex 分类页假「运行中」：桌面端为 auto-review 开的附属线程壳（无用户活动、无产物）不再被当成独立任务；工作区任务列表只剩真实执行会话。',
        '修复任务标题里的时间显示：Codex / Claude 的兜底标题从 UTC 改为本地时间（原来差 8 小时）。',
        '缓存加固：页面与静态资源响应改发 Cache-Control: no-store，长时间开着的旧标签页不再停留在老 UI（曾导致顶栏版本号「消失」）；live-http 验收新增缓存头断言。',
        'v6 交互提案 demo（prototype/interaction-v6/）顶栏补版本号标记。',
      ],
    },
    {
      version: '5.0.1',
      released: '2026-10-26',
      headline: 'README 改版 + 演示截图',
      notes: [
        'README 重写开头：先讲它解决的四个问题（任务是黑盒 / 任务会漏 / 提示词不可见 / 产物没人验），再讲与同类工具的差异与适用人群，第一次看到这个项目的人能快速判断要不要用。',
        'README 补三张演示数据截图：全部任务列表、任务详情（架构 + 提示词 + 痕迹 + 产物验证）、六列看板。',
        '无产品功能变更，版本号随文档改版 +0.0.1。',
      ],
    },
    {
      version: '5.0.0',
      released: '2026-10-25',
      headline: '工作痕迹面板 + 架构节点检查器',
      notes: [
        '详情页新增「任务与提示词」：主 Agent 与每个 subagent 的任务内容、提示词、提示词来源都摊开，缺记录就明说日志未记录。',
        '详情页新增「工作痕迹」：从真实事件流归纳技能 / MCP 工具 / 产出 / 网页查阅 / 来源，图片与链接去掉签名参数只留主机与路径。',
        '「运行架构」整行置顶，「有多少 Agent 在执行」移到它下面；悬停或点击架构节点即出检查器：任务、提示词、执行进度、最近日志，随数据动态刷新。',
        '全局任务看板改成泳道可收纳：已完成任务留在「已完成」列，每列默认 25 条，超出折叠成「展开剩余 N 条」，可切 10 / 25 / 50 / 全部。',
        '顶栏新增版本号标记，点开即看本次更新说明与历史版本。',
        '真实采集补齐：Qoder CN / Claude Code 的 subagent 提示词、用户附件与图片块（只取文件名与域名）。',
        '检查器修复：指针从架构节点移进检查器时保持预览，「固定此 Agent」按钮不再被重渲染瞬掉；键盘 Tab 同样可固定。',
      ],
    },
    {
      version: '4.0.0',
      released: '2026-10-25',
      headline: '本机真实会话接入 + 独立任务看板',
      notes: [
        '默认读本机真实数据：Qoder CN / Codex / WorkBuddy / Trae CN / Claude Code，覆盖全部工作区，只读不回写。',
        'Agent 视图按工作区分组并单列默认分组；支持按执行 / 创建 / 最后更新时间排序，全机任务同样可排。',
        '新增 `#/board` 独立看板页与详情看板面板；详情页加任务切换器与前后导航。',
        '修复 Codex 恢复会话复用 session id 导致的任务 ID 重复与详情串线。',
        '执行日志文案统一为「参考 DSH 产品设计」，明确不依赖其运行时。',
      ],
    },
    {
      version: '3.2.0',
      released: '2026-10-25',
      headline: 'Nginx 本地入口 + SSE 原位刷新',
      notes: [
        '挂到本机 80 端口 Nginx：`agent-runner.localhost` 与 `localhost/agent-runner/` 两个入口。',
        'Node 8796 提供 `/api/live/dataset|stream|events`，服务端每 1.5 秒比对数据 revision，页面原位刷新。',
      ],
    },
    {
      version: '3.1.0',
      released: '2026-10-25',
      headline: '看板列与验收门进架构图',
      notes: [
        '读过一个 DSH 任务看板插件的源码后，把六列看板、子任务分列、验收门与 settle 回写接进架构图（仅产品语义参考）。',
      ],
    },
    {
      version: '3.0.0',
      released: '2026-10-25',
      headline: 'Trae CN + 全部任务视图 + Multica 协作',
      notes: [
        '4 个 Agent × 4 个任务的仿真数据集（562 条事件），全部任务视图。',
        '子任务派发、一键关联 Multica、状态同步与关联记忆；线索式执行日志支持动态放出与重播。',
      ],
    },
    {
      version: '2.0.0',
      released: '2026-10-25',
      headline: '监控台成型',
      notes: ['Agent 侧栏 + 任务列表 + 详情深链 + 本地 .jsonl 载入。'],
    },
    {
      version: '1.0.0',
      released: '2026-10-25',
      headline: '首版单文件看板',
      notes: ['执行日志 Schema + 5 个面板的静态看板，回答谁在跑、架构、进度、结果落点、是否待验证。'],
    },
  ];

  window.OBS_VERSION = {
    product: 'Agent Runner',
    tagline: '执行监控台',
    releases,
    get current() { return releases[0]; },
    get version() { return releases[0].version; },
    get released() { return releases[0].released; },
    get headline() { return releases[0].headline; },
  };
})();
