import React from 'react'
import { createRoot } from 'react-dom/client'
import { aggregatePluginUse } from '../owners.js'

type Finding = { id?: string; severity: string; impact?: string; title: string; message: string; evidence?: string; recommendation?: string; action?: { kind: string; plugin?: string; label?: string } }
type Plugin = { id: string; name: string; description?: string; source: string; status: string; role: string; version?: string; packagePath?: string; compatibility?: { status: string; label: string; requirement?: string; evidence?: string }; provides: string[]; dependsOn: string[]; dependents?: string[]; sessionUsage?: { count: number; lastActivity?: string }; fiberPhase?: string | null; enabled?: boolean; findings?: Finding[] }
type Report = { dshVersion: string; versionSource?: string; profile: string; sessionId?: string; patch: { entries: number; reload?: string }; usage: { sessionEvents: number; toolCalls: number }; sessionTools?: Record<string, { count: number; lastActivity?: string }>; activity?: { byTool?: Record<string, { count: number; lastActivity?: string }>; toolOwners?: Record<string, string>; unattributedTools?: Record<string, { count: number; lastActivity?: string }>; attribution?: string }; runtime: { dumpConfig: string; activatedEntries: number }; status: string; summary: { total: number; active: number; attention: number; blocked: number }; plugins: Plugin[]; recommendedActions?: string[] }
type ReportPayload = Partial<Report> & { plugins?: Plugin[] }
type OverlayProps = { useSessions?: (selector: (state: { current?: string }) => unknown) => unknown }
type InsightTreePanelProps = { embedded?: boolean }
type UpstreamVersionInfo = { version: string; publishedAt?: string; hostOk: boolean | null; isInstalled: boolean; isLatest: boolean; ranges?: string }
type UpstreamVerdict = { id: string; name: string; installedVersion?: string; sourceKind: string; repo?: string; repoUrl?: string; npmName?: string; stars?: number | null; license?: string | null; archived?: boolean; catalogDescription?: string; category?: string; catalogInstall?: string; latest?: string; latestCompatible?: string | null; hostAligned: boolean | null; updateAvailable: boolean; versions: UpstreamVersionInfo[]; error?: string }
type UpstreamState = { state: 'ok' | 'partial' | 'offline'; hostVersion?: string; profile?: string; generatedAt?: string; registry?: string; catalogUrl?: string; catalogCount?: number; catalogFetchedAt?: string; plugins?: UpstreamVerdict[]; error?: string }

const colors = { ink: '#17212b', muted: '#71808f', line: '#e5e9ed', accent: '#2864d7', good: '#14804a', warn: '#a66b00', bad: '#b33535', panel: '#f8fafc' }
const statusText: Record<string, string> = { active: '已正常加载', warning: '存在风险', degraded: '功能受限', blocked: '阻塞启动', disabled: '暂时关闭' }
let sharedToken = ''

function upstreamVersionSummary(upstream: UpstreamVerdict): string {
  const current = upstream.installedVersion ?? '未知'
  const source = upstream.npmName ? `npm: ${upstream.npmName}` : undefined
  if (upstream.latest && upstream.latest === current && upstream.latestCompatible === current) {
    return [`当前插件 ${current}`, source, '已是最新兼容版本'].filter(Boolean).join('　')
  }
  return [
    `当前插件 ${current}`,
    source,
    upstream.latest ? `最新插件 ${upstream.latest}` : undefined,
    upstream.latestCompatible ? `最新兼容插件 ${upstream.latestCompatible}` : undefined,
  ].filter(Boolean).join('　')
}

