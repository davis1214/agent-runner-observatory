#!/usr/bin/env node
/* Agent Runner · 本地桥接（静态服务 + 实时数据 + Multica CLI 代理）
 * 运行：node scripts/serve.mjs [--port 8796]
 * 只绑定 127.0.0.1；不向浏览器暴露 Multica token，所有写操作由本机 CLI 完成。
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRealSource, REAL_AGENTS } from './real-data.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const DATA_DIR = path.resolve(process.env.OBS_DATA_DIR || path.join(ROOT, 'data'));
const SOURCE_MODE = (process.env.OBS_SOURCE || (process.env.OBS_DATA_DIR ? 'demo' : 'real')).toLowerCase();
const REAL = SOURCE_MODE === 'real' ? createRealSource() : null;
const HOST = process.env.HOST || '127.0.0.1';
const argv = process.argv.slice(2);
const portFlag = argv.indexOf('--port');
const PORT = Number(portFlag >= 0 ? argv[portFlag + 1] : process.env.PORT || 8796);
const MULTICA_BIN = process.env.MULTICA_BIN || 'multica';
const CONFIG_PATH = process.env.MULTICA_CONFIG || path.join(os.homedir(), '.multica', 'config.json');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.jsonl': 'application/x-ndjson; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.md': 'text/markdown; charset=utf-8',
  '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
};

function readConfig() {
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    return {
      appUrl: String(cfg.app_url || cfg.server_url || 'http://localhost:3000').replace(/\/$/, ''),
      serverUrl: String(cfg.server_url || 'http://localhost:8080').replace(/\/$/, ''),
      workspaceId: cfg.workspace_id || null,
    };
  } catch {
    return { appUrl: 'http://localhost:3000', serverUrl: 'http://localhost:8080', workspaceId: null };
  }
}
const CFG = readConfig();

function runMultica(args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(MULTICA_BIN, args, { env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    const out = [], err = [];
    let size = 0, done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      child.kill('SIGKILL');
      reject(new Error(`multica ${args[0]} ${args[1] || ''} 超时（30s）`));
    }, 30_000);
    const collect = (buf) => { size += buf.length; if (size > 8e6) { child.kill('SIGKILL'); } return buf; };
    child.stdout.on('data', b => out.push(collect(b)));
    child.stderr.on('data', b => err.push(collect(b)));
    child.on('error', e => {
      if (done) return; done = true; clearTimeout(timer);
      reject(new Error(e.code === 'ENOENT' ? `找不到 multica CLI（${MULTICA_BIN}），请确认已安装并在 PATH 中` : e.message));
    });
    child.on('close', code => {
      if (done) return; done = true; clearTimeout(timer);
      const stdout = Buffer.concat(out).toString('utf8').trim();
      const stderr = Buffer.concat(err).toString('utf8').trim();
      if (code !== 0) return reject(new Error(stderr || stdout || `multica 退出码 ${code}`));
      resolve({ stdout, stderr });
    });
    if (input != null) child.stdin.end(input); else child.stdin.end();
  });
}

async function runJSON(args, input) {
  const { stdout } = await runMultica(args, input);
  if (!stdout) return null;
  try { return JSON.parse(stdout); } catch {
    throw new Error(`multica 返回了非 JSON 输出：${stdout.slice(0, 180)}`);
  }
}

let healthCache = { at: 0, value: null };
async function health() {
  if (Date.now() - healthCache.at < 4000) return healthCache.value;
  let value = { online: false, checks: null };
  try {
    const res = await fetch(CFG.serverUrl + '/healthz', { signal: AbortSignal.timeout(2500) });
    const body = await res.json().catch(() => null);
    value = { online: res.ok && body?.status === 'ok', checks: body?.checks || null };
  } catch {}
  healthCache = { at: Date.now(), value };
  return value;
}

let agentCache = { at: 0, list: null };
async function agents() {
  if (agentCache.list && Date.now() - agentCache.at < 30_000) return agentCache.list;
  const rows = await runJSON(['agent', 'list', '--output', 'json']);
  const list = (Array.isArray(rows) ? rows : [])
    .filter(a => !a.archived_at)
    .map(a => ({ id: a.id, name: a.name, status: a.status || '', runtimeId: a.runtime_id || null, model: a.model || '' }))
    .sort((a, b) => a.name.localeCompare(b.name));
  agentCache = { at: Date.now(), list };
  return list;
}

function agentNameMap(list) {
  return new Map(list.map(a => [a.id, a.name]));
}

const PATHS = {
  project: '01-raw/05-tasks/2026-10-25-agent-router-observatory',
};

function minimalIssue(x, nameMap) {
  if (!x) return null;
  const assigneeName = x.assignee_id && nameMap ? nameMap.get(x.assignee_id) : null;
  return {
    id: x.id, identifier: x.identifier, title: x.title, status: x.status,
    priority: x.priority || null, parentIssueId: x.parent_issue_id || null,
    assigneeId: x.assignee_id || null, assigneeType: x.assignee_type || null,
    assigneeName: assigneeName || null, stage: x.stage ?? null,
    dueDate: x.due_date || null, createdAt: x.created_at || null, updatedAt: x.updated_at || null,
    labels: Array.isArray(x.labels) ? x.labels.map(l => l.name) : [],
    url: `${CFG.appUrl}/work-space/issues/${encodeURIComponent(x.identifier || x.id)}`,
  };
}

function flattenChildren(data, nameMap) {
  const rows = [];
  for (const stage of data?.stages || []) {
    for (const x of stage.issues || []) rows.push({ ...minimalIssue(x, nameMap), stage: stage.stage ?? x.stage ?? null });
  }
  for (const x of data?.unstaged || []) rows.push({ ...minimalIssue(x, nameMap), stage: x.stage ?? null });
  return rows.sort((a, b) => (a.stage || 0) - (b.stage || 0) || String(a.identifier).localeCompare(String(b.identifier)));
}

function nextFriday() {
  const d = new Date();
  const delta = (5 - d.getDay() + 7) % 7;
  d.setDate(d.getDate() + delta);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function cleanText(v, max = 4000) {
  return String(v ?? '').trim().slice(0, max);
}

function parentDescription(task) {
  return [
    '## 目标',
    `在 Agent Runner 中跟踪任务「${cleanText(task.title, 200)}」的执行与验收。`,
    '',
    '## 范围与步骤',
    '1. 读取本 issue 的关联记忆与子任务记录。',
    '2. 按子任务拆解执行，完成后回写 Multica 状态。',
    '3. 产物验证通过后在 Agent Runner 中标记可交付。',
    '',
    '## 验收标准（AC）',
    '- [ ] 所有子任务完成并回写状态',
    '- [ ] 产物验证通过',
    '',
    '---',
    '## Agent Runner 关联',
    `- task_id: ${task.id}`,
    `- runner_agent: ${task.agent || '—'}`,
    `- repo: ${task.repo || '—'}`,
    `- task_dir: ${PATHS.project}`,
  ].join('\n');
}

function memoryComment(task, issue, subtasks = []) {
  const rows = Array.isArray(subtasks) ? subtasks.slice(0, 100) : [];
  const lines = [
    '## Agent Runner 关联记忆',
    `- task_id: ${task.id}`,
    `- runner_agent: ${task.agent || '—'}`,
    `- repo: ${task.repo || '—'}`,
    `- multica_issue: ${issue.identifier}`,
    `- task_dir: ${PATHS.project}`,
    `- linked_at: ${new Date().toISOString()}`,
    '',
    '子任务进度：',
  ];
  if (!rows.length) lines.push('- 暂无本地派发记录');
  for (const s of rows) {
    lines.push(`- [${cleanText(s.status || 'todo', 24)}] ${cleanText(s.title, 160)}${s.identifier ? ` · ${cleanText(s.identifier, 40)}` : ' · 仅本地'}`);
  }
  lines.push(
    '',
    '子任务协议：在本 issue 下创建 child issue；child 的 metadata 保留 `sync_source=agent-runner` 与 `runner_parent_task_id`，状态更新后同步回 Agent Runner。',
  );
  return lines.join('\n');
}

function subtaskDescription(task, parent, title, body, owner) {
  return [
    '## 目标',
    cleanText(body, 2000) || `完成「${cleanText(task.title, 200)}」下的子任务：${cleanText(title, 200)}`,
    '',
    '## 范围与步骤',
    `1. 父任务：${parent.identifier} · ${parent.title}`,
    `2. 负责人：${owner || '待分配'}`,
    '3. 完成后把状态回写到 Multica，并在 Agent Runner 中同步。',
    '',
    '## 验收标准（AC）',
    '- [ ] 子任务目标完成',
    '- [ ] 状态与证据已回写',
    '',
    '---',
    '## Agent Runner 关联',
    `- runner_parent_task_id: ${task.id}`,
    `- runner_agent: ${task.agent || '—'}`,
    `- parent_issue: ${parent.identifier}`,
  ].join('\n');
}

async function labelIds(names) {
  const labels = await runJSON(['label', 'list', '--output', 'json']).catch(() => []);
  const map = new Map((Array.isArray(labels) ? labels : []).map(l => [l.name, l.id]));
  return names.map(n => ({ name: n, id: map.get(n) })).filter(x => x.id);
}

async function attachLabels(issueId, names, warnings) {
  const ids = await labelIds(names);
  for (const { name, id } of ids) {
    try { await runMultica(['issue', 'label', 'add', issueId, id]); }
    catch (e) { warnings.push(`标签 ${name} 未附上：${e.message}`); }
  }
  for (const name of names) if (!ids.some(x => x.name === name)) warnings.push(`标签 ${name} 不存在，已跳过`);
}

async function setMetadata(issueId, entries, warnings) {
  for (const [key, value] of Object.entries(entries)) {
    try {
      await runMultica(['issue', 'metadata', 'set', issueId, '--key', key, '--value', String(value), '--type', 'string']);
    } catch (e) { warnings.push(`metadata ${key} 写入失败：${e.message}`); }
  }
}

async function issueBundle(id, warnings = []) {
  const list = await agents().catch(() => []);
  const nameMap = agentNameMap(list);
  const issue = await runJSON(['issue', 'get', id, '--output', 'json']);
  let children = [];
  try {
    const raw = await runJSON(['issue', 'children', id, '--output', 'json']);
    children = flattenChildren(raw, nameMap);
  } catch (e) { warnings.push(`子任务读取失败：${e.message}`); }
  return { issue: minimalIssue(issue, nameMap), children, warnings };
}

/* ---------------- 实时数据：磁盘快照 + SSE 增量通知 ---------------- */

