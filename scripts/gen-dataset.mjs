#!/usr/bin/env node
// 生成 16 个任务的演示会话日志（JSONL）+ dataset.js 打包
// 运行：node scripts/gen-dataset.mjs
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SESS = path.join(ROOT, 'data', 'sessions');
fs.mkdirSync(SESS, { recursive: true });

const AGENTS = [
  { id: 'qoder-cn', name: 'qoder-cn', vendor: 'Qoder', model: 'opus 4.6', accent: '#c792ea', desc: '本地旗舰模型，擅长长任务与多文件重构' },
  { id: 'codex', name: 'codex', vendor: 'OpenAI', model: 'gpt-5.1-codex', accent: '#4dd0e1', desc: 'CLI 与基础设施任务的默认执行器' },
  { id: 'workbuddy', name: 'workbuddy', vendor: 'WorkBuddy', model: 'sonnet 4.6', accent: '#ffb86c', desc: '文档、发布与日常运维的执行助手' },
  { id: 'trae-cn', name: 'trae-cn', vendor: 'Trae', model: 'doubao-seed-code', accent: '#f472b6', desc: 'Trae CN 端到端交付线，前端与接口联调见长' },
];

const iso = ms => new Date(ms + 8 * 3600e3).toISOString().replace('Z', '+08:00');
const step = (id, desc, owner) => ({ id, desc, owner });
const t = (tool, args, result, failed = false) => ({ tool, args, result, failed });
const R = (path, kind, by, summary, verdict, method, evidence, emit = true) =>
  ({ path, kind, by, summary, verdict, method, evidence, emit });