function InsightTreePanel(props: InsightTreePanelProps = {}): React.ReactElement {
  const [report, setReport] = React.useState<Report | null>(null)
  const [selected, setSelected] = React.useState<string>('')
  const [message, setMessage] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState('')
  const [filter, setFilter] = React.useState('all')
  const [search, setSearch] = React.useState('')
  const [token, setToken] = React.useState('')
  const [compareOpen, setCompareOpen] = React.useState(false)
  const [compare, setCompare] = React.useState<Array<{ profile: string; report: { dshVersion: string; status: string; summary: { total: number; active: number; attention: number; blocked: number } } }>>([])
  const [upstream, setUpstream] = React.useState<Record<string, UpstreamVerdict> | null>(null)
  const [upstreamState, setUpstreamState] = React.useState<UpstreamState | null>(null)
  const [updating, setUpdating] = React.useState(false)
  const [expandedVersions, setExpandedVersions] = React.useState<Record<string, boolean>>({})
  const auth = (): Record<string, string> => (token ? { 'x-dsh-insight-tree-token': token } : {})
  const loadReport = React.useCallback((): void => {
    setError('')
    setReport(null)
    void Promise.race([fetch('/dsh-insight-tree', { cache: 'no-store', headers: auth() }), new Promise<Response>((_, reject) => window.setTimeout(() => reject(new Error('读取超时')), 8000))])
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        return response.json() as Promise<ReportPayload>
      })
      .then((data) => {
        const plugins = (Array.isArray(data.plugins) ? data.plugins : []).map((plugin) => ({
          ...plugin,
          id: plugin.id ?? 'unknown-plugin',
          name: plugin.name ?? plugin.id ?? '未知插件',
          source: plugin.source ?? 'user',
          status: plugin.status ?? 'warning',
          role: plugin.role ?? '插件状态待确认',
          provides: Array.isArray(plugin.provides) ? plugin.provides : [],
          dependsOn: Array.isArray(plugin.dependsOn) ? plugin.dependsOn : [],
          dependents: Array.isArray(plugin.dependents) ? plugin.dependents : [],
          compatibility: plugin.compatibility ?? { status: 'unknown', label: '暂时无法确认', evidence: '旧版报告没有提供兼容性信息。' },
          findings: Array.isArray(plugin.findings) ? plugin.findings : [],
        })) as Plugin[]
        const summary = data.summary ?? { total: plugins.length, active: plugins.length, attention: 0, blocked: 0 }
        const normalized: Report = {
          dshVersion: data.dshVersion ?? '未知',
          versionSource: data.versionSource ?? 'unknown',
          profile: data.profile ?? 'web',
          sessionId: data.sessionId,
          patch: data.patch ?? { entries: 0 },
          usage: data.usage ?? { sessionEvents: 0, toolCalls: 0 },
          sessionTools: data.sessionTools ?? {},
          runtime: data.runtime ?? { dumpConfig: 'failed', activatedEntries: 0 },
          status: data.status ?? 'attention',
          summary: { ...summary, total: summary.total ?? plugins.length },
          plugins,
          recommendedActions: data.recommendedActions ?? [],
        }
        setReport(normalized)
        setSelected((previous) => plugins.some((plugin) => plugin.id === previous) ? previous : plugins[0]?.id ?? '')
      })
      .catch((reason: unknown) => {
        setError(`暂时无法读取结构：${reason instanceof Error ? reason.message : String(reason)}`)
      })
  }, [token])
  const loadUpstream = React.useCallback((): void => {
    void fetch('/dsh-insight-tree/upstream', { cache: 'no-store', headers: auth() })
      .then((response) => response.json() as Promise<UpstreamState>)
      .then((data) => {
        setUpstreamState(data)
        setUpstream(Object.fromEntries((data.plugins ?? []).map((item) => [item.id, item])))
      })
      .catch(() => { setUpstreamState({ state: 'offline', error: '上游核验暂不可用' }); setUpstream(null) })
  }, [token])
  const applyUpdate = async (plugin: Plugin, version: string, forcing = false): Promise<void> => {
    const candidate = upstream?.[plugin.id]?.versions.find((item) => item.version === version)
    const needsConfirmation = Boolean(candidate && (candidate.hostOk === false || (candidate.hostOk === null && upstream?.[plugin.id]?.latestCompatible !== version)))
    const warning = needsConfirmation
      ? `⚠️ ${plugin.name}@${version} 与当前 DSH ${report?.dshVersion ?? ''} 可能不适配（${candidate?.hostOk === false ? candidate.ranges ?? '该版本声明的 DSH 范围不满足宿主' : '该版本没有声明可核对的 DSH 适配范围，且存在更明确的兼容版本'}）。\n继续也可能导致插件或 DSH 运行异常，确定要安装/更新吗？`
      : null
    if (!forcing && warning && !window.confirm(warning)) return
    setUpdating(true)
    setMessage(`正在安装/更新 ${plugin.name}@${version}…（可能需要几分钟）`)
    try {
      const response = await fetch(`/dsh-insight-tree/update?id=${encodeURIComponent(plugin.id)}&version=${encodeURIComponent(version)}&confirm=${warning ? '1' : '0'}`, { method: 'POST', headers: auth() })
      const result = await response.json() as { ok?: boolean; message?: string; needsConfirm?: boolean; warning?: string; before?: string; after?: string; backup?: string; rollbackCommand?: string; restartRequired?: boolean }
      if (response.status === 409 && result.needsConfirm && result.warning && !forcing) {
        if (window.confirm(result.warning)) { await applyUpdate(plugin, version, true); return }
        setMessage('已取消更新。')
        return
      }
      setMessage(`${result.ok ? '✅ ' : '❌ '}${result.message ?? (response.ok ? '完成' : '失败')}${result.rollbackCommand ? `　回滚：${result.rollbackCommand}` : ''}`)
      if (result.ok) { loadReport(); loadUpstream() }
    } catch (reason) {
      setMessage(`更新请求失败：${reason instanceof Error ? reason.message : String(reason)}`)
    } finally {
      setUpdating(false)
    }
  }
  React.useEffect(() => {
    void fetch('/dsh-insight-tree/bootstrap', { cache: 'no-store' })
      .then((r) => r.json() as Promise<{ token?: string | null }>)
      .then((data) => { const value = data.token ?? ''; sharedToken = value; setToken(value); loadReport(); loadUpstream() })
      .catch(() => { loadReport(); loadUpstream() })
  }, [loadReport, loadUpstream])
  React.useEffect(() => {
    const select = (event: Event): void => {
      const id = (event as CustomEvent<{ id?: string }>).detail?.id
      if (id) setSelected(id)
    }
    window.addEventListener('dsh-insight-tree:select', select)
    const hash = decodeURIComponent(window.location.hash.replace(/^#dsh-insight-tree\//u, ''))
    if (hash && hash !== window.location.hash) setSelected(hash)
    return () => window.removeEventListener('dsh-insight-tree:select', select)
  }, [])
  if (error) return <div style={{ padding: 24, color: colors.muted }}><div style={{ color: colors.bad }}>{error}</div><button type="button" onClick={loadReport} style={{ marginTop: 14, padding: '7px 11px', border: `1px solid ${colors.line}`, borderRadius: 5, background: '#fff', color: colors.ink, cursor: 'pointer' }}>重新读取</button></div>
  if (!report) return <div style={{ padding: 24, color: colors.muted }}>正在读取 DSH 结构…</div>
  const runAction = async (action: 'disable' | 'enable' | 'uninstall', confirmation: string): Promise<void> => {
    if (!current || current.source === 'core' || busy || !window.confirm(confirmation)) return
    setBusy(true)
    try {
      const response = await fetch(`/dsh-insight-tree/${action}?id=${encodeURIComponent(current.id)}`, { method: 'POST', headers: auth() })
      const result = await response.json() as { message?: string; appliedNow?: boolean; restartRequired?: boolean; backup?: string; rollbackCommand?: string }
      const outcome = result.appliedNow ? '已立即生效。' : result.restartRequired ? '需要重启 DSH 才能完全生效。' : ''
      const backup = result.backup ? ` 备份：${result.backup}` : ''
      const rollback = result.rollbackCommand ? ` 回滚：${result.rollbackCommand}` : ''
      setMessage(`${response.ok ? (result.message ?? '操作完成') : (result.message ?? `操作失败（HTTP ${response.status}）`)} ${outcome}${backup}${rollback}`.trim())
      loadReport()
    } catch (reason) {
      setMessage(`操作失败：${reason instanceof Error ? reason.message : String(reason)}`)
    } finally {
      setBusy(false)
    }
  }
  const disable = async (): Promise<void> => runAction('disable', `暂时关闭“${current?.name ?? '该插件'}”？当前运行实例会立即停止，配置也会同步保存。`)
  const enable = async (): Promise<void> => runAction('enable', `重新启用“${current?.name ?? '该插件'}”？当前运行实例会立即加载，配置也会同步保存。`)
  const uninstall = async (): Promise<void> => runAction('uninstall', `卸载“${current?.name ?? '该插件'}”？${current?.dependents?.length ? `它被 ${current.dependents.join('、')} 使用。` : ''}这会从当前 Profile 移除，并立即停止当前运行实例。`)
  const matchesSearch = (plugin: Plugin): boolean => !search || plugin.name.toLowerCase().includes(search.toLowerCase()) || plugin.id.toLowerCase().includes(search.toLowerCase())
  const isAttention = (plugin: Plugin): boolean => plugin.status !== 'active' || (plugin.findings ?? []).some((finding) => finding.severity === 'warning' || finding.severity === 'degraded')
  const dotColor = (plugin: Plugin): string => {
    if (plugin.fiberPhase === 'failed' || plugin.status === 'blocked' || (plugin.findings ?? []).some((finding) => finding.severity === 'blocking')) return colors.bad
    if (plugin.status === 'warning' || plugin.status === 'degraded' || (plugin.findings ?? []).some((finding) => finding.severity === 'warning' || finding.severity === 'degraded')) return colors.warn
    if (plugin.status === 'disabled') return colors.muted
    if (plugin.sessionUsage) return colors.accent
    return colors.good
  }
  const visible = report.plugins.filter((plugin) => matchesSearch(plugin) && (filter === 'all' || (filter === 'attention' ? isAttention(plugin) : filter === 'used' ? Boolean(plugin.sessionUsage) : plugin.source === filter)))
  const current = visible.find((plugin) => plugin.id === selected) ?? visible[0] ?? report.plugins[0]
  const toggleCompare = (): void => {
    if (!compareOpen) {
      void fetch('/dsh-insight-tree/compare', { cache: 'no-store', headers: auth() })
        .then((r) => r.json() as Promise<{ profiles?: typeof compare }>)
        .then((data) => setCompare(data.profiles ?? []))
        .catch(() => setCompare([]))
    }
    setCompareOpen(!compareOpen)
  }
  const downloadExport = (format: 'json' | 'md' | 'csv'): void => {
    void fetch(`/dsh-insight-tree/export?format=${format}`, { cache: 'no-store', headers: auth() })
      .then((r) => r.blob())
      .then((blob) => {
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = `dsh-insight-tree-report.${format}`
        a.click()
        URL.revokeObjectURL(url)
      })
  }
  const impactText: Record<string, string> = { none: '不影响使用', plugin: '仅影响当前插件', capability: '影响一项能力', profile: '影响当前 Profile', startup: '阻塞 DSH 启动' }
  const pluginById = new Map(report.plugins.map((item) => [item.id, item]))
  const selectPlugin = (id: string): void => {
    setFilter('all')
    setSearch('')
    setSelected(id)
    window.dispatchEvent(new CustomEvent('dsh-insight-tree:select', { detail: { id } }))
    window.location.hash = `dsh-insight-tree/${encodeURIComponent(id)}`
  }
  const relationChip = (id: string): React.ReactElement => <button type="button" onClick={() => selectPlugin(id)} style={{ padding: '3px 6px', border: `1px solid ${colors.line}`, borderRadius: 4, background: '#fff', color: colors.accent, cursor: 'pointer', fontSize: 10 }}>{pluginById.get(id)?.name ?? id}</button>
  const renderDetail = (plugin: Plugin): React.ReactElement => <section style={{ margin: '0 0 8px', padding: 12, background: colors.panel, borderLeft: `3px solid ${plugin.status === 'blocked' ? colors.bad : plugin.status === 'active' ? colors.good : colors.warn}`, borderTop: `1px solid ${colors.line}`, borderRight: `1px solid ${colors.line}`, borderBottom: `1px solid ${colors.line}`, borderRadius: 6 }}>
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}><div style={{ fontSize: 14, fontWeight: 650 }}>{plugin.name}</div><span style={{ fontSize: 11, color: plugin.status === 'active' ? colors.good : colors.warn }}>{statusText[plugin.status] ?? plugin.status}</span></div>
    <p style={{ margin: '8px 0 6px', fontSize: 12, lineHeight: 1.6, color: colors.muted }}>{plugin.role}</p>
    {plugin.description && <p style={{ margin: '0 0 7px', fontSize: 12, lineHeight: 1.6, color: colors.ink }}>{plugin.description}</p>}
    <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', fontSize: 11, color: colors.muted }}><span>版本：{plugin.version ?? '未知'}</span><span>适配：{plugin.compatibility?.label ?? '暂时无法确认'}</span>{plugin.fiberPhase !== undefined && <span>Loader：{plugin.fiberPhase === null ? '无存活根' : plugin.fiberPhase}</span>}{plugin.sessionUsage && <span>本会话使用：{plugin.sessionUsage.count} 次</span>}</div>
    {plugin.compatibility?.status === 'unknown' && <div style={{ marginTop: 5, fontSize: 11, color: colors.muted }}>暂时无法确认：{plugin.compatibility.evidence ?? '插件没有提供可核对的 DSH 版本范围。'}</div>}
    {plugin.compatibility?.status === 'missing' && <div style={{ marginTop: 5, fontSize: 11, color: colors.warn }}>暂时无法确认：找不到插件安装包的版本信息。</div>}
    {(plugin.dependsOn.length > 0 || (plugin.dependents?.length ?? 0) > 0) && <div style={{ marginTop: 8, padding: '8px 9px', border: `1px solid ${colors.line}`, borderRadius: 5, background: '#fff' }}><div style={{ fontSize: 11, color: colors.muted }}>关系与影响路径</div><div style={{ marginTop: 6, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 5, fontSize: 10, color: colors.muted }}><span>依赖</span>{plugin.dependsOn.length > 0 ? plugin.dependsOn.map((id) => <React.Fragment key={id}>{relationChip(id)}<span>→</span></React.Fragment>) : <span>无</span>}<strong style={{ color: colors.ink }}>{plugin.name}</strong>{plugin.dependents?.length ? <><span>→</span><span>被以下插件使用</span>{plugin.dependents.map((id) => relationChip(id))}</> : null}</div></div>}
    {plugin.findings?.map((finding) => { const blocking = finding.severity === 'blocking'; return <div key={finding.id ?? finding.title} style={{ marginTop: 8, padding: '8px 9px', background: blocking ? '#fff0f0' : '#fff8e8', border: `1px solid ${blocking ? '#e7b4b4' : '#f1d38a'}`, borderRadius: 5 }}><div style={{ fontSize: 11, fontWeight: 650, color: blocking ? colors.bad : colors.warn }}>{finding.title}</div><div style={{ marginTop: 3, fontSize: 11, lineHeight: 1.5, color: colors.muted }}>{finding.message}</div>{finding.impact && <div style={{ marginTop: 3, fontSize: 11, color: blocking ? colors.bad : colors.ink }}>影响：{impactText[finding.impact] ?? finding.impact}</div>}{finding.impact && <div style={{ marginTop: 5, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 4, fontSize: 10, color: colors.muted }}><span>影响链：</span><strong style={{ color: colors.ink }}>{finding.title}</strong><span>→</span><span>{plugin.name}</span><span>→</span><span>{plugin.provides[0] ?? '插件功能'}</span><span>→</span><span>{impactText[finding.impact] ?? finding.impact}</span></div>}{finding.recommendation && <div style={{ marginTop: 4, fontSize: 11, color: colors.ink }}>建议：{finding.recommendation}</div>}{finding.evidence && <details style={{ marginTop: 4, fontSize: 10, color: colors.muted }}><summary>查看依据</summary><div style={{ marginTop: 3 }}>{finding.evidence}</div></details>}{finding.action && finding.action.kind !== 'none' && <button type="button" onClick={() => void (finding.action?.kind === 'disable' ? disable() : finding.action?.kind === 'enable' ? enable() : finding.action?.kind === 'uninstall' ? uninstall() : loadReport())} style={{ marginTop: 5, padding: '3px 7px', border: `1px solid ${colors.line}`, borderRadius: 4, background: '#fff', color: colors.ink, cursor: 'pointer', fontSize: 10 }}>{finding.action.label ?? '执行'}</button>}</div> })}
    <div style={{ marginTop: 8, fontSize: 11, color: colors.muted }}>具体能力</div>
    <div style={{ marginTop: 5, display: 'flex', flexWrap: 'wrap', gap: 6 }}>{plugin.provides.map((item) => <span key={item} style={{ padding: '3px 6px', background: '#fff', border: `1px solid ${colors.line}`, borderRadius: 4, fontSize: 11 }}>{item}</span>)}</div>
    {upstream && (() => {
      const u = upstream[plugin.id]
      if (!u) return null
      const sourceLabel = u.sourceKind === 'official' ? '官方内置' : u.sourceKind === 'npm' ? 'npm 包' : u.sourceKind === 'github' ? 'GitHub 源码' : u.sourceKind === 'local' ? '仅本地/未发布' : '未发现来源'
      const sourceColor = u.sourceKind === 'official' ? colors.muted : u.sourceKind === 'local' ? colors.warn : colors.good
      const updateButton = (version: string, label: string, danger: boolean) => <button key={version} type="button" disabled={updating || busy} onClick={() => void applyUpdate(plugin, version)} style={{ padding: '3px 7px', border: `1px solid ${danger ? '#efc6c6' : colors.line}`, borderRadius: 4, background: '#fff', color: danger ? '#a33535' : colors.accent, cursor: updating ? 'wait' : 'pointer', fontSize: 10, marginRight: 6 }}>{label}</button>
      const candidate = u.latestCompatible ? u.versions.find((v) => v.version === u.latestCompatible) : undefined
      return <div style={{ marginTop: 10, padding: '9px 10px', border: `1px solid ${colors.line}`, borderRadius: 5, background: colors.panel }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, fontWeight: 650, color: colors.ink, flexWrap: 'wrap' }}>来源与版本
          <span style={{ padding: '1px 6px', background: '#fff', border: `1px solid ${colors.line}`, borderRadius: 3, fontSize: 10, fontWeight: 400, color: sourceColor }}>{sourceLabel}</span>
          {u.repoUrl && <a href={u.repoUrl} target="_blank" rel="noreferrer" style={{ fontSize: 10, color: colors.accent }}>{u.repo}</a>}
          {typeof u.stars === 'number' && <span style={{ fontSize: 10, color: colors.muted }}>★ {u.stars}</span>}
          {u.license && <span style={{ fontSize: 10, color: colors.muted }}>{u.license}</span>}
        </div>
        <div style={{ marginTop: 5, fontSize: 10, color: colors.muted }}>
          {upstreamState?.state === 'offline' ? '⚠ 上游核验离线' : upstreamVersionSummary(u)}
        </div>
        {u.updateAvailable && u.latestCompatible && u.latestCompatible !== u.installedVersion && <div style={{ marginTop: 6 }}>{updateButton(u.latestCompatible, `一键更新到 ${u.latestCompatible}${candidate?.hostOk === false ? '（⚠ 可能不适配，需确认）' : ''}`, candidate?.hostOk === false)}</div>}
        <details style={{ marginTop: 6 }}>
          <summary style={{ fontSize: 10, color: colors.muted, cursor: 'pointer' }}>历史版本（{u.versions.length}）</summary>
          <div style={{ marginTop: 5, maxHeight: 180, overflow: 'auto' }}>
            {(expandedVersions[plugin.id] ? u.versions : u.versions.slice(0, 8)).map((v) => <div key={v.version} style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 6, padding: '3px 0', fontSize: 10, color: colors.ink }}>
              <span style={{ minWidth: 84, fontWeight: 500 }}>{v.version}{v.isInstalled ? '（当前）' : ''}</span>
              <span style={{ color: colors.muted }}>{v.publishedAt ? new Date(v.publishedAt).toLocaleDateString('zh-CN') : ''}</span>
              <span style={{ color: v.hostOk === false ? colors.bad : v.hostOk === null ? colors.muted : colors.good }}>{v.hostOk === false ? '✗ 不适配' : v.hostOk === null ? '? 未声明' : '✓ 适配'}</span>
              {!v.isInstalled && updateButton(v.version, '更新到此版本', v.hostOk === false)}
            </div>)}
            {u.versions.length > 8 && <button type="button" onClick={() => setExpandedVersions((current) => ({ ...current, [plugin.id]: !current[plugin.id] }))} style={{ padding: '3px 0', border: 0, background: 'transparent', color: colors.accent, cursor: 'pointer', fontSize: 10 }}>{expandedVersions[plugin.id] ? '收起历史版本' : `展开全部 ${u.versions.length} 个版本`}</button>}
          </div>
        </details>
      </div>
    })()}
    {plugin.source !== 'core' && <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>{plugin.status === 'disabled' ? <button type="button" disabled={busy} onClick={() => void enable()} style={{ padding: '6px 9px', border: `1px solid ${colors.line}`, borderRadius: 5, background: '#fff', color: colors.ink, cursor: busy ? 'wait' : 'pointer', fontSize: 11 }}>重新启用</button> : <button type="button" disabled={busy} onClick={() => void disable()} style={{ padding: '6px 9px', border: `1px solid ${colors.line}`, borderRadius: 5, background: '#fff', color: colors.ink, cursor: busy ? 'wait' : 'pointer', fontSize: 11 }}>暂时关闭</button>}<button type="button" disabled={busy} onClick={() => void uninstall()} style={{ padding: '6px 9px', border: '1px solid #efc6c6', borderRadius: 5, background: '#fff', color: '#a33535', cursor: busy ? 'wait' : 'pointer', fontSize: 11 }}>卸载插件</button></div>}
    {message && <div style={{ marginTop: 8, fontSize: 11, color: colors.good }}>{message}</div>}
  </section>
  const pluginButton = (plugin: Plugin): React.ReactElement => <div key={plugin.id}><button onClick={() => setSelected(selected === plugin.id ? '' : plugin.id)} style={{ display: 'block', width: '100%', padding: '12px 14px', border: 0, borderBottom: `1px solid ${colors.line}`, background: selected === plugin.id ? '#f0f5ff' : '#fff', color: colors.ink, textAlign: 'left', cursor: 'pointer' }}><div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><span style={{ width: 7, height: 7, borderRadius: '50%', background: dotColor(plugin) }} /><span style={{ width: 10, fontSize: 11, color: colors.muted }}>{selected === plugin.id ? '▾' : '▸'}</span><span style={{ fontSize: 13, fontWeight: 600 }}>{plugin.name}</span></div><div style={{ margin: '5px 0 0 15px', fontSize: 11, color: colors.muted }}>{plugin.role} · {plugin.compatibility?.label ?? '适配状态未知'}</div>{plugin.provides.length > 0 && <div style={{ margin: '6px 0 0 15px', display: 'flex', flexWrap: 'wrap', gap: 4 }}>{plugin.provides.map((item) => <span key={item} style={{ padding: '2px 5px', border: `1px solid ${colors.line}`, borderRadius: 3, fontSize: 10, color: colors.muted }}>{item}</span>)}</div>}{plugin.dependsOn.length > 0 && <div style={{ margin: '5px 0 0 15px', fontSize: 10, color: colors.muted }}>声明关联 {plugin.dependsOn.join('、')}</div>}</button>{selected === plugin.id && renderDetail(plugin)}</div>
  const renderLayer = (title: string, subtitle: string, plugins: Plugin[]): React.ReactElement | null => plugins.length === 0 ? null : <div style={{ margin: '6px 0 0 16px', borderLeft: `1px solid ${colors.line}` }}><div style={{ marginLeft: 12, padding: '8px 10px', background: colors.panel, border: `1px solid ${colors.line}`, borderRadius: 5, fontSize: 11, fontWeight: 650, color: colors.ink }}>{title}<span style={{ marginLeft: 8, color: colors.muted, fontWeight: 400 }}>{subtitle}</span></div><div style={{ marginLeft: 12 }}>{plugins.map(pluginButton)}</div></div>
  const core = visible.filter((plugin) => plugin.source === 'core')
  const webApp = core.filter((plugin) => plugin.id === '@deepseek-ai/dsh-web-app')
  const foundation = core.filter((plugin) => plugin.id !== '@deepseek-ai/dsh-web-app')
  const bundles = visible.filter((plugin) => plugin.source === 'bundle')
  const unmounted = visible.filter((plugin) => plugin.source === 'user')
  return <div style={{ width: props.embedded ? '100%' : 'min(760px, calc(100vw - 24px))', height: '100%', overflow: 'auto', background: '#fff', borderLeft: `1px solid ${colors.line}`, color: colors.ink, fontFamily: 'Inter, system-ui, sans-serif' }}>
    <header style={{ padding: '20px 20px 16px', borderBottom: `1px solid ${colors.line}` }}>
      <div style={{ fontSize: 12, color: colors.muted, letterSpacing: '.04em' }}>DSH PLUGIN TREE</div>
      <div style={{ marginTop: 7, fontSize: 22, fontWeight: 650 }}>插件树</div>
      <div style={{ marginTop: 10, display: 'flex', gap: 8, flexWrap: 'wrap', fontSize: 12, color: colors.muted }}><span>DSH {report.dshVersion}</span><span>·</span><span>版本来源：{report.versionSource === 'installed' ? '已安装包' : report.versionSource === 'spec' ? 'Profile 声明' : report.versionSource === 'config' ? '配置' : '暂时无法确认'}</span><span>·</span><span>{report.profile}</span><span>·</span><span>{report.patch.reload === 'live' ? '支持热更新' : '启动时加载'}</span></div>
    </header>
    <section style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 1, background: colors.line, borderBottom: `1px solid ${colors.line}` }}>
      {[['插件', report.summary.total], ['正常', report.summary.active], ['需关注', report.summary.attention + report.summary.blocked]].map(([label, value]) => <div key={String(label)} style={{ padding: '14px 12px', background: '#fff' }}><div style={{ fontSize: 20, fontWeight: 650 }}>{value}</div><div style={{ marginTop: 4, fontSize: 11, color: colors.muted }}>{label}</div></div>)}
    </section>
    <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', padding: '10px 16px', borderBottom: `1px solid ${colors.line}`, fontSize: 10, color: colors.muted }}><span><i style={{ display: 'inline-block', width: 7, height: 7, borderRadius: '50%', background: colors.good, marginRight: 4 }} />正常</span><span><i style={{ display: 'inline-block', width: 7, height: 7, borderRadius: '50%', background: colors.warn, marginRight: 4 }} />需要关注</span><span><i style={{ display: 'inline-block', width: 7, height: 7, borderRadius: '50%', background: colors.bad, marginRight: 4 }} />会阻塞运行</span><span><i style={{ display: 'inline-block', width: 7, height: 7, borderRadius: '50%', background: colors.muted, marginRight: 4 }} />已暂时关闭</span><span><i style={{ display: 'inline-block', width: 7, height: 7, borderRadius: '50%', background: colors.accent, marginRight: 4 }} />本会话使用</span></div>
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
      <button type="button" onClick={() => void downloadExport('json')} style={{ padding: '5px 9px', border: `1px solid ${colors.line}`, borderRadius: 4, background: '#fff', color: colors.ink, cursor: 'pointer', fontSize: 11 }}>导出 JSON</button>
      <button type="button" onClick={() => void downloadExport('md')} style={{ padding: '5px 9px', border: `1px solid ${colors.line}`, borderRadius: 4, background: '#fff', color: colors.ink, cursor: 'pointer', fontSize: 11 }}>导出 MD</button>
      <button type="button" onClick={() => void downloadExport('csv')} style={{ padding: '5px 9px', border: `1px solid ${colors.line}`, borderRadius: 4, background: '#fff', color: colors.ink, cursor: 'pointer', fontSize: 11 }}>导出 CSV</button>
      <button type="button" onClick={toggleCompare} style={{ padding: '5px 9px', border: `1px solid ${colors.line}`, borderRadius: 4, background: '#fff', color: colors.ink, cursor: 'pointer', fontSize: 11 }}>{compareOpen ? '收起对比' : 'Profile 对比'}</button>
      <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="搜索插件…" aria-label="搜索插件" style={{ padding: '5px 9px', border: `1px solid ${colors.line}`, borderRadius: 4, color: colors.ink, background: '#fff', fontSize: 11 }} />
    </div>
    {compareOpen && <section style={{ marginBottom: 12, padding: 12, background: colors.panel, border: `1px solid ${colors.line}`, borderRadius: 6 }}><div style={{ fontSize: 12, fontWeight: 650, color: colors.muted, marginBottom: 8 }}>Profile 对比</div>{compare.length === 0 ? <div style={{ fontSize: 11, color: colors.muted }}>无数据（本机仅一个 profile 或尚未加载）</div> : <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}><thead><tr>{['Profile', '版本', '状态', '插件', '正常', '需关注', '阻塞'].map((head) => <th key={head} style={{ textAlign: 'left', padding: '4px 6px', color: colors.muted }}>{head}</th>)}</tr></thead><tbody>{compare.map((entry) => <tr key={entry.profile}>{[entry.profile, entry.report.dshVersion, entry.report.status, entry.report.summary.total, entry.report.summary.active, entry.report.summary.attention, entry.report.summary.blocked].map((value, index) => <td key={index} style={{ padding: '4px 6px', color: colors.ink }}>{String(value)}</td>)}</tr>)}</tbody></table>}</section>}
    <section style={{ padding: '18px 16px' }}>
      <div style={{ marginBottom: 14, fontSize: 12, color: colors.muted }}>最终配置 · {report.runtime.dumpConfig === 'ok' ? `${report.runtime.activatedEntries} 个已装载条目` : '读取失败'}　·　本次运行 · {report.usage.sessionEvents} 条会话事件 · {report.usage.toolCalls} 次工具调用</div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}><div style={{ fontSize: 12, color: colors.muted }}>DSH 本体 → 当前 Profile → 插件与能力</div><select value={filter} onChange={(event) => setFilter(event.target.value)} aria-label="筛选插件" style={{ border: `1px solid ${colors.line}`, borderRadius: 4, padding: '4px 6px', color: colors.ink, background: '#fff', fontSize: 11 }}><option value="all">全部</option><option value="attention">需关注</option><option value="used">本轮使用</option><option value="core">DSH 本体</option><option value="bundle">当前插件</option><option value="user">未启用</option></select></div>
      <div style={{ border: `1px solid ${colors.line}`, borderRadius: 6, padding: '10px 12px', overflow: 'hidden' }}>
        {visible.length === 0 ? <div style={{ padding: 18, color: colors.muted, fontSize: 11 }}>当前筛选条件下没有插件。</div> : <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 10px', border: `1px solid ${colors.line}`, borderRadius: 5, fontSize: 12, fontWeight: 700 }}><span style={{ width: 8, height: 8, borderRadius: '50%', background: report.status === 'blocked' ? colors.bad : report.status === 'attention' ? colors.warn : colors.good }} />DSH 本体<span style={{ marginLeft: 'auto', fontSize: 10, color: colors.muted }}>{report.dshVersion}</span></div>
          <div style={{ margin: '6px 0 0 16px', borderLeft: `1px solid ${colors.line}`, paddingLeft: 12 }}>
            <div style={{ padding: '8px 10px', border: `1px solid ${colors.line}`, borderRadius: 5, fontSize: 11, fontWeight: 650 }}>当前 Profile：{report.profile}<span style={{ marginLeft: 8, color: colors.muted, fontWeight: 400 }}>{report.runtime.activatedEntries} 个运行条目</span></div>
            {renderLayer('Web 应用层', '负责对话界面与浏览器交互', webApp)}
            {renderLayer('DSH 基础层', '模型、会话、工具与权限', foundation)}
            {renderLayer('用户插件', `${bundles.length} 个已进入当前插件树`, bundles)}
          </div>
          {renderLayer('已安装但未启用', '安装在 Profile 中，当前没有进入运行树', unmounted)}
        </>}
      </div>
    </section>
  </div>
}

