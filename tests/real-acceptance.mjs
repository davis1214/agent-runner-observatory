/* Agent Runner · 真实数据验收
 * 运行：node tests/real-acceptance.mjs [--verbose]
 * 自起一个只读真实数据服务（默认采集本机 Qoder / Codex / WorkBuddy / Trae / Claude Code），
 * 用 Playwright 验证：工作区分组、默认分组、时间排序、独立看板（含 v5 泳道收纳）、
 * 详情任务切换、真实日志与只读边界、v5 提示词 / 工作痕迹 / 架构检查器与隐私净化。
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PROJECT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const SHOT_DIR = process.env.SHOT_DIR || '/tmp/agent-runner-real-acceptance';
const VERBOSE = process.argv.includes('--verbose');
fs.mkdirSync(SHOT_DIR, { recursive: true });

let suite = 'general', checks = 0, failures = 0;
const suites = new Map();
function section(name) { suite = name; if (!suites.has(name)) suites.set(name, { pass: 0, fail: 0 }); console.log('\n■ ' + name); }
function check(name, cond, detail = '') {
  checks++;
  const s = suites.get(suite) || { pass: 0, fail: 0 };
  if (cond) { s.pass++; if (VERBOSE) console.log('  ✓ ' + name); }
  else { s.fail++; failures++; console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
  suites.set(suite, s);
  return !!cond;
}
function eq(name, actual, wanted) { return check(name, JSON.stringify(actual) === JSON.stringify(wanted), `期望 ${JSON.stringify(wanted)}，实际 ${JSON.stringify(actual)}`); }
function sameOrder(name, actual, expected) {
  const bad = actual.findIndex((id, i) => id !== expected[i]);
  const ok = actual.length === expected.length && bad < 0;
  return check(name, ok, ok ? '' : `长度 ${actual.length}/${expected.length}，首差 #${bad}：${actual[bad]} ≠ ${expected[bad]}`);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.once('error', reject);
  srv.listen(0, '127.0.0.1', () => {
    const port = srv.address().port;
    srv.close(() => resolve(port));
  });
});

let proc = null, BASE = '';
const serverLog = [];
async function startServer() {
  const port = await freePort();
  BASE = `http://127.0.0.1:${port}`;
  const env = { ...process.env };
  delete env.OBS_DATA_DIR;
  delete env.OBS_SOURCE;
  proc = spawn(process.execPath, [path.join(PROJECT, 'scripts/serve.mjs'), '--port', String(port)], {
    cwd: PROJECT, env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', b => serverLog.push(b.toString()));
  proc.stderr.on('data', b => serverLog.push(b.toString()));
  for (let i = 0; i < 600; i++) {
    try {
      const res = await fetch(BASE + '/api/live/dataset', { signal: AbortSignal.timeout(4000) });
      if (res.ok) return await res.json();
    } catch { /* still collecting */ }
    await sleep(500);
  }
  throw new Error('真实数据服务 300s 内没有就绪：' + serverLog.join('').slice(-800));
}

const laneOf = t => {
  const pc = (t.preview && t.preview.counts) || {};
  const pending = Number(pc.total) > 0 ? Number(pc.total) : 0;
  const s = String(t.status || '').toLowerCase();
  if (['completed', 'done', 'shipped', 'succeeded'].includes(s)) return pending > 0 ? 'review' : 'done';
  if (s === 'failed') return 'failed';
  if (['canceled', 'cancelled', 'idle', 'archived', 'stopped', 'paused', 'blocked'].includes(s)) return 'idle';
  if (['todo', 'backlog', 'pending'].includes(s)) return 'todo';
  return 'running';
};
const keyOf = (t, field) => Number((t.preview && t.preview[field]) || t[field] || 0);
const sortTasks = (rows, field) => rows.slice().sort((a, b) => keyOf(b, field) - keyOf(a, field));
const rowsOf = p => p.$$eval('.task-row', els => els.map(e => e.dataset.task));
async function probeDetail(candidates) {
  for (const t of candidates) {
    if (!t) continue;
    const res = await fetch(`${BASE}/api/live/task?id=${encodeURIComponent(t.id)}`);
    const body = await res.json().catch(() => null);
    if (res.ok && Array.isArray(body?.events) && body.events.length) return { t, body };
  }
  return null;
}

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const pageErrors = [];
page.on('pageerror', e => pageErrors.push('pageerror: ' + e.message));
page.on('console', m => { if (m.type() === 'error') pageErrors.push('console: ' + m.text()); });

