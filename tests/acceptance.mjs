/* Agent Runner · 功能验收（独立解析日志 vs 页面 UI 双向比对）
 * 运行：node tests/acceptance.mjs [--verbose]
 * 依赖：仓库根 node_modules 里的 playwright（系统 Chrome，headless）
 *
 * 覆盖：
 *   1. 16 份 JSONL 独立校验 + 模型派生边界
 *   2. 4 个 Agent / 全部任务视图 / 工作区与排序 / 深链
 *   3. 16 个任务详情（架构、独立看板面板、甘特、产物、线索流）
 *   4. 线索式执行日志（动态放出、暂停、重播、筛选、合成事件）
 *   5. 详情任务切换（同 Agent 前后导航 / 跨 Agent 跳转）
 *   6. 协作面板离线（本地子任务、刷新持久化）
 *   7. Multica 桥接 API + 在线协作（stub CLI，一键关联 / 派发 / 同步 / 记忆）
 *   8. 本地日志导入 / 响应式 / 控制台零错误
 *   9. v5：7 面板顺序、任务与提示词、工作痕迹、架构节点检查器、版本标记、看板泳道收纳
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import vm from 'node:vm';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PROJECT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const PAGE_URL = pathToFileURL(path.join(PROJECT, 'index.html')).href;
const SHOT_DIR = process.env.SHOT_DIR || '/tmp/agent-runner-acceptance';
const VERBOSE = process.argv.includes('--verbose');
fs.mkdirSync(SHOT_DIR, { recursive: true });

const catalog = JSON.parse(fs.readFileSync(path.join(PROJECT, 'data/catalog.json'), 'utf8'));

/* ---------- 独立实现：不经由 frontend 代码解析日志 ---------- */
function loadExpected(meta) {
  const file = path.join(PROJECT, 'data/sessions', meta.id + '.jsonl');
  const raw = fs.readFileSync(file, 'utf8');
  const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
  const events = lines.map(l => JSON.parse(l));
  const agentIds = ['main'];
  for (const e of events) {
    if (e.type === 'agent_spawned' && !agentIds.includes(e.data.agent)) agentIds.push(e.data.agent);
  }
  const states = {};
  for (const e of events) if (e.type === 'subagent_state') states[e.src] = e.data.state;
  const verif = new Map();
  for (const e of events) if (e.type === 'verification') verif.set(e.data.target, e.data.verdict);
  const resultRows = events.filter(e => e.type === 'result_emitted').map(e => ({
    path: e.data.path, by: e.data.created_by, verdict: verif.get(e.data.path) || 'pending',
  }));
  const counts = { pass: 0, fail: 0, pending: 0 };
  for (const r of resultRows) counts[r.verdict]++;

  const fin = events.find(e => e.type === 'agent_finished' && e.data.agent === 'main');
  const status = !fin ? 'running' : fin.data.status === 'shipped' ? 'completed' : fin.data.status;
  const plan = (events.find(e => e.type === 'plan') || { data: { steps: [] } }).data.steps;
  const summary = events.find(e => e.type === 'session_summary')?.data || null;
  const forkSummary = events.find(e => e.type === 'fork_summary')?.data || null;
  const advisorSummary = events.find(e => e.type === 'advisor_summary')?.data || null;
  const forks = events.filter(e => e.type === 'fork_decision').length;
  const errors = events.filter(e => e.type === 'error').length;
  const interventions = events.filter(e => e.type === 'advisor_note' && e.data.intervened).length;
  const t0 = Date.parse(events[0].ts), t1 = Date.parse(events[events.length - 1].ts);
  const firstTypes = [...new Set(events.map(e => e.type))];
  const srcs = [...new Set(events.map(e => e.src))];
  const working = Object.entries(states).filter(([, s]) => s === 'working').map(([id]) => id);
  const tools = events.filter(e => e.type === 'tool_call').length;
  const messages = events.filter(e => ['user_message', 'assistant_message', 'thinking'].includes(e.type)).length;

  return {
    ...meta, file, raw, lines, events, agentIds, states, verif, resultRows, counts,
    status, plan, summary, forkSummary, advisorSummary, forks, errors, interventions, tools, messages,
    t0, t1, durationMs: t1 - t0, firstTypes, srcs, working,
    subCount: agentIds.filter(a => !['main', 'router', 'advisor'].includes(a)).length,
    hasRouter: agentIds.includes('router'), hasAdvisor: agentIds.includes('advisor'),
    ownEvents: id => events.filter(e => e.src === id),
  };
}
const expectedTasks = catalog.tasks.map(loadExpected);
const byId = Object.fromEntries(expectedTasks.map(t => [t.id, t]));

/* ---------- 断言与统计 ---------- */
const suites = new Map();
let suite = 'general', checks = 0, failures = 0;
function section(name) { suite = name; if (!suites.has(name)) suites.set(name, { pass: 0, fail: 0 }); console.log('\n■ ' + name); }
function check(name, cond, detail = '') {
  checks++;
  const s = suites.get(suite) || { pass: 0, fail: 0 };
  if (cond) { s.pass++; if (VERBOSE) console.log('  ✓ ' + name); }
  else { s.fail++; failures++; console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
  suites.set(suite, s);
  return !!cond;
}
function eq(name, actual, wanted) {
  const a = JSON.stringify(actual), w = JSON.stringify(wanted);
  return check(name, a === w, `期望 ${w}，实际 ${a}`);
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------- 格式化（与 UI 契约一致） ---------- */
const fmtCost = n => '$' + (Number(n) || 0).toFixed(4);
const fmtDur = ms => { const s = Math.max(0, Math.round(ms / 1000)); return s < 60 ? s + 's' : Math.floor(s / 60) + 'm ' + String(s % 60).padStart(2, '0') + 's'; };
const norm = s => String(s ?? '').replace(/\s+/g, ' ').trim();
const STATUS_TEXT = { completed: '✓ 已完成', running: '● 运行中', failed: '✗ 失败', canceled: '■ 已取消' };
const BOARD_LANE_OF = t => t.status === 'completed'
  ? (t.counts.pending > 0 ? 'review' : 'done')
  : t.status === 'failed' ? 'failed'
  : t.status === 'canceled' ? 'idle'
  : 'running';
const badgeOf = v => v === 'pass' ? '✓ 已验证通过' : v === 'fail' ? '✗ 验证未通过' : '⏳ 待验证';

/* ---------- 浏览器 ---------- */
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const pageErrors = [];
page.on('pageerror', e => pageErrors.push('pageerror: ' + e.message));
page.on('console', m => { if (m.type() === 'error') pageErrors.push('console: ' + m.text()); });

let httpContext = null, page2 = null;
const httpErrors = [];

async function goTaskOn(p, id) {
  const t = byId[id];
  await p.evaluate(id => { location.hash = '#/task/' + id; }, id);
  await p.waitForFunction(({ id, title }) =>
    location.hash === '#/task/' + id && document.querySelector('.detail-head .dh-title')?.textContent === title,
  { id, title: t.title });
  await p.waitForSelector('.gantt');
}
async function goAgentOn(p, id) {
  await p.evaluate(id => { location.hash = '#/agent/' + id; }, id);
  await p.waitForFunction(id => location.hash === '#/agent/' + id && document.querySelector('.page-head h1')?.textContent === id, id);
  await p.waitForSelector('.task-list');
}
async function goAll(p) {
  await p.evaluate(() => { location.hash = '#/all'; });
  await p.waitForFunction(() => location.hash === '#/all' && document.querySelector('.page-head h1')?.textContent === '全部任务');
  await p.waitForSelector('.task-list');
}
const goTask = id => goTaskOn(page, id);
const goAgent = id => goAgentOn(page, id);
const rows = p => p.$$eval('.task-row', els => els.map(e => e.dataset.task));
const subBoard = p => p.$$eval('#task-board .kb-card-sub', els => els.map(e => ({
  lane: e.closest('.kb-col').dataset.col,
  title: e.querySelector('.kb-card-title')?.textContent.trim() || '',
})));
const boardCurrentLane = p => p.$eval('#task-board .kb-card:not(.kb-card-sub)', e => e.closest('.kb-col').dataset.col);
const boardNote = p => p.$eval('#task-board + .note', e => e.textContent.replace(/\s+/g, ' ').trim());
const pillData = p => p.$$eval('[data-status]', els => els.map(e => [e.dataset.status, e.firstChild.textContent.trim(), e.querySelector('.pill-count').textContent.trim()]));
const statData = p => p.$$eval('.stat', els => els.map(e => ({ v: e.querySelector('.stat-v').textContent, k: e.querySelector('.stat-k').textContent })));
const liveState = p => p.$eval('#live-panel', el => ({
  mode: el.dataset.mode, visible: Number(el.dataset.visible), total: Number(el.dataset.total), follow: el.dataset.follow,
}));
async function waitToast(p, re, timeout = 9000) {
  await p.waitForFunction(src => {
    const el = document.querySelector('#toast');
    return el && el.style.display !== 'none' && new RegExp(src).test(el.textContent);
  }, re.source, { timeout });
  return p.$eval('#toast', el => el.textContent.trim());
}
async function toastText(p) {
  return p.$eval('#toast', el => el.style.display === 'none' ? '' : el.textContent.trim());
}

/* ---------- 桥接测试工具 ---------- */
let bridgeProc = null, BRIDGE_URL = '', STUB_STATE = '';
const STUB_BIN = path.join(PROJECT, 'tests/fixtures/stub-multica');
const freePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.once('error', reject);
  srv.listen(0, '127.0.0.1', () => {
    const port = srv.address().port;
    srv.close(() => resolve(port));
  });
});
async function waitBridge(url, tries = 80) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url + '/api/bridge/status', { signal: AbortSignal.timeout(1000) });
      if (res.ok) return await res.json();
    } catch { /* retry */ }
    await sleep(100);
  }
  throw new Error('桥接在 8s 内没有就绪');
}
async function api(pathname, options = {}) {
  const res = await fetch(BRIDGE_URL + '/api/bridge' + pathname, {
    headers: { 'Content-Type': 'application/json' }, ...options,
  });
  let body = null;
  try { body = await res.json(); } catch { /* non-json */ }
  return { status: res.status, body };
}
function readStub() { return JSON.parse(fs.readFileSync(STUB_STATE, 'utf8')); }
function writeStub(state) { fs.writeFileSync(STUB_STATE, JSON.stringify(state, null, 2)); }