// 折叠入口几何常量：切角 22%/78% 来自历次视觉迭代，细线角度由几何推导，
// 保证内侧细线与切角严格平行（旧版硬编码 62deg 与 53° 实际斜率偏差 ~9°）。
const PILL_W = 28
const PILL_H = 168
const PILL_CUT = 0.22
const PILL_INNER_W = PILL_W - 2
const PILL_INNER_H = PILL_H - 2
const PILL_CUT_Y = PILL_INNER_H * PILL_CUT
const PILL_ANGLE = (Math.atan2(PILL_CUT_Y, PILL_INNER_W) * 180) / Math.PI
// 内侧装饰线：取内层切角对角线 +4px，两端以 mask 渐变淡出（18% 渐入/渐出），
// hover/展开变钉蓝。
const PILL_LINE_LEN = Math.hypot(PILL_INNER_W, PILL_CUT_Y) + 4
const PILL_LINE_MASK = 'linear-gradient(90deg, transparent, #000 18%, #000 82%, transparent)'
// 上下两条外侧轮廓线（用户红线标注位置）：沿外壳 clip 斜边，几何按外层切角计算；
// 实线（无渐变/无淡出），idle 透明（保持壳底自然边缘），hover/展开显示钉蓝实线。
const PILL_EDGE_ANGLE = (Math.atan2(PILL_H * PILL_CUT, PILL_W) * 180) / Math.PI
const PILL_EDGE_LEN = Math.hypot(PILL_W, PILL_H * PILL_CUT) + 2
// 右侧垂直边（用户要求 hover 变蓝）：位于外壳右直边内侧，悬浮在上/下切角之间。
const PILL_EDGE_TOP = PILL_H * PILL_CUT
const PILL_EDGE_H = PILL_H * (1 - 2 * PILL_CUT)
const PILL_CLIP = `polygon(0 0, 100% ${PILL_CUT * 100}%, 100% ${(1 - PILL_CUT) * 100}%, 0 100%)`

