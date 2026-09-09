import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { InsightTreeActivity, InsightTreeReport } from './model.js'
import { createInsightTreeRoute, removePatchEntries, updatePatchEntries, type InsightTreeRuntime } from './route.js'
import { discoverReport } from './discovery.js'
import { snapshotLoaderEntries, isStructuralLoaderEntry, loaderEntryBelongsToPlugin, STRUCTURAL_ENTRY_ID_PREFIXES, type LoaderEntryLike, type LoaderLike } from './loader.js'
import { ACTIVITY_KEY, activityFromEvents, createActivityDefinition, foldActivityEvent, type ActivityEventLike } from './activity.js'
import { renderCompareMarkdown, renderMarkdownReport, renderPluginCsv, sanitizeReport } from './export.js'
import type { InsightTreeCompareEntry } from './export.js'
import { RULES_VERSION, applyRules } from './rules.js'
import { TOOL_OWNER_LABELS, aggregatePluginUse, toolOwnerOf } from './owners.js'
import { createHotOperations } from './hot.js'
import { isPluginRelatedFailure } from './diagnostics.js'

export { discoverReport, snapshotLoaderEntries, isStructuralLoaderEntry, loaderEntryBelongsToPlugin, STRUCTURAL_ENTRY_ID_PREFIXES, foldActivityEvent, activityFromEvents, createActivityDefinition, ACTIVITY_KEY, renderMarkdownReport, renderPluginCsv, renderCompareMarkdown, sanitizeReport, applyRules, RULES_VERSION, createInsightTreeRoute, removePatchEntries, updatePatchEntries, TOOL_OWNER_LABELS, aggregatePluginUse, toolOwnerOf, runtimeFor, sessionUsageFromActivity, isPluginRelatedFailure }
export { minimumReleaseAgeFailure } from './route.js'
export { buildVerdict, catalogUrl, declaredDshRanges, hostOkFor, isOfficialPlugin, loadCatalog, loadGithubRepo, loadPackument, parsePackumentVersions, parseRepository, registryBase, resolveUpstream, selectCandidate, versionNeedsConfirmation } from './upstream.js'
export { createHotOperations } from './hot.js'
export type { DiscoverOptions } from './discovery.js'

export const name = 'dsh-insight-tree'

export interface Config { profile: string; dshVersion: string; token: string }
export const Config = z.object({
  profile: z.string().default('web'),
  dshVersion: z.string().default('0.1.2-rc.1'),
  token: z.string().default(''),
})

interface ProjectionLike {
  register(definition: unknown): () => void
  stateOf(session: unknown, key: string): { events: number; toolCalls: number; byEventType: Record<string, number>; byTool: Record<string, { count: number; lastActivity?: string }>; toolOwners?: Record<string, string>; lastActivity?: string } | undefined
}

interface SessionObjectLike { id?: string; sessionId?: string }

interface SessionQueryLike {
  readSession: (sessionId: string) => Promise<{ events?: readonly unknown[] }>
}

interface ActivityCacheRecord {
  rows?: Record<string, { val?: unknown }>
}

/** Runtime tool → plugin owner map. Explicit event metadata wins over curated rules. */
const toolOwnerRuntime = new Map<string, string>()
let toolsPatched = false

function patchToolsRegister(ctx: Context): void {
  if (toolsPatched) return
  const tools = (ctx as unknown as { get?: (key: string) => unknown }).get?.('tools') as { register?: (definition: { name?: string }) => unknown } | undefined
  if (!tools || typeof tools.register !== 'function') return
  const original = tools.register
  const wrapped = function (this: unknown, definition: { name?: string }) {
    try {
      const caller = (this as { ctx?: Context } | undefined)?.ctx
      const entry = (caller?.fiber as unknown as { entry?: { options?: { name?: string } } } | undefined)?.entry
      const plugin = entry?.options?.name
      if (typeof plugin === 'string' && plugin.length > 0 && typeof definition?.name === 'string' && definition.name.length > 0) {
        toolOwnerRuntime.set(definition.name, plugin)
      }
    } catch { /* ownership must never break tool registration */ }
    return original.call(this, definition)
  }
  tools.register = wrapped
  toolsPatched = true
  ctx.effect(() => () => {
    if (tools.register === wrapped) tools.register = original
    toolsPatched = false
  }, 'dsh-insight-tree: restore tools.register')
}