try {
  /* ══════════════ 1. 数据完整性 ══════════════ */
  section('数据完整性（16 份日志独立校验）');
  eq('数据集共 16 个任务', expectedTasks.length, 16);
  eq('数据集共 4 个 Agent', catalog.agents.length, 4);
  eq('Agent 名称', catalog.agents.map(a => a.id), ['qoder-cn', 'codex', 'workbuddy', 'trae-cn']);
  for (const a of catalog.agents) {
    eq(`${a.id} 有 4 个任务`, catalog.tasks.filter(t => t.agent === a.id).length, 4);
  }
  eq('任务状态分布', {
    completed: expectedTasks.filter(t => t.status === 'completed').length,
    running: expectedTasks.filter(t => t.status === 'running').length,
    failed: expectedTasks.filter(t => t.status === 'failed').length,
    canceled: expectedTasks.filter(t => t.status === 'canceled').length,
  }, { completed: 8, running: 4, failed: 3, canceled: 1 });
  for (const t of expectedTasks) {
    const seqOk = t.events.every((e, i) => i === 0 || e.seq > t.events[i - 1].seq);
    const tsOk = t.events.every((e, i) => i === 0 || Date.parse(e.ts) >= Date.parse(t.events[i - 1].ts));
    const fieldsOk = t.events.every(e => e.ts && Number.isFinite(e.seq) && e.src && e.type && e.data);
    check(`${t.id} seq 单调递增`, seqOk);
    check(`${t.id} ts 不倒流`, tsOk);
    check(`${t.id} 事件字段完整`, fieldsOk);
    if (t.status === 'running') check(`${t.id} 运行中：无收尾事件`, !t.events.some(e => e.type === 'session_summary' || e.type === 'agent_finished'));
    else check(`${t.id} 结束态：有 session_summary 与 main.agent_finished`, !!t.summary && t.events.some(e => e.type === 'agent_finished' && e.data.agent === 'main'));
    if (t.summary) {
      eq(`${t.id} summary 产物数一致`, t.summary.results_total, t.resultRows.length);
      eq(`${t.id} summary 通过数一致`, t.summary.results_verified_pass, t.counts.pass);
      eq(`${t.id} summary 未通过数一致`, t.summary.results_verified_fail, t.counts.fail);
      eq(`${t.id} summary 待验证数一致`, t.summary.results_pending, t.counts.pending);
      const costSum = t.summary.router_cost + t.summary.advisor_cost + t.summary.subagents_cost;
      check(`${t.id} 成本拆分可加和`, Math.abs(costSum - t.summary.total_cost) < 1e-4, `${costSum} vs ${t.summary.total_cost}`);
      check(`${t.id} 目录成本等于日志总成本`, Math.abs(t.cost - t.summary.total_cost) < 1e-9);
    }
    if (t.forkSummary) eq(`${t.id} fork_summary 次数一致`, t.forkSummary.forks, t.forks);
    if (t.hasRouter) check(`${t.id} 有 router 就有 fork_decision`, t.forks > 0);
    check(`${t.id} 产物路径不重复`, new Set(t.resultRows.map(r => r.path)).size === t.resultRows.length);
  }

  /* ══════════════ 1b. 模型派生边界（Node 侧单测） ══════════════ */
  section('模型派生边界（vm 单测）');
  const OBS_NODE = (() => {
    /* 沙箱要注入 URL：observatory 的 safeLink / hostOf 依赖浏览器全局，vm 默认上下文没有 */
    const ctx = { window: {}, URL };
    vm.runInNewContext(fs.readFileSync(path.join(PROJECT, 'assets/observatory.js'), 'utf8'), ctx);
    return ctx.window.Observatory;
  })();
  const iso = n => new Date(Date.parse('2026-10-25T12:00:00+08:00') + n * 1000).toISOString();
  const evt = (n, type, src, data) => ({ ts: iso(n), seq: n + 1, src, type, data });

  const doneModel = OBS_NODE.buildModel([
    evt(0, 'session_start', 'main', { task: 'x' }),
    evt(1, 'agent_finished', 'main', { agent: 'main', status: 'done' }),
  ]);
  eq('主会话以 done 收尾也归一为 completed', doneModel.status, 'completed');

  const summaryOnly = OBS_NODE.buildModel([
    evt(0, 'session_start', 'main', { task: 'x' }),
    evt(1, 'result_emitted', 'main', { path: 'a.md', created_by: 'main' }),
    evt(2, 'session_summary', 'main', { total_cost: 0.01, results_total: 1, results_verified_pass: 0, results_verified_fail: 0, results_pending: 1 }),
  ]);
  eq('有 session_summary、缺 agent_finished 也视为 completed', summaryOnly.status, 'completed');

  const protoModel = OBS_NODE.buildModel([
    evt(0, 'session_start', 'main', { task: 'x' }),
    evt(1, 'agent_spawned', 'main', { agent: '__proto__', role: 'subagent', label: 'p' }),
    evt(2, 'tool_call', '__proto__', { tool: 'x' }),
  ]);
  check('特殊 agent id 不污染原型且可派生', Object.keys(protoModel.agents).includes('__proto__') && protoModel.agents.__proto__.events.length === 1);

  const badTs = OBS_NODE.buildModel([
    { ts: 'not-a-date', seq: 1, src: 'main', type: 'session_start', data: {} },
    evt(1, 'plan', 'main', { steps: [] }),
  ]);
  check('非法 ts 不产生 NaN span', badTs.span.every(Number.isFinite), JSON.stringify(badTs.span));

  const life = OBS_NODE.buildModel([
    evt(0, 'session_start', 'main', {}),
    evt(1, 'agent_spawned', 'main', { agent: 'worker', role: 'subagent' }),
    evt(6, 'tool_call', 'worker', { tool: 'x' }),
    evt(7, 'subagent_state', 'worker', { state: 'done' }),
  ]);
  const wIv = life.agents.worker.intervals;
  eq('甘特首区间从 spawn 时刻开始', wIv[0][0], Date.parse(iso(1)));
  eq('甘特末区间延伸到 done 时刻', wIv[wIv.length - 1][1], Date.parse(iso(7)));

  const real = [evt(0, 'session_start', 'main', { task: 'x' }), evt(10, 'result_emitted', 'main', { path: 'a.md', created_by: 'main' })];
  const merged = OBS_NODE.mergeEvents(real, [{ ts: iso(5), seq: 100000, src: 'main', type: 'subtask_created', data: { title: 't' }, synthetic: true }]);
  eq('合成事件按时间插入真实事件之间', merged.map(e => e.type), ['session_start', 'subtask_created', 'result_emitted']);
  eq('合成事件不参与派生耗时', OBS_NODE.summarize({ id: 'x', log: real.map(e => JSON.stringify(e)).join('\n'), model: 'm', cost: 0, tokens: 0 }, [{ ts: iso(60), seq: 100000, src: 'main', type: 'subtask_created', data: {}, synthetic: true }]).durationMs, 10000);

  /* ---- v5：提示词捕获（main 首条 user_message / subagent spawn，回退首条 user_message） ---- */
  const promptModel = OBS_NODE.buildModel([
    evt(0, 'session_start', 'main', { task: '修 bug' }),
    evt(1, 'user_message', 'main', { text: '帮我把分页参数统一掉' }),
    evt(2, 'agent_spawned', 'main', { agent: 'worker', role: 'subagent', label: 'worker', prompt: '只改 server 层' }),
    evt(3, 'agent_spawned', 'main', { agent: 'helper', role: 'subagent', label: 'helper' }),
    evt(4, 'user_message', 'helper', { text: '先跑测试' }),
  ]);
  eq('主会话提示词取首条 user_message', promptModel.agents.main.prompt, '帮我把分页参数统一掉');
  eq('subagent 提示词取 spawn 事件', promptModel.agents.worker.prompt, '只改 server 层');
  eq('spawn 缺提示词回退首条 user_message', promptModel.agents.helper.prompt, '先跑测试');

  /* ---- v5：运行痕迹归纳（技能 / MCP / 网页 / 来源，链接去签名） ---- */
  const traceLog = [
    evt(0, 'session_start', 'main', { task: 'x' }),
    evt(1, 'user_message', 'main', { text: '看图 ![shot](https://qoder.cn/p.png?token=secret) 和 /tmp/local.png' }),
    evt(2, 'tool_call', 'main', { tool: 'mcp__multica__issue_create', input: { title: 't' }, callId: 'c1' }),
    evt(3, 'tool_call', 'main', { tool: 'WebSearch', input: { query: 'agent observability' } }),
    evt(4, 'tool_call', 'main', { tool: 'WebFetch', input: { url: 'https://example.com/doc?sig=abc' } }),
    evt(5, 'tool_call', 'main', { tool: 'skill', input: { skill: 'handoff' } }),
    evt(6, 'attachment', 'main', { name: 'design.png', host: 'qoder.cn', kind: '图片' }),
    evt(7, 'tool_result', 'main', { callId: 'c1', summary: 'created iss-1' }),
  ].map(e => JSON.stringify(e)).join('\n');
  const traced = OBS_NODE.summarize({ id: 'trace-x', log: traceLog, model: 'm', cost: 0, tokens: 0 }, []);
  eq('痕迹：MCP 工具按全名归纳', traced.model.trace.mcp.map(r => [r.name, r.server, r.tool, r.count]), [['mcp__multica__issue_create', 'multica', 'issue_create', 1]]);
  eq('痕迹：MCP 行带上结果摘要', traced.model.trace.mcp[0].result, 'created iss-1');
  eq('痕迹：Skill 调用进技能块', traced.model.trace.skills.map(r => [r.name, r.count]), [['handoff', 1]]);
  eq('痕迹：网页分搜索与抓取两类', traced.model.trace.web.map(r => [r.kind, r.count]), [['搜索', 1], ['抓取', 1]]);
  check('痕迹：抓取链接剥掉签名参数', traced.model.trace.web.some(r => r.kind === '抓取' && r.label === 'https://example.com/doc'), JSON.stringify(traced.model.trace.web));
  eq('痕迹：附件 / 图片 / 本地文件进来源块', traced.model.trace.sources.map(r => [r.name, r.kind, r.host]), [['design.png', '图片', 'qoder.cn'], ['local.png', '文件', '本地文件'], ['shot', '图片', 'qoder.cn']]);
  check('痕迹：任何一块都不含签名查询串', !/token=|sig=|sign=|\?[a-z]+=/.test(JSON.stringify(traced.model.trace)), JSON.stringify(traced.model.trace));

  /* ══════════════ 2. 页面骨架 / 默认路由 / 侧栏 ══════════════ */
  section('页面骨架 / 默认路由 / 侧栏 Agent 列表');
  await page.goto(PAGE_URL);
  await page.evaluate(() => localStorage.clear());
  await page.goto(PAGE_URL);
  await page.waitForSelector('.agent-nav-item');
  await page.waitForFunction(() => location.hash === '#/agent/qoder-cn');
  check('无 hash 时默认跳到 qoder-cn', true);
  eq('页面标题', await page.title(), 'qoder-cn · Agent Runner');
  eq('侧栏 Agent 名称', await page.$$eval('#agent-nav .agent-nav-item .an-name', els => els.map(e => e.textContent)), ['qoder-cn', 'codex', 'workbuddy', 'trae-cn']);
  eq('侧栏 Agent 角标（任务总数）', await page.$$eval('#agent-nav .an-badge', els => els.map(e => e.textContent.trim())), ['4', '4', '4', '4']);
  eq('每个 Agent 的角标 title 可解释', await page.$$eval('#agent-nav .an-badge', els => els.every(e => /个运行中 \/ 共 4 个任务/.test(e.title))), true);
  eq('侧栏导航项都是按钮', await page.$$eval('.agent-nav-item', els => els.every(e => e.tagName === 'BUTTON')), true);
  eq('OVERVIEW 入口名称', await page.$eval('#overview-nav .an-name', e => e.textContent), '全部任务');
  eq('OVERVIEW 入口角标为 16', await page.$eval('#overview-nav .an-badge', e => e.textContent.trim()), '16');
  eq('OVERVIEW 入口标题说明', await page.$eval('#overview-nav .agent-nav-item', e => e.title), '4 个运行中 / 共 16 个任务');
  eq('载入按钮存在', await page.$$eval('[data-load]', els => els.length), 2);
  eq('file:// 桥接状态为未启用', await page.$eval('#bridge-status', e => e.className.includes('offline') && e.textContent.includes('桥接未启用')), true);

  eq('默认 qoder-cn 任务数', (await rows(page)).length, 4);
  eq('默认排序：最近更新', await rows(page), ['qcn-flaky-test', 'qcn-config-layering', 'qcn-api-pagination', 'qcn-db-migration']);
  eq('单 Agent 默认按工作区分组', await page.$eval('#task-group', e => e.value), 'group');
  eq('页头标题', await page.$eval('.page-head h1', e => e.textContent), 'qoder-cn');
  check('页头副标题含厂商、模型与工作区数', /Qoder.*opus 4\.6.*1 个工作区/.test(await page.$eval('.page-sub', e => e.textContent)));

  eq('页头统计', await statData(page), [
    { v: '4', k: '任务' }, { v: '1', k: '运行中' }, { v: '2', k: '已完成' },
    { v: '2', k: '待验证产物' }, { v: '$0.8220', k: '总成本' },
  ]);
  eq('状态筛选条', await pillData(page), [
    ['all', '全部', '4'], ['running', '运行中', '1'], ['completed', '已完成', '2'],
    ['idle', '已停止', '0'], ['failed', '失败 / 取消', '1'],
  ]);
  check('列表页脚注汇总验证比例', /该 Agent 的产物验证：9\/13 通过/.test(norm(await page.$eval('.page', e => e.textContent))));

  const mini = await page.$$eval('.task-row', els => els.map(e => ({
    id: e.dataset.task,
    title: e.querySelector('.tr-results').title,
    status: e.querySelector('.tr-status .badge').textContent.trim(),
    agents: e.querySelector('.tr-num-v').textContent.trim(),
  })));
  for (const m of mini) {
    const t = byId[m.id];
    eq(`${m.id} 列表结果条计数`, m.title, `结果：${t.counts.pass} 通过 / ${t.counts.fail} 未通过 / ${t.counts.pending} 待验证`);
    eq(`${m.id} 列表状态徽标`, m.status, STATUS_TEXT[t.status]);
    eq(`${m.id} 列表 Agent 数`, m.agents, String(t.agentIds.length));
  }

  /* ══════════════ 3. 全部任务视图 ══════════════ */
  section('全部任务视图（跨 Agent 汇总）');
  await page.click('#overview-nav [data-all]');
  await page.waitForFunction(() => location.hash === '#/all' && document.querySelector('.page-head h1')?.textContent === '全部任务');
  eq('全部视图标题', await page.$eval('.page-head h1', e => e.textContent), '全部任务');
  eq('全部视图副标题', await page.$eval('.page-sub', e => e.textContent), '4 个 Agent · 16 个任务 · 1 个工作区 · 跨 Agent 汇总');
  eq('全部视图 16 行', (await rows(page)).length, 16);
  eq('全部视图默认平铺（全局排序）', await page.$eval('#task-group', e => e.value), 'flat');
  eq('全部视图默认排序', await rows(page), [
    'trae-style-migration', 'wb-oncall-runbook', 'cdx-monorepo-cache', 'qcn-flaky-test',
    'qcn-config-layering', 'wb-release-notes', 'qcn-api-pagination', 'trae-api-contract',
    'cdx-cli-flags', 'cdx-webhook-retry', 'cdx-perf-regression', 'trae-e2e-coverage',
    'qcn-db-migration', 'wb-dep-audit', 'wb-docs-migration', 'trae-doc-sync',
  ]);
  await page.selectOption('#task-sort', 'created');
  eq('全部视图按创建时间降序', await rows(page), [
    'trae-style-migration', 'wb-oncall-runbook', 'cdx-monorepo-cache', 'qcn-flaky-test',
    'qcn-config-layering', 'wb-release-notes', 'qcn-api-pagination', 'trae-api-contract',
    'cdx-cli-flags', 'cdx-webhook-retry', 'cdx-perf-regression', 'trae-e2e-coverage',
    'qcn-db-migration', 'wb-dep-audit', 'wb-docs-migration', 'trae-doc-sync',
  ]);
  await page.selectOption('#task-sort', 'updated');
  eq('全部视图统计', await statData(page), [
    { v: '4', k: '覆盖 Agent' }, { v: '16', k: '任务' }, { v: '4', k: '运行中' },
    { v: '8', k: '已完成' }, { v: '12', k: '待验证产物' }, { v: '$2.7970', k: '总成本' },
  ]);
  eq('全部视图状态筛选条', await pillData(page), [
    ['all', '全部', '16'], ['running', '运行中', '4'], ['completed', '已完成', '8'],
    ['idle', '已停止', '0'], ['failed', '失败 / 取消', '4'],
  ]);
  eq('全部视图 Agent 过滤条', await page.$$eval('[data-all-agent]', els => els.map(e => [e.dataset.allAgent, e.querySelector('.pill-label')?.textContent.trim() ?? '', e.querySelector('.pill-count').textContent.trim()])), [
    ['all', '全部 Agent', '16'], ['qoder-cn', 'qoder-cn', '4'], ['codex', 'codex', '4'], ['workbuddy', 'workbuddy', '4'], ['trae-cn', 'trae-cn', '4'],
  ]);
  check('全部视图行带 Agent 标记', await page.$$eval('.task-row .tr-agent-name', els => els.length === 16 && els.map(e => e.textContent).includes('trae-cn')));
  check('全部视图页脚汇总验证比例', /全部产物验证：29\/46 通过/.test(norm(await page.$eval('.page', e => e.textContent))));
  await page.screenshot({ path: path.join(SHOT_DIR, 'list-overview.png'), fullPage: true });

  await page.click('[data-all-agent="trae-cn"]');
  await page.waitForFunction(() => document.querySelectorAll('.task-row').length === 4);
  eq('全部视图按 trae-cn 过滤', await rows(page), ['trae-style-migration', 'trae-api-contract', 'trae-e2e-coverage', 'trae-doc-sync']);
  eq('trae-cn 过滤后统计', await statData(page), [
    { v: '1', k: '覆盖 Agent' }, { v: '4', k: '任务' }, { v: '1', k: '运行中' },
    { v: '2', k: '已完成' }, { v: '4', k: '待验证产物' }, { v: '$0.5650', k: '总成本' },
  ]);
  eq('trae-cn 过滤后状态计数', await pillData(page), [
    ['all', '全部', '4'], ['running', '运行中', '1'], ['completed', '已完成', '2'],
    ['idle', '已停止', '0'], ['failed', '失败 / 取消', '1'],
  ]);
  check('trae-cn 页脚验证比例', /全部产物验证：7\/12 通过/.test(norm(await page.$eval('.page', e => e.textContent))));
  await page.screenshot({ path: path.join(SHOT_DIR, 'list-trae.png'), fullPage: true });

  await page.click('[data-all-agent="all"]');
  await page.waitForFunction(() => document.querySelectorAll('.task-row').length === 16);
  await page.click('[data-status="failed"]');
  eq('全部视图失败 / 取消筛选', await rows(page), ['cdx-perf-regression', 'trae-e2e-coverage', 'qcn-db-migration', 'wb-dep-audit']);
  await page.click('[data-status="running"]');
  eq('全部视图运行中筛选', await rows(page), ['trae-style-migration', 'wb-oncall-runbook', 'cdx-monorepo-cache', 'qcn-flaky-test']);
  await page.click('[data-status="all"]');
  await page.fill('#task-q', 'trae');
  eq('跨 Agent 搜索 Agent 名', await rows(page), ['trae-style-migration', 'trae-api-contract', 'trae-e2e-coverage', 'trae-doc-sync']);
  await page.fill('#task-q', '订单');
  eq('跨 Agent 搜索标题', await rows(page), ['trae-api-contract']);
  await page.fill('#task-q', '');
  await page.selectOption('#task-sort', 'cost');
  const allCosts = (await rows(page)).map(id => byId[id].cost);
  eq('全部视图按成本降序', allCosts, [...allCosts].sort((a, b) => b - a));
  await page.selectOption('#task-sort', 'recent');
  await goAgent('qoder-cn');

  /* ══════════════ 4. 单 Agent 筛选 / 搜索 / 排序 / 切换 ══════════════ */
  section('单 Agent 筛选 / 搜索 / 排序 / 切换');
  await page.click('[data-status="running"]');
  eq('筛选运行中', await rows(page), ['qcn-flaky-test']);
  await page.click('[data-status="completed"]');
  eq('筛选已完成', await rows(page), ['qcn-config-layering', 'qcn-api-pagination']);
  await page.click('[data-status="failed"]');
  eq('筛选失败 / 取消', await rows(page), ['qcn-db-migration']);
  await page.click('[data-status="all"]');
  eq('恢复全部', (await rows(page)).length, 4);

  await page.fill('#task-q', 'order-service');
  eq('搜索仓库名', await rows(page), ['qcn-api-pagination', 'qcn-db-migration']);
  await page.fill('#task-q', 'flaky');
  eq('搜索标题', await rows(page), ['qcn-flaky-test']);
  await page.fill('#task-q', 'qcn-api');
  eq('搜索任务 ID', await rows(page), ['qcn-api-pagination']);
  await page.fill('#task-q', '不存在的关键词');
  eq('搜索无命中显示空态', await page.$eval('.empty-state b', e => e.textContent), '没有匹配的任务');
  await page.fill('#task-q', '');

  await page.selectOption('#task-sort', 'cost');
  const qCosts = (await rows(page)).map(id => byId[id].cost);
  eq('按成本降序', qCosts, [...qCosts].sort((a, b) => b - a));
  await page.selectOption('#task-sort', 'duration');
  const qDurations = (await rows(page)).map(id => byId[id].durationMs);
  eq('按耗时降序', qDurations, [...qDurations].sort((a, b) => b - a));
  await page.selectOption('#task-sort', 'recent');

  await page.click('#agent-nav .agent-nav-item[data-agent="codex"]');
  await page.waitForFunction(() => document.querySelector('.page-head h1')?.textContent === 'codex');
  eq('切到 codex：4 个任务', (await rows(page)).length, 4);
  eq('切换 Agent 后筛选重置', await page.$eval('[data-status="all"]', e => e.classList.contains('active')), true);
  eq('切换 Agent 后搜索框清空', await page.$eval('#task-q', e => e.value), '');
  eq('codex 任务集合', await rows(page), ['cdx-monorepo-cache', 'cdx-cli-flags', 'cdx-webhook-retry', 'cdx-perf-regression']);
  eq('codex 页头模型', await page.$eval('.page-sub', e => e.textContent.replace(/\s+/g, ' ').trim()), 'CLI 与基础设施任务的默认执行器 · OpenAI gpt-5.1-codex · 1 个工作区');

  await page.click('#agent-nav .agent-nav-item[data-agent="workbuddy"]');
  await page.waitForFunction(() => document.querySelector('.page-head h1')?.textContent === 'workbuddy');
  eq('切到 workbuddy：4 个任务', (await rows(page)).length, 4);
  eq('workbuddy 任务集合', await rows(page), ['wb-oncall-runbook', 'wb-release-notes', 'wb-dep-audit', 'wb-docs-migration']);
  await page.screenshot({ path: path.join(SHOT_DIR, 'list-workbuddy.png'), fullPage: true });

  await page.click('#agent-nav .agent-nav-item[data-agent="trae-cn"]');
  await page.waitForFunction(() => document.querySelector('.page-head h1')?.textContent === 'trae-cn');
  eq('切到 trae-cn：4 个任务', (await rows(page)).length, 4);
  eq('trae-cn 任务集合', await rows(page), ['trae-style-migration', 'trae-api-contract', 'trae-e2e-coverage', 'trae-doc-sync']);
  eq('trae-cn 页头模型', await page.$eval('.page-sub', e => e.textContent.replace(/\s+/g, ' ').trim()), 'Trae CN 端到端交付线，前端与接口联调见长 · Trae doubao-seed-code · 1 个工作区');

  await page.click('#agent-nav .agent-nav-item[data-agent="codex"]');
  await page.waitForFunction(() => document.querySelector('.page-head h1')?.textContent === 'codex');
  await page.click('[data-status="failed"]');
  eq('失败 / 取消筛选包含 canceled', await rows(page), ['cdx-perf-regression']);

  await goAgent('qoder-cn');
  await page.click('[data-status="failed"]');
  eq('qoder 侧筛选后只显示失败任务', await rows(page), ['qcn-db-migration']);
  await goTask('cdx-webhook-retry');
  await page.click('#back-btn');
  await page.waitForFunction(() => location.hash === '#/agent/codex' && document.querySelector('.page-head h1')?.textContent === 'codex');
  eq('跨 Agent 深链返回后过滤条件重置', (await rows(page)).length, 4);
  eq('跨 Agent 返回后状态回到全部', await page.$eval('[data-status="all"]', e => e.classList.contains('active')), true);

  /* ══════════════ 5. 导航 / 深链 / 返回 / 非法路由 ══════════════ */
  section('导航 / 深链 / 返回 / 非法路由');
  await goAgent('qoder-cn');
  await page.click('.task-row[data-task="qcn-api-pagination"]');
  await page.waitForFunction(() => location.hash === '#/task/qcn-api-pagination' && document.querySelector('.dh-title'));
  eq('点任务行进入详情', await page.$eval('.dh-title', e => e.textContent), 'API 分页统一改造');
  eq('详情页标题', await page.title(), 'API 分页统一改造 · Agent Runner');
  eq('详情面包屑含 Agent', await page.evaluate(() => [
    document.querySelector('.crumb b').textContent,
    document.querySelector('.crumb a').textContent,
    document.querySelector('.crumb .current').textContent,
  ]), ['Agent Runner', 'qoder-cn', 'API 分页统一改造']);
  await page.click('#back-btn');
  await page.waitForFunction(() => location.hash === '#/agent/qoder-cn' && document.querySelector('.page-head h1'));
  eq('返回按钮回到原 Agent 列表', await page.$eval('.page-head h1', e => e.textContent), 'qoder-cn');
  eq('返回后仍是 4 行', (await rows(page)).length, 4);

  await goAll(page);
  await page.click('.task-row[data-task="trae-api-contract"]');
  await page.waitForFunction(() => location.hash === '#/task/trae-api-contract' && document.querySelector('.dh-title'));
  eq('全部视图进入详情', await page.$eval('.dh-title', e => e.textContent), '订单 API 契约生成');
  eq('全部视图返回按钮文案', await page.$eval('#back-btn', e => e.textContent.trim()), '← 全部任务');
  await page.click('#back-btn');
  await page.waitForFunction(() => location.hash === '#/all' && document.querySelector('.page-head h1')?.textContent === '全部任务');
  eq('从全部视图返回后仍 16 行', (await rows(page)).length, 16);

  await goTask('cdx-webhook-retry');
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => location.hash === '#/task/cdx-webhook-retry' && document.querySelector('.dh-title'));
  eq('详情深链刷新后仍能打开', await page.$eval('.dh-title', e => e.textContent), 'Webhook 重试与幂等');
  eq('刷新后侧栏高亮所属 Agent', await page.$eval('#agent-nav .agent-nav-item.active .an-name', e => e.textContent), 'codex');
  eq('刷新后 OVERVIEW 入口不高亮', await page.$eval('#overview-nav .agent-nav-item', e => e.classList.contains('active')), false);

  await page.evaluate(() => { location.hash = '#/task/does-not-exist'; });
  await page.waitForSelector('.empty-state');
  check('不存在的任务显示空态', /找不到任务 does-not-exist/.test(await page.$eval('.page', e => e.textContent)));
  await page.click('#back-btn');
  await page.waitForFunction(() => location.hash === '#/agent/qoder-cn' && document.querySelector('.task-list'));
  eq('非法任务返回默认 Agent', await page.$eval('.page-head h1', e => e.textContent), 'qoder-cn');

  await page.goto(PAGE_URL + '#/task/does-not-exist');
  await page.waitForSelector('.empty-state');
  eq('冷启动非法任务仍渲染侧栏', await page.$$eval('#agent-nav .agent-nav-item', els => els.length), 4);
  check('冷启动非法任务仍渲染顶栏', /Agent Runner/.test(await page.$eval('#crumb', e => e.textContent)));
  check('冷启动非法任务顶栏有快捷入口', (await page.$eval('.topbar-right [data-load]', e => e.getBoundingClientRect().width)) > 0);
  await page.click('#back-btn');
  await page.waitForFunction(() => location.hash === '#/agent/qoder-cn' && document.querySelector('.task-list'));

  await page.evaluate(() => { location.hash = '#/agent/does-not-exist'; });
  await page.waitForTimeout(80);
  eq('不存在的 Agent 回退首个 Agent', await page.$eval('.page-head h1', e => e.textContent), 'qoder-cn');
  check('无 JS 崩溃即可（未知 Agent 容错）', pageErrors.length === 0, pageErrors.join(' | '));

  /* ══════════════ 6. 16 个任务详情全量验收 ══════════════ */
  section('16 个任务详情全量验收（UI vs 日志）');
  for (const t of expectedTasks) {
    await goTask(t.id);
    const ui = await page.evaluate(() => {
      const txt = s => { const el = document.querySelector(s); return el ? el.textContent.trim() : null; };
      const chips = [...document.querySelectorAll('.chip')].map(c => ({ v: c.querySelector('.chip-v').textContent.trim(), k: c.querySelector('.chip-k').textContent.trim() }));
      const cards = [...document.querySelectorAll('.agent-card')].map(c => ({
        name: c.querySelector('.ac-name').textContent.trim(),
        role: c.querySelector('.ac-role').textContent.trim(),
        status: c.querySelector('.stx').textContent.trim(),
        meta: c.querySelector('.ac-meta').textContent.replace(/\s+/g, ' ').trim(),
      }));
      const svg = document.querySelector('.svgwrap svg');
      const svgTexts = svg ? [...svg.querySelectorAll('text')].map(e => e.textContent) : [];
      const svgRects = svg ? [...svg.querySelectorAll('rect.arch-box')].length : 0;
      const boardCols = [...document.querySelectorAll('#task-board .kb-col')].map(e => e.dataset.col);
      const boardCards = [...document.querySelectorAll('#task-board .kb-card')].map(e => ({
        lane: (e.closest('.kb-col') || {}).dataset?.col || '',
        kind: e.classList.contains('kb-card-sub') ? 'subtask' : 'current',
        title: e.querySelector('.kb-card-title')?.textContent.trim() || '',
        tags: [...e.querySelectorAll('.kb-tag')].map(x => x.textContent.trim()),
      }));
      const boardTitle = [...document.querySelectorAll('.panel h2')].find(h => h.textContent.includes('任务看板'))?.textContent.replace(/\s+/g, ' ').trim() || '';
      const boardNote = (document.querySelector('#task-board')?.parentElement?.querySelector('.note')?.textContent || '').replace(/\s+/g, ' ').trim();
      const lines = svg ? [...svg.querySelectorAll('line')].map(l => ({
        x1: +l.getAttribute('x1'), y1: +l.getAttribute('y1'), x2: +l.getAttribute('x2'), y2: +l.getAttribute('y2'),
      })) : [];
      const panels = [...document.querySelectorAll('#panels .grid > section.panel')].map(e => ({
        cls: e.className,
        h2: (e.querySelector('h2')?.textContent || '').replace(/\s+/g, ' ').trim(),
      }));
      const promptRows = [...document.querySelectorAll('.prompt-row')].map(e => ({
        id: e.dataset.archAgent,
        src: e.querySelector('.pr-src')?.textContent.trim() || '',
        prompt: e.querySelector('.pr-prompt')?.textContent.trim() || '',
        task: e.querySelector('.pr-block .pr-v')?.textContent.trim() || '',
      }));
      const traceBlocks = [...document.querySelectorAll('.trace-block')].map(e => ({
        h3: (e.querySelector('h3')?.textContent || '').replace(/\s+/g, ' ').trim(),
        rows: e.querySelectorAll('.trace-row').length,
        empty: e.querySelector('.trace-empty')?.textContent.trim() || '',
      }));
      const traceTotal = (document.querySelector('.trace-total')?.textContent || '').replace(/\s+/g, ' ').trim();
      const traceNote = (document.querySelector('.trace-grid')?.parentElement?.querySelector('.note')?.textContent || '').replace(/\s+/g, ' ').trim();
      const inspector = {
        id: document.querySelector('#arch-inspector')?.dataset.archInspector || '',
        name: document.querySelector('#arch-inspector .ai-name')?.textContent.trim() || '',
        pin: document.querySelector('#arch-inspector .ai-pin')?.textContent.trim() || '',
        blocks: document.querySelectorAll('#arch-inspector .ai-block').length,
        logs: document.querySelectorAll('#arch-inspector .ai-loglist li').length,
      };
      return {
        title: txt('.dh-title'), status: txt('.dh-top .badge'), meta: txt('.dh-meta'),
        chips, cards, svgTexts, svgRects, boardCols, boardCards, boardTitle, boardNote, lines,
        liveTotal: Number(document.querySelector('#live-panel')?.dataset.total || 0),
        gRows: [...document.querySelectorAll('.grow .glabel')].map(e => e.textContent.trim()),
        gBars: [...document.querySelectorAll('.gbar')].filter(e => e.getBoundingClientRect().width > 0).length,
        gBarTotal: document.querySelectorAll('.gbar').length,
        gMarks: document.querySelectorAll('.gmark').length,
        steps: [...document.querySelectorAll('.step')].map(e => ({ text: e.textContent.replace(/\s+/g, ' ').trim(), done: e.classList.contains('done') })),
        resultRows: [...document.querySelectorAll('.results-table tbody tr')].map(tr => [...tr.children].map(td => td.textContent.replace(/\s+/g, ' ').trim())),
        resultsEmpty: txt('.panel.full .empty'),
        notes: [...document.querySelectorAll('.note')].map(e => e.textContent.replace(/\s+/g, ' ').trim()),
        resultBadges: [...document.querySelectorAll('.results-table .badge')].map(e => e.textContent.trim()),
        panels, promptRows, traceBlocks, traceTotal, traceNote, inspector,
      };
    });

    eq(`${t.id} 标题`, ui.title, t.title);
    eq(`${t.id} 状态徽标`, ui.status, STATUS_TEXT[t.status]);
    check(`${t.id} 元信息含仓库/模型/成本`, ui.meta.includes(t.repo) && ui.meta.includes(t.model) && ui.meta.includes(fmtCost(t.cost)), ui.meta);
    if (t.status !== 'running') check(`${t.id} 元信息含耗时`, ui.meta.includes('历时 ' + fmtDur(t.durationMs)), ui.meta);

    eq(`${t.id} Agent 卡片数`, ui.cards.length, t.agentIds.length);
    eq(`${t.id} 主 Agent 卡`, [ui.cards[0].name, ui.cards[0].status], ['主 Agent', t.status === 'completed' ? 'DONE' : t.status.toUpperCase()]);
    eq(`${t.id} Subagent 卡`, ui.cards.filter(c => c.role.startsWith('subagent')).length, t.subCount);
    const liveCount = t.status === 'running'
      ? 1 + (t.hasRouter ? 1 : 0) + (t.hasAdvisor ? 1 : 0) + t.working.length
      : 0;
    eq(`${t.id} 活跃 Agent 数`, ui.cards.filter(c => c.status === 'RUNNING' || c.status === 'WORKING').length, liveCount);

    eq(`${t.id} 架构图盒子数`, ui.svgRects, 1 + (t.hasRouter ? 1 : 0) + (t.hasAdvisor ? 1 : 0) + t.subCount + 1);
    eq(`${t.id} 架构图 router 提示`, ui.svgTexts.some(x => x === 'JEV · fork 路由'), t.hasRouter);
    eq(`${t.id} 架构图 advisor 提示`, ui.svgTexts.some(x => x === 'FABLE · advisor'), t.hasAdvisor);
    check(`${t.id} 架构图产物区数量`, ui.svgTexts.some(x => x === `产物区 · ${t.resultRows.length} 个结果`));
    const subY = t.hasRouter || t.hasAdvisor ? 196 : 120;
    const spawnEdges = ui.lines.filter(l => l.y2 === subY);
    eq(`${t.id} 架构图 spawn 连线数`, spawnEdges.length, t.subCount);
    eq(`${t.id} spawn 连线起点正确`, spawnEdges.every(l => l.y1 === (t.hasRouter || t.hasAdvisor ? 136 : 54)), true);
    check(`${t.id} 架构验收门计数`, ui.svgTexts.includes(`通过 ${t.counts.pass} · 未过 ${t.counts.fail} · 待验证 ${t.counts.pending}`), ui.svgTexts.filter(x => x.includes('通过 ')).join(' | '));

    check(`${t.id} 独立看板面板标题`, ui.boardTitle.includes('任务看板'), ui.boardTitle);
    eq(`${t.id} 看板六列顺序`, ui.boardCols, ['todo', 'running', 'review', 'done', 'idle', 'failed']);
    const currentCards = ui.boardCards.filter(c => c.kind === 'current');
    eq(`${t.id} 看板当前卡唯一`, currentCards.length, 1);
    eq(`${t.id} 看板当前卡所在列`, currentCards[0] && currentCards[0].lane, BOARD_LANE_OF(t));
    if (t.status === 'canceled') eq(`${t.id} 看板取消卡带状态标记`, currentCards[0].tags.includes('已取消'), true);
    if (t.status === 'failed') eq(`${t.id} 看板失败卡带状态标记`, currentCards[0].tags.includes('失败'), true);
    eq(`${t.id} 看板初始无子任务卡`, ui.boardCards.filter(c => c.kind === 'subtask').length, 0);
    check(`${t.id} 看板无子任务脚注`, ui.boardNote.includes('无子任务'), ui.boardNote);

    /* ---- v5：7 面板顺序 / 提示词面板 / 工作痕迹 / 架构检查器 ---- */
    eq(`${t.id} 详情共 7 个面板`, ui.panels.length, 7);
    eq(`${t.id} 面板全部通栏`, ui.panels.every(p => p.cls.includes('full')), true);
    eq(`${t.id} 运行架构面板独占首行`, ui.panels[0].cls.includes('arch-panel'), true);
    eq(`${t.id} 面板顺序`, ui.panels.map(p => p.h2), [
      '① 运行架构 · 会话执行面 + 验收门 · 点击 / 悬停节点看任务与日志',
      '② 有多少 Agent 在执行 · 状态与开销',
      '③ 任务与提示词 · 每个 Agent 在做什么、收到什么指令',
      '④ 工作痕迹 · 技能 / MCP / 产出 / 网页查阅 / 来源',
      '⑤ 任务看板 · 当前任务与已派发子任务',
      '⑥ 执行进度 · ■ 活跃区间 · ✗ 报错 · ◆ advisor 干预',
      '⑦ 生成的结果放在哪里 + 是否待验证',
    ]);
    eq(`${t.id} 提示词面板行数 = Agent 数`, ui.promptRows.length, t.agentIds.length);
    eq(`${t.id} 提示词面板覆盖每个 Agent`, ui.promptRows.map(r => r.id).slice().sort(), t.agentIds.slice().sort());
    check(`${t.id} 演示日志无提示词时明说未记录`, ui.promptRows.every(r => r.src === '提示词未记录' && r.prompt === '日志未记录'), JSON.stringify(ui.promptRows[0]));
    eq(`${t.id} 痕迹面板四块结构`, ui.traceBlocks.map(b => b.h3.replace(/ \d+$/, '')), ['技能与 MCP', '产出', '网页查阅', '来源']);
    eq(`${t.id} 痕迹汇总条`, ui.traceTotal, `技能/MCP 0 · 产出 ${t.resultRows.length} · 网页 0 · 来源 0`);
    check(`${t.id} 无技能/MCP 痕迹时给空态`, ui.traceBlocks[0].empty === '日志里没有 Skill 或 mcp__ 工具调用。', ui.traceBlocks[0].empty);
    if (t.resultRows.length) eq(`${t.id} 产出痕迹行数`, ui.traceBlocks[1].rows, t.resultRows.length);
    else check(`${t.id} 无产物痕迹空态`, ui.traceBlocks[1].empty === '当前任务还没有发布产物。', ui.traceBlocks[1].empty);
    check(`${t.id} 网页与来源空态`, ui.traceBlocks[2].empty === '日志里没有 WebSearch / WebFetch 调用。' && ui.traceBlocks[3].empty === '日志里没有用户附件或本地图片引用。', JSON.stringify(ui.traceBlocks.slice(2)));
    check(`${t.id} 痕迹脚注声明只统计真实出现`, ui.traceNote.includes('只统计日志里真实出现的工具名与附件块'), ui.traceNote);
    eq(`${t.id} 检查器默认看主会话`, [ui.inspector.id, ui.inspector.name, ui.inspector.pin], ['main', '主 Agent', '已固定']);
    check(`${t.id} 检查器含四区与最近日志`, ui.inspector.blocks === 4 && ui.inspector.logs > 0, JSON.stringify(ui.inspector));

    eq(`${t.id} Gantt 行`, ui.gRows, ['main', ...(t.hasRouter ? ['router'] : []), ...(t.hasAdvisor ? ['advisor'] : []), ...t.agentIds.filter(a => !['main', 'router', 'advisor'].includes(a))]);
    check(`${t.id} Gantt 有可见活跃条`, ui.gBars > 0, `${ui.gBars}/${ui.gBarTotal}`);
    eq(`${t.id} Gantt 报错/干预标记`, ui.gMarks, t.errors + t.interventions);

    eq(`${t.id} 计划步数`, ui.steps.length, t.plan.length);
    if (t.status === 'completed') eq(`${t.id} 收尾后所有计划步完成`, ui.steps.every(s => s.done), true);

    eq(`${t.id} 产物行数`, ui.resultRows.length, t.resultRows.length);
    for (const want of t.resultRows) {
      const row = ui.resultRows.find(r => r[2] === want.path);
      if (!check(`${t.id} 产物 ${want.path} 存在`, !!row)) continue;
      eq(`${t.id} ${want.path} 生成者`, row[3], want.by);
      eq(`${t.id} ${want.path} 验证徽标`, row[5], badgeOf(want.verdict));
      if (want.verdict === 'pending') check(`${t.id} ${want.path} 标注无验证事件`, row[6].includes('尚无 verification 事件'));
      if (want.verdict === 'fail') check(`${t.id} ${want.path} 带失败证据`, row[6].length > 10);
    }
    if (!t.resultRows.length) check(`${t.id} 无产物时显示空态`, /当前任务还没有发布任何产物/.test(ui.resultsEmpty || ''), ui.resultsEmpty);

    const notes = ui.notes.join(' | ');
    if (t.status === 'running') {
      const progress = t.resultRows.length ? `已有 ${t.resultRows.length} 个产物` : '日志里还没有产物记录';
      check(`${t.id} 运行中提示`, notes.includes('任务仍在执行') && notes.includes(progress), notes);
      check(`${t.id} 耗时为已运行（日志跨度）`, ui.chips.some(c => c.k === '已运行' && c.v === fmtDur(t.durationMs) + '（日志跨度）'), JSON.stringify(ui.chips));
    } else {
      if (t.summary && t.summary.next) check(`${t.id} 收工遗留提示`, notes.includes('收工遗留：' + t.summary.next), notes);
      else check(`${t.id} 默认交付提示`, notes.includes('所有产物均已有验证结论，可以交付。'), notes);
      check(`${t.id} 耗时标签为总耗时`, ui.chips.some(c => c.k === '总耗时'), JSON.stringify(ui.chips));
    }

    eq(`${t.id} chips Agent/Subagent`, [ui.chips[0].v, ui.chips[1].v], [String(t.agentIds.length), String(t.subCount)]);
    if (t.hasRouter) {
      eq(`${t.id} chips fork 决策数`, [ui.chips[2].k, ui.chips[2].v], ['fork 决策', String(t.forkSummary ? t.forkSummary.forks : t.forks)]);
      eq(`${t.id} chips 平均决策耗时`, ui.chips[3].v, t.forkSummary ? t.forkSummary.avg_elapsed_ms + 'ms' : '—');
    } else {
      eq(`${t.id} chips 工具调用数`, [ui.chips[2].k, ui.chips[2].v], ['工具调用', String(t.tools)]);
      eq(`${t.id} chips 对话事件数`, [ui.chips[3].k, ui.chips[3].v], ['对话事件', String(t.messages)]);
    }
    eq(`${t.id} chips 总成本`, ui.chips[4].v, fmtCost(t.summary ? t.summary.total_cost : t.cost));
    eq(`${t.id} chips 结果状态`, ui.chips[6].v, `${t.counts.pass} 通过 · ${t.counts.fail} 未过 · ${t.counts.pending} 待验证`);

    eq(`${t.id} 线索流总数`, ui.liveTotal, t.events.length);
    eq(`${t.id} 线索流 Agent 选项`, await page.$$eval('#live-agent option', els => els.map(o => o.value)), ['', ...t.srcs]);
    eq(`${t.id} 线索流类型选项`, await page.$$eval('#live-type option', els => els.map(o => o.value)), ['', ...t.firstTypes]);

    if (t.id === 'qcn-config-layering') {
      eq('主案例卡片名称', ui.cards.map(c => c.name), ['主 Agent', 'JEV · fork 层', 'FABLE · advisor', 'explorer', 'researcher', 'worker']);
      eq('主案例计划步骤', ui.steps.map(s => (s.text.match(/^S\d+/) || [s.text])[0]), ['S1', 'S2', 'S3', 'S4']);
      await page.screenshot({ path: path.join(SHOT_DIR, 'detail-completed-both.png'), fullPage: true });
    }
    if (t.id === 'qcn-api-pagination') await page.screenshot({ path: path.join(SHOT_DIR, 'detail-no-router-advisor.png'), fullPage: true });
    if (t.id === 'cdx-cli-flags') await page.screenshot({ path: path.join(SHOT_DIR, 'detail-router-only.png'), fullPage: true });
    if (t.id === 'cdx-webhook-retry') await page.screenshot({ path: path.join(SHOT_DIR, 'detail-advisor-only.png'), fullPage: true });
    if (t.id === 'qcn-flaky-test') await page.screenshot({ path: path.join(SHOT_DIR, 'detail-running.png'), fullPage: true });
    if (t.id === 'qcn-db-migration') await page.screenshot({ path: path.join(SHOT_DIR, 'detail-failed.png'), fullPage: true });
    if (t.id === 'trae-api-contract') await page.screenshot({ path: path.join(SHOT_DIR, 'detail-trae-both.png'), fullPage: true });
    if (t.id === 'trae-style-migration') await page.screenshot({ path: path.join(SHOT_DIR, 'detail-trae-running.png'), fullPage: true });
    if (t.id === 'cdx-perf-regression') {
      const color = await page.$eval('.agent-card .stx', e => getComputedStyle(e).color);
      check('取消态主卡不用红色', color !== 'rgb(248, 113, 113)', color);
      await page.screenshot({ path: path.join(SHOT_DIR, 'detail-canceled.png'), fullPage: true });
    }
    if (t.id === 'wb-oncall-runbook') {
      eq('无产物任务不渲染结果表', await page.$$eval('.results-table', els => els.length), 0);
      eq('无产物任务 Agent 数', ui.cards.length, 2);
    }
  }

  /* ══════════════ 6.5 架构节点检查器（悬停预览 / 点击 / 键盘固定） ══════════════ */
  section('架构节点检查器（悬停预览 / 点击 / 键盘固定）');
  await goTask('qcn-config-layering');
  const inspectorState = () => page.evaluate(() => ({
    view: document.querySelector('#arch-inspector')?.dataset.archInspector,
    name: document.querySelector('#arch-inspector .ai-name')?.textContent.trim(),
    pin: document.querySelector('#arch-inspector .ai-pin')?.textContent.trim(),
    selected: [...document.querySelectorAll('.arch-node.selected')].map(e => e.dataset.archAgent),
    logs: document.querySelectorAll('#arch-inspector .ai-loglist li').length,
  }));
  const archNode = id => page.locator(`.arch-node[data-arch-agent="${id}"]`);
  eq('检查器默认固定主会话', await inspectorState(), { view: 'main', name: '主 Agent', pin: '已固定', selected: ['main'], logs: 9 });

  await archNode('explorer').hover();
  eq('悬停 subagent 节点出预览', await inspectorState(), { view: 'explorer', name: 'explorer', pin: '悬停预览', selected: ['explorer'], logs: 9 });
  await page.mouse.move(2, 2);
  await page.waitForTimeout(60);
  eq('移开后回到固定项', await inspectorState(), { view: 'main', name: '主 Agent', pin: '已固定', selected: ['main'], logs: 9 });

  await archNode('researcher').click();
  eq('点击节点固定检查器', await inspectorState(), { view: 'researcher', name: 'researcher', pin: '已固定', selected: ['researcher'], logs: 7 });
  await archNode('worker').hover();
  eq('固定后悬停仍可预览别的节点', (await inspectorState()).view, 'worker');
  await page.mouse.move(2, 2);
  await page.waitForTimeout(60);
  eq('移开后回到固定项而非默认项', (await inspectorState()).view, 'researcher');

  await archNode('worker').focus();
  eq('聚焦节点出预览', (await inspectorState()).view, 'worker');
  await page.keyboard.press('Enter');
  eq('Enter 固定节点', await inspectorState(), { view: 'worker', name: 'worker', pin: '已固定', selected: ['worker'], logs: 9 });
  await archNode('worker').blur();
  eq('失焦后留在固定项', (await inspectorState()).view, 'worker');
  await archNode('explorer').focus();
  await page.keyboard.press(' ');
  eq('空格同样固定节点', (await inspectorState()).view, 'explorer');

  await page.click('.prompt-row[data-arch-agent="worker"]');
  eq('提示词面板点击行同步固定检查器', (await inspectorState()).view, 'worker');
  await archNode('explorer').hover();
  await page.click('#arch-inspector [data-arch-pin]');
  eq('检查器内固定按钮可点（悬停预览不瞬掉）', await inspectorState(), { view: 'explorer', name: 'explorer', pin: '已固定', selected: ['explorer'], logs: 9 });

  const ins = await page.evaluate(() => {
    const host = document.querySelector('#arch-inspector');
    return {
      ks: [...host.querySelectorAll('.ai-k')].map(e => e.textContent.replace(/\s+/g, ' ').trim()),
      bar: !!host.querySelector('.ai-bar'),
      stats: host.querySelectorAll('.ai-stat').length,
      live: !!host.querySelector('[data-arch-action="live"]'),
      taskText: host.querySelector('.ai-block .ai-v')?.textContent.trim() || '',
    };
  });
  check('检查器含任务内容 / 提示词 / 执行进度 / 日志四区', ins.ks.some(x => x.startsWith('任务内容')) && ins.ks.some(x => x.startsWith('提示词')) && ins.ks.some(x => x.startsWith('执行进度')) && ins.ks.some(x => x.startsWith('正在执行的日志')), JSON.stringify(ins.ks));
  check('检查器有进度条与执行统计', ins.bar && ins.stats >= 3, JSON.stringify(ins));
  check('检查器提供完整执行日志入口', ins.live);
  const kept = await page.evaluate(() => {
    const before = document.querySelector('#arch-inspector').dataset.archInspector;
    window.Observatory.renderPanels(document.querySelector('#panels'), window.__RUNNER_DETAIL.summary.model, {
      board: { id: 'qcn-config-layering', title: '重渲染回归', status: 'completed', counts: { pass: 1, fail: 0, pending: 0, total: 1 }, updatedAt: 1 },
    });
    return { before, after: document.querySelector('#arch-inspector').dataset.archInspector };
  });
  eq('重渲染后检查器选择不丢', kept.after, kept.before);
  await goTask('qcn-config-layering');

  /* ══════════════ 6.6 顶栏版本标记 ══════════════ */
  section('顶栏版本标记');
  const ver = await page.evaluate(() => window.OBS_VERSION);
  eq('版本单一事实源可读', [ver.product, ver.version], ['Agent Runner', '5.0.0']);
  eq('顶栏版本号与事实源一致', await page.$eval('#ver-chip', e => e.textContent.trim()), 'v' + ver.version);
  eq('版本按钮标题含版本 / 日期 / 主题', /^v5\.0\.0 · 2026-10-25 · .+/.test(await page.$eval('#ver-chip', e => e.title)), true);
  eq('版本号写进 data 属性', await page.$eval('#ver-chip', e => e.dataset.version), ver.releases[0].version);
  await page.click('#ver-chip');
  eq('点击出版本弹层', await page.$eval('#ver-pop', e => !e.hasAttribute('hidden')), true);
  eq('弹层含当前版本全部说明', await page.$$eval('#ver-pop .vp-notes li', els => els.length), ver.releases[0].notes.length);
  eq('弹层列历史版本', await page.$$eval('#ver-pop .vp-old', els => els.map(e => e.querySelector('.vp-v').textContent)), ver.releases.slice(1).map(r => 'v' + r.version));
  check('弹层指回版本单一事实源', /assets\/version\.js/.test(await page.$eval('#ver-pop', e => e.textContent)));
  await page.keyboard.press('Escape');
  eq('Escape 关闭弹层', await page.$eval('#ver-pop', e => e.hasAttribute('hidden')), true);
  await page.click('#ver-chip');
  await page.click('#crumb');
  eq('点击别处关闭弹层', await page.$eval('#ver-pop', e => e.hasAttribute('hidden')), true);

  /* ══════════════ 7. 详情页任务切换 ══════════════ */
  section('详情页交互（任务切换 / 前后导航）');
  await goAgent('codex');
  await goTask('cdx-webhook-retry');
  eq('切换器覆盖全部任务', await page.$$eval('#task-switch option', els => els.length), 16);
  eq('切换器按 Agent 分组', await page.$$eval('#task-switch optgroup', els => els.map(e => e.label)), [
    'qoder-cn（4）', 'codex（4）', 'workbuddy（4）', 'trae-cn（4）',
  ]);
  eq('切换器当前任务选中', await page.$eval('#task-switch', e => e.value), 'cdx-webhook-retry');
  const curOption = await page.$eval('#task-switch option[selected]', e => e.textContent);
  check('切换器选项带归属与时间', curOption.includes(byId['cdx-webhook-retry'].repo) && /\d{2}-\d{2} \d{2}:\d{2}/.test(curOption), curOption);
  eq('当前任务前后导航都可用', await page.evaluate(() => [!document.querySelector('#task-prev').disabled, !document.querySelector('#task-next').disabled]), [true, true]);

  await page.click('#task-next');
  await page.waitForFunction(() => location.hash === '#/task/cdx-perf-regression' && document.querySelector('.dh-title')?.textContent === 'P99 性能回归排查');
  eq('下一项进入同 Agent 较旧任务', await page.$eval('#task-switch', e => e.value), 'cdx-perf-regression');
  eq('最旧任务禁用下一项', await page.$eval('#task-next', e => e.disabled), true);
  await page.click('#task-prev');
  await page.waitForFunction(() => location.hash === '#/task/cdx-webhook-retry' && document.querySelector('.dh-title')?.textContent === 'Webhook 重试与幂等');

  await page.selectOption('#task-switch', 'qcn-api-pagination');
  await page.waitForFunction(() => location.hash === '#/task/qcn-api-pagination' && document.querySelector('.dh-title')?.textContent === 'API 分页统一改造');
  eq('切换器可跨 Agent 跳转', await page.$eval('#task-switch', e => e.value), 'qcn-api-pagination');
  eq('跨 Agent 跳转后侧栏高亮', await page.$eval('#agent-nav .agent-nav-item.active .an-name', e => e.textContent), 'qoder-cn');
  await page.click('#back-btn');
  await page.waitForFunction(() => location.hash === '#/agent/qoder-cn' && document.querySelector('.page-head h1')?.textContent === 'qoder-cn');
  check('切换任务后返回按钮回到所属 Agent', true);

  await goAgent('qoder-cn');
  await goTask('qcn-flaky-test');
  eq('最新任务禁用上一项', await page.$eval('#task-prev', e => e.disabled), true);

  /* ══════════════ 8. 线索流执行日志 ══════════════ */
  section('线索流执行日志（动态放出 / 暂停 / 重播 / 筛选）');
  const flaky = byId['qcn-flaky-test'];
  await goAgent('qoder-cn');
  await page.evaluate(() => { window.__RUNNER_LIVE_SPEED = 1000; });
  await goTask('qcn-flaky-test');
  await page.waitForFunction(() => document.querySelector('#live-panel')?.dataset.mode === 'live');
  const live0 = await liveState(page);
  eq('运行中任务日志总数', live0.total, flaky.events.length);
  check('运行中任务只放出尾部一部分', live0.visible < live0.total && live0.visible >= live0.total - 12, JSON.stringify(live0));
  eq('运行中任务默认跟随', live0.follow, 'true');
  check('运行中日志有 LIVE 状态', /LIVE/.test(await page.$eval('#live-mode', e => e.textContent)));
  check('未放出的条数有提示', /还有 \d+ 条未放出/.test(await page.$eval('#live-new', e => e.textContent)));
  await sleep(1400);
  const live1 = await liveState(page);
  check('日志会自动逐条放出', live1.visible > live0.visible, `${live0.visible} → ${live1.visible}`);

  await page.click('#live-pause');
  await page.waitForFunction(() => document.querySelector('#live-panel').dataset.mode === 'paused');
  const paused0 = await liveState(page);
  await sleep(1200);
  const paused1 = await liveState(page);
  eq('暂停后日志不再增长', paused1.visible, paused0.visible);
  eq('暂停按钮变为继续', await page.$eval('#live-pause', e => e.textContent), '继续');
  await page.click('#live-pause');
  await page.waitForFunction(() => document.querySelector('#live-panel').dataset.mode === 'live');
  await sleep(1200);
  const resumed = await liveState(page);
  check('继续后恢复放出', resumed.visible > paused1.visible, `${paused1.visible} → ${resumed.visible}`);

  await page.click('#live-replay');
  const replay0 = await liveState(page);
  eq('重播从 0 开始', replay0.visible, 0);
  eq('重播模式标记', replay0.mode, 'replay');
  await page.selectOption('#live-speed', '0');
  await page.waitForFunction(() => {
    const el = document.querySelector('#live-panel');
    return el.dataset.visible === el.dataset.total && el.dataset.mode === 'live-wait';
  });
  const fullLive = await liveState(page);
  eq('即时模式一次放完', fullLive.visible, flaky.events.length);
  eq('已跟上最新日志', await page.$eval('#live-mode', e => e.textContent.includes('已跟上最新日志')), true);
  check('日志容器可滚动', await page.$eval('#livelog', el => el.scrollHeight > el.clientHeight));
  await page.waitForTimeout(120);
  check('跟随开启时自动滚到底部', await page.$eval('#livelog', el => el.scrollHeight - el.scrollTop - el.clientHeight < 28));
  await page.$eval('#livelog', el => { el.scrollTop = 0; el.dispatchEvent(new Event('scroll')); });
  await page.waitForFunction(() => document.querySelector('#live-follow').textContent.includes('关'));
  eq('用户上滚自动关闭跟随', await page.$eval('#live-panel', el => el.dataset.follow), 'false');
  await page.click('#live-follow');
  await page.waitForFunction(() => document.querySelector('#live-follow').textContent.includes('开'));
  check('手动开启跟随后回到底部', await page.$eval('#livelog', el => el.scrollTop > 0));

  const forkCount = flaky.events.filter(e => e.type === 'fork_decision').length;
  await page.selectOption('#live-type', 'fork_decision');
  eq('日志按类型筛选', await page.$$eval('.liveline', els => els.length), forkCount);
  eq('日志筛选后计数同步', /当前筛选 \d+ 条/.test(await page.$eval('#live-count', e => e.textContent)), true);
  eq('日志类型筛选行全部匹配', await page.$$eval('.liveline', els => els.every(e => e.dataset.type === 'fork_decision')), true);
  await page.selectOption('#live-type', '');
  const routerId = 'router';
  const routerCount = flaky.events.filter(e => e.src === routerId).length;
  await page.selectOption('#live-agent', routerId);
  eq('日志按 Agent 筛选', await page.$$eval('.liveline', els => els.length), routerCount);
  await page.selectOption('#live-agent', '');
  const flakyHits = flaky.events.filter(e => JSON.stringify(e).toLowerCase().includes('flaky')).length;
  await page.fill('#live-q', 'flaky');
  eq('日志全文搜索', await page.$$eval('.liveline', els => els.length), flakyHits);
  await page.fill('#live-q', 'zzz-no-hit');
  eq('日志搜索无命中空态', await page.$eval('#livelog .empty', e => e.textContent.trim()), '没有匹配的线索');
  await page.fill('#live-q', '');

  await goTask('qcn-config-layering');
  await page.waitForFunction(() => document.querySelector('#live-panel')?.dataset.mode === 'full');
  const doneLive = await liveState(page);
  eq('已完成任务默认全量', doneLive.visible, byId['qcn-config-layering'].events.length);
  eq('已完成任务日志条数', doneLive.total, byId['qcn-config-layering'].events.length);
  eq('已完成任务暂停按钮禁用', await page.$eval('#live-pause', e => e.disabled), true);
  await page.selectOption('#live-speed', '0');
  await page.click('#live-replay');
  await page.waitForFunction(() => document.querySelector('#live-panel').dataset.mode === 'done');
  const replayDone = await liveState(page);
  eq('已完成任务重播可回到全量', replayDone.visible, doneLive.total);
  eq('重播完成文案', /回放完成/.test(await page.$eval('#live-mode', e => e.textContent)), true);
  eq('重播后日志行数', await page.$$eval('.liveline', els => els.length), doneLive.total);

  /* ══════════════ 9. 协作面板离线 ══════════════ */
  section('协作面板离线（本地子任务 / 持久化）');
  await goTask('qcn-db-migration');
  await page.waitForSelector('#collab');
  await page.waitForFunction(() => document.querySelector('#bridge-chip')?.textContent.includes('桥接离线'));
  const dbTask = byId['qcn-db-migration'];
  eq('离线时关联状态为未关联', await page.$eval('#link-state', e => e.textContent), '未关联');
  eq('离线时一键关联禁用', await page.$eval('[data-act="link-create"]', e => e.disabled), true);
  eq('离线时派发按钮禁用', await page.$eval('[data-act="subtask-dispatch"]', e => e.disabled), true);
  check('离线时说明原因', /file:\/\/ 模式没有本地桥接/.test(await page.$eval('#link-body', e => e.textContent)));
  check('未关联时记忆未生成', /关联 Multica 后/.test(await page.$eval('#memory-card', e => e.textContent)));

  await page.fill('#st-title', '本地补测：迁移失败回滚');
  await page.fill('#st-owner', 'codex');
  await page.selectOption('#st-status', 'in_progress');
  await page.fill('#st-stage', '2');
  await page.fill('#st-desc', '本地记录，桥接恢复后派发');
  await page.click('[data-act="subtask-local"]');
  await waitToast(page, /已记录到本地/);
  await page.waitForSelector('.subtask-row');
  eq('本地子任务计数', await page.$eval('#subtask-count', e => e.textContent), '1 个');
  eq('本地子任务标为仅本地', await page.$eval('.subtask-row .st-origin', e => e.textContent.trim()), '仅本地');
  eq('本地子任务负责人', await page.$eval('.subtask-row .st-meta', e => e.textContent.includes('负责人 codex')), true);
  eq('本地子任务初始状态', await page.$eval('.subtask-row select', e => e.value), 'in_progress');
  eq('本地子任务描述保留', await page.$eval('.subtask-row .st-desc', e => e.textContent.trim()), '本地记录，桥接恢复后派发');
  const offBoard1 = await subBoard(page);
  eq('离线子任务进入看板进行中列', offBoard1.map(c => c.lane), ['running']);
  check('看板脚注显示子任务进度', (await boardNote(page)).includes('子任务 0/1 完成'), await boardNote(page));
  check('详情元信息带子任务计数', /☑ 1 个子任务/.test(await page.$eval('.dh-meta', e => e.textContent)));
  check('合成事件标为合成', await page.$eval('.ll-synth', e => e.textContent.trim()) === '合成');
  eq('合成事件进入线索日志', await page.$$eval('.liveline.synth', els => els.length), 1);
  eq('线索日志总数增加 1', (await liveState(page)).total, dbTask.events.length + 1);
  check('线索流类型选项含本地子任务', (await page.$$eval('#live-type option', els => els.map(o => o.value))).includes('subtask_created'));
  check('线索日志描述含子任务标题', (await page.$eval('.liveline.synth', e => e.textContent)).includes('本地补测：迁移失败回滚'));
  const saved1 = await page.evaluate(() => JSON.parse(localStorage.getItem('agentRunner.state.v2')));
  check('本地状态结构完整', saved1.version === 2 && saved1.subtasks['qcn-db-migration'].length === 1 && saved1.events['qcn-db-migration'].length === 1 && saved1.versions['qcn-db-migration'] > 0);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: path.join(SHOT_DIR, 'detail-collab-offline.png'), fullPage: true });

  await page.click('#back-btn');
  await page.waitForFunction(() => location.hash === '#/agent/qoder-cn' && document.querySelector('.task-list'));
  check('列表行显示子任务标记', /☑ 1/.test(await page.$eval('.task-row[data-task="qcn-db-migration"] .tr-meta', e => e.textContent)));
  await page.click('.task-row[data-task="qcn-db-migration"]');
  await page.waitForFunction(() => location.hash === '#/task/qcn-db-migration' && document.querySelector('.dh-title'));

  await page.selectOption('.subtask-row select', 'done');
  await page.waitForFunction(() => document.querySelector('#live-panel').dataset.total === String(32 + 2));
  eq('子任务状态改动生成事件', await page.$$eval('.liveline.synth', els => els.length), 2);
  check('状态变更文案', (await page.$$eval('.liveline.synth', els => els[els.length - 1].textContent)).includes('in_progress → done'));
  const offBoard2 = await subBoard(page);
  eq('子任务 done 后进入看板已完成列', offBoard2.map(c => c.lane), ['done']);
  check('看板脚注更新为 1/1', (await boardNote(page)).includes('子任务 1/1 完成'), await boardNote(page));

  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => location.hash === '#/task/qcn-db-migration' && document.querySelector('.dh-title'));
  await page.waitForSelector('.subtask-row');
  eq('刷新后本地子任务仍在', await page.$$eval('.subtask-row', els => els.length), 1);
  eq('刷新后状态仍是 done', await page.$eval('.subtask-row select', e => e.value), 'done');
  eq('刷新后合成事件仍在', await page.$$eval('.liveline.synth', els => els.length), 2);
  const offBoard3 = await subBoard(page);
  eq('刷新后看板子任务仍是 done', offBoard3.map(c => c.lane), ['done']);

  await page.click('[data-remove-id]');
  await waitToast(page, /已移除本地子任务/);
  eq('移除后子任务为空', await page.$$eval('.subtask-row', els => els.length), 0);
  eq('移除后计数归零', await page.$eval('#subtask-count', e => e.textContent), '0 个');
  const offBoard4 = await subBoard(page);
  eq('移除后看板子任务卡消失', offBoard4.length, 0);
  check('移除后看板脚注回到无子任务', (await boardNote(page)).includes('无子任务'), await boardNote(page));
  await page.waitForFunction(() => document.querySelector('#live-panel').dataset.total === String(32 + 3));
  const saved2 = await page.evaluate(() => JSON.parse(localStorage.getItem('agentRunner.state.v2')));
  eq('移除后本地状态保留审计事件', saved2.events['qcn-db-migration'].map(e => e.type), ['subtask_created', 'subtask_status', 'subtask_removed']);
  await page.evaluate(() => localStorage.removeItem('agentRunner.state.v2'));
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('.gantt');

  /* ══════════════ 10. 本地日志导入 ══════════════ */
  section('本地 .jsonl 日志导入');
  const navBefore = await page.$$eval('#agent-nav .agent-nav-item', els => els.length);
  await page.setInputFiles('#file', path.join(PROJECT, 'tests/fixtures/broken-session.jsonl'));
  await page.waitForFunction(() => document.querySelector('#toast').style.display !== 'none');
  eq('坏日志提示', await toastText(page), '没有载入任何日志');
  eq('坏日志不新增 Agent', await page.$$eval('#agent-nav .agent-nav-item', els => els.length), navBefore);

  await page.setInputFiles('#file', path.join(PROJECT, 'tests/fixtures/extra-session.jsonl'));
  await page.waitForFunction(() => /^#\/task\/local-/.test(location.hash) && document.querySelector('.detail-head'));
  await page.waitForSelector('.gantt');
  eq('导入后新增本地 Agent', await page.$$eval('#agent-nav .agent-nav-item', els => els.length), navBefore + 1);
  eq('导入的 Agent 名称', await page.$eval('#agent-nav .agent-nav-item:last-child .an-name', e => e.textContent), 'local');
  eq('导入任务标题取文件名', await page.$eval('.dh-title', e => e.textContent), 'extra-session');
  eq('导入任务状态', await page.$eval('.detail-head .badge', e => e.textContent.trim()), '✓ 已完成');
  eq('导入任务 Agent 数', await page.$$eval('.agent-card', els => els.length), 2);
  eq('导入任务产物数', await page.$$eval('.results-table tbody tr', els => els.length), 1);
  eq('导入任务验证徽标', await page.$eval('.results-table tbody tr td:nth-child(6) .badge', e => e.textContent.trim()), '✓ 已验证通过');
  eq('导入任务线索日志全量', (await liveState(page)).total, 8);
  eq('坏行被跳过（9 行输入 / 8 条事件）', await page.$$eval('.liveline', els => els.length), 8);
  eq('导入后 toast 成功', await toastText(page), '已载入 1 份日志');

  await page.click('#agent-nav .agent-nav-item[data-agent="local"]');
  await page.waitForFunction(() => document.querySelector('.page-head h1')?.textContent === 'local');
  eq('本地 Agent 列表有 1 个任务', (await rows(page)).length, 1);

  await page.setInputFiles('#file', path.join(PROJECT, 'tests/fixtures/pending-no-next.jsonl'));
  await page.waitForFunction(() => /^#\/task\/local-/.test(location.hash) && document.querySelector('.dh-title')?.textContent === 'pending-no-next');
  await page.waitForSelector('.gantt');
  eq('无 next 的收尾任务仍是已完成', await page.$eval('.detail-head .badge', e => e.textContent.trim()), '✓ 已完成');
  eq('未知 verdict 归入待验证徽标', await page.$eval('.results-table tbody tr td:nth-child(6) .badge', e => e.textContent.trim()), '⏳ 待验证');
  const pendingChips = await page.$$eval('.chip', els => els.map(e => e.querySelector('.chip-v').textContent.trim()));
  eq('未知 verdict 计入待验证 chip', pendingChips[6], '0 通过 · 0 未过 · 1 待验证');
  check('无 next 时按实际结果生成收工遗留', /收工遗留：1 个待验证；需要复核后再交付/.test(await page.$eval('.page', e => e.textContent)), await page.$eval('.page', e => e.textContent.replace(/\s+/g, ' ').slice(-180)));
  await page.click('#agent-nav .agent-nav-item[data-agent="local"]');
  await page.waitForFunction(() => document.querySelector('.page-head h1')?.textContent === 'local');
  eq('本地 Agent 累计 2 个任务', (await rows(page)).length, 2);

  await page.click('#agent-nav .agent-nav-item[data-agent="qoder-cn"]');
  await page.waitForFunction(() => document.querySelector('.page-head h1')?.textContent === 'qoder-cn');
  eq('导入后仍可回到内置 Agent', (await rows(page)).length, 4);

  /* ══════════════ 10.5 全局任务看板 · 泳道收纳（v5） ══════════════ */
  section('全局任务看板 · 泳道收纳（已完成任务 / 每列条数 / 展开收起）');
  const EXTRA_FIXTURE = path.join(PROJECT, 'tests/fixtures/extra-session.jsonl');
  await page.setInputFiles('#file', Array.from({ length: 8 }, () => EXTRA_FIXTURE));
  await page.waitForFunction(n => {
    const el = document.querySelector('#agent-nav .agent-nav-item[data-agent="local"] .an-badge');
    return el && Number(el.textContent.trim()) === n;
  }, 10);
  const totalTasks = Number(await page.$eval('#overview-nav .an-badge', e => e.textContent.trim()));
  eq('导入后总任务数', totalTasks, 26);

  await page.click('#overview-nav [data-board]');
  await page.waitForFunction(() => location.hash === '#/board' && document.querySelector('.board-page .kb'));
  const boardRead = () => page.evaluate(() => {
    const kb = document.querySelector('.board-page .kb');
    const col = id => document.querySelector(`.board-page .kb-col[data-col="${id}"]`);
    return {
      total: Number(kb.dataset.total),
      limit: kb.dataset.limit,
      cards: document.querySelectorAll('.board-page .kb-card').length,
      fixed: kb.classList.contains('kb-fixed'),
      lanes: Object.fromEntries([...document.querySelectorAll('.board-page .kb-col')].map(c => [c.dataset.col, { count: Number(c.querySelector('.kb-col-count').textContent), shown: c.querySelectorAll('.kb-card').length }])),
      more: [...document.querySelectorAll('[data-lane-more]')].map(e => e.textContent.trim()),
      less: [...document.querySelectorAll('[data-lane-less]')].map(e => e.textContent.trim()),
      note: (document.querySelector('#board-note')?.textContent || '').replace(/\s+/g, ' ').trim(),
      titles: [...document.querySelectorAll('.board-page .kb-col-name')].map(e => e.textContent.trim()),
    };
  });
  let b = await boardRead();
  eq('看板六列标题', b.titles, ['待办', '进行中', '待确认', '已完成', '已停止 / 取消', '失败']);
  eq('看板覆盖全部任务（含已完成）', b.total, totalTasks);
  eq('默认每列上限 25 条', b.limit, '25');
  eq('done 列计入已完成任务', b.lanes.done.count, 14);
  eq('未超上限时全部可见', b.lanes.done.shown, 14);
  eq('看板沿用固定高度列', b.fixed, true);
  eq('未超上限时无展开按钮', b.more, []);
  check('脚注说明已完成任务同样进泳道', /已完成的任务同样进泳道/.test(b.note), b.note);

  await page.selectOption('#board-limit', '10');
  await page.waitForFunction(() => document.querySelector('.board-page .kb').dataset.limit === '10');
  b = await boardRead();
  eq('切到 10 条后 done 列只显示 10 张', b.lanes.done.shown, 10);
  eq('超出部分折叠为展开按钮', b.more, ['展开剩余 4 条「已完成」']);
  check('脚注同步当前每列条数', b.note.includes('当前每列显示最近 10 条'), b.note);

  await page.click('.board-page .kb-col[data-col="done"] [data-lane-more]');
  await page.waitForFunction(n => document.querySelectorAll('.board-page .kb-col[data-col="done"] .kb-card').length === n, 14);
  b = await boardRead();
  eq('展开后 done 列 14 张全见', b.lanes.done.shown, 14);
  eq('展开后出现收起按钮', b.less, ['收起，只留最近 10 条']);
  eq('展开后展开按钮消失', b.more, []);

  await page.click('.board-page .kb-col[data-col="done"] [data-lane-less]');
  await page.waitForFunction(() => document.querySelectorAll('.board-page .kb-col[data-col="done"] .kb-card').length === 10);
  eq('收起后回到 10 张', (await boardRead()).lanes.done.shown, 10);

  await page.selectOption('#board-limit', 'all');
  await page.waitForFunction(n => document.querySelectorAll('.board-page .kb-card').length === n, totalTasks);
  b = await boardRead();
  eq('切到全部后 26 张全见', b.cards, totalTasks);
  eq('全部条数时无展开按钮', b.more, []);
  check('全部条数脚注', b.note.includes('全部'), b.note);
  await page.screenshot({ path: path.join(SHOT_DIR, 'board-lanes.png'), fullPage: true });

  /* ══════════════ 11. Multica 桥接直接 API（stub） ══════════════ */
  section('Multica 桥接直接 API（stub CLI）');
  let bridgeReady = false;
  try {
    const port = await freePort();
    BRIDGE_URL = `http://127.0.0.1:${port}`;
    STUB_STATE = path.join(os.tmpdir(), `agent-runner-stub-${process.pid}.json`);
    try { fs.unlinkSync(STUB_STATE); } catch {}
    const bridgeLog = [];
    bridgeProc = spawn(process.execPath, [path.join(PROJECT, 'scripts/serve.mjs'), '--port', String(port)], {
      cwd: PROJECT,
      env: { ...process.env, OBS_DATA_DIR: path.join(PROJECT, 'data'), MULTICA_BIN: STUB_BIN, STUB_MULTICA_STATE: STUB_STATE },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    bridgeProc.stdout.on('data', b => bridgeLog.push(b.toString()));
    bridgeProc.stderr.on('data', b => bridgeLog.push(b.toString()));
    const st = await waitBridge(BRIDGE_URL);
    bridgeReady = true;
    check('桥接启动并返回 status', st.ok === true && st.bridge === 'online', JSON.stringify(st));
    check('桥接使用 stub CLI', String(st.multica.cli).includes('stub'), st.multica.cli);
  } catch (e) {
    check('桥接启动', false, e.message);
  }

  if (bridgeReady) {
    const status = await api('/status');
    eq('直接 API：status 200', status.status, 200);
    eq('直接 API：bridge online', status.body.bridge, 'online');

    const agents = await api('/agents');
    eq('直接 API：agents 200', agents.status, 200);
    eq('直接 API：过滤归档 Agent 并排序', agents.body.agents.map(a => a.name), ['code-reviewer', 'daily-task-executor']);
    eq('直接 API：Agent 字符段', Object.keys(agents.body.agents[0]).sort(), ['id', 'model', 'name', 'runtimeId', 'status']);

    const issues = await api('/issues?limit=20');
    eq('直接 API：issues 200', issues.status, 200);
    check('直接 API：只返回父 issue', issues.body.issues.length >= 3 && issues.body.issues.every(x => !x.parentIssueId));
    check('直接 API：issue 带 appUrl 链接', issues.body.issues.every(x => /\/work-space\/issues\/WORK-\d+$/.test(x.url)));

    const bundle = await api('/issue/iss-101');
    eq('直接 API：issue 详情 200', bundle.status, 200);
    eq('直接 API：children 展平并排序', bundle.body.children.map(x => x.identifier), ['WORK-111', 'WORK-112']);
    eq('直接 API：children 带阶段', bundle.body.children.map(x => x.stage), [1, 2]);
    eq('直接 API：无警告', bundle.body.warnings, []);

    const directTask = { id: 'direct-api-task', title: '直连 API 验收任务', agent: 'qoder-cn', repo: 'direct/repo' };
    const created = await api('/link', {
      method: 'POST', body: JSON.stringify({ task: directTask, mode: 'create' }),
    });
    eq('直接 API：创建父 issue 200', created.status, 200);
    check('直接 API：父 issue 编号', /^WORK-\d+$/.test(created.body.issue.identifier), created.body.issue.identifier);
    check('直接 API：父 issue 标题带前缀', created.body.issue.title.startsWith('[work-space]-[implement]-'), created.body.issue.title);
    eq('直接 API：父 issue 默认 todo', created.body.issue.status, 'todo');
    eq('直接 API：返回记忆元数据键', created.body.memory.metadataKeys, ['sync_source', 'sync_date', 'task_id', 'task_dir', 'runner_link_source']);
    eq('直接 API：创建无警告', created.body.warnings, []);
    const directParentId = created.body.issue.id;
    let stub = readStub();
    let directIssue = stub.issues.find(x => x.id === directParentId);
    eq('直接 API：metadata task_id', directIssue.metadata.task_id, 'direct-api-task');
    eq('直接 API：metadata 来源 created', directIssue.metadata.runner_link_source, 'created');
    eq('直接 API：metadata sync_source', directIssue.metadata.sync_source, 'agent-runner');
    eq('直接 API：父 issue 标签', directIssue.labels.map(l => l.name), ['work-space', 'todo', 'implement']);
    check('直接 API：写入关联记忆评论', directIssue.comments.some(c => c.includes('## Agent Runner 关联记忆') && c.includes('task_id: direct-api-task')));

    const existing = await api('/link', {
      method: 'POST', body: JSON.stringify({ task: directTask, mode: 'existing', issueId: 'iss-103' }),
    });
    eq('直接 API：关联已有 issue 200', existing.status, 200);
    eq('直接 API：已有 issue 编号', existing.body.issue.identifier, 'WORK-103');
    stub = readStub();
    const iss103 = stub.issues.find(x => x.id === 'iss-103');
    eq('直接 API：existing 元数据来源', iss103.metadata.runner_link_source, 'existing');
    eq('直接 API：existing 元数据 task', iss103.metadata.runner_task_id, 'direct-api-task');
    check('直接 API：existing 也写记忆评论', iss103.comments.some(c => c.includes('## Agent Runner 关联记忆') && c.includes('task_id: direct-api-task')));

    const subtask = await api('/subtask', {
      method: 'POST', body: JSON.stringify({
        task: directTask, parentIssueId: directParentId, title: 'API 派发子任务',
        description: '通过桥接直接派发', assignee: 'code-reviewer', stage: 2,
      }),
    });
    eq('直接 API：派发子任务 200', subtask.status, 200);
    eq('直接 API：子任务父 issue', subtask.body.issue.parentIssueId, directParentId);
    eq('直接 API：子任务负责人', subtask.body.issue.assigneeName, 'code-reviewer');
    eq('直接 API：子任务初始状态', subtask.body.issue.status, 'todo');
    check('直接 API：子任务标题带前缀', subtask.body.issue.title.startsWith('[work-space]-[implement]-API 派发子任务'), subtask.body.issue.title);
    stub = readStub();
    const childIssue = stub.issues.find(x => x.id === subtask.body.issue.id);
    eq('直接 API：子任务 metadata 父任务', childIssue.metadata.runner_parent_task_id, 'direct-api-task');
    eq('直接 API：子任务 metadata 协议来源', childIssue.metadata.runner_origin, 'subtask');
    eq('直接 API：子任务阶段', childIssue.stage, 2);
    eq('直接 API：子任务标签', childIssue.labels.map(l => l.name), ['work-space', 'todo', 'implement']);
    const bundle2 = await api('/issue/' + directParentId);
    check('直接 API：父 issue 能读到新子任务', bundle2.body.children.some(x => x.id === childIssue.id));

    const patchedChild = await api('/issue/' + childIssue.id, { method: 'PATCH', body: JSON.stringify({ status: 'in_progress' }) });
    eq('直接 API：PATCH 子任务状态', [patchedChild.status, patchedChild.body.issue.status], [200, 'in_progress']);
    const patchedParent = await api('/issue/' + directParentId, { method: 'PATCH', body: JSON.stringify({ status: 'in_review' }) });
    eq('直接 API：PATCH 父 issue 状态', [patchedParent.status, patchedParent.body.issue.status], [200, 'in_review']);

    const beforeComments = readStub().issues.find(x => x.id === directParentId).comments.length;
    const memory = await api('/memory', {
      method: 'POST', body: JSON.stringify({
        task: directTask, issueId: directParentId,
        subtasks: [{ title: 'API 派发子任务', status: 'in_progress', identifier: childIssue.identifier }],
      }),
    });
    eq('直接 API：写记忆 200', memory.status, 200);
    eq('直接 API：记忆子任务数', memory.body.memory.subtasks, 1);
    stub = readStub();
    directIssue = stub.issues.find(x => x.id === directParentId);
    eq('直接 API：记忆追加一条评论', directIssue.comments.length, beforeComments + 1);
    const lastComment = directIssue.comments[directIssue.comments.length - 1];
    check('直接 API：记忆评论含子任务进度', lastComment.includes('子任务进度：') && lastComment.includes('in_progress') && lastComment.includes(childIssue.identifier), lastComment.slice(0, 220));
    check('直接 API：记忆更新时间写入 metadata', !!directIssue.metadata.runner_memory_updated_at);

    eq('直接 API：缺少 task 返回 400', (await api('/link', { method: 'POST', body: '{}' })).status, 400);
    eq('直接 API：非法 JSON 返回 400', (await api('/link', { method: 'POST', body: 'not-json' })).status, 400);
    eq('直接 API：缺少 parent 返回 400', (await api('/subtask', { method: 'POST', body: JSON.stringify({ task: directTask, title: 'x' }) })).status, 400);
    eq('直接 API：未知端点 404', (await api('/nope')).status, 404);
    const notFound = await api('/issue/iss-does-not-exist');
    eq('直接 API：未知 issue 502', notFound.status, 502);
    check('直接 API：未知 issue 带错误信息', /issue not found/.test(notFound.body.error || ''), JSON.stringify(notFound.body));

    /* ══════════════ 12. 协作面板在线 ══════════════ */
    section('协作面板在线（一键关联 / 派发 / 同步 / 记忆）');
    httpContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    page2 = await httpContext.newPage();
    page2.on('pageerror', e => httpErrors.push('pageerror: ' + e.message));
    page2.on('console', m => { if (m.type() === 'error') httpErrors.push('console: ' + m.text()); });

    await page2.goto(BRIDGE_URL + '/index.html');
    await page2.waitForSelector('.agent-nav-item');
    await page2.waitForFunction(() => document.querySelector('#bridge-crumb')?.textContent.includes('桥接在线'));
    eq('HTTP 页面默认路由', await page2.evaluate(() => location.hash), '#/agent/qoder-cn');
    check('侧栏桥接在线态', await page2.$eval('#bridge-status', e => ['online', 'warn'].some(c => e.className.includes(c))));
    check('侧栏桥接文案', /Multica (在线|未响应)/.test(await page2.$eval('#bridge-status .bs-text', e => e.textContent)));
    check('顶栏桥接入口在线', /⇄ 桥接在线/.test(await page2.$eval('#bridge-crumb', e => e.textContent)));

    // 一键关联：新建父 issue
    await goTaskOn(page2, 'qcn-api-pagination');
    await page2.waitForSelector('#collab');
    await page2.waitForFunction(() => document.querySelector('#bridge-chip')?.classList.contains('online'));
    eq('在线时关联状态为未关联', await page2.$eval('#link-state', e => e.textContent), '未关联');
    eq('在线时派发按钮仍禁用（未关联）', await page2.$eval('[data-act="subtask-dispatch"]', e => e.disabled), true);
    const beforeParents = readStub().issues.filter(x => !x.parent_issue_id).length;
    await page2.click('[data-act="link-create"]');
    const linkToast = await waitToast(page2, /已关联 WORK-\d+/);
    const linkedIdentifier = linkToast.match(/WORK-\d+/)[0];
    await page2.waitForSelector('.link-issue .issue-id');
    eq('一键关联状态更新', await page2.$eval('#link-state', e => e.textContent), linkedIdentifier);
    eq('一键关联 toast', linkToast, `已关联 ${linkedIdentifier}`);
    eq('父 issue 新链接可打开', /localhost:3000\/work-space\/issues\/WORK-\d+/.test(await page2.$eval('.link-issue .issue-id', e => e.href)), true);
    eq('新建父 issue 数量 +1', readStub().issues.filter(x => !x.parent_issue_id).length, beforeParents + 1);
    const savedQcn = await page2.evaluate(() => JSON.parse(localStorage.getItem('agentRunner.state.v2')));
    const qcnLink = savedQcn.links['qcn-api-pagination'];
    eq('本地关联记录模式', qcnLink.mode, 'created');
    eq('本地关联记录编号', qcnLink.issue.identifier, linkedIdentifier);
    const qcnStubIssue = readStub().issues.find(x => x.id === qcnLink.issueId);
    eq('UI 关联写入 task_id', qcnStubIssue.metadata.task_id, 'qcn-api-pagination');
    eq('UI 关联写入 runner_agent', qcnStubIssue.metadata.runner_agent, 'qoder-cn');
    eq('UI 关联写入 task_dir', qcnStubIssue.metadata.task_dir, '01-raw/05-tasks/2026-10-25-agent-router-observatory');
    check('UI 关联写入记忆评论', qcnStubIssue.comments.some(c => c.includes('qcn-api-pagination') && c.includes(linkedIdentifier)));
    check('记忆块包含 task_id 与 issue', /task_id: qcn-api-pagination/.test(await page2.$eval('#memory-text', e => e.textContent)) && (await page2.$eval('#memory-text', e => e.textContent)).includes(linkedIdentifier));
    eq('派发按钮解锁', await page2.$eval('[data-act="subtask-dispatch"]', e => e.disabled), false);
    check('详情元信息显示关联', /⇄ WORK-\d+/.test(await page2.$eval('.dh-meta', e => e.textContent)));
    eq('关联事件进入日志', await page2.$$eval('.liveline.synth', els => els.length), 1);
    eq('关联事件类型', await page2.$eval('.liveline.synth .ll-type', e => e.textContent), 'Multica 关联');
    eq('线索日志总数 +1', (await liveState(page2)).total, byId['qcn-api-pagination'].events.length + 1);
    check('线索流类型选项含关联事件', (await page2.$$eval('#live-type option', els => els.map(o => o.value))).includes('multica_linked'));
    await page2.evaluate(() => window.scrollTo(0, 0));
    await page2.screenshot({ path: path.join(SHOT_DIR, 'detail-collab-online.png'), fullPage: true });

    // 关联已有 issue
    await goTaskOn(page2, 'qcn-db-migration');
    await page2.waitForFunction(() => document.querySelector('#bridge-chip')?.classList.contains('online'));
    await page2.click('[data-act="toggle-existing"]');
    await page2.waitForFunction(() => document.querySelectorAll('.issue-result').length >= 3);
    await page2.fill('#issue-q', '网关');
    await page2.waitForFunction(() =>
      document.querySelectorAll('.issue-result').length === 1 &&
      document.querySelector('.issue-result')?.textContent.includes('WORK-102'));
    await page2.click('.issue-result');
    eq('选中已有 issue 高亮', await page2.$$eval('.issue-result.selected', els => els.length), 1);
    eq('选中后确认按钮解锁', await page2.$eval('[data-act="link-existing"]', e => e.disabled), false);
    await page2.click('[data-act="link-existing"]');
    await waitToast(page2, /已关联 WORK-102/);
    eq('关联已有 issue 状态更新', await page2.$eval('#link-state', e => e.textContent), 'WORK-102');
    eq('关联已有 issue 标题展示', await page2.$eval('.link-issue .issue-title', e => e.textContent), '网关重试');
    const savedDb = await page2.evaluate(() => JSON.parse(localStorage.getItem('agentRunner.state.v2')));
    eq('已有 issue 本地模式', savedDb.links['qcn-db-migration'].mode, 'existing');
    const iss102 = readStub().issues.find(x => x.id === 'iss-102');
    eq('已有 issue 写入来源', iss102.metadata.runner_link_source, 'existing');
    eq('已有 issue 写入 task_id', iss102.metadata.runner_task_id, 'qcn-db-migration');
    check('已有 issue 写入记忆评论', iss102.comments.some(c => c.includes('qcn-db-migration')));

    // 派发子任务 + 状态回写
    await goTaskOn(page2, 'trae-style-migration');
    await page2.waitForFunction(() => document.querySelector('#bridge-chip')?.classList.contains('online'));
    await page2.click('[data-act="link-create"]');
    await waitToast(page2, /已关联 WORK-\d+/);
    await page2.waitForSelector('.link-issue .issue-id');
    const traeIdent = await page2.$eval('#link-state', e => e.textContent);
    const savedTrae1 = await page2.evaluate(() => JSON.parse(localStorage.getItem('agentRunner.state.v2')));
    const traeLink = savedTrae1.links['trae-style-migration'];
    eq('trae 任务完成关联', traeLink.issue.identifier, traeIdent);
    eq('派发前子任务为空', await page2.$$eval('.subtask-row', els => els.length), 0);

    await page2.fill('#st-title', '补齐深色对比度回归');
    await page2.fill('#st-owner', 'code-reviewer');
    await page2.fill('#st-stage', '2');
    await page2.fill('#st-desc', '覆盖 4.5:1 对比度与键盘焦点');
    await page2.selectOption('#st-status', 'todo');
    await page2.click('[data-act="subtask-dispatch"]');
    const dispatchToast = await waitToast(page2, /已派发 WORK-\d+/);
    const childIdent = dispatchToast.match(/WORK-\d+/)[0];
    await page2.waitForSelector('.subtask-row');
    eq('派发后子任务计数', await page2.$eval('#subtask-count', e => e.textContent), '1 个');
    eq('派发后标记 Multica 来源', await page2.$eval('.subtask-row .st-origin', e => e.textContent.trim()), 'Multica');
    check('派发后行内显示 child 编号', (await page2.$eval('.subtask-row .st-meta', e => e.textContent)).includes(childIdent));
    eq('派发后日志事件', await page2.$$eval('.liveline.synth', els => els.length), 2);
    check('线索日志含派发结果', (await page2.$eval('#livelog', e => e.textContent)).includes(childIdent));
    const savedTrae2 = await page2.evaluate(() => JSON.parse(localStorage.getItem('agentRunner.state.v2')));
    const traeSub = savedTrae2.subtasks['trae-style-migration'][0];
    eq('本地子任务绑定 child', traeSub.issue.identifier, childIdent);
    eq('本地子任务状态', traeSub.status, 'todo');
    const onlineBoard1 = await subBoard(page2);
    eq('Multica 派发后看板子任务在待办列', onlineBoard1.map(c => c.lane), ['todo']);
    check('派发后看板脚注 0/1', (await boardNote(page2)).includes('子任务 0/1 完成'), await boardNote(page2));
    let traeStub = readStub();
    let traeParent = traeStub.issues.find(x => x.id === traeLink.issueId);
    let traeChild = traeStub.issues.find(x => x.id === traeSub.issue.id);
    eq('child 父 issue 正确', traeChild.parent_issue_id, traeParent.id);
    eq('child 负责人写入', traeChild.assignee_id, 'agent-2');
    eq('child 阶段写入', traeChild.stage, 2);
    eq('child 元数据父任务', traeChild.metadata.runner_parent_task_id, 'trae-style-migration');
    eq('child 元数据父 issue', traeChild.metadata.runner_parent_issue, traeParent.identifier);
    check('记忆块包含派发子任务', (await page2.$eval('#memory-text', e => e.textContent)).includes('补齐深色对比度回归'));

    await page2.selectOption('.subtask-row select', 'in_progress');
    await waitToast(page2, /→ 进行中/);
    traeStub = readStub();
    traeChild = traeStub.issues.find(x => x.id === traeSub.issue.id);
    eq('子任务状态回写 Multica', traeChild.status, 'in_progress');
    eq('状态事件进入日志', await page2.$$eval('.liveline.synth', els => els.length), 3);
    const onlineBoard2 = await subBoard(page2);
    eq('子任务转进行中后看板列同步', onlineBoard2.map(c => c.lane), ['running']);

    // 外部新增 child + 改状态，页面“刷新子任务”应拉回
    traeStub = readStub();
    traeParent = traeStub.issues.find(x => x.id === traeLink.issueId);
    traeChild = traeStub.issues.find(x => x.id === traeSub.issue.id);
    traeChild.status = 'done';
    traeChild.updated_at = new Date(Date.now() + 1500).toISOString();
    const nextN = ++traeStub.next;
    const nowIso = new Date().toISOString();
    traeStub.issues.push({
      id: 'iss-' + nextN, identifier: 'WORK-' + nextN, title: '[work-space]-[implement]-外部补充 E2E',
      status: 'todo', priority: 'low', parent_issue_id: traeParent.id, assignee_id: 'agent-2', assignee_type: 'agent',
      stage: 3, due_date: '2026-10-30', created_at: nowIso, updated_at: nowIso, labels: [], metadata: {}, comments: [],
    });
    writeStub(traeStub);
    await page2.click('[data-act="sync"]');
    const syncToast = await waitToast(page2, /已同步 WORK-\d+：2 项变化/);
    check('同步拉回 2 项变化', syncToast.includes('2 项变化'), syncToast);
    await page2.waitForFunction(() => document.querySelectorAll('.subtask-row').length === 2);
    eq('同步后子任务计数', await page2.$eval('#subtask-count', e => e.textContent), '2 个');
    const rowStatus = await page2.$$eval('.subtask-row', els => els.map(e => ({ title: e.querySelector('.st-title').textContent, status: e.querySelector('select').value })));
    check('外部状态更新为 done', rowStatus.some(r => r.title.includes('补齐深色对比度回归') && r.status === 'done'), JSON.stringify(rowStatus));
    check('外部新增 child 进入列表', rowStatus.some(r => r.title.includes('外部补充 E2E') && r.status === 'todo'), JSON.stringify(rowStatus));
    eq('同步事件进入日志', await page2.$$eval('.liveline.synth', els => els.length), 4);
    const onlineBoard3 = await subBoard(page2);
    eq('同步后看板子任务分列', onlineBoard3.map(c => c.lane), ['todo', 'done']);
    eq('同步后看板当前卡仍在进行中', await boardCurrentLane(page2), 'running');
    check('同步后看板脚注 1/2', (await boardNote(page2)).includes('子任务 1/2 完成'), await boardNote(page2));
    await page2.evaluate(() => window.scrollTo(0, 0));
    await page2.locator('#task-board').screenshot({ path: path.join(SHOT_DIR, 'arch-board-subtasks.png') });

    // 父 issue 状态回写
    await page2.selectOption('#parent-status', 'in_review');
    await page2.click('[data-act="parent-status"]');
    await waitToast(page2, /→ 待验收/);
    eq('父 issue 状态回写', readStub().issues.find(x => x.id === traeLink.issueId).status, 'in_review');
    eq('父状态事件进入日志', await page2.$$eval('.liveline.synth', els => els.length), 5);

    // 写入记忆
    const traeCommentsBefore = readStub().issues.find(x => x.id === traeLink.issueId).comments.length;
    await page2.click('[data-act="memory-write"]');
    await waitToast(page2, /记忆已写入/);
    const traeComments = readStub().issues.find(x => x.id === traeLink.issueId).comments;
    eq('记忆写回追加评论', traeComments.length, traeCommentsBefore + 1);
    const memText = traeComments[traeComments.length - 1];
    check('记忆评论含两个子任务', memText.includes('补齐深色对比度回归') && memText.includes('外部补充 E2E'), memText.slice(0, 300));
    check('记忆评论含状态', memText.includes('[done]') && memText.includes('[todo]'), memText.slice(0, 300));
    eq('记忆事件进入日志', await page2.$$eval('.liveline.synth', els => els.length), 6);
    check('记忆状态显示已写入', /已写入/.test(await page2.$eval('#memory-card .cc-count', e => e.textContent)));

    // 刷新后持久化 + 外部数据仍在
    await page2.reload({ waitUntil: 'load' });
    await page2.waitForFunction(() => location.hash === '#/task/trae-style-migration' && document.querySelector('.dh-title'));
    await page2.waitForSelector('#collab');
    await page2.waitForFunction(() => document.querySelector('#bridge-chip')?.classList.contains('online'));
    eq('刷新后关联仍在', await page2.$eval('#link-state', e => e.textContent), traeIdent);
    eq('刷新后子任务仍在', await page2.$$eval('.subtask-row', els => els.length), 2);
    eq('刷新后父状态仍是待验收', await page2.$eval('#parent-status', e => e.value), 'in_review');
    check('刷新后记忆仍标记已写入', /已写入/.test(await page2.$eval('#memory-card .cc-count', e => e.textContent)));
    await page2.selectOption('#live-speed', '0');
    await page2.click('#live-replay');
    await page2.waitForFunction(() => document.querySelectorAll('.liveline.synth').length === 6);
    eq('刷新后合成日志仍在', await page2.$$eval('.liveline.synth', els => els.length), 6);

    // 全部任务视图展示协作标记
    await goAll(page2);
    eq('全部视图任务数不变', (await rows(page2)).length, 16);
    check('全部视图显示 Multica 关联', /⇄ WORK-\d+/.test(await page2.$eval('.task-row[data-task="qcn-api-pagination"] .tr-meta', e => e.textContent)));
    check('全部视图显示子任务计数', /☑ 2/.test(await page2.$eval('.task-row[data-task="trae-style-migration"] .tr-meta', e => e.textContent)));

    // 解除本地关联（不删除远端 issue）
    await goTaskOn(page2, 'qcn-db-migration');
    await page2.waitForFunction(() => document.querySelector('#bridge-chip')?.classList.contains('online'));
    await page2.click('[data-act="unlink"]');
    await waitToast(page2, /已解除本地关联/);
    eq('解除后回到未关联', await page2.$eval('#link-state', e => e.textContent), '未关联');
    const savedDb2 = await page2.evaluate(() => JSON.parse(localStorage.getItem('agentRunner.state.v2')));
    eq('解除后本地 link 清空', savedDb2.links['qcn-db-migration'], undefined);
    check('解除后 Multica issue 保留', readStub().issues.some(x => x.id === 'iss-102'));
    eq('解除事件进入日志', (await liveState(page2)).total, byId['qcn-db-migration'].events.length + 2);

    eq('HTTP 页面无 console 错误', httpErrors, []);
  } else {
    check('协作面板在线测试', false, '桥接未启动，跳过');
  }

  /* ══════════════ 13. 响应式与布局 ══════════════ */
  section('响应式 / 布局不溢出');
  await goAgent('qoder-cn');
  await page.setViewportSize({ width: 820, height: 900 });
  await page.waitForTimeout(100);
  const mobile = await page.evaluate(() => ({
    cols: getComputedStyle(document.querySelector('.app')).gridTemplateColumns,
    sidebarPos: getComputedStyle(document.querySelector('.sidebar')).position,
    overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
  }));
  eq('820px 侧栏改为单列布局', mobile.cols.trim().split(/\s+/).length, 1);
  eq('820px 侧栏不再 sticky', mobile.sidebarPos, 'static');
  eq('820px 列表无横向溢出', mobile.overflow, false);
  await page.screenshot({ path: path.join(SHOT_DIR, 'mobile-list.png'), fullPage: true });

  await goTask('qcn-config-layering');
  const detailMobile = await page.evaluate(() => ({
    gridCols: getComputedStyle(document.querySelector('.grid')).gridTemplateColumns,
    collabCols: getComputedStyle(document.querySelector('.collab-grid')).gridTemplateColumns,
    overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
  }));
  eq('820px 详情面板单列', detailMobile.gridCols.trim().split(/\s+/).length, 1);
  eq('820px 协作面板单列', detailMobile.collabCols.trim().split(/\s+/).length, 1);
  eq('820px 详情无横向溢出', detailMobile.overflow, false);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(100);
  const phoneOverflow = await page.evaluate(() => ({
    overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth,
  }));
  eq('390px 详情不产生页面级横向滚动', phoneOverflow.overflow, false);
  const phoneBits = await page.evaluate(() => {
    const btn = document.querySelector('.topbar-right [data-load]');
    const wrap = document.querySelector('.svgwrap');
    const svg = wrap.querySelector('svg');
    const live = document.querySelector('#live-panel');
    const collab = document.querySelector('.collab-grid');
    return {
      loadW: btn ? btn.getBoundingClientRect().width : 0,
      svgW: Math.round(svg.getBoundingClientRect().width),
      svgScroll: wrap.scrollWidth > wrap.clientWidth,
      liveW: Math.round(live.getBoundingClientRect().width),
      collabCols: getComputedStyle(collab).gridTemplateColumns.split(/\s+/).length,
      liveBarCol: getComputedStyle(document.querySelector('.live-bar')).flexDirection,
    };
  });
  check('390px 顶栏仍可导入日志', phoneBits.loadW > 0, String(phoneBits.loadW));
  check('390px 架构图保持可读宽度并可横向滚动', phoneBits.svgW >= 500 && phoneBits.svgScroll, JSON.stringify(phoneBits));
  check('390px 线索日志不超出视口', phoneBits.liveW <= 370, String(phoneBits.liveW));
  eq('390px 协作面板单列', phoneBits.collabCols, 1);
  eq('390px 日志工具条纵向排列', phoneBits.liveBarCol, 'column');
  await page.screenshot({ path: path.join(SHOT_DIR, 'mobile-detail.png'), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });

  /* ══════════════ 14. 运行期错误检查 ══════════════ */
  section('运行期错误检查');
  eq('file:// 无 pageerror / console.error', pageErrors, []);
  check('验收覆盖 16 个任务 + 4 个 Agent + 全部视图 + 本地导入 + 协作 + 日志', true);

  /* ══════════════ 汇总 ══════════════ */
  console.log('\n════════ 验收汇总 ════════');
  for (const [name, s] of suites) {
    console.log(`${s.fail ? '✗' : '✓'} ${name}: ${s.pass}/${s.pass + s.fail}`);
  }
  console.log(`总计 ${checks} 项断言，失败 ${failures} 项`);
  console.log(`截图目录：${SHOT_DIR}`);
  if (failures) process.exitCode = 1;
} catch (err) {
  failures++;
  console.error('\n验收中断：', err);
  process.exitCode = 1;
} finally {
  await page.screenshot({ path: path.join(SHOT_DIR, 'last-state.png'), fullPage: true }).catch(() => {});
  if (httpContext) await httpContext.close().catch(() => {});
  await browser.close();
  if (bridgeProc) {
    bridgeProc.kill('SIGTERM');
    await sleep(300);
    if (bridgeProc.exitCode == null) bridgeProc.kill('SIGKILL');
  }
  if (STUB_STATE) { try { fs.unlinkSync(STUB_STATE); } catch {} }
}