// 使用 DSH web 提供的主题变量（同 host boot 帧），未定义时回退到原硬编码色，
// 使中性表面在暗色主题（body[data-ds-dark-theme]）下不再发白刺眼。
// 注意：交互强调色保持原钉蓝 #2864d7——DSH 的 --dsw-alias-brand-primary 是近黑品牌色，
// 直接引用会把悬停/聚焦从蓝变成黑（用户 2026-09-07 反馈）。
// 颜色层级遵循主流产品标准（VS Code / Linear / GitHub 侧栏 tab 类）：
// idle=中性 → hover 内底 8% 主色 tint + 上下两条斜线转钉蓝实线（外壳保持浅灰轮廓）
// → open/激活=12% tint + 强调装饰 → focus=仅键盘内环（不联动 hover 视觉）。
const pillTheme = {
  bg: 'var(--dsw-alias-bg-base, #fff)',
  bgHover: 'color-mix(in srgb, #2864d7 8%, var(--dsw-alias-bg-base, #fff))',
  bgOpen: 'color-mix(in srgb, #2864d7 12%, var(--dsw-alias-bg-base, #fff))',
  bgOpenHover: 'color-mix(in srgb, #2864d7 16%, var(--dsw-alias-bg-base, #fff))',
  ink: 'var(--dsw-alias-label-primary, #17212b)',
  line: 'var(--dsw-alias-border-l2, #e5e9ed)',
  lineStrong: 'var(--dsw-alias-label-tertiary, #cbd3dc)',
  accent: '#2864d7',
}