function readCatalog() {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'catalog.json'), 'utf8'));
    return {
      generatedAt: parsed.generatedAt || '',
      agents: Array.isArray(parsed.agents) ? parsed.agents : [],
      tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
    };
  } catch {
    return { generatedAt: '', agents: [], tasks: [] };
  }
}

function sessionFiles() {
  try { return fs.readdirSync(path.join(DATA_DIR, 'sessions')).filter(f => f.endsWith('.jsonl')); }
  catch { return []; }
}

function liveRevision() {
  if (REAL) return 'real-' + REAL.revision();
  const files = [path.join(DATA_DIR, 'catalog.json'), ...sessionFiles().map(f => path.join(DATA_DIR, 'sessions', f))];
  let max = 0, total = 0, count = 0;
  for (const file of files) {
    try { const st = fs.statSync(file); max = Math.max(max, st.mtimeMs); total += st.size; count++; } catch {}
  }
  return `${max.toFixed(3)}-${total}-${count}`;
}

function parseJSONLText(text) {
  return String(text || '').split('\n').filter(l => l.trim().startsWith('{')).map(line => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}

function liveDataset() {
  if (REAL) {
    const cat = REAL.catalog();
    return {
      generatedAt: cat.builtAt,
      agents: REAL_AGENTS.map(a => ({ ...a, source: 'real' })),
      tasks: cat.tasks,
      workspaces: cat.workspaces,
      sources: cat.sources,
      mode: 'real',
      live: true,
      revision: cat.revision,
      servedAt: new Date().toISOString(),
    };
  }
  const catalog = readCatalog();
  const tasks = catalog.tasks.map(task => {
    let log = '';
    try { log = fs.readFileSync(path.join(DATA_DIR, 'sessions', `${task.id}.jsonl`), 'utf8'); } catch {}
    return { ...task, log };
  });
  return {
    generatedAt: catalog.generatedAt,
    agents: catalog.agents,
    tasks,
    mode: 'demo',
    live: true,
    revision: liveRevision(),
    servedAt: new Date().toISOString(),
  };
}

function liveTask(id) {
  if (REAL) return REAL.readTask(id);
  const catalog = readCatalog();
  const task = catalog.tasks.find(t => t.id === id);
  if (!task) return null;
  let log = '';
  try { log = fs.readFileSync(path.join(DATA_DIR, 'sessions', `${id}.jsonl`), 'utf8'); } catch {}
  return { task: { ...task }, events: parseJSONLText(log), transcript: `data/sessions/${id}.jsonl`, partial: false };
}

function appendLiveEvents(body) {
  if (REAL) throw Object.assign(new Error('真实数据源为只读：会话由各 Agent 本机写入，不能通过桥接追加事件'), { status: 409 });
  const taskId = String(body?.taskId || '');
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(taskId)) throw Object.assign(new Error('taskId 非法'), { status: 400 });
  const catalog = readCatalog();
  if (!catalog.tasks.some(t => t.id === taskId)) throw Object.assign(new Error(`catalog 里没有任务 ${taskId}`), { status: 404 });
  const rows = Array.isArray(body?.events) ? body.events : null;
  if (!rows || !rows.length) throw Object.assign(new Error('events 不能为空'), { status: 400 });
  if (rows.length > 500) throw Object.assign(new Error('单次最多 500 条事件'), { status: 413 });

  const file = path.join(DATA_DIR, 'sessions', `${taskId}.jsonl`);
  let existing = '';
  try { existing = fs.readFileSync(file, 'utf8'); } catch {}
  let maxSeq = 0;
  for (const line of existing.split('\n')) {
    if (!line.trim()) continue;
    try { const n = Number(JSON.parse(line).seq); if (Number.isFinite(n) && n > maxSeq) maxSeq = n; } catch {}
  }
  const now = new Date().toISOString();
  const lines = rows.map(raw => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw Object.assign(new Error('事件必须是对象'), { status: 400 });
    const type = String(raw.type || '').trim();
    if (!type) throw Object.assign(new Error('事件缺少 type'), { status: 400 });
    const ts = raw.ts && Number.isFinite(Date.parse(raw.ts)) ? raw.ts : now;
    return JSON.stringify({
      ts, seq: ++maxSeq, src: String(raw.src || 'main'), type,
      data: raw.data && typeof raw.data === 'object' && !Array.isArray(raw.data) ? raw.data : {},
    });
  });
  const prefix = existing && !existing.endsWith('\n') ? '\n' : '';
  fs.appendFileSync(file, prefix + lines.join('\n') + '\n', 'utf8');
  return { ok: true, taskId, appended: lines.length, revision: liveRevision(), file: path.relative(DATA_DIR, file) };
}

