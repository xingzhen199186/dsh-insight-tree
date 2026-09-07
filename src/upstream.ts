import semver from 'semver'
import { readCache, writeCache } from './cache.js'

export type SourceKind = 'official' | 'github' | 'npm' | 'local' | 'missing'

export interface UpstreamVersionInfo {
  version: string
  publishedAt?: string
  /** hostDsh 是否满足该版本声明的 DSH 范围；null = 未声明，无法判定。 */
  hostOk: boolean | null
  isInstalled: boolean
  isLatest: boolean
  ranges?: string
}

export interface UpstreamVerdict {
  id: string
  name: string
  installedVersion?: string
  sourceKind: SourceKind
  repo?: string
  repoUrl?: string
  npmName?: string
  stars?: number | null
  license?: string | null
  archived?: boolean
  catalogDescription?: string
  category?: string
  catalogInstall?: string
  latest?: string
  latestCompatible?: string | null
  hostAligned: boolean | null
  updateAvailable: boolean
  versions: UpstreamVersionInfo[]
  error?: string
}

export interface UpstreamState {
  state: 'ok' | 'partial' | 'offline'
  hostVersion: string
  profile: string
  generatedAt: string
  registry: string
  catalogUrl: string
  catalogCount?: number
  catalogFetchedAt?: string
  plugins: UpstreamVerdict[]
}

