/* Agent Runner · 日志派生与详情面板渲染（无外部依赖） */
(function () {
  'use strict';

  const COLORS = {
    main: '#c792ea', router: '#4dd0e1', advisor: '#ffb86c',
    worker: '#a3e635', explorer: '#60a5fa', researcher: '#f472b6',
    tester: '#34d399', reviewer: '#facc15', local: '#9aa4bf',
  };
  const ROLE_ORDER = ['main', 'router', 'advisor'];
  /* 独立任务看板的六列。列由会话状态与产物验证结论推导，不照搬任何插件运行时。 */
  const BOARD_COLUMNS = [
    { id: 'todo', label: '待办', color: '#6b768f' },
    { id: 'running', label: '进行中', color: '#4dd0e1' },
    { id: 'review', label: '待确认', color: '#facc15' },
    { id: 'done', label: '已完成', color: '#4ade80' },
    { id: 'idle', label: '已停止 / 取消', color: '#9aa4bf' },
    { id: 'failed', label: '失败', color: '#f87171' },
  ];
  const boardBucketOf = card => {
    const s = String(card.status || '').toLowerCase();
    const pending = Number(card.counts?.pending ?? card.pending ?? 0);
    if (['completed', 'done', 'shipped', 'succeeded'].includes(s)) return pending > 0 ? 'review' : 'done';
    if (['failed'].includes(s)) return 'failed';
    if (['canceled', 'cancelled', 'idle', 'archived', 'stopped', 'paused', 'blocked'].includes(s)) return 'idle';
    if (['todo', 'backlog', 'pending'].includes(s)) return 'todo';
    if (s === 'in_review') return 'review';
    return 'running';
  };
  const clip = (s, n) => {
    const chars = Array.from(String(s || ''));
    return chars.length > n ? chars.slice(0, n - 1).join('') + '…' : chars.join('');
  };
  const STATUS_LABEL = {
    shipped: 'SHIPPED', done: 'DONE', completed: 'DONE', running: 'RUNNING',
    working: 'WORKING', idle: 'IDLE', canceled: 'CANCELED', cancelled: 'CANCELED', failed: 'FAILED', todo: 'TODO',
  };
  const STATUS_CN = { completed: '已完成', running: '进行中', idle: '已停止', canceled: '已取消', failed: '失败', todo: '待办', done: '已完成' };

  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const tsMs = e => Date.parse(e.ts);
  const hhmmss = ms => new Date(ms).toLocaleTimeString('zh-CN', { hour12: false });
  const fmtTok = n => !n ? '—' : n >= 1e9 ? (n / 1e9).toFixed(1) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n);
  const fmtCost = n => '$' + (Number(n) || 0).toFixed(4);
  const fmtCredits = n => (Number(n) || 0).toLocaleString('zh-CN', { maximumFractionDigits: 2 }) + ' credits';
  const fmtAmount = (n, unit) => unit === 'credits' ? fmtCredits(n) : fmtCost(n);
  const fmtDur = ms => {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return s + 's';
    const m = Math.floor(s / 60);
    if (m < 60) return m + 'm ' + String(s % 60).padStart(2, '0') + 's';
    const h = Math.floor(m / 60);
    if (h < 24) return h + 'h ' + String(m % 60).padStart(2, '0') + 'm';
    return Math.floor(h / 24) + 'd ' + (h % 24) + 'h';
  };
  const fmtStamp = ms => {
    if (!Number.isFinite(ms)) return '—';
    const d = new Date(ms), p = n => String(n).padStart(2, '0');
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  const colorOf = id => COLORS[id] || '#9aa4bf';

  function parseJSONL(text) {
    return String(text || '').split('\n').map(l => l.trim()).filter(l => l.startsWith('{'))
      .map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
  }

  function parseObject(v) {
    if (v && typeof v === 'object') return v;
    if (typeof v !== 'string') return {};
    const s = v.trim();
    if (!s || (s[0] !== '{' && s[0] !== '[')) return {};
    try { const out = JSON.parse(s); return out && typeof out === 'object' ? out : {}; } catch { return {}; }
  }

  function brief(v, n = 160) {
    if (v == null) return '';
    const text = typeof v === 'string' ? v : JSON.stringify(v);
    return clip(String(text).replace(/\s+/g, ' ').trim(), n);
  }

  function safeLink(raw) {
    try {
      const u = new URL(String(raw));
      return ['http:', 'https:'].includes(u.protocol) ? u.origin + u.pathname : '';
    } catch { return ''; }
  }

  function baseName(p) {
    const clean = String(p || '').replace(/[?#].*$/, '');
    const m = clean.match(/([^/\\]+)$/);
    return m ? m[1] : clean;
  }

  function hostOf(url) {
    try { return new URL(url).host; } catch { return ''; }
  }

  /* 从事件流里归纳「运行痕迹」。只认日志里真实出现的工具与调用，不按提示词猜。 */
  function collectTrace(events) {
    const skills = new Map(), mcp = new Map(), web = new Map(), sources = new Map();
    const results = new Map();
    for (const e of events) {
      if (e.type === 'tool_result' && e.data?.callId) results.set(e.data.callId, e.data);
    }
    const add = (map, key, patch) => {
      const row = map.get(key) || { count: 0 };
      row.count++;
      Object.assign(row, patch);
      map.set(key, row);
    };
    const addSource = (key, row) => add(sources, key, row);

    for (const e of events) {
      const d = e.data || {};
      if (e.type === 'attachment') {
        addSource(`att:${d.host || ''}:${d.name || ''}`, {
          name: d.name || '附件', host: d.host || '', kind: d.kind || '附件', source: '用户附件',
        });
        continue;
      }
      if (e.type === 'user_message') {
        const text = String(d.text || '');
        const md = /!\[([^\]]*)\]\(([^)\s]+)\)/g;
        let m;
        while ((m = md.exec(text))) {
          const link = safeLink(m[2]);
          const name = m[1] || baseName(link || m[2]);
          if (name) addSource(`md:${link || name}`, { name, host: link ? hostOf(link) : '本地文件', kind: '图片', source: '用户消息' });
        }
        const pathRe = /(?:^|[\s("'`])((?:\/|~\/)[^\s"'`)]+\.(?:png|jpe?g|gif|webp|svg|pdf|heic|bmp))/gi;
        while ((m = pathRe.exec(text))) {
          const name = baseName(m[1]);
          if (name) addSource(`path:${name}`, { name, host: '本地文件', kind: '文件', source: '用户消息' });
        }
        const cmd = /<command-name>\/?([\w:.-]+)<\/command-name>/g;
        while ((m = cmd.exec(text))) add(skills, `cmd:${m[1]}`, { name: m[1], kind: '技能', source: '命令调用' });
        continue;
      }
      if (e.type !== 'tool_call') continue;
      const tool = String(d.tool || '');
      const input = parseObject(d.input);
      const nestedName = String(input.toolName || input.tool_name || '');
      const nestedArgs = parseObject(input.arguments ?? input.args);
      const callName = nestedName || tool;
      const args = nestedName ? nestedArgs : input;
      const resultText = results.has(d.callId) ? brief(results.get(d.callId).summary, 140) : '';
      const argText = brief(d.args || '', 200);

      const skillName = String(input.skill || args.skill || (/^skill$/i.test(tool) ? argText : '')).trim();
      if (/^skill$/i.test(tool) || /^skill$/i.test(nestedName) || /(?:^|__)skill$/i.test(nestedName)) {
        if (skillName) add(skills, `skill:${skillName}`, {
          name: skillName, kind: '技能', source: /^skill$/i.test(tool) ? 'Skill 工具' : callName,
          detail: brief(args.args || input.args || '', 100),
        });
      }

      if (/^mcp__/.test(callName) || /^mcp__/.test(tool)) {
        const full = /^mcp__/.test(callName) ? callName : tool;
        const parts = full.split('__');
        add(mcp, `mcp:${full}`, {
          name: full, server: parts[1] || '', tool: parts.slice(2).join('__') || full,
          detail: brief(nestedName ? args : argText, 120), result: resultText,
        });
      }

      const isSearch = /^(WebSearch|web_search|search_query)$/i.test(tool) || /(?:^|__)(web_search|search_query)$/i.test(nestedName);
      const isFetch = /^(WebFetch|web_fetch|fetch_url|browse)$/i.test(tool) || /(?:^|__)(web_fetch|fetch_url|browse)$/i.test(nestedName);
      if (isSearch) {
        const query = String(args.query || input.query || (tool === 'WebSearch' ? argText : '')).trim();
        if (query) add(web, `search:${query}`, { kind: '搜索', label: query, tool: callName, result: resultText });
      } else if (isFetch) {
        const url = safeLink(args.url || input.url || '');
        if (url) add(web, `fetch:${url}`, { kind: '抓取', label: url, tool: callName, result: resultText });
      }
    }

    const sort = rows => rows.sort((a, b) => b.count - a.count || String(a.name || a.label).localeCompare(String(b.name || b.label)));
    return {
      skills: sort([...skills.values()]),
      mcp: sort([...mcp.values()]),
      web: sort([...web.values()]),
      sources: sort([...sources.values()]),
    };
  }

  const archSelections = new Map();

  function buildModel(events, meta) {
    meta = meta || {};
    const agents = Object.create(null);
    const ensure = (id, extra) => {
      if (!agents[id]) agents[id] = { id, status: 'running', events: [], forks: 0, tokens: 0, credits: 0, cost: 0, errors: 0, interventions: 0, tools: 0, messages: 0 };
      if (extra) Object.assign(agents[id], extra);
      return agents[id];
    };
    ensure('main', { role: 'main', label: '主会话', model: meta.model || '—', task: '规划 + 拍板', prompt: meta.prompt || '' });

    const plan = { steps: [] };
    const results = [];
    const verifs = [];
    const notices = [];
    let summary = null, forkSummary = null, advisorSummary = null, task = '', policy = null;

    for (const e of events) {
      const d = e.data || {};
      if (e.type === 'session_start') {
        task = d.task || task;
        policy = d.policy || policy;
        if (d.model) agents.main.model = d.model;
      }
      if (e.type === 'agent_spawned') ensure(d.agent, { role: d.role || 'subagent', label: d.label, model: d.model, task: d.task, step: d.step, spawnedAt: tsMs(e), prompt: d.prompt || '' });
      if (e.type === 'plan') plan.steps = d.steps || [];
      if (e.type === 'fork_decision') { const a = ensure(e.src); a.forks++; a.tokens += d.tokens || 0; a.cost += d.cost || 0; }
      if (e.type === 'token_usage') {
        const a = ensure(e.src);
        a.tokens += Number(d.total_tokens) || 0;
        a.credits += Number(d.credits) || 0;
      }
      if (e.type === 'tool_call') ensure(e.src).tools++;
      if (e.type === 'user_message') {
        const a = ensure(e.src);
        a.messages++;
        if (!a.prompt && d.text) a.prompt = String(d.text);
      } else if (e.type === 'assistant_message' || e.type === 'thinking') ensure(e.src).messages++;
      if (e.type === 'error') { const a = agents[e.src]; if (a) a.errors++; }
      if (e.type === 'notice') notices.push({ ts: tsMs(e), text: d.text || '' });
      if (e.type === 'advisor_note' && d.intervened) { const a = agents.advisor; if (a) a.interventions++; }
      if (e.type === 'subagent_state' && agents[e.src]) { agents[e.src].state = d.state; agents[e.src].stateNote = d.note; }
      if (e.type === 'result_emitted') results.push({ ts: tsMs(e), ...d });
      if (e.type === 'verification') verifs.push({ ts: tsMs(e), ...d });
      if (e.type === 'fork_summary') forkSummary = d;
      if (e.type === 'advisor_summary') {
        advisorSummary = d;
        ensure('advisor', { role: 'advisor', label: 'FABLE · advisor', model: 'fable 5.1' });
        agents.advisor.tokens = d.tokens || 0;
        agents.advisor.calls = d.calls || 0;
      }
      if (e.type === 'session_summary') summary = d;
      if (e.type === 'agent_finished') {
        const a = ensure(d.agent || e.src, {});
        a.status = d.status || 'done';
        a.finishedAt = tsMs(e);
      }
      if (agents[e.src]) agents[e.src].events.push(e);
    }

    const subs = Object.values(agents).filter(a => a.role === 'subagent');
    if (summary) {
      const routerCost = Number(summary.router_cost) || 0;
      const advisorCost = Number(summary.advisor_cost) || 0;
      if (agents.router) agents.router.cost = routerCost;
      if (agents.advisor) agents.advisor.cost = advisorCost;
      if (subs.length) {
        const weights = subs.map(a => Math.max(1, a.events.filter(e => e.type === 'tool_call').length));
        const sumW = weights.reduce((x, y) => x + y, 0);
        const subTotal = Number(summary.subagents_cost) || 0;
        subs.forEach((a, i) => { a.cost = subTotal * weights[i] / sumW; });
      }
      const known = routerCost + advisorCost + (Number(summary.subagents_cost) || 0);
      agents.main.cost = Math.max(0, (Number(summary.total_cost) || 0) - known);
    } else if (agents.router) {
      agents.router.cost = agents.router.cost || 0;
    }

    const eventTimes = events.map(tsMs).filter(Number.isFinite);
    const logStart = eventTimes.length ? Math.min(...eventTimes) : 0;
    const logEnd = eventTimes.length ? Math.max(...eventTimes) : 0;
    const mainStatus = agents.main.status;
    const stillRunning = mainStatus === 'running';

    for (const a of Object.values(agents)) {
      const pts = a.events.map(tsMs).filter(Number.isFinite).sort((x, y) => x - y);
      const iv = [];
      for (const t of pts) {
        if (iv.length && t - iv[iv.length - 1][1] < 8000) iv[iv.length - 1][1] = t;
        else iv.push([t, t]);
      }
      const start = Number.isFinite(a.spawnedAt) ? a.spawnedAt : a.role === 'main' ? logStart : null;
      let end = Number.isFinite(a.finishedAt) ? a.finishedAt : null;
      const aliveRole = a.role === 'main' || a.role === 'router' || a.role === 'advisor';
      if (end == null && (a.state === 'working' || (stillRunning && aliveRole))) end = logEnd;
      if (iv.length) {
        if (start != null && start < iv[0][0]) iv[0][0] = start;
        if (end != null && end > iv[iv.length - 1][1]) iv[iv.length - 1][1] = end;
      } else if (start != null) {
        iv.push([start, Math.max(start, end == null ? start : end)]);
      }
      a.intervals = iv;
    }

    const rows = results.map(r => {
      const vs = verifs.filter(v => v.target === r.path);
      return { ...r, verif: vs[vs.length - 1] };
    });

    const status = ['shipped', 'done', 'completed'].includes(mainStatus) ? 'completed'
      : mainStatus === 'running' && summary ? 'completed'
      : mainStatus;

    const allAgents = Object.values(agents);
    const tokens = allAgents.reduce((n, a) => n + (Number(a.tokens) || 0), 0);
    const credits = allAgents.reduce((n, a) => n + (Number(a.credits) || 0), 0);

    return {
      agents, plan, results: rows, verifs, summary, forkSummary, advisorSummary, notices,
      task, policy, status, events, tokens, credits,
      span: eventTimes.length ? [logStart, logEnd] : [0, 0],
    };
  }

  function effectiveStatus(a) {
    if (!a) return 'running';
    if (a.role === 'main') return a.status; // shipped | completed | failed | canceled | idle | running
    if (a.status && a.status !== 'running') return a.status; // done
    return a.state === 'done' ? 'done' : (a.state || 'running');
  }

  function mergeEvents(real, extra) {
    const rows = [...real, ...(Array.isArray(extra) ? extra : [])];
    return rows.map((e, i) => ({ e, i })).sort((a, b) => {
      const ta = tsMs(a.e), tb = tsMs(b.e);
      const va = Number.isFinite(ta) ? ta : 0, vb = Number.isFinite(tb) ? tb : 0;
      return va - vb || (Number(a.e.seq) || 0) - (Number(b.e.seq) || 0) || a.i - b.i;
    }).map(x => x.e);
  }

  function summarize(task, extraEvents) {
    const realEvents = parseJSONL(task.log);
    const events = mergeEvents(realEvents, extraEvents);
    /* 合成事件（Multica 关联 / 子任务 / 记忆）只进日志，不改变历史任务的
     * 耗时、成本与状态——否则补一条关联记录会把已完成任务重新拉长。 */
    const model = buildModel(realEvents, { model: task.model });
    model.events = events;
    model.trace = collectTrace(realEvents);
    model.extraEvents = Array.isArray(extraEvents) ? extraEvents.slice() : [];
    const preview = task.preview || {};
    const loaded = realEvents.length > 0;
    let status = loaded ? model.status : (preview.status || task.status || 'idle');
    if (loaded && status === 'running' && preview.status && preview.status !== 'running') status = preview.status;
    if (status === 'shipped' || status === 'done') status = 'completed';

    const pStart = Number(preview.startedAt || task.startedAt) || 0;
    const pEnd = Number(preview.endedAt || task.endedAt) || 0;
    const t0 = loaded ? (pStart || tsMs(realEvents[0])) : pStart;
    const t1 = loaded ? Math.max(pEnd, tsMs(realEvents[realEvents.length - 1]) || 0) : (pEnd || t0);
    if (!model.span[0] && t0) model.span = [t0, t1];

    const counts = { pass: 0, fail: 0, pending: 0, total: model.results.length };
    for (const r of model.results) {
      const v = r.verif ? r.verif.verdict : 'pending';
      if (v === 'pass') counts.pass++;
      else if (v === 'fail') counts.fail++;
      else counts.pending++;
    }
    const pCounts = preview.counts || {};
    if (pCounts.total > counts.total) {
      counts.pending += pCounts.total - counts.total;
      counts.total = pCounts.total;
    }
    const subs = Object.values(model.agents).filter(a => a.role === 'subagent');
    const tokens = Number(model.tokens) || Number(preview.tokens) || Number(task.tokens) || 0;
    const credits = Number(model.credits) || Number(preview.credits) || Number(task.credits) || 0;
    const cost = model.summary ? Number(model.summary.total_cost) || 0 : (Number(preview.cost ?? task.cost) || 0);
    const costUnit = task.costUnit || preview.costUnit || (credits ? 'credits' : 'usd');

    const main = model.agents.main;
    if (main) {
      main.status = status;
      if (task.model && main.model === '—') main.model = task.model;
      if (task.title && !main.task) main.task = task.title;
      if (!loaded) {
        main.spawnedAt = t0;
        main.finishedAt = t1;
        main.intervals = [[t0, Math.max(t0, t1)]];
      }
      main.credits = main.credits || credits;
      main.tokens = main.tokens || tokens;
    }
    model.status = status;
    model.credits = credits;
    model.tokens = tokens;

    return {
      id: task.id, model, events, status, task,
      startedAt: t0, endedAt: t1,
      durationMs: Number(preview.durationMs) > 0 ? Number(preview.durationMs) : Math.max(0, t1 - t0),
      createdAt: Number(preview.createdAt || task.createdAt) || t0,
      updatedAt: Number(preview.updatedAt || task.updatedAt) || t1,
      cost, credits, costUnit, tokens,
      agentCount: Math.max(Object.keys(model.agents).length, Number(preview.agentCount) || 0, Number(task.agentCount) || 0),
      subCount: Math.max(subs.length, Number(preview.subCount) || 0, Number(task.subCount) || 0),
      counts, loaded, partial: !!preview.partial,
    };
  }

  /* ---------------- render helpers ---------------- */

  function agentCard(a, model) {
    const st = effectiveStatus(a);
    const active = st === 'running' || st === 'working';
    const label = a.role === 'main' ? '主 Agent' : (a.label || a.id);
    const statusText = STATUS_LABEL[st] || String(st).toUpperCase();
    const meta = [];
    if (a.forks) meta.push(`fork ${a.forks} 次`);
    if (a.tools) meta.push(`${a.tools} 次工具`);
    if (a.messages) meta.push(`${a.messages} 条对话`);
    if (a.tokens) meta.push(fmtTok(a.tokens) + ' tok');
    if (a.credits) meta.push(fmtCredits(a.credits));
    else if (a.cost) meta.push(fmtCost(a.cost));
    if (a.errors) meta.push(`<span style="color:var(--red)">✗ ${a.errors}</span>`);
    if (a.interventions) meta.push(`<span style="color:var(--orange)">◆ 干预 ${a.interventions}</span>`);
    if (a.role === 'subagent') {
      const r = model.results.filter(x => x.created_by === a.id).length;
      if (r) meta.push(r + ' 个产物');
    }
    if (a.role === 'main' && model.span) meta.push(fmtDur(model.span[1] - model.span[0]));
    const shortModel = String(a.model || '').split(' · ')[0];
    const roleText = a.role === 'subagent' ? `subagent · ${shortModel}` : a.role === 'main' ? `main · ${shortModel}` : (shortModel || a.role);
    const prompt = a.prompt ? String(a.prompt).replace(/\s+/g, ' ').trim() : '';
    return `<div class="agent-card" data-arch-agent="${esc(a.id)}" tabindex="0" role="button" aria-label="查看 ${esc(label)} 的任务、提示词与执行日志" style="--c:${colorOf(a.id)}">
      <div class="ac-top">
        <span class="ac-name" style="color:${colorOf(a.id)}">${esc(label)}</span>
        <span class="ac-role">${esc(roleText)}</span>
        <span class="ac-status ${active ? 'running' : ''}">
          ${active ? '<span class="dot"></span>' : ''}
          <span class="stx" style="color:${active ? 'var(--green)' : st === 'failed' ? 'var(--red)' : 'var(--dim)'}">${esc(statusText)}</span>
        </span>
      </div>
      ${a.step ? `<div class="ac-task">步骤 ${esc(a.step)} · ${esc(a.task || '')}</div>` : `<div class="ac-task">${esc(a.task || '')}</div>`}
      ${prompt ? `<div class="ac-prompt" title="${esc(a.prompt)}">提示词：${esc(clip(prompt, 180))}</div>` : '<div class="ac-prompt muted">提示词：日志未记录</div>'}
      <div class="ac-meta">${meta.map(m => `<span>${m}</span>`).join('') || '<span>—</span>'}</div>
      <div class="ac-hint">查看任务与运行日志 ›</div>
    </div>`;
  }

  function agentLabel(a) {
    return a.role === 'main' ? '主 Agent' : (a.label || a.id);
  }

  function agentProgress(model, a) {
    const st = effectiveStatus(a);
    const steps = (model.plan.steps || []).filter(s => s.owner === a.id);
    const terminal = ['done', 'completed', 'shipped'].includes(st);
    const doneSteps = terminal ? steps.length : 0;
    const events = (a.events || []).filter(e => e.type !== 'token_usage');
    const first = Number.isFinite(a.spawnedAt) ? a.spawnedAt : (events.length ? tsMs(events[0]) : null);
    const last = Number.isFinite(a.finishedAt) ? a.finishedAt : (events.length ? tsMs(events[events.length - 1]) : null);
    return {
      st, steps, doneSteps, events,
      first, last,
      dur: Number.isFinite(first) && Number.isFinite(last) ? Math.max(0, last - first) : 0,
    };
  }

  function archInspectorHtml(model, meta, id, pinned) {
    const a = model.agents[id] || model.agents.main;
    if (!a) return '';
    const p = agentProgress(model, a);
    const active = p.st === 'running' || p.st === 'working';
    const label = agentLabel(a);
    const task = String(a.task || (a.role === 'main' ? model.task : '') || '').trim();
    const prompt = String(a.prompt || '').trim();
    const logs = p.events.slice(-9);
    const pct = p.steps.length ? Math.round(p.doneSteps / p.steps.length * 100) : (p.st === 'done' || p.st === 'completed' ? 100 : 0);
    const statusText = STATUS_LABEL[p.st] || String(p.st).toUpperCase();
    const stats = [
      `<span class="ai-stat">工具 <b>${Number(a.tools) || 0}</b></span>`,
      `<span class="ai-stat">事件 <b>${p.events.length}</b></span>`,
      `<span class="ai-stat">对话 <b>${Number(a.messages) || 0}</b></span>`,
      p.steps.length ? `<span class="ai-stat">计划步 <b>${p.doneSteps}/${p.steps.length}</b></span>` : '',
      p.dur ? `<span class="ai-stat">跨度 <b>${fmtDur(p.dur)}</b></span>` : '',
      a.tokens ? `<span class="ai-stat">Token <b>${fmtTok(a.tokens)}</b></span>` : '',
    ].filter(Boolean).join('');

    return `<div class="ai-head">
      <span class="ai-dot" style="background:${colorOf(id)}"></span>
      <span class="ai-name" style="color:${colorOf(id)}">${esc(label)}</span>
      <span class="ac-status ${active ? 'running' : ''}">${active ? '<span class="dot"></span>' : ''}<span class="stx" style="color:${active ? 'var(--green)' : p.st === 'failed' ? 'var(--red)' : 'var(--dim)'}">${esc(statusText)}</span></span>
      <span class="ai-role">${esc(a.role === 'main' ? 'main' : 'subagent')}${a.step ? ' · step ' + esc(a.step) : ''} · ${esc(a.model || '—')}</span>
      ${active ? '<span class="ai-live"><span class="dot running"></span>LIVE · 随数据刷新</span>' : '<span class="ai-live ended">已结束 · 保留最近日志</span>'}
      <span class="ai-pin">${pinned ? '已固定' : '悬停预览'}</span>
      ${pinned ? '' : `<button class="btn ai-pinbtn" type="button" data-arch-pin="${esc(id)}">固定此 Agent</button>`}
      <button class="btn ai-pinbtn" type="button" data-arch-action="live">完整执行日志 ›</button>
    </div>
    <div class="ai-grid">
      <section class="ai-block">
        <div class="ai-k">任务内容</div>
        <div class="ai-v">${task ? esc(task) : '<span class="muted">日志未记录任务描述</span>'}</div>
      </section>
      <section class="ai-block">
        <div class="ai-k">提示词</div>
        <pre class="ai-v ai-prompt">${prompt ? esc(prompt) : '日志未记录提示词'}</pre>
      </section>
      <section class="ai-block">
        <div class="ai-k">执行进度</div>
        <div class="ai-bar ${active && !p.steps.length ? 'live' : ''}"><span style="width:${pct}%"></span></div>
        <div class="ai-stats">${stats || '<span class="muted">暂无执行记录</span>'}</div>
        ${a.stateNote ? `<div class="ai-note">${esc(a.stateNote)}</div>` : ''}
      </section>
    </div>
    <section class="ai-block ai-logs">
      <div class="ai-k">正在执行的日志 <span class="muted">最近 ${logs.length} 条 · ${active ? '自动刷新' : '收工快照'}</span></div>
      ${logs.length ? `<ol class="ai-loglist">${logs.map(e => `<li>
        <span class="ai-time">${Number.isFinite(tsMs(e)) ? hhmmss(tsMs(e)) : '—'}</span>
        <span class="ai-type">${esc(e.type)}</span>
        <span class="ai-ev">${esc(clip(evDesc(e), 240)) || '—'}</span>
      </li>`).join('')}</ol>` : '<div class="ai-empty">这个 Agent 还没有独立日志事件。</div>'}
    </section>
    <div class="ai-foot">悬停架构节点可预览，点击或按 Enter 固定；日志来自${meta.board?.id ? '当前任务' : '当前会话'}的真实事件流，不补造中间状态。</div>`;
  }

  function promptPanelHtml(model) {
    const rank = { main: 0, router: 1, advisor: 2 };
    const agents = Object.values(model.agents).sort((a, b) => (rank[a.role] ?? 3) - (rank[b.role] ?? 3));
    const rows = agents.map(a => {
      const st = effectiveStatus(a);
      const label = agentLabel(a);
      const task = String(a.task || (a.role === 'main' ? model.task : '') || '').trim();
      const prompt = String(a.prompt || '').trim();
      const statusText = STATUS_LABEL[st] || String(st).toUpperCase();
      return `<article class="prompt-row" data-arch-agent="${esc(a.id)}" tabindex="0" role="button" style="--c:${colorOf(a.id)}" aria-label="查看 ${esc(label)} 的任务、提示词与运行日志">
        <header class="pr-head">
          <span class="pr-name" style="color:${colorOf(a.id)}">${esc(label)}</span>
          <span class="pr-role">${esc(a.role === 'main' ? 'main' : 'subagent')}${a.step ? ' · step ' + esc(a.step) : ''} · ${esc(a.model || '—')}</span>
          <span class="pr-status">${esc(statusText)}</span>
          <span class="pr-src ${prompt ? '' : 'muted'}">${prompt ? '提示词来自日志' : '提示词未记录'}</span>
        </header>
        <div class="pr-body">
          <div class="pr-block">
            <div class="pr-k">任务内容</div>
            <div class="pr-v">${task ? esc(task) : '<span class="muted">—</span>'}</div>
          </div>
          <div class="pr-block">
            <div class="pr-k">提示词</div>
            <pre class="pr-v pr-prompt">${prompt ? esc(prompt) : '日志未记录'}</pre>
          </div>
        </div>
      </article>`;
    }).join('');
    const missing = agents.filter(a => !String(a.prompt || '').trim()).length;
    return `<div class="prompt-list">${rows}</div>
      <div class="note">任务与提示词直接来自会话事件（${agents.length - missing}/${agents.length} 个 Agent 有提示词记录）。subagent 的提示词优先取 spawn 事件，缺失时回退到该 Agent 的首条 user_message；不根据任务标题补写提示词。</div>`;
  }

  function traceRows(rows, render, empty) {
    if (!rows.length) return `<div class="trace-empty">${esc(empty)}</div>`;
    const shown = rows.slice(0, 24);
    return `<div class="trace-rows">${shown.map(render).join('')}</div>
      ${rows.length > shown.length ? `<div class="trace-more">另有 ${rows.length - shown.length} 条未展开（按次数排序）</div>` : ''}`;
  }

  function tracePanelHtml(model) {
    const tr = model.trace || { skills: [], mcp: [], web: [], sources: [] };
    const verdictBadge = r => {
      const v = r.verif ? r.verif.verdict : 'pending';
      return v === 'pass' ? '<span class="badge b-ok">✓ 通过</span>'
        : v === 'fail' ? '<span class="badge b-fail">✗ 未通过</span>'
        : '<span class="badge b-warn">⏳ 待验证</span>';
    };
    const skillRow = r => `<div class="trace-row" data-trace-skill="${esc(r.name)}">
      <span class="tr-kind">技能</span><span class="tr-name">${esc(r.name)}</span>
      <span class="tr-src">${esc(r.source || '')}</span><span class="tr-count">×${r.count}</span>
      ${r.detail ? `<span class="tr-detail">${esc(r.detail)}</span>` : ''}
    </div>`;
    const mcpRow = r => `<div class="trace-row" data-trace-mcp="${esc(r.name)}">
      <span class="tr-kind mcp">MCP</span><span class="tr-name">${esc(r.tool || r.name)}</span>
      <span class="tr-src">${esc(r.server || '')}</span><span class="tr-count">×${r.count}</span>
      ${r.detail ? `<span class="tr-detail">${esc(r.detail)}</span>` : ''}
      ${r.result ? `<span class="tr-result">↳ ${esc(r.result)}</span>` : ''}
    </div>`;
    const webRow = r => {
      const label = String(r.label || '');
      const link = r.kind === '抓取' ? safeLink(label) : '';
      return `<div class="trace-row" data-trace-web="${esc(label)}">
      <span class="tr-kind web">${esc(r.kind)}</span>
      <span class="tr-name">${link ? `<a href="${esc(link)}" target="_blank" rel="noopener noreferrer">${esc(label)}</a>` : esc(label)}</span>
      <span class="tr-src">${esc(r.tool || '')}</span><span class="tr-count">×${r.count}</span>
      ${r.result ? `<span class="tr-result">↳ ${esc(r.result)}</span>` : ''}
    </div>`;
    };
    const sourceRow = r => `<div class="trace-row" data-trace-source="${esc(r.name)}">
      <span class="tr-kind">${esc(r.kind || '来源')}</span><span class="tr-name">${esc(r.name)}</span>
      <span class="tr-src">${esc(r.host || '')}</span><span class="tr-count">×${r.count}</span>
      <span class="tr-detail">${esc(r.source || '')}</span>
    </div>`;
    const outRow = r => `<div class="trace-row" data-trace-output="${esc(r.path)}">
      <span class="tr-kind out">${esc(r.kind || '产物')}</span><span class="tr-name">${esc(r.path)}</span>
      <span class="tr-src">${esc(r.created_by || '')}</span>${verdictBadge(r)}
      <span class="tr-detail">${esc(r.summary || '')}</span>
    </div>`;
    const skillCount = tr.skills.length + tr.mcp.length;
    const total = skillCount + model.results.length + tr.web.length + tr.sources.length;
    return `<div class="trace-head">
      <span>日志中真实出现的运行痕迹</span>
      <span class="trace-total">技能/MCP <b>${skillCount}</b> · 产出 <b>${model.results.length}</b> · 网页 <b>${tr.web.length}</b> · 来源 <b>${tr.sources.length}</b></span>
    </div>
    <div class="trace-grid">
      <section class="trace-block">
        <h3>技能与 MCP <span class="tb-count">${skillCount}</span></h3>
        ${tr.skills.length ? `<div class="trace-sub">技能调用</div>${traceRows(tr.skills, skillRow, '')}` : ''}
        ${tr.mcp.length ? `<div class="trace-sub">MCP 工具</div>${traceRows(tr.mcp, mcpRow, '')}` : ''}
        ${skillCount ? '' : '<div class="trace-empty">日志里没有 Skill 或 mcp__ 工具调用。</div>'}
      </section>
      <section class="trace-block">
        <h3>产出 <span class="tb-count">${model.results.length}</span></h3>
        ${traceRows(model.results, outRow, '当前任务还没有发布产物。')}
      </section>
      <section class="trace-block">
        <h3>网页查阅 <span class="tb-count">${tr.web.length}</span></h3>
        ${traceRows(tr.web, webRow, '日志里没有 WebSearch / WebFetch 调用。')}
      </section>
      <section class="trace-block">
        <h3>来源 <span class="tb-count">${tr.sources.length}</span></h3>
        ${traceRows(tr.sources, sourceRow, '日志里没有用户附件或本地图片引用。')}
      </section>
    </div>
    <div class="note">只统计日志里真实出现的工具名与附件块：Qoder / Claude Code 的 Skill、mcp__server__tool、WebSearch、WebFetch，以及用户消息里的附件与图片路径。链接与图片地址已去掉签名参数，只保留主机与路径；当前共 ${total} 条痕迹。${model.extraEvents?.length ? ' Multica 关联等本地合成事件不计入痕迹。' : ''}</div>`;
  }

  function archSVG(model, meta, selectedId) {
    meta = meta || {};
    const A = model.agents;
    const hasRouter = !!A.router, hasAdvisor = !!A.advisor;
    const subs = Object.values(A).filter(a => a.role === 'subagent');
    const W = 760;
    const mainY = 8, mainH = 46, row2Y = 92, row2H = 44;
    const subY = hasRouter || hasAdvisor ? 196 : 120;
    const subH = 44;
    const resY = subs.length
      ? subY + 92
      : (hasRouter || hasAdvisor ? row2Y + row2H + 58 : mainY + mainH + 58);
    const gateY = resY + 54, gateH = 30;
    const H = gateY + gateH + 18;
    const cx = W / 2;

    const box = (x, y, w, h, id, title, sub, extra) =>
      `<g class="arch-node${id === selectedId ? ' selected' : ''}" data-arch-agent="${esc(id)}" tabindex="0" role="button" aria-label="查看 ${esc(title)} 的任务、提示词与执行日志">
       <title>${esc(title)} · ${esc(sub)}</title>
       <rect class="arch-box" x="${x}" y="${y}" width="${w}" height="${h}" rx="8" fill="#0e121b" stroke="${colorOf(id)}" stroke-width="1.2" opacity="${extra || 1}"/>
       <text x="${x + w / 2}" y="${y + 19}" text-anchor="middle" fill="${colorOf(id)}" font-size="12" font-weight="700">${esc(title)}</text>
       <text x="${x + w / 2}" y="${y + 34}" text-anchor="middle" fill="#6b768f" font-size="9.5">${esc(sub)}</text>
      </g>`;

    const line = (x1, y1, x2, y2, label, dashed, color) => {
      const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
      return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color || '#3a4358'}" stroke-width="1" ${dashed ? 'stroke-dasharray="3 3"' : ''} marker-end="url(#obs-arr)"/>
        ${label ? `<text x="${mx}" y="${my - 4}" text-anchor="middle" fill="#6b768f" font-size="9">${esc(label)}</text>` : ''}`;
    };

    let svg = `<svg viewBox="0 0 ${W} ${H}" width="${W}" role="img" aria-label="Agent 运行架构图：会话执行面与产物验收门">
      <defs><marker id="obs-arr" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0L8,4L0,8z" fill="#3a4358"/></marker></defs>`;

    const mainModel = String(A.main.model || 'main').trim();
    const mainTitle = (mainModel.length > 19 ? mainModel.slice(0, 18) + '…' : mainModel) + ' · 主会话';
    svg += box(cx - 130, mainY, 260, mainH, 'main', mainTitle, 'plan + 拍板');

    if (hasRouter || hasAdvisor) {
      const w = 250;
      if (hasAdvisor && hasRouter) {
        svg += box(32, row2Y, w, row2H, 'advisor', 'FABLE · advisor', '只听不写 · 3 个时机出声');
        svg += box(W - w - 32, row2Y, w, row2H, 'router', 'JEV · fork 路由', 'cheap · <0.5s');
        svg += line(cx - 90, mainY + mainH, 32 + w / 2, row2Y, '监听全部调用', false, '#ffb86c');
        svg += line(32 + w / 2, row2Y + row2H, cx - 100, mainY + mainH, '◆ 干预', true, '#ffb86c');
        svg += line(cx + 90, mainY + mainH, W - 32 - w / 2, row2Y, '每次工具调用', false, '#4dd0e1');
        svg += line(W - 32 - w / 2, row2Y + row2H, cx + 100, mainY + mainH, `${model.forkSummary ? model.forkSummary.forks : A.router.forks} 次轻决策`, true, '#4dd0e1');
      } else if (hasAdvisor) {
        svg += box(cx - w / 2, row2Y, w, row2H, 'advisor', 'FABLE · advisor', '只听不写 · 3 个时机出声');
        svg += line(cx, mainY + mainH, cx, row2Y, '监听全部调用', false, '#ffb86c');
        svg += line(cx + 70, row2Y + row2H, cx + 40, mainY + mainH, '◆ 干预', true, '#ffb86c');
      } else {
        svg += box(cx - w / 2, row2Y, w, row2H, 'router', 'JEV · fork 路由', 'cheap · <0.5s');
        svg += line(cx, mainY + mainH, cx, row2Y, '每次工具调用', false, '#4dd0e1');
        svg += line(cx + 70, row2Y + row2H, cx + 40, mainY + mainH, `${model.forkSummary ? model.forkSummary.forks : A.router.forks} 次轻决策`, true, '#4dd0e1');
      }
    }

    if (subs.length) {
      const gap = 14;
      const bw = Math.min(180, (W - 80 - gap * (subs.length - 1)) / subs.length);
      const total = subs.length * bw + gap * (subs.length - 1);
      const startX = (W - total) / 2;
      const spawnSrcY = hasRouter || hasAdvisor ? row2Y + row2H : mainY + mainH;
      subs.forEach((a, i) => {
        const x = startX + i * (bw + gap);
        svg += box(x, subY, bw, subH, a.id, a.label || a.id, 'step ' + (a.step || '—'));
        svg += line(cx, spawnSrcY, x + bw / 2, subY, i === 0 ? 'spawn' : '', false, colorOf(a.id));
        svg += line(x + bw / 2, subY + subH, cx - 80 + i * 20, resY, i === 0 ? 'emit' : '', false, '#4ade80');
      });
    }

    const resultNames = model.results.map(r => r.path.split('/').pop());
    const nameLine = resultNames.length > 4
      ? resultNames.slice(0, 3).join(' · ') + ` +${resultNames.length - 3}`
      : resultNames.join(' · ');
    svg += `<rect class="arch-box" x="${cx - 190}" y="${resY}" width="380" height="46" rx="8" fill="none" stroke="#4ade80" stroke-dasharray="4 3"/>
      <text x="${cx}" y="${resY + 19}" text-anchor="middle" fill="#4ade80" font-size="11" font-weight="700">产物区 · ${model.results.length} 个结果</text>
      <text x="${cx}" y="${resY + 34}" text-anchor="middle" fill="#6b768f" font-size="9">${esc((nameLine.length > 70 ? nameLine.slice(0, 69) + '…' : nameLine) || '暂无产物')}</text>`;

    /* ---- 验收门：goal 执行必须拿到通过记录，才能从运行列落到已完成 ---- */
    const v = { pass: 0, fail: 0, pending: 0 };
    model.results.forEach(r => {
      const verdict = r.verif ? r.verif.verdict : 'pending';
      if (verdict === 'pass') v.pass++;
      else if (verdict === 'fail') v.fail++;
      else v.pending++;
    });
    const gateColor = v.fail > 0 ? '#f87171' : (v.pass > 0 && v.pending === 0 ? '#4ade80' : '#facc15');
    svg += line(cx, resY + 46, cx, gateY, '', false, gateColor);
    svg += `<text x="${cx + 7}" y="${resY + 51}" fill="#6b768f" font-size="8.5">settle 回写</text>`;
    svg += `<rect class="gate" x="${cx - 150}" y="${gateY}" width="300" height="${gateH}" rx="7" fill="#0b0f17" stroke="${gateColor}" stroke-width="1.3"/>
      <text x="${cx}" y="${gateY + 12}" text-anchor="middle" fill="${gateColor}" font-size="9.5" font-weight="700">验收门 · 产物需要通过记录</text>
      <text x="${cx}" y="${gateY + 24}" text-anchor="middle" fill="#7b86a0" font-size="8.5">通过 ${v.pass} · 未过 ${v.fail} · 待验证 ${v.pending}</text>`;

    svg += '</svg>';
    return svg;
  }

  /* ---------------- 独立任务看板 ---------------- */

  function boardBar(counts) {
    const total = Number(counts?.pass || 0) + Number(counts?.fail || 0) + Number(counts?.pending || 0);
    if (!total) return '';
    const seg = (n, cls, name) => n > 0 ? `<span class="kb-seg ${cls}" style="flex:${n}" title="${name} ${n}"></span>` : '';
    return `<span class="kb-bar">${seg(counts.pass, 'ok', '通过')}${seg(counts.fail, 'fail', '未通过')}${seg(counts.pending, 'pend', '待验证')}</span>`;
  }

  function boardCardHtml(card) {
    const c = card || {};
    const bucket = boardBucketOf(c);
    const col = BOARD_COLUMNS.find(x => x.id === bucket) || BOARD_COLUMNS[1];
    const total = Number(c.counts?.total ?? c.counts?.pass + c.counts?.fail + c.counts?.pending) || 0;
    const statusKey = String(c.status || '').toLowerCase();
    const statusTag = ['canceled', 'cancelled', 'failed', 'idle'].includes(statusKey) && STATUS_CN[statusKey]
      ? `<span class="kb-tag kb-tag-status kb-tag-${esc(statusKey)}">${esc(STATUS_CN[statusKey])}</span>` : '';
    const tags = [
      c.current ? '<span class="kb-tag kb-tag-current">当前</span>' : '',
      c.isSub ? '<span class="kb-tag">子任务</span>' : '',
      statusTag,
      c.link ? `<span class="kb-tag">⇄ ${esc(c.link)}</span>` : '',
    ].filter(Boolean).join('');
    const meta = [c.agentName, c.workspaceLabel].filter(Boolean).join(' · ');
    const tag = c.noLink ? 'div' : 'button';
    const attrs = c.noLink ? '' : `type="button" data-board-task="${esc(c.id)}"`;
    return `<${tag} class="kb-card${c.isSub ? ' kb-card-sub' : ''}" ${attrs} style="--c:${esc(c.accent || col.color)}">
      <span class="kb-card-top"><span class="kb-card-title">${esc(c.title || '未命名任务')}</span>${tags}</span>
      <span class="kb-card-meta">${esc(meta || '—')}</span>
      <span class="kb-card-foot"><span>${c.updatedAt ? '更新 ' + fmtStamp(c.updatedAt) : (STATUS_CN[c.status] || c.status || '')}</span><span>${total ? total + ' 个产物' : (STATUS_CN[c.status] || '')}</span></span>
      ${boardBar(c.counts)}
    </${tag}>`;
  }

  function renderBoard(host, cards, opts) {
    opts = opts || {};
    if (!host) return;
    const list = (Array.isArray(cards) ? cards : []).slice()
      .sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0));
    const lanes = Object.fromEntries(BOARD_COLUMNS.map(col => [col.id, []]));
    for (const card of list) lanes[boardBucketOf(card)].push(card);
    const limit = opts.limit === 'all' || Number(opts.limit) <= 0 ? Infinity : Number(opts.limit) || Infinity;
    const open = opts.openLanes instanceof Set ? opts.openLanes : new Set(Array.isArray(opts.openLanes) ? opts.openLanes : []);
    const laneHtml = col => {
      const all = lanes[col.id];
      const expanded = open.has(col.id);
      const shown = expanded ? all : all.slice(0, limit);
      const hidden = all.length - shown.length;
      const collapse = expanded && Number.isFinite(limit) && all.length > limit;
      return `<div class="kb-lane">${shown.map(boardCardHtml).join('') || '<div class="kb-empty">—</div>'}
        ${hidden > 0 ? `<button class="kb-lane-more" type="button" data-lane-more="${col.id}">展开剩余 ${hidden} 条「${col.label}」</button>` : ''}
        ${collapse ? `<button class="kb-lane-more" type="button" data-lane-less="${col.id}">收起，只留最近 ${limit} 条</button>` : ''}
      </div>`;
    };
    host.innerHTML = `<div class="kb${opts.fixed ? ' kb-fixed' : ''}" data-total="${list.length}" data-limit="${Number.isFinite(limit) ? limit : 'all'}">
      <div class="kb-cols">${BOARD_COLUMNS.map(col => `
        <section class="kb-col" data-col="${col.id}" style="--c:${col.color}">
          <header class="kb-col-head">
            <span class="kb-dot"></span><span class="kb-col-name">${col.label}</span>
            <span class="kb-col-count">${lanes[col.id].length}</span>
          </header>
          ${laneHtml(col)}
        </section>`).join('')}</div>
      ${opts.note ? `<div class="kb-foot">${opts.note}</div>` : ''}
    </div>`;
  }

  function boardCardsOf(board) {
    if (!board || !board.id) return [];
    return [{
      id: board.id, title: board.title, status: board.status, agent: board.agent,
      agentName: board.agentName || board.agent, accent: board.accent,
      workspaceLabel: board.workspaceLabel || board.repo, updatedAt: board.updatedAt || board.endedAt,
      counts: board.counts, link: board.link && board.link.identifier ? board.link.identifier : null,
      current: true, noLink: true,
    }, ...(Array.isArray(board.subtasks) ? board.subtasks : []).map(st => ({
      id: st.id, title: st.title, status: st.status, agentName: st.owner,
      workspaceLabel: '子任务', isSub: true, noLink: true, updatedAt: st.updatedAt, counts: st.counts,
      link: st.issue || null,
    }))];
  }

  function gantt(model) {
    const [t0, t1] = model.span;
    const W = Math.max(1, t1 - t0);
    const A = model.agents;
    const order = ROLE_ORDER.filter(id => A[id]);
    const subs = Object.values(A).filter(a => a.role === 'subagent' && !ROLE_ORDER.includes(a.id));
    const rows = order.concat(subs.map(a => a.id));
    const body = rows.map(id => {
      const a = A[id];
      const bars = (a.intervals || []).map(([s, e]) => {
        const left = (s - t0) / W * 100, width = Math.max((e - s) / W * 100, 1.2);
        return `<div class="gbar" style="left:${left}%;width:${width}%;--c:${colorOf(id)}" title="${esc(id)} ${hhmmss(s)}–${hhmmss(e)}"></div>`;
      }).join('');
      const marks = a.events.filter(e => e.type === 'error' || (e.type === 'advisor_note' && e.data && e.data.intervened)).map(e => {
        const left = (tsMs(e) - t0) / W * 100;
        const sym = e.type === 'error' ? '✗' : '◆';
        return `<div class="gmark" style="left:${left}%;color:${e.type === 'error' ? 'var(--red)' : 'var(--orange)'}" title="${esc(evDesc(e).slice(0, 100))}">${sym}</div>`;
      }).join('');
      return `<div class="grow"><div class="glabel" style="color:${colorOf(id)}">${esc(id)}</div><div class="gtrack">${bars}${marks}</div></div>`;
    }).join('');
    const axis = `<div class="gaxis">${[0, 0.25, 0.5, 0.75, 1].map(p => `<span>${hhmmss(t0 + W * p)}</span>`).join('')}</div>`;
    return `<div class="gantt">${body}${axis}</div>`;
  }

  function steps(model) {
    const A = model.agents;
    const ownerDone = id => {
      const a = A[id];
      if (!a) return false;
      const st = effectiveStatus(a);
      return st === 'done' || st === 'shipped' || st === 'completed';
    };
    return model.plan.steps.map(s => `<div class="step ${ownerDone(s.owner) ? 'done' : ''}">
      <span class="sid">${esc(s.id)}</span><b>${esc(s.desc)}</b>
      <span style="color:${colorOf(s.owner)}">@${esc(s.owner)}</span></div>`).join('');
  }

  function resultsTable(model) {
    if (!model.results.length) {
      return `<div class="empty">当前任务还没有发布任何产物${model.status === 'running' ? '（执行中）' : ''}</div>`;
    }
    const rows = model.results.map(r => {
      const verdict = r.verif ? r.verif.verdict : 'pending';
      const badge = verdict === 'pass' ? '<span class="badge b-ok">✓ 已验证通过</span>'
        : verdict === 'fail' ? '<span class="badge b-fail">✗ 验证未通过</span>'
        : '<span class="badge b-warn">⏳ 待验证</span>';
      const v = r.verif
        ? `<div>${esc(r.verif.method || '')}</div><div class="ev">${esc(r.verif.evidence || '')}</div>`
        : '<div class="ev">尚无 verification 事件</div>';
      return `<tr>
        <td>${esc(r.summary || '—')}</td>
        <td><span class="badge b-info">${esc(r.kind || 'artifact')}</span></td>
        <td class="path">${esc(r.path)}</td>
        <td style="color:${colorOf(r.created_by)}">${esc(r.created_by)}</td>
        <td class="ev" style="white-space:nowrap">${hhmmss(r.ts)}</td>
        <td>${badge}</td>
        <td>${v}</td>
      </tr>`;
    }).join('');
    return `<table class="results-table">
      <thead><tr><th>产物</th><th>类型</th><th>落点路径</th><th>生成者</th><th>发布</th><th>验证状态</th><th>验证方式 / 证据</th></tr></thead>
      <tbody>${rows}</tbody></table>`;
  }

  function evDesc(e) {
    const d = e.data || {};
    switch (e.type) {
      case 'session_start': return [d.task, d.model, d.workspace].filter(Boolean).join(' · ');
      case 'turn_started': return `第 ${d.turn ?? '—'} 轮${d.model ? ' · ' + d.model : ''}`;
      case 'user_message': return d.text || '';
      case 'assistant_message': return d.text || '';
      case 'thinking': return d.text || '';
      case 'token_usage': return `${fmtTok(d.total_tokens)} tok${d.credits ? ' · ' + fmtCredits(d.credits) : ''}（in ${fmtTok(d.input_tokens)} / out ${fmtTok(d.output_tokens)}）`;
      case 'notice': return d.text || '';
      case 'agent_spawned': return `${d.label || d.agent} · ${d.task || ''}`;
      case 'plan': return `计划 ${(d.steps || []).length} 步：${(d.steps || []).map(s => s.id).join(' → ')}`;
      case 'fork_decision': return `${d.decision} → ${d.target}（${d.route}，${d.elapsed_ms}ms）`;
      case 'tool_call': return `${d.tool} ${d.args || ''}`;
      case 'tool_result': return `${d.tool} · ${d.status} · ${d.summary || ''}`;
      case 'error': return `${d.error}${d.attempt ? `（attempt ${d.attempt}，连续第 ${d.same_error_x} 次）` : ''}`;
      case 'retry': return `重试 ${d.tool} · ${d.reason || ''}`;
      case 'advisor_note': return `${d.timing} · ${d.advice}`;
      case 'subagent_state': return `${d.state} · ${d.note || ''}`;
      case 'result_emitted': return `${d.path} — ${d.summary || ''}`;
      case 'attachment': return `${d.kind || '附件'} · ${d.name || ''}${d.host ? ' · ' + d.host : ''}`;
      case 'verification': return `${d.target} · ${d.method} → ${d.verdict}`;
      case 'merge': return d.note || '子任务结论合并';
      case 'fork_summary': return `fork ${d.forks} 次 · ${d.tokens} tok · ${fmtCost(d.cost)} · 平均 ${d.avg_elapsed_ms}ms`;
      case 'advisor_summary': return d.note || '';
      case 'session_summary': return `总成本 ${fmtCost(d.total_cost)} · 产物 ${d.results_total}（${d.results_verified_pass} 通过 / ${d.results_verified_fail} 未通过 / ${d.results_pending} 待验证）`;
      case 'agent_finished': return `${d.agent} → ${d.status}`;
      case 'multica_linked': return `已关联 ${d.identifier} · ${d.mode === 'existing' ? '已有 issue' : '新建 issue'}${d.title ? ' · ' + d.title : ''}`;
      case 'multica_sync': return `${d.identifier || 'Multica'}${(d.changes || []).length ? '：' + d.changes.join('；') : (d.source === 'unlink' ? ' · 已解除本地关联' : ' · 已同步')}`;
      case 'multica_subtask': return `${d.identifier} · ${d.title}${d.owner ? ' → ' + d.owner : ''}（父 ${d.parent || '—'}）`;
      case 'subtask_created': return `${d.title}${d.owner ? ' → ' + d.owner : ''} · 仅本地`;
      case 'subtask_status': return `${d.title} · ${d.from} → ${d.to}${d.identifier ? ' · ' + d.identifier : ''}`;
      case 'subtask_removed': return `${d.title}${d.remoteKept ? ' · 仅移除本地记录' : ''}`;
      case 'memory_written': return `关联记忆已写入 ${d.identifier || 'Multica'} · ${d.subtasks || 0} 个子任务`;
      default: return '';
    }
  }

  function wireArchitecture(root, model, meta) {
    const key = meta.board?.id || 'task';
    const host = root.querySelector('#arch-inspector');
    if (!host) return;
    const state = () => archSelections.get(key) || { pinned: 'main', view: 'main' };
    const paint = () => {
      const s = state();
      if (!model.agents[s.view]) s.view = 'main';
      if (!model.agents[s.pinned]) s.pinned = 'main';
      host.innerHTML = archInspectorHtml(model, meta, s.view, s.pinned === s.view);
      host.dataset.archInspector = s.view;
      root.querySelectorAll('[data-arch-agent]').forEach(node => {
        const on = node.dataset.archAgent === s.view;
        node.classList.toggle('inspecting', on);
        if (node.classList.contains('arch-node')) node.classList.toggle('selected', on);
      });
    };
    const setView = (id, pinned) => {
      const s = state();
      s.view = id;
      if (pinned) s.pinned = id;
      archSelections.set(key, s);
      paint();
    };
    const restore = () => {
      const s = state();
      s.view = s.pinned;
      archSelections.set(key, s);
      paint();
    };
    /* 指针从架构节点移进检查器时保持预览：否则一离开节点就重渲染，
     * 检查器里的「固定此 Agent」按钮会被瞬掉，鼠标与键盘都用不到。
     * 恢复动作延后到下一个宏任务：期间若指针 / 焦点进了检查器或另一个节点，就不恢复。 */
    let hoverId = null, overInspector = false, overNode = false;
    const leaveNode = () => {
      setTimeout(() => {
        if (!overInspector && !overNode) { hoverId = null; restore(); }
      }, 0);
    };
    host.addEventListener('mouseenter', () => {
      overInspector = true;
      if (hoverId && state().view !== hoverId) setView(hoverId, false);
    });
    host.addEventListener('mouseleave', () => {
      overInspector = false;
      hoverId = null;
      restore();
    });
    root.querySelectorAll('[data-arch-agent]').forEach(node => {
      const id = node.dataset.archAgent;
      if (node.classList.contains('arch-node')) {
        node.addEventListener('mouseenter', () => { overNode = true; hoverId = id; setView(id, false); });
        node.addEventListener('mouseleave', () => { overNode = false; leaveNode(); });
        node.addEventListener('focus', () => { overNode = true; hoverId = id; setView(id, false); });
        node.addEventListener('blur', () => {
          overNode = false;
          setTimeout(() => {
            if (!overInspector && !overNode && !host.contains(document.activeElement)) { hoverId = null; restore(); }
          }, 0);
        });
      }
      node.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setView(id, true); }
      });
      node.addEventListener('click', e => {
        if (e.target.closest('a')) return;
        e.preventDefault();
        setView(id, true);
      });
    });
    host.addEventListener('click', e => {
      const pinBtn = e.target.closest('[data-arch-pin]');
      if (pinBtn) { setView(pinBtn.dataset.archPin, true); return; }
      if (e.target.closest('[data-arch-action="live"]')) {
        const lp = document.querySelector('#live-panel');
        if (lp) lp.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
    paint();
  }

  function renderPanels(root, model, meta) {
    meta = meta || {};
    const [t0, t1] = model.span;
    const durMs = Math.max(0, t1 - t0);
    const counts = { pass: 0, fail: 0, pending: 0, total: model.results.length };
    model.results.forEach(r => { const v = r.verif ? r.verif.verdict : 'pending'; if (v === 'pass') counts.pass++; else if (v === 'fail') counts.fail++; else counts.pending++; });
    if (!counts.total && meta.counts) Object.assign(counts, meta.counts);
    const agents = Object.values(model.agents);
    const subCount = agents.filter(a => a.role === 'subagent').length;
    const tools = agents.reduce((n, a) => n + (Number(a.tools) || 0), 0);
    const messages = agents.reduce((n, a) => n + (Number(a.messages) || 0), 0);
    const elapsedLabel = fmtDur(durMs) + (model.status === 'running' ? '（日志跨度）' : '');
    const hasRouting = model.forkSummary || model.agents.router;
    const routingChips = hasRouting
      ? [[model.forkSummary ? model.forkSummary.forks : model.agents.router.forks, 'fork 决策'],
         [model.forkSummary ? model.forkSummary.avg_elapsed_ms + 'ms' : '—', '平均决策耗时']]
      : [[tools, '工具调用'], [messages, '对话事件']];
    const creditMode = meta.costUnit === 'credits';
    const chips = [
      [agents.length, 'Agent 总数'],
      [subCount, 'Subagent'],
      ...routingChips,
      [fmtAmount(creditMode ? (meta.credits || 0) : (model.summary ? model.summary.total_cost : meta.cost), meta.costUnit), creditMode ? 'Credits 消耗' : '总成本'],
      [elapsedLabel, model.status === 'running' ? '已运行' : '总耗时'],
      [`<span style="color:var(--green)">${counts.pass}</span> 通过 · <span style="color:var(--red)">${counts.fail}</span> 未过 · <span style="color:var(--yellow)">${counts.pending}</span> 待验证`, '结果状态'],
    ];

    const backlog = [];
    if (counts.fail) backlog.push(`${counts.fail} 个未通过`);
    if (counts.pending) backlog.push(`${counts.pending} 个待验证`);
    const next = model.summary && model.summary.next ? String(model.summary.next).trim() : '';
    const note = !model.results.length
      ? (model.status === 'running'
        ? '任务仍在执行，日志里还没有产物记录；上方结果计数来自会话元数据。'
        : '该会话没有记录产物事件；验证状态不做推断，只展示日志中真实出现的结论。')
      : model.status === 'running'
        ? `任务仍在执行：已有 ${model.results.length} 个产物，${counts.pending} 个尚未验证；下方进度按最后一条日志的时间截断。`
        : next ? `收工遗留：${esc(next)}`
        : backlog.length ? `收工遗留：${backlog.join('、')}；需要复核后再交付。`
        : '所有产物均已有验证结论，可以交付。';
    const partialNote = meta.partial ? ' 原始日志较大，详情只载入最近事件。' : '';

    const boardCards = boardCardsOf(meta.board);
    const subRows = Array.isArray(meta.board?.subtasks) ? meta.board.subtasks : [];
    const subDone = subRows.filter(st => ['done', 'completed'].includes(String(st.status || '').toLowerCase())).length;
    const subLine = subRows.length ? `子任务 ${subDone}/${subRows.length} 完成。` : '无子任务。';
    const boardNote = boardCards.length
      ? subLine + '列由任务状态与产物验证结论推导；「待确认」= 已完成但仍有产物未验证。看板是独立面板，不依赖架构图。'
      : '该任务还没有可上板的记录。';

    const key = meta.board?.id || 'task';
    const sel = archSelections.get(key) || { pinned: 'main', view: 'main' };
    if (!model.agents[sel.view]) sel.view = 'main';
    if (!model.agents[sel.pinned]) sel.pinned = 'main';
    archSelections.set(key, sel);

    root.innerHTML = `
      <div class="chips">${chips.map(([v, k]) => `<div class="chip"><div class="chip-v">${v}</div><div class="chip-k">${esc(k)}</div></div>`).join('')}</div>
      <div class="grid">
        <section class="panel full arch-panel">
          <h2>① <span class="q">运行架构</span> · 会话执行面 + 验收门 · 点击 / 悬停节点看任务与日志</h2>
          <div class="svgwrap">${archSVG(model, meta, sel.view)}</div>
          <div class="arch-inspector" id="arch-inspector" data-arch-inspector="${esc(sel.view)}"></div>
          <div class="note">${model.policy ? '路由策略：' + esc(model.policy.router) + ' ｜ ' + esc(model.policy.advisor) : '日志未声明路由策略；架构只画日志中真实出现的 Agent、产物与验收记录。悬停节点可预览，点击固定，Enter / 空格同样可固定。'}</div>
        </section>
        <section class="panel full">
          <h2>② <span class="q">有多少 Agent 在执行</span> · 状态与开销</h2>
          <div class="agents">${agents.map(a => agentCard(a, model)).join('')}</div>
        </section>
        <section class="panel full">
          <h2>③ <span class="q">任务与提示词</span> · 每个 Agent 在做什么、收到什么指令</h2>
          ${promptPanelHtml(model)}
        </section>
        <section class="panel full">
          <h2>④ <span class="q">工作痕迹</span> · 技能 / MCP / 产出 / 网页查阅 / 来源</h2>
          ${tracePanelHtml(model)}
        </section>
        <section class="panel full">
          <h2>⑤ <span class="q">任务看板</span> · 当前任务与已派发子任务</h2>
          <div id="task-board"></div>
          <div class="note">${boardNote}</div>
        </section>
        <section class="panel full">
          <h2>⑥ <span class="q">执行进度</span> · ■ 活跃区间 · ✗ 报错 · ◆ advisor 干预</h2>
          <div class="svgwrap">${gantt(model)}</div>
          ${model.plan.steps.length ? `<div class="steps">${steps(model)}</div>` : ''}
          <div class="legend">
            ${Object.keys(model.agents).map(id => `<span><span class="dot" style="background:${colorOf(id)}"></span>${esc(id)}</span>`).join('')}
          </div>
          ${subCount ? '' : '<div class="note">该会话没有 subagent；进度条为主会话的活跃区间。</div>'}
        </section>
        <section class="panel full">
          <h2>⑦ <span class="q">生成的结果放在哪里</span> + <span class="q">是否待验证</span></h2>
          ${resultsTable(model)}
          <div class="note">${note}${partialNote}</div>
        </section>
      </div>`;

    const boardHost = root.querySelector('#task-board');
    renderBoard(boardHost, boardCards);
    wireArchitecture(root, model, meta);
  }

  window.Observatory = {
    parseJSONL, buildModel, summarize, renderPanels, renderBoard, boardCardsOf, boardBucketOf,
    effectiveStatus, colorOf, fmtDur, fmtCost, fmtCredits, fmtAmount, fmtTok, fmtStamp, hhmmss,
    eventLabel: evDesc, mergeEvents, BOARD_COLUMNS, STATUS_CN,
  };
})();
