/**
 * dsh-session-delete — delete sessions for real.
 *
 * DSH ships archive/unarchive but no deletion: the persistence seam has no
 * delete method, archived logs stay on disk, and the project-local session
 * folder (for example <cwd>/会话/<date>-<topic>-<host>-<hash>) is never
 * touched. This plugin removes all three sides of a session:
 *
 *  - Session storage: <sessionPersistence.root>/<workspace-slug>/<id>
 *  - Workspace registry: detachSession(id) + drop from archivedSessionIds
 *  - Project folder: <cwd>/<configured folder names>/... whose .session.json
 *    carries thread_id === sessionId (the id DSH exports as DSH_SESSION_ID)
 *
 * Host commands: /list-sessions, /delete-session <id>, /purge-archived
 * Web route:     POST /api/session.delete  { sessionId }
 * @module dsh-session-delete
 */
import { appendFile, readdir, readFile, rm, stat, lstat, realpath, rename } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join, resolve, relative, isAbsolute, basename } from 'node:path'
import { homedir } from 'node:os'
import { deleting, guardIdleSession, installLifecycle } from './lifecycle.js'

export const name = 'session-delete'

export const inject = ['commands', 'sessionPersistence', 'workspaceRegistry', 'agents', 'agentLoop', 'sessions', 'connection']

const ROUTE_PATH = '/api/session.delete'
const USAGE = '用法：/delete-session <sessionId>，或 /purge-archived 清空所有已归档会话'

/** Folder names inside a project where per-session working directories live. */
const DEFAULT_SESSION_FOLDERS = ['会话']

function sessionsRoot(ctx) {
  const root = ctx.sessionPersistence?.root
  if (typeof root !== 'string' || root.length === 0) {
    throw new Error('无法定位会话存储目录：sessionPersistence.root 不可用')
  }
  return root
}

function validSessionId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(value) || value === '.' || value === '..') {
    throw new Error('无效会话 ID：必须是单个会话标识，不能包含路径')
  }
  return value
}
function within(root, target) {
  const rel = relative(resolve(root), resolve(target))
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + (process.platform === 'win32' ? '\\' : '/')) && !isAbsolute(rel)
}
async function plainDirectory(root, target) {
  if (!within(root, target)) throw new Error('目录超出允许范围')
  const info = await lstat(target)
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('拒绝删除联接、符号链接或非目录')
  const canonicalRoot = await realpath(root), canonicalTarget = await realpath(target)
  if (!within(canonicalRoot, canonicalTarget)) throw new Error('目录解析后超出允许范围')
  return canonicalTarget
}

/** Find <root>/<workspace-slug>/<sessionId> directories for one id. */
async function sessionDirectories(root, sessionId) {
  validSessionId(sessionId)
  const found = []
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return found
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue
    await plainDirectory(root, join(root, entry.name))
    const candidate = join(root, entry.name, sessionId)
    try {
      await plainDirectory(root, candidate)
      found.push(candidate)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }
  return found
}

/** Read the JSONL header line of a stored session, if present. */
async function readHeader(ctx, sessionId) {
  validSessionId(sessionId)
  return (await ctx.sessionPersistence.stat(sessionId))?.header
}

/** Read .session.json inside one candidate folder and return its thread_id. */
async function folderThreadId(dir) {
  try {
    const parsed = JSON.parse((await readFile(join(dir, '.session.json'), 'utf8')).replace(/^\uFEFF/, ''))
    if (parsed.provider !== 'dsh') return undefined
    return typeof parsed.thread_id === 'string' ? parsed.thread_id : undefined
  } catch { return undefined }
}

/**
 * Project-local working folders created for this session. Matches on the
 * .session.json thread_id, so renamed or duplicated topic titles stay safe.
 */
async function localSessionFolders(cwd, sessionId, names) {
  const found = []
  if (typeof cwd !== 'string' || cwd.length === 0) return found
  for (const name of names) {
    if (typeof name !== 'string' || !name || name === '.' || name === '..' || basename(name) !== name || name.includes('\\') || name.includes('/')) throw new Error('无效的会话目录名')
    const base = join(cwd, name)
    let entries
    try {
      await plainDirectory(cwd, base)
      entries = await readdir(base, { withFileTypes: true })
    } catch (error) {
      if (error?.code === 'ENOENT') continue
      throw error
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const dir = join(base, entry.name)
      if ((await folderThreadId(dir)) === sessionId) { await plainDirectory(base, dir); found.push(dir) }
    }
  }
  return found
}

