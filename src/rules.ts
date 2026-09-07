import type { InsightTreeAction, InsightTreeFinding, InsightTreePlugin } from './model.js'

export const RULES_VERSION = 1

export interface RuleOutcome {
  findings: InsightTreeFinding[]
}

function action(kind: InsightTreeAction['kind'], plugin: string | undefined, label?: string): InsightTreeAction {
  return { kind, plugin, label }
}

function loaderFinding(plugin: InsightTreePlugin, severity: InsightTreeFinding['severity'], phase: string, title: string, message: string, recommendation: string): InsightTreeFinding {
  return {
    id: `loader:${plugin.id}:${phase}`,
    severity,
    impact: 'plugin',
    title,
    message,
    recommendation,
    evidence: `Loader fiberPhase=${plugin.fiberPhase ?? 'null'}, enabled=${plugin.enabled ?? '?'}`,
    action: action('recheck', plugin.id, '重新检查'),
  }
}

/**
 * Rule engine on the final plugin/finding state. Existing findings stay as-is
 * but get a machine-readable `action` (client renders a button); loader-state
 * findings are added here rather than in discovery, so discovery stays the
 * profile/manifest reader and rules own the diagnostic interpretation.
 */
export function applyRules(plugins: InsightTreePlugin[], findings: InsightTreeFinding[]): RuleOutcome {
  const result = findings.map((finding) => {
    const plugin = plugins.find((item) => finding.id.startsWith(`${item.id}:`))
    const withAction: InsightTreeFinding = { ...finding }
    if (!withAction.action) {
      if (finding.id.includes(':incompatible')) withAction.action = action('recheck', plugin?.id, '重新检查')
      else if (finding.id.includes(':not-mounted')) withAction.action = action('recheck', plugin?.id, '重新检查')
      else if (finding.id.includes(':missing-dependency')) withAction.action = action('recheck', plugin?.id, '重新检查')
    }
    return withAction
  })

  for (const plugin of plugins) {
    if (plugin.fiberPhase === 'failed' && !result.some((finding) => finding.id === `loader:${plugin.id}:failed`)) {
      if (plugin.status === 'active' || plugin.status === 'warning') plugin.status = 'degraded'
      result.push(loaderFinding(plugin, 'degraded', 'failed', '插件激活失败（Loader）', `插件 ${plugin.name} 的 Loader Fiber 处于 failed，当前未运行。`, '检查该插件的依赖与配置，修复后重新检查或重启。'))
    } else if (plugin.fiberPhase === 'pending' && !result.some((finding) => finding.id === `loader:${plugin.id}:pending`)) {
      // pending is a point-in-time fact, not a defect: include/isolate/group
      // structure and transient startup both show pending. Keep it as info so
      // it never inflates "需关注" or colors the dot yellow.
      result.push(loaderFinding(plugin, 'info', 'pending', '插件等待加载（Loader）', `插件 ${plugin.name} 的 Loader Fiber 当前为 pending（可能仍在启动或属于结构行）。`, '稍候重新检查；只有持续 pending 或变为 failed 才需要处理。'))
    }
    if (plugin.source === 'core' && plugin.enabled === false) {
      result.push({
        id: `loader:${plugin.id}:core-disabled`,
        severity: 'warning',
        impact: 'profile',
        title: '核心插件被禁用',
        message: `核心 DSH 插件 ${plugin.name} 当前被禁用，可能影响整个 Profile 的能力。`,
        recommendation: '确认是否有意；如误操作请重新启用并重启。',
        evidence: `Loader enabled=${plugin.enabled}`,
        action: action('enable', plugin.id, '重新启用'),
      })
    }
  }

  return { findings: result }
}
