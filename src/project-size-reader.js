// Only measure project roots under an allowlist (default ~/code, override with
// CODEX_BADGE_SIZE_ROOTS). Walking home, cloud-synced or network folders can trigger
// file-provider downloads or remote traffic even when only metadata is read.
function sizeRootStatus(root) {
  const fs = require('node:fs');
  const path = require('node:path');
  let real;
  try { real = fs.realpathSync(root); } catch { return 'missing'; }
  const bases = (process.env.CODEX_BADGE_SIZE_ROOTS || path.join(require('node:os').homedir(), 'code')).split(path.delimiter).filter(Boolean);
  return bases.some(base => {
    try { const allowed = fs.realpathSync(base); return real === allowed || real.startsWith(allowed + path.sep); }
    catch { return false; }
  }) ? 'allowed' : 'outside';
}

function measureDirectory(root, { timeoutMs = 180000, signal } = {}) {
  if (signal?.aborted) return Promise.reject(new Error('扫描已停止'));
  const status = sizeRootStatus(root);
  if (status === 'missing') return Promise.reject(new Error('项目路径不可用'));
  if (status === 'outside') return Promise.reject(new Error('仅统计允许目录（默认 ~/code）下的本地项目'));
  if (process.platform === 'win32') return measureDirectoryPortable(root, { timeoutMs, signal });
  return new Promise((resolve, reject) => {
    const { spawn } = require('node:child_process');
    const command = process.platform === 'darwin' ? '/usr/bin/du' : 'du';
    const child = spawn(command, ['-skx', root], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '', stderr = '', settled = false;
    const finish = (error, bytes) => {
      if (settled) return; settled = true; clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      if (error) reject(error); else resolve(bytes);
    };
    const timer = setTimeout(() => { child.kill('SIGTERM'); finish(new Error('计算超时')); }, timeoutMs);
    const cancel = () => { child.kill('SIGTERM'); finish(new Error('扫描已停止')); };
    signal?.addEventListener('abort', cancel, {once: true});
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { if (stdout.length < 65536) stdout += chunk; });
    child.stderr.on('data', chunk => { if (stderr.length < 4096) stderr += chunk; });
    child.once('error', error => finish(error));
    child.once('close', code => {
      const match = /^\s*(\d+)/.exec(stdout);
      const kib = match ? Number(match[1]) : NaN;
      if (code === 0 && Number.isSafeInteger(kib) && kib >= 0) finish(null, kib * 1024);
      else finish(new Error('无法计算文件夹占用，请检查路径和访问权限'));
    });
  });
}

async function measureDirectoryPortable(root, { timeoutMs = 180000, signal } = {}) {
  const fs = require('node:fs/promises');
  const deadline = Date.now() + timeoutMs;
  const queue = [root];
  let bytes = 0;
  while (queue.length) {
    signal?.throwIfAborted();
    if (Date.now() > deadline) throw new Error('计算超时');
    const current = queue.pop();
    let entries;
    entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const file = require('node:path').join(current, entry.name);
      if (entry.isDirectory()) queue.push(file);
      else if (entry.isFile()) {
        const stat = await fs.stat(file);
        if (Number.isSafeInteger(stat.size) && stat.size >= 0) bytes += stat.size;
      }
    }
  }
  return bytes;
}

async function measureProjectRoots(roots, {timeoutMs = 180000, signal} = {}) {
  let bytes = 0;
  const deadline = Date.now() + timeoutMs;
  for (const root of roots) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('计算超时');
    bytes += await measureDirectory(root, {timeoutMs: remaining, signal});
  }
  return bytes;
}