const DEFAULT_REGISTRY = 'https://registry.npmjs.org'
const DEFAULT_CATALOG = 'https://awesome-dsh-plugin.com/plugins.json'
const GITHUB_REPO_RE = /(?:github\.com[/:]|github:)([^/]+)\/([^/#\s]+)/iu

export function registryBase(): string {
  return (process.env.DSH_INSIGHT_TREE_REGISTRY || DEFAULT_REGISTRY).replace(/\/+$/u, '')
}

export function catalogUrl(): string {
  return process.env.DSH_INSIGHT_TREE_CATALOG_URL || DEFAULT_CATALOG
}

export function githubApiBase(): string {
  return (process.env.DSH_INSIGHT_TREE_GITHUB_API_BASE || 'https://api.github.com').replace(/\/+$/u, '')
}

/** Normalize any repository field shape to 'owner/repo'. */
export function parseRepository(repository: unknown): string | null {
  const value = typeof repository === 'string' ? repository : typeof repository === 'object' && repository !== null ? (repository as { url?: string }).url : undefined
  if (!value) return null
  const match = GITHUB_REPO_RE.exec(value)
  return match ? `${match[1]}/${match[2].replace(/\.git$/iu, '')}` : null
}

/** host repo from a catalog entry url ('https://github.com/o/r/tree/main/pkg' → 'o/r'). */
export function repoFromCatalogUrl(url: string | undefined): string | null {
  if (!url) return null
  const match = GITHUB_REPO_RE.exec(url)
  return match ? `${match[1]}/${match[2]}` : null
}

export function isOfficialPlugin(id: string): boolean {
  return id.startsWith('@deepseek-ai/dsh-')
}

function cleanVersion(value: string | undefined): string | undefined {
  if (!value) return undefined
  return semver.valid(semver.clean(value) ?? value) ?? undefined
}

/** DSH host/package ranges declared by one published version. */
export function declaredDshRanges(meta: { dependencies?: Record<string, string>; peerDependencies?: Record<string, string>; engines?: Record<string, string> } | undefined): Array<{ key: string; range: string }> {
  if (!meta) return []
  const merged = { ...(meta.dependencies ?? {}), ...(meta.peerDependencies ?? {}) }
  const fromDeps = Object.entries(merged).filter(([key]) => key === '@deepseek-ai/dsh' || key.startsWith('@deepseek-ai/dsh-')).map(([key, range]) => ({ key, range }))
  const fromEngines = meta.engines?.dsh ? [{ key: 'engines.dsh', range: meta.engines.dsh }] : []
  return [...fromDeps, ...fromEngines]
}

/** true / false / null(未声明或缺少配套包上下文无法判定) — the pre-update verdict the UI warns on. */
export function hostOkFor(hostVersion: string, meta: { dependencies?: Record<string, string>; peerDependencies?: Record<string, string>; engines?: Record<string, string> } | undefined, installedDshVersions: Record<string, string> = {}): boolean | null {
  const ranges = declaredDshRanges(meta)
  if (ranges.length === 0) return null
  const host = cleanVersion(hostVersion) ?? hostVersion
  try {
    let unknown = false
    for (const { key, range } of ranges) {
      const actual = key === '@deepseek-ai/dsh' || key === 'engines.dsh' ? host : installedDshVersions[key]
      if (!actual) {
        unknown = true
        continue
      }
      if (!semver.satisfies(cleanVersion(actual) ?? actual, range, { includePrerelease: true })) return false
    }
    return unknown ? null : true
  } catch {
    return null
  }
}

export interface ParsedVersion extends UpstreamVersionInfo {
  meta?: { dependencies?: Record<string, string>; peerDependencies?: Record<string, string>; engines?: Record<string, string> }
}

/** Require an explicit confirmation when a requested version is incompatible,
 * or is unverified while a known compatible candidate exists. */
export function versionNeedsConfirmation(candidate: Pick<UpstreamVersionInfo, 'version' | 'hostOk'>, latestCompatible?: string | null): boolean {
  return candidate.hostOk === false || (candidate.hostOk === null && latestCompatible !== candidate.version)
}

/** Sort a packument's versions into newest-first parsed rows. */
export function parsePackumentVersions(data: { versions?: Record<string, unknown>; time?: Record<string, string>; 'dist-tags'?: Record<string, string> } | undefined): { rows: ParsedVersion[]; distTags: Record<string, string> } {
  const rows: ParsedVersion[] = []
  const versions = data?.versions ?? {}
  const time = data?.time ?? {}
  const distTags = data?.['dist-tags'] ?? {}
  for (const [version, raw] of Object.entries(versions)) {
    if (!semver.valid(semver.clean(version) ?? version)) continue
    const meta = (raw && typeof raw === 'object' ? raw : {}) as { dependencies?: Record<string, string>; peerDependencies?: Record<string, string>; engines?: Record<string, string> }
    rows.push({ version, publishedAt: time[version], hostOk: null, isInstalled: false, isLatest: false, meta })
  }
  rows.sort((a, b) => semver.rcompare(a.version, b.version, true))
  const latest = Object.entries(distTags).find(([tag]) => tag === 'latest')?.[1]
  if (latest) rows.forEach((row) => { row.isLatest = row.version === latest })
  if (rows.length > 0 && !rows.some((row) => row.isLatest)) rows[0].isLatest = true
  return { rows, distTags }
}

/** Pick the best upgrade candidate: newest hostOk, else newest unknown, else none. */
export function selectCandidate(rows: ParsedVersion[], hostVersion: string, installedDshVersions: Record<string, string> = {}): { latest?: string; latestCompatible: string | null; latestHostOk: boolean | null } {
  if (rows.length === 0) return { latestCompatible: null, latestHostOk: null }
  const scored = rows.map((row) => ({ row, hostOk: row.hostOk ?? hostOkFor(hostVersion, row.meta, installedDshVersions) }))
  const latest = scored.find((item) => item.row.isLatest)?.row.version ?? scored[0].row.version
  const compatible = scored.find((item) => item.hostOk === true)
  const unknown = scored.find((item) => item.hostOk === null)
  if (compatible) return { latest, latestCompatible: compatible.row.version, latestHostOk: true }
  if (unknown) return { latest, latestCompatible: unknown.row.version, latestHostOk: null }
  return { latest, latestCompatible: null, latestHostOk: false }
}

async function fetchJson(url: string, fetchImpl: typeof fetch, init: RequestInit = {}): Promise<unknown> {
  const response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(12_000) })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.json() as Promise<unknown>
}

interface CatalogPlugin {
  name?: string
  owner?: string
  url?: string
  npm?: string | null
  category?: string
  description?: { en?: string; zh?: string }
  stars?: number | null
  install?: string
}

export interface CatalogIndex {
  state: 'ok' | 'offline'
  count: number
  fetchedAt?: string
  byNpm: Map<string, CatalogPlugin>
  byRepo: Map<string, CatalogPlugin>
}

