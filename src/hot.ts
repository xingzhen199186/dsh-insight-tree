import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import yaml from 'js-yaml'

interface HotContext {
  plugin?: (plugin: unknown, config: unknown) => { await?: () => Promise<unknown>; dispose?: () => Promise<unknown> | void }
  logger?: { warn?: (message: string) => void }
}

interface HotHandle {
  dispose: () => Promise<unknown> | void
  file: string
}

interface HotRow { id: string; name: string }

let includeClass: unknown | null | undefined

const handles = new Map<string, HotHandle>()

function packageManifest(profileDir: string, packageName: string): { dsh?: { client?: unknown; bundle?: unknown } } | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(profileDir, 'node_modules', packageName, 'package.json'), 'utf8')) as { dsh?: { client?: unknown; bundle?: unknown } }
  } catch {
    return null
  }
}

function patchRows(value: unknown): HotRow[] | null {
  if (!Array.isArray(value)) return null
  const rows: HotRow[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null
    const record = item as Record<string, unknown>
    if (!Array.isArray(record.insert)) return null
    for (const row of record.insert) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) return null
      const candidate = row as Record<string, unknown>
      if (typeof candidate.id !== 'string' || typeof candidate.name !== 'string' || Object.keys(candidate).some((key) => key !== 'id' && key !== 'name')) return null
      rows.push({ id: candidate.id, name: candidate.name })
    }
  }
  return rows.length > 0 ? rows : null
}

async function loadIncludeClass(profileDir: string): Promise<unknown | null> {
  if (includeClass !== undefined) return includeClass
  try {
    const specifier = '@deepseek-ai/cordis-plugin-include'
    let resolved: string | undefined
    for (const base of [path.join(profileDir, 'node_modules', 'dsh-insight-tree', 'lib', 'index.js'), import.meta.url]) {
      try {
        resolved = createRequire(base).resolve(specifier)
        break
      } catch { /* try the next module root */ }
    }
    const mod = await import(resolved ? pathToFileURL(resolved).href : specifier) as { Include?: new (...args: never[]) => { write(): void; import(name: string, getOuterStack?: () => string[]): unknown } }
    if (!mod.Include) throw new Error('Include export unavailable')
    class InsightHotTree extends mod.Include {
      override write(): void {}
    }
    includeClass = InsightHotTree
  } catch {
    includeClass = null
  }
  return includeClass
}

async function mount(context: HotContext | undefined, profileDir: string, packageName: string): Promise<boolean> {
  if (!context?.plugin || handles.has(packageName)) return handles.has(packageName)
  const Include = await loadIncludeClass(profileDir)
  if (!Include) return false
  const manifest = packageManifest(profileDir, packageName)
  if (!manifest?.dsh) return false
  let rows: HotRow[] | null = null
  const patchFile = path.join(profileDir, 'node_modules', packageName, 'cordis.patch.yml')
  if (manifest.dsh.bundle !== undefined) {
    try {
      rows = patchRows(yaml.load(fs.readFileSync(patchFile, 'utf8')))
    } catch {
      rows = null
    }
  } else if (manifest.dsh.client !== undefined) {
    rows = [{ id: `client-${packageName.replace(/[^A-Za-z0-9_.-]/gu, '-')}`, name: packageName }]
  }
  if (!rows) return false
  const hotDir = path.join(profileDir, '.dsh-insight-tree')
  fs.mkdirSync(hotDir, { recursive: true })
  try {
    for (const entry of fs.readdirSync(hotDir)) {
      if (/^hot-.*\.yml$/u.test(entry)) fs.rmSync(path.join(hotDir, entry), { force: true })
    }
  } catch { /* stale hot files are best-effort cleanup */ }
  const file = path.join(hotDir, `hot-${Date.now()}-${Math.random().toString(16).slice(2)}.yml`)
  const content = rows.map((row) => `- id: 'insight-${row.id}'\n  name: '${row.name.replace(/'/gu, "''")}'\n`).join('')
  fs.writeFileSync(file, content, 'utf8')
  let handle: { await?: () => Promise<unknown>; dispose?: () => Promise<unknown> | void } | undefined
  try {
    handle = context.plugin(Include, { path: pathToFileURL(file).href })
    if (handle.await) {
      await Promise.race([
        handle.await(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('热挂载激活超过 10 秒，可能正在等待未提供的服务')), 10000)),
      ])
    }
    if (!handle.dispose) throw new Error('热挂载句柄不支持移除')
    handles.set(packageName, { dispose: handle.dispose, file })
    return true
  } catch (error) {
    try { await Promise.resolve(handle?.dispose?.()) } catch { /* best effort */ }
    try { fs.rmSync(file, { force: true }) } catch { /* best effort */ }
    context.logger?.warn?.(`dsh-insight-tree hot mount failed for ${packageName}: ${error instanceof Error ? error.message : String(error)}`)
    return false
  }
}

export async function unmount(packageName: string): Promise<boolean> {
  const handle = handles.get(packageName)
  if (!handle) return false
  handles.delete(packageName)
  try {
    await handle.dispose()
  } catch {
    return false
  } finally {
    try { fs.rmSync(handle.file, { force: true }) } catch { /* best effort */ }
  }
  return true
}

export function createHotOperations(context: HotContext | undefined, profileDir: string): {
  mount: (packageName: string) => Promise<boolean>
  unmount: (packageName: string) => Promise<boolean>
} {
  return {
    mount: (packageName) => mount(context, profileDir, packageName),
    unmount,
  }
}