const scenarios = [
  {
    id: 'qcn-config-layering', agent: 'qoder-cn', title: '重构 config 分层加载', repo: 'myapp',
    status: 'completed', model: 'opus 4.6 · high', start: '2026-10-25T09:30:00+08:00',
    cost: 0.142, tokens: 812000,
    router: true, advisor: true,
    beforePlan: '改造前先补一层旧格式读取的回归测试，否则无法证明向后兼容',
    errorIntervention: '同一错误第二次出现，位置本身有问题——不要重试，改用临时文件 + 原子替换',
    beforeDone: 'reports/legacy-config-refs.md 里还有 2 处废弃模块引用未处理，确认是有意留白还是遗漏',
    steps: [
      step('S1', '摸清 legacy config 的全部引用点', 'explorer'),
      step('S2', '查 pydantic-settings 分层方案文档', 'researcher'),
      step('S3', '实现分层加载 + 迁移旧格式', 'worker'),
      step('S4', '跑测试验证向后兼容', 'main'),
    ],
    subs: [
      { id: 'explorer', step: 'S1', task: '扫描 src/ 找出 legacy config 的全部引用点', workingNote: '已定位 6 个文件，正在读上下文', tools: [
        t('grep', 'legacy_config( src/', '命中 14 处引用，分布在 6 个文件'),
        t('read', 'src/config/legacy.py', '读取 120 行，确认默认值硬编码在模块顶部'),
        t('read', 'src/app.py', '找到 3 处调用，其中 1 处在启动路径上'),
      ] },
      { id: 'researcher', step: 'S2', task: '查 pydantic-settings 分层配置官方文档并给结论', workingNote: '文档已取到，正在核对项目锁定版本', tools: [
        t('web_fetch', 'docs.pydantic.dev/latest/concepts/pydantic_settings', '确认 sources 链式加载可行，深度合并默认开启'),
        t('read', 'pyproject.toml', '项目锁定 pydantic-settings==2.4，与在线文档 2.7 存在差异'),
      ] },
      { id: 'worker', step: 'S3', task: '实现 config/loader.py 分层加载并迁移调用方', workingNote: '骨架已写入，正在跑自检', tools: [
        t('write', 'src/config/loader.py', '分层加载骨架写入，含 defaults/file/env 三级'),
        t('edit', 'src/app.py 改用 get_settings()', 'app.py 迁移完成'),
        t('bash', 'python -m myapp --check-config', '原子替换成功，check-config 通过'),
      ], error: { index: 2, msg: "PermissionError: 'etc/config.json' read-only volume" } },
    ],
    results: [
      R('reports/legacy-config-refs.md', 'report', 'explorer', '14 处引用清单 + 迁移优先级', 'pass', '人工抽查 3/14 引用点', '抽查位置与行号一致'),
      R('src/config/loader.py', 'code', 'worker', '分层加载实现（defaults → file → env）', 'pass', 'pytest tests/ -q', '34 passed in 2.1s（含 6 例向后兼容回归）'),
      R('src/app.py', 'code', 'worker', '调用方迁移到 get_settings()', 'pass', 'python -m myapp --check-config', '启动自检通过，env 覆盖生效'),
      R('tests/test_config_layering.py', 'test', 'worker', '向后兼容回归测试 6 例', 'pending', '', ''),
      R('notes/pydantic-settings-layering.md', 'research', 'researcher', 'sources 链分层方案结论（基于文档 2.7）', 'fail', '对照项目锁定的 pydantic-settings 2.4 复核', '文档基于 2.7，项目锁的是 2.4，InitSettingsSource 参数名不同——结论需按 2.4 修订后重验'),
    ],
    next: 'researcher 结论按 pydantic-settings 2.4 修订后重验；补跑 tests/test_config_layering.py 并留证',
  },
  {
    id: 'qcn-api-pagination', agent: 'qoder-cn', title: 'API 分页统一改造', repo: 'order-service',
    status: 'completed', model: 'sonnet 4.5', start: '2026-10-24T16:20:00+08:00',
    cost: 0.38, tokens: 1520000, router: false, advisor: false,
    steps: [
      step('S1', '盘点现有分页参数与调用方', 'explorer'),
      step('S2', '抽出统一 pagination helper', 'worker'),
      step('S3', '补充分页边界测试', 'tester'),
      step('S4', '汇总审计报告', 'main'),
    ],
    subs: [
      { id: 'explorer', step: 'S1', task: '盘点 9 个列表接口的分页参数差异', workingNote: '已比对 6 个接口', tools: [
        t('grep', 'page_size|per_page|limit', '发现 3 套参数命名并存'),
        t('read', 'src/api/orders.py', '确认 order 列表仍用旧 offset/limit'),
      ] },
      { id: 'worker', step: 'S2', task: '实现 pagination helper 并迁移接口', workingNote: 'helper 已落地，正在迁移调用方', tools: [
        t('write', 'src/api/pagination.py', '统一 page/page_size/cursor 三种模式'),
        t('edit', 'src/api/orders.py', '迁移到统一 helper'),
        t('edit', 'src/api/users.py', '迁移到统一 helper'),
      ] },
      { id: 'tester', step: 'S3', task: '覆盖空页、越界页与超大 page_size', workingNote: '正在补越界用例', tools: [
        t('write', 'tests/test_pagination.py', '新增 11 个边界用例'),
        t('bash', 'pytest tests/test_pagination.py -q', '11 passed'),
      ] },
    ],
    results: [
      R('src/api/pagination.py', 'code', 'worker', '统一分页 helper（page/page_size/cursor）', 'pass', 'pytest tests/ -q', '87 passed'),
      R('src/api/orders.py', 'code', 'worker', '订单列表迁移到统一分页', 'pass', 'pytest tests/test_orders_api.py', '19 passed'),
      R('tests/test_pagination.py', 'test', 'tester', '分页边界测试 11 例', 'pass', 'pytest tests/test_pagination.py -q', '11 passed in 0.8s'),
      R('reports/pagination-audit.md', 'report', 'explorer', '9 个接口的分页参数盘点与迁移清单', 'pass', '人工复核接口清单', '与路由注册表逐项对齐'),
    ],
    next: '无遗留，可交付',
  },
  {
    id: 'qcn-flaky-test', agent: 'qoder-cn', title: '修复 CI flaky 测试', repo: 'payment-core',
    status: 'running', model: 'opus 4.6 · high', start: '2026-10-25T10:02:00+08:00',
    cost: 0.09, tokens: 356000, router: true, advisor: true,
    beforePlan: '先确认 flaky 是时序问题还是断言问题，不要直接加重试掩盖',
    steps: [
      step('S1', '复现并定位 flaky 用例', 'worker'),
      step('S2', '分析近 30 次 CI 失败日志', 'explorer'),
      step('S3', '修复并回归', 'main'),
    ],
    subs: [
      { id: 'worker', step: 'S1', task: '在本地复现 tests/test_retry.py 的间歇失败', state: 'working', workingNote: '已复现 2/10，正在加日志定位', tools: [
        t('bash', 'pytest tests/test_retry.py -x --count=10', '10 次中失败 2 次，均为超时断言'),
        t('read', 'tests/test_retry.py', '发现等待固定 50ms，机器负载高时必挂'),
        t('bash', 'pytest tests/test_retry.py -x --count=10 -s', '正在运行，日志待收集'),
      ], stopAfter: 2 },
      { id: 'explorer', step: 'S2', task: '统计 CI 失败分布与共同特征', workingNote: '已抓取 30 份日志', tools: [
        t('grep', 'TimeoutError', 'logs/ci/*.log：29/30 次失败都卡在同一断言'),
        t('read', 'logs/ci-8821.log', '确认失败前有 120ms 的 GC 停顿'),
      ] },
    ],
    results: [
      R('reports/flaky-analysis.md', 'report', 'explorer', 'flaky 失败分布：集中在 retry 超时断言', 'pass', '人工核对 30 份 CI 日志', '29/30 失败点一致，GC 停顿是共同前兆'),
      R('tests/test_retry.py', 'test', 'worker', '改用 fake clock 消除时序依赖', 'pending', '', ''),
    ],
    next: '',
  },
  {
    id: 'qcn-db-migration', agent: 'qoder-cn', title: 'orders 表迁移脚本', repo: 'order-service',
    status: 'failed', model: 'opus 4.6', start: '2026-10-23T14:05:00+08:00',
    cost: 0.21, tokens: 640000, router: false, advisor: true,
    beforePlan: '迁移必须先做影子表演练，确认外键与索引重建顺序',
    beforeDone: 'dry-run 已失败，收工前确认回滚路径可用',
    steps: [
      step('S1', '梳理 orders 表结构与依赖', 'explorer'),
      step('S2', '编写迁移与回滚脚本', 'worker'),
      step('S3', '影子表 dry-run 演练', 'main'),
    ],
    subs: [
      { id: 'explorer', step: 'S1', task: '梳理 orders 相关的 7 个外键与 3 个索引', workingNote: '已导出依赖图', tools: [
        t('bash', 'psql -c "\\d+ orders"', '拿到 14 个字段与 3 个索引'),
        t('grep', 'REFERENCES orders', '发现 7 个外键引用'),
      ] },
      { id: 'worker', step: 'S2', task: '编写 0042 迁移与回滚脚本', workingNote: '迁移脚本完成，正在补回滚', tools: [
        t('write', 'migrations/0042_orders.sql', '拆分旧表并重建索引'),
        t('write', 'migrations/0042_orders_rollback.sql', '回滚脚本按逆序恢复外键'),
        t('bash', 'psql -f migrations/0042_orders.sql --dry-run', '两阶段执行仍报外键冲突：order_items 尚未迁移', true),
      ], error: { index: 2, msg: 'ERROR: cannot drop constraint orders_user_id_fkey because other objects depend on it' } },
    ],
    results: [
      R('reports/migration-plan.md', 'report', 'explorer', 'orders 迁移依赖图与执行顺序', 'pass', '人工复核依赖图', '7 个外键与 3 个索引顺序正确'),
      R('migrations/0042_orders.sql', 'code', 'worker', 'orders 拆分迁移脚本', 'fail', '影子库 dry-run', '外键依赖冲突：需先迁移 order_items 再重建约束'),
    ],
    next: '迁移脚本需改为两阶段（先解绑外键再重建），修复后重跑影子库 dry-run',
  },
  {
    id: 'cdx-cli-flags', agent: 'codex', title: 'CLI flag 重构', repo: 'devctl',
    status: 'completed', model: 'gpt-5.1-codex', start: '2026-10-24T11:00:00+08:00',
    cost: 0.27, tokens: 980000, router: true, advisor: false,
    steps: [
      step('S1', '盘点全部 CLI flag 与别名', 'explorer'),
      step('S2', '迁移到 click 统一声明', 'worker'),
      step('S3', '核对 click 迁移注意事项', 'researcher'),
      step('S4', '回归与文档更新', 'main'),
    ],
    subs: [
      { id: 'explorer', step: 'S1', task: '扫描 34 个 flag 的声明位置与使用点', workingNote: '已完成 20 个', tools: [
        t('grep', 'add_argument\\(', '34 处 flag 声明，分布在 8 个文件'),
        t('read', 'src/cli/main.py', '确认 5 个全局 flag 与子命令共享'),
      ] },
      { id: 'worker', step: 'S2', task: '迁移 flag 声明到 click', workingNote: '已迁移 3 个命令组', tools: [
        t('write', 'src/cli/flags.py', '集中声明 34 个 flag 与别名'),
        t('edit', 'src/cli/commands.py', '命令组改为 click.group'),
      ] },
      { id: 'researcher', step: 'S3', task: '核对 click 9 的 flag 兼容边界', workingNote: '正在比对环境变量前缀规则', tools: [
        t('web_fetch', 'click.palletsprojects.com/en/stable/options/', '确认 envvar 与 flag 联动规则'),
        t('write', 'notes/click-migration.md', '整理 4 条迁移注意事项'),
      ] },
    ],
    results: [
      R('src/cli/flags.py', 'code', 'worker', '集中式 click flag 声明', 'pass', 'pytest tests/test_flags.py', '22 passed'),
      R('src/cli/commands.py', 'code', 'worker', '命令组迁移到 click', 'pass', 'devctl --help 快照比对', '34 个 flag 无缺失'),
      R('docs/cli.md', 'doc', 'worker', 'CLI 帮助文档同步更新', 'pass', '人工比对 --help 输出', '与文档一致'),
      R('notes/click-migration.md', 'research', 'researcher', 'click 9 迁移注意事项', 'pass', '对照官方文档复核', '版本与项目一致（click 9.1）'),
      R('reports/flag-audit.md', 'report', 'explorer', '34 个 flag 的盘点清单', 'pass', '人工抽查 5 个 flag', '声明与使用点一致'),
      R('tests/test_flags.py', 'test', 'worker', 'flag 解析回归测试', 'pending', '', ''),
    ],
    next: '补跑 tests/test_flags.py 全量回归（当前仅跑过 22 例子集）',
  },
  {
    id: 'cdx-webhook-retry', agent: 'codex', title: 'Webhook 重试与幂等', repo: 'notify-hub',
    status: 'completed', model: 'gpt-5.1-codex', start: '2026-10-24T09:12:00+08:00',
    cost: 0.33, tokens: 1100000, router: false, advisor: true,
    beforePlan: '先定义幂等键，再谈重试，否则重复投递会放大故障',
    errorIntervention: '同一错误第二次出现，说明签名校验顺序有误——不要重试，先改校验时机',
    beforeDone: '确认重试上限与告警阈值在同一处配置，避免双份来源',
    steps: [
      step('S1', '实现幂等键与重试策略', 'worker'),
      step('S2', '补重试与幂等测试', 'tester'),
      step('S3', '出幂等设计说明', 'main'),
    ],
    subs: [
      { id: 'worker', step: 'S1', task: '实现 retry policy 与幂等键存储', workingNote: '重试骨架完成，正在处理签名校验顺序', tools: [
        t('write', 'src/webhook/retry.py', '指数退避 + 最大 5 次'),
        t('bash', 'pytest tests/test_webhook_retry.py -q', '调整验签顺序后重试通过：9 passed'),
      ], error: { index: 1, msg: 'AssertionError: signature verified after retry #2' } },
      { id: 'tester', step: 'S2', task: '覆盖重复投递与乱序到达', workingNote: '新增 9 个用例', tools: [
        t('write', 'tests/test_webhook_retry.py', '新增幂等与乱序用例 9 个'),
        t('bash', 'pytest tests/test_webhook_retry.py -q', '9 passed'),
      ] },
    ],
    results: [
      R('src/webhook/retry.py', 'code', 'worker', '幂等键 + 指数退避重试', 'pass', 'pytest tests/test_webhook_retry.py', '9 passed'),
      R('tests/test_webhook_retry.py', 'test', 'tester', '重复投递与乱序到达测试', 'pass', 'pytest tests/ -q', '64 passed'),
      R('reports/idempotency-design.md', 'report', 'worker', '幂等键设计与重试边界', 'pass', '人工评审设计文档', '与实现一致，上限单点配置'),
    ],
    next: '无遗留，可交付',
  },
  {
    id: 'cdx-monorepo-cache', agent: 'codex', title: 'Monorepo 构建缓存', repo: 'build-infra',
    status: 'running', model: 'gpt-5.1-codex', start: '2026-10-25T10:10:00+08:00',
    cost: 0.16, tokens: 720000, router: true, advisor: true,
    beforePlan: '先量化命中率，再决定是否引入远端缓存',
    steps: [
      step('S1', '评估 Turborepo 缓存命中率', 'researcher'),
      step('S2', '盘点 412 个包的构建图', 'explorer'),
      step('S3', '接入本地缓存并验证', 'worker'),
      step('S4', '压测远端缓存收益', 'tester'),
    ],
    subs: [
      { id: 'researcher', step: 'S1', task: '评估 Turborepo 缓存机制与收益', workingNote: '已读完官方文档', tools: [
        t('web_fetch', 'turborepo.com/docs/crafting-your-repository/caching', '确认本地/远端缓存与哈希输入'),
        t('write', 'notes/turbo-cache-eval.md', '评估笔记初稿：预计命中率 60-70%'),
      ] },
      { id: 'explorer', step: 'S2', task: '导出 412 个包的依赖图', workingNote: '已导出 380 个包', tools: [
        t('bash', 'pnpm ls -r --depth -1 --json', '拿到 412 个包清单'),
        t('bash', 'npx turbo run build --dry=json', '迁移到 tasks 字段后导出成功：412 个包'),
      ], error: { index: 1, msg: 'ERROR turbo.json: pipeline key not found (expected "tasks")' } },
      { id: 'worker', step: 'S3', task: '接入本地缓存并验证增量构建', state: 'working', workingNote: '正在改写 turbo.json', tools: [
        t('read', 'turbo.json', '发现仍使用旧版 pipeline 字段'),
        t('edit', 'turbo.json', '迁移到 tasks 字段并声明 outputs'),
        t('bash', 'npx turbo run build --dry=json', '构建图导出成功，412 个包'),
        t('bash', 'npx turbo run build', '首次全量构建中'),
      ], stopAfter: 3 },
      { id: 'tester', step: 'S4', task: '压测远端缓存收益', state: 'working', workingNote: '等待 worker 产出后开始', tools: [
        t('read', 'notes/turbo-cache-eval.md', '读取评估笔记，准备压测脚本'),
      ] },
    ],
    results: [
      R('notes/turbo-cache-eval.md', 'research', 'researcher', 'Turborepo 缓存收益评估（初稿）', 'pending', '', ''),
    ],
    next: '',
  },
  {
    id: 'cdx-perf-regression', agent: 'codex', title: 'P99 性能回归排查', repo: 'gateway',
    status: 'canceled', model: 'gpt-5.1-codex', start: '2026-10-23T18:40:00+08:00',
    cost: 0.07, tokens: 280000, router: false, advisor: false,
    steps: [
      step('S1', '抓取回归时间窗内的 P99 基线', 'explorer'),
      step('S2', '定位热点候选', 'main'),
    ],
    subs: [
      { id: 'explorer', step: 'S1', task: '拉取 24h P99 与发布记录对照', workingNote: '已导出 24h 曲线', tools: [
        t('bash', 'curl -s grafana/api/ds/query -d @p99.json', '导出 18:00-18:40 的 P99 曲线'),
        t('read', 'deploys/2026-10-23.json', '18:12 有一次网关配置变更'),
      ] },
    ],
    results: [
      R('reports/p99-baseline.md', 'report', 'explorer', 'P99 回归窗口基线', 'pending', '', ''),
      R('reports/hotspot-candidates.md', 'report', 'explorer', '热点候选：连接池与 DNS 缓存', 'pending', '', ''),
    ],
    next: '用户中止：生产已回滚，排查转入异步专项；两份报告待补验证',
  },
  {
    id: 'wb-docs-migration', agent: 'workbuddy', title: '文档站迁移 Docusaurus', repo: 'docs-site',
    status: 'completed', model: 'sonnet 4.6', start: '2026-10-22T15:30:00+08:00',
    cost: 0.19, tokens: 690000, router: true, advisor: true,
    beforePlan: '先跑链接检查再迁移，避免把死链带进新站',
    beforeDone: '抽查 10 个重定向规则，确认旧 URL 不会 404',
    steps: [
      step('S1', '盘点旧站页面与死链', 'explorer'),
      step('S2', '搭建 Docusaurus 并迁移内容', 'worker'),
      step('S3', '核对 Docusaurus 迁移配置', 'researcher'),
      step('S4', '链接检查与验收', 'main'),
    ],
    subs: [
      { id: 'explorer', step: 'S1', task: '盘点旧站 86 个页面与死链', workingNote: '已发现 7 条死链', tools: [
        t('bash', 'npx broken-link-checker http://docs.local', '86 个页面中 7 条死链'),
        t('write', 'reports/link-check.md', '死链清单与修复建议'),
      ] },
      { id: 'worker', step: 'S2', task: '初始化 Docusaurus 并迁移 Markdown', workingNote: '已迁移 60 篇', tools: [
        t('write', 'docusaurus.config.ts', '站点配置与旧 URL 重定向'),
        t('write', 'sidebars.ts', '按原目录结构生成侧栏'),
        t('bash', 'npm run build', '构建成功，产出 86 个页面'),
      ] },
      { id: 'researcher', step: 'S3', task: '核对 Docusaurus 3 的迁移注意事项', workingNote: '正在核对 MDX 兼容性', tools: [
        t('web_fetch', 'docusaurus.io/docs/migration/v3', '确认 MDX 3 与 Node 版本要求'),
        t('read', 'docs/intro.md', '发现一处 HTML 内嵌写法需改为 MDX'),
      ] },
    ],
    results: [
      R('docusaurus.config.ts', 'config', 'worker', '站点配置与旧 URL 重定向', 'pass', 'npm run build', '构建成功，86 个页面'),
      R('sidebars.ts', 'code', 'worker', '按原目录结构生成侧栏', 'pass', '人工比对原站导航', '层级一致'),
      R('docs/intro.md', 'doc', 'worker', '首页迁移到 MDX', 'pass', '页面渲染检查', '代码块与提示框正常'),
      R('reports/link-check.md', 'report', 'explorer', '死链清单与修复建议', 'pass', '迁移后重跑链接检查', '86 个页面 0 死链'),
    ],
    next: '无遗留，可交付',
  },
  {
    id: 'wb-release-notes', agent: 'workbuddy', title: '发布说明自动化', repo: 'workbuddy-app',
    status: 'completed', model: 'sonnet 4.6', start: '2026-10-24T20:15:00+08:00',
    cost: 0.12, tokens: 410000, router: true, advisor: true,
    beforePlan: '发布说明必须只取已合并 PR，不要把进行中的改动写进去',
    beforeDone: '2.4 的破坏性变更还没写进升级指引，确认是否遗漏',
    steps: [
      step('S1', '抓取 2.4 已合并 PR 与标签', 'worker'),
      step('S2', '整理破坏性变更清单', 'researcher'),
      step('S3', '生成发布说明并校对', 'main'),
    ],
    subs: [
      { id: 'worker', step: 'S1', task: '抓取 v2.3.0..v2.4.0 的已合并 PR', workingNote: '已抓取 42 个 PR', tools: [
        t('bash', 'gh pr list --state merged --base main --json number,title', '拿到 42 个已合并 PR'),
        t('write', 'scripts/gen_release_notes.py', '按标签分组生成 Markdown'),
      ] },
      { id: 'researcher', step: 'S2', task: '整理破坏性变更与升级步骤', workingNote: '已确认 3 项破坏性变更', tools: [
        t('grep', 'BREAKING CHANGE', 'CHANGELOG 中 3 处破坏性变更'),
        t('read', 'docs/upgrade.md', '升级指引仍停留在 2.2'),
      ] },
    ],
    results: [
      R('scripts/gen_release_notes.py', 'code', 'worker', '发布说明生成脚本', 'pass', 'python scripts/gen_release_notes.py --dry-run', '42 个 PR 正确分组'),
      R('docs/release-notes-2.4.md', 'doc', 'worker', 'v2.4.0 发布说明', 'fail', '人工校对破坏性变更章节', '3 项破坏性变更只写了 1 项，升级指引缺失'),
    ],
    next: '补齐 2.4 的 3 项破坏性变更与升级步骤后重新校对',
  },
  {
    id: 'wb-dep-audit', agent: 'workbuddy', title: '依赖安全审计', repo: 'workbuddy-app',
    status: 'failed', model: 'sonnet 4.6', start: '2026-10-23T10:20:00+08:00',
    cost: 0.24, tokens: 760000, router: false, advisor: true,
    beforePlan: '先跑完整审计再定升级范围，避免逐包升级引入二次风险',
    errorIntervention: '同一错误第二次出现：osv.dev 接口超时，改为批量拉取并加缓存，不要再单包重试',
    beforeDone: '高危项还没有可执行升级路径，收工前给出降级/隔离方案',
    steps: [
      step('S1', '扫描全部依赖漏洞', 'explorer'),
      step('S2', '调研受影响包的修复版本', 'researcher'),
      step('S3', '生成升级与隔离方案', 'worker'),
      step('S4', '复核方案', 'main'),
    ],
    subs: [
      { id: 'explorer', step: 'S1', task: '运行 npm audit 与 osv-scanner', workingNote: 'npm audit 完成，osv 扫描中', tools: [
        t('bash', 'npm audit --json', '发现 3 个高危、9 个中危'),
        t('bash', 'osv-scanner -r .', '重试后扫描完成：12 项漏洞（3 高危）'),
      ], error: { index: 1, msg: 'ETIMEDOUT: https://api.osv.dev/v1/query' } },
      { id: 'researcher', step: 'S2', task: '查高危包的可用修复版本', workingNote: '已确认 2 个包有补丁', tools: [
        t('web_fetch', 'osv.dev/list?q=lodash', 'lodash 4.17.21 修复原型污染'),
        t('web_fetch', 'osv.dev/list?q=axios', 'axios 1.7.4 修复 SSRF'),
      ] },
      { id: 'worker', step: 'S3', task: '生成升级计划与无法升级项的隔离方案', workingNote: '升级计划初稿完成', tools: [
        t('write', 'reports/upgrade-plan.md', '12 项漏洞的升级/隔离矩阵'),
        t('edit', 'package-lock.json', '尝试升级 3 个高危包'),
        t('bash', 'npm install', '高危包升级完成，锁文件已更新'),
      ] },
    ],
    results: [
      R('reports/cve-scan.md', 'report', 'explorer', '依赖漏洞扫描结果', 'fail', '人工核对 osv 结果', '3 项高危均无可用补丁，隔离方案尚未验证'),
      R('reports/upgrade-plan.md', 'report', 'worker', '升级与隔离方案', 'pending', '', ''),
      R('package-lock.json', 'config', 'worker', '高危依赖升级', 'pending', '', ''),
    ],
    next: '切换 registry 镜像后重跑 osv-scanner；升级计划需随完整漏洞清单更新',
  },
  {
    id: 'wb-oncall-runbook', agent: 'workbuddy', title: '生成 oncall 手册', repo: 'ops-runbooks',
    status: 'running', model: 'sonnet 4.6', start: '2026-10-25T10:18:00+08:00',
    cost: 0.03, tokens: 120000, router: false, advisor: false,
    steps: [
      step('S1', '收集近 90 天告警与处置记录', 'researcher'),
      step('S2', '整理成可执行 runbook', 'main'),
    ],
    subs: [
      { id: 'researcher', step: 'S1', task: '汇总近 90 天告警 TOP10 与处置动作', state: 'working', workingNote: '已拉取 62 条告警', tools: [
        t('bash', 'curl -s alertmanager/api/v2/alerts', '拉取 62 条历史告警'),
        t('read', 'ops/incidents/2026-Q3.md', '读取 18 起事件复盘'),
        t('grep', 'runbook', 'ops/', '命中 4 份零散手册'),
      ], stopAfter: 2 },
    ],
    results: [],
    next: '',
  },
  {
    id: 'trae-api-contract', agent: 'trae-cn', title: '订单 API 契约生成', repo: 'trae-service',
    status: 'completed', model: 'doubao-seed-code', start: '2026-10-24T13:10:00+08:00',
    cost: 0.185, tokens: 690000, router: true, advisor: true,
    beforePlan: '契约要从现有响应实测反推，文档已经落后两个版本，别照着文档改',
    beforeDone: '确认 generated/client.ts 与 OpenAPI 快照同源，不能留手改行',
    steps: [
      step('S1', '抓取 12 个接口的真实响应样本', 'explorer'),
      step('S2', '生成 OpenAPI 契约与类型', 'worker'),
      step('S3', '前端 client 接入生成类型', 'worker'),
      step('S4', '契约回归与差异审计', 'main'),
    ],
    subs: [
      { id: 'explorer', step: 'S1', task: '抓取订单域 12 个接口的响应与错误码', workingNote: '已抓取 9 个接口', tools: [
        t('bash', 'curl -s http://order.local/openapi.json', '线上 openapi 只有 9 个接口，缺退款与对账'),
        t('bash', 'node scripts/probe-api.mjs --domain order', '实测 12 个接口，3 个响应结构与文档不一致'),
        t('write', 'reports/api-samples.md', '12 个接口的样本与差异清单'),
      ] },
      { id: 'worker', step: 'S2', task: '用实测样本生成 OpenAPI 与 TS 类型', workingNote: '契约已生成，正在接入 client', tools: [
        t('write', 'contracts/order.openapi.yaml', '补上退款、对账与统一错误结构'),
        t('bash', 'npx openapi-typescript contracts/order.openapi.yaml -o src/generated/order.ts', '生成 12 组请求/响应类型'),
        t('write', 'src/api/order-client.ts', 'client 改用生成类型，移除手写 DTO'),
      ] },
    ],
    results: [
      R('contracts/order.openapi.yaml', 'config', 'worker', '订单域 12 接口契约（以实测为准）', 'pass', 'npx openapi-diff 对照线上快照', '新增 3 个接口与统一错误结构，无破坏性差异'),
      R('src/generated/order.ts', 'code', 'worker', 'OpenAPI 生成的 TS 类型', 'pass', 'tsc --noEmit', '0 error，与契约同源'),
      R('src/api/order-client.ts', 'code', 'worker', '前端 client 接入生成类型', 'pass', 'vitest src/api/order-client.test.ts', '18 passed'),
      R('reports/api-samples.md', 'report', 'explorer', '12 接口实测样本与文档差异', 'pass', '人工抽查 4 个接口', '状态码与字段结构和实测一致'),
    ],
    next: '无遗留，可交付',
  },
  {
    id: 'trae-style-migration', agent: 'trae-cn', title: '设计令牌迁移', repo: 'trae-web',
    status: 'running', model: 'doubao-seed-code', start: '2026-10-25T10:24:00+08:00',
    cost: 0.06, tokens: 240000, router: true, advisor: false,
    steps: [
      step('S1', '盘点 214 处硬编码颜色与间距', 'explorer'),
      step('S2', '迁移到设计令牌', 'worker'),
      step('S3', '跑视觉回归', 'tester'),
    ],
    subs: [
      { id: 'explorer', step: 'S1', task: '扫描组件中的硬编码样式', workingNote: '已完成扫描', tools: [
        t('grep', '#[0-9a-fA-F]{6}|\\b[0-9]+px\\b', 'src/components', '214 处硬编码，集中在 6 个旧组件'),
        t('write', 'reports/style-inventory.md', '按组件与风险等级分组'),
      ] },
      { id: 'worker', step: 'S2', task: '按组件迁移到 --color/--space 令牌', state: 'working', workingNote: '已迁移 4/6 个组件，正在处理表格样式', tools: [
        t('read', 'src/styles/tokens.css', '确认 32 个颜色令牌与 12 个间距令牌'),
        t('edit', 'src/components/DataTable.tsx', '表格斑马纹与边框改用令牌'),
        t('edit', 'src/components/FilterBar.tsx', '筛选栏间距改用 --space-*'),
      ], stopAfter: 2 },
      { id: 'tester', step: 'S3', task: '跑视觉回归并标出差异', state: 'working', workingNote: '等待 worker 迁移完成后开始', tools: [
        t('read', 'reports/style-inventory.md', '读取迁移清单，准备回归基线'),
      ] },
    ],
    results: [
      R('reports/style-inventory.md', 'report', 'explorer', '214 处硬编码样式盘点', 'pending', '', ''),
      R('src/components/DataTable.tsx', 'code', 'worker', '表格样式迁移到设计令牌', 'pending', '', ''),
    ],
    next: '',
  },
  {
    id: 'trae-e2e-coverage', agent: 'trae-cn', title: '补齐 checkout E2E 覆盖', repo: 'trae-web',
    status: 'failed', model: 'doubao-seed-code', start: '2026-10-23T16:00:00+08:00',
    cost: 0.23, tokens: 810000, router: false, advisor: true,
    beforePlan: '先固定测试数据的清理顺序，再写用例，否则跨浏览器会互相污染',
    errorIntervention: '同一错误第二次出现：WebKit 的 storage 清理顺序与 Chromium 不同，不要加重试，改为每个用例独立 context',
    beforeDone: 'WebKit 仍失败，确认失败证据与修复方案后再收工',
    steps: [
      step('S1', '搭 Playwright 骨架与夹具', 'worker'),
      step('S2', '覆盖 checkout 主流程与异常分支', 'worker'),
      step('S3', '跑三浏览器矩阵', 'main'),
    ],
    subs: [
      { id: 'worker', step: 'S1', task: '搭建 Playwright 配置与测试夹具', workingNote: '配置完成，正在跑矩阵', tools: [
        t('write', 'playwright.config.ts', 'chromium / firefox / webkit 三套 project'),
        t('write', 'tests/e2e/fixtures/checkout.ts', '测试用户、购物车与支付桩'),
        t('bash', 'npx playwright test tests/e2e/checkout.spec.ts', 'Chromium 12 passed；WebKit 7 failed，storage 状态串用例', true),
      ], error: { index: 2, msg: 'WebKit: expected cart badge 0 but received 3 (state leaked between tests)' } },
    ],
    results: [
      R('playwright.config.ts', 'config', 'worker', '三浏览器 E2E 配置', 'pass', 'npx playwright test --list', '3 个 project 共 36 个用例被识别'),
      R('tests/e2e/checkout.spec.ts', 'test', 'worker', 'checkout 主流程与异常分支', 'fail', 'npx playwright test tests/e2e/checkout.spec.ts', 'Chromium 12/12 通过，WebKit 5/12 失败：购物车状态跨用例泄漏'),
      R('reports/webkit-failures.md', 'report', 'worker', 'WebKit 失败证据汇总', 'pending', '', ''),
    ],
    next: '按 advisor 建议改为每个用例独立 context，修复 storage 清理顺序后重跑三浏览器矩阵',
  },
  {
    id: 'trae-doc-sync', agent: 'trae-cn', title: 'API 变更文档同步', repo: 'trae-docs',
    status: 'completed', model: 'doubao-seed-code', start: '2026-10-22T11:40:00+08:00',
    cost: 0.09, tokens: 320000, router: false, advisor: false,
    steps: [
      step('S1', '扫描本周已合并的 API 变更', 'explorer'),
      step('S2', '更新 6 篇接口文档与示例', 'worker'),
      step('S3', '全站链接检查', 'main'),
    ],
    subs: [
      { id: 'explorer', step: 'S1', task: '从 28 个已合并 PR 中筛出 API 变更', workingNote: '已筛出 8 个 PR', tools: [
        t('bash', 'gh pr list --state merged --search "api" --json number,title', '28 个 PR 中 8 个涉及接口行为'),
        t('grep', 'BREAKING|deprecated', 'CHANGELOG.md', '2 处弃用、1 处返回结构变更'),
      ] },
      { id: 'worker', step: 'S2', task: '更新接口文档与请求示例', workingNote: '已更新 5 篇', tools: [
        t('read', 'docs/api/orders.md', '确认示例仍使用旧分页参数'),
        t('write', 'docs/api/orders.md', '更新 page/page_size 与错误码'),
        t('write', 'docs/api/webhooks.md', '补签名校验与重试说明'),
      ] },
    ],
    results: [
      R('docs/api/orders.md', 'doc', 'worker', '订单接口分页与错误码更新', 'pass', '人工比对 OpenAPI 契约', '字段与示例一致'),
      R('docs/api/webhooks.md', 'doc', 'worker', 'Webhook 签名与重试说明', 'pass', '人工评审', '与实现中的 5 次上限一致'),
      R('reports/link-check.md', 'report', 'explorer', '全站链接检查结果', 'pending', '', ''),
    ],
    next: '补跑全站链接检查并把结果附到 reports/link-check.md',
  },
];

