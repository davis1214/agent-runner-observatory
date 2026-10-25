/* Agent Runner · 本地状态（关联、子任务、合成事件）
 * 只存浏览器 localStorage；不包含 Multica token。
 */
(function () {
  'use strict';
  const KEY = 'agentRunner.state.v2';
  const EMPTY = () => ({ version: 2, links: {}, subtasks: {}, events: {}, versions: {} });
  let memory = null;

  function read() {
    if (memory) return memory;
    try {
      const raw = localStorage.getItem(KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      memory = parsed && parsed.version === 2 ? parsed : EMPTY();
    } catch { memory = EMPTY(); }
    for (const k of ['links', 'subtasks', 'events', 'versions']) if (!memory[k]) memory[k] = {};
    return memory;
  }

  function write() {
    try { localStorage.setItem(KEY, JSON.stringify(memory)); } catch {}
    window.dispatchEvent(new CustomEvent('agent-runner:changed'));
  }

  const uid = () => (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : 'id-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const now = () => new Date().toISOString();
  const version = taskId => read().versions[taskId] || 0;
  const bump = taskId => { read().versions[taskId] = version(taskId) + 1; };

  function linkFor(taskId) { return read().links[taskId] || null; }
  function setLink(taskId, link) {
    read().links[taskId] = { ...link, linkedAt: link.linkedAt || now(), lastSyncedAt: now() };
    bump(taskId); write();
    return read().links[taskId];
  }
  function patchLink(taskId, patch) {
    const cur = linkFor(taskId);
    if (!cur) return null;
    read().links[taskId] = { ...cur, ...patch, lastSyncedAt: patch.lastSyncedAt || now() };
    bump(taskId); write();
    return read().links[taskId];
  }
  function clearLink(taskId) {
    delete read().links[taskId];
    bump(taskId); write();
  }

  function subtasksFor(taskId) { return (read().subtasks[taskId] || []).slice(); }
  function addSubtask(taskId, item) {
    const row = {
      id: uid(), title: String(item.title || '').trim(), owner: String(item.owner || '').trim(),
      description: String(item.description || ''), status: item.status || 'todo',
      createdAt: now(), issue: item.issue || null, syncedAt: item.issue ? now() : null,
    };
    if (!read().subtasks[taskId]) read().subtasks[taskId] = [];
    read().subtasks[taskId].push(row);
    bump(taskId); write();
    return row;
  }
  function updateSubtask(taskId, id, patch) {
    const rows = read().subtasks[taskId] || [];
    const i = rows.findIndex(x => x.id === id);
    if (i < 0) return null;
    rows[i] = { ...rows[i], ...patch };
    if (patch.issue) rows[i].syncedAt = now();
    bump(taskId); write();
    return rows[i];
  }
  function removeSubtask(taskId, id) {
    read().subtasks[taskId] = (read().subtasks[taskId] || []).filter(x => x.id !== id);
    bump(taskId); write();
  }

  function eventsFor(taskId) { return (read().events[taskId] || []).slice(); }

  function addEvent(taskId, type, data, src = 'main') {
    const list = read().events[taskId] || (read().events[taskId] = []);
    const seq = 100000 + list.length;
    const ev = { ts: now(), seq, src, type, data: data || {}, synthetic: true };
    list.push(ev);
    if (list.length > 200) list.splice(0, list.length - 200);
    bump(taskId); write();
    return ev;
  }

  function memoryBlock(task, link, subtasks) {
    const lines = [
      '## Agent Runner 关联记忆',
      `- task_id: ${task.id}`,
      `- runner_agent: ${task.agent || '—'}`,
      `- repo: ${task.repo || '—'}`,
      `- multica_issue: ${link.issue.identifier}`,
      `- issue_status: ${link.issue.status}`,
      `- task_dir: 01-raw/05-tasks/2026-10-25-agent-router-observatory`,
      '',
      '子任务进度：',
    ];
    if (!subtasks.length) lines.push('- 暂无本地派发记录');
    for (const s of subtasks) lines.push(`- [${s.status}] ${s.title}${s.issue ? ` · ${s.issue.identifier}` : ' · 仅本地'}`);
    lines.push('', '更新方式：在 Multica 创建/更新 child issue，并保持 runner_parent_task_id 元数据；Agent Runner 会轮询刷新。');
    return lines.join('\n');
  }

  window.RunnerStore = {
    linkFor, setLink, patchLink, clearLink,
    subtasksFor, addSubtask, updateSubtask, removeSubtask,
    eventsFor, addEvent, version, memoryBlock,
    _read: read,
  };
})();
