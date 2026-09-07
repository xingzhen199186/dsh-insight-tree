import test from 'node:test'
import assert from 'node:assert/strict'
import { renderMarkdownReport, renderPluginCsv, sanitizeReport } from '../lib/index.js'

const report = {
  schemaVersion: 3,
  generatedAt: '2026-09-06T00:00:00.000Z',
  dshVersion: '0.1.2-rc.1',
  versionSource: 'installed',
  profile: 'web',
  patch: { entries: 1, reload: 'live' },
  usage: { sessionEvents: 0, toolCalls: 0 },
  ruleVersion: 1,
  runtime: { dumpConfig: 'ok', activatedEntries: 1 },
  status: 'ready',
  summary: { total: 1, active: 1, attention: 0, blocked: 0 },
  plugins: [{
    id: 'demo',
    name: '演示插件',
    source: 'bundle',
    status: 'active',
    packagePath: 'C:\\Users\\someone\\dsh\\profile\\node_modules\\demo\\package.json',
    compatibility: { status: 'compatible', label: '适配当前版本' },
    role: '已装配到当前 Profile',
    provides: ['能力 A'],
    dependsOn: [],
    dependents: [],
    findings: [{ id: 'demo:info', severity: 'info', impact: 'none', title: '提示', message: '无', evidence: 'C:\\Users\\someone\\evidence' }],
  }],
  findings: [{ id: 'demo:info', severity: 'info', impact: 'none', title: '提示', message: '无', evidence: 'C:\\Users\\someone\\evidence' }],
  recommendedActions: [],
}

test('sanitizeReport 脱敏绝对路径并移除 packagePath', () => {
  const sanitized = sanitizeReport(report)
  assert.equal(sanitized.plugins[0].packagePath, undefined)
  assert.equal(sanitized.plugins[0].findings[0].evidence, '~\\evidence')
  assert.equal(sanitized.findings[0].evidence, '~\\evidence')
})

test('renderMarkdownReport 输出标题与插件行', () => {
  const md = renderMarkdownReport(report)
  assert.match(md, /# DSH Insight Tree 报告/u)
  assert.match(md, /演示插件/u)
  assert.match(md, /DSH 版本：0\.1\.2-rc\.1/u)
})

test('renderPluginCsv 输出表头与行', () => {
  const csv = renderPluginCsv(report)
  assert.match(csv, /^id,name,status/u)
  assert.match(csv, /demo/u)
})
