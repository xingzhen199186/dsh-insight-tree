export type PluginStatus = 'active' | 'warning' | 'degraded' | 'blocked' | 'disabled'

export interface InsightTreeAction {
  kind: 'disable' | 'enable' | 'uninstall' | 'recheck' | 'export' | 'none'
  plugin?: string
  label?: string
}

export interface InsightTreeFinding {
  id: string
  severity: 'info' | 'warning' | 'degraded' | 'blocking'
  impact: 'none' | 'plugin' | 'capability' | 'profile' | 'startup'
  title: string
  message: string
  recommendation?: string
  evidence?: string
  action?: InsightTreeAction
}

export type CompatibilityStatus = 'compatible' | 'incompatible' | 'unknown' | 'missing'
export interface InsightTreeCompatibility { status: CompatibilityStatus; label: string; requirement?: string; evidence?: string }

export type InsightTreeFiberPhase = 'pending' | 'loading' | 'active' | 'failed' | 'unloading' | null

export interface InsightTreeLoaderEntry {
  entryId: string
  moduleName: string
  enabled: boolean
  fiberPhase: InsightTreeFiberPhase
}

export interface InsightTreePlugin {
  id: string
  name: string
  description?: string
  source: 'core' | 'bundle' | 'user'
  status: PluginStatus
  version?: string
  packagePath?: string
  compatibility: InsightTreeCompatibility
  role: string
  provides: string[]
  dependsOn: string[]
  dependents: string[]
  findings: InsightTreeFinding[]
  sessionUsage?: { count: number; lastActivity?: string }
  fiberPhase?: InsightTreeFiberPhase
  enabled?: boolean
  loaderEntryId?: string
}

export interface InsightTreeActivity {
  events: number
  toolCalls: number
  byEventType?: Record<string, number>
  byTool?: Record<string, { count: number; lastActivity?: string }>
  /** Tool → plugin map only when the host event explicitly supplies an owner. */
  toolOwners?: Record<string, string>
  /** Tool calls whose owning plugin is not present in the host event. */
  unattributedTools?: Record<string, { count: number; lastActivity?: string }>
  attribution?: 'explicit' | 'partial' | 'unconfirmed'
  lastActivity?: string
  source: 'projection' | 'memory' | 'session-query' | 'none'
}

export interface InsightTreeReport {
  schemaVersion: 3
  generatedAt: string
  dshVersion: string
  versionSource: 'installed' | 'spec' | 'config' | 'unknown'
  profile: string
  sessionId?: string
  patch: { entries: number; reload?: string }
  usage: { sessionEvents: number; toolCalls: number }
  sessionTools?: Record<string, { count: number; lastActivity?: string }>
  activity?: InsightTreeActivity
  loader?: InsightTreeLoaderEntry[]
  ruleVersion?: number
  runtime: { dumpConfig: 'ok' | 'failed'; activatedEntries: number; error?: string; probe?: 'live' | 'skipped' }
  status: 'ready' | 'attention' | 'blocked'
  summary: { total: number; active: number; attention: number; blocked: number }
  plugins: InsightTreePlugin[]
  findings: InsightTreeFinding[]
  recommendedActions: string[]
}
