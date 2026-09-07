import { z } from 'zod'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'

export interface InsightTreeActivityState {
  events: number
  toolCalls: number
  byEventType: Record<string, number>
  byTool: Record<string, { count: number; lastActivity?: string }>
  /** Tool owners only when the host event explicitly identifies the source. */
  toolOwners?: Record<string, string>
  lastActivity?: string
}

export interface ActivityEventLike {
  type?: string
  time?: number
  data?: { name?: string; plugin?: string; source?: string } | unknown
  plugin?: string
  source?: string
  name?: string
}

declare module '@deepseek-ai/dsh-session-projection' {
  interface SessionProjectionStateMap {
    'dsh-insight-tree/activity': InsightTreeActivityState
  }
}

export const ACTIVITY_KEY = 'dsh-insight-tree/activity'

const activityStateSchema = z.object({
  events: z.number(),
  toolCalls: z.number(),
  byEventType: z.record(z.string(), z.number()),
  byTool: z.record(z.string(), z.object({ count: z.number(), lastActivity: z.string().optional() })),
  toolOwners: z.record(z.string(), z.string()).optional(),
  lastActivity: z.string().optional(),
})

function emptyState(): InsightTreeActivityState {
  return { events: 0, toolCalls: 0, byEventType: {}, byTool: {} }
}

/**
 * Pure fold for one committed session event. Returns `state` unchanged when the
 * event carries no type (projection contract: same reference ⇒ zero work).
 */
type ActivityFoldEvent = { type?: string; data?: { name?: string; plugin?: string; source?: string } | unknown; plugin?: string; source?: string; name?: string }

function eventField(event: ActivityFoldEvent, field: 'name' | 'plugin' | 'source'): string | undefined {
  const direct = event[field]
  if (typeof direct === 'string' && direct) return direct
  if (event.data && typeof event.data === 'object') {
    const nested = (event.data as Record<string, unknown>)[field]
    if (typeof nested === 'string' && nested) return nested
  }
  return undefined
}

export function foldActivityEvent(state: InsightTreeActivityState, event: ActivityFoldEvent): InsightTreeActivityState {
  if (!event.type) return state
  const timestamp = new Date().toISOString()
  const next: InsightTreeActivityState = {
    events: state.events + 1,
    toolCalls: state.toolCalls + (event.type === 'tool/call' ? 1 : 0),
    byEventType: { ...state.byEventType, [event.type]: (state.byEventType[event.type] ?? 0) + 1 },
    byTool: state.byTool,
    lastActivity: timestamp,
  }
  if (event.type === 'tool/call') {
    const name = eventField(event, 'name')
    if (!name) return next
    next.byTool = {
      ...state.byTool,
      [name]: { count: (state.byTool[name]?.count ?? 0) + 1, lastActivity: timestamp },
    }
    const owner = eventField(event, 'plugin') ?? eventField(event, 'source')
    if (owner) next.toolOwners = { ...state.toolOwners, [name]: owner }
  }
  return next
}

/** Fold a detached session-query log into the same activity shape as the live projection. */
export function activityFromEvents(events: readonly ActivityEventLike[]): InsightTreeActivityState {
  let state = emptyState()
  for (const event of events) {
    if (!event?.type) continue
    const timestamp = typeof event.time === 'number' && Number.isFinite(event.time)
      ? new Date(event.time).toISOString()
      : undefined
    const data = event.data && typeof event.data === 'object' ? event.data as { name?: string; plugin?: string; source?: string } : undefined
    const next = foldActivityEvent(state, { type: event.type, data, plugin: event.plugin, source: event.source, name: event.name })
    state = timestamp && next.lastActivity ? { ...next, lastActivity: timestamp, byTool: Object.fromEntries(Object.entries(next.byTool).map(([name, item]) => item.lastActivity === next.lastActivity ? [name, { ...item, lastActivity: timestamp }] : [name, item])) } : next
  }
  return state
}

/**
 * Host-only session projection unit: derives per-session activity (event
 * counts, tool-call counts per tool name) from the durable session log. The
 * unit is host-only (`no wire`), so clients do not receive it through the
 * change feed; the plugin's own route reads `stateOf(session, ACTIVITY_KEY)`.
 */
export function createActivityDefinition(): ProjectionDefinition<'dsh-insight-tree/activity', InsightTreeActivityState> {
  return {
    key: ACTIVITY_KEY,
    stateSchema: activityStateSchema,
    stateVersion: 1,
    init: () => emptyState(),
    apply: (state, event) => foldActivityEvent(state, event as unknown as ActivityFoldEvent),
  }
}