async function detachFromWorkspaces(ctx, sessionId) {
  const registry = ctx.workspaceRegistry
  for (const workspace of registry.list()) {
    if (workspace.sessionIds.includes(sessionId)) await workspace.detachSession(sessionId)
  }
  await registry.unarchiveSession(sessionId)
  if (registry.unpinSession) await registry.unpinSession(sessionId)
}

/** Preflight, take the native writer lease, stage atomically, then remove only staged paths. */
export async function deleteSession(ctx, sessionId, folders = DEFAULT_SESSION_FOLDERS) {
  const id = validSessionId(typeof sessionId === 'string' ? sessionId.trim() : sessionId)
  if (deleting.has(id)) throw new Error('该会话正在删除')
  const root = sessionsRoot(ctx), staged = []
  let handle, guard, committed = false
  const registry = ctx.workspaceRegistry
  const memberships = registry.list().filter(w => w.sessionIds.includes(id))
  const archived = registry.archivedSessionIds.includes(id)
  const pinned = (registry.pinnedSessionIds ?? []).includes(id)
  deleting.add(id)
  try {
    guard = guardIdleSession(ctx, id)
    const header = await readHeader(ctx, id)
    if (!header || header.id !== id) throw new Error('未找到该会话的有效存储')
    const dirs = await sessionDirectories(root, id)
    if (dirs.length !== 1) throw new Error('会话存储不唯一或不存在，拒绝猜测删除')
    const local = await localSessionFolders(header.cwd, id, folders)
    // Release only a quiescent target through its original native handle.
    await guard.release()
    // The native lease also refuses a writer held by another DSH process.
    handle = await ctx.sessionPersistence.open(id, 'write')
    if (handle.header.id !== id || ctx.agents.get(id) !== undefined) throw new Error('会话状态已变化，请稍后再试')
    for (const source of [...dirs, ...local]) {
      await plainDirectory(dirs.includes(source) ? root : header.cwd, source)
      const temporary = join(source, '..', '.dsh-delete-' + randomUUID())
      if (!within(dirs.includes(source) ? root : header.cwd, temporary)) throw new Error('暂存目录超出范围')
      await rename(source, temporary)
      staged.push({ source, temporary })
    }
    await handle.close(); handle = undefined
    await detachFromWorkspaces(ctx, id)
    committed = true
    const failures = []
    for (const item of staged) {
      try { await rm(item.temporary, { recursive: true, force: false }) }
      catch (error) { failures.push(item.temporary + ': ' + String(error)) }
    }
    if (failures.length) throw new Error('会话已从列表移除，但暂存目录清理失败：' + failures.join('; '))
    return { dirs, local }
  } catch (error) {
    if (!committed) {
      const failures = []
      for (const item of [...staged].reverse()) {
        try { await rename(item.temporary, item.source) } catch (rollback) { failures.push(String(rollback)) }
      }
      for (const workspace of memberships) {
        try { if (!workspace.sessionIds.includes(id)) await workspace.attachSession(id) } catch (rollback) { failures.push(String(rollback)) }
      }
      try {
        if (archived && !registry.archivedSessionIds.includes(id)) await registry.archiveSession(id)
        if (pinned && !(registry.pinnedSessionIds ?? []).includes(id)) await registry.pinSession(id)
      } catch (rollback) { failures.push(String(rollback)) }
      if (failures.length) throw new AggregateError([error, ...failures], '删除失败且部分回滚失败；请保留暂存目录：' + staged.map(x=>x.temporary).join('; '))
    }
    throw error
  } finally {
    try { await handle?.close() } finally { guard?.restore(); deleting.delete(id) }
  }
}