class ProjectSizeScanner {
  constructor({ cacheTtlMs = 300000, errorTtlMs = 30000, concurrency = 2, timeoutMs = 180000, measure = measureProjectRoots, now = Date.now } = {}) {
    this.cacheTtlMs = cacheTtlMs;
    this.errorTtlMs = errorTtlMs;
    this.concurrency = Math.max(1, Math.min(8, concurrency));
    this.timeoutMs = timeoutMs;
    this.measure = measure;
    this.now = now;
    this.cache = new Map();
    this.pending = new Map();
    this.queue = [];
    this.running = 0;
    this.controllers = new Set();
    this.idleWaiters = [];
    this.onChange = null;
    this.stopped = false;
  }
  normalize(projects) {
    const path = require('node:path');
    const result = [];
    const seen = new Set();
    for (const project of Array.isArray(projects) ? projects.slice(0, 200) : []) {
      const id = project?.id;
      if (typeof id !== 'string' || !id || id.length > 512 || seen.has(id)) continue;
      seen.add(id);
      const roots = [...new Set((Array.isArray(project.roots) ? project.roots : []).filter(root => typeof root === 'string' && root.length <= 4096 && path.isAbsolute(root)).slice(0, 8))].sort();
      result.push({ id, roots, key: roots.join('\0') });
    }
    return result;
  }
  snapshot(projects) {
    const checkedAt = this.now();
    const sizes = Object.create(null);
    for (const project of this.normalize(projects)) {
      if (!project.roots.length) { sizes[project.id] = { state: 'unavailable', message: '项目路径不可用', roots: [] }; continue; }
      const cached = this.cache.get(project.key);
      const ttl = cached?.state === 'error' ? this.errorTtlMs : this.cacheTtlMs;
      const stale = !cached || checkedAt - cached.scannedAt >= ttl;
      if (stale) this.enqueue(project.key, project.roots);
      if (!cached) sizes[project.id] = { state: 'pending', roots: project.roots };
      else sizes[project.id] = { ...cached, roots: project.roots, stale };
    }
    return { ok: !this.stopped, sizes, checkedAt };
  }
  enqueue(key, roots) {
    if (this.stopped || this.pending.has(key)) return;
    this.pending.set(key, true); this.queue.push({ key, roots }); this.drain();
  }
  drain() {
    while (!this.stopped && this.running < this.concurrency && this.queue.length) {
      const job = this.queue.shift(); this.running++;
      const controller = new AbortController(); this.controllers.add(controller);
      Promise.resolve().then(() => {
        if (this.stopped) throw new Error('扫描已停止');
        return this.measure(job.roots, { timeoutMs: this.timeoutMs, signal: controller.signal });
      }).then(bytes => {
        if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('文件夹大小无效');
        if (!this.stopped) this.cache.set(job.key, { state: 'ready', bytes, scannedAt: this.now() });
      }).catch(error => {
        if (!this.stopped) this.cache.set(job.key, { state: 'error', message: error?.message || '计算失败', scannedAt: this.now() });
      }).finally(() => {
        this.controllers.delete(controller);
        this.running--; this.pending.delete(job.key);
        try { this.onChange?.(); } catch {}
        this.drain(); this.resolveIdle();
      });
    }
    this.resolveIdle();
  }
  resolveIdle() {
    if (this.running || this.queue.length || this.pending.size) return;
    for (const resolve of this.idleWaiters.splice(0)) resolve();
  }
  whenIdle() {
    if (!this.running && !this.queue.length && !this.pending.size) return Promise.resolve();
    return new Promise(resolve => this.idleWaiters.push(resolve));
  }
  stop() {
    this.stopped = true; this.queue.length = 0; this.pending.clear();
    for (const controller of this.controllers) controller.abort();
    this.resolveIdle();
  }
}

async function refreshProjectSizes(injector, scanner) {
  const sessions = [...injector.sessions.values()];
  if (!sessions.length) return;
  const requests = await Promise.all(sessions.map(async session => {
    try {
      const result = await session.evaluate('window.__codexProjectSizes?.requestedProjects() ?? []');
      const projects = result?.result?.value;
      return { session, projects: Array.isArray(projects) ? projects : [] };
    } catch { return { session, projects: [] }; }
  }));
  await Promise.all(requests.map(async ({ session, projects }) => {
    try { await session.evaluate(`window.__codexProjectSizes?.update(${JSON.stringify(scanner.snapshot(projects))})`); } catch {}
  }));
}