function runtimeFor(loader: LoaderLike, context?: Context, profileDir = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'profiles', 'web')): InsightTreeRuntime {
  const hot = createHotOperations(context as unknown as {
    plugin?: (plugin: unknown, config: unknown) => { await?: () => Promise<unknown>; dispose?: () => Promise<unknown> | void }
    logger?: { warn?: (message: string) => void }
  } | undefined, profileDir)
  const matches = (pluginId: string): LoaderEntryLike[] => [...loader.entries()].filter((entry) => {
    return loaderEntryBelongsToPlugin(entry, pluginId)
  })
  const setDisabled = async (pluginId: string, disabled: boolean): Promise<{ matched: number }> => {
    const entries = matches(pluginId)
    const changed: LoaderEntryLike[] = []
    let hotMatched = false
    try {
      if (disabled) hotMatched = await hot.unmount(pluginId)
      for (const entry of entries) {
        if (typeof entry.update !== 'function') throw new Error(`Loader 条目 ${entry.id} 不支持运行时更新`)
        let recorded = false
        for (let attempt = 0; attempt < 3; attempt += 1) {
          await entry.update({ disabled: disabled ? true : null }, false, true)
          if (!recorded) {
            changed.push(entry)
            recorded = true
          }
          // Test doubles may omit `fiber`; real Cordis entries expose it and
          // can finish an in-flight init shortly after the first update.
          if (!('fiber' in entry) || (entry.fiber !== undefined) === !disabled) break
          await new Promise((resolve) => setTimeout(resolve, 200))
        }
      }
    } catch (error) {
      for (const entry of changed.reverse()) {
        try { await entry.update?.({ disabled: disabled ? null : true }, false, true) } catch { /* keep the original failure */ }
      }
      throw error
    }
    if (!disabled && entries.length === 0) hotMatched = await hot.mount(pluginId)
    return { matched: entries.length + (hotMatched ? 1 : 0) }
  }
  const remove = async (pluginId: string): Promise<{ matched: number }> => {
    const entries = matches(pluginId)
    if (!loader.remove && entries.length > 0) throw new Error('当前 Loader 不支持运行时移除')
    const hotMatched = await hot.unmount(pluginId)
    for (const entry of entries) await loader.remove?.(entry.id)
    return { matched: entries.length + (hotMatched ? 1 : 0) }
  }
  return { setDisabled, remove }
}

function dshProfiles(): string[] {
  const dir = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'profiles')
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((item) => item.isDirectory()).map((item) => item.name).sort()
  } catch {
    return []
  }
}

function sessionUsageFromActivity(activity: InsightTreeActivity): Record<string, { count: number; lastActivity?: string }> {
  const owners = activity.toolOwners ?? {}
  const result: Record<string, { count: number; lastActivity?: string }> = {}
  for (const [tool, item] of Object.entries(activity.byTool ?? {})) {
    const owner = owners[tool] ?? toolOwnerOf(tool)
    const current = result[owner] ?? { count: 0 }
    result[owner] = {
      count: current.count + item.count,
      lastActivity: item.lastActivity && (!current.lastActivity || item.lastActivity > current.lastActivity) ? item.lastActivity : current.lastActivity,
    }
  }
  return result
}

function attributionFor(activity: InsightTreeActivity): InsightTreeActivity {
  const owners = activity.toolOwners ?? {}
  const unattributedTools = Object.fromEntries(Object.entries(activity.byTool ?? {}).filter(([name]) => !owners[name]))
  return {
    ...activity,
    unattributedTools: Object.keys(unattributedTools).length ? unattributedTools : undefined,
    attribution: Object.keys(owners).length === 0 ? 'unconfirmed' : Object.keys(unattributedTools).length ? 'partial' : 'explicit',
  }
}