function InsightTreeDock(): React.ReactElement {
  const [open, setOpen] = React.useState(false)
  const [hovered, setHovered] = React.useState(false)
  const [sidebarRight, setSidebarRight] = React.useState(280)
  const dockRef = React.useRef<HTMLDivElement>(null)
  React.useEffect(() => {
    // 展开时点击面板/胶囊之外的空白处收起（点击外部关闭，不阻断页面其他交互）。
    if (!open) return
    const onDown = (event: PointerEvent): void => {
      const el = dockRef.current
      if (el && event.target instanceof Node && !el.contains(event.target)) setOpen(false)
    }
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
  }, [open])
  React.useEffect(() => {
    const frame = document.querySelector('[class*="_frame"]') as HTMLElement | null
    const sidebar = frame?.firstElementChild as HTMLElement | null
    const measure = (): void => {
      const right = sidebar?.getBoundingClientRect().right
      if (right && Number.isFinite(right)) setSidebarRight(Math.round(right))
    }
    measure()
    const resize = sidebar && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : undefined
    if (sidebar && resize) resize.observe(sidebar)
    window.addEventListener('resize', measure)
    const mutations = typeof MutationObserver !== 'undefined' ? new MutationObserver(measure) : undefined
    if (frame && mutations) mutations.observe(frame, { attributes: true, attributeFilter: ['class', 'style', 'data-sidebar-collapsed', 'data-details-collapsed'] })
    return () => {
      resize?.disconnect()
      mutations?.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [])
  const panelWidth = `min(760px, max(220px, calc(100vw - ${sidebarRight}px - 32px)))`
  const pillShadow = hovered
    ? 'drop-shadow(0 4px 12px rgba(40,100,215,.18))'
    : 'drop-shadow(0 2px 8px rgba(23,33,43,.10))'
  const pillFace = hovered ? (open ? pillTheme.bgOpenHover : pillTheme.bgHover) : (open ? pillTheme.bgOpen : pillTheme.bg)
  // 上下两条外侧轮廓线（用户红线标注的两条斜边）：仅 hover/展开显示钉蓝实线，无淡出。
  const pillEdge = hovered || open ? pillTheme.accent : 'transparent'
  const pillLine = open ? pillTheme.accent : hovered ? pillTheme.accent : pillTheme.line
  return <div ref={dockRef} style={{ position: 'absolute', inset: 0, zIndex: 21, pointerEvents: 'none' }}>
    <div style={{ position: 'absolute', top: 0, bottom: 0, left: sidebarRight, display: 'flex', alignItems: 'center', pointerEvents: 'auto' }}>
      <div style={{ position: 'relative', zIndex: 3, width: PILL_W, height: PILL_H, flex: `0 0 ${PILL_W}px`, clipPath: PILL_CLIP, background: pillTheme.line, filter: pillShadow, transform: hovered ? 'translateX(1px)' : 'none', transition: 'filter .16s ease, transform .16s ease' }}>
        <span aria-hidden="true" style={{ position: 'absolute', zIndex: 1, left: 0.5, top: 0.75, width: PILL_EDGE_LEN, height: 1.5, background: pillEdge, transformOrigin: 'left center', transform: `rotate(${PILL_EDGE_ANGLE}deg)`, opacity: 1, pointerEvents: 'none', transition: 'background .16s ease' }} />
        <span aria-hidden="true" style={{ position: 'absolute', zIndex: 1, left: 0.5, bottom: 0.75, width: PILL_EDGE_LEN, height: 1.5, background: pillEdge, transformOrigin: 'left center', transform: `rotate(-${PILL_EDGE_ANGLE}deg)`, opacity: 1, pointerEvents: 'none', transition: 'background .16s ease' }} />
        <span aria-hidden="true" style={{ position: 'absolute', zIndex: 1, left: PILL_W - 1.5, top: PILL_EDGE_TOP, width: 1.5, height: PILL_EDGE_H, background: pillEdge, opacity: 1, pointerEvents: 'none', transition: 'background .16s ease' }} />
        <button type="button" onClick={() => setOpen(!open)} onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)} title={open ? '点击收起插件树' : '点击展开插件树'} aria-label={open ? '收起插件树' : '展开插件树'} aria-pressed={open} style={{ position: 'absolute', inset: 1, width: PILL_INNER_W, height: PILL_INNER_H, padding: '16px 5px', border: 0, background: pillFace, color: open ? pillTheme.accent : pillTheme.ink, cursor: 'pointer', writingMode: 'vertical-rl', fontSize: 11, fontWeight: 500, letterSpacing: '.14em', lineHeight: 1.7, userSelect: 'none', clipPath: PILL_CLIP, transition: 'background .16s ease, color .16s ease' }}>{open ? '收起插件树' : '插件树'}</button>
        <span aria-hidden="true" style={{ position: 'absolute', zIndex: 2, left: 2, top: 11, width: PILL_LINE_LEN, height: 1, background: pillLine, WebkitMaskImage: PILL_LINE_MASK, maskImage: PILL_LINE_MASK, transformOrigin: 'left center', transform: `rotate(${PILL_ANGLE}deg)`, opacity: 1, pointerEvents: 'none', transition: 'background .16s ease' }} />
        <span aria-hidden="true" style={{ position: 'absolute', zIndex: 2, left: 2, bottom: 11, width: PILL_LINE_LEN, height: 1, background: pillLine, WebkitMaskImage: PILL_LINE_MASK, maskImage: PILL_LINE_MASK, transformOrigin: 'left center', transform: `rotate(-${PILL_ANGLE}deg)`, opacity: 1, pointerEvents: 'none', transition: 'background .16s ease' }} />
      </div>
      {open && <>
        <div aria-hidden="true" style={{ position: 'absolute', zIndex: 4, left: PILL_W - 6, top: '50%', width: 14, height: 52, transform: 'translateY(-50%)', background: pillTheme.bg, borderTop: `1px solid ${pillTheme.line}`, borderRight: `1px solid ${pillTheme.line}`, borderBottom: `1px solid ${pillTheme.line}`, borderRadius: '0 4px 4px 0', filter: 'drop-shadow(2px 0 7px rgba(23,33,43,.05))' }}>
          <span style={{ position: 'absolute', left: 0, top: '50%', width: 14, height: 1, background: pillTheme.accent, transform: 'translateY(-50%)' }} />
          <span style={{ position: 'absolute', left: 3, top: '50%', width: 5, height: 5, background: pillTheme.bg, border: `1px solid ${pillTheme.accent}`, borderRadius: '50%', transform: 'translate(-50%, -50%)' }} />
        </div>
        <div style={{ position: 'relative', zIndex: 2, width: panelWidth, maxWidth: 'calc(100vw - 40px)', height: '100%', overflow: 'hidden', boxShadow: '8px 0 24px rgba(23,33,43,.12)' }}><InsightTreePanel embedded /></div>
      </>}
    </div>
  </div>
}