export async function loadCatalog(fetchImpl: typeof fetch = fetch, fallbackTtlMs = 6 * 60 * 60 * 1000): Promise<CatalogIndex> {
  const cached = readCache<{ fetchedAt?: string; plugins: CatalogPlugin[] }>('catalog', fallbackTtlMs)
  if (cached?.plugins) return indexCatalog(cached.plugins, cached.fetchedAt)
  try {
    const data = await fetchJson(catalogUrl(), fetchImpl, { headers: { accept: 'application/json', 'user-agent': 'dsh-insight-tree' } }) as { plugins?: CatalogPlugin[]; updated?: string }
    const plugins = Array.isArray(data.plugins) ? data.plugins : []
    writeCache('catalog', { fetchedAt: new Date().toISOString(), plugins })
    return indexCatalog(plugins, new Date().toISOString())
  } catch {
    return { state: 'offline', count: 0, byNpm: new Map(), byRepo: new Map() }
  }
}

function indexCatalog(plugins: CatalogPlugin[], fetchedAt?: string): CatalogIndex {
  const byNpm = new Map<string, CatalogPlugin>()
  const byRepo = new Map<string, CatalogPlugin>()
  for (const plugin of plugins) {
    if (plugin.npm) byNpm.set(plugin.npm, plugin)
    const repo = repoFromCatalogUrl(plugin.url)
    if (repo) byRepo.set(repo, plugin)
  }
  return { state: 'ok', count: plugins.length, fetchedAt, byNpm, byRepo }
}

interface Packument {
  versions?: Record<string, unknown>
  time?: Record<string, string>
  'dist-tags'?: Record<string, string>
}

export async function loadPackument(npmName: string, fetchImpl: typeof fetch = fetch, ttlMs = 10 * 60 * 1000): Promise<{ rows: ParsedVersion[]; distTags: Record<string, string> }> {
  const key = `npm-${npmName}`
  const cached = readCache<ParsedVersion[]>(key, ttlMs)
  if (cached) return { rows: cached, distTags: {} }
  const data = await fetchJson(`${registryBase()}/${encodeURIComponent(npmName)}`, fetchImpl, { headers: { accept: 'application/json', 'user-agent': 'dsh-insight-tree' } }) as Packument
  const parsed = parsePackumentVersions(data)
  writeCache(key, parsed.rows)
  return parsed
}

export interface GithubRepoMeta { stars?: number | null; license?: string | null; archived?: boolean; pushedAt?: string }

export async function loadGithubRepo(repo: string, fetchImpl: typeof fetch = fetch, ttlMs = 60 * 60 * 1000): Promise<GithubRepoMeta | null> {
  const cached = readCache<GithubRepoMeta>(`gh-${repo}`, ttlMs)
  if (cached) return cached
  try {
    const data = await fetchJson(`${githubApiBase()}/repos/${repo}`, fetchImpl, { headers: { accept: 'application/json', 'user-agent': 'dsh-insight-tree' } }) as { stargazers_count?: number; license?: { spdx_id?: string } | null; archived?: boolean; pushed_at?: string }
    const meta: GithubRepoMeta = { stars: data.stargazers_count ?? null, license: data.license?.spdx_id ?? null, archived: data.archived ?? false, pushedAt: data.pushed_at }
    writeCache(`gh-${repo}`, meta)
    return meta
  } catch {
    return null
  }
}

export interface ResolveUpstreamInput {
  id: string
  name?: string
  version?: string
  /** Registry package name discovered outside the catalog (for example, a fallback probe). */
  npmName?: string
  repository?: unknown
  homepage?: string
  hostVersion: string
  /** Installed DSH package versions used to verify package-level ranges. */
  installedDshVersions?: Record<string, string>
  profile?: string
  resource?: { catalog?: CatalogIndex; packument?: { rows: ParsedVersion[]; distTags: Record<string, string> } | null; repoMeta?: GithubRepoMeta | null }
  fetchImpl?: typeof fetch
}

