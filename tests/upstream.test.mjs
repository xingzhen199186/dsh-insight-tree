import test from 'node:test'
import assert from 'node:assert/strict'
import { buildVerdict, declaredDshRanges, hostOkFor, isOfficialPlugin, isPluginRelatedFailure, parsePackumentVersions, parseRepository, selectCandidate, versionNeedsConfirmation } from '../lib/index.js'

test('isPluginRelatedFailure：只为插件启动阻塞自动打开独立诊断', () => {
  const coreOnly = { plugins: [{ id: '@deepseek-ai/dsh-base', source: 'core', findings: [] }] }
  const healthyPlugin = { plugins: [{ id: 'demo-plugin', source: 'bundle', findings: [] }] }
  const blockedPlugin = { plugins: [{ id: 'demo-plugin', source: 'bundle', findings: [{ severity: 'blocking', impact: 'startup' }] }] }
  assert.equal(isPluginRelatedFailure(coreOnly, '核心模块启动失败'), false)
  assert.equal(isPluginRelatedFailure(healthyPlugin, 'dsh web failed'), false)
  assert.equal(isPluginRelatedFailure(healthyPlugin, 'failed to load demo-plugin'), true)
  assert.equal(isPluginRelatedFailure(blockedPlugin, 'dsh web failed'), true)
})

test('parseRepository 支持常见 repository 写法并归一化为 owner/repo', () => {
  assert.equal(parseRepository('https://github.com/xingzhen199186/dsh-advisor-group'), 'xingzhen199186/dsh-advisor-group')
  assert.equal(parseRepository('git+https://github.com/xingzhen199186/dsh-advisor-group.git'), 'xingzhen199186/dsh-advisor-group')
  assert.equal(parseRepository('git@github.com:xingzhen199186/dsh-advisor-group.git'), 'xingzhen199186/dsh-advisor-group')
  assert.equal(parseRepository({ type: 'git', url: 'https://github.com/o/r.git' }), 'o/r')
  assert.equal(parseRepository('https://gitlab.com/o/r'), null)
  assert.equal(parseRepository(undefined), null)
})

test('declaredDshRanges 聚合 dependencies/peerDependencies 与 engines.dsh', () => {
  const ranges = declaredDshRanges({
    peerDependencies: { '@deepseek-ai/dsh': '>=0.1.2-rc.1 <0.2.0' },
    engines: { node: '^22', dsh: '0.1.2-rc.1' },
  })
  assert.deepEqual(ranges.map(({ key }) => key).sort(), ['@deepseek-ai/dsh', 'engines.dsh'])
})

test('hostOkFor：适配 / 不适配 / 未声明三种判定', () => {
  assert.equal(hostOkFor('0.1.2-rc.1', { peerDependencies: { '@deepseek-ai/dsh': '>=0.1.0 <0.2.0' } }), true)
  assert.equal(hostOkFor('0.1.2-rc.1', { peerDependencies: { '@deepseek-ai/dsh': '>=0.2.0' } }), false)
  assert.equal(hostOkFor('0.1.2-rc.1', { peerDependencies: { react: '^18' } }), null)
  assert.equal(hostOkFor('0.1.2-rc.1', { engines: { dsh: '0.2.0' } }), false)
  assert.equal(hostOkFor('0.1.2-rc.1', { dependencies: { '@deepseek-ai/dsh-credentials': '0.1.0-rc.8' } }), null)
  assert.equal(hostOkFor('0.1.2-rc.1', { dependencies: { '@deepseek-ai/dsh-credentials': '0.1.0-rc.8' } }, { '@deepseek-ai/dsh-credentials': '0.1.0-rc.8' }), true)
  assert.equal(hostOkFor('0.1.2-rc.1', { dependencies: { '@deepseek-ai/dsh-credentials': '0.1.0-rc.8' } }, { '@deepseek-ai/dsh-credentials': '0.1.0-rc.7' }), false)
})

