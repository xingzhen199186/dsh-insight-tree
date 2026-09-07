import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-insight-tree-'))
const profile = path.join(root, 'profiles', 'web')
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value) }
write(path.join(profile, 'package.json'), JSON.stringify({
  dependencies: { '@deepseek-ai/dsh-base': '0.1.2-rc.1', '@deepseek-ai/dsh-web-app': '0.1.2-rc.1', 'demo-plugin': '1.0.0', 'unmounted-plugin': '1.0.0' },
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'demo-plugin'], patchReload: 'live' } },
}))
write(path.join(profile, 'node_modules', '@deepseek-ai', 'dsh-base', 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-base', version: '0.1.2-rc.1' }))
write(path.join(profile, 'node_modules', '@deepseek-ai', 'dsh-web-app', 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-web-app', version: '0.1.2-rc.1', description: 'technical package description' }))
write(path.join(profile, 'node_modules', '@deepseek-ai', 'dsh-tools', 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-tools', version: '0.1.2-rc.1' }))
write(path.join(profile, 'node_modules', '@deepseek-ai', 'dsh-web-frontend', 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-web-frontend', version: '0.1.2-rc.1', devDependencies: { '@deepseek-ai/dsh-client-ui-slots': '^0.1.2-rc.1' } }))
write(path.join(profile, 'node_modules', 'demo-plugin', 'package.json'), JSON.stringify({ name: 'demo-plugin', version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } }, peerDependencies: { '@deepseek-ai/dsh-tools': '>=0.1.2-rc.1 <0.2.0-0', '@deepseek-ai/dsh-client-ui-slots': '>=0.1.2-rc.1 <0.2.0-0' }, dependencies: { '@deepseek-ai/dsh-base': '>=0.1.2-rc.1 <0.2.0-0' } }))
write(path.join(profile, 'node_modules', 'demo-plugin', 'cordis.patch.yml'), '- insert:\n    - id: demo\n      name: demo-plugin\n')
write(path.join(profile, 'node_modules', 'unmounted-plugin', 'package.json'), JSON.stringify({ name: 'unmounted-plugin', version: '1.0.0' }))
write(path.join(profile, 'cordis.patch.yml'), '- insert:\n    - id: demo\n      name: demo-plugin\n')
process.env.DSH_HOME = root
const { discoverReport } = await import('../lib/index.js')

test('报告包含真实插件关系和兼容性', () => {
  const report = discoverReport('web', '0.1.2-rc.1')
  const demo = report.plugins.find((plugin) => plugin.id === 'demo-plugin')
  const unmounted = report.plugins.find((plugin) => plugin.id === 'unmounted-plugin')
  assert.equal(report.schemaVersion, 3)
  assert.equal(report.versionSource, 'installed')
  assert.equal(demo.compatibility.status, 'compatible')
  assert.equal(demo.compatibility.label, '适配当前 DSH 本体 @deepseek-ai/dsh@0.1.2-rc.1')
  assert.match(demo.compatibility.evidence, /dsh-client-ui-slots 0\.1\.2-rc\.1 满足/u)
  assert.deepEqual(demo.dependsOn, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-client-ui-slots'])
  assert.ok(demo.dependents.length === 0)
  assert.equal(unmounted.findings[0].title, '已安装但未启用')
})

test('核心层使用用户化描述而不是包元数据原文', () => {
  const report = discoverReport('web', '0.1.2-rc.1', {}, [], undefined, { probeRuntime: false })
  const base = report.plugins.find((plugin) => plugin.id === '@deepseek-ai/dsh-base')
  const web = report.plugins.find((plugin) => plugin.id === '@deepseek-ai/dsh-web-app')
  assert.match(base.description, /基础运行层/u)
  assert.match(web.description, /Web 应用层/u)
  assert.doesNotMatch(base.description, /profile bundle/u)
})

test('无效 patch 产生阻塞诊断', () => {
  write(path.join(profile, 'cordis.patch.yml'), 'not: [valid')
  const report = discoverReport('web', '0.1.2-rc.1')
  assert.ok(report.findings.some((finding) => finding.id === 'profile:patch-invalid' && finding.impact === 'startup'))
})

test('patch 顶层不是数组也产生阻塞诊断', () => {
  write(path.join(profile, 'cordis.patch.yml'), 'enabled: true\n')
  const report = discoverReport('web', '0.1.2-rc.1', {}, [], undefined, { probeRuntime: false })
  assert.ok(report.findings.some((finding) => finding.id === 'profile:patch-invalid' && finding.impact === 'startup'))
})

test('disabled patch 显示暂时关闭状态', () => {
  write(path.join(profile, 'cordis.patch.yml'), '- id: demo-plugin\n  disabled: true\n')
  const report = discoverReport('web', '0.1.2-rc.1')
  assert.equal(report.plugins.find((plugin) => plugin.id === 'demo-plugin').status, 'disabled')
})

test('Loader 已关闭时即使 patch 使用真实行 id 也显示暂时关闭', () => {
  write(path.join(profile, 'cordis.patch.yml'), '- id: demo\n  disabled: true\n')
  const report = discoverReport('web', '0.1.2-rc.1', {}, [{ entryId: 'include:demo', moduleName: 'demo-plugin', enabled: false, fiberPhase: null }])
  const demo = report.plugins.find((plugin) => plugin.id === 'demo-plugin')
  assert.equal(demo.status, 'disabled')
  assert.equal(demo.enabled, false)
})

test('loader 失败发现项回填到插件 findings（筛选/详情一致）', () => {
  const report = discoverReport('web', '0.1.2-rc.1', {}, [{ entryId: 'demo', moduleName: 'demo-plugin', enabled: true, fiberPhase: 'failed' }])
  const demo = report.plugins.find((plugin) => plugin.id === 'demo-plugin')
  assert.ok(demo.findings.some((finding) => finding.id === 'loader:demo-plugin:failed'))
  assert.ok(report.findings.some((finding) => finding.id === 'loader:demo-plugin:failed'))
})

test('聚合 bundle 以根 Loader 判断启用状态，保留可选子入口的关闭状态', () => {
  write(path.join(profile, 'cordis.patch.yml'), '- id: demo-plugin\n  disabled: false\n')
  const report = discoverReport('web', '0.1.2-rc.1', {}, [
    { entryId: 'include:demo-root', moduleName: 'demo-plugin', enabled: true, fiberPhase: 'active' },
    { entryId: 'include:demo-ui', moduleName: 'demo-plugin/ui', enabled: false, fiberPhase: null },
  ])
  const demo = report.plugins.find((plugin) => plugin.id === 'demo-plugin')
  assert.equal(demo.enabled, true)
  assert.equal(demo.fiberPhase, 'active')
  assert.equal(demo.loaderEntryId, 'include:demo-root')
})

test('运行中的插件不会把未解析 peer 依赖判为启动阻塞', () => {
  const manifestPath = path.join(profile, 'package.json')
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  manifest.dependencies['peer-only-plugin'] = '1.0.0'
  manifest.dsh.profile.bundles.push('peer-only-plugin')
  write(manifestPath, JSON.stringify(manifest))
  write(path.join(profile, 'node_modules', 'peer-only-plugin', 'package.json'), JSON.stringify({
    name: 'peer-only-plugin',
    version: '1.0.0',
    dsh: { bundle: { patch: './cordis.patch.yml' } },
    peerDependencies: { 'host-only-package': '^1.0.0' },
  }))
  write(path.join(profile, 'node_modules', 'peer-only-plugin', 'cordis.patch.yml'), '- insert:\n    - id: peer-only\n      name: peer-only-plugin\n')
  const report = discoverReport('web', '0.1.2-rc.1', {}, [{ entryId: 'include:peer-only', moduleName: 'peer-only-plugin', enabled: true, fiberPhase: 'active' }], undefined, { probeRuntime: false })
  const plugin = report.plugins.find((item) => item.id === 'peer-only-plugin')
  const finding = plugin.findings.find((item) => item.id === 'peer-only-plugin:missing-dependency:host-only-package')
  assert.equal(plugin.status, 'active')
  assert.equal(finding.severity, 'info')
  assert.equal(finding.impact, 'none')
  assert.equal(report.status, 'ready')
})

test('静态诊断中的 peer 依赖缺失不会被标为启动阻塞', () => {
  const report = discoverReport('web', '0.1.2-rc.1', {}, [], undefined, { probeRuntime: false })
  const plugin = report.plugins.find((item) => item.id === 'peer-only-plugin')
  const finding = plugin.findings.find((item) => item.id === 'peer-only-plugin:missing-dependency:host-only-package')
  assert.equal(finding.severity, 'info')
  assert.equal(finding.impact, 'none')
  assert.equal(finding.title, '依赖声明待确认')
  assert.equal(plugin.status, 'active')
  assert.equal(report.status, 'ready')
  assert.notEqual(plugin.status, 'blocked')
})

test('独立诊断跳过完整 DSH 配置加载', () => {
  const report = discoverReport('web', '0.1.2-rc.1', {}, [], undefined, { probeRuntime: false })
  assert.equal(report.runtime.probe, 'skipped')
  assert.match(report.runtime.error, /未执行完整 DSH/u)
})

test('重复 patch 行和重复 Loader 条目产生启动阻塞诊断', () => {
  write(path.join(profile, 'cordis.patch.yml'), '- id: demo-plugin\n  disabled: true\n- id: demo-plugin\n  disabled: false\n')
  const report = discoverReport('web', '0.1.2-rc.1', {}, [
    { entryId: 'one', moduleName: 'demo-plugin', enabled: true, fiberPhase: 'active' },
    { entryId: 'two', moduleName: 'demo-plugin', enabled: true, fiberPhase: 'active' },
  ])
  assert.ok(report.findings.some((finding) => finding.id === 'profile:duplicate-patch-rows' && finding.impact === 'startup'))
  assert.ok(report.findings.some((finding) => finding.id === 'runtime:duplicate-loader-entries' && finding.impact === 'startup'))
})

test('禁用结构条目与一个启用条目不算重复加载', () => {
  write(path.join(profile, 'cordis.patch.yml'), '- id: demo-plugin\n  disabled: false\n')
  const report = discoverReport('web', '0.1.2-rc.1', {}, [
    { entryId: 'include:hmr', moduleName: '@deepseek-ai/cordis-plugin-hmr', enabled: false, fiberPhase: null },
    { entryId: 'alias:hmr', moduleName: '@deepseek-ai/cordis-plugin-hmr', enabled: true, fiberPhase: 'active' },
  ], undefined, { probeRuntime: false })
  assert.equal(report.findings.some((finding) => finding.id === 'runtime:duplicate-loader-entries'), false)
})