function streamLive(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  let last = liveRevision();
  const send = (event, data) => {
    if (res.writableEnded) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  res.write('retry: 2000\n\n');
  send('ready', { revision: last, at: new Date().toISOString() });
  const tick = setInterval(() => {
    const revision = liveRevision();
    if (revision === last) return;
    last = revision;
    send('change', { revision, at: new Date().toISOString() });
  }, 1500);
  const beat = setInterval(() => { if (!res.writableEnded) res.write(': ping\n\n'); }, 20_000);
  const cleanup = () => { clearInterval(tick); clearInterval(beat); };
  req.on('close', cleanup);
  res.on('close', cleanup);
}

async function handleLive(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/live/dataset') {
    return sendJSON(res, 200, liveDataset());
  }
  if (req.method === 'GET' && url.pathname === '/api/live/task') {
    try {
      const id = String(url.searchParams.get('id') || '');
      if (!id) return sendJSON(res, 400, { error: '缺少 id' });
      const data = liveTask(id);
      if (!data) return sendJSON(res, 404, { error: `找不到任务 ${id}` });
      return sendJSON(res, 200, data);
    } catch (e) {
      return sendJSON(res, e.status || 500, { error: e.message || '读取会话失败' });
    }
  }
  if (req.method === 'GET' && url.pathname === '/api/live/stream') {
    return streamLive(req, res);
  }
  if (req.method === 'POST' && url.pathname === '/api/live/events') {
    try {
      const body = await readBody(req);
      return sendJSON(res, 200, appendLiveEvents(body));
    } catch (e) {
      return sendJSON(res, e.status || 400, { error: e.message || '实时事件写入失败' });
    }
  }
  return sendJSON(res, 404, { error: 'unknown live endpoint' });
}

