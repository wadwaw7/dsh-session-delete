/** Exact native AgentHandle ownership, scoped to this plugin's lifetime. */
const owners = new WeakMap()
export const deleting = new Set()

function factoryOf(ctx) {
  return ctx.agents.requireFactory().target
}

export function installLifecycle(ctx) {
  const factory = factoryOf(ctx)
  if (owners.has(factory)) throw new Error('会话删除生命周期已注册')
  const state = { handles: new WeakMap(), pending: new Map() }
  const undo = []
  try {
    for (const method of ['createAgent', 'resume']) {
      const original = factory[method]
      if (typeof original !== 'function') throw new Error('宿主缺少原生会话生命周期接口')
      const descriptor = Object.getOwnPropertyDescriptor(factory, method)
      const wrapped = async function (ownerCtx, options) {
        const id = method === 'resume' ? options.resumeSessionId : options.sessionId
        if (deleting.has(id)) throw new Error('目标会话正在删除，暂不能加载')
        state.pending.set(id, (state.pending.get(id) ?? 0) + 1)
        try {
          // Preserve the caller-traced receiver and exact native owner context.
          const handle = await Reflect.apply(original, this, [ownerCtx, options])
          state.handles.set(handle.agent, handle)
          return handle
        } finally {
          const count = state.pending.get(id) - 1
          if (count) state.pending.set(id, count)
          else state.pending.delete(id)
        }
      }
      Object.defineProperty(factory, method, { value: wrapped, configurable: true, writable: true })
      undo.push(() => {
        if (factory[method] !== wrapped) return
        if (descriptor) Object.defineProperty(factory, method, descriptor)
        else delete factory[method]
      })
    }
    owners.set(factory, state)
  } catch (error) {
    for (const restore of undo.reverse()) restore()
    throw error
  }
  return () => {
    for (const restore of undo.reverse()) restore()
    if (owners.get(factory) === state) owners.delete(factory)
  }
}

function assertIdle(agent) {
  if (agent.status === 'running') throw new Error('目标会话正在运行，不能删除；请等待它完成')
  if (agent.status !== 'idle' || agent.phase?.kind !== 'idle' || agent.inbox?.hasPending !== false) {
    throw new Error('会话已加载且仍有维护或排队工作，暂不能删除')
  }
}

/**
 * Whether this agent is a root Session rather than a subagent of another task.
 * dsh 0.2.2 dropped ctx.agents.roots(); the durable Session header carries the
 * relationship instead, so both signals are checked and absence means root.
 */
function isRootAgent(ctx, agent, id) {
  // 优先读 live Session 的 header；取不到时退回 agent 自身字段。
  let header;
  try { header = ctx.sessions?.get?.(id)?.header } catch { header = undefined }
  const origin = header?.origin ?? agent?.origin;
  const parent = header?.parentSession ?? agent?.parentSession;
  if (origin === 'subagent') return false;
  if (typeof parent === 'string' && parent.length > 0 && parent !== id) return false;
  return true;
}

/** Prevent target wakeups while preflight and native teardown cross awaits. */
export function guardIdleSession(ctx, id) {
  let state
  try { state = owners.get(factoryOf(ctx)) } catch { /* Unknown ownership fails closed below. */ }
  if (state?.pending.has(id)) throw new Error('目标会话正在加载，暂不能删除')
  const agent = ctx.agents.get(id)
  const undo = []
  let handle
  if (agent !== undefined) {
    assertIdle(agent)
    handle = state?.handles.get(agent)
    if (!handle || typeof handle.dispose !== 'function') {
      throw new Error('会话已加载，但缺少其原生释放句柄；请正常重启 DSH 后重试')
    }
    // dsh 0.2.2 移除了 ctx.agents.roots()。子会话由 Session 头部标记：
    // origin === 'subagent' 且有 parentSession，两者都说明它属于别的任务。
    if (!isRootAgent(ctx, agent, id)) throw new Error('目标是其他任务的子会话，不能单独删除')
    try {
      for (const method of ['send', 'runMaintenance']) {
        const original = agent[method]
        if (typeof original !== 'function') throw new Error('宿主缺少会话输入隔离接口')
        const descriptor = Object.getOwnPropertyDescriptor(agent, method)
        const wrapped = function (...args) {
          if (deleting.has(id)) throw new Error('目标会话正在删除，暂不能接收新工作')
          return Reflect.apply(original, this, args)
        }
        Object.defineProperty(agent, method, { value: wrapped, configurable: true, writable: true })
        undo.push(() => {
          if (agent[method] !== wrapped) return
          if (descriptor) Object.defineProperty(agent, method, descriptor)
          else delete agent[method]
        })
      }
    } catch (error) {
      for (const restore of undo.reverse()) restore()
      throw error
    }
  }
  return {
    async release() {
      const activity = await ctx.waterfall('workspace/session-activity', { sessionId: id }, () => Promise.resolve([]))
      if (!Array.isArray(activity) || activity.length) throw new Error('目标会话仍有关联任务、子任务或提醒，暂不能删除')
      if (agent !== undefined) {
        if (ctx.agents.get(id) !== agent) throw new Error('目标会话状态已变化，请重试')
        assertIdle(agent)
        // Only this target's captured native handle is disposed. Other agents continue.
        await handle.dispose()
        state.handles.delete(agent)
      }
      if (ctx.agents.get(id) !== undefined || ctx.sessions.get(id) !== undefined) {
        throw new Error('原生会话尚未完全释放，拒绝删除文件')
      }
    },
    restore() { for (const restore of undo.reverse()) restore() }
  }
}
