import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

/** Cache directory inside the DSH home; never touches the profile. */
export function cacheDir(): string {
  return path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'dsh-insight-tree', 'cache')
}

interface CacheRecord<T> {
  at: string
  ttlMs: number
  value: T
}

/**
 * Read a TTL-bounded disk cache entry. Corrupt, stale or unreadable records
 * return undefined — a cache miss is always safe, never fatal.
 */
export function readCache<T>(key: string, ttlMs: number): T | undefined {
  try {
    const file = path.join(cacheDir(), `${key}.json`)
    const raw = fs.readFileSync(file, 'utf8')
    const record = JSON.parse(raw) as CacheRecord<T>
    if (typeof record.at !== 'string' || typeof record.ttlMs !== 'number') return undefined
    const age = Date.now() - Date.parse(record.at)
    if (!Number.isFinite(age) || age > ttlMs || age < 0) return undefined
    return record.value
  } catch {
    return undefined
  }
}

/** Atomic write: tmp file then rename, so a crash never leaves a torn record. */
export function writeCache<T>(key: string, value: T): void {
  try {
    const dir = cacheDir()
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, `${key}.json`)
    const tmp = `${file}.${process.pid}.tmp`
    const record: CacheRecord<T> = { at: new Date().toISOString(), ttlMs: Infinity, value }
    fs.writeFileSync(tmp, JSON.stringify(record), 'utf8')
    fs.renameSync(tmp, file)
  } catch {
    // Cache writes must never break the caller (network read is the point).
  }
}
