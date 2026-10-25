/* Agent Runner · 协作面板：Multica 关联 / 子任务派发 / Agent 记忆
 * 所有状态先写本地 RunnerStore；桥接在线时再同步到 Multica。
 */
(function () {
  'use strict';

  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const STATUS_LABEL = {
    backlog: '待排期', todo: '待开始', in_progress: '进行中', in_review: '待验收',
    blocked: '受阻', done: '已完成', cancelled: '已取消',
  };
  const STATUS_CLASS = {
    backlog: 'b-cancel', todo: 'b-warn', in_progress: 'b-run', in_review: 'b-info',
    blocked: 'b-fail', done: 'b-ok', cancelled: 'b-cancel',
  };
  const STATUS_ORDER = ['todo', 'in_progress', 'in_review', 'blocked', 'done', 'cancelled'];
  const statusLabel = s => STATUS_LABEL[s] || s || '—';
  const statusBadge = s => `<span class="badge ${STATUS_CLASS[s] || 'b-info'}">${esc(statusLabel(s))}</span>`;
  const timeText = iso => {
    if (!iso) return '—';
    const d = new Date(iso);
    if (!Number.isFinite(d.getTime())) return String(iso).slice(0, 16);
    const p = n => String(n).padStart(2, '0');
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  const shortTitle = s => String(s || '').replace(/^\[[^\]]+\]-\[[^\]]+\]-/, '');
  const listOf = v => Array.isArray(v) ? v : [];

  async function copyText(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch { /* 落到 execCommand */ }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch { return false; }
  }

  function mount(host, ctx) {
    const store = ctx.store || window.RunnerStore;
    const bridge = ctx.bridge || window.RunnerMultica;
    const task = ctx.task;
    const toast = ctx.toast || (() => {});
    const afterChange = ctx.afterChange || (() => {});
    let bridgeState = ctx.bridgeState || { ok: false, bridge: 'offline', reason: '桥接状态未知' };
    let busy = false;
    let selectedIssue = null;
    let agentList = null;
    let searchTimer = null;
    let lastSearch = '';

    const writable = () => !!(bridgeState && bridgeState.ok && bridgeState.bridge === 'online');
    const link = () => store.linkFor(task.id);
    const subtasks = () => store.subtasksFor(task.id);

    host.innerHTML = `<section class="panel full collab" id="collab" aria-label="协作与子任务">
      <h2>⑥ 协作 · <span class="q">Multica 关联 / 子任务 / Agent 记忆</span> <span class="bridge-chip" id="bridge-chip">检测中</span></h2>
      <div class="collab-grid">
        <section class="collab-card link-card">
          <div class="cc-title"><span>Multica 关联</span><span class="cc-count" id="link-state">未关联</span></div>
          <div id="link-body"></div>
        </section>
        <section class="collab-card subtask-card">
          <div class="cc-title"><span>子任务派发</span><span class="cc-count" id="subtask-count">0 个</span></div>
          <div id="subtask-body"></div>
        </section>
      </div>
      <div class="memory-card" id="memory-card"></div>
      <div class="collab-foot">关联会写入父 issue 的 metadata（task_id / runner_*）和一条关联记忆评论；派发的 child issue 在描述里带 runner_parent_task_id。Agent / Subagent 在 Multica 读到这些字段后按同一协议回写状态。</div>
    </section>`;

    const linkBody = host.querySelector('#link-body');
    const subtaskBody = host.querySelector('#subtask-body');
    const memoryCard = host.querySelector('#memory-card');
    const bridgeChip = host.querySelector('#bridge-chip');
    const linkState = host.querySelector('#link-state');
    const subtaskCount = host.querySelector('#subtask-count');

    function warningsHtml(warnings) {
      const rows = listOf(warnings).filter(Boolean);
      if (!rows.length) return '';
      return `<div class="collab-warn"><b>桥接提示</b>${rows.map(w => `<div>· ${esc(w)}</div>`).join('')}</div>`;
    }

    function bridgeChipHtml() {
      if (!bridgeState) return '<span class="dot"></span> 检测中';
      if (!writable()) return `<span class="dot"></span> 桥接离线`;
      const m = bridgeState.multica || {};
      return m.online
        ? `<span class="dot ok"></span> 桥接在线 · Multica 在线`
        : `<span class="dot warn"></span> 桥接在线 · Multica 未响应`;
    }

    function renderBridgeChip() {
      bridgeChip.innerHTML = bridgeChipHtml();
      bridgeChip.classList.toggle('online', writable());
      bridgeChip.title = writable()
        ? `${bridgeState.multica?.appUrl || 'Multica'} · workspace ${bridgeState.multica?.workspaceId || 'default'}${bridgeState.multica?.cli ? ' · ' + bridgeState.multica.cli : ''}`
        : (bridgeState.reason || '本地桥接未启动');
    }

    function offlineHtml() {
      if (writable()) return '';
      return `<div class="collab-offline">${esc(bridgeState.reason || '本地桥接未启动')}。本地子任务仍可记录；联机同步后再派发到 Multica。</div>`;
    }

    function renderLink() {
      const cur = link();
      linkState.textContent = cur ? cur.issue.identifier : '未关联';
      linkState.className = 'cc-count' + (cur ? ' linked' : '');
      if (!cur) {
        linkBody.innerHTML = `
          <p class="collab-copy">把当前任务挂到一个 Multica 父 issue，建立可回溯的协作入口。</p>
          <div class="action-row">
            <button class="btn btn-primary" type="button" data-act="link-create" ${writable() ? '' : 'disabled title="本地桥接未启动"'}>⇄ 一键关联 Multica</button>
            <button class="btn" type="button" data-act="toggle-existing" ${writable() ? '' : 'disabled'}>关联已有 issue</button>
          </div>
          ${offlineHtml()}
          <div class="existing-box" id="existing-box" hidden>
            <div class="existing-row">
              <input class="search" id="issue-q" type="search" placeholder="搜索 issue 标题 / 编号" aria-label="搜索 Multica issue">
              <button class="btn" type="button" data-act="issue-search">搜索</button>
            </div>
            <div class="issue-results" id="issue-results"><div class="mini-empty">输入关键词搜索，或直接看最近 issue</div></div>
            <div class="action-row">
              <button class="btn" type="button" data-act="link-existing" disabled>关联选中的 issue</button>
            </div>
          </div>`;
        bindLink();
        return;
      }

      const issue = cur.issue;
      const warnings = listOf(cur.warnings);
      linkBody.innerHTML = `
        <div class="link-issue">
          <a class="issue-id" href="${esc(issue.url || '#')}" target="_blank" rel="noopener noreferrer">${esc(issue.identifier)}</a>
          ${statusBadge(issue.status)}
          <span class="issue-title" title="${esc(issue.title)}">${esc(shortTitle(issue.title))}</span>
        </div>
        <div class="link-meta">
          <span>${issue.assigneeName ? '负责人 ' + esc(issue.assigneeName) : '未分配'}</span>
          <span>更新 ${esc(timeText(issue.updatedAt))}</span>
          <span>子任务 ${listOf(cur.children).length} 个</span>
          ${issue.labels?.length ? `<span>${issue.labels.map(l => esc(l)).join(' / ')}</span>` : ''}
        </div>
        <div class="action-row">
          <button class="btn" type="button" data-act="sync" ${writable() ? '' : 'disabled'}>↻ 刷新子任务</button>
          <button class="btn" type="button" data-act="memory" ${writable() ? '' : 'disabled'}>✎ 写入记忆</button>
          <a class="btn" href="${esc(issue.url || '#')}" target="_blank" rel="noopener noreferrer">打开 Multica ↗</a>
          <button class="btn btn-danger" type="button" data-act="unlink">解除本地关联</button>
        </div>
        <div class="parent-status">
          <span>父 issue 状态</span>
          <select class="select" id="parent-status" aria-label="父 issue 状态">
            ${statusOptions(issue.status)}
          </select>
          <button class="btn" type="button" data-act="parent-status" ${writable() ? '' : 'disabled'}>更新</button>
          <span class="sync-note">上次同步 ${esc(timeText(cur.lastSyncedAt))}</span>
        </div>
        ${warningsHtml(warnings)}
        ${offlineHtml()}`;
      bindLink();
    }

    function statusOptions(current) {
      const list = STATUS_ORDER.includes(current) ? STATUS_ORDER : [current, ...STATUS_ORDER.filter(s => s !== current)];
      return list.map(s => `<option value="${esc(s)}" ${s === current ? 'selected' : ''}>${esc(statusLabel(s))}（${esc(s)}）</option>`).join('');
    }

    function renderSubtasks() {
      const rows = subtasks().sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
      const cur = link();
      const prevForm = {
        title: host.querySelector('#st-title')?.value || '',
        owner: host.querySelector('#st-owner')?.value || '',
        stage: host.querySelector('#st-stage')?.value || '',
        desc: host.querySelector('#st-desc')?.value || '',
        status: host.querySelector('#st-status')?.value || 'todo',
      };
      subtaskCount.textContent = rows.length + ' 个';
      subtaskBody.innerHTML = `
        <div class="subtask-form">
          <div class="stf-row">
            <input class="search stf-title" id="st-title" type="text" maxlength="180" placeholder="子任务标题，例如：补齐失败用例" aria-label="子任务标题">
            <select class="select stf-status" id="st-status" aria-label="初始状态">
              ${statusOptions('todo')}
            </select>
          </div>
          <div class="stf-row">
            <input class="search stf-owner" id="st-owner" type="text" maxlength="100" list="multica-agent-list" placeholder="负责人（Multica agent，可留空）" aria-label="子任务负责人">
            <input class="search stf-stage" id="st-stage" type="number" min="1" max="99" placeholder="阶段（可选）" aria-label="子任务阶段">
            <datalist id="multica-agent-list">${agentList ? agentList.slice(0, 200).map(a => `<option value="${esc(a.name)}"></option>`).join('') : ''}</datalist>
          </div>
          <textarea class="stf-desc" id="st-desc" rows="2" maxlength="2000" placeholder="目标 / 验收标准（可选）" aria-label="子任务描述"></textarea>
          <div class="action-row">
            <button class="btn" type="button" data-act="subtask-local">＋ 仅记录本地</button>
            <button class="btn btn-primary" type="button" data-act="subtask-dispatch" ${cur && writable() ? '' : 'disabled title="先关联 Multica 父 issue，并确保本地桥接在线"'}>⇄ 派发到 Multica</button>
            <span class="stf-hint">${cur ? '派发后会创建 child issue 并分配负责人' : '未关联父 issue 时只能记录本地'}</span>
          </div>
        </div>
        <div class="subtask-list">
          ${rows.length ? rows.map(subtaskRow).join('') : '<div class="mini-empty">还没有子任务。先拆一个，执行完把状态改回 Multica。</div>'}
        </div>`;
      const restore = (sel, val) => { const el = host.querySelector(sel); if (el && val) el.value = val; };
      restore('#st-title', prevForm.title);
      restore('#st-owner', prevForm.owner);
      restore('#st-stage', prevForm.stage);
      restore('#st-desc', prevForm.desc);
      const stStatus = host.querySelector('#st-status');
      if (stStatus && [...stStatus.options].some(o => o.value === prevForm.status)) stStatus.value = prevForm.status;
      bindSubtasks();
    }

    function subtaskRow(s) {
      const issue = s.issue;
      const canRemote = issue && writable();
      return `<div class="subtask-row" data-subtask="${esc(s.id)}">
        <span class="st-dot ${esc(s.status)}" title="${esc(statusLabel(s.status))}"></span>
        <div class="st-main">
          <div class="st-title">${esc(s.title)} ${issue ? `<span class="st-origin" title="已在 Multica 建 child issue">Multica</span>` : '<span class="st-origin local">仅本地</span>'}</div>
          <div class="st-meta">
            ${s.owner ? '负责人 ' + esc(s.owner) : '未分配'}
            ${issue ? ` · <a href="${esc(issue.url || '#')}" target="_blank" rel="noopener noreferrer">${esc(issue.identifier)}</a>` : ''}
            ${s.syncedAt ? ` · 同步 ${esc(timeText(s.syncedAt))}` : ''}
          </div>
          ${s.description ? `<div class="st-desc">${esc(s.description)}</div>` : ''}
          ${issue && !canRemote ? '<div class="st-warn">桥接离线：状态只改在本地</div>' : ''}
        </div>
        <select class="select st-status" data-status-id="${esc(s.id)}" aria-label="${esc(s.title)} 状态">
          ${statusOptions(s.status)}
        </select>
        <button class="btn btn-ghost st-remove" type="button" data-remove-id="${esc(s.id)}" title="仅移除本地记录">✕</button>
      </div>`;
    }

    function renderMemory() {
      const cur = link();
      if (!cur) {
        memoryCard.innerHTML = `<div class="memory-head"><span>Agent 关联记忆</span><span class="cc-count">未生成</span></div>
          <div class="mini-empty">关联 Multica 后，这里会生成一段可复制的记忆块，并写入父 issue 评论。</div>`;
        return;
      }
      const text = store.memoryBlock(task, cur, subtasks());
      memoryCard.innerHTML = `<div class="memory-head">
          <span>Agent 关联记忆</span>
          <span class="cc-count">${cur.memoryAt ? '已写入 ' + esc(timeText(cur.memoryAt)) : '待写入'}</span>
          <span class="memory-spacer"></span>
          <button class="btn btn-ghost" type="button" data-act="memory-copy">复制</button>
          <button class="btn" type="button" data-act="memory-write" ${writable() ? '' : 'disabled'}>✎ 写入 / 更新 Multica</button>
        </div>
        <pre class="memory-text" id="memory-text">${esc(text)}</pre>
        <div class="memory-hint">这段内容包含 task_id、父 issue、子任务进度与更新协议；复制给其他 Agent 也能接上同一上下文。</div>`;
      memoryCard.querySelector('[data-act="memory-copy"]')?.addEventListener('click', async (e) => {
        const ok = await copyText(text);
        toast(ok ? '关联记忆已复制' : '复制失败，请手动选择文本', ok ? 'ok' : 'err');
        if (e.currentTarget) e.currentTarget.blur();
      });
      memoryCard.querySelector('[data-act="memory-write"]')?.addEventListener('click', e => writeMemory(e.currentTarget));
    }

    function renderAll() {
      renderBridgeChip();
      renderLink();
      renderSubtasks();
      renderMemory();
    }

    function busyButton(btn, on, text) {
      if (!btn) return;
      if (on) {
        btn.dataset.label = btn.textContent;
        btn.textContent = text || '处理中…';
        btn.disabled = true;
      } else {
        btn.textContent = btn.dataset.label || btn.textContent;
        btn.disabled = false;
      }
    }

    function applyChildren(children) {
      const changes = [];
      const rows = subtasks();
      const byIssue = new Map(rows.filter(s => s.issue && s.issue.id).map(s => [s.issue.id, s]));
      for (const child of listOf(children)) {
        if (!child || !child.id) continue;
        const existing = byIssue.get(child.id);
        if (!existing) {
          store.addSubtask(task.id, {
            title: shortTitle(child.title), owner: child.assigneeName || '',
            description: '来自 Multica child issue，跟随父 issue 同步。',
            status: child.status || 'todo', issue: child,
          });
          changes.push(`+ ${child.identifier} ${shortTitle(child.title)}`);
          continue;
        }
        const patch = {};
        if (existing.status !== child.status) patch.status = child.status;
        if (shortTitle(existing.title) !== shortTitle(child.title)) patch.title = shortTitle(child.title);
        if ((existing.owner || '') !== (child.assigneeName || '')) patch.owner = child.assigneeName || '';
        if (existing.issue?.updatedAt !== child.updatedAt) patch.issue = child;
        if (Object.keys(patch).length) {
          store.updateSubtask(task.id, existing.id, patch);
          const bits = [];
          if (patch.status) bits.push(`状态 ${statusLabel(existing.status)} → ${statusLabel(patch.status)}`);
          if (patch.title) bits.push('标题更新');
          if (patch.owner !== undefined) bits.push('负责人更新');
          changes.push(`${child.identifier} ${bits.join('，') || '信息更新'}`);
        }
      }
      return changes;
    }

    function applyBundle(bundle, source) {
      const cur = link();
      if (!cur || !bundle || !bundle.issue) return [];
      const changes = applyChildren(bundle.children);
      const issueChanged = bundle.issue.status !== cur.issue.status || bundle.issue.title !== cur.issue.title ||
        bundle.issue.assigneeName !== cur.issue.assigneeName || bundle.issue.updatedAt !== cur.issue.updatedAt;
      store.patchLink(task.id, {
        issue: bundle.issue, children: bundle.children || [], warnings: bundle.warnings || [],
        lastCheckedAt: new Date().toISOString(), ...(source === 'memory' ? { memoryAt: new Date().toISOString() } : {}),
      });
      if (changes.length) {
        store.addEvent(task.id, 'multica_sync', {
          identifier: bundle.issue.identifier, source, children: (bundle.children || []).length,
          changes: changes.slice(0, 12), more: Math.max(0, changes.length - 12),
        }, task.agent);
      }
      return changes;
    }

    async function syncNow(btn, silent) {
      const cur = link();
      if (!cur || busy || !writable()) return;
      busy = true;
      busyButton(btn, true, '同步中…');
      try {
        const bundle = await bridge.issue(cur.issue.id);
        const changes = applyBundle(bundle, 'manual');
        const warnings = listOf(bundle.warnings);
        if (changes.length) {
          toast(`已同步 ${cur.issue.identifier}：${changes.length} 项变化`, 'ok');
        } else if (!silent) {
          toast(`${cur.issue.identifier} 已是最新`, 'ok');
        }
        if (warnings.length) toast(warnings[0], 'err');
        renderAll();
        if (changes.length) afterChange({ reason: 'sync', changes, event: 'multica_sync' });
        return changes;
      } catch (e) {
        if (!silent) toast(`同步失败：${e.message}`, 'err');
        store.patchLink(task.id, { syncError: e.message, lastCheckedAt: new Date().toISOString() });
        renderLink();
        return null;
      } finally {
        busy = false;
        busyButton(btn, false);
      }
    }

    async function writeMemory(btn) {
      const cur = link();
      if (!cur || busy || !writable()) return;
      busy = true;
      busyButton(btn, true, '写入中…');
      try {
        const rows = subtasks().map(s => ({ title: s.title, status: s.status, identifier: s.issue?.identifier || null }));
        const res = await bridge.memory(task, cur.issue.id, rows);
        store.patchLink(task.id, { issue: res.issue || cur.issue, children: res.children || cur.children || [], memoryAt: new Date().toISOString(), warnings: res.warnings || [] });
        store.addEvent(task.id, 'memory_written', { identifier: cur.issue.identifier, subtasks: rows.length, metadata: res.memory?.metadataKeys || [] }, task.agent);
        toast(`记忆已写入 ${cur.issue.identifier}`, 'ok');
        renderAll();
        afterChange({ reason: 'memory', event: 'memory_written' });
      } catch (e) {
        toast(`写入记忆失败：${e.message}`, 'err');
      } finally {
        busy = false;
        busyButton(btn, false);
      }
    }

    async function doLinkCreate(btn) {
      if (busy || !writable()) return;
      busy = true;
      busyButton(btn, true, '关联中…');
      try {
        const res = await bridge.link(task, { mode: 'create' });
        store.setLink(task.id, {
          mode: 'created', issue: res.issue, children: res.children || [], warnings: res.warnings || [],
          memoryAt: new Date().toISOString(), issueId: res.issue.id,
        });
        store.addEvent(task.id, 'multica_linked', {
          mode: 'create', identifier: res.issue.identifier, issueId: res.issue.id,
          title: shortTitle(res.issue.title), url: res.issue.url, warnings: (res.warnings || []).length,
        }, task.agent);
        toast(`已关联 ${res.issue.identifier}`, 'ok');
        renderAll();
        afterChange({ reason: 'link', event: 'multica_linked' });
      } catch (e) {
        toast(`关联失败：${e.message}`, 'err');
      } finally {
        busy = false;
        busyButton(btn, false);
      }
    }

    async function doLinkExisting(btn) {
      if (!selectedIssue || busy || !writable()) return;
      busy = true;
      busyButton(btn, true, '关联中…');
      try {
        const res = await bridge.link(task, { mode: 'existing', issueId: selectedIssue.id });
        store.setLink(task.id, {
          mode: 'existing', issue: res.issue, children: res.children || [], warnings: res.warnings || [],
          memoryAt: new Date().toISOString(), issueId: res.issue.id,
        });
        store.addEvent(task.id, 'multica_linked', {
          mode: 'existing', identifier: res.issue.identifier, issueId: res.issue.id,
          title: shortTitle(res.issue.title), url: res.issue.url, warnings: (res.warnings || []).length,
        }, task.agent);
        applyChildren(res.children || []);
        toast(`已关联 ${res.issue.identifier}`, 'ok');
        selectedIssue = null;
        renderAll();
        afterChange({ reason: 'link', event: 'multica_linked' });
      } catch (e) {
        toast(`关联失败：${e.message}`, 'err');
      } finally {
        busy = false;
        busyButton(btn, false);
      }
    }

    async function parentStatus(btn) {
      const cur = link();
      const sel = host.querySelector('#parent-status');
      if (!cur || !sel || busy || !writable()) return;
      if (sel.value === cur.issue.status) { toast('状态没有变化'); return; }
      busy = true;
      busyButton(btn, true, '更新中…');
      try {
        const bundle = await bridge.updateIssue(cur.issue.id, { status: sel.value });
        const prev = cur.issue.status;
        store.patchLink(task.id, { issue: bundle.issue, children: bundle.children || [], warnings: bundle.warnings || [] });
        store.addEvent(task.id, 'multica_sync', {
          identifier: cur.issue.identifier, source: 'parent-status', children: (bundle.children || []).length,
          changes: [`父 issue 状态 ${statusLabel(prev)} → ${statusLabel(bundle.issue.status)}`],
        }, task.agent);
        applyChildren(bundle.children || []);
        toast(`${cur.issue.identifier} → ${statusLabel(bundle.issue.status)}`, 'ok');
        renderAll();
        afterChange({ reason: 'parent-status', event: 'multica_sync' });
      } catch (e) {
        toast(`更新父 issue 失败：${e.message}`, 'err');
      } finally {
        busy = false;
        busyButton(btn, false);
      }
    }

    async function dispatchSubtask(btn) {
      const cur = link();
      const title = host.querySelector('#st-title')?.value.trim() || '';
      if (!title) { toast('先写子任务标题', 'err'); host.querySelector('#st-title')?.focus(); return; }
      if (!cur || !writable() || busy) return;
      const owner = host.querySelector('#st-owner')?.value.trim() || '';
      const description = host.querySelector('#st-desc')?.value.trim() || '';
      const stage = Number(host.querySelector('#st-stage')?.value || 0) || undefined;
      const initial = host.querySelector('#st-status')?.value || 'todo';
      busy = true;
      busyButton(btn, true, '派发中…');
      try {
        const res = await bridge.subtask(task, cur.issue.id, { title, description, assignee: owner, stage });
        const child = res.issue;
        store.addSubtask(task.id, {
          title, owner, description, status: child.status || initial, issue: child,
        });
        store.patchLink(task.id, {
          children: [...listOf(cur.children), child], warnings: res.warnings || [],
          lastSyncedAt: new Date().toISOString(),
        });
        store.addEvent(task.id, 'multica_subtask', {
          identifier: child.identifier, issueId: child.id, title, owner, parent: cur.issue.identifier,
          stage: stage || null, warnings: (res.warnings || []).length,
        }, task.agent);
        if (child.status && child.status !== initial) {
          store.addEvent(task.id, 'subtask_status', { title, from: initial, to: child.status, identifier: child.identifier }, task.agent);
        }
        toast(`已派发 ${child.identifier}`, 'ok');
        resetSubtaskForm();
        renderAll();
        afterChange({ reason: 'subtask', event: 'multica_subtask' });
      } catch (e) {
        toast(`派发失败：${e.message}`, 'err');
      } finally {
        busy = false;
        busyButton(btn, false);
      }
    }

    function resetSubtaskForm() {
      const t = host.querySelector('#st-title'), d = host.querySelector('#st-desc'), st = host.querySelector('#st-stage');
      if (t) t.value = '';
      if (d) d.value = '';
      if (st) st.value = '';
    }

    function localSubtask(btn) {
      const title = host.querySelector('#st-title')?.value.trim() || '';
      if (!title) { toast('先写子任务标题', 'err'); host.querySelector('#st-title')?.focus(); return; }
      const owner = host.querySelector('#st-owner')?.value.trim() || '';
      const description = host.querySelector('#st-desc')?.value.trim() || '';
      const status = host.querySelector('#st-status')?.value || 'todo';
      store.addSubtask(task.id, { title, owner, description, status });
      store.addEvent(task.id, 'subtask_created', { title, owner, status, local: true }, task.agent);
      toast('已记录到本地', 'ok');
      resetSubtaskForm();
      renderSubtasks();
      renderMemory();
      afterChange({ reason: 'subtask-local', event: 'subtask_created' });
      if (btn) btn.blur();
    }

    async function changeSubtaskStatus(id, next) {
      const row = subtasks().find(s => s.id === id);
      if (!row || row.status === next) return;
      const prev = row.status;
      store.updateSubtask(task.id, id, { status: next });
      store.addEvent(task.id, 'subtask_status', {
        title: row.title, from: prev, to: next, identifier: row.issue?.identifier || null,
      }, task.agent);
      if (row.issue && writable()) {
        try {
          const bundle = await bridge.updateIssue(row.issue.id, { status: next });
          const child = bundle.issue;
          store.updateSubtask(task.id, id, { issue: child, status: child.status, syncedAt: new Date().toISOString() });
          store.patchLink(task.id, { warnings: bundle.warnings || [] });
          toast(`${child.identifier} → ${statusLabel(child.status)}`, 'ok');
        } catch (e) {
          toast(`Multica 更新失败：${e.message}（本地已改）`, 'err');
        }
      }
      renderSubtasks();
      renderMemory();
      afterChange({ reason: 'subtask-status', event: 'subtask_status' });
    }

    function removeSubtask(id) {
      const row = subtasks().find(s => s.id === id);
      if (!row) return;
      store.removeSubtask(task.id, id);
      store.addEvent(task.id, 'subtask_removed', {
        title: row.title, identifier: row.issue?.identifier || null, remoteKept: !!row.issue,
      }, task.agent);
      toast(row.issue ? '已从本地移除，Multica child issue 保留' : '已移除本地子任务', 'ok');
      renderSubtasks();
      renderMemory();
      afterChange({ reason: 'subtask-removed', event: 'subtask_removed' });
    }

    async function searchIssues(btn) {
      const q = host.querySelector('#issue-q')?.value.trim() || '';
      const box = host.querySelector('#issue-results');
      if (!box) return;
      lastSearch = q;
      box.innerHTML = '<div class="mini-empty">搜索中…</div>';
      busyButton(btn, true, '搜索中…');
      try {
        const rows = await bridge.issues(q, 20);
        if (lastSearch !== q) return;
        box.innerHTML = rows.length ? rows.map(issueRow).join('') : '<div class="mini-empty">没有找到父 issue</div>';
        box.querySelectorAll('[data-pick]').forEach(btn => {
          btn.addEventListener('click', () => {
            selectedIssue = rows.find(x => x.id === btn.dataset.pick) || null;
            box.querySelectorAll('.issue-result').forEach(el => el.classList.toggle('selected', el.dataset.issueId === btn.dataset.pick));
            const confirm = host.querySelector('[data-act="link-existing"]');
            if (confirm) confirm.disabled = !selectedIssue;
          });
        });
      } catch (e) {
        box.innerHTML = `<div class="mini-empty err">${esc(e.message)}</div>`;
      } finally {
        busyButton(btn, false);
      }
    }

    function issueRow(x) {
      return `<button class="issue-result" type="button" data-pick="${esc(x.id)}" data-issue-id="${esc(x.id)}">
        <span class="ir-id">${esc(x.identifier)}</span>
        ${statusBadge(x.status)}
        <span class="ir-title">${esc(shortTitle(x.title))}</span>
        <span class="ir-meta">${x.assigneeName ? esc(x.assigneeName) : '未分配'}</span>
      </button>`;
    }

    function bindLink() {
      const act = (name, fn) => host.querySelector(`[data-act="${name}"]`)?.addEventListener('click', e => fn(e.currentTarget, e));
      act('link-create', btn => doLinkCreate(btn));
      act('toggle-existing', () => {
        const box = host.querySelector('#existing-box');
        if (!box) return;
        box.hidden = false;
        const q = host.querySelector('#issue-q');
        if (q) q.focus();
        if (!box.dataset.loaded) {
          box.dataset.loaded = '1';
          searchIssues();
        }
      });
      act('issue-search', btn => searchIssues(btn));
      act('link-existing', btn => doLinkExisting(btn));
      act('sync', btn => syncNow(btn, false));
      act('memory', btn => writeMemory(btn));
      act('parent-status', btn => parentStatus(btn));
      act('unlink', () => {
        store.clearLink(task.id);
        store.addEvent(task.id, 'multica_sync', {
          identifier: 'local', source: 'unlink', changes: ['解除本地关联（未删除 Multica issue）'],
        }, task.agent);
        toast('已解除本地关联，Multica issue 未删除', 'ok');
        renderAll();
        afterChange({ reason: 'unlink', event: 'multica_sync' });
      });
      const issueQ = host.querySelector('#issue-q');
      if (issueQ) {
        issueQ.addEventListener('input', () => {
          clearTimeout(searchTimer);
          searchTimer = setTimeout(() => searchIssues(), 280);
        });
        issueQ.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); searchIssues(); } });
      }
    }

    function bindSubtasks() {
      host.querySelector('[data-act="subtask-local"]')?.addEventListener('click', e => localSubtask(e.currentTarget));
      host.querySelector('[data-act="subtask-dispatch"]')?.addEventListener('click', e => dispatchSubtask(e.currentTarget));
      host.querySelectorAll('[data-status-id]').forEach(sel => {
        sel.addEventListener('change', () => changeSubtaskStatus(sel.dataset.statusId, sel.value));
      });
      host.querySelectorAll('[data-remove-id]').forEach(btn => {
        btn.addEventListener('click', () => removeSubtask(btn.dataset.removeId));
      });
    }

    async function loadAgents() {
      if (!writable() || agentList) return;
      try {
        agentList = await bridge.agents();
        const list = host.querySelector('#multica-agent-list');
        if (list) list.innerHTML = agentList.slice(0, 200).map(a => `<option value="${esc(a.name)}"></option>`).join('');
      } catch { /* 不阻塞手动输入 */ }
    }

    renderAll();
    if (ctx.bridgeStatusPromise) {
      ctx.bridgeStatusPromise.then(st => {
        bridgeState = st;
        renderAll();
        loadAgents();
      }).catch(() => {});
    } else {
      loadAgents();
    }

    return {
      syncNow: (silent = true) => syncNow(null, silent),
      refresh: () => renderAll(),
      destroy: () => { clearTimeout(searchTimer); host.innerHTML = ''; },
      get link() { return link(); },
    };
  }

  window.RunnerCollab = { mount, statusLabel };
})();