const API = {
  'GET /status': async () => {
    const h = await health();
    let cli = null;
    try { cli = (await runMultica(['--version'])).stdout.split('\n')[0]; } catch {}
    return {
      ok: true, bridge: 'online', multica: { online: h.online, checks: h.checks, serverUrl: CFG.serverUrl, appUrl: CFG.appUrl, workspaceId: CFG.workspaceId, cli },
    };
  },
  'GET /agents': async () => ({ agents: await agents() }),
  'GET /issues': async (url) => {
    const q = cleanText(url.searchParams.get('q'), 80).toLowerCase();
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 30));
    const list = await agents().catch(() => []);
    const nameMap = agentNameMap(list);
    let rows = [];
    if (q) {
      const data = await runJSON(['issue', 'search', q, '--limit', String(limit), '--output', 'json']);
      rows = (data?.issues || []).filter(x => !x.parent_issue_id);
    } else {
      const data = await runJSON(['issue', 'list', '--limit', String(Math.min(100, limit * 3)), '--fields', 'id,identifier,title,status,priority,parent_issue_id,assignee_id,assignee_type,updated_at,due_date,labels', '--output', 'json']);
      rows = (data?.issues || []).filter(x => !x.parent_issue_id);
    }
    return { issues: rows.slice(0, limit).map(x => minimalIssue(x, nameMap)) };
  },
  'GET /issue': async (url, m) => issueBundle(decodeURIComponent(m[2])),
  'POST /link': async (url, m, body) => {
    const task = body?.task;
    if (!task?.id || !task?.title) throw Object.assign(new Error('缺少 task.id / task.title'), { status: 400 });
    if (body.mode === 'existing') {
      if (!body.issueId) throw Object.assign(new Error('缺少 issueId'), { status: 400 });
      const warnings = [];
      const bundle = await issueBundle(body.issueId, warnings);
      await setMetadata(bundle.issue.id, {
        runner_task_id: task.id, runner_agent: task.agent || '', runner_repo: task.repo || '',
        runner_linked_at: new Date().toISOString(), runner_link_source: 'existing', runner_task_dir: PATHS.project,
      }, warnings);
      try { await runMultica(['issue', 'comment', 'add', bundle.issue.id, '--content-stdin'], memoryComment(task, bundle.issue)); }
      catch (e) { warnings.push(`关联评论写入失败：${e.message}`); }
      return { ...bundle, memory: { taskId: task.id, issueIdentifier: bundle.issue.identifier, metadataKeys: ['runner_task_id', 'runner_agent', 'runner_repo', 'runner_linked_at', 'runner_link_source', 'runner_task_dir'] }, warnings };
    }
    const warnings = [];
    const title = cleanText(task.title, 180).startsWith('[') ? cleanText(task.title, 200) : `[work-space]-[implement]-${cleanText(task.title, 170)}`;
    const created = await runJSON(['issue', 'create', '--title', title, '--description-stdin', '--priority', 'low', '--due-date', nextFriday(), '--status', 'todo', '--output', 'json'], parentDescription(task));
    const id = created.id;
    const memory = {
      taskId: task.id, issueIdentifier: created.identifier, metadataKeys: ['sync_source', 'sync_date', 'task_id', 'task_dir', 'runner_link_source'],
    };
    await attachLabels(id, ['work-space', 'todo', 'implement'], warnings);
    await setMetadata(id, {
      sync_source: 'agent-runner', sync_date: new Date().toISOString().slice(0, 10), task_id: task.id,
      task_dir: PATHS.project, runner_link_source: 'created', runner_agent: task.agent || '', runner_repo: task.repo || '',
    }, warnings);
    try { await runMultica(['issue', 'comment', 'add', id, '--content-stdin'], memoryComment(task, created)); }
    catch (e) { warnings.push(`关联评论写入失败：${e.message}`); }
    const bundle = await issueBundle(id, warnings);
    return { ...bundle, memory, warnings };
  },
  'POST /memory': async (url, m, body) => {
    const task = body?.task;
    if (!task?.id || !task?.title || !body?.issueId) throw Object.assign(new Error('缺少 task / issueId'), { status: 400 });
    const warnings = [];
    const bundle = await issueBundle(body.issueId, warnings);
    const subtasks = Array.isArray(body.subtasks) ? body.subtasks : [];
    const text = memoryComment(task, bundle.issue, subtasks);
    try { await runMultica(['issue', 'comment', 'add', bundle.issue.id, '--content-stdin'], text); }
    catch (e) { throw Object.assign(new Error(`关联记忆写入失败：${e.message}`), { status: 502 }); }
    await setMetadata(bundle.issue.id, {
      runner_memory_updated_at: new Date().toISOString(), runner_task_id: task.id,
      runner_agent: task.agent || '', runner_task_dir: PATHS.project,
    }, warnings);
    return {
      ...bundle,
      memory: { taskId: task.id, issueIdentifier: bundle.issue.identifier, text, subtasks: subtasks.length, metadataKeys: ['runner_memory_updated_at', 'runner_task_id', 'runner_agent', 'runner_task_dir'] },
      warnings,
    };
  },
  'POST /subtask': async (url, m, body) => {
    const { task, parentIssueId, title, description = '', assignee = '', stage } = body || {};
    if (!task?.id || !parentIssueId || !cleanText(title)) throw Object.assign(new Error('缺少 task / parentIssueId / title'), { status: 400 });
    const warnings = [];
    const parentList = await agents().catch(() => []);
    const nameMap = agentNameMap(parentList);
    const parent = minimalIssue(await runJSON(['issue', 'get', parentIssueId, '--output', 'json']), nameMap);
    const normalizedTitle = cleanText(title, 180).startsWith('[') ? cleanText(title, 200) : `[work-space]-[implement]-${cleanText(title, 170)}`;
    const args = ['issue', 'create', '--title', normalizedTitle, '--description-stdin', '--parent', parent.id, '--status', 'todo', '--priority', 'low', '--due-date', nextFriday(), '--output', 'json'];
    if (Number(stage) >= 1) args.push('--stage', String(Math.floor(Number(stage))));
    const created = await runJSON(args, subtaskDescription(task, parent, title, description, assignee));
    const id = created.id;
    await attachLabels(id, ['work-space', 'todo', 'implement'], warnings);
    await setMetadata(id, {
      sync_source: 'agent-runner', sync_date: new Date().toISOString().slice(0, 10), task_id: task.id,
      runner_parent_task_id: task.id, runner_parent_issue: parent.identifier, runner_origin: 'subtask', runner_task_dir: PATHS.project,
    }, warnings);
    if (cleanText(assignee)) {
      try { await runMultica(['issue', 'assign', id, '--to', cleanText(assignee, 100), '--no-start']); }
      catch (e) { warnings.push(`分配 ${assignee} 失败：${e.message}`); }
    }
    try { await runMultica(['issue', 'comment', 'add', id, '--content-stdin'], memoryComment(task, created)); }
    catch (e) { warnings.push(`子任务评论写入失败：${e.message}`); }
    const bundle = await issueBundle(id, warnings);
    return { ...bundle, warnings };
  },
  'PATCH /issue': async (url, m, body) => {
    const id = decodeURIComponent(m[2]);
    const warnings = [];
    const patch = body || {};
    if (patch.status) {
      const allowed = ['backlog', 'todo', 'in_progress', 'in_review', 'done', 'blocked', 'cancelled'];
      if (!allowed.includes(patch.status)) throw Object.assign(new Error('非法状态'), { status: 400 });
      await runMultica(['issue', 'update', id, '--status', patch.status, '--no-start']);
    }
    if (patch.assignee !== undefined) {
      if (cleanText(patch.assignee)) await runMultica(['issue', 'assign', id, '--to', cleanText(patch.assignee, 100), '--no-start']);
      else await runMultica(['issue', 'assign', id, '--unassign', '--no-start']);
    }
    if (patch.title) await runMultica(['issue', 'update', id, '--title', cleanText(patch.title, 200), '--no-start']);
    return issueBundle(id, warnings);
  },
};

