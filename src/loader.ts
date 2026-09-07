import type { InsightTreeFiberPhase, InsightTreeLoaderEntry } from './model.js'

export interface LoaderEntryLike {
  id: string
  options?: { id?: string; name?: string; group?: boolean | null }
  disabled?: boolean
  fiber?: { state?: number }
  update?: (options: { disabled?: boolean | null }, create?: boolean, force?: boolean) => Promise<void>
  /** Container nodes own a nested entry tree/subgroup; they are structure, not modules. */
  subtree?: unknown
  subgroup?: unknown
}

export interface LoaderLike {
  entries(): Iterable<LoaderEntryLike>
  remove?(id: string): Promise<void>
}

/**
 * A bundle may expose several loader modules. The root entry uses the package
 * name while subpath entries use `package/subpath`; a few older bundles use a
 * dash-delimited child name instead. Keep this rule shared by reporting and
 * live operations so the UI cannot claim a bundle is stopped while one of its
 * children is still running.
 */
export function loaderEntryBelongsToPlugin(entry: LoaderEntryLike, pluginId: string): boolean {
  if (isStructuralLoaderEntry(entry)) return false
  const names = [entry.id, entry.options?.id, entry.options?.name].filter((value): value is string => typeof value === 'string')
  return names.some((name) => name === pluginId || name.startsWith(`${pluginId}/`) || name.startsWith(`${pluginId}-`))
}

/**
 * Structural entry id families produced by the Cordis loader. These prefixes
 * can also appear on real child modules inside a composed include/group tree,
 * so they are only hints; the classifier below relies on the entry's actual
 * group/container signals before treating a row as structure.
 */
export const STRUCTURAL_ENTRY_ID_PREFIXES = ['include:', 'group:', 'isolate:'] as const

/**
 * True when a loader entry is config-assembly structure rather than a runtime
 * plugin module. Uses the loader's own signals — `options.group`, container
 * nodes (`subtree`/`subgroup`) and the documented structural id families — so
 * future structural kinds do not create false "pending" warnings.
 */
export function isStructuralLoaderEntry(entry: LoaderEntryLike): boolean {
  if (entry.options?.group) return true
  if (entry.subtree !== undefined || entry.subgroup !== undefined) return true
  return typeof entry.options?.name === 'string' && entry.options.name.startsWith('cordis:')
}

/** Mirrors @deepseek-ai/cordis-plugin-loader FiberState at runtime. */
const FIBER_PHASE: Record<number, InsightTreeFiberPhase> = {
  0: 'pending',
  1: 'loading',
  2: 'active',
  3: 'failed',
  4: null,
  5: 'unloading',
}

/**
 * Project the live Cordis Loader entries into the plugin's report vocabulary.
 * Mirrors the official `@deepseek-ai/dsh-host-plugin-inventory` gateway: group
 * rows are skipped, `fiber === undefined` becomes `null`, and `disabled` is the
 * effective enablement (including disabled ancestor groups). Structural rows
 * (group/include/isolate/containers) are excluded via
 * {@link isStructuralLoaderEntry} so a snapshot never reports them as plugins
 * waiting to load.
 */
export function snapshotLoaderEntries(loader: LoaderLike | undefined): InsightTreeLoaderEntry[] {
  if (!loader) return []
  const entries: InsightTreeLoaderEntry[] = []
  for (const entry of loader.entries()) {
    if (isStructuralLoaderEntry(entry)) continue
    entries.push({
      entryId: entry.id,
      moduleName: entry.options?.name ?? entry.id,
      enabled: !entry.disabled,
      fiberPhase: entry.fiber === undefined ? null : FIBER_PHASE[entry.fiber.state ?? 0] ?? null,
    })
  }
  return entries
}
