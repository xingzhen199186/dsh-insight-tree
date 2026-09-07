import test from 'node:test'
import assert from 'node:assert/strict'
import { applyRules } from '../lib/index.js'

test('rules 为不兼容项附加动作', () => {
  const plugins = [{
    id: 'demo',
    name: '演示插件',
    source: 'bundle',
    status: 'warning',
    compatibility: { status: 'incompatible', label: '版本可能不适配' },
    role: 'r',
    provides: [],
    dependsOn: [],
    dependents: [],
    findings: [],
  }]
  const out = applyRules(plugins, [{ id: 'demo:incompatible', severity: 'warning', impact: 'plugin', title: '版本可能不适配', message: 'm' }])
  const finding = out.findings.find((item) => item.id === 'demo:incompatible')
  assert.equal(finding.action.kind, 'recheck')
})

test('rules 为 failed 插件添加 Loader 失败项', () => {
  const plugins = [{
    id: 'demo',
    name: '演示插件',
    source: 'bundle',
    status: 'warning',
    compatibility: { status: 'compatible', label: '适配' },
    role: 'r',
    provides: [],
    dependsOn: [],
    dependents: [],
    findings: [],
    fiberPhase: 'failed',
    enabled: true,
  }]
  const out = applyRules(plugins, [])
  assert.ok(out.findings.some((item) => item.id === 'loader:demo:failed'))
})

test('rules 对 pending 只给 info（不触发需关注/黄点）', () => {
  const plugins = [{
    id: 'demo',
    name: '演示插件',
    source: 'bundle',
    status: 'active',
    compatibility: { status: 'compatible', label: '适配' },
    role: 'r',
    provides: [],
    dependsOn: [],
    dependents: [],
    findings: [],
    fiberPhase: 'pending',
    enabled: true,
  }]
  const out = applyRules(plugins, [])
  const pending = out.findings.find((item) => item.id === 'loader:demo:pending')
  assert.ok(pending)
  assert.equal(pending.severity, 'info')
})

test('rules 为禁用核心插件添加警告', () => {
  const plugins = [{
    id: '@deepseek-ai/dsh-base',
    name: 'DSH dsh-base',
    source: 'core',
    status: 'warning',
    compatibility: { status: 'compatible', label: '随当前 DSH 安装' },
    role: 'r',
    provides: [],
    dependsOn: [],
    dependents: [],
    findings: [],
    enabled: false,
  }]
  const out = applyRules(plugins, [])
  assert.ok(out.findings.some((item) => item.id === 'loader:@deepseek-ai/dsh-base:core-disabled'))
})
