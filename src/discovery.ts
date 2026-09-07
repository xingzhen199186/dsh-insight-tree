import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import yaml from 'js-yaml'
import semver from 'semver'
import type { InsightTreeCompatibility, InsightTreeFinding, InsightTreeLoaderEntry, InsightTreePlugin, InsightTreeReport, InsightTreeActivity } from './model.js'
import { RULES_VERSION, applyRules } from './rules.js'
import { loaderEntryBelongsToPlugin } from './loader.js'

interface ProfileManifest {
  dependencies?: Record<string, string>
  dsh?: { profile?: { bundles?: string[]; patchReload?: string } }
}

export interface PackageMetadata {
  name?: string
  version?: string
  description?: string
  repository?: { type?: string; url?: string } | string
  homepage?: string
  engines?: Record<string, string>
  devDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  dependencies?: Record<string, string>
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
  keywords?: string[]
  exports?: Record<string, unknown>
  dsh?: { bundle?: { patch?: string }; client?: unknown; skills?: unknown; mcpServers?: unknown }
}

const resolvePackage = createRequire(import.meta.url)

export interface DiscoverOptions {
  /** Skip invoking the DSH CLI; used by the independent failure diagnostic. */
  probeRuntime?: boolean
}

const capabilityCatalog: Record<string, string[]> = {
  '@deepseek-ai/dsh-base': ['模型与工具运行', '会话、文件与权限基础'],
  '@deepseek-ai/dsh-web-app': ['Web 对话界面', '浏览器端运行支持'],
  dshmarket: ['发现和安装插件', '插件市场浏览'],
  '@linxin666/dsh-web-all': ['任务、皮肤与界面扩展', 'Web 功能集合'],
  '@linxin666/dsh-remote-web-ui': ['手机扫码访问', '远程同步与设备管理'],
  'dsh-cost-meter': ['会话费用统计', '余额与额度查看'],
  '@vectorize-io/hindsight-coding-agents': ['编码长期记忆', '上下文自动沉淀'],
  'dsh-mnemon': ['跨会话记忆', '项目文档检索'],
  'dsh-find-plugin': ['搜索和发现插件', 'GitHub 插件目录'],
  'dsh-chat-import': ['导入外部会话', '恢复历史对话'],
  'upstream-radar': ['依赖与兼容性监测', '上游变更提醒'],
  'dsh-config-manager': ['配置备份与迁移', '插件、技能和工作区同步'],
  'dsh-pocket': ['手机远程访问', '扫码连接与实时同步'],
  'dsh-insight-tree': ['插件结构可视化', '运行状态与问题诊断'],
  'dsh-advisor-group': ['多模型顾问协作', '流式咨询与综合建议'],
}

function dshHome(): string {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

function readJson<T>(file: string): T | undefined {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as T } catch { return undefined }
}

function resolveProfile(profile: string): string {
  return path.join(dshHome(), 'profiles', profile)
}