function shortPluginName(id: string): string {
  return id.replace(/^@deepseek-ai\/dsh-tool-/u, 'tool-').replace(/^@deepseek-ai\//u, '').replace(/^dsh-/u, '')
}

function ownerDotStyle(plugin: Plugin | undefined, used = false): string {
  if (!plugin) return colors.accent
  const findings = plugin.findings ?? []
  if (plugin.fiberPhase === 'failed' || plugin.status === 'blocked' || findings.some((finding) => finding.severity === 'blocking')) return colors.bad
  if (plugin.status === 'warning' || plugin.status === 'degraded' || findings.some((finding) => finding.severity === 'warning' || finding.severity === 'degraded')) return colors.warn
  if (plugin.status === 'disabled') return colors.muted
  if (used) return colors.accent
  return colors.good
}

function ConversationInsightTree(props: OverlayProps = {}): React.ReactElement {
  const [open, setOpen] = React.useState(false)
  const [pluginUse, setPluginUse] = React.useState<Array<[string, number]>>([])
  const [plugins, setPlugins] = React.useState<Plugin[]>([])
  const [expanded, setExpanded] = React.useState('')
  const currentSessionId = props.useSessions?.((state) => state.current) as string | undefined
  React.useEffect(() => {
    const load = (): void => {
      const endpoint = currentSessionId ? `/dsh-insight-tree/session/${encodeURIComponent(currentSessionId)}` : '/dsh-insight-tree/session/current'
      const headers: Record<string, string> = sharedToken ? { 'x-dsh-insight-tree-token': sharedToken } : {}
      void fetch(endpoint, { cache: 'no-store', headers })
        .then((response) => { if (!response.ok) throw new Error(`HTTP ${response.status}`); return response.json() as Promise<Report> })
        .then((data) => {
          const currentPlugins = (Array.isArray(data.plugins) ? data.plugins : []).map((plugin) => ({ ...plugin, provides: Array.isArray(plugin.provides) ? plugin.provides : [], dependsOn: Array.isArray(plugin.dependsOn) ? plugin.dependsOn : [], dependents: Array.isArray(plugin.dependents) ? plugin.dependents : [], findings: Array.isArray(plugin.findings) ? plugin.findings : [] }))
          setPlugins(currentPlugins)
          const explicit = Object.fromEntries(currentPlugins.filter((plugin) => plugin.sessionUsage).map((plugin) => [plugin.id, plugin.sessionUsage?.count ?? 0]))
          const inferred = Object.fromEntries(Object.entries(aggregatePluginUse(data.activity?.byTool, data.activity?.toolOwners)))
          const use = Object.entries({ ...inferred, ...explicit })
            .map(([id, count]) => [id, count] as [string, number])
            .sort((a, b) => b[1] - a[1])
          setPluginUse(use)
        })
        .catch(() => { setPlugins([]); setPluginUse([]) })
    }
    load()
    const timer = window.setInterval(load, 5000)
    return () => window.clearInterval(timer)
  }, [currentSessionId])
  const byId = new Map(plugins.map((plugin) => [plugin.id, plugin]))
  return (
    <div style={{ position: 'fixed', right: 0, top: 120, zIndex: 40, display: 'flex', alignItems: 'flex-start', flexDirection: 'row-reverse', fontFamily: 'Inter, system-ui, sans-serif' }}>
      <button type="button" onClick={() => setOpen(!open)} style={{ padding: '10px 7px', border: `1px solid ${colors.line}`, borderRight: 0, borderRadius: '5px 0 0 5px', background: '#fff', color: colors.ink, cursor: 'pointer', writingMode: 'vertical-rl', fontSize: 11 }}>{open ? '收起结构' : '本轮活动'}</button>
      {open && (
        <div style={{ width: 'min(260px, calc(100vw - 40px))', maxHeight: 'min(430px, calc(100vh - 160px))', overflow: 'auto', padding: 14, background: '#fff', border: `1px solid ${colors.line}`, borderLeft: 0, borderRadius: '0 6px 6px 0', boxShadow: '0 8px 24px rgba(23,33,43,.12)' }}>
          <div style={{ fontSize: 13, fontWeight: 650 }}>本轮活动 · 插件调用</div>
          {pluginUse.length === 0 ? <div style={{ marginTop: 12, fontSize: 11, color: colors.muted }}>本轮尚未使用额外插件。</div> : pluginUse.map(([id, count]) => {
            const plugin = byId.get(id)
            const active = expanded === id
            return (
              <div key={id} style={{ marginTop: 10, paddingTop: 9, borderTop: `1px solid ${colors.line}` }}>
                <div onClick={() => { setExpanded(active ? '' : id); window.dispatchEvent(new CustomEvent('dsh-insight-tree:select', { detail: { id } })); window.location.hash = `dsh-insight-tree/${encodeURIComponent(id)}` }} style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 7 }}>
                  <span style={{ width: 8, height: 8, borderRadius: '50%', background: ownerDotStyle(plugin, true), flexShrink: 0 }} />
                  <span style={{ fontSize: 12, fontWeight: 600, flex: 1 }}>{shortPluginName(id)}{active ? ' ▾' : ' ▸'}</span>
                </div>
                <div style={{ marginTop: 4, fontSize: 11, color: colors.muted }}>调用 {count} 次</div>
                {plugin?.sessionUsage?.lastActivity && <div style={{ marginTop: 2, fontSize: 10, color: colors.muted }}>最近活动：{new Date(plugin.sessionUsage.lastActivity).toLocaleTimeString()}</div>}
                {active && (
                  <div style={{ marginTop: 8, padding: '8px 9px', background: colors.panel, border: `1px solid ${colors.line}`, borderRadius: 5, fontSize: 11, lineHeight: 1.6, color: colors.muted }}>
                    {plugin ? (
                      <>
                        <div>状态：{statusText[plugin.status] ?? plugin.status} · Loader：{plugin.fiberPhase ?? '—'}</div>
                        <div>版本：{plugin.version ?? '未知'} · 适配：{plugin.compatibility?.label ?? '待确认'}</div>
                        {plugin.role && <div>{plugin.role}</div>}
                        {plugin.provides.length > 0 && <div>能力：{plugin.provides.join('、')}</div>}
                        {(plugin.findings ?? []).length > 0 && <div style={{ color: colors.warn }}>关注：{(plugin.findings ?? []).map((finding) => finding.title).join('；')}</div>}
                      </>
                    ) : (
                      <div style={{ marginTop: 4 }}>功能：工具注册方插件（来自预设 / Agent 层）<div>完整标识：{id}<div>该插件来自工具注册（预设 / Agent 层），未纳入当前 Profile 插件树。</div></div></div>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

export const inject = ['slots']

export function apply(ctx: { slots: { inject: (name: string, factory: () => unknown) => void; register: (definition: unknown, component: unknown) => unknown } }): void {
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'dsh-insight-tree', order: 10 }, InsightTreeDock))
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'dsh-insight-tree-conversation', order: 20 }, ConversationInsightTree))
}

export function mount(element: HTMLElement): void { createRoot(element).render(<InsightTreePanel />) }
