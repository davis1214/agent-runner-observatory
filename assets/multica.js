/* Agent Runner · 本地 Multica 桥接客户端
 * 只访问同源 /api/bridge/*；token 永远留在本机 serve.mjs 进程内。
 * file:// 模式下没有桥接，直接降级为离线，不发起请求（避免控制台噪音）。
 */
(function () {
  'use strict';

  /* 相对路径：既支持根路径部署，也支持 http://localhost/agent-runner/ 子路径。 */
  const BASE = 'api/bridge';
  const FILE_MODE = location.protocol === 'file:';
  const OFFLINE_REASON = FILE_MODE
    ? 'file:// 模式没有本地桥接；用 node scripts/serve.mjs 启动后再打开'
    : '本地桥接未启动；先运行 scripts/service.sh start，再从 http://agent-runner.localhost/ 或 http://localhost/agent-runner/ 打开';

  class BridgeError extends Error {
    constructor(message, status) {
      super(message);
      this.name = 'BridgeError';
      this.status = status || 0;
    }
  }

  async function call(path, options = {}) {
    if (FILE_MODE) throw new BridgeError(OFFLINE_REASON, 0);
    const { timeout = 40_000, ...rest } = options;
    let res;
    try {
      res = await fetch(BASE + path, {
        cache: 'no-store',
        ...rest,
        headers: { 'Content-Type': 'application/json', ...(rest.headers || {}) },
        signal: AbortSignal.timeout(timeout),
      });
    } catch (e) {
      const reason = e && e.name === 'AbortError' ? '桥接请求超时' : '连不上本地桥接';
      throw new BridgeError(`${reason}：${e && e.message ? e.message : 'network error'}`, 0);
    }
    let body = null;
    try { body = await res.json(); } catch { /* 非 JSON 响应 */ }
    if (!res.ok) throw new BridgeError(body && body.error ? body.error : `桥接返回 HTTP ${res.status}`, res.status);
    return body;
  }

  function taskPayload(task) {
    return { id: task.id, title: task.title, agent: task.agent || '', repo: task.repo || '' };
  }

  async function status() {
    if (FILE_MODE) {
      return { ok: false, bridge: 'offline', reason: OFFLINE_REASON, fileMode: true, multica: { online: false } };
    }
    try {
      return await call('/status', { timeout: 5000 });
    } catch (e) {
      return { ok: false, bridge: 'offline', reason: e.message, fileMode: false, multica: { online: false } };
    }
  }

  async function agents() {
    const data = await call('/agents');
    return Array.isArray(data && data.agents) ? data.agents : [];
  }

  async function issues(q = '', limit = 20) {
    const qs = new URLSearchParams();
    if (q) qs.set('q', q);
    qs.set('limit', String(limit));
    const data = await call('/issues?' + qs.toString());
    return Array.isArray(data && data.issues) ? data.issues : [];
  }

  const issue = id => call('/issue/' + encodeURIComponent(id));

  const link = (task, options = {}) => call('/link', {
    method: 'POST',
    body: JSON.stringify({
      task: taskPayload(task),
      mode: options.mode === 'existing' ? 'existing' : 'create',
      issueId: options.issueId || undefined,
    }),
  });

  const subtask = (task, parentIssueId, payload = {}) => call('/subtask', {
    method: 'POST',
    body: JSON.stringify({
      task: taskPayload(task),
      parentIssueId,
      title: payload.title || '',
      description: payload.description || '',
      assignee: payload.assignee || '',
      stage: payload.stage || undefined,
    }),
  });

  const updateIssue = (id, patch = {}) => call('/issue/' + encodeURIComponent(id), {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });

  const memory = (task, issueId, subtasks = []) => call('/memory', {
    method: 'POST',
    body: JSON.stringify({ task: taskPayload(task), issueId, subtasks }),
  });

  window.RunnerMultica = {
    status, agents, issues, issue, link, subtask, updateIssue, memory,
    BridgeError, OFFLINE_REASON, fileMode: FILE_MODE,
  };
})();