async function readBody(req) {
  const chunks = []; let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 256 * 1024) throw Object.assign(new Error('请求体过大'), { status: 413 });
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('请求体不是合法 JSON'), { status: 400 }); }
}

function sendJSON(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(data);
}

function sendDatasetScript(res) {
  /* 真实模式首屏直接拿到真实元数据，避免先闪一帧打包的演示数据。 */
  const data = liveDataset();
  const body = 'window.OBS_DATASET = ' + JSON.stringify(data).replace(/</g, '\\u003c') + ';\n';
  res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  if (rel.includes('\0') || rel.split('/').some(seg => seg === '..')) { res.writeHead(403); return res.end('forbidden'); }
  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT + path.sep)) { res.writeHead(403); return res.end('forbidden'); }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('not found'); }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      /* no-store：页面与脚本永远取最新。曾因无缓存头导致旧标签页/启发式缓存停留在无版本号的老 UI。 */
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || HOST}`);
  if (REAL && req.method === 'GET' && url.pathname === '/data/dataset.js') return sendDatasetScript(res);
  if (url.pathname.startsWith('/api/live/')) return handleLive(req, res, url);
  if (!url.pathname.startsWith('/api/bridge/')) return serveStatic(req, res, url);
  const route = url.pathname.slice('/api/bridge'.length);
  const m = route.match(/^\/([a-z-]+)(?:\/([^/]+))?$/i);
  const key = m ? `${req.method} /${m[1]}` : null;
  const handler = key && API[key];
  if (!handler) return sendJSON(res, 404, { error: 'unknown bridge endpoint' });
  try {
    const body = ['POST', 'PATCH', 'PUT'].includes(req.method) ? await readBody(req) : {};
    const result = await handler(url, m, body);
    sendJSON(res, 200, result);
  } catch (e) {
    sendJSON(res, e.status || 502, { error: e.message || 'bridge error' });
  }
});

server.listen(PORT, HOST, () => {
  const actual = server.address().port;
  console.log(`Agent Runner bridge → http://${HOST}:${actual}`);
  console.log(SOURCE_MODE === 'real'
    ? `数据源: 本机真实会话（Qoder CN / Codex / WorkBuddy / Trae CN / Claude Code）`
    : `数据源: 演示快照 · 数据目录 ${DATA_DIR}`);
  console.log(`Multica: ${CFG.serverUrl} · workspace ${CFG.workspaceId || '(CLI default)'}`);
  console.log('只监听本机回环地址；Ctrl+C 停止。');
});