async function listSessions(ctx) {
  const archived = new Set(ctx.workspaceRegistry.archivedSessionIds)
  const snapshots = await ctx.sessionPersistence.list()
  const rows = []
  for (const snapshot of snapshots.slice(0, 200)) {
    const header = snapshot.header
    let title = '(无标题)'
    let handle
    try {
      handle = await ctx.sessionPersistence.open(header.id, 'read')
      const { events } = await handle.read()
      const last = events.findLast(event => event.type === 'session/title')
      title = last?.data?.title ?? title
    } finally { await handle?.close() }
    rows.push({ id: header.id, title, archived: archived.has(header.id), cwd: header.cwd ?? '' })
  }
  return rows
}

async function purgeArchived(ctx, folders) {
  const archived = [...(ctx.workspaceRegistry?.archivedSessionIds ?? [])]
  const deleted = []
  const failed = []
  for (const id of archived) {
    try {
      await deleteSession(ctx, id, folders)
      deleted.push(id)
    } catch (error) {
      failed.push(id + ': ' + (error instanceof Error ? error.message : String(error)))
    }
  }
  return { deleted, failed }
}

/** Append one diagnostic line to ~/.dsh/session-delete.log (best effort). */
async function trace(message) {
  if (process.env.DSH_SESSION_DELETE_TRACE === '0') return
  try {
    await appendFile(join(homedir(), '.dsh', 'session-delete.log'), new Date().toISOString() + ' ' + message + '\n')
  } catch {
    // diagnostics must never break plugin loading
  }
}

export function apply(ctx, config = {}) {
  void trace('apply pid=' + process.pid)
  ctx.effect(() => installLifecycle(ctx), 'session-delete native lifecycle ownership')
  const folders = Array.isArray(config.sessionFolders) && config.sessionFolders.length > 0
    ? config.sessionFolders
    : DEFAULT_SESSION_FOLDERS

  ctx.effect(function* () {
    yield ctx.commands.register({
      name: 'list-sessions',
      description: '列出所有已存储会话的 id、标题与归档状态',
      handler: async () => {
        try {
          const rows = await listSessions(ctx)
          if (rows.length === 0) return { kind: 'success', text: '没有找到已存储的会话' }
          return {
            kind: 'success',
            text: rows.map((row) => (row.archived ? '[归档] ' : '       ') + row.id + '  ' + row.title).join('\n')
          }
        } catch (error) {
          return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
        }
      }
    })
    yield ctx.commands.register({
      name: 'delete-session',
      description: '删除指定会话：存储、工作区记录与项目内会话文件夹，不可恢复',
      handler: async (invocation) => {
        try {
          const id = invocation.rawInput.trim()
          const { dirs, local } = await deleteSession(ctx, id, folders)
          if (dirs.length === 0 && local.length === 0) {
            return { kind: 'error', text: '未找到会话 ' + id + ' 的任何存储' }
          }
          return { kind: 'success', text: '已删除 ' + id + '：会话存储 ' + dirs.length + ' 处，本地文件夹 ' + local.length + ' 个' }
        } catch (error) {
          return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
        }
      }
    })
    yield ctx.commands.register({
      name: 'purge-archived',
      description: '删除所有已归档会话（存储 + 工作区记录 + 本地文件夹），不可恢复',
      handler: async () => {
        const { deleted, failed } = await purgeArchived(ctx, folders)
        if (deleted.length === 0 && failed.length === 0) return { kind: 'success', text: '没有已归档会话需要删除' }
        const lines = ['已删除 ' + deleted.length + ' 个归档会话']
        if (failed.length > 0) lines.push('失败 ' + failed.length + ' 个：', ...failed)
        return { kind: failed.length > 0 ? 'error' : 'success', text: lines.join('\n') }
      }
    })
  }, 'session-delete commands')

  void trace('commands registered')
  const connection = ctx.connection
  void trace('connection=' + (connection === undefined ? 'undefined' : typeof connection))
  if (connection?.fetch?.register !== undefined) {
    ctx.effect(() => connection.fetch.register({
      path: ROUTE_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        try {
          const body = await request.json()
          const id = typeof body?.sessionId === 'string' ? body.sessionId : ''
          const result = await deleteSession(ctx, id, folders)
          return Response.json({ ok: true, sessionId: id, dirs: result.dirs.length, local: result.local })
        } catch (error) {
          return Response.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, { status: 400 })
        }
      }
    }), 'session-delete: web route')
  }
}