function build(sc) {
  const start = Date.parse(sc.start);
  let clock = start;
  let seq = 0;
  const events = [];
  const add = (src, type, data, dt = 1.2) => {
    clock = Math.max(clock, start);
    clock += Math.round(dt * 1000);
    events.push({ ts: iso(clock), seq: ++seq, src, type, data });
  };

  add('main', 'session_start', {
    task: sc.title,
    policy: {
      router: sc.router ? 'sharp/cheap · 每次工具调用前做轻决策' : '未启用（工具调用直接由主会话决定）',
      advisor: sc.advisor ? 'fable/mid · 仅在 plan 前 / 错误重复时 / 收工前出声' : '未启用',
    },
  }, 0);

  if (sc.router) add('main', 'agent_spawned', { agent: 'router', role: 'router', label: 'JEV · fork 层', model: 'sharp(cheap)', task: '拦截每次工具调用，0.5s 内给出轻决策（选文件/选工具/是否重试）' }, 1.2);
  if (sc.advisor) add('main', 'agent_spawned', { agent: 'advisor', role: 'advisor', label: 'FABLE · advisor', model: 'fable 5.1', task: '监听全部调用，只在三个时机出声，不写代码' }, 0.2);
  if (sc.advisor && sc.beforePlan) add('advisor', 'advisor_note', { timing: 'before_plan', advice: sc.beforePlan, intervened: false }, 0.6);

  add('main', 'plan', { steps: sc.steps }, 2.4);
  for (const sub of sc.subs) {
    add('main', 'agent_spawned', { agent: sub.id, role: 'subagent', label: sub.id, model: sub.model || 'opus · effort medium', task: sub.task, step: sub.step }, 0.1);
  }

  const maxTools = Math.max(...sc.subs.map(s => s.tools.length), 0);
  let forkCount = 0;
  for (let i = 0; i < maxTools; i++) {
    for (const sub of sc.subs) {
      if (sub.stopAfter !== undefined && i >= sub.stopAfter) continue;
      const tool = sub.tools[i];
      if (!tool) continue;
      if (sc.router) {
        add('router', 'fork_decision', {
          decision: sub.error && sub.error.index === i ? 'retry_stop' : (i % 2 ? 'which_tool' : 'which_file'),
          target: tool.args,
          route: 'sharp -> code',
          elapsed_ms: 280 + ((forkCount * 37) % 260),
          tokens: 900 + ((forkCount * 131) % 520),
          cost: 0.0004,
        }, 0.5);
        forkCount++;
      }
      add(sub.id, 'tool_call', { tool: tool.tool, args: tool.args, step: sub.step }, 0.6);
      if (sub.error && sub.error.index === i) {
        add(sub.id, 'error', { tool: tool.tool, error: sub.error.msg, attempt: 1, same_error_x: 1 }, 1.0);
        if (sc.router) {
          add('router', 'fork_decision', { decision: 'retry_stop', target: 'retry once', route: 'sharp -> code', elapsed_ms: 372, tokens: 980, cost: 0.0003 }, 0.4);
          forkCount++;
        }
        add(sub.id, 'retry', { tool: tool.tool, args: tool.args, attempt: 2, reason: 'router: retry once' }, 0.8);
        add(sub.id, 'error', { tool: tool.tool, error: sub.error.msg, attempt: 2, same_error_x: 2 }, 1.0);
        if (sc.advisor && sc.errorIntervention) add('advisor', 'advisor_note', { timing: 'error_again', advice: sc.errorIntervention, intervened: true }, 0.5);
        if (sc.router) {
          add('router', 'fork_decision', { decision: 'retry_stop', target: 'stop retrying, change approach', route: 'split -> opus', elapsed_ms: 520, tokens: 1450, cost: 0.0006 }, 0.3);
          forkCount++;
        }
        add(sub.id, 'tool_result', { tool: tool.tool, status: tool.failed ? 'failed' : 'ok', summary: tool.result, step: sub.step }, 2.2);
      } else {
        add(sub.id, 'tool_result', { tool: tool.tool, status: tool.failed ? 'failed' : 'ok', summary: tool.result, step: sub.step }, 1.6);
      }
    }
    if (i === 0) {
      for (const sub of sc.subs) {
        if (sub.stopAfter === 0) continue;
        add(sub.id, 'subagent_state', { state: 'working', note: sub.workingNote || '执行中' }, 0.2);
      }
    }
  }

  for (const sub of sc.subs) {
    const finished = sub.stopAfter === undefined;
    if (finished) add(sub.id, 'subagent_state', { state: 'done', note: '任务完成' }, 0.3);
  }

  for (const r of sc.results) {
    if (r.emit === false) continue;
    if (sc.status === 'running' && r.by !== 'main' && !sc.subs.find(s => s.id === r.by)) continue;
    add(r.by, 'result_emitted', { kind: r.kind, path: r.path, created_by: r.by, summary: r.summary }, 0.4);
  }

  const verified = sc.results.filter(r => r.emit !== false && r.verdict && r.verdict !== 'pending');
  for (const r of verified) {
    add('main', 'verification', { target: r.path, method: r.method, verdict: r.verdict, evidence: r.evidence }, 1.6);
  }

  if (sc.advisor && sc.beforeDone) add('advisor', 'advisor_note', { timing: 'before_done', advice: sc.beforeDone, intervened: true }, 1.2);
  if (sc.status === 'completed' && sc.subs.length > 1) add('main', 'merge', { from: sc.subs.map(s => s.id), note: '子任务结论合并，冲突项已人工确认' }, 1.4);

  const notes = events.filter(e => e.type === 'advisor_note');
  const forks = events.filter(e => e.type === 'fork_decision');
  if (sc.router) {
    const avg = Math.round(forks.reduce((s, e) => s + e.data.elapsed_ms, 0) / Math.max(forks.length, 1));
    add('main', 'fork_summary', { forks: forks.length, tokens: forks.reduce((s, e) => s + e.data.tokens, 0), cost: +(forks.reduce((s, e) => s + e.data.cost, 0)).toFixed(4), avg_elapsed_ms: avg }, 0.6);
  }
  if (sc.advisor) {
    add('advisor', 'advisor_summary', { calls: notes.length, tokens: 214000 * notes.length, note: `${notes.length} 次出声：${notes.filter(n => n.data.intervened).length} 次干预` }, 0.4);
  }

  const emitted = events.filter(e => e.type === 'result_emitted');
  const verdictOf = p => {
    const v = sc.results.find(r => r.path === p);
    return v ? v.verdict : 'pending';
  };
  const pass = emitted.filter(e => verdictOf(e.data.path) === 'pass').length;
  const fail = emitted.filter(e => verdictOf(e.data.path) === 'fail').length;
  const pending = emitted.length - pass - fail;

  if (sc.status !== 'running') {
    const routerCost = +(forks.reduce((s, e) => s + e.data.cost, 0)).toFixed(4);
    const advisorCost = +(notes.length * 0.0029).toFixed(4);
    const subCost = Math.max(0, +(sc.cost - routerCost - advisorCost).toFixed(4));
    add('main', 'session_summary', {
      forks: forks.length,
      router_cost: routerCost,
      advisor_cost: advisorCost,
      subagents_cost: subCost,
      total_cost: sc.cost,
      elapsed_s: Math.round((clock - start) / 1000),
      total_tokens: sc.tokens,
      results_total: emitted.length,
      results_verified_pass: pass,
      results_verified_fail: fail,
      results_pending: pending,
      next: sc.next || '',
    }, 0.8);
    if (sc.router) add('main', 'agent_finished', { agent: 'router', status: 'done' }, 0.1);
    if (sc.advisor) add('main', 'agent_finished', { agent: 'advisor', status: 'done' }, 0.1);
    add('main', 'agent_finished', { agent: 'main', status: sc.status === 'completed' ? 'shipped' : sc.status }, 0.1);
  } else {
    const working = sc.subs.find(s => s.stopAfter !== undefined);
    if (working) add(working.id, 'subagent_state', { state: 'working', note: working.workingNote || '执行中' }, 6);
  }

  return { events, meta: { forks: forks.length, pass, fail, pending, cost: sc.cost } };
}