function packageLocation(profileDir: string, name: string): string | undefined {
  const encoded = name.startsWith('@') ? path.join(...name.split('/')) : name
  const candidates = [
    path.join(profileDir, 'node_modules', encoded, 'package.json'),
    path.join(dshHome(), 'profiles', 'node_modules', encoded, 'package.json'),
    path.join(dshHome(), 'node_modules', encoded, 'package.json'),
    ...(process.env.APPDATA ? [
      path.join(process.env.APPDATA, 'npm', 'node_modules', encoded, 'package.json'),
      path.join(process.env.APPDATA, 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', encoded, 'package.json'),
    ] : []),
  ]
  for (const file of candidates) {
    if (fs.existsSync(file)) return file
  }
  try {
    const resolved = resolvePackage.resolve(`${name}/package.json`, { paths: [profileDir, dshHome()] })
    if (fs.existsSync(resolved)) return resolved
  } catch {
    // Some packages block the package.json subpath through exports. Resolve
    // their entry and walk up to the package root as a fallback.
    try {
      let current = path.dirname(resolvePackage.resolve(name, { paths: [profileDir, dshHome()] }))
      for (let depth = 0; depth < 6; depth += 1) {
        const file = path.join(current, 'package.json')
        const metadata = readJson<{ name?: string }>(file)
        if (metadata?.name === name) return file
        const parent = path.dirname(current)
        if (parent === current) break
        current = parent
      }
    } catch {
      // The package is genuinely unavailable to this process.
    }
  }
  return undefined
}

function packageMetadata(profileDir: string, name: string): PackageMetadata | undefined {
  const file = packageLocation(profileDir, name)
  return file ? readJson<PackageMetadata>(file) : undefined
}

/** Exported for the upstream resolver/updater: raw installed manifest fields. */
export function pluginManifest(profileDir: string, name: string): PackageMetadata | undefined {
  return packageMetadata(profileDir, name)
}

/** Return installed versions for DSH packages named by plugin manifests. */
export function installedDshPackageVersions(profileDir: string, names: Iterable<string>, dshVersion?: string): Record<string, string> {
  const versions: Record<string, string> = {}
  for (const name of names) {
    if (name !== '@deepseek-ai/dsh' && !name.startsWith('@deepseek-ai/dsh-')) continue
    const version = installedVersion(profileDir, name, dshVersion)
    if (version) versions[name] = version
  }
  return versions
}

function versionFromSpec(spec: string | undefined): string | undefined {
  if (!spec) return undefined
  const match = spec.match(/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/u)
  return match?.[1]
}

function installedVersion(profileDir: string, name: string, dshVersion?: string): string | undefined {
  return packageMetadata(profileDir, name)?.version ?? officialStaticClientVersion(profileDir, name, dshVersion)
}

function patchRows(entry: unknown): Record<string, unknown>[] {
  if (!entry || typeof entry !== 'object') return []
  if (Array.isArray(entry)) return entry.flatMap((item) => patchRows(item))
  const record = entry as Record<string, unknown>
  const rows: Record<string, unknown>[] = []
  if (typeof record.id === 'string') rows.push(record)
  for (const value of Object.values(record)) rows.push(...patchRows(value))
  return rows.filter((row, index, all) => all.indexOf(row) === index)
}

const descriptionCatalog: Record<string, string> = {
  '@deepseek-ai/dsh-base': 'DSH 的基础运行层：负责模型、会话、工具与权限，让各个插件在同一套运行环境中协同工作',
  '@deepseek-ai/dsh-web-app': 'DSH 的 Web 应用层：提供对话页面、浏览器交互和前端运行支持',
  'dsh-advisor-group': '自动深挖顾问群：多专家接力组会讨论，SSE 实时回放与综合结论',
  'dsh-mnemon': '跨会话记忆控制平面：运行时上下文、项目文档检索、可插拔长期记忆与受控策略',
  'dsh-insight-tree': 'DSH 结构、插件关系、版本适配与运行状态可视化面板',
  'dsh-chat-import': '导入外部聊天会话并继续（Claude/Codex/Kimi 等 19 种格式）',
}

function capabilitiesFor(profileDir: string, name: string): string[] {
  const catalog = capabilityCatalog[name]
  if (catalog) return catalog
  const metadata = packageMetadata(profileDir, name)
  const manifest: string[] = []
  if (metadata?.dsh?.client) manifest.push('Web 客户端界面/设置面板')
  if (metadata?.dsh?.bundle?.patch) manifest.push('插件层装配（bundle）')
  if (metadata?.dsh?.skills) manifest.push('技能包')
  if (metadata?.dsh?.mcpServers) manifest.push('MCP 服务器接入')
  if (metadata?.exports && Object.keys(metadata.exports).length > 1) manifest.push(`导出 ${Object.keys(metadata.exports).length} 个入口`)
  if (metadata?.keywords?.length) manifest.push(`关键词：${metadata.keywords.slice(0, 4).join('、')}`)
  if (manifest.length) return manifest
  const description = metadata?.description?.replace(/\s+/gu, ' ').trim()
  if (description) return [`功能说明：${description.length > 90 ? `${description.slice(0, 87)}…` : description}`]
  return ['扩展功能待识别']
}

function satisfies(version: string, range: string): boolean {
  const normalized = semver.valid(semver.clean(version) ?? version)
  if (!normalized) return false
  try {
    return semver.satisfies(normalized, range, { includePrerelease: true })
  } catch {
    return false
  }
}

/**
 * Web-only client contracts can be compiled into dsh-web-frontend's static
 * module table instead of being materialised in the Profile node_modules.
 * Treat those as installed only when the host package explicitly declares the
 * contract and is the same release as the running DSH version.
 */
function officialStaticClientVersion(profileDir: string, name: string, dshVersion?: string): string | undefined {
  if (!dshVersion || dshVersion === '未知' || !name.startsWith('@deepseek-ai/dsh-client-')) return undefined
  const host = packageMetadata(profileDir, '@deepseek-ai/dsh-web-frontend')
  if (!host?.version || host.version !== dshVersion) return undefined
  const declared = host.dependencies?.[name] ?? host.devDependencies?.[name]
  if (!declared || !satisfies(dshVersion, declared)) return undefined
  return dshVersion
}

function compatibility(profileDir: string, name: string, dshVersion: string): InsightTreeCompatibility {
  const metadata = packageMetadata(profileDir, name)
  if (!metadata) return { status: 'missing', label: '未找到安装包' }
  const isCore = name.startsWith('@deepseek-ai/dsh-')
  const declared = Object.entries({ ...metadata.dependencies, ...metadata.peerDependencies })
    .filter(([dependency]) => dependency === '@deepseek-ai/dsh' || dependency.startsWith('@deepseek-ai/dsh-'))
  if (isCore && declared.length === 0) {
    const actual = metadata.version
    if (!actual || dshVersion === '未知') return { status: 'unknown', label: '暂时无法确认', evidence: `核心包实际版本：${actual ?? '缺失'}；当前 DSH 版本：${dshVersion}` }
    if (actual === dshVersion) return { status: 'compatible', label: `与当前 DSH 本体 @deepseek-ai/dsh@${dshVersion} 一致`, evidence: `核心包 ${actual} 与当前 DSH ${dshVersion} 一致` }
    return { status: 'unknown', label: '暂时无法确认', evidence: `核心包 ${actual} 与当前 DSH ${dshVersion} 不同，未找到可用于判定的适配声明` }
  }
  if (declared.length === 0) return { status: 'unknown', label: '插件未声明适配范围', evidence: 'package.json 未声明 DSH 相关 dependencies/peerDependencies' }
  if (dshVersion === '未知') return { status: 'unknown', label: '无法读取当前 DSH 版本', requirement: declared.map(([, range]) => range).join('；'), evidence: `插件声明了 ${declared.map(([dependency, range]) => `${dependency} ${range}`).join('、')}` }
  const checks = declared.map(([dependency, range]) => {
    const actual = installedVersion(profileDir, dependency, dshVersion) ?? (dependency === '@deepseek-ai/dsh' || dependency === '@deepseek-ai/dsh-base' ? dshVersion : undefined)
    return { dependency, range, actual, ok: actual ? satisfies(actual, range) : false }
  })
  const requirement = checks.map(({ dependency, range }) => `${dependency} ${range}`).join('；')
  const missing = checks.filter(({ actual }) => !actual)
  if (missing.length > 0) return { status: 'unknown', label: '暂时无法确认', requirement, evidence: `找不到 ${missing.map(({ dependency }) => dependency).join('、')} 的实际版本` }
  const incompatible = checks.filter(({ ok }) => !ok)
  if (incompatible.length > 0) return { status: 'incompatible', label: `不适配当前 DSH 本体 @deepseek-ai/dsh@${dshVersion}`, requirement, evidence: incompatible.map(({ dependency, range, actual }) => `${dependency} ${actual} 不满足 ${range}`).join('；') }
  return { status: 'compatible', label: `适配当前 DSH 本体 @deepseek-ai/dsh@${dshVersion}`, requirement, evidence: checks.map(({ dependency, actual, range }) => `${dependency} ${actual} 满足 ${range}`).join('；') }
}

function statusFor(name: string, version: string | undefined, isBundle: boolean): { status: InsightTreePlugin['status']; findings: InsightTreeFinding[] } {
  const findings: InsightTreeFinding[] = []
  if (!version && !name.startsWith('@deepseek-ai/')) {
    findings.push({ id: `${name}:version-unknown`, severity: 'warning', impact: 'plugin', title: '版本信息不完整', message: '当前无法从 profile 清单确认这个扩展的版本。', evidence: 'package.json dependency specifier' })
  }
  return { status: findings.length ? 'warning' : 'active', findings }
}

export function discoverReport(
  profile: string,
  configuredVersion?: string,
  sessionUsage: Record<string, { count: number; lastActivity?: string }> = {},
  loaderEntries: InsightTreeLoaderEntry[] = [],
  activity?: InsightTreeActivity,
  options: DiscoverOptions = {},
): InsightTreeReport {
  const dir = resolveProfile(profile)
  const manifest = readJson<ProfileManifest>(path.join(dir, 'package.json')) ?? {}
  const dependencies = manifest.dependencies ?? {}
  const bundles = manifest.dsh?.profile?.bundles ?? []
  const bundleSet = new Set(bundles)
  const duplicateBundles = bundles.filter((name, index) => bundles.indexOf(name) !== index)
  const patchFile = path.join(dir, 'cordis.patch.yml')
  let parsedPatch: unknown[] | undefined
  let patchParseError: string | undefined
  if (fs.existsSync(patchFile)) {
    try {
      const parsed = yaml.load(fs.readFileSync(patchFile, 'utf8'))
      if (Array.isArray(parsed)) parsedPatch = parsed
      else patchParseError = 'patch 文件不是顶层条目数组'
    } catch (error) {
      patchParseError = error instanceof Error ? error.message : String(error)
    }
  }
  const patchReferences = (parsedPatch ?? [])
    .flatMap((entry) => patchRows(entry).map((row) => typeof row.name === 'string' ? row.name : ''))
    .filter(Boolean)
  const names = Array.from(new Set([...bundles, ...Object.keys(dependencies), ...patchReferences]))
  const installedCore = installedVersion(dir, '@deepseek-ai/dsh-base')
  const specCore = versionFromSpec(dependencies['@deepseek-ai/dsh-base'])
  let dshVersion = '未知'
  let versionSource: InsightTreeReport['versionSource'] = 'unknown'
  if (installedCore) { dshVersion = installedCore; versionSource = 'installed' }
  else if (specCore) { dshVersion = specCore; versionSource = 'spec' }
  else if (configuredVersion) { dshVersion = configuredVersion; versionSource = 'config' }

  const plugins: InsightTreePlugin[] = names.map((name) => {
    const version = installedVersion(dir, name, dshVersion) || versionFromSpec(dependencies[name])
    const checked = statusFor(name, version, bundleSet.has(name))
    const metadata = packageMetadata(dir, name)
    const compat = compatibility(dir, name, dshVersion)
    if (!metadata) {
      checked.findings.push({
        id: `${name}:package-missing`,
        severity: bundleSet.has(name) ? 'blocking' : 'warning',
        impact: bundleSet.has(name) ? 'startup' : 'plugin',
        title: '找不到安装包',
        message: bundleSet.has(name) ? '这个扩展被列入当前运行插件树，但安装包文件不存在，可能直接阻塞 DSH 启动。' : 'Profile 或 patch 记录了这个扩展，但本机找不到对应安装包。',
        recommendation: '重新安装该插件，或从 Profile 清单和 patch 中移除无效条目。',
        evidence: `package.json / ${name}`,
      })
      if (bundleSet.has(name)) checked.status = 'blocked'
    }
    if (metadata) {
      const declared = { ...metadata.dependencies, ...metadata.peerDependencies }
      for (const [dependency, range] of Object.entries(declared)) {
        const isPeer = Object.prototype.hasOwnProperty.call(metadata.peerDependencies ?? {}, dependency)
        if (metadata.peerDependenciesMeta?.[dependency]?.optional) continue
        const actual = installedVersion(dir, dependency, dshVersion)
        if (!actual) {
          const blocking = !isPeer && bundleSet.has(name)
          checked.findings.push({ id: `${name}:missing-dependency:${dependency}`, severity: blocking ? 'blocking' : 'warning', impact: blocking ? 'startup' : 'capability', title: isPeer ? '宿主关联未单独记录' : '依赖没有安装', message: isPeer ? `这个扩展声明需要宿主提供 ${dependency}，当前 Profile 没有独立包记录；这项声明本身不会阻塞 DSH 启动。` : `这个扩展需要 ${dependency}，但当前 Profile 找不到它，相关功能可能受影响。`, recommendation: isPeer ? '插件当前能正常运行时无需处理；只有对应功能异常时再核对宿主版本。' : `安装 ${dependency}，或移除依赖它的插件。`, evidence: `${name}/package.json 声明 ${dependency} ${range}` })
          if (blocking) checked.status = 'blocked'
          else if (checked.status === 'active') checked.status = 'warning'
        } else if (!satisfies(actual, range)) {
          checked.findings.push({ id: `${name}:dependency-version:${dependency}`, severity: 'warning', impact: 'capability', title: '依赖版本不满足', message: `${dependency} 当前为 ${actual}，没有满足该扩展声明的 ${range}，相关能力可能受影响。`, recommendation: '安装满足范围的依赖版本，或更新该插件。', evidence: `${dependency} ${actual} 不满足 ${range}` })
          if (checked.status === 'active') checked.status = 'warning'
        }
      }
    }
    if (compat.status === 'incompatible') {
      checked.findings.push({ id: `${name}:incompatible`, severity: 'warning', impact: 'plugin', title: '版本可能不适配', message: `声明范围 ${compat.requirement} 与当前 DSH ${dshVersion} 不一致。`, recommendation: '升级插件或使用匹配的 DSH 版本。' })
      if (checked.status === 'active') checked.status = 'warning'
    }
    if (bundleSet.has(name) && !dependencies[name] && !name.startsWith('@deepseek-ai/')) {
      checked.findings.push({ id: `${name}:missing-dependency`, severity: 'blocking', impact: 'startup', title: '已装配但缺少安装依赖', message: '这个扩展出现在当前插件树中，但 profile 没有对应的安装依赖，DSH 可能无法启动。', evidence: 'dsh.profile.bundles / dependencies' })
      checked.status = 'blocked'
    }
    if (!bundleSet.has(name) && dependencies[name]) {
      checked.findings.push({ id: `${name}:not-mounted`, severity: 'info', impact: 'none', title: '已安装但未启用', message: '这个扩展已安装在 profile 中，但当前没有进入运行插件树。', evidence: 'dependencies without dsh.profile.bundles entry' })
    }
    return {
      id: name,
      name: name.startsWith('@deepseek-ai/') ? name.replace('@deepseek-ai/', 'DSH ') : name,
      source: name.startsWith('@deepseek-ai/') ? 'core' : bundleSet.has(name) ? 'bundle' : 'user',
      status: checked.status,
      version,
      packagePath: packageLocation(dir, name),
      compatibility: compat,
      role: bundleSet.has(name) ? '已装配到当前 Profile' : '已安装但未进入当前插件树',
      provides: bundleSet.has(name) ? capabilitiesFor(dir, name) : [],
      description: descriptionCatalog[name] ?? (metadata?.description?.replace(/\s+/gu, ' ').trim() || undefined),
      dependsOn: Object.keys({ ...metadata?.dependencies, ...metadata?.peerDependencies }).filter((dep) => dep !== name),
      dependents: [],
      findings: checked.findings,
      sessionUsage: sessionUsage[name],
    }
  })
  for (const plugin of plugins) for (const dependency of plugin.dependsOn) {
    const target = plugins.find((item) => item.id === dependency)
    if (target && !target.dependents.includes(plugin.id)) target.dependents.push(plugin.id)
  }

  // Merge live Loader entries (authoritative fiber phases) onto manifest plugins.
  const loaderByModule = new Map(loaderEntries.map((entry) => [entry.moduleName, entry]))
  for (const plugin of plugins) {
    const entries = loaderEntries.filter((item) => loaderEntryBelongsToPlugin({ id: item.entryId, options: { name: item.moduleName }, disabled: !item.enabled }, plugin.id))
    // Aggregated bundles often include optional child modules which are
    // intentionally disabled by default. The root module is the source of
    // truth for the bundle's lifecycle; child phases still contribute to
    // diagnostics when the root is not present.
    const rootEntries = entries.filter((item) => item.moduleName === plugin.id || item.moduleName === plugin.name || item.entryId === plugin.id || item.entryId === plugin.name)
    const stateEntries = rootEntries.length > 0 ? rootEntries : entries
    const entry = loaderByModule.get(plugin.id) ?? loaderEntries.find((item) => item.moduleName === plugin.name)
    if (entries.length > 0 || entry) {
      const matched = stateEntries.length > 0 ? stateEntries : [entry as InsightTreeLoaderEntry]
      const phases = matched.map((item) => item.fiberPhase)
      plugin.loaderEntryId = matched[0]?.entryId
      plugin.enabled = matched.every((item) => item.enabled)
      plugin.fiberPhase = phases.includes('failed') ? 'failed' : phases.includes('loading') ? 'loading' : phases.includes('pending') ? 'pending' : phases.includes('unloading') ? 'unloading' : phases.every((phase) => phase === null) ? null : 'active'
    }
  }

  // A live Loader phase is stronger evidence than a static dependency
  // declaration. Peer packages may be supplied by the host, and pnpm may
  // resolve a dependency through a workspace/junction that is not visible at
  // the profile root. Keep the declaration visible, but never call an active
  // plugin startup-blocking solely because that static lookup missed it.
  for (const plugin of plugins) {
    if (plugin.fiberPhase !== 'active' || plugin.enabled === false) continue
    for (const finding of plugin.findings) {
      if (finding.id === `${plugin.id}:package-missing` || finding.id.startsWith(`${plugin.id}:missing-dependency`)) {
        finding.severity = 'info'
        finding.impact = 'none'
        finding.title = '运行正常，未发现启动影响'
        finding.message = `当前 Loader 已正常加载 ${plugin.name}；这条静态依赖记录没有造成 DSH 启动问题。`
        finding.recommendation = '无需处理；如果对应功能出现异常，再检查插件自身的依赖声明。'
        delete finding.action
      } else if (finding.id.startsWith(`${plugin.id}:dependency-version:`)) {
        finding.severity = 'info'
        finding.impact = 'none'
        finding.title = '运行正常，存在版本差异'
        finding.message = `当前 Loader 已正常加载 ${plugin.name}；依赖版本与插件声明不同，但目前未观察到运行影响。`
        finding.recommendation = '暂不需要处理；只有对应能力出现异常时，再更新插件或依赖。'
        delete finding.action
      }
    }
    if (!plugin.findings.some((finding) => finding.severity === 'warning' || finding.severity === 'degraded' || finding.severity === 'blocking')) plugin.status = 'active'
  }

  // The independent diagnostic intentionally has no live Loader evidence.
  // A non-blocking dependency declaration difference is therefore only an
  // unconfirmed hint; it must not make a healthy-looking profile appear risky.
  if (options.probeRuntime === false) {
    for (const plugin of plugins) {
      for (const finding of plugin.findings) {
        if (finding.severity === 'blocking') continue
        if (finding.id.startsWith(`${plugin.id}:missing-dependency:`)) {
          finding.severity = 'info'
          finding.impact = 'none'
          finding.title = '依赖声明待确认'
          finding.message = '独立诊断没有加载运行实例，无法确认这项依赖声明是否影响功能；目前没有证据表明它会阻塞 DSH 启动。'
          finding.recommendation = '插件可以正常使用时无需处理；只有对应功能异常时，再检查宿主或依赖版本。'
        } else if (finding.id.startsWith(`${plugin.id}:dependency-version:`)) {
          finding.severity = 'info'
          finding.impact = 'none'
          finding.title = '版本差异待确认'
          finding.message = '独立诊断没有加载运行实例，当前只能看到版本声明差异，无法确认它是否已经影响功能。'
          finding.recommendation = '插件可以正常使用时无需处理；只有对应功能异常时，再更新插件或依赖。'
        }
      }
      const staticMissing = plugin.findings.filter((finding) => finding.id.startsWith(`${plugin.id}:missing-dependency:`) && finding.severity === 'info')
      if (staticMissing.length > 1) {
        const primary = staticMissing[0]
        const dependencies = staticMissing.map((finding) => finding.id.slice(`${plugin.id}:missing-dependency:`.length))
        primary.title = `依赖声明待确认（${staticMissing.length} 项）`
        primary.message = `独立诊断没有加载运行实例，当前无法确认 ${dependencies.join('、')} 这些依赖声明是否影响功能；目前没有证据表明它们会阻塞 DSH 启动。`
        primary.evidence = staticMissing.map((finding) => finding.evidence).filter(Boolean).join('；')
        plugin.findings = plugin.findings.filter((finding) => !staticMissing.includes(finding) || finding === primary)
      }
      const staticVersions = plugin.findings.filter((finding) => finding.id.startsWith(`${plugin.id}:dependency-version:`) && finding.severity === 'info')
      if (staticVersions.length > 1) {
        const primary = staticVersions[0]
        const dependencies = staticVersions.map((finding) => finding.id.slice(`${plugin.id}:dependency-version:`.length))
        primary.title = `版本差异待确认（${staticVersions.length} 项）`
        primary.message = `独立诊断没有加载运行实例，当前只能看到 ${dependencies.join('、')} 的版本声明差异，无法确认它们是否已经影响功能。`
        primary.evidence = staticVersions.map((finding) => finding.evidence).filter(Boolean).join('；')
        plugin.findings = plugin.findings.filter((finding) => !staticVersions.includes(finding) || finding === primary)
      }
      if (!plugin.findings.some((finding) => finding.severity === 'warning' || finding.severity === 'degraded' || finding.severity === 'blocking')) plugin.status = 'active'
    }
  }

  const findings = plugins.flatMap((plugin) => plugin.findings)
  if (duplicateBundles.length) findings.push({ id: 'profile:duplicate-bundles', severity: 'blocking', impact: 'startup', title: '插件被重复装配', message: `当前 Profile 重复装配了 ${Array.from(new Set(duplicateBundles)).join('、')}，可能导致重复注册或路由冲突。`, recommendation: '保留一个来源，删除重复的 bundle 声明。', evidence: 'dsh.profile.bundles' })
  let runtime: InsightTreeReport['runtime'] = options.probeRuntime === false
    ? { dumpConfig: 'ok', activatedEntries: 0, probe: 'skipped', error: '独立诊断未执行完整 DSH 配置加载' }
    : { dumpConfig: 'failed', activatedEntries: 0, probe: 'live' }
  if (options.probeRuntime !== false) try {
    const command = process.platform === 'win32' ? 'dsh.cmd' : 'dsh'
    const dump = execFileSync(command, ['--profile', profile, '--dump-config'], { encoding: 'utf8', timeout: 5000, windowsHide: true, shell: process.platform === 'win32' })
    runtime = { dumpConfig: 'ok', activatedEntries: (dump.match(/^\s*- id:/gmu) || []).length, probe: 'live' }
  } catch (error) {
    runtime.error = error instanceof Error ? error.message.slice(0, 240) : String(error).slice(0, 240)
  }
  const disabledIds = new Set<string>()
  try {
    if (Array.isArray(parsedPatch)) for (const entry of parsedPatch) for (const row of patchRows(entry)) {
      if (row.disabled === true && typeof row.id === 'string') disabledIds.add(row.id)
    }
  } catch { /* invalid patch is reported below */ }
  for (const plugin of plugins) if (plugin.enabled === false || disabledIds.has(plugin.id) || (plugin.loaderEntryId ? disabledIds.has(plugin.loaderEntryId.split(':').pop() ?? '') : false)) {
    plugin.status = 'disabled'
    plugin.role = '已安装但暂时关闭'
  }
  if (patchParseError) findings.push({ id: 'profile:patch-invalid', severity: 'blocking', impact: 'startup', title: '配置文件无法读取', message: '当前 Profile 的补丁文件不是 DSH 能读取的条目列表，可能直接阻塞启动。', recommendation: '修正 patch 文件的 YAML 和顶层数组结构后重新检查。', evidence: patchParseError })

  if (Array.isArray(parsedPatch)) {
    const invalidRows = parsedPatch.filter((entry) => patchRows(entry).length === 0)
    if (invalidRows.length) findings.push({ id: 'profile:patch-entry-invalid', severity: 'blocking', impact: 'startup', title: '配置里有无法识别的条目', message: `patch 文件中有 ${invalidRows.length} 条记录没有有效的插件标识，DSH 可能无法按预期装配。`, recommendation: '为每条配置补上有效 id，或删除无法识别的记录。', evidence: 'cordis.patch.yml' })
  }

  for (const plugin of plugins) {
    const metadata = packageMetadata(dir, plugin.id)
    const patchSpec = metadata?.dsh?.bundle?.patch
    if (!patchSpec || !plugin.source || plugin.source === 'user') continue
    const packageFile = packageLocation(dir, plugin.id)
    if (!packageFile) continue
    const patchPath = path.resolve(path.dirname(packageFile), patchSpec)
    if (!fs.existsSync(patchPath)) {
      const finding: InsightTreeFinding = { id: `${plugin.id}:bundle-patch-missing`, severity: 'blocking', impact: 'startup', title: '插件装配文件缺失', message: '插件声明了运行配置，但对应的装配文件找不到，可能阻塞 DSH 启动。', recommendation: '重新安装插件，或修复 package.json 中的 bundle 配置。', evidence: `${plugin.id}/package.json → ${patchSpec}` }
      plugin.findings.push(finding)
      plugin.status = 'blocked'
      findings.push(finding)
    }
  }

  const patchIds = (parsedPatch ?? []).flatMap((entry) => patchRows(entry).map((row) => row.id)).filter((id): id is string => typeof id === 'string')
  const duplicatePatchIds = [...new Set(patchIds.filter((id, index) => patchIds.indexOf(id) !== index))]
  if (duplicatePatchIds.length) findings.push({ id: 'profile:duplicate-patch-rows', severity: 'blocking', impact: 'startup', title: '配置里重复修改了同一插件', message: `patch 文件重复出现 ${duplicatePatchIds.join('、')}，不同配置可能互相覆盖或造成重复装配。`, recommendation: '保留一条明确的配置，删除重复 patch 行。', evidence: 'cordis.patch.yml' })

  const enabledLoaderModules = loaderEntries.filter((entry) => entry.enabled).map((entry) => entry.moduleName)
  const duplicateLoaderModules = [...new Set(enabledLoaderModules.filter((name, index, list) => list.indexOf(name) !== index))]
  if (duplicateLoaderModules.length) findings.push({ id: 'runtime:duplicate-loader-entries', severity: 'blocking', impact: 'startup', title: '同一个插件被重复加载', message: `运行时发现 ${duplicateLoaderModules.join('、')} 出现多次，可能造成重复注册或路由冲突。`, recommendation: '检查 bundle、Profile 和 patch 是否重复挂载同一插件。', evidence: loaderEntries.map((entry) => `${entry.entryId}=${entry.moduleName}`).join('; ') })

  const ruled = applyRules(plugins, findings)
  const finalFindings = ruled.findings
  // Rules may add/rename report-level findings (loader fibers, core-disabled)
  // or decorate them with actions. Merge every plugin-scoped final finding
  // back onto its plugin so the client's per-plugin filter/detail stays
  // consistent with the summary count.
  for (const plugin of plugins) {
    const owned = finalFindings.filter((finding) => finding.id.startsWith(`${plugin.id}:`) || finding.id.startsWith(`loader:${plugin.id}:`))
    if (owned.length) plugin.findings = owned
  }
  const ownedBy = (finding: InsightTreeFinding): InsightTreePlugin | undefined => plugins.find((plugin) => finding.id.startsWith(`${plugin.id}:`) || finding.id.startsWith(`loader:${plugin.id}:`))
  const blockedPlugins = new Set(plugins.filter((plugin) => plugin.status === 'blocked').map((plugin) => plugin.id))
  const blocked = blockedPlugins.size + finalFindings.filter((finding) => finding.severity === 'blocking' && !ownedBy(finding)).length
  const attentionPlugins = new Set(plugins.filter((plugin) => plugin.status === 'warning' || plugin.status === 'degraded' || plugin.status === 'disabled').map((plugin) => plugin.id))
  const attention = attentionPlugins.size + finalFindings.filter((finding) => (finding.severity === 'warning' || finding.severity === 'degraded') && !ownedBy(finding)).length
  let patchEntries = 0
  try {
    if (fs.existsSync(patchFile)) {
      patchEntries = Array.isArray(parsedPatch) ? parsedPatch.length : 0
    }
  } catch { /* patch finding below explains the invalid file */ }
  return {
    schemaVersion: 3,
    generatedAt: new Date().toISOString(),
    dshVersion,
    versionSource,
    profile,
    patch: { entries: patchEntries, reload: manifest.dsh?.profile?.patchReload },
    usage: { sessionEvents: 0, toolCalls: 0 },
    activity,
    loader: loaderEntries,
    ruleVersion: RULES_VERSION,
    runtime,
    status: blocked ? 'blocked' : attention ? 'attention' : 'ready',
    summary: { total: plugins.length, active: Math.max(0, plugins.length - attention - blocked), attention, blocked },
    plugins,
    findings: finalFindings,
    recommendedActions: finalFindings.map((finding) => finding.recommendation).filter((value): value is string => Boolean(value)),
  }
}

export function readPatchSummary(profile: string): { entries: number; reload?: string } {
  const dir = resolveProfile(profile)
  const manifest = readJson<ProfileManifest>(path.join(dir, 'package.json'))
  const file = path.join(dir, 'cordis.patch.yml')
  if (!fs.existsSync(file)) return { entries: 0, reload: manifest?.dsh?.profile?.patchReload }
  try {
    const parsed = yaml.load(fs.readFileSync(file, 'utf8'))
    return { entries: Array.isArray(parsed) ? parsed.length : 0, reload: manifest?.dsh?.profile?.patchReload }
  } catch {
    return { entries: 0, reload: manifest?.dsh?.profile?.patchReload }
  }
}
