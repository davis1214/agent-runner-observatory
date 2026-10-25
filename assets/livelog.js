/* Agent Runner · 执行日志（线索式时间线）
 * - 运行中任务从尾部逐步放出日志，模拟“实时滚动”
 * - 已完成任务默认全量，可重播
 * - 新产生的本地/桥接事件即时追加，并带合成标记
 */
(function () {
  'use strict';

  const OBS = window.Observatory || {};
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const colorOf = id => (OBS.colorOf ? OBS.colorOf(id) : '#9aa4bf');
  const hhmmss = ms => {
    if (!Number.isFinite(ms)) return '—';
    const d = new Date(ms), p = n => String(n).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  };
  const tsMs = e => Date.parse(e.ts);
  const keyOf = e => `${e.ts}|${e.seq}|${e.src}|${e.type}`;

  const ICONS = {
    session_start: '▶', turn_started: '↻', user_message: '›', assistant_message: '‹',
    thinking: '…', token_usage: '∑', notice: 'ⓘ',
    plan: '◇', agent_spawned: '✦', fork_decision: '⑂',
    tool_call: '▸', tool_result: '·', error: '✗', retry: '↻', advisor_note: '◆',
    subagent_state: '●', result_emitted: '▤', verification: '✓', merge: '⊕',
    fork_summary: '⑂', advisor_summary: '◆', session_summary: '■',
    agent_finished: '◼', multica_linked: '⇄', multica_sync: '⇄',
    multica_subtask: '☑', subtask_created: '☐', subtask_status: '☑',
    subtask_removed: '⊘', memory_written: '✎', attachment: '⧉',
  };
  const TYPE_LABEL = {
    session_start: '会话开始', turn_started: '轮次开始', user_message: '用户消息',
    assistant_message: 'Agent 回复', thinking: '思考', token_usage: 'Token 用量', notice: '提示',
    plan: '计划', agent_spawned: 'Agent 派生',
    fork_decision: '路由拍板', tool_call: '工具调用', tool_result: '工具返回',
    error: '报错', retry: '重试', advisor_note: 'Advisor 旁注',
    subagent_state: 'Subagent 状态', result_emitted: '产物发布',
    verification: '验证结论', merge: '合并', fork_summary: '路由小结',
    advisor_summary: 'Advisor 小结', session_summary: '会话小结',
    agent_finished: 'Agent 收尾', multica_linked: 'Multica 关联',
    multica_sync: 'Multica 同步', multica_subtask: 'Multica 子任务',
    subtask_created: '本地子任务', subtask_status: '子任务状态',
    subtask_removed: '移除子任务', memory_written: '写入关联记忆', attachment: '附件',
  };

  function kindOf(e) {
    const d = e.data || {};
    if (e.type === 'error' || d.verdict === 'fail') return 'crit';
    if (e.type === 'verification' && d.verdict === 'pass') return 'ok';
    if (e.type === 'result_emitted' || e.type === 'merge') return 'ok';
    if (e.type === 'retry' || (e.type === 'advisor_note' && d.intervened)) return 'warn';
    if (e.synthetic) return 'sync';
    return '';
  }

  function labelOf(e) {
    if (OBS.eventLabel) {
      const text = OBS.eventLabel(e);
      if (text) return text;
    }
    return e.type;
  }

  function statusText(mode, task, shown, total) {
    if (mode === 'live') return `● LIVE · 正在放出 ${shown}/${total}`;
    if (mode === 'live-wait') return '● LIVE · 已跟上最新日志，等待新事件';
    if (mode === 'paused') return `⏸ 已暂停 · ${shown}/${total}`;
    if (mode === 'replay') return `↻ 重播中 · ${shown}/${total}`;
    if (mode === 'done') return `✓ 回放完成 · ${total} 条`;
    return `▤ ${task && task.status === 'running' ? '已加载' : '历史全量'} · ${total} 条`;
  }

  function mount(host, options = {}) {
    const opts = options || {};
    let task = null;
    let summary = null;
    let allEvents = [];
    let visible = 0;
    let mode = 'full';
    let follow = true;
    let speed = Number(opts.speed) || 500;
    let timer = null;
    let syntheticKeys = new Set();
    let flashKeys = new Set();

    host.innerHTML = `<section class="panel full live-panel" id="live-panel" aria-label="执行日志">
      <h2>执行日志 · <span class="q">线索流</span> <span class="live-mode" id="live-mode">…</span></h2>
      <div class="live-bar">
        <div class="live-controls">
          <button class="btn" type="button" id="live-follow" aria-pressed="true">跟随：开</button>
          <button class="btn" type="button" id="live-pause">暂停</button>
          <button class="btn" type="button" id="live-replay">↻ 重播</button>
          <select class="select live-speed" id="live-speed" aria-label="日志放出速度">
            <option value="1000">0.5×</option>
            <option value="500" selected>1×</option>
            <option value="125">4×</option>
            <option value="0">即时</option>
          </select>
        </div>
        <div class="filters live-filters">
          <select id="live-agent" aria-label="按 Agent 过滤日志"><option value="">全部 Agent</option></select>
          <select id="live-type" aria-label="按类型过滤日志"><option value="">全部类型</option></select>
          <input type="search" id="live-q" aria-label="搜索执行日志" placeholder="搜索日志内容…">
        </div>
      </div>
      <div class="live-progress">
        <span id="live-count">0 / 0</span>
        <span class="live-hint" id="live-new" hidden></span>
        <span class="live-spacer"></span>
        <button class="btn btn-ghost" type="button" id="live-bottom">↓ 跳到底部</button>
      </div>
      <div class="livelog" id="livelog" tabindex="0" aria-live="polite"></div>
      <div class="live-foot">每条线索可展开原始 JSON。运行中任务会逐条放出；点「重播」从头回看，点「跟随」保持自动滚底。界面组织参考 DSH 的线索视图，不依赖其运行时。</div>
    </section>`;

    const panel = host.querySelector('#live-panel');
    const log = host.querySelector('#livelog');
    const followBtn = host.querySelector('#live-follow');
    const pauseBtn = host.querySelector('#live-pause');
    const replayBtn = host.querySelector('#live-replay');
    const speedSel = host.querySelector('#live-speed');
    const aSel = host.querySelector('#live-agent');
    const tSel = host.querySelector('#live-type');
    const qEl = host.querySelector('#live-q');
    const countEl = host.querySelector('#live-count');
    const newEl = host.querySelector('#live-new');
    const modeEl = host.querySelector('#live-mode');
    const bottomBtn = host.querySelector('#live-bottom');

    speedSel.value = String([1000, 500, 125, 0].includes(speed) ? speed : 500);
    speed = Number(speedSel.value);

    function scrollBottom() {
      log.scrollTop = log.scrollHeight;
    }

    function setFollow(next) {
      follow = !!next;
      panel.dataset.follow = String(follow);
      followBtn.textContent = '跟随：' + (follow ? '开' : '关');
      followBtn.classList.toggle('active', follow);
      followBtn.setAttribute('aria-pressed', String(follow));
      if (follow) scrollBottom();
    }

    function stopTimer() {
      if (timer) clearInterval(timer);
      timer = null;
    }

    function tick() {
      const total = allEvents.length;
      if (visible >= total) {
        stopTimer();
        mode = task && task.status === 'running' ? 'live-wait' : 'done';
        pauseBtn.textContent = task && task.status === 'running' ? '继续' : '暂停';
        renderStatus();
        updateControls();
        return;
      }
      visible = Math.min(total, visible + 1);
      const last = allEvents[visible - 1];
      if (last) flashKeys = new Set([keyOf(last)]);
      renderRows();
      renderStatus();
      updateControls();
    }

    function startTimer(nextMode) {
      stopTimer();
      mode = nextMode || 'live';
      const total = allEvents.length;
      if (visible >= total) {
        mode = task && task.status === 'running' ? 'live-wait' : 'done';
        renderStatus();
        updateControls();
        return;
      }
      if (speed <= 0) {
        visible = total;
        flashKeys = new Set();
        renderRows();
        mode = task && task.status === 'running' ? 'live-wait' : 'done';
        renderStatus();
        updateControls();
        return;
      }
      timer = setInterval(tick, speed);
      renderStatus();
      updateControls();
    }

    function updateControls() {
      const running = !!(task && task.status === 'running');
      pauseBtn.textContent = timer ? '暂停' : (mode === 'paused' ? '继续' : (running && mode === 'live-wait' ? '继续跟随' : '暂停'));
      pauseBtn.disabled = !timer && !running && mode !== 'paused';
      panel.dataset.mode = mode;
      panel.dataset.visible = String(visible);
      panel.dataset.total = String(allEvents.length);
      panel.dataset.follow = String(follow);
    }

    function renderStatus() {
      const total = allEvents.length;
      const filtered = filterEvents().length;
      modeEl.textContent = statusText(mode, task, visible, total);
      modeEl.dataset.mode = mode;
      countEl.textContent = visible < total
        ? `已放出 ${visible} / ${total} 条 · 当前筛选 ${filtered} 条`
        : `共 ${total} 条 · 当前筛选 ${filtered} 条`;
      const hidden = allEvents.length - visible;
      if (hidden > 0) {
        newEl.hidden = false;
        newEl.textContent = `还有 ${hidden} 条未放出`;
      } else {
        newEl.hidden = true;
        newEl.textContent = '';
      }
      updateControls();
    }

    function filterEvents() {
      const a = aSel.value, t = tSel.value, q = qEl.value.trim().toLowerCase();
      return allEvents.slice(0, visible).filter(e =>
        (!a || e.src === a) &&
        (!t || e.type === t) &&
        (!q || JSON.stringify(e).toLowerCase().includes(q))
      );
    }

    function rowHtml(e) {
      const key = keyOf(e);
      const cls = [kindOf(e), e.synthetic ? 'synth' : '', flashKeys.has(key) ? 'flash' : ''].filter(Boolean).join(' ');
      const icon = ICONS[e.type] || '·';
      const raw = JSON.stringify(e, null, 2);
      return `<div class="liveline ${cls}" data-key="${esc(key)}" data-src="${esc(e.src)}" data-type="${esc(e.type)}">
        <div class="ll-rail"><span class="ll-icon">${icon}</span></div>
        <div class="ll-card">
          <div class="ll-head">
            <span class="ll-time">${hhmmss(tsMs(e))}</span>
            <span class="ll-src" style="color:${colorOf(e.src)}">${esc(e.src)}</span>
            <span class="ll-type" title="${esc(e.type)}">${esc(TYPE_LABEL[e.type] || e.type)}</span>
            ${e.synthetic ? '<span class="ll-synth">合成</span>' : ''}
            <span class="ll-seq">#${esc(e.seq)}</span>
          </div>
          <div class="ll-desc">${esc(labelOf(e))}</div>
          <details class="ll-raw"><summary>原始 JSON</summary><pre>${esc(raw.length > 2400 ? raw.slice(0, 2399) + '…' : raw)}</pre></details>
        </div>
      </div>`;
    }

    function renderRows() {
      const rows = filterEvents();
      log.innerHTML = rows.length
        ? rows.map(rowHtml).join('')
        : `<div class="empty">${allEvents.length ? '没有匹配的线索' : '当前任务还没有日志事件'}</div>`;
      flashKeys = new Set();
      if (follow) requestAnimationFrame(scrollBottom);
    }

    function rebuildOptions() {
      const curA = aSel.value, curT = tSel.value;
      const agents = [...new Set(allEvents.map(e => e.src))];
      const types = [...new Set(allEvents.map(e => e.type))];
      aSel.innerHTML = '<option value="">全部 Agent</option>' + agents.map(a => `<option value="${esc(a)}">${esc(a)}</option>`).join('');
      tSel.innerHTML = '<option value="">全部类型</option>' + types.map(t => `<option value="${esc(t)}">${TYPE_LABEL[t] || t} · ${esc(t)}</option>`).join('');
      aSel.value = agents.includes(curA) ? curA : '';
      tSel.value = types.includes(curT) ? curT : '';
    }

    function setData(nextTask, nextSummary, flags = {}) {
      if (!nextTask || !nextSummary) return;
      const prevId = task ? task.id : null;
      const sameTask = prevId === nextTask.id;
      const prevEvents = allEvents;
      const prevKeys = new Set(prevEvents.map(keyOf));
      task = nextTask;
      summary = nextSummary;
      allEvents = Array.isArray(nextSummary.events) ? nextSummary.events.slice() : [];
      const added = sameTask ? allEvents.filter(e => !prevKeys.has(keyOf(e))) : allEvents;
      added.forEach(e => { if (e.synthetic) syntheticKeys.add(keyOf(e)); });
      if (added.length) flashKeys = new Set(added.map(keyOf));
      rebuildOptions();

      if (!sameTask) {
        visible = task.status === 'running'
          ? Math.max(0, allEvents.length - Math.min(12, Math.ceil(allEvents.length * 0.28)))
          : allEvents.length;
        setFollow(true);
        renderRows();
        if (task.status === 'running' && visible < allEvents.length) startTimer('live');
        else { mode = 'full'; stopTimer(); renderStatus(); updateControls(); }
      } else {
        const total = allEvents.length;
        if (total > prevEvents.length && visible < total) {
          if (follow) visible = total;
        }
        if (visible > total) visible = total;
        if (flags.preserveScroll !== true) renderRows();
        else renderRows();
        if (total > prevEvents.length && visible === total && task.status === 'running' && !timer && mode === 'live') {
          renderStatus();
        } else {
          renderStatus();
        }
      }
      if (flags.autoStart && task.status === 'running' && visible < allEvents.length && !timer) startTimer('live');
    }

    followBtn.addEventListener('click', () => setFollow(!follow));
    bottomBtn.addEventListener('click', () => { setFollow(true); scrollBottom(); });
    pauseBtn.addEventListener('click', () => {
      if (timer) {
        stopTimer();
        mode = 'paused';
        renderStatus();
        updateControls();
      } else if (visible < allEvents.length) {
        startTimer(task && task.status === 'running' ? 'live' : 'replay');
      } else if (task && task.status === 'running') {
        setFollow(true);
      }
    });
    replayBtn.addEventListener('click', () => {
      visible = 0;
      flashKeys = new Set();
      renderRows();
      startTimer('replay');
    });
    speedSel.addEventListener('change', () => {
      speed = Number(speedSel.value) || 0;
      if (timer) startTimer(mode === 'paused' ? 'live' : mode);
    });
    [aSel, tSel].forEach(el => el.addEventListener('change', () => { renderRows(); renderStatus(); }));
    qEl.addEventListener('input', () => { renderRows(); renderStatus(); });
    log.addEventListener('scroll', () => {
      const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 24;
      if (!atBottom && follow) setFollow(false);
      else if (atBottom && !follow) setFollow(true);
    });

    function destroy() {
      stopTimer();
      host.innerHTML = '';
    }

    return { setData, destroy, replay: () => replayBtn.click(), scrollBottom, get state() { return { mode, visible, total: allEvents.length, follow }; } };
  }

  window.RunnerLive = { mount };
})();