const tasks = [];
const report = [];
for (const sc of scenarios) {
  const { events, meta } = build(sc);
  const log = events.map(e => JSON.stringify(e)).join('\n') + '\n';
  fs.writeFileSync(path.join(SESS, `${sc.id}.jsonl`), log);
  tasks.push({
    id: sc.id, agent: sc.agent, title: sc.title, repo: sc.repo, status: sc.status,
    model: sc.model, startedAt: sc.start, cost: sc.cost, tokens: sc.tokens, log,
  });
  report.push({ id: sc.id, status: sc.status, events: events.length, agents: 1 + (sc.router ? 1 : 0) + (sc.advisor ? 1 : 0) + sc.subs.length, forks: meta.forks, pass: meta.pass, fail: meta.fail, pending: meta.pending });
}

const generatedAt = '2026-10-25T10:30:00.000+08:00';
fs.writeFileSync(path.join(ROOT, 'data', 'dataset.js'), `window.OBS_DATASET = ${JSON.stringify({ generatedAt, agents: AGENTS, tasks }, null, 2)};\n`);
fs.writeFileSync(path.join(ROOT, 'data', 'catalog.json'), JSON.stringify({ generatedAt, agents: AGENTS, tasks: tasks.map(({ log, ...t }) => t) }, null, 2) + '\n');

console.table(report);
console.log(`\n${tasks.length} tasks, ${report.reduce((s, r) => s + r.events, 0)} events -> data/sessions/ + data/dataset.js`);
