/* Agent Runner · HTTP 实时数据验收
 * 运行：node tests/live-http.mjs
 * 起一个临时数据副本 + 随机端口服务，验证页面经 SSE 收到新增事件并刷新。
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PROJECT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const SHOT_DIR = process.env.SHOT_DIR || '/tmp/agent-runner-acceptance';
fs.mkdirSync(SHOT_DIR, { recursive: true });

let checks = 0, failures = 0;
function check(name, cond, detail = '') {
  checks++;
  if (cond) console.log('  ✓ ' + name);
  else { failures++; console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function freePort() {
  const srv = net.createServer();
  await new Promise(res => srv.listen(0, '127.0.0.1', res));
  const port = srv.address().port;
  await new Promise(res => srv.close(res));
  return port;
}

async function waitFor(url, timeout = 8000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try { const res = await fetch(url); if (res.ok) return res; } catch {}
    await sleep(150);
  }
  throw new Error('等待服务超时：' + url);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-live-http-'));
fs.cpSync(path.join(PROJECT, 'data'), path.join(tmp, 'data'), { recursive: true });
const port = await freePort();
const server = spawn(process.execPath, [path.join(PROJECT, 'scripts/serve.mjs')], {
  cwd: PROJECT,
  env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', OBS_DATA_DIR: path.join(tmp, 'data') },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', b => { serverLog += b; });
server.stderr.on('data', b => { serverLog += b; });

let browser = null;
try {
  console.log('\n■ HTTP 实时数据');
  await waitFor(`http://127.0.0.1:${port}/api/live/dataset`);
  check('临时服务已启动', true);

  const dataset = await (await fetch(`http://127.0.0.1:${port}/api/live/dataset`)).json();
  check('实时快照包含 4 个 Agent', dataset.agents.length === 4, `实际 ${dataset.agents.length}`);
  check('实时快照包含 16 个任务', dataset.tasks.length === 16, `实际 ${dataset.tasks.length}`);
  check('每个任务都带 JSONL 文本', dataset.tasks.every(t => typeof t.log === 'string' && t.log.length > 0));
  check('快照带 revision', typeof dataset.revision === 'string' && dataset.revision.length > 0);

  /* 缓存头：页面与静态资源必须 no-store，否则旧标签页/启发式缓存会停留在老 UI（曾导致版本号"消失"）。 */
  {
    const head = await fetch(`http://127.0.0.1:${port}/`);
    const cc = head.headers.get('cache-control') || '';
    check('index.html 缓存头为 no-store', cc === 'no-store', `实际 "${cc}"`);
    const jsHead = await fetch(`http://127.0.0.1:${port}/assets/version.js`);
    check('静态 JS 缓存头为 no-store', (jsHead.headers.get('cache-control') || '') === 'no-store');
  }

  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#live-status[data-state="live"]', { timeout: 10_000 });
  check('页面连上 SSE', true);
  check('实时状态显示已连接', (await page.locator('#live-status .bs-text').textContent()).includes('实时'));
  check('侧栏仍渲染 4 个 Agent', await page.locator('#agent-nav .agent-nav-item').count() === 4);

  await page.evaluate(() => { location.hash = '#/task/qcn-config-layering'; });
  await page.waitForSelector('#live-panel');
  const before = Number(await page.locator('#live-panel').getAttribute('data-total'));
  check('详情日志已载入', before > 0, `实际 ${before}`);

  const res = await fetch(`http://127.0.0.1:${port}/api/live/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      taskId: 'qcn-config-layering',
      events: [{ src: 'main', type: 'tool_call', data: { tool: 'live-http-test', args: { ok: true } } }],
    }),
  });
  const ingest = await res.json();
  check('增量事件写入成功', res.ok && ingest.appended === 1, JSON.stringify(ingest));

  await page.waitForFunction(prev => Number(document.querySelector('#live-panel').dataset.total) > prev, before, { timeout: 10_000 });
  const after = Number(await page.locator('#live-panel').getAttribute('data-total'));
  check('SSE 触发页面增量刷新', after === before + 1, `before ${before} / after ${after}`);
  check('新事件出现在日志里', (await page.locator('#livelog').innerText()).includes('live-http-test'));
  check('实时状态保持连接', await page.locator('#live-status').getAttribute('data-state') === 'live');

  const bad = await fetch(`http://127.0.0.1:${port}/api/live/events`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ taskId: '../etc', events: [{ type: 'tool_call' }] }),
  });
  check('非法 taskId 被拒绝', bad.status === 400, `HTTP ${bad.status}`);
  const missing = await fetch(`http://127.0.0.1:${port}/api/live/events`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ taskId: 'not-a-task', events: [{ type: 'tool_call' }] }),
  });
  check('未知任务被拒绝', missing.status === 404, `HTTP ${missing.status}`);

  await page.screenshot({ path: path.join(SHOT_DIR, 'live-http.png'), fullPage: true });
  check('无页面异常', errors.length === 0, errors.join(' | '));
} catch (e) {
  failures++;
  console.error('  ✗ 验收中断：' + e.message);
  if (serverLog) console.error(serverLog);
} finally {
  if (browser) await browser.close().catch(() => {});
  server.kill('SIGTERM');
  await sleep(300);
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n总计 ${checks} 项断言，失败 ${failures} 项`);
process.exit(failures ? 1 : 0);
