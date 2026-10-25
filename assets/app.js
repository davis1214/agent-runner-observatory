/* Agent Runner · 列表 / 全部任务 / 任务看板 / 详情 / 协作 / 实时日志 */
(function () {
  'use strict';

  const DS = window.OBS_DATASET || { agents: [], tasks: [], generatedAt: '' };
  const OBS = window.Observatory;
  const STORE = window.RunnerStore || {
    linkFor: () => null, setLink: () => null, patchLink: () => null, clearLink: () => {},
    subtasksFor: () => [], addSubtask: () => null, updateSubtask: () => null, removeSubtask: () => {},
    eventsFor: () => [], addEvent: () => null, version: () => 0, memoryBlock: () => '',
  };
  const BRIDGE = window.RunnerMultica || { status: async () => ({ ok: false, bridge: 'offline', reason: '桥接客户端未加载' }), fileMode: location.protocol === 'file:' };
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const clip = (s, n) => { const a = Array.from(String(s || '')); return a.length > n ? a.slice(0, n - 1).join('') + '…' : a.join(''); };
  const fmtCost = n => '$' + (Number(n) || 0).toFixed(4);
  const fmtCredits = n => (Number(n) || 0).toLocaleString('zh-CN', { maximumFractionDigits: 2 }) + ' credits';
  const fmtCreditShort = n => Number(n) >= 1000 ? (Number(n) / 1000).toFixed(1) + 'k cr' : (Math.round(Number(n) * 10) / 10) + ' cr';
  const fmtAmount = (v, unit) => unit === 'credits' ? fmtCredits(v) : fmtCost(v);
  const fmtTok = n => OBS.fmtTok(n);
  const fmtDur = ms => OBS.fmtDur(ms);
  const fmtStamp = ms => OBS.fmtStamp ? OBS.fmtStamp(ms) : '—';
  const fmtStart = fmtStamp;
  const STATUS = {
    completed: ['✓ 已完成', 'b-ok'], running: ['● 运行中', 'b-run'],
    idle: ['◼ 已停止', 'b-idle'], failed: ['✗ 失败', 'b-fail'], canceled: ['■ 已取消', 'b-cancel'],
  };
  const sortVal = {
    updated: (a, b) => (b.s.updatedAt || b.s.startedAt) - (a.s.updatedAt || a.s.startedAt),
    recent: (a, b) => b.s.startedAt - a.s.startedAt,
    created: (a, b) => (b.s.createdAt || b.s.startedAt) - (a.s.createdAt || a.s.startedAt),
    duration: (a, b) => b.s.durationMs - a.s.durationMs,
    cost: (a, b) => (b.s.credits - a.s.credits) || (b.s.cost - a.s.cost),
  };
  const SORT_OPTIONS = [
    ['updated', '最近更新'], ['created', '最近创建'], ['recent', '最近执行'],
    ['duration', '耗时最长'], ['cost', '消耗最高'],
  ];

  const state = {
    mode: 'agent', agent: 'qoder-cn', allAgent: 'all', status: 'all', workspace: 'all', q: '', sort: 'updated',
    group: true, collapsed: new Set(), bAgent: 'all', bWorkspace: 'all', bQ: '', bLimit: 25, bOpen: new Set(),
  };
  const groupPref = { agent: true, all: false };
  const local = { agents: [], tasks: [] };
  const cache = new Map();
  const loadedLogs = [];
  const $ = sel => document.querySelector(sel);
  const nav = $('#agent-nav'), overviewNav = $('#overview-nav'), view = $('#view'), crumb = $('#crumb'), topStats = $('#top-stats');

  let live = null, collab = null, pollTimer = null, bridgeState = null, bridgeStatusPromise = null;
  let detailSeq = 0, detailFetching = false;
  let lastList = '#/agent/qoder-cn';

  function paintMode() {
    const real = DS.mode === 'real';
    document.querySelectorAll('.mode-tag').forEach(el => {
      el.className = 'mode-tag ' + (real ? 'real' : 'demo');
      el.textContent = real ? '真实数据 · 只读' : '演示数据';
      el.title = real ? '来自本机各 Agent 会话存储，只读' : '打包的演示数据；通过服务端打开可切换真实数据';
    });
    const side = $('#side-mode');
    if (side) side.textContent = real ? '真实会话' : '演示数据';
  }

  const agents = () => DS.agents.concat(local.agents);
  const allTasks = () => DS.tasks.concat(local.tasks);
  const tasksOf = id => allTasks().filter(t => t.agent === id);
  const agentOf = id => agents().find(a => a.id === id);

  function summarize(task) {
    const ver = STORE.version(task.id);
    const hit = cache.get(task.id);
    if (hit && hit.task === task && hit.version === ver) return hit.summary;
    const s = OBS.summarize(task, STORE.eventsFor(task.id));
    cache.set(task.id, { task, version: ver, summary: s });
    return s;
  }

  let toastTimer;
  function toast(msg, kind) {
    const el = $('#toast');
    if (!el) return;
    el.className = 'toast ' + (kind || '');
    el.textContent = msg;
    el.style.display = 'flex';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.style.display = 'none'; }, 3400);
  }

  function resourceText(s) {
    if (s.costUnit === 'credits' && s.credits) return fmtCredits(s.credits);
    if (s.credits && s.cost) return `${fmtCredits(s.credits)} + ${fmtCost(s.cost)}`;
    if (s.credits) return fmtCredits(s.credits);
    return fmtCost(s.cost);
  }

  function computeStats(sums) {
    return {
      total: sums.length,
      running: sums.filter(x => x.s.status === 'running').length,
      completed: sums.filter(x => x.s.status === 'completed').length,
      idle: sums.filter(x => x.s.status === 'idle').length,
      failed: sums.filter(x => x.s.status === 'failed' || x.s.status === 'canceled').length,
      pending: sums.reduce((n, x) => n + x.s.counts.pending, 0),
      pass: sums.reduce((n, x) => n + x.s.counts.pass, 0),
      results: sums.reduce((n, x) => n + x.s.counts.total, 0),
      cost: sums.reduce((n, x) => n + x.s.cost, 0),
      credits: sums.reduce((n, x) => n + x.s.credits, 0),
      tokens: sums.reduce((n, x) => n + x.s.tokens, 0),
      agents: new Set(sums.map(x => x.s.task.agent)).size,
      workspaces: new Set(sums.map(x => x.s.task.workspace || '')).size,
    };
  }

  /* ---------------- 本地桥接状态 ---------------- */
  function ensureBridgeStatus(force = false) {
    if (!force && bridgeStatusPromise) return bridgeStatusPromise;
    bridgeStatusPromise = Promise.resolve(BRIDGE.status()).then(st => {
      bridgeState = st || { ok: false, bridge: 'offline', reason: '桥接状态未知' };
      renderBridgeStatus();
      return bridgeState;
    }).catch(e => {
      bridgeState = { ok: false, bridge: 'offline', reason: e.message || '桥接状态未知' };
      renderBridgeStatus();
      return bridgeState;
    });
    return bridgeStatusPromise;
  }

  function renderBridgeStatus() {
    const el = $('#bridge-status');
    if (!el) return;
    const online = !!(bridgeState && bridgeState.ok && bridgeState.bridge === 'online');
    const m = (bridgeState && bridgeState.multica) || {};
    el.className = 'bridge-state ' + (online ? (m.online ? 'online' : 'warn') : 'offline');
    el.innerHTML = `<span class="bs-dot"></span><span class="bs-text">${online ? (m.online ? 'Multica 在线' : 'Multica 未响应') : (bridgeState?.fileMode ? '桥接未启用' : '桥接离线')}</span>`;
    el.title = online
      ? `${m.appUrl || 'Multica'} · workspace ${m.workspaceId || 'default'}${m.cli ? ' · ' + m.cli : ''}`
      : (bridgeState?.reason || '本地桥接未启动');
    const crumbTag = $('#bridge-crumb');
    if (crumbTag) {
      crumbTag.textContent = online ? (m.online ? '⇄ 桥接在线' : '⇄ Multica 未响应') : '⇄ 桥接离线';
      crumbTag.className = 'crumb bridge-crumb ' + (online ? (m.online ? 'online' : 'warn') : 'offline');
      crumbTag.title = el.title;
    }
  }

  /* ---------------- 侧栏 ---------------- */
  function renderOverview(active) {
    if (!overviewNav) return;
    const tasks = allTasks();
    const running = tasks.filter(t => summarize(t).status === 'running').length;
    overviewNav.innerHTML = `
      <button class="agent-nav-item overview-item ${active === 'all' ? 'active' : ''}" type="button" data-all="1" title="${running} 个运行中 / 共 ${tasks.length} 个任务">
        <span class="an-dot overview-dot">▦</span>
        <span class="an-body"><span class="an-name">全部任务</span><span class="an-vendor">All agents</span></span>
        <span class="an-badge" title="${running} 个运行中 / 共 ${tasks.length} 个任务">${tasks.length}</span>
      </button>
      <button class="agent-nav-item overview-item ${active === 'board' ? 'active' : ''}" type="button" data-board="1" title="全部任务看板 · ${tasks.length} 个任务">
        <span class="an-dot overview-dot">▥</span>
        <span class="an-body"><span class="an-name">任务看板</span><span class="an-vendor">Board</span></span>
        <span class="an-badge">${tasks.length}</span>
      </button>`;
    const allBtn = overviewNav.querySelector('[data-all]');
    if (allBtn) allBtn.addEventListener('click', () => { location.hash = '#/all'; });
    const boardBtn = overviewNav.querySelector('[data-board]');
    if (boardBtn) boardBtn.addEventListener('click', () => { location.hash = '#/board'; });
  }

  function renderNav(active) {
    const list = agents();
    nav.innerHTML = list.map(a => {
      const ts = tasksOf(a.id);
      const running = ts.filter(t => summarize(t).status === 'running').length;
      return `<button class="agent-nav-item ${a.id === active ? 'active' : ''}" type="button" data-agent="${esc(a.id)}" title="${esc(a.desc || '')}">
        <span class="an-dot" style="--c:${a.accent || '#9aa4bf'}"></span>
        <span class="an-body"><span class="an-name">${esc(a.name)}</span><span class="an-vendor">${esc(a.vendor || '')}</span></span>
        <span class="an-badge${running ? ' has-run' : ''}" title="${running} 个运行中 / 共 ${ts.length} 个任务">${ts.length}</span>
      </button>`;
    }).join('');
    nav.querySelectorAll('[data-agent]').forEach(btn => {
      btn.addEventListener('click', () => { location.hash = '#/agent/' + btn.dataset.agent; });
    });
    renderOverview(active);
  }

  /* ---------------- 顶栏 ---------------- */
  function renderTopbar(mode, agent, task) {
    const bridgeTag = `<span class="crumb bridge-crumb ${bridgeState && bridgeState.ok && bridgeState.bridge === 'online' ? (bridgeState.multica?.online ? 'online' : 'warn') : 'offline'}" id="bridge-crumb" title="Multica 桥接状态">⇄ 桥接检测中</span>`;
    const modeTag = DS.mode === 'real'
      ? '<span class="mode-tag real" title="来自本机各 Agent 会话存储，只读">真实数据 · 只读</span>'
      : '<span class="mode-tag demo" title="打包的演示数据；通过服务端打开可切换真实数据">演示数据</span>';
    const left = mode === 'detail'
      ? `<span class="crumb"><b>Agent Runner</b><span class="crumb-sep">/</span><a href="#/agent/${esc(task.agent)}">${esc(agent ? agent.name : task.agent)}</a><span class="crumb-sep">/</span><span class="current">${esc(task.title)}</span></span>`
      : mode === 'all'
        ? `<span class="crumb"><b>Agent Runner</b><span class="crumb-sep">/</span><span class="current">全部任务</span></span>`
        : mode === 'board'
          ? `<span class="crumb"><b>Agent Runner</b><span class="crumb-sep">/</span><span class="current">任务看板</span></span>`
          : `<span class="crumb"><b>Agent Runner</b><span class="crumb-sep">/</span><span class="current">${esc(agent ? agent.name : '')}</span></span>`;
    crumb.innerHTML = left;
    topStats.innerHTML = `${bridgeTag}${modeTag}${versionChip()}<span class="crumb" title="数据快照时间">${esc((DS.generatedAt || '').slice(0, 10))}</span><button class="btn btn-ghost" type="button" data-load>＋ 载入日志</button>${versionPopover()}`;
    if (bridgeState) renderBridgeStatus();
  }

  const VERSION = window.OBS_VERSION || null;

  function versionChip() {
    if (!VERSION) return '';
    return `<button class="btn ver-chip" type="button" id="ver-chip" data-version="${esc(VERSION.version)}"
      aria-haspopup="dialog" aria-expanded="false" aria-controls="ver-pop"
      title="v${esc(VERSION.version)} · ${esc(VERSION.released)} · ${esc(VERSION.headline)}">v${esc(VERSION.version)}</button>`;
  }

  function versionPopover() {
    if (!VERSION) return '';
    const cur = VERSION.releases[0];
    const history = VERSION.releases.slice(1).map(r =>
      `<li class="vp-old"><span class="vp-v">v${esc(r.version)}</span><span class="vp-date">${esc(r.released)}</span><span class="vp-h">${esc(r.headline)}</span></li>`).join('');
    return `<div class="ver-pop" id="ver-pop" role="dialog" aria-label="版本信息" hidden>
      <header class="vp-head"><span class="vp-title">Agent Runner</span><span class="vp-vp">v${esc(cur.version)}</span><span class="vp-date">${esc(cur.released)}</span></header>
      <div class="vp-hl">${esc(cur.headline)}</div>
      <ul class="vp-notes">${cur.notes.map(n => `<li>${esc(n)}</li>`).join('')}</ul>
      <div class="vp-sub">历史版本</div>
      <ul class="vp-history">${history}</ul>
      <div class="vp-foot">版本单一事实源：<code>assets/version.js</code>，发版说明同步 <code>CHANGELOG.md</code>。</div>
    </div>`;
  }

  function statusBadge(status) {
    const [label, cls] = STATUS[status] || STATUS.running;
    return `<span class="badge ${cls}">${label}</span>`;
  }

  function miniBar(counts) {
    const total = counts.pass + counts.fail + counts.pending;
    if (!total) return '<div class="mini-bar"><span class="mini-seg" style="flex:1" title="暂无产物"></span></div>';
    const seg = (n, cls, name) => n > 0 ? `<span class="mini-seg ${cls}" style="flex:${n}" title="${name} ${n} 个"></span>` : '';
    return `<div class="mini-bar">${seg(counts.pass, 'ok', '通过')}${seg(counts.fail, 'fail', '未通过')}${seg(counts.pending, 'pend', '待验证')}</div>`;
  }

  /* ---------------- 工作区 / 行 ---------------- */
  function workspaceOptions(sums) {
    const map = new Map();
    for (const { s } of sums) {
      const key = s.task.workspace || '';
      if (!map.has(key)) {
        const label = s.task.workspaceLabel || (key ? key.split('/').filter(Boolean).pop() : '默认工作区');
        map.set(key, { key, label, count: 0 });
      }
      map.get(key).count++;
    }
    return [...map.values()].sort((a, b) => {
      if (!a.key !== !b.key) return a.key ? 1 : -1;
      return b.count - a.count || a.label.localeCompare(b.label);
    });
  }

  function wsLabelOf(task) {
    if (task.workspaceLabel) return task.workspaceLabel;
    if (task.workspace) return task.workspace.split('/').filter(Boolean).pop() || task.workspace;
    if (task.repo && task.workspace === undefined) return task.repo;
    return '默认工作区';
  }

  function taskRow(t, s, opts = {}) {
    const link = STORE.linkFor(t.id);
    const subs = STORE.subtasksFor(t.id).length;
    const agent = opts.showAgent ? agentOf(t.agent) : null;
    const collabBits = [
      link ? `<span class="tr-link" title="已关联 Multica ${esc(link.issue.identifier)}">⇄ ${esc(link.issue.identifier)}</span>` : '',
      subs ? `<span class="tr-link" title="${subs} 个子任务">☑ ${subs}</span>` : '',
    ].filter(Boolean).join(' ');
    const ws = wsLabelOf(t);
    const resource = s.costUnit === 'credits'
      ? (s.credits ? fmtCreditShort(s.credits) : '—')
      : fmtCost(s.cost);
    return `<button class="task-row" type="button" data-task="${esc(t.id)}">
      <div class="tr-main">
        <span class="tr-title">${opts.showAgent ? `<span class="tr-agent-dot" style="--c:${esc((agent && agent.accent) || '#9aa4bf')}"></span>` : ''}${esc(t.title)}</span>
        <span class="tr-meta">${opts.showAgent ? `<span class="tr-agent-name">${esc(agent ? agent.name : t.agent)}</span> · ` : ''}<span class="tr-ws${t.workspace ? '' : ' tr-ws-default'}">${esc(ws)}</span> · ${esc(t.model)} · 更新 ${fmtStamp(s.updatedAt)}${collabBits ? ' · ' + collabBits : ''}</span>
      </div>
      <div class="tr-status">${statusBadge(s.status)}</div>
      <div class="tr-results" title="结果：${s.counts.pass} 通过 / ${s.counts.fail} 未通过 / ${s.counts.pending} 待验证">${miniBar(s.counts)}</div>
      <div class="tr-nums">
        <div><span class="tr-num-v">${s.agentCount}</span><span class="tr-num-k">agents</span></div>
        <div><span class="tr-num-v">${fmtTok(s.tokens)}</span><span class="tr-num-k">tok</span></div>
        <div><span class="tr-num-v" title="${esc(resourceText(s))}">${resource}</span><span class="tr-num-k">${s.costUnit === 'credits' ? 'credits' : 'cost'}</span></div>
      </div>
      <div class="tr-arrow">›</div>
    </button>`;
  }

  function filtered(sums) {
    let rows = sums;
    if (state.mode === 'all' && state.allAgent !== 'all') rows = rows.filter(({ s }) => s.task.agent === state.allAgent);
    if (state.workspace !== 'all') rows = rows.filter(({ s }) => (s.task.workspace || '') === state.workspace);
    return rows.filter(({ s }) => {
      if (state.status === 'failed') {
        if (s.status !== 'failed' && s.status !== 'canceled') return false;
      } else if (state.status !== 'all' && s.status !== state.status) return false;
      if (!state.q) return true;
      const agent = agentOf(s.task.agent);
      const hay = [s.task.title, s.task.repo, s.task.workspaceLabel, s.task.workspace, s.task.id, s.task.model, agent ? agent.name : ''].join(' ').toLowerCase();
      return hay.includes(state.q);
    }).sort(sortVal[state.sort] || sortVal.updated);
  }

  function groupOf(rows) {
    const map = new Map();
    for (const row of rows) {
      const key = row.s.task.workspace || '';
      if (!map.has(key)) map.set(key, { key, label: wsLabelOf(row.s.task), path: row.s.task.workspace || '', rows: [] });
      map.get(key).rows.push(row);
    }
    return [...map.values()].sort((a, b) => {
      if (!a.key !== !b.key) return a.key ? 1 : -1;
      return b.rows.length - a.rows.length || a.label.localeCompare(b.label);
    });
  }

  function rowsHtml(rows, opts) {
    return rows.map(({ s }) => taskRow(s.task, s, opts)).join('');
  }

  function groupHtml(group, opts) {
    const key = group.key || '__default__';
    const closed = state.collapsed.has(key);
    const running = group.rows.filter(x => x.s.status === 'running').length;
    return `<section class="ws-group ${closed ? 'closed' : ''}" data-ws-group="${esc(key)}">
      <button class="ws-head" type="button" data-ws-toggle="${esc(key)}" aria-expanded="${!closed}">
        <span class="ws-chev">▾</span>
        <span class="ws-name">${esc(group.label)}</span>
        ${group.path ? `<span class="ws-path">${esc(group.path)}</span>` : '<span class="ws-path">无工作区字段</span>'}
        ${running ? `<span class="ws-running">${running} 运行中</span>` : ''}
        <span class="ws-count">${group.rows.length}</span>
      </button>
      <div class="ws-body">${rowsHtml(group.rows, opts)}</div>
    </section>`;
  }

  function fillRows(host, sums, opts = {}) {
    const rows = filtered(sums);
    const hasWs = rows.some(({ s }) => s.task.workspaceLabel || s.task.workspace);
    if (!rows.length) {
      host.className = 'task-list';
      host.innerHTML = '<div class="empty-state"><b>没有匹配的任务</b><span>换个状态、工作区、Agent 或关键词试试</span></div>';
      return;
    }
    if (hasWs && state.group) {
      host.className = 'task-list task-groups';
      host.innerHTML = groupOf(rows).map(g => groupHtml(g, opts)).join('');
    } else {
      host.className = 'task-list';
      host.innerHTML = rowsHtml(rows, opts);
    }
    host.querySelectorAll('[data-task]').forEach(btn => {
      btn.addEventListener('click', () => { location.hash = '#/task/' + btn.dataset.task; });
    });
    host.querySelectorAll('[data-ws-toggle]').forEach(btn => {
      btn.addEventListener('click', () => {
        const key = btn.dataset.wsToggle;
        const group = btn.closest('.ws-group');
        const closed = group.classList.toggle('closed');
        btn.setAttribute('aria-expanded', String(!closed));
        if (closed) state.collapsed.add(key); else state.collapsed.delete(key);
      });
    });
  }

  /* ---------------- 列表（单 Agent / 全部） ---------------- */
  function renderCollection(mode, agentId) {
    cleanupDetail();
    state.mode = mode;
    state.group = groupPref[mode] !== false;
    const allAgents = agents();
    const agent = mode === 'agent' ? (allAgents.find(a => a.id === agentId) || allAgents[0]) : null;
    if (mode === 'agent' && !agent) {
      view.innerHTML = '<div class="page"><div class="empty-state"><b>没有可用的 Agent 数据</b></div></div>';
      return;
    }
    if (mode === 'agent') {
      if (agent.id !== agentId) history.replaceState(null, '', '#/agent/' + encodeURIComponent(agent.id));
      if (state.agent !== agent.id) { state.agent = agent.id; state.status = 'all'; state.q = ''; state.workspace = 'all'; }
      lastList = '#/agent/' + agent.id;
    } else {
      lastList = '#/all';
      if (location.hash !== '#/all') history.replaceState(null, '', '#/all');
    }
    document.title = (mode === 'all' ? '全部任务' : agent.name) + ' · Agent Runner';
    renderNav(mode === 'all' ? 'all' : agent.id);
    renderTopbar(mode === 'all' ? 'all' : 'list', agent);

    const baseSums = (mode === 'all' ? allTasks() : tasksOf(agent.id)).map(t => ({ t, s: summarize(t) }));
    const scoped = mode === 'all' && state.allAgent !== 'all'
      ? baseSums.filter(x => x.s.task.agent === state.allAgent)
      : baseSums;
    const stats = computeStats(scoped);
    const wsOptions = workspaceOptions(scoped);
    if (state.workspace !== 'all' && !wsOptions.some(w => w.key === state.workspace)) state.workspace = 'all';
    const title = mode === 'all' ? '全部任务' : agent.name;
    const sub = mode === 'all'
      ? `${allAgents.length} 个 Agent · ${allTasks().length} 个任务 · ${stats.workspaces} 个工作区 · 跨 Agent 汇总`
      : `${agent.desc || ''} · ${agent.vendor || ''} ${agent.model || ''} · ${stats.workspaces} 个工作区`;
    const agentPills = mode === 'all' ? `
      <div class="toolbar all-agents-bar">
        <div class="pills" id="all-agent-pills" aria-label="按 Agent 过滤">
          <button class="pill ${state.allAgent === 'all' ? 'active' : ''}" type="button" data-all-agent="all"><span class="pill-label">全部 Agent</span><span class="pill-count">${baseSums.length}</span></button>
          ${allAgents.map(a => `<button class="pill ${state.allAgent === a.id ? 'active' : ''}" type="button" data-all-agent="${esc(a.id)}"><span class="pill-dot" style="--c:${esc(a.accent || '#9aa4bf')}"></span><span class="pill-label">${esc(a.name)}</span><span class="pill-count">${baseSums.filter(x => x.s.task.agent === a.id).length}</span></button>`).join('')}
        </div>
      </div>` : '';

    const statCards = [
      mode === 'all' ? `<div class="stat"><div class="stat-v">${stats.agents}</div><div class="stat-k">覆盖 Agent</div></div>` : '',
      `<div class="stat"><div class="stat-v">${stats.total}</div><div class="stat-k">任务</div></div>`,
      `<div class="stat"><div class="stat-v" style="color:var(--cyan)">${stats.running}</div><div class="stat-k">运行中</div></div>`,
      `<div class="stat"><div class="stat-v" style="color:var(--green)">${stats.completed}</div><div class="stat-k">已完成</div></div>`,
      `<div class="stat"><div class="stat-v" style="color:var(--yellow)">${stats.pending}</div><div class="stat-k">待验证产物</div></div>`,
      `<div class="stat"><div class="stat-v stat-v-sm">${resourceText(stats)}</div><div class="stat-k">${stats.credits ? 'Credits / 成本' : '总成本'}</div></div>`,
    ].join('');

    view.innerHTML = `<div class="page">
      <div class="page-head">
        <div>
          <h1>${esc(title)}</h1>
          <div class="page-sub">${esc(sub)}</div>
        </div>
        <div class="head-stats">${statCards}</div>
      </div>
      ${agentPills}
      <div class="toolbar">
        <div class="pills">
          ${[['all', '全部', stats.total], ['running', '运行中', stats.running], ['completed', '已完成', stats.completed], ['idle', '已停止', stats.idle], ['failed', '失败 / 取消', stats.failed]]
            .map(([k, label, n]) => `<button class="pill ${state.status === k ? 'active' : ''}" type="button" data-status="${k}">${label}<span class="pill-count">${n}</span></button>`).join('')}
        </div>
        <div class="toolbar-right">
          <select class="select" id="task-group" aria-label="任务分组方式">
            <option value="group" ${state.group ? 'selected' : ''}>按工作区分组</option>
            <option value="flat" ${!state.group ? 'selected' : ''}>不分组 · 全局排序</option>
          </select>
          ${wsOptions.length > 1 ? `<select class="select" id="ws-filter" aria-label="按工作区过滤">
            <option value="all" ${state.workspace === 'all' ? 'selected' : ''}>全部工作区（${wsOptions.length}）</option>
            ${wsOptions.map(w => `<option value="${esc(w.key)}" ${state.workspace === w.key ? 'selected' : ''}>${esc(w.label)} · ${w.count}</option>`).join('')}
          </select>` : ''}
          <input class="search" id="task-q" type="search" aria-label="搜索任务、仓库或 ID" placeholder="${mode === 'all' ? '搜索任务 / Agent / 工作区' : '搜索任务 / 工作区 / ID'}" value="${esc(state.q)}">
          <select class="select" id="task-sort" aria-label="排序">
            ${SORT_OPTIONS.map(([v, label]) => `<option value="${v}" ${state.sort === v ? 'selected' : ''}>${label}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="task-list" id="task-list"></div>
      <div class="note">结果条：<span style="color:var(--green)">绿=验证通过</span> · <span style="color:var(--red)">红=未通过</span> · <span style="color:var(--yellow)">黄=待验证</span>。「按工作区分组」把同一 cwd 的任务折叠在一起；切到「不分组」后按所选时间列全局排序。点任意任务进入详情；带 ⇄ 的任务已关联 Multica。</div>
      ${DS.mode === 'real' ? '<div class="note">数据来自本机 Qoder / Codex / WorkBuddy / Trae / Claude Code 的会话存储，只读；工作区按任务真实 cwd 归组，缺失 cwd 的会话进「默认工作区」。</div>' : ''}
      ${stats.results ? `<div class="note">${mode === 'all' ? '全部' : '该 Agent 的'}产物验证：${stats.pass}/${stats.results} 通过。</div>` : ''}
    </div>`;

    const host = $('#task-list');
    fillRows(host, baseSums, { showAgent: mode === 'all' });

    view.querySelectorAll('[data-status]').forEach(p => {
      p.addEventListener('click', () => {
        state.status = p.dataset.status;
        view.querySelectorAll('[data-status]').forEach(x => x.classList.toggle('active', x === p));
        fillRows(host, baseSums, { showAgent: mode === 'all' });
      });
    });
    view.querySelectorAll('[data-all-agent]').forEach(p => {
      p.addEventListener('click', () => {
        state.allAgent = p.dataset.allAgent;
        state.workspace = 'all';
        renderCollection('all');
      });
    });
    const wsFilter = $('#ws-filter');
    if (wsFilter) wsFilter.addEventListener('change', () => {
      state.workspace = wsFilter.value;
      fillRows(host, baseSums, { showAgent: mode === 'all' });
    });
    const groupSel = $('#task-group');
    if (groupSel) groupSel.addEventListener('change', () => {
      state.group = groupSel.value === 'group';
      groupPref[mode] = state.group;
      fillRows(host, baseSums, { showAgent: mode === 'all' });
    });
    const q = $('#task-q');
    q.addEventListener('input', () => { state.q = q.value.trim().toLowerCase(); fillRows(host, baseSums, { showAgent: mode === 'all' }); });
    const sort = $('#task-sort');
    sort.addEventListener('change', () => { state.sort = sort.value; fillRows(host, baseSums, { showAgent: mode === 'all' }); });
  }

  const renderList = agentId => renderCollection('agent', agentId);
  const renderAll = () => renderCollection('all');

  /* ---------------- 任务看板（全局） ---------------- */
  function boardCardOf(t, s) {
    const agent = agentOf(t.agent);
    const link = STORE.linkFor(t.id);
    return {
      id: t.id, title: t.title, status: s.status, agent: t.agent,
      agentName: agent ? agent.name : t.agent, accent: agent ? agent.accent : '#9aa4bf',
      workspaceLabel: wsLabelOf(t), updatedAt: s.updatedAt, counts: s.counts,
      link: link && link.issue ? link.issue.identifier : null,
    };
  }

  function renderBoardPage() {
    cleanupDetail();
    state.mode = 'board';
    lastList = '#/board';
    if (location.hash !== '#/board') history.replaceState(null, '', '#/board');
    document.title = '任务看板 · Agent Runner';
    renderNav('board');
    renderTopbar('board');

    const base = allTasks().map(t => ({ t, s: summarize(t) }));
    const wsOptions = workspaceOptions(base);
    if (state.bWorkspace !== 'all' && !wsOptions.some(w => w.key === state.bWorkspace)) state.bWorkspace = 'all';

    view.innerHTML = `<div class="page board-page">
      <div class="page-head">
        <div>
          <h1>任务看板</h1>
          <div class="page-sub">${allTasks().length} 个任务跨 ${agents().length} 个 Agent · ${wsOptions.length} 个工作区 · 按最近更新时间排序，点卡片进详情</div>
        </div>
        <div class="head-stats" id="board-stats"></div>
      </div>
      <div class="toolbar board-toolbar">
        <div class="pills">
          <button class="pill ${state.bAgent === 'all' ? 'active' : ''}" type="button" data-board-agent="all"><span class="pill-label">全部 Agent</span><span class="pill-count">${base.length}</span></button>
          ${agents().map(a => `<button class="pill ${state.bAgent === a.id ? 'active' : ''}" type="button" data-board-agent="${esc(a.id)}"><span class="pill-dot" style="--c:${esc(a.accent || '#9aa4bf')}"></span><span class="pill-label">${esc(a.name)}</span><span class="pill-count">${base.filter(x => x.t.agent === a.id).length}</span></button>`).join('')}
        </div>
        <div class="toolbar-right">
          <label class="field-inline">每列条数
            <select class="select" id="board-limit" aria-label="每条泳道显示条数">
              ${[10, 25, 50, 'all'].map(v => `<option value="${v}" ${String(state.bLimit) === String(v) ? 'selected' : ''}>${v === 'all' ? '全部' : v + ' 条'}</option>`).join('')}
            </select>
          </label>
          ${wsOptions.length > 1 ? `<select class="select" id="board-ws" aria-label="按工作区过滤">
            <option value="all">全部工作区（${wsOptions.length}）</option>
            ${wsOptions.map(w => `<option value="${esc(w.key)}" ${state.bWorkspace === w.key ? 'selected' : ''}>${esc(w.label)} · ${w.count}</option>`).join('')}
          </select>` : ''}
          <input class="search" id="board-q" type="search" aria-label="搜索看板任务" placeholder="搜索任务 / Agent / 工作区" value="${esc(state.bQ)}">
        </div>
      </div>
      <div id="board-host"></div>
      <div class="note" id="board-note">看板列：待办 / 进行中 / 待确认 / 已完成 / 已停止·取消 / 失败。已完成的任务同样进泳道，点「展开剩余」看完整列表。「待确认」表示任务已完成但仍有产物未验证；取消的任务不混进失败列。真实数据只读，看板不写回原始会话。</div>
    </div>`;

    const paint = () => {
      const rows = base.filter(({ t }) => {
        if (state.bAgent !== 'all' && t.agent !== state.bAgent) return false;
        if (state.bWorkspace !== 'all' && (t.workspace || '') !== state.bWorkspace) return false;
        if (!state.bQ) return true;
        const agent = agentOf(t.agent);
        return [t.title, t.id, t.model, t.workspaceLabel, t.workspace, agent ? agent.name : ''].join(' ').toLowerCase().includes(state.bQ);
      });
      const stats = computeStats(rows);
      const cards = rows.map(({ t, s }) => boardCardOf(t, s));
      $('#board-stats').innerHTML = `
        <div class="stat"><div class="stat-v">${stats.total}</div><div class="stat-k">当前任务</div></div>
        <div class="stat"><div class="stat-v" style="color:var(--cyan)">${stats.running}</div><div class="stat-k">进行中</div></div>
        <div class="stat"><div class="stat-v" style="color:var(--green)">${stats.completed}</div><div class="stat-k">已完成</div></div>
        <div class="stat"><div class="stat-v" style="color:var(--yellow)">${stats.pending}</div><div class="stat-k">待验证产物</div></div>`;
      view.querySelectorAll('[data-board-agent]').forEach(x => x.classList.toggle('active', x.dataset.boardAgent === state.bAgent));
      OBS.renderBoard($('#board-host'), cards, {
        fixed: true, limit: state.bLimit, openLanes: state.bOpen,
        note: cards.length ? '' : '当前筛选下没有任务。',
      });
      const laneTotal = cards.length;
      const noteEl = $('#board-note');
      if (noteEl) {
        const hiddenCount = state.bLimit === 'all' ? 0 : Math.max(0, laneTotal - 6 * Number(state.bLimit));
        noteEl.innerHTML = `看板列：待办 / 进行中 / 待确认 / 已完成 / 已停止·取消 / 失败。已完成的任务同样进泳道，当前每列显示最近 ${state.bLimit === 'all' ? '全部' : state.bLimit + ' 条'}${hiddenCount ? `，另有约 ${hiddenCount} 条折叠在「展开剩余」里` : ''}。「待确认」表示任务已完成但仍有产物未验证；取消的任务不混进失败列。真实数据只读，看板不写回原始会话。`;
      }
    };
    paint();

    view.querySelectorAll('[data-board-agent]').forEach(p => p.addEventListener('click', () => {
      state.bAgent = p.dataset.boardAgent;
      state.bWorkspace = 'all';
      const sel = $('#board-ws');
      if (sel) sel.value = 'all';
      paint();
    }));
    const limitSel = $('#board-limit');
    if (limitSel) limitSel.addEventListener('change', () => {
      state.bLimit = limitSel.value === 'all' ? 'all' : Number(limitSel.value) || 25;
      state.bOpen.clear();
      paint();
    });
    const laneHost = $('#board-host');
    if (laneHost) laneHost.addEventListener('click', e => {
      const more = e.target.closest('[data-lane-more]');
      if (more) { state.bOpen.add(more.dataset.laneMore); paint(); return; }
      const less = e.target.closest('[data-lane-less]');
      if (less) { state.bOpen.delete(less.dataset.laneLess); paint(); }
    });
    const wsSel = $('#board-ws');
    if (wsSel) wsSel.addEventListener('change', () => { state.bWorkspace = wsSel.value; paint(); });
    const q = $('#board-q');
    q.addEventListener('input', () => { state.bQ = q.value.trim().toLowerCase(); paint(); });
  }

  /* ---------------- 详情 ---------------- */
  function cleanupDetail() {
    detailSeq++;
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
    if (live) { live.destroy(); live = null; }
    if (collab) { collab.destroy(); collab = null; }
    delete window.__RUNNER_DETAIL;
  }

  function detailMeta(task, s) {
    const link = STORE.linkFor(task.id);
    const subs = STORE.subtasksFor(task.id);
    const agent = agentOf(task.agent);
    const dur = s.status === 'running' ? `已运行 ${fmtDur(s.durationMs)}（日志跨度）` : `历时 ${fmtDur(s.durationMs)}`;
    return [
      esc(wsLabelOf(task)),
      esc(agent ? agent.name : task.agent),
      esc(task.model),
      `创建 ${fmtStamp(s.createdAt)}`,
      `更新 ${fmtStamp(s.updatedAt)}`,
      dur,
      `${fmtTok(s.tokens)} tok`,
      resourceText(s),
      `产物 ${s.counts.total}（${s.counts.pass} 通过 / ${s.counts.fail} 未通过 / ${s.counts.pending} 待验证）`,
      link ? `⇄ ${esc(link.issue.identifier)}` : '',
      subs.length ? `☑ ${subs.length} 个子任务` : '',
    ].filter(Boolean).join(' · ');
  }

  function panelMeta(task, s) {
    const link = STORE.linkFor(task.id);
    const agent = agentOf(task.agent);
    return {
      cost: s.cost, credits: s.credits, costUnit: s.costUnit, counts: s.counts,
      partial: s.partial || !!task.detailMeta?.partial,
      board: {
        id: task.id, title: task.title, status: s.status, agent: task.agent,
        agentName: agent ? agent.name : task.agent, accent: agent ? agent.accent : '#9aa4bf',
        workspaceLabel: wsLabelOf(task), repo: task.repo, updatedAt: s.updatedAt,
        startedAt: s.startedAt, endedAt: s.endedAt, durationMs: s.durationMs, counts: s.counts,
        link: link && link.issue ? { identifier: link.issue.identifier, status: link.issue.status } : null,
        subtasks: STORE.subtasksFor(task.id).map(st => ({
          id: st.id, title: st.title, status: st.status, owner: st.owner, updatedAt: st.updatedAt,
          issue: st.issue ? st.issue.identifier : null,
        })),
      },
    };
  }

  function refreshDetail(task) {
    cache.delete(task.id);
    const s = summarize(task);
    const panels = $('#panels');
    if (panels) OBS.renderPanels(panels, s.model, panelMeta(task, s));
    if (live) live.setData(task, s);
    const meta = $('.dh-meta');
    if (meta) meta.innerHTML = detailMeta(task, s);
    const badge = $('.dh-top .badge');
    if (badge) badge.outerHTML = statusBadge(s.status);
    return s;
  }

  function taskSwitcherHtml(current) {
    const rank = t => {
      const v = t.updatedAt || t.preview?.updatedAt || t.endedAt || t.startedAt;
      return typeof v === 'number' ? v : (Date.parse(v) || 0);
    };
    const groups = new Map();
    for (const a of agents()) groups.set(a.id, []);
    for (const t of allTasks()) if (groups.has(t.agent)) groups.get(t.agent).push(t);
    return [...groups.entries()].filter(([, list]) => list.length).map(([id, list]) => {
      const agent = agentOf(id);
      const options = list.slice().sort((a, b) => rank(b) - rank(a)).map(t =>
        `<option value="${esc(t.id)}" ${t.id === current.id ? 'selected' : ''}>${esc(clip(t.title, 46))} · ${esc(wsLabelOf(t))} · ${fmtStamp(rank(t))}</option>`
      ).join('');
      return `<optgroup label="${esc(agent ? agent.name : id)}（${list.length}）">${options}</optgroup>`;
    }).join('');
  }

  async function loadTaskDetail(task, force = false) {
    if (!task || !task.real) return;
    if (task.log && !force) return;
    const url = new URL('api/live/task', location.href);
    url.searchParams.set('id', task.id);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    try {
      const res = await fetch(url, { cache: 'no-store', signal: ctrl.signal, headers: { accept: 'application/json' } });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      if (!Array.isArray(body.events)) throw new Error('返回结构不正确');
      task.log = body.events.map(e => JSON.stringify(e)).join('\n');
      task.detailMeta = {
        partial: !!body.partial, lines: body.lines || 0,
        transcript: body.transcript || '', fetchedAt: Date.now(),
      };
      task._detailUpdatedAt = Number(task.updatedAt) || 0;
      cache.delete(task.id);
      rememberLoaded(task);
      return body;
    } finally {
      clearTimeout(timer);
    }
  }

  function rememberLoaded(task) {
    if (!task || !task.real) return;
    const idx = loadedLogs.indexOf(task.id);
    if (idx >= 0) loadedLogs.splice(idx, 1);
    loadedLogs.push(task.id);
    while (loadedLogs.length > 4) {
      const old = loadedLogs.shift();
      if (window.__RUNNER_DETAIL && window.__RUNNER_DETAIL.task.id === old) continue;
      const t = allTasks().find(x => x.id === old);
      if (t) { delete t.log; cache.delete(t.id); }
    }
  }

  function startPolling(task) {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      if (!collab || !STORE.linkFor(task.id)) return;
      if (!bridgeState || !bridgeState.ok || bridgeState.bridge !== 'online') return;
      collab.syncNow(true);
    }, 30_000);
  }

  function mountSidePanels(task, s, seq) {
    if (seq !== detailSeq) return;
    ensureBridgeStatus();
    collab = window.RunnerCollab ? window.RunnerCollab.mount($('#collab-host'), {
      task, summary: s, store: STORE, bridge: BRIDGE, bridgeState, bridgeStatusPromise,
      toast, afterChange: () => refreshDetail(task),
    }) : null;
    if (window.RunnerLive) {
      live = window.RunnerLive.mount($('#live-host'), { speed: Number(window.__RUNNER_LIVE_SPEED) || 500 });
      live.setData(task, s);
    } else {
      const host = $('#live-host');
      if (host) host.innerHTML = '';
    }
    startPolling(task);
    window.__RUNNER_DETAIL = { task, get summary() { return summarize(task); }, sync: () => collab && collab.syncNow(true), refreshing: false };
  }

  function renderDetail(taskId) {
    cleanupDetail();
    const seq = detailSeq;
    const task = allTasks().find(t => t.id === taskId);
    if (!task) {
      const fallback = agents()[0];
      renderNav(fallback ? fallback.id : '');
      renderTopbar('list', fallback);
      view.innerHTML = `<div class="page"><div class="empty-state"><b>找不到任务 ${esc(taskId)}</b><span>它可能不在当前数据快照里</span></div>
        <div><button class="back" id="back-btn" type="button">← 返回 ${esc(fallback ? fallback.name : '任务列表')}</button></div></div>`;
      const b = $('#back-btn');
      if (b) b.addEventListener('click', () => { location.hash = '#/agent/' + (fallback ? fallback.id : ''); });
      return;
    }
    const agent = agentOf(task.agent);
    if (state.agent !== task.agent) { state.agent = task.agent; state.status = 'all'; state.q = ''; state.workspace = 'all'; }
    document.title = task.title + ' · Agent Runner';
    renderNav(task.agent);
    renderTopbar('detail', agent, task);

    const s0 = summarize(task);
    const siblings = tasksOf(task.agent).map(t => ({ t, s: summarize(t) }))
      .sort((a, b) => (b.s.updatedAt || 0) - (a.s.updatedAt || 0)).map(x => x.t);
    const sibIdx = siblings.findIndex(t => t.id === task.id);
    const prevTask = sibIdx > 0 ? siblings[sibIdx - 1] : null;
    const nextTask = sibIdx >= 0 && sibIdx < siblings.length - 1 ? siblings[sibIdx + 1] : null;
    const backTarget = lastList === '#/all' || lastList === '#/board' ? lastList : '#/agent/' + task.agent;
    const backLabel = backTarget === '#/all' ? '全部任务' : backTarget === '#/board' ? '任务看板' : (agent ? agent.name : task.agent);
    view.innerHTML = `<div class="page">
      <div class="detail-head">
        <div class="dh-top">
          <button class="back" id="back-btn" type="button">← ${esc(backLabel)}</button>
          <h1 class="dh-title" title="${esc(task.title)}">${esc(task.title)}</h1>
          <span class="dh-marks">${statusBadge(s0.status)}<span class="dh-id">${esc(task.id)}</span></span>
        </div>
        <div class="dh-subline">
          <div class="dh-meta">${detailMeta(task, s0)}</div>
          <div class="dh-switch">
            <span>切换任务</span>
            <button class="dh-step" id="task-prev" type="button" title="同 Agent 较新的任务" ${prevTask ? '' : 'disabled'}>‹</button>
            <select class="select" id="task-switch" aria-label="切换到其他任务">${taskSwitcherHtml(task)}</select>
            <button class="dh-step" id="task-next" type="button" title="同 Agent 较旧的任务" ${nextTask ? '' : 'disabled'}>›</button>
          </div>
        </div>
      </div>
      <div id="panels"></div>
      <div id="collab-host"></div>
      <div id="live-host"></div>
    </div>`;
    $('#back-btn').addEventListener('click', () => { location.hash = backTarget; });
    const sw = $('#task-switch');
    if (sw) sw.addEventListener('change', () => { location.hash = '#/task/' + sw.value; });
    const prevBtn = $('#task-prev'), nextBtn = $('#task-next');
    if (prevBtn && prevTask) prevBtn.addEventListener('click', () => { location.hash = '#/task/' + prevTask.id; });
    if (nextBtn && nextTask) nextBtn.addEventListener('click', () => { location.hash = '#/task/' + nextTask.id; });

    const boot = async () => {
      if (task.real && !task.log) {
        $('#panels').innerHTML = '<div class="panel full loading-panel"><span class="spinner" aria-hidden="true"></span><b>正在读取真实会话日志…</b><span>' + esc(wsLabelOf(task)) + ' · ' + esc(task.title) + '</span></div>';
        try {
          await loadTaskDetail(task);
        } catch (e) {
          if (seq !== detailSeq) return;
          toast('读取会话日志失败：' + (e.message || '未知错误'), 'err');
        }
      }
      if (seq !== detailSeq) return;
      const s = refreshDetail(task);
      mountSidePanels(task, s, seq);
    };
    boot();
  }

  /* ---------------- 导入 ---------------- */
  async function addLogs(files) {
    const list = Array.from(files || []).filter(Boolean);
    if (!list.length) return;
    let lastId = null, ok = 0;
    for (const f of list) {
      const text = await f.text();
      const ev = OBS.parseJSONL(text);
      if (!ev.length) { toast(`无法解析 ${f.name}：没有有效 JSONL 事件`, 'err'); continue; }
      if (!local.agents.length) {
        local.agents.push({ id: 'local', name: 'local', vendor: '本地载入', model: '—', accent: '#9aa4bf', desc: '从 .jsonl 文件载入的会话' });
      }
      const id = 'local-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
      const task = {
        id, agent: 'local', title: f.name.replace(/\.(jsonl|log|txt)$/i, ''), repo: '本地文件',
        status: 'running', model: '—', startedAt: ev[0].ts, cost: 0, tokens: 0, log: text,
      };
      local.tasks.push(task);
      const s = OBS.summarize(task);
      task.status = s.status; task.cost = s.cost; task.tokens = s.tokens;
      cache.clear();
      lastId = id; ok++;
    }
    renderNav(state.mode === 'all' ? 'all' : state.agent);
    if (lastId) {
      toast(`已载入 ${ok} 份日志`, 'ok');
      location.hash = '#/task/' + lastId;
    } else {
      toast('没有载入任何日志', 'err');
    }
  }

  /* ---------------- 实时数据 ---------------- */
  /* 保留已有 task 对象引用，避免详情页与协作面板拿到过期对象。 */
  function applyLiveDataset(next) {
    if (!next || !Array.isArray(next.tasks) || !Array.isArray(next.agents)) return false;
    const prev = new Map(DS.tasks.map(t => [t.id, t]));
    DS.agents = next.agents.map(a => ({ ...a }));
    DS.tasks = next.tasks.map(t => {
      const cur = prev.get(t.id);
      if (!cur) return t;
      Object.assign(cur, t);
      return cur;
    });
    DS.generatedAt = next.generatedAt || DS.generatedAt;
    DS.mode = next.mode || DS.mode;
    cache.clear();
    const snap = $('.side-note b');
    if (snap && DS.generatedAt) snap.textContent = DS.generatedAt.slice(0, 10);
    paintMode();

    const detail = window.__RUNNER_DETAIL;
    if (detail && detail.task) {
      const task = allTasks().find(t => t.id === detail.task.id);
      if (!task) { renderList(state.agent); return true; }
      renderNav(task.agent);
      if (task.real && Number(task.updatedAt) !== Number(task._detailUpdatedAt || 0)) {
        if (detailFetching) { detail.pending = true; return true; }
        detailFetching = true;
        loadTaskDetail(task, true).then(() => {
          if (window.__RUNNER_DETAIL && window.__RUNNER_DETAIL.task.id === task.id) refreshDetail(task);
        }).catch(() => {}).finally(() => {
          detailFetching = false;
          if (detail.pending) { detail.pending = false; applyLiveDataset(next); }
        });
        return true;
      }
      refreshDetail(task);
      return true;
    }
    if (state.mode === 'board') renderBoardPage();
    else if (state.mode === 'all') renderAll();
    else renderList(state.agent);
    return true;
  }
  window.__RUNNER_LIVE_APPLY = applyLiveDataset;

  /* ---------------- 路由 ---------------- */
  function route() {
    if (location.hash === '#/all') { renderAll(); return; }
    if (location.hash === '#/board') { renderBoardPage(); return; }
    const m = location.hash.match(/^#\/(agent|task)\/(.+)$/);
    if (!m) {
      const fallback = agents()[0] ? agents()[0].id : 'qoder-cn';
      const target = '#/agent/' + fallback;
      if (location.hash === target) renderList(fallback);
      else location.hash = target;
      return;
    }
    let id = m[2];
    try { id = decodeURIComponent(id); } catch (e) { /* 保留原串 */ }
    if (m[1] === 'task') renderDetail(id);
    else renderList(id);
  }

  document.addEventListener('click', e => {
    const pop = document.getElementById('ver-pop');
    const chip = e.target.closest('#ver-chip');
    if (chip && pop) {
      const willOpen = pop.hasAttribute('hidden');
      pop.toggleAttribute('hidden', !willOpen);
      chip.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
    } else if (pop && !pop.hasAttribute('hidden') && !e.target.closest('#ver-pop')) {
      pop.setAttribute('hidden', '');
      const c = document.getElementById('ver-chip');
      if (c) c.setAttribute('aria-expanded', 'false');
    }
    const btn = e.target.closest('[data-load]');
    if (btn) { const f = $('#file'); if (f) f.click(); }
    const boardCard = e.target.closest('[data-board-task]');
    if (boardCard) { location.hash = '#/task/' + boardCard.dataset.boardTask; }
    const bridgeBtn = e.target.closest('#bridge-status');
    if (bridgeBtn) {
      if (bridgeState && bridgeState.ok && bridgeState.bridge === 'online') {
        toast(`Multica ${bridgeState.multica?.online ? '在线' : '未响应'} · ${bridgeState.multica?.serverUrl || ''}`, bridgeState.multica?.online ? 'ok' : 'err');
      } else {
        toast(bridgeState?.reason || '本地桥接未启动；运行 node scripts/serve.mjs', 'err');
      }
    }
  });
  const file = $('#file');
  if (file) file.addEventListener('change', () => { addLogs(file.files); file.value = ''; });
  const drop = $('#drop');
  let dragDepth = 0;
  window.addEventListener('dragenter', e => { e.preventDefault(); dragDepth++; if (drop) drop.style.display = 'flex'; });
  window.addEventListener('dragover', e => { e.preventDefault(); });
  window.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth && drop) drop.style.display = 'none'; });
  window.addEventListener('drop', e => {
    e.preventDefault(); dragDepth = 0;
    if (drop) drop.style.display = 'none';
    if (e.dataTransfer && e.dataTransfer.files.length) addLogs(e.dataTransfer.files);
  });
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    const pop = document.getElementById('ver-pop');
    if (pop && !pop.hasAttribute('hidden')) {
      pop.setAttribute('hidden', '');
      const c = document.getElementById('ver-chip');
      if (c) { c.setAttribute('aria-expanded', 'false'); c.focus(); }
    }
  });
  window.addEventListener('hashchange', route);
  const snap = $('.side-note b');
  if (snap && DS.generatedAt) snap.textContent = DS.generatedAt.slice(0, 10);
  paintMode();
  ensureBridgeStatus();
  route();
})();