test('parsePackumentVersions 排序、latest 标记与未知版本忽略', () => {
  const { rows, distTags } = parsePackumentVersions({
    versions: {
      '1.0.0': { peerDependencies: {} },
      '1.2.0': { peerDependencies: {} },
      '1.1.0-beta.1': { peerDependencies: {} },
      'not-a-version': {},
    },
    time: { '1.2.0': '2026-01-02T00:00:00Z' },
    'dist-tags': { latest: '1.2.0' },
  })
  assert.deepEqual(rows.map((row) => row.version), ['1.2.0', '1.1.0-beta.1', '1.0.0'])
  assert.equal(rows[0].isLatest, true)
  assert.equal(rows[1].isLatest, false)
  assert.deepEqual(distTags, { latest: '1.2.0' })
})

test('selectCandidate：优先兼容版，其次未知，全不兼容则 null', () => {
  const host = '0.1.2-rc.1'
  const rows = parsePackumentVersions({
    versions: { '0.9.0': {}, '1.0.0': { peerDependencies: { '@deepseek-ai/dsh': '>=0.2.0' } }, '0.8.0': { peerDependencies: { '@deepseek-ai/dsh': '>=0.1.0' } } },
    'dist-tags': { latest: '1.0.0' },
  }).rows
  const first = selectCandidate(rows, host)
  assert.equal(first.latestCompatible, '0.8.0')
  assert.equal(first.latestHostOk, true)
  const unknownRows = parsePackumentVersions({ versions: { '1.0.0': {} } }).rows
  const unknown = selectCandidate(unknownRows, host)
  assert.equal(unknown.latestCompatible, '1.0.0')
  assert.equal(unknown.latestHostOk, null)
  const badRows = parsePackumentVersions({ versions: { '1.0.0': { peerDependencies: { '@deepseek-ai/dsh': '>=0.2.0' } } } }).rows
  const none = selectCandidate(badRows, host)
  assert.equal(none.latestCompatible, null)
  assert.equal(none.latestHostOk, false)
})

test('buildVerdict：npm 来源经 catalog 映射、适配与可更新判定', () => {
  const verdict = buildVerdict({
    id: 'dsh-advisor-group',
    name: 'dsh-advisor-group',
    version: '0.0.1',
    hostVersion: '0.1.2-rc.1',
    resource: {
      catalog: {
        state: 'ok',
        count: 1,
        byNpm: new Map([['dsh-advisor-group', { name: 'dsh-advisor-group', npm: 'dsh-advisor-group', url: 'https://github.com/xingzhen199186/dsh-advisor-group', stars: 12, description: { zh: '顾问群' }, install: 'dsh plugin --profile web add dsh-advisor-group' }]]),
        byRepo: new Map(),
      },
      packument: {
        rows: parsePackumentVersions({
          versions: {
            '0.0.1': { peerDependencies: { '@deepseek-ai/dsh': '>=0.1.0 <0.2.0' } },
            '0.0.2': { peerDependencies: { '@deepseek-ai/dsh': '>=0.1.2-rc.1 <0.2.0' } },
          },
          time: { '0.0.2': '2026-09-07T00:00:00Z' },
          'dist-tags': { latest: '0.0.2' },
        }).rows,
        distTags: { latest: '0.0.2' },
      },
    },
  })
  assert.equal(verdict.sourceKind, 'npm')
  assert.equal(verdict.repo, 'xingzhen199186/dsh-advisor-group')
  assert.equal(verdict.latest, '0.0.2')
  assert.equal(verdict.latestCompatible, '0.0.2')
  assert.equal(verdict.updateAvailable, true)
  assert.equal(verdict.versions.find((item) => item.version === '0.0.2').hostOk, true)
  assert.equal(verdict.stars, 12)
})