export function apply(ctx: Context, config: Config): void {
  patchToolsRegister(ctx)
  const usage = { sessionEvents: 0, toolCalls: 0 }
  let lastActivityAt: string | undefined
  const sessionTools = new Map<string, Record<string, { count: number; lastActivity?: string }>>()
  const sessions = new Map<string, Record<string, { count: number; lastActivity?: string }>>()
  const sessionObjects = new Map<string, SessionObjectLike>()
  let lastSessionId = ''
  const eventContext = ctx as Context & { on: (event: string, listener: (session: unknown, event: { type?: string }) => void) => unknown }
  eventContext.on('session/event', (session: unknown, event: { type?: string; plugin?: string; source?: string; name?: string; data?: { name?: string } }) => {
    usage.sessionEvents += 1
    if (event.type === 'tool/call') usage.toolCalls += 1
    lastActivityAt = new Date().toISOString()
    const sessionId = typeof session === 'string'
      ? session
      : ((session as SessionObjectLike | undefined)?.id || (session as SessionObjectLike | undefined)?.sessionId || 'current')
    lastSessionId = sessionId
    if (session && typeof session === 'object') sessionObjects.set(sessionId, session as SessionObjectLike)
    // Standard tool/call events expose a tool name, not its owning bundle. Only
    // count ownership when the host supplies an explicit plugin/source field.
    const pluginId = event.plugin || event.source
    if (pluginId) {
      const current = sessions.get(sessionId) || {}
      const item = current[pluginId] || { count: 0 }
      current[pluginId] = { count: item.count + 1, lastActivity: new Date().toISOString() }
      sessions.set(sessionId, current)
    }
    const toolName = event.name || event.data?.name
    if (event.type === 'tool/call' && toolName) {
      const current = sessionTools.get(sessionId) || {}
      const item = current[toolName] || { count: 0 }
      current[toolName] = { count: item.count + 1, lastActivity: new Date().toISOString() }
      sessionTools.set(sessionId, current)
    }
  })
  ctx.inject(['loader', 'webServer'], (webCtx) => {
    const runtimeContext = webCtx as Context & { get?: (key: string) => unknown; loader: LoaderLike; webServer: { register: (route: unknown) => () => void } }
    patchToolsRegister(runtimeContext)
    const loaderService = runtimeContext.loader
    // Resolve optional services after the injected runtime fiber is active.
    // Looking them up during apply() can return undefined while their loader
    // is still pending.
    const projections = runtimeContext.get?.('sessionProjections') as ProjectionLike | undefined
    const sessionQuery = runtimeContext.get?.('sessionQuery') as SessionQueryLike | undefined
    if (projections?.register) {
      const disposer = projections.register(createActivityDefinition())
      ctx.effect(() => disposer, 'dsh-insight-tree: activity projection')
    }
    const readActivity = (sessionId: string): InsightTreeActivity => {
      const sessionObject = sessionObjects.get(sessionId)
      if (sessionObject && projections?.stateOf) {
        try {
          const state = projections.stateOf(sessionObject, ACTIVITY_KEY)
        if (state) return attributionFor({ ...state, source: 'projection' })
        } catch { /* fall back to memory below */ }
      }
      return attributionFor({ events: usage.sessionEvents, toolCalls: usage.toolCalls, byTool: sessionTools.get(sessionId) || {}, lastActivity: lastActivityAt, source: 'memory' })
    }
    const readCachedActivity = (sessionId: string): InsightTreeActivity | undefined => {
      // dsh-session-projection-cache keeps detached projection snapshots even
      // after a session leaves the live registry. Use only a basename so a
      // session id can never escape the DSH storage directory.
      if (!sessionId || path.basename(sessionId) !== sessionId) return undefined
      const file = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'storages', 'session_projcache', 'sessions', `${sessionId}.json`)
      try {
        const record = JSON.parse(fs.readFileSync(file, 'utf8')) as ActivityCacheRecord
        const value = record.rows?.[ACTIVITY_KEY]?.val
        if (!value || typeof value !== 'object') return undefined
        const candidate = value as Partial<InsightTreeActivity>
        if (typeof candidate.events !== 'number' || typeof candidate.toolCalls !== 'number' || !candidate.byTool || typeof candidate.byTool !== 'object') return undefined
        return attributionFor({ events: candidate.events, toolCalls: candidate.toolCalls, byEventType: candidate.byEventType, byTool: candidate.byTool as InsightTreeActivity['byTool'], lastActivity: candidate.lastActivity, toolOwners: Object.fromEntries(toolOwnerRuntime), source: 'projection' })
      } catch {
        return undefined
      }
    }
    const historicalActivity = new Map<string, InsightTreeActivity | null>()
    const readSessionActivity = async (sessionId: string): Promise<InsightTreeActivity> => {
      // The current live session is already covered by the projection/memory
      // path. Any other id may be a persisted session that was never attached
      // to this process, so ask sessionQuery to replay it even if the host has
      // a lightweight object for that id.
      const cached = readCachedActivity(sessionId)
      if (cached) return cached
      const known = sessionId === 'current' || sessionId === lastSessionId
      if (known || !sessionQuery?.readSession) return readActivity(sessionId)
      if (historicalActivity.has(sessionId)) return historicalActivity.get(sessionId) ?? { events: 0, toolCalls: 0, byTool: {}, toolOwners: Object.fromEntries(toolOwnerRuntime), source: 'none' }
      try {
        const snapshot = await Promise.race([
          sessionQuery.readSession(sessionId),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('历史会话读取超时')), 5000)),
        ])
        const folded = activityFromEvents((snapshot.events ?? []) as ActivityEventLike[])
        const toolOwners = Object.fromEntries(toolOwnerRuntime)
        const result = attributionFor({ ...folded, toolOwners, source: 'session-query' as const })
        historicalActivity.set(sessionId, result)
        return result
      } catch {
        historicalActivity.set(sessionId, null)
        return { events: 0, toolCalls: 0, byTool: {}, toolOwners: Object.fromEntries(toolOwnerRuntime), source: 'none' }
      }
    }
    const getReport = (sessionId?: string): InsightTreeReport => {
      const key = sessionId || lastSessionId
      if (!key) {
        const empty: InsightTreeActivity = { events: 0, toolCalls: 0, byTool: {}, source: 'none', attribution: 'unconfirmed' }
        const report = discoverReport(config.profile, config.dshVersion, {}, snapshotLoaderEntries(loaderService), empty)
        return { ...report, sessionId: undefined, usage: { sessionEvents: 0, toolCalls: 0 }, sessionTools: {} }
      }
      const activity = attributionFor({ ...readActivity(key), toolOwners: Object.fromEntries(toolOwnerRuntime) })
      const sessionUsage = { ...sessionUsageFromActivity(activity), ...(sessions.get(key) || {}) }
      const report = discoverReport(config.profile, config.dshVersion, sessionUsage, snapshotLoaderEntries(loaderService), activity)
      return { ...report, sessionId: key, usage, sessionTools: activity.byTool ?? sessionTools.get(key) ?? {} }
    }
    const getSessionReport = async (sessionId: string): Promise<InsightTreeReport> => {
      const activity = await readSessionActivity(sessionId)
      const sessionUsage = sessionUsageFromActivity(activity)
      const report = discoverReport(config.profile, config.dshVersion, sessionUsage, snapshotLoaderEntries(loaderService), activity)
      return { ...report, sessionId, usage: { sessionEvents: activity.events, toolCalls: activity.toolCalls }, sessionTools: activity.byTool }
    }
    const getCompare = (profiles: string[]): InsightTreeCompareEntry[] => {
      const list = profiles.length ? profiles : dshProfiles()
      return list.map((profile) => ({ profile, report: discoverReport(profile, config.dshVersion, {}, [], { events: 0, toolCalls: 0, source: 'none' }) }))
    }
    const profileDir = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'profiles', config.profile)
    const disposer = runtimeContext.webServer.register(createInsightTreeRoute(getReport, config.profile, { token: config.token, getCompare, getSessionReport, runtime: runtimeFor(loaderService, runtimeContext, profileDir), hostVersion: config.dshVersion }))
    ctx.effect(() => disposer, 'dsh-insight-tree: routes')
  })
}