/** Pure-ish verdict builder; network inputs come from the caller so it stays testable. */
export function buildVerdict(input: ResolveUpstreamInput): UpstreamVerdict {
  const plugin = input.resource?.catalog?.byNpm.get(input.id) ?? (input.resource?.catalog ? [...input.resource.catalog.byRepo.values()].find((item) => item.name === input.id) : undefined)
  const repoFromCatalog = plugin ? repoFromCatalogUrl(plugin.url) : null
  const repo = repoFromCatalog ?? parseRepository(input.repository)
  const isOfficial = isOfficialPlugin(input.id)
  const pack = input.resource?.packument ?? null
  // npm 名称直接采信目录映射（awesome registry 是 npm↔GitHub 的权威源头）；
  // 不在目录里的插件：有 repo → GitHub 源，无 repo → 仅本地/未发布。
  const npmName = input.npmName ?? ((plugin?.npm && !plugin.npm.startsWith('github:')) ? plugin.npm : undefined) ?? (pack ? input.id : undefined)
  const installed = cleanVersion(input.version)
  let versions: UpstreamVersionInfo[] = []
  if (pack) {
    versions = pack.rows.map((row) => {
      const hostOk = row.hostOk ?? hostOkFor(input.hostVersion, row.meta, input.installedDshVersions)
      const ranges = declaredDshRanges(row.meta).map(({ key, range }) => `${key} ${range}`).join('；') || undefined
      return { version: row.version, publishedAt: row.publishedAt, hostOk, isInstalled: row.version === installed, isLatest: row.isLatest, ranges }
    })
  }
  const latest = versions.find((item) => item.isLatest)?.version ?? versions[0]?.version
  const compatible = versions.find((item) => item.hostOk === true)
  const unknown = versions.find((item) => item.hostOk === null)
  const candidate = compatible ?? unknown ?? null
  const latestCompatible = candidate?.version ?? null
  const updateAvailable = Boolean(pack && candidate && installed && candidate.version !== installed && semver.gt(candidate.version, installed, true))
  const hostAligned = installed ? (versions.find((item) => item.isInstalled)?.hostOk ?? null) : null
  const sourceKind: SourceKind = isOfficial ? 'official' : repo && !npmName ? 'github' : npmName || repo ? 'npm' : 'local'
  const repoMeta = input.resource?.repoMeta
  return {
    id: input.id,
    name: input.name ?? input.id,
    installedVersion: installed,
    sourceKind,
    repo: repo ?? undefined,
    repoUrl: repo ? `https://github.com/${repo}` : undefined,
    npmName,
    stars: repoMeta?.stars ?? (sourceKind === 'local' ? undefined : plugin?.stars ?? null),
    license: repoMeta?.license ?? null,
    archived: repoMeta?.archived,
    catalogDescription: plugin?.description?.zh ?? plugin?.description?.en,
    category: plugin?.category,
    catalogInstall: plugin?.install,
    latest,
    latestCompatible,
    hostAligned,
    updateAvailable,
    versions,
  }
}

/** One plugin, network optional: fetch only what the verdict needs. */
export async function resolveUpstream(id: string, input: Omit<ResolveUpstreamInput, 'id' | 'hostVersion' | 'resource'>, hostVersion: string, fetchImpl: typeof fetch = fetch): Promise<UpstreamVerdict> {
  const catalog = await loadCatalog(fetchImpl)
  const base: ResolveUpstreamInput = { id, hostVersion, ...input, resource: { catalog } }
  const catalogEntry = [...catalog.byRepo.values()].find((item) => item.name === id)
  const repo = parseRepository(input.repository) ?? (catalogEntry ? repoFromCatalogUrl(catalogEntry.url) : null)
  const plugin = catalog.byNpm.get(id)
  const npmName = plugin?.npm && !plugin.npm.startsWith('github:') ? plugin.npm : undefined
  try {
    if (npmName) {
      const pack = await loadPackument(npmName, fetchImpl)
      return buildVerdict({ ...base, resource: { catalog, packument: pack } })
    }
    // Catalog may mark npm:null while the package actually exists on the
    // registry (author published later, awesome entry not refreshed). Probe
    // the registry once; 404/network keeps the GitHub/local verdict.
    if (!isOfficialPlugin(id) && /^(?:@[^/]+\/)?[\w.-]+$/u.test(id)) {
      try {
        const pack = await loadPackument(id, fetchImpl)
        if (pack.rows.length > 0) return buildVerdict({ ...base, npmName: id, resource: { catalog, packument: pack } })
      } catch { /* not published under this name */ }
    }
    if (repo) {
      const repoMeta = await loadGithubRepo(repo, fetchImpl)
      return buildVerdict({ ...base, resource: { catalog, packument: null, repoMeta } })
    }
    return buildVerdict({ ...base, resource: { catalog, packument: null } })
  } catch (error) {
    const verdict = buildVerdict({ ...base, resource: { catalog, packument: null } })
    return { ...verdict, error: `上游读取失败：${error instanceof Error ? error.message : String(error)}` }
  }
}