test('buildVerdict：仅 GitHub 源 / 官方内置 / 仅本地', () => {
  const github = buildVerdict({ id: 'private-plugin', name: 'private-plugin', version: '0.1.0', hostVersion: '0.1.2-rc.1', repository: 'github:me/private-plugin', resource: { catalog: { state: 'ok', count: 0, byNpm: new Map(), byRepo: new Map() }, packument: null } })
  assert.equal(github.sourceKind, 'github')
  assert.equal(github.repo, 'me/private-plugin')
  const official = buildVerdict({ id: '@deepseek-ai/dsh-web-app', name: 'dsh-web-app', version: '0.1.2-rc.1', hostVersion: '0.1.2-rc.1', resource: { catalog: { state: 'ok', count: 0, byNpm: new Map(), byRepo: new Map() }, packument: null } })
  assert.equal(official.sourceKind, 'official')
  assert.equal(isOfficialPlugin('@deepseek-ai/dsh-tools'), true)
  const local = buildVerdict({ id: 'dsh-insight-tree', name: 'dsh-insight-tree', version: '0.1.0', hostVersion: '0.1.2-rc.1', resource: { catalog: { state: 'ok', count: 0, byNpm: new Map(), byRepo: new Map() }, packument: null } })
  assert.equal(local.sourceKind, 'local')
})

test('buildVerdict：Registry 兜底探测到包时标记 npm 来源', () => {
  const verdict = buildVerdict({
    id: 'dsh-advisor-group',
    name: 'dsh-advisor-group',
    version: '0.0.1',
    hostVersion: '0.1.2-rc.1',
    npmName: 'dsh-advisor-group',
    repository: 'github:xingzhen199186/dsh-advisor-group',
    resource: {
      catalog: { state: 'ok', count: 0, byNpm: new Map(), byRepo: new Map() },
      packument: { rows: parsePackumentVersions({ versions: { '0.1.0': {} }, 'dist-tags': { latest: '0.1.0' } }).rows, distTags: { latest: '0.1.0' } },
    },
  })
  assert.equal(verdict.sourceKind, 'npm')
  assert.equal(verdict.npmName, 'dsh-advisor-group')
})

test('buildVerdict：配套 DSH 包版本按 Profile 实际版本核验，不与本体版本混比', () => {
  const verdict = buildVerdict({
    id: 'dsh-cost-meter',
    name: 'dsh-cost-meter',
    version: '1.7.10',
    hostVersion: '0.1.2-rc.1',
    installedDshVersions: {
      '@deepseek-ai/dsh-credentials': '0.1.0-rc.8',
      '@deepseek-ai/dsh-home-paths': '0.1.0-rc.8',
    },
    resource: {
      catalog: { state: 'ok', count: 0, byNpm: new Map(), byRepo: new Map() },
      packument: {
        rows: parsePackumentVersions({
          versions: {
            '1.7.10': { dependencies: { '@deepseek-ai/dsh-credentials': '0.1.0-rc.8', '@deepseek-ai/dsh-home-paths': '0.1.0-rc.8' } },
          },
          'dist-tags': { latest: '1.7.10' },
        }).rows,
        distTags: { latest: '1.7.10' },
      },
    },
  })
  assert.equal(verdict.hostAligned, true)
  assert.equal(verdict.versions[0].hostOk, true)
  assert.equal(verdict.latestCompatible, '1.7.10')
})

test('versionNeedsConfirmation：不兼容或未核验且偏离兼容候选时要求确认', () => {
  assert.equal(versionNeedsConfirmation({ version: '0.3.17', hostOk: false }, '0.1.12'), true)
  assert.equal(versionNeedsConfirmation({ version: '0.3.17', hostOk: null }, '0.1.12'), true)
  assert.equal(versionNeedsConfirmation({ version: '0.1.12', hostOk: null }, '0.1.12'), false)
  assert.equal(versionNeedsConfirmation({ version: '0.1.12', hostOk: true }, '0.1.12'), false)
})
