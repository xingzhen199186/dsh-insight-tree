import type { InsightTreeReport } from './model.js'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import yaml from 'js-yaml'
import { renderCompareMarkdown, renderMarkdownReport, renderPluginCsv, sanitizeReport } from './export.js'
import type { InsightTreeCompareEntry } from './export.js'
import { loaderEntryBelongsToPlugin } from './loader.js'
import { installedDshPackageVersions, pluginManifest } from './discovery.js'
import { buildVerdict, catalogUrl, isOfficialPlugin, loadCatalog, registryBase, resolveUpstream, versionNeedsConfirmation, type UpstreamState, type UpstreamVerdict } from './upstream.js'

const loopback = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/iu

interface RouteOptions {
  token?: string
  getCompare?: (profiles: string[]) => InsightTreeCompareEntry[]
  getSessionReport?: (sessionId: string) => Promise<InsightTreeReport>
  runtime?: InsightTreeRuntime
  hostVersion?: string
}

export interface InsightTreeRuntime {
  setDisabled: (pluginId: string, disabled: boolean) => Promise<{ matched: number }>
  remove: (pluginId: string) => Promise<{ matched: number }>
}

interface DshInvocation { file: string; args: string[]; cwd?: string; viaShell: boolean }

function quoteCmdArg(value: string): string {
  return /[\s"&|<>^()%!]/u.test(value) ? `"${value.replace(/"/gu, '""')}"` : value
}

function dshInvocation(): DshInvocation {
  const entry = process.argv[1]
  if (entry && /[\\/]bin\.(?:js|ts)$/u.test(entry)) return { file: process.execPath, args: [...process.execArgv, entry], cwd: path.dirname(entry), viaShell: false }
  return { file: process.platform === 'win32' ? 'dsh.cmd' : 'dsh', args: [], viaShell: process.platform === 'win32' }
}

function spawnDsh(args: string[], options: Parameters<typeof spawn>[2] = {}) {
  const invocation = dshInvocation()
  if (!invocation.viaShell || process.platform !== 'win32') return spawn(invocation.file, [...invocation.args, ...args], { ...options, cwd: invocation.cwd, shell: false })
  const commandLine = [invocation.file, ...invocation.args, ...args].map(quoteCmdArg).join(' ')
  return spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `"${commandLine}"`], { ...options, shell: false, windowsVerbatimArguments: true })
}

interface RouteRequest {
  method?: string
  headers: Record<string, string | undefined>
  url?: string
}

interface RouteResponse {
  writeHead: (status: number, headers: Record<string, string>) => void
  end: (body: string) => void
}

let mutationLock = false

const securityHeaders: Record<string, string> = {
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'data:'",
  'x-content-type-options': 'nosniff',
}

function profilePatch(profile: string): string {
  return path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'profiles', profile, 'cordis.patch.yml')
}

function patchEntryMatches(entry: unknown, id: string): boolean {
  if (!entry || typeof entry !== 'object') return false
  if (Array.isArray(entry)) return entry.some((item) => patchEntryMatches(item, id))
  const record = entry as Record<string, unknown>
  if (record.id === id) return true
  return Object.values(record).some((value) => patchEntryMatches(value, id))
}

function updatePatchEntry(entry: unknown, id: string, disabled: boolean): unknown {
  if (!entry || typeof entry !== 'object') return entry
  if (Array.isArray(entry)) return entry.map((item) => updatePatchEntry(item, id, disabled))
  const record = entry as Record<string, unknown>
  if (record.id === id) return { ...record, disabled }
  return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, updatePatchEntry(value, id, disabled)]))
}

export function updatePatchEntries(entries: unknown[], id: string, disabled: boolean): { entries: unknown[]; matched: boolean } {
  let matched = false
  const next = entries.map((entry) => {
    if (!patchEntryMatches(entry, id)) return entry
    matched = true
    return updatePatchEntry(entry, id, disabled)
  })
  if (!matched) next.push({ id, disabled })
  return { entries: next, matched }
}

/** Remove plugin-owned disable/enable rows after a package uninstall. */
export function removePatchEntries(entries: unknown[], ids: readonly string[]): { entries: unknown[]; removed: number } {
  const wanted = new Set(ids)
  let removed = 0
  const REMOVE = Symbol('remove-patch-entry')
  const clean = (value: unknown): unknown | typeof REMOVE => {
    if (Array.isArray(value)) {
      const output: unknown[] = []
      for (const item of value) {
        const next = clean(item)
        if (next === REMOVE) {
          removed += 1
          continue
        }
        output.push(next)
      }
      return output
    }
    if (!value || typeof value !== 'object') return value
    const record = value as Record<string, unknown>
    if (typeof record.id === 'string' && wanted.has(record.id)) return REMOVE
    const output: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(record)) {
      const next = clean(item)
      if (next === REMOVE) continue
      output[key] = next
    }
    if (Object.keys(output).length === 0) return REMOVE
    return output
  }
  return { entries: clean(entries) as unknown[], removed }
}

function runDshDryRun(profile: string, patchFile: string): Promise<{ ok: boolean; message: string }> {
  return new Promise((resolve) => {
    const child = spawnDsh(['--profile', profile, '--patch', patchFile, '--dump-config'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    const timer = setTimeout(() => {
      child.kill()
      resolve({ ok: false, message: 'dry-run 超时' })
    }, 20000)
    child.once('error', (error) => {
      clearTimeout(timer)
      resolve({ ok: false, message: `无法启动 dry-run：${error.message}` })
    })
    child.once('exit', (code) => {
      clearTimeout(timer)
      resolve(code === 0 ? { ok: true, message: '' } : { ok: false, message: `dry-run 退出码 ${code ?? '未知'}：${[stderr, stdout].map((value) => value.trim()).filter(Boolean).join('；').slice(0, 400) || '没有可用错误摘要'}` })
    })
  })
}

async function setPluginDisabled(profile: string, id: string, disabled: boolean, runtime?: InsightTreeRuntime, patchIds: readonly string[] = [id]): Promise<{ ok: boolean; message: string; backup?: string; restartRequired: boolean; appliedNow?: boolean; rollbackCommand?: string }> {
  if (!/^[\w@./-]+$/u.test(id)) return { ok: false, message: '插件标识格式无效', restartRequired: true }
  if (id === 'dsh-insight-tree' || id.startsWith('@deepseek-ai/')) return { ok: false, message: '核心 DSH 包和当前诊断插件不能在自身页面中关闭。', restartRequired: false }
  const file = profilePatch(profile)
  let entries: unknown[] = []
  try {
    if (fs.existsSync(file)) {
      const parsed = yaml.load(fs.readFileSync(file, 'utf8'))
      if (!Array.isArray(parsed)) return { ok: false, message: 'patch 文件不是顶层数组', restartRequired: true }
      entries = parsed
    }
  } catch (error) {
    return { ok: false, message: `patch 文件无法解析：${error instanceof Error ? error.message : String(error)}`, restartRequired: true }
  }
  const ids = [...new Set(patchIds.filter((value) => /^[\w@./-]+$/u.test(value)))]
  const next = ids.reduce((current, patchId) => updatePatchEntries(current, patchId, disabled).entries, entries)
  // Round-trip: the patch must parse back as an array before we touch the real file.
  try {
    const roundTrip = yaml.load(yaml.dump(next, { noRefs: true, lineWidth: -1 }))
    if (!Array.isArray(roundTrip)) return { ok: false, message: 'dry-run 校验失败：生成的配置不是顶层数组', restartRequired: true }
  } catch (error) {
    return { ok: false, message: `dry-run 校验失败：${error instanceof Error ? error.message : String(error)}`, restartRequired: true }
  }
  // Composition-level dry-run: apply the proposed patch as an overlay and dump-config.
  const tmp = path.join(os.tmpdir(), `dsh-insight-tree-${Date.now()}.yml`)
  const validationOverlay = ids.map((patchId) => ({ id: patchId, disabled }))
  fs.writeFileSync(tmp, yaml.dump(validationOverlay, { noRefs: true, lineWidth: -1 }), 'utf8')
  const dryRun = await runDshDryRun(profile, tmp)
  fs.unlinkSync(tmp)
  if (!dryRun.ok) return { ok: false, message: `dry-run 未通过，未修改原配置：${dryRun.message}`, restartRequired: true }
  const backup = `${file}.bak-insight-tree-${Date.now()}`
  if (fs.existsSync(file)) fs.copyFileSync(file, backup)
  let appliedNow = false
  try {
    if (runtime) appliedNow = (await runtime.setDisabled(id, disabled)).matched > 0
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, yaml.dump(next, { noRefs: true, lineWidth: -1 }), 'utf8')
  } catch (error) {
    if (appliedNow && runtime) {
      try { await runtime.setDisabled(id, !disabled) } catch { /* preserve the primary failure */ }
    }
    try {
      if (fs.existsSync(backup)) fs.copyFileSync(backup, file)
      else if (fs.existsSync(file)) fs.unlinkSync(file)
    } catch { /* preserve the original operation error */ }
    return {
      ok: false,
      message: `操作未完成，配置已恢复：${error instanceof Error ? error.message : String(error)}`,
      backup,
      restartRequired: true,
    }
  }
  return {
    ok: true,
    message: disabled
      ? appliedNow ? `已暂时关闭 ${id}，当前运行实例已立即停止。` : `已暂时关闭 ${id}，配置已保存；当前没有可立即停止的运行实例。`
      : appliedNow ? `已重新启用 ${id}，当前运行实例已立即加载。` : `已重新启用 ${id}，配置已保存；当前没有可立即加载的运行实例。`,
    backup,
    restartRequired: !appliedNow,
    appliedNow,
    rollbackCommand: `dsh plugin --profile ${profile} add ${id}`,
  }
}

async function uninstallPlugin(profile: string, id: string, runtime?: InsightTreeRuntime, patchIds: readonly string[] = [id]): Promise<{ ok: boolean; message: string; restartRequired: boolean; appliedNow?: boolean; rollbackCommand?: string }> {
  if (!/^[\w@./-]+$/u.test(id) || id.startsWith('@deepseek-ai/') || id === 'dsh-insight-tree') return Promise.resolve({ ok: false, message: '核心 DSH 包或当前诊断插件不能从 Insight Tree 中卸载。', restartRequired: true })
  const profileDir = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'profiles', profile)
  const packageFile = path.join(profileDir, 'package.json')
  const patchFile = path.join(profileDir, 'cordis.patch.yml')
  const stamp = Date.now()
  if (fs.existsSync(packageFile)) fs.copyFileSync(packageFile, `${packageFile}.bak-insight-tree-${stamp}`)
  if (fs.existsSync(patchFile)) fs.copyFileSync(patchFile, `${patchFile}.bak-insight-tree-${stamp}`)
  return new Promise((resolve) => {
    const child = spawnDsh(['plugin', '--profile', profile, 'remove', id], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    child.once('error', (error) => resolve({ ok: false, message: `无法启动卸载命令：${error.message}`, restartRequired: true }))
    child.once('exit', async (code) => {
      if (code !== 0) {
        resolve({ ok: false, message: `卸载命令退出码为 ${code ?? '未知'}：${[stderr, stdout].map((value) => value.trim()).filter(Boolean).join('；').slice(0, 400) || '没有可用错误摘要'}`, restartRequired: true })
        return
      }
      try {
        let appliedNow = false
        let runtimeNote = ''
        let runtimeFailure = false
        if (runtime) {
          try {
            appliedNow = (await runtime.remove(id)).matched > 0
          } catch (error) {
            runtimeNote = `当前运行实例未能移除：${error instanceof Error ? error.message : String(error)}`
            try { appliedNow = (await runtime.setDisabled(id, true)).matched > 0 } catch { runtimeFailure = true }
          }
        }
        let patchNote = ''
        try {
          if (fs.existsSync(patchFile)) {
            const parsed = yaml.load(fs.readFileSync(patchFile, 'utf8'))
            if (Array.isArray(parsed)) {
              const cleaned = removePatchEntries(parsed, patchIds)
              if (cleaned.removed > 0) fs.writeFileSync(patchFile, yaml.dump(cleaned.entries, { noRefs: true, lineWidth: -1 }), 'utf8')
            }
          }
        } catch (error) {
          patchNote = `补丁清理未完成：${error instanceof Error ? error.message : String(error)}`
        }
        const detail = [runtimeNote, patchNote].filter(Boolean).join('；')
        resolve({
          ok: !runtimeFailure,
          message: appliedNow
            ? `已卸载 ${id}，当前运行实例已立即移除。${detail ? ` ${detail}` : ''}`
            : runtimeFailure
              ? `已从 Profile 移除 ${id}，但当前运行实例无法确认已停止。请重启 DSH 完成清理；${detail}`
              : `已卸载 ${id}，当前没有可立即移除的运行实例。${detail ? ` ${detail}` : ''}`,
          rollbackCommand: `dsh plugin --profile ${profile} add ${id}`,
          restartRequired: !appliedNow || Boolean(runtimeNote || patchNote),
          appliedNow,
        })
      } catch (error) {
        resolve({
          ok: true,
          message: `已卸载 ${id}，但当前运行实例未能立即停止：${error instanceof Error ? error.message : String(error)}。请重启 DSH 完成清理。`,
          rollbackCommand: `dsh plugin --profile ${profile} add ${id}`,
          restartRequired: true,
          appliedNow: false,
        })
      }
    })
  })
}

function send(res: RouteResponse, status: number, body: string, extra: Record<string, string> = {}): void {
  res.writeHead(status, { ...securityHeaders, ...extra })
  res.end(body)
}

function profileDirectory(profile: string): string {
  return path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'profiles', profile)
}

async function buildUpstreamState(report: InsightTreeReport, profile: string, hostVersion: string): Promise<UpstreamState> {
  const dir = profileDirectory(profile)
  const catalog = await loadCatalog()
  const dshPackageNames = new Set<string>()
  const manifests = new Map<string, ReturnType<typeof pluginManifest>>()
  for (const plugin of report.plugins) {
    const manifest = pluginManifest(dir, plugin.id)
    manifests.set(plugin.id, manifest)
    for (const name of Object.keys({ ...(manifest?.dependencies ?? {}), ...(manifest?.peerDependencies ?? {}) })) dshPackageNames.add(name)
  }
  const installedDshVersions = installedDshPackageVersions(dir, dshPackageNames, hostVersion)
  const plugins: UpstreamVerdict[] = []
  let errors = 0
  // Keep network pressure bounded while avoiding a 15+ plugin serial wait.
  for (let offset = 0; offset < report.plugins.length; offset += 6) {
    const batch = report.plugins.slice(offset, offset + 6)
    const verdicts = await Promise.all(batch.map(async (plugin) => {
      const manifest = manifests.get(plugin.id)
      try {
        const verdict = await resolveUpstream(plugin.id, { name: plugin.name, version: plugin.version, repository: manifest?.repository, homepage: manifest?.homepage, installedDshVersions }, hostVersion)
        if (verdict.error) errors += 1
        return verdict
      } catch {
        errors += 1
        return buildVerdict({ id: plugin.id, name: plugin.name, version: plugin.version, hostVersion, profile, resource: { catalog, packument: null } })
      }
    }))
    plugins.push(...verdicts)
  }
  return {
    state: catalog.state === 'offline' && errors > 0 ? 'offline' : errors > 0 ? 'partial' : catalog.state,
    hostVersion,
    profile,
    generatedAt: new Date().toISOString(),
    registry: registryBase(),
    catalogUrl: catalogUrl(),
    catalogCount: catalog.count,
    catalogFetchedAt: catalog.fetchedAt,
    plugins,
  }
}

function runAdd(profile: string, spec: string, extra: string[] = [], timeoutMs = 300_000): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawnDsh(['plugin', '--profile', profile, 'add', spec, ...extra], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    const timer = setTimeout(() => {
      child.kill()
      resolve({ code: null, stdout, stderr })
    }, timeoutMs)
    child.once('error', (error) => {
      clearTimeout(timer)
      resolve({ code: null, stdout, stderr: `${stderr}${error.message}` })
    })
    child.once('exit', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
  })
}

function restoreInstalledDependencies(profileDir: string): Promise<boolean> {
  if (!fs.existsSync(path.join(profileDir, 'pnpm-lock.yaml'))) return Promise.resolve(true)
  return new Promise((resolve) => {
    const command = process.platform === 'win32' ? (process.env.ComSpec ?? 'cmd.exe') : 'pnpm'
    const args = process.platform === 'win32'
      ? ['/d', '/s', '/c', 'pnpm install --offline --frozen-lockfile --ignore-scripts']
      : ['install', '--offline', '--frozen-lockfile', '--ignore-scripts']
    const child = spawn(command, args, { cwd: profileDir, windowsHide: true, stdio: 'ignore', shell: false })
    const timer = setTimeout(() => { child.kill(); resolve(false) }, 120_000)
    child.once('error', () => { clearTimeout(timer); resolve(false) })
    child.once('exit', (code) => { clearTimeout(timer); resolve(code === 0) })
  })
}

interface UpdateResult {
  ok: boolean
  message: string
  needsConfirm?: boolean
  warning?: string
  before?: string
  after?: string
  backup?: string
  rollbackCommand?: string
  restartRequired: boolean
}

async function applyPluginUpdate(report: InsightTreeReport, profile: string, hostVersion: string, id: string, requested: string, confirm: string): Promise<UpdateResult> {
  const target = report.plugins.find((plugin) => plugin.id === id)
  if (!target) return { ok: false, message: '找不到这个插件，未执行更新。', restartRequired: false }
  if (target.source === 'core' || isOfficialPlugin(id) || id === 'dsh-insight-tree') return { ok: false, message: '官方内置/核心包与当前诊断插件不能通过插件树更新。', restartRequired: false }
  if (!/^[\w@./-]+$/u.test(id)) return { ok: false, message: '插件标识格式无效', restartRequired: false }
  const dir = profileDirectory(profile)
  const manifest = pluginManifest(dir, id)
  const dshPackageNames = Object.keys({ ...(manifest?.dependencies ?? {}), ...(manifest?.peerDependencies ?? {}) })
  const installedDshVersions = installedDshPackageVersions(dir, dshPackageNames, hostVersion)
  const verdict = await resolveUpstream(id, { name: target.name, version: target.version, repository: manifest?.repository, homepage: manifest?.homepage, installedDshVersions }, hostVersion)
  const candidate = verdict.versions.find((item) => item.version === requested)
  if (!candidate) return { ok: false, message: `上游源中找不到版本 ${requested}${verdict.sourceKind === 'local' ? '（未发现可下载源）' : ''}。`, restartRequired: false }
  if (versionNeedsConfirmation(candidate, verdict.latestCompatible) && confirm !== '1') {
    const reason = candidate.hostOk === false
      ? `${candidate.ranges ?? '该版本声明的 DSH 范围不满足宿主'}`
      : '该版本没有声明可核对的 DSH 适配范围，且当前存在更明确的兼容版本'
    return {
      ok: false,
      needsConfirm: true,
      warning: `${id}@${requested} 与当前 DSH ${hostVersion} 可能不适配（${reason}）。继续安装/更新可能影响插件运行，请确认后重试。`,
      message: '版本与宿主不适配，需要用户确认',
      restartRequired: false,
    }
  }
  const npmName = verdict.npmName
  const spec = npmName ? `${npmName}@${requested}` : verdict.repo ? `github:${verdict.repo}@${requested}` : ''
  if (!spec) return { ok: false, message: '未找到可下载源（npm 或 GitHub），无法更新。', restartRequired: false }
  const before = target.version
  const stamp = Date.now()
  const pkgFile = path.join(dir, 'package.json')
  const patchFile = path.join(dir, 'cordis.patch.yml')
  const lockFile = path.join(dir, 'pnpm-lock.yaml')
  const backups: string[] = []
  for (const file of [pkgFile, patchFile, lockFile]) {
    if (fs.existsSync(file)) {
      const backup = `${file}.bak-insight-tree-${stamp}`
      fs.copyFileSync(file, backup)
      backups.push(backup)
    }
  }
  const rollbackCommand = `dsh plugin --profile ${profile} add ${npmName ?? `github:${verdict.repo ?? ''}`}${before ? `@${before}` : ''}`
  const restoreBackups = async (): Promise<boolean> => {
    for (const backup of backups) {
      try { fs.copyFileSync(backup, backup.replace(/\.bak-insight-tree-\d+$/u, '')) } catch { /* preserve the primary failure */ }
    }
    return restoreInstalledDependencies(dir)
  }
  try {
    let run = await runAdd(profile, spec)
    if (run.code !== 0 && /MINIMUM_RELEASE_AGE|minimum-release-age/iu.test(`${run.stdout}${run.stderr}`)) {
      run = await runAdd(profile, spec, ['--config.minimum-release-age=0'])
    }
    if (run.code !== 0) {
      const restored = await restoreBackups()
      return {
        ok: false,
        message: `更新没有完成，${restored ? '配置和安装目录已恢复' : '配置已恢复但安装目录需要重新安装'}：退出码 ${run.code ?? '超时/中断'}：${[run.stderr, run.stdout].map((item) => item.trim()).filter(Boolean).join('；').slice(0, 400) || '没有可用错误摘要'}`,
        backup: backups[0] ?? undefined,
        rollbackCommand,
        restartRequired: false,
      }
    }
    const after = pluginManifest(dir, id)?.version
    if (!after || after === before) {
      const restored = await restoreBackups()
      return {
        ok: false,
        message: `更新未生效：${id} 版本仍为 ${before ?? '未知'}（可能是 pnpm 冷静期静默保留或已是最新；${restored ? '配置和安装目录已恢复' : '配置已恢复但安装目录需要重新安装'}）。回滚命令：${rollbackCommand}`,
        before,
        after,
        backup: backups[0] ?? undefined,
        rollbackCommand,
        restartRequired: false,
      }
    }
    return {
      ok: true,
      message: `已更新 ${id}：${before ?? '未知'} → ${after}。请在 DSH 重启后生效；如无问题可删除备份 ${backups[0] ?? ''}。`,
      before,
      after,
      backup: backups[0] ?? undefined,
      rollbackCommand,
      restartRequired: true,
    }
  } catch (error) {
    const restored = await restoreBackups()
    return {
      ok: false,
      message: `更新异常，${restored ? '配置和安装目录已恢复' : '配置已恢复但安装目录需要重新安装'}：${error instanceof Error ? error.message : String(error)}`,
      backup: backups[0] ?? undefined,
      rollbackCommand,
      restartRequired: false,
    }
  }
}

export function createInsightTreeRoute(getReport: (sessionId?: string) => InsightTreeReport, profile = 'web', options: RouteOptions = {}) {
  return {
    kind: 'prefix' as const,
    path: '/dsh-insight-tree',
    handler: async (req: RouteRequest, res: RouteResponse) => {
      if ((req.method !== 'GET' && req.method !== 'POST') || !loopback.test(req.headers.host ?? '')) {
        send(res, 403, JSON.stringify({ error: 'DSH Insight Tree 仅允许本机访问' }), { 'content-type': 'application/json' })
        return
      }
      const url = new URL(req.url ?? '/', `http://${req.headers.host}`)
      const token = options.token || ''
      const isBootstrap = url.pathname === '/dsh-insight-tree/bootstrap'
      const provided = req.headers['x-dsh-insight-tree-token'] || req.headers['x-insight-tree-token']
      if (token && !isBootstrap && provided !== token) {
        send(res, 401, JSON.stringify({ error: '缺少或错误的访问令牌' }), { 'content-type': 'application/json' })
        return
      }
      const jsonHeaders = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }

      if (req.method === 'GET' && isBootstrap) {
        send(res, 200, JSON.stringify({ token: token || null }), jsonHeaders)
        return
      }
      const sessionMatch = url.pathname.match(/^\/dsh-insight-tree\/session\/([^/]+)$/u)
      if (req.method === 'GET' && sessionMatch) {
        const sessionId = decodeURIComponent(sessionMatch[1])
        const report = options.getSessionReport ? await options.getSessionReport(sessionId) : getReport(sessionId)
        send(res, 200, JSON.stringify(report), jsonHeaders)
        return
      }
      if ((req.method === 'POST' && url.pathname.endsWith('/recheck')) || (req.method === 'GET' && url.pathname.endsWith('/diagnostics'))) {
        const report = getReport(url.searchParams.get('session') || undefined)
        send(res, 200, JSON.stringify(report), jsonHeaders)
        return
      }
      if (req.method === 'GET' && url.pathname.endsWith('/compare')) {
        const profiles = url.searchParams.get('profiles')?.split(',').map((item) => item.trim()).filter(Boolean) ?? []
        const entries = options.getCompare ? options.getCompare(profiles) : []
        if (url.searchParams.get('format') === 'md') {
          send(res, 200, renderCompareMarkdown(entries), { 'content-type': 'text/markdown; charset=utf-8', 'cache-control': 'no-store' })
        } else {
          send(res, 200, JSON.stringify({ schemaVersion: 3, profiles: entries }), jsonHeaders)
        }
        return
      }
      if (req.method === 'GET' && url.pathname.endsWith('/export')) {
        const report = sanitizeReport(getReport(url.searchParams.get('session') || undefined))
        const format = url.searchParams.get('format') || 'json'
        if (format === 'md') {
          send(res, 200, renderMarkdownReport(report), { 'content-type': 'text/markdown; charset=utf-8', 'cache-control': 'no-store', 'content-disposition': 'attachment; filename="dsh-insight-tree-report.md"' })
        } else if (format === 'csv') {
          send(res, 200, renderPluginCsv(report), { 'content-type': 'text/csv; charset=utf-8', 'cache-control': 'no-store', 'content-disposition': 'attachment; filename="dsh-insight-tree-plugins.csv"' })
        } else {
          send(res, 200, JSON.stringify(report), { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-disposition': 'attachment; filename="dsh-insight-tree-report.json"' })
        }
        return
      }
      if (req.method === 'POST' && (url.pathname.endsWith('/disable') || url.pathname.endsWith('/enable'))) {
        if (mutationLock) {
          send(res, 409, JSON.stringify({ ok: false, message: '已有插件配置操作进行中，请稍后再试。', restartRequired: true }), { 'content-type': 'application/json' })
          return
        }
        mutationLock = true
        try {
          try {
            const id = url.searchParams.get('id') ?? ''
            const report = getReport()
            const target = report.plugins.find((plugin) => plugin.id === id)
            if (!target) {
              send(res, 404, JSON.stringify({ ok: false, message: '找不到这个插件，配置没有修改。', restartRequired: false }), { 'content-type': 'application/json' })
              return
            }
            if (target.source === 'core' || id.startsWith('@deepseek-ai/')) {
              send(res, 400, JSON.stringify({ ok: false, message: '核心 DSH 包不能从插件树中关闭。', restartRequired: false }), { 'content-type': 'application/json' })
              return
            }
            const patchIds = [id, ...(report.loader ?? []).filter((entry) => loaderEntryBelongsToPlugin({ id: entry.entryId, options: { name: entry.moduleName }, disabled: !entry.enabled }, id)).map((entry) => entry.entryId.split(':').pop() ?? entry.entryId)]
            const result = await setPluginDisabled(profile, id, url.pathname.endsWith('/disable'), options.runtime, patchIds)
            send(res, result.ok ? 200 : 400, JSON.stringify(result), { 'content-type': 'application/json' })
          } catch (error) {
            send(res, 500, JSON.stringify({ ok: false, message: `插件状态操作异常：${error instanceof Error ? error.message : String(error)}`, restartRequired: true }), { 'content-type': 'application/json' })
          }
        } finally {
          mutationLock = false
        }
        return
      }
      if (req.method === 'POST' && url.pathname.endsWith('/uninstall')) {
        if (mutationLock) {
          send(res, 409, JSON.stringify({ ok: false, message: '已有插件配置操作进行中，请稍后再试。', restartRequired: true }), { 'content-type': 'application/json' })
          return
        }
        mutationLock = true
        try {
          const id = url.searchParams.get('id') ?? ''
          const report = getReport()
          const target = report.plugins.find((plugin) => plugin.id === id)
          if (!target) {
            send(res, 404, JSON.stringify({ ok: false, message: '找不到这个插件，未执行卸载。', restartRequired: false }), { 'content-type': 'application/json' })
            return
          }
          if (target.source === 'core' || id.startsWith('@deepseek-ai/')) {
            send(res, 400, JSON.stringify({ ok: false, message: '核心 DSH 包不能从插件树中卸载。', restartRequired: false }), { 'content-type': 'application/json' })
            return
          }
          if (target?.dependents?.length) {
            send(res, 400, JSON.stringify({ ok: false, message: `不能卸载 ${id}：${target.dependents.join('、')} 仍依赖它。`, restartRequired: false }), { 'content-type': 'application/json' })
            return
          }
          try {
            const patchIds = [id, ...(report.loader ?? []).filter((entry) => loaderEntryBelongsToPlugin({ id: entry.entryId, options: { name: entry.moduleName }, disabled: !entry.enabled }, id)).map((entry) => entry.entryId.split(':').pop() ?? entry.entryId)]
            const result = await uninstallPlugin(profile, id, options.runtime, patchIds)
            send(res, result.ok ? 200 : 400, JSON.stringify(result), { 'content-type': 'application/json' })
          } catch (error) {
            send(res, 500, JSON.stringify({ ok: false, message: `插件卸载异常：${error instanceof Error ? error.message : String(error)}`, restartRequired: true }), { 'content-type': 'application/json' })
          }
        } finally {
          mutationLock = false
        }
        return
      }
      if ((req.method === 'GET' || req.method === 'POST') && url.pathname.endsWith('/update')) {
        if (req.method === 'GET') {
          send(res, 405, JSON.stringify({ error: '更新接口仅接受 POST' }), { 'content-type': 'application/json' })
          return
        }
        if (mutationLock) {
          send(res, 409, JSON.stringify({ ok: false, message: '已有插件配置操作进行中，请稍后再试。', restartRequired: true }), { 'content-type': 'application/json' })
          return
        }
        mutationLock = true
        try {
          try {
            const id = url.searchParams.get('id') ?? ''
            const version = url.searchParams.get('version') ?? ''
            const confirm = url.searchParams.get('confirm') ?? '0'
            const result = await applyPluginUpdate(getReport(), profile, options.hostVersion ?? '', id, version, confirm)
            send(res, result.ok ? 200 : result.needsConfirm ? 409 : 400, JSON.stringify(result), { 'content-type': 'application/json' })
          } catch (error) {
            send(res, 500, JSON.stringify({ ok: false, message: `插件更新异常：${error instanceof Error ? error.message : String(error)}`, restartRequired: false }), { 'content-type': 'application/json' })
          }
        } finally {
          mutationLock = false
        }
        return
      }
      if (req.method === 'GET' && url.pathname.endsWith('/upstream')) {
        try {
          const state = await buildUpstreamState(getReport(), profile, options.hostVersion ?? '')
          send(res, 200, JSON.stringify(state), jsonHeaders)
        } catch (error) {
          send(res, 500, JSON.stringify({ state: 'offline', error: `上游核验失败：${error instanceof Error ? error.message : String(error)}` }), { 'content-type': 'application/json' })
        }
        return
      }
      const report = getReport(url.searchParams.get('session') || undefined)
      send(res, 200, JSON.stringify(report), jsonHeaders)
    },
  }
}
