import os from 'node:os'
import type { InsightTreeFinding, InsightTreePlugin, InsightTreeReport } from './model.js'

function redact(value: string | undefined): string | undefined {
  if (!value) return value
  const home = os.homedir()
  let result = home ? value.replaceAll(home, '~') : value
  result = result.replace(/[A-Za-z]:\\Users\\[^\\]+/gu, '~').replace(/\/home\/[^/]+/gu, '~')
  return result
}

/** Copy of the report safe to hand to external users: no absolute package paths, no raw env paths. */
export function sanitizeReport(report: InsightTreeReport): InsightTreeReport {
  const redactFinding = (finding: InsightTreeFinding): InsightTreeFinding => ({ ...finding, evidence: redact(finding.evidence) })
  return {
    ...report,
    plugins: report.plugins.map((plugin) => ({
      ...plugin,
      packagePath: undefined,
      findings: plugin.findings.map(redactFinding),
    })),
    findings: report.findings.map(redactFinding),
    runtime: { ...report.runtime, error: redact(report.runtime.error) },
  }
}

export function renderMarkdownReport(report: InsightTreeReport): string {
  const lines: string[] = []
  lines.push('# DSH Insight Tree 报告')
  lines.push('')
  lines.push(`- 生成时间：${report.generatedAt}`)
  lines.push(`- DSH 版本：${report.dshVersion}（来源：${report.versionSource}）`)
  lines.push(`- Profile：${report.profile}${report.patch.reload ? ` · 重载：${report.patch.reload}` : ''}`)
  lines.push(`- 状态：${report.status}`)
  lines.push(`- 摘要：插件 ${report.summary.total} · 正常 ${report.summary.active} · 需关注 ${report.summary.attention} · 阻塞 ${report.summary.blocked}`)
  const loaderCount = report.loader?.length ?? 0
  lines.push(`- Loader 条目：${loaderCount}${report.ruleVersion ? ` · 规则版本：${report.ruleVersion}` : ''}`)
  lines.push('')
  lines.push('## 插件')
  lines.push('')
  lines.push('| 插件 | 状态 | 版本 | 适配 | Fiber | 能力 | 依赖 | 被依赖 | 问题 |')
  lines.push('|---|---|---|---|---|---|---|---|---|')
  for (const plugin of report.plugins) {
    const findings = plugin.findings.length ? plugin.findings.map((f) => f.title).join('；') : '—'
    lines.push(`| ${escapeMd(plugin.name)} | ${plugin.status} | ${plugin.version ?? '—'} | ${plugin.compatibility.label} | ${plugin.fiberPhase ?? '—'} | ${plugin.provides.length ? escapeMd(plugin.provides.join('、')) : '—'} | ${plugin.dependsOn.join('、') || '—'} | ${plugin.dependents.join('、') || '—'} | ${escapeMd(findings)} |`)
  }
  lines.push('')
  lines.push('## 发现项')
  lines.push('')
  if (!report.findings.length) lines.push('无。')
  for (const finding of report.findings) {
    lines.push(`### ${finding.title}（${finding.severity} / ${finding.impact}）`)
    lines.push(`- ${finding.message}`)
    if (finding.recommendation) lines.push(`- 建议：${finding.recommendation}`)
    if (finding.evidence) lines.push(`- 依据：${redact(finding.evidence)}`)
    lines.push('')
  }
  lines.push('## 推荐动作')
  lines.push('')
  if (!report.recommendedActions.length) lines.push('无。')
  for (const action of report.recommendedActions) lines.push(`- ${action}`)
  lines.push('')
  return lines.join('\n')
}

function escapeMd(value: string): string {
  return value.replace(/\|/gu, '\\|').replace(/\n/gu, ' ')
}

export function renderPluginCsv(report: InsightTreeReport): string {
  const header = ['id', 'name', 'status', 'version', 'compatibility', 'enabled', 'fiberPhase', 'provides', 'dependsOn', 'dependents', 'findings']
  const rows = report.plugins.map((plugin) => [
    plugin.id,
    plugin.name,
    plugin.status,
    plugin.version ?? '',
    plugin.compatibility.label,
    plugin.enabled === undefined ? '' : String(plugin.enabled),
    plugin.fiberPhase ?? '',
    plugin.provides.join(' | '),
    plugin.dependsOn.join(' | '),
    plugin.dependents.join(' | '),
    plugin.findings.map((finding) => finding.title).join(' | '),
  ])
  return [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\n')
}

function csvCell(value: string): string {
  return /[",\n]/u.test(value) ? `"${value.replace(/"/gu, '""')}"` : value
}

export interface InsightTreeCompareEntry { profile: string; report: InsightTreeReport }

export function renderCompareMarkdown(profiles: InsightTreeCompareEntry[]): string {
  const lines: string[] = []
  lines.push('# DSH Insight Tree 多 Profile 对比')
  lines.push('')
  lines.push('| Profile | 版本 | 状态 | 插件 | 正常 | 需关注 | 阻塞 |')
  lines.push('|---|---|---|---|---|---|---|')
  for (const { profile, report } of profiles) {
    lines.push(`| ${profile} | ${report.dshVersion} | ${report.status} | ${report.summary.total} | ${report.summary.active} | ${report.summary.attention} | ${report.summary.blocked} |`)
  }
  lines.push('')
  for (const { profile, report } of profiles) {
    lines.push(`## ${profile}`)
    lines.push('')
    lines.push(renderMarkdownReport(report))
  }
  return lines.join('\n')
}