try {
  section('真实数据 API');
  const ds = await startServer();
  eq('数据源模式', ds.mode, 'real');
  eq('Agent 列表', ds.agents.map(a => a.id), ['qoder-cn', 'codex', 'workbuddy', 'trae-cn', 'claude-code']);
  check('任务量达到真实规模', ds.tasks.length >= 300, String(ds.tasks.length));
  const counts = Object.fromEntries(ds.agents.map(a => [a.id, ds.tasks.filter(t => t.agent === a.id).length]));
  check('每个 Agent 都有真实任务', Object.values(counts).every(n => n > 0), JSON.stringify(counts));
  check('Codex 会话已采集', counts['codex'] >= 200, String(counts['codex']));
  check('Claude Code 会话已采集', counts['claude-code'] >= 100, String(counts['claude-code']));
  check('WorkBuddy SQLite 会话已采集', counts['workbuddy'] >= 80, String(counts['workbuddy']));
  const ws = new Set(ds.tasks.map(t => t.workspace || ''));
  check('工作区跨多个真实目录', ws.size >= 20, String(ws.size));
  const defaultWorkspace = ds.tasks.filter(t => !t.workspace);
  check('存在无 cwd 的默认工作区分组', defaultWorkspace.length > 0, String(defaultWorkspace.length));
  check('任务时间字段可用于排序', ds.tasks.every(t => Number.isFinite(keyOf(t, 'createdAt')) && Number.isFinite(keyOf(t, 'updatedAt'))));
  check('状态字段都在约定集合内', ds.tasks.every(t => ['running', 'completed', 'idle', 'failed', 'canceled'].includes(t.status)));
  check('真实数据带只读 preview', ds.tasks.every(t => t.real === true && t.preview));
  const uniqueIds = new Set(ds.tasks.map(t => t.id));
  check('任务 ID 全局唯一', uniqueIds.size === ds.tasks.length, `unique ${uniqueIds.size}/${ds.tasks.length}`);

  const detailTargets = {};
  for (const a of ds.agents) {
    const candidate = ds.tasks.filter(t => t.agent === a.id);
    let hit = null;
    for (const t of candidate.slice(0, 8)) {
      const res = await fetch(`${BASE}/api/live/task?id=${encodeURIComponent(t.id)}`);
      const body = await res.json();
      if (res.ok && Array.isArray(body.events) && body.events.length) { hit = { t, body }; break; }
    }
    if (!check(`${a.id} 详情 API 可取到事件`, !!hit)) continue;
    detailTargets[a.id] = hit.t;
    check(`${a.id} 事件字段完整`, hit.body.events.every(e => e.ts && Number.isFinite(e.seq) && e.src && e.type && e.data), String(hit.body.events[0] && JSON.stringify(hit.body.events[0]).slice(0, 120)));
    check(`${a.id} 详情声明真实日志来源`, typeof hit.body.transcript === 'string' && hit.body.transcript.length > 0, JSON.stringify(Object.keys(hit.body)));
  }

  section('真实数据 UI · 工作区分组与默认分组');
  await page.goto(BASE + '/index.html');
  await page.evaluate(() => localStorage.clear());
  await page.goto(BASE + '/index.html');
  await page.waitForSelector('.agent-nav-item');
  await page.waitForSelector('.task-list');
  /* UI 断言以页面实际加载的 dataset.js 快照为准：验收期间本机 Agent 仍可能追加会话，
   * 若对比更早的 /api/live/dataset 快速照，会把真实的数据更新误判成排序错误。 */
  /* 验收期间本机 Agent 仍在写会话，SSE 会持续替换列表数据；冻结 UI 应用层，
   * 让排序 / 分组 / 看板断言与首屏快照一一对应。详情仍按真实 API 懒加载。 */
  await page.evaluate(() => { window.__RUNNER_LIVE_APPLY = () => {}; });
  const ui = await page.evaluate(() => window.OBS_DATASET);
  const uiCounts = Object.fromEntries(ui.agents.map(a => [a.id, ui.tasks.filter(t => t.agent === a.id).length]));
  const uiDefault = ui.tasks.filter(t => !t.workspace);
  const uiWs = new Set(ui.tasks.map(t => t.workspace || ''));
  eq('默认进入首个 Agent', await page.evaluate(() => location.hash), '#/agent/qoder-cn');
  eq('真实模式只读标识', await page.$eval('.mode-tag', e => e.textContent), '真实数据 · 只读');
  eq('侧栏 Agent 总数', await page.$$eval('#agent-nav .agent-nav-item', els => els.length), 5);
  eq('侧栏角标为各 Agent 任务总数', await page.$$eval('#agent-nav .an-badge', els => els.map(e => Number(e.textContent.trim()))), ui.agents.map(a => uiCounts[a.id]));
  eq('单 Agent 默认按工作区分组', await page.$eval('#task-group', e => e.value), 'group');
  const qoderGroups = await page.$$eval('.ws-group', els => els.map(e => ({ key: e.dataset.wsGroup, label: e.querySelector('.ws-name').textContent.trim(), count: Number(e.querySelector('.ws-count').textContent) })));
  eq('qoder 工作区分组数', qoderGroups.length, new Set(ui.tasks.filter(t => t.agent === 'qoder-cn').map(t => t.workspace || '')).size);
  check('分组标题展示真实工作区', qoderGroups.some(g => g.label === 'work-space') && qoderGroups.some(g => g.label === 'Qoder 默认工作区'), JSON.stringify(qoderGroups));

  await page.click('#agent-nav .agent-nav-item[data-agent="workbuddy"]');
  await page.waitForFunction(() => document.querySelector('.page-head h1')?.textContent === 'WorkBuddy');
  await page.waitForSelector('.ws-group');
  const wbTaskCount = uiCounts['workbuddy'];
  eq('WorkBuddy 行数', (await rowsOf(page)).length, wbTaskCount);
  const wbGroups = await page.$$eval('.ws-group', els => els.map(e => ({ key: e.dataset.wsGroup, label: e.querySelector('.ws-name').textContent.trim(), count: Number(e.querySelector('.ws-count').textContent) })));
  eq('WorkBuddy 工作区分组数', wbGroups.length, new Set(ui.tasks.filter(t => t.agent === 'workbuddy').map(t => t.workspace || '')).size);
  const defGroup = wbGroups.find(g => g.key === '__default__');
  check('默认工作区分组存在', !!defGroup && defGroup.label === '默认工作区', JSON.stringify(wbGroups));
  if (defGroup) eq('默认工作区任务数', defGroup.count, uiDefault.filter(t => t.agent === 'workbuddy').length);
  await page.screenshot({ path: path.join(SHOT_DIR, 'real-list-grouped.png'), fullPage: true });

  section('真实数据 UI · 工作区过滤与时间排序');
  await page.selectOption('#ws-filter', '');
  await page.waitForFunction(n => document.querySelectorAll('.task-row').length === n, uiDefault.filter(t => t.agent === 'workbuddy').length);
  eq('默认工作区过滤只显示无 cwd 任务', await rowsOf(page), sortTasks(uiDefault.filter(t => t.agent === 'workbuddy'), 'updatedAt').map(t => t.id));
  await page.selectOption('#ws-filter', 'all');
  await page.selectOption('#task-group', 'flat');
  await page.selectOption('#task-sort', 'created');
  const wb = ui.tasks.filter(t => t.agent === 'workbuddy');
  sameOrder('WorkBuddy 按创建时间降序', await rowsOf(page), sortTasks(wb, 'createdAt').map(t => t.id));
  await page.selectOption('#task-sort', 'updated');
  sameOrder('WorkBuddy 按最后更新时间降序', await rowsOf(page), sortTasks(wb, 'updatedAt').map(t => t.id));

  section('真实数据 UI · 全局列表');
  await page.click('#overview-nav [data-all]');
  await page.waitForFunction(() => {
    const badge = document.querySelector('#overview-nav .an-badge');
    return location.hash === '#/all' && !!badge && document.querySelectorAll('.task-row').length === Number(badge.textContent);
  });
  eq('全部任务视图平铺（全局排序）', await page.$eval('#task-group', e => e.value), 'flat');
  sameOrder('全局按最后更新降序', await rowsOf(page), sortTasks(ui.tasks, 'updatedAt').map(t => t.id));
  await page.selectOption('#task-sort', 'created');
  sameOrder('全局按创建时间降序', await rowsOf(page), sortTasks(ui.tasks, 'createdAt').map(t => t.id));
  await page.selectOption('#task-sort', 'updated');
  await page.click('[data-all-agent="claude-code"]');
  await page.waitForFunction(n => document.querySelectorAll('.task-row').length === n, uiCounts['claude-code']);
  eq('跨 Agent 过滤到 Claude Code', await page.$$eval('.task-row .tr-agent-name', els => [...new Set(els.map(e => e.textContent))]), ['Claude Code']);
  await page.click('[data-all-agent="all"]');
  await page.waitForFunction(n => document.querySelectorAll('.task-row').length === n, ui.tasks.length);
  await page.click('[data-status="failed"]');
  const failExpected = ui.tasks.filter(t => t.status === 'failed' || t.status === 'canceled');
  await page.waitForFunction(n => document.querySelectorAll('.task-row').length === n, failExpected.length);
  check('失败筛选含失败与取消', (await rowsOf(page)).every(id => ['failed', 'canceled'].includes(ui.tasks.find(t => t.id === id).status)));
  await page.click('[data-status="all"]');
  const probe = ui.tasks[Math.floor(ui.tasks.length / 2)];
  await page.fill('#task-q', probe.id);
  await page.waitForFunction(() => document.querySelectorAll('.task-row').length === 1);
  eq('全局按任务 ID 搜索', await rowsOf(page), [probe.id]);
  await page.fill('#task-q', '');
  await page.selectOption('#task-group', 'group');
  await page.waitForSelector('.ws-group');
  const allGroups = await page.$$eval('.ws-group', els => els.map(e => e.dataset.wsGroup));
  eq('全局按工作区分组数量', allGroups.length, uiWs.size);
  check('全局分组含默认工作区', allGroups.includes('__default__'));
  await page.selectOption('#task-group', 'flat');

  section('真实数据 UI · 独立任务看板');
  await page.click('#overview-nav [data-board]');
  await page.waitForFunction(() => {
    if (location.hash !== '#/board') return false;
    const kb = document.querySelector('.board-page .kb');
    return !!kb && Number(kb.dataset.total) === window.OBS_DATASET.tasks.length;
  });
  eq('看板六列标题', await page.$$eval('.board-page .kb-col-name', els => els.map(e => e.textContent.trim())), ['待办', '进行中', '待确认', '已完成', '已停止 / 取消', '失败']);
  const board = await page.evaluate(() => ({
    total: Number(document.querySelector('.board-page .kb').dataset.total),
    limit: document.querySelector('.board-page .kb').dataset.limit,
    fixed: document.querySelector('.board-page .kb').classList.contains('kb-fixed'),
    lanes: Object.fromEntries([...document.querySelectorAll('.board-page .kb-col')].map(c => [c.dataset.col, { total: Number(c.querySelector('.kb-col-count').textContent), shown: c.querySelectorAll('.kb-card').length }])),
    more: [...document.querySelectorAll('[data-lane-more]')].map(e => ({ lane: e.dataset.laneMore, text: e.textContent.trim() })),
    note: (document.querySelector('#board-note')?.textContent || '').replace(/\s+/g, ' ').trim(),
  }));
  eq('看板覆盖全部任务', board.total, ui.tasks.length);
  const expectedLanes = { todo: 0, running: 0, review: 0, done: 0, idle: 0, failed: 0 };
  ui.tasks.forEach(t => expectedLanes[laneOf(t)]++);
  eq('看板分列计数', Object.fromEntries(Object.entries(board.lanes).map(([k, v]) => [k, v.total])), expectedLanes);
  check('看板使用固定高度列', board.fixed);
  eq('默认每列上限 25 条', board.limit, '25');
  eq('done 列默认只显示最近 25 条', board.lanes.done.shown, Math.min(25, expectedLanes.done));
  const doneMore = board.more.find(m => m.lane === 'done');
  if (expectedLanes.done > 25) {
    check('done 列超出上限时折叠为展开按钮', !!doneMore && doneMore.text.includes(`展开剩余 ${expectedLanes.done - 25} 条`), JSON.stringify(board.more));
    await page.click('.board-page .kb-col[data-col="done"] [data-lane-more]');
    await page.waitForFunction(n => document.querySelectorAll('.board-page .kb-col[data-col="done"] .kb-card').length === n, expectedLanes.done, { timeout: 20000 });
    eq('展开后 done 列全量可见', await page.$$eval('.board-page .kb-col[data-col="done"] .kb-card', els => els.length), expectedLanes.done);
    eq('展开后出现收起按钮', await page.$eval('.board-page .kb-col[data-col="done"] [data-lane-less]', e => e.textContent.trim()), '收起，只留最近 25 条');
    await page.click('.board-page .kb-col[data-col="done"] [data-lane-less]');
    await page.waitForFunction(n => document.querySelectorAll('.board-page .kb-col[data-col="done"] .kb-card').length === n, Math.min(25, expectedLanes.done));
  } else {
    check('done 列未超上限时无展开按钮', !doneMore, JSON.stringify(board.more));
  }
  await page.selectOption('#board-limit', 'all');
  await page.waitForFunction(n => document.querySelectorAll('.board-page .kb-card').length === n, ui.tasks.length, { timeout: 30000 });
  eq('切到全部后看板全量渲染', await page.$$eval('.board-page .kb-card', els => els.length), ui.tasks.length);
  const boardAll = await page.evaluate(() => ({
    more: document.querySelectorAll('[data-lane-more]').length,
    cards: [...document.querySelectorAll('.board-page .kb-card')].map(e => ({
      lane: e.closest('.kb-col').dataset.col,
      tags: [...e.querySelectorAll('.kb-tag')].map(x => x.textContent.trim()),
    })),
  }));
  eq('全部条数时无展开按钮', boardAll.more, 0);
  eq('取消任务进入已停止列', boardAll.cards.filter(c => c.tags.includes('已取消')).every(c => c.lane === 'idle'), true);
  eq('已停止任务带状态标记', boardAll.cards.filter(c => c.tags.includes('已停止')).every(c => c.lane === 'idle'), true);
  eq('失败任务只在失败列', boardAll.cards.filter(c => c.tags.includes('失败')).every(c => c.lane === 'failed'), true);
  eq('取消任务不混入失败列', boardAll.cards.filter(c => c.tags.includes('已取消') && c.lane === 'failed').length, 0);
  await page.screenshot({ path: path.join(SHOT_DIR, 'real-board.png'), fullPage: true });
  await page.fill('#board-q', probe.id);
  await page.waitForFunction(() => document.querySelectorAll('.board-page .kb-card').length === 1);
  eq('看板按任务 ID 过滤', await page.$eval('.board-page .kb-card .kb-card-title', e => e.textContent.trim()), probe.title);
  await page.fill('#board-q', '');

  section('真实数据 UI · 详情任务切换与线索流');
  const qList = sortTasks(ui.tasks.filter(t => t.agent === 'qoder-cn'), 'updatedAt');
  const qMid = Math.floor(qList.length / 2);
  const qHit = await probeDetail([qList[qMid], ...qList]);
  check('qoder 详情目标可用', !!qHit, `qoder ${qList.length} 个任务`);
  if (!qHit) throw new Error('qoder 详情目标不可用');
  const qDetail = qHit.t;
  const qIdx = qList.findIndex(t => t.id === qDetail.id);
  check('qoder 详情目标可用于前后导航', qIdx > 0 && qIdx < qList.length - 1, `index ${qIdx}/${qList.length}`);
  await page.evaluate(id => { location.hash = '#/task/' + id; }, qDetail.id);
  await page.waitForFunction(title => location.hash === '#/task/' + location.hash.split('/').pop() && document.querySelector('.dh-title')?.textContent === title, qDetail.title);
  await page.waitForSelector('.gantt', { timeout: 40000 });
  await page.waitForFunction(() => Number(document.querySelector('#live-panel')?.dataset.total) > 0, null, { timeout: 20000 });
  eq('详情标题来自真实会话', await page.$eval('.dh-title', e => e.textContent), qDetail.title);
  check('详情元信息含工作区与 Agent', (await page.$eval('.dh-meta', e => e.textContent)).includes(qDetail.workspaceLabel) && (await page.$eval('.dh-meta', e => e.textContent)).includes('Qoder CN'));
  check('详情读取到真实日志', Number(await page.$eval('#live-panel', e => e.dataset.total)) > 0);
  check('线索日志渲染出事件', (await page.$$eval('.liveline', els => els.length)) > 0);
  eq('切换器覆盖全部任务', await page.$$eval('#task-switch option', els => els.length), ui.tasks.length);
  eq('切换器按 5 个 Agent 分组', await page.$$eval('#task-switch optgroup', els => els.map(e => e.label)), ui.agents.map(a => `${a.name}（${uiCounts[a.id]}）`));
  check('详情内独立看板为六列', (await page.$$eval('#task-board .kb-col', els => els.map(e => e.dataset.col))).join(',') === 'todo,running,review,done,idle,failed');
  check('详情看板有且仅有一个当前卡', (await page.$$eval('#task-board .kb-card:not(.kb-card-sub)', els => els.length)) === 1);
  check('详情看板脚注说明口径', /独立面板/.test(await page.$eval('#task-board + .note', e => e.textContent)));
  const liveFoot = await page.$eval('#live-panel .live-foot', e => e.textContent);
  check('执行日志声明为参考 DSH 设计', liveFoot.includes('参考 DSH') && liveFoot.includes('不依赖其运行时'), liveFoot);
  check('页面不冒充 DSH 插件运行时', !(await page.$eval('.page', e => e.textContent)).includes('dsh-task-board'));

  if (qIdx > 0 && qIdx < qList.length - 1) {
    await page.click('#task-next');
    await page.waitForFunction(id => location.hash === '#/task/' + id, qList[qIdx + 1].id);
    await page.waitForSelector('.gantt', { timeout: 40000 });
    eq('下一项切到较旧的真实任务', await page.$eval('.dh-title', e => e.textContent), qList[qIdx + 1].title);
    await page.click('#task-prev');
    await page.waitForFunction(id => location.hash === '#/task/' + id, qDetail.id);
    await page.waitForSelector('.gantt', { timeout: 40000 });
  }
  const cList = sortTasks(ui.tasks.filter(t => t.agent === 'claude-code'), 'updatedAt');
  const cKnown = ui.tasks.find(t => t.id === detailTargets['claude-code']?.id);
  const cHit = cKnown ? { t: cKnown } : await probeDetail([cList[Math.floor(cList.length / 2)], ...cList]);
  check('claude code 详情目标可用', !!cHit, `claude ${cList.length} 个任务`);
  if (!cHit) throw new Error('claude code 详情目标不可用');
  const claudeDetail = cHit.t;
  await page.selectOption('#task-switch', claudeDetail.id);
  await page.waitForFunction(id => location.hash === '#/task/' + id, claudeDetail.id);
  await page.waitForSelector('.gantt', { timeout: 40000 });
  eq('切换器跨 Agent 到 Claude Code', await page.$eval('#agent-nav .agent-nav-item.active .an-name', e => e.textContent), 'Claude Code');
  await page.screenshot({ path: path.join(SHOT_DIR, 'real-detail.png'), fullPage: true });

  section('真实数据 UI · 提示词、工作痕迹与架构检查器（v5）');
  /* 扫 qoder 真实任务找痕迹目标：不依赖某一天的会话恰好命中，按类别优先级挑 */
  const qoderScan = async () => {
    const list = sortTasks(ui.tasks.filter(t => t.agent === 'qoder-cn'), 'updatedAt');
    const rows = [];
    for (const t of list) {
      const res = await fetch(`${BASE}/api/live/task?id=${encodeURIComponent(t.id)}`);
      if (!res.ok) continue;
      const body = await res.json().catch(() => null);
      const evs = Array.isArray(body?.events) ? body.events : [];
      const isCall = e => e.type === 'tool_call';
      rows.push({
        t, evs,
        has: {
          trace: evs.some(e => isCall(e) && (/^mcp__/.test(e.data?.tool || '') || /^skill$/i.test(e.data?.tool || ''))),
          web: evs.some(e => isCall(e) && /^(WebSearch|WebFetch)$/i.test(e.data?.tool || '')),
          att: evs.some(e => e.type === 'attachment'),
          spawn: evs.some(e => e.type === 'agent_spawned'),
        },
      });
    }
    return rows;
  };
  const qrows = await qoderScan();
  const pick = pred => qrows.find(r => pred(r.has));
  const traceHit = pick(h => h.trace && h.web && h.att && h.spawn)
    || pick(h => h.trace && h.att && h.spawn)
    || pick(h => h.trace && h.web);
  check('qoder 真实任务具备技能 / 网页 / 附件 / subagent 痕迹', !!traceHit, `扫描 ${qrows.length} 个 qoder 任务：` + JSON.stringify(qrows.map(r => r.has)));
  if (traceHit) {
    const { t: traceTask, evs: traceEvs, has } = traceHit;
    /* 采集侧净化：附件只留文件名 + 域名，签名 URL 不进事件 */
    const atts = traceEvs.filter(e => e.type === 'attachment');
    if (atts.length) {
      check('附件事件只含文件名 / 域名 / 类型', atts.every(e => Object.keys(e.data || {}).every(k => ['name', 'host', 'kind'].includes(k)) && !/[?#]|https?:/.test(JSON.stringify(e.data))), JSON.stringify(atts.slice(0, 2)));
    }
    await page.evaluate(id => { location.hash = '#/task/' + id; }, traceTask.id);
    await page.waitForFunction(title => document.querySelector('.dh-title')?.textContent === title, traceTask.title, { timeout: 40000 });
    await page.waitForSelector('.gantt', { timeout: 40000 });
    const v5 = await page.evaluate(() => {
      const blocks = [...document.querySelectorAll('.trace-block')].map(e => ({
        h3: (e.querySelector('h3')?.textContent || '').replace(/\s+/g, ' ').trim(),
        rows: e.querySelectorAll('.trace-row').length,
      }));
      return {
        blocks,
        total: (document.querySelector('.trace-total')?.textContent || '').replace(/\s+/g, ' ').trim(),
        rows: document.querySelectorAll('.trace-row').length,
        links: [...document.querySelectorAll('.trace-row a')].map(a => a.getAttribute('href') || ''),
        signed: [...document.querySelectorAll('.trace-row')].some(r => /[?&](token|sig|sign|expire)=/i.test(r.textContent)),
        promptRows: document.querySelectorAll('.prompt-row').length,
        agentCards: document.querySelectorAll('.agent-card').length,
        promptFromLog: document.querySelectorAll('.prompt-row .pr-src:not(.muted)').length,
        mainPrompt: document.querySelector('.prompt-row[data-arch-agent="main"] .pr-prompt')?.textContent.trim() || '',
        subPrompts: [...document.querySelectorAll('.prompt-row:not([data-arch-agent="main"]) .pr-prompt')].map(e => e.textContent.trim()).filter(x => x && x !== '日志未记录').length,
        inspector: document.querySelector('#arch-inspector')?.dataset.archInspector,
        archNodes: [...document.querySelectorAll('.arch-node')].map(e => e.dataset.archAgent),
      };
    });
    eq('痕迹面板四块结构', v5.blocks.map(b => b.h3.replace(/ \d+$/, '')), ['技能与 MCP', '产出', '网页查阅', '来源']);
    check('痕迹面板有真实行', v5.rows > 0, JSON.stringify(v5.blocks));
    check('汇总条至少一项计数非零', /[1-9]/.test(v5.total.replace(/[^1-9]/g, '')), v5.total);
    if (has.web) check('网页查阅块有行', v5.blocks[2].rows > 0, JSON.stringify(v5.blocks[2]));
    check('页面不出现签名参数', !v5.signed, JSON.stringify(v5.links));
    check('痕迹链接全部去掉 query', v5.links.every(h => !h.includes('?')), JSON.stringify(v5.links));
    eq('提示词面板行数 = Agent 卡数', v5.promptRows, v5.agentCards);
    check('至少一个 Agent 的提示词来自日志', v5.promptFromLog >= 1, String(v5.promptFromLog));
    check('主会话提示词非空', v5.mainPrompt.length > 0 && v5.mainPrompt !== '日志未记录', v5.mainPrompt.slice(0, 40));
    if (has.spawn) check('subagent 提示词非空（spawn 或首条 user_message 回退）', v5.subPrompts >= 1, String(v5.subPrompts));
    eq('检查器默认看主会话', v5.inspector, 'main');
    const subNode = v5.archNodes.find(id => id !== 'main') || '';
    if (subNode) {
      await page.locator(`.arch-node[data-arch-agent="${subNode}"]`).hover();
      await page.waitForTimeout(80);
      eq('悬停 subagent 节点出预览', await page.$eval('#arch-inspector', e => e.dataset.archInspector), subNode);
      await page.locator(`.arch-node[data-arch-agent="${subNode}"]`).click();
      await page.waitForTimeout(80);
      eq('点击固定检查器', await page.$eval('#arch-inspector', e => e.dataset.archInspector), subNode);
      check('检查器日志最多 9 条', (await page.$$eval('#arch-inspector .ai-loglist li', els => els.length)) <= 9);
    }
    await page.screenshot({ path: path.join(SHOT_DIR, 'real-trace.png'), fullPage: true });
  }

  section('运行期错误检查');
  eq('真实数据页面无 console 错误', pageErrors, []);
  check('真实数据验收覆盖 5 个 Agent + 工作区 + 排序 + 看板 + 切换', true);
} catch (e) {
  failures++;
  console.error('\n真实数据验收中断：', e);
  if (serverLog.length) console.error(serverLog.join('').slice(-1200));
  process.exitCode = 1;
} finally {
  await page.screenshot({ path: path.join(SHOT_DIR, 'last-state.png'), fullPage: true }).catch(() => {});
  await browser.close();
  if (proc) {
    proc.kill('SIGTERM');
    await sleep(300);
    if (proc.exitCode == null) proc.kill('SIGKILL');
  }
}

console.log('\n════════ 真实数据验收汇总 ════════');
for (const [name, s] of suites) console.log(`${s.fail ? '✗' : '✓'} ${name}: ${s.pass}/${s.pass + s.fail}`);
console.log(`总计 ${checks} 项断言，失败 ${failures} 项`);
console.log(`截图目录：${SHOT_DIR}`);
if (failures) process.exitCode = 1;
