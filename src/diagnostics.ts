import type { InsightTreeReport } from './model.js'

/** Decide whether a failed DSH start has enough evidence to open diagnostics. */
export function isPluginRelatedFailure(report: Pick<InsightTreeReport, 'plugins'> | undefined, output = ''): boolean {
  if (!report) return false
  const pluginIds = report.plugins.filter((plugin) => plugin.source !== 'core').map((plugin) => plugin.id)
  const blockedPlugin = report.plugins.some((plugin) => plugin.source !== 'core' && plugin.findings.some((finding) => finding.severity === 'blocking' && finding.impact === 'startup'))
  if (blockedPlugin) return true
  return pluginIds.some((id) => id.length > 0 && output.includes(id))
}
