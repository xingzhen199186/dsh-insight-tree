import test from 'node:test'
import assert from 'node:assert/strict'
import { createInsightTreeRoute, removePatchEntries, updatePatchEntries } from '../lib/index.js'

const report = {
  schemaVersion: 3,
  generatedAt: '2026-09-06T00:00:00.000Z',
  dshVersion: '0.1.2-rc.1',
  versionSource: 'installed',
  profile: 'web',
  patch: { entries: 0, reload: 'live' },
  usage: { sessionEvents: 0, toolCalls: 0 },
  ruleVersion: 1,
  runtime: { dumpConfig: 'ok', activatedEntries: 1 },
  status: 'ready',
  summary: { total: 1, active: 1, attention: 0, blocked: 0 },
  plugins: [],
  findings: [],
  recommendedActions: [],
}

function createResponseRecorder() {
  let status = 0
  const headers = {}
  let body = ''
  return {
    res: { writeHead: (s, h) => { status = s; Object.assign(headers, h) }, end: (b) => { body = b } },
    get: () => ({ status, headers, body }),
  }
}

async function call(route, method, path, extraHeaders = {}) {
  const recorder = createResponseRecorder()
  const req = { method, headers: { host: '127.0.0.1', ...extraHeaders }, url: path }
  await route.handler(req, recorder.res)
  return recorder.get()
}

test('bootstrap 返回令牌，受保护路由要求令牌', async () => {
  const route = createInsightTreeRoute(() => report, 'web', { token: 'abc' })
  const boot = await call(route, 'GET', '/dsh-insight-tree/bootstrap')
  assert.equal(boot.status, 200)
  assert.equal(JSON.parse(boot.body).token, 'abc')
  const denied = await call(route, 'GET', '/dsh-insight-tree')
  assert.equal(denied.status, 401)
  const ok = await call(route, 'GET', '/dsh-insight-tree', { 'x-dsh-insight-tree-token': 'abc' })
  assert.equal(ok.status, 200)
  assert.equal(JSON.parse(ok.body).schemaVersion, 3)
})

test('export 与 compare 端点行为正确', async () => {
  const route = createInsightTreeRoute(() => report, 'web', { token: 'abc', getCompare: () => [{ profile: 'web', report }] })
  const md = await call(route, 'GET', '/dsh-insight-tree/export?format=md', { 'x-dsh-insight-tree-token': 'abc' })
  assert.equal(md.status, 200)
  assert.match(md.headers['content-type'], /text\/markdown/u)
  assert.match(md.body, /# DSH Insight Tree 报告/u)
  const compare = await call(route, 'GET', '/dsh-insight-tree/compare', { 'x-dsh-insight-tree-token': 'abc' })
  assert.equal(compare.status, 200)
  assert.equal(JSON.parse(compare.body).profiles.length, 1)
})

test('历史会话端点使用异步回放报告', async () => {
  const historical = { ...report, sessionId: 'old-session', usage: { sessionEvents: 4, toolCalls: 1 } }
  const route = createInsightTreeRoute(() => report, 'web', { getSessionReport: async (id) => ({ ...historical, sessionId: id }) })
  const result = await call(route, 'GET', '/dsh-insight-tree/session/old-session')
  assert.equal(result.status, 200)
  assert.equal(JSON.parse(result.body).sessionId, 'old-session')
  assert.equal(JSON.parse(result.body).usage.toolCalls, 1)
})

test('非本机与非法方法被拒绝', async () => {
  const route = createInsightTreeRoute(() => report, 'web', {})
  const foreign = await call(route, 'GET', '/dsh-insight-tree', { host: 'evil.example' })
  assert.equal(foreign.status, 403)
})

test('卸载被依赖插件时直接阻止操作', async () => {
  const dependentReport = { ...report, plugins: [{ id: 'demo', dependents: ['consumer'] }] }
  const route = createInsightTreeRoute(() => dependentReport, 'web', {})
  const result = await call(route, 'POST', '/dsh-insight-tree/uninstall?id=demo')
  assert.equal(result.status, 400)
  assert.match(JSON.parse(result.body).message, /仍依赖/u)
})

test('不能从自身页面卸载或关闭诊断插件', async () => {
  const route = createInsightTreeRoute(() => ({ ...report, plugins: [{ id: 'dsh-insight-tree', source: 'user', dependents: [] }] }), 'web', {})
  const uninstall = await call(route, 'POST', '/dsh-insight-tree/uninstall?id=dsh-insight-tree')
  assert.equal(uninstall.status, 400)
  assert.match(JSON.parse(uninstall.body).message, /当前诊断插件/u)
  const disable = await call(route, 'POST', '/dsh-insight-tree/disable?id=dsh-insight-tree')
  assert.equal(disable.status, 400)
  assert.match(JSON.parse(disable.body).message, /自身页面/u)
})

test('patch 更新使用 DSH 的直接 id 语法并覆盖 bundle 插入项', () => {
  const direct = updatePatchEntries([{ id: 'demo', name: 'demo-plugin' }], 'demo', true)
  assert.deepEqual(direct.entries, [{ id: 'demo', name: 'demo-plugin', disabled: true }])
  const inserted = updatePatchEntries([{ insert: [{ id: 'demo', name: 'demo-plugin' }] }], 'demo', false)
  assert.deepEqual(inserted.entries, [{ insert: [{ id: 'demo', name: 'demo-plugin', disabled: false }] }])
  const appended = updatePatchEntries([], 'demo', true)
  assert.deepEqual(appended.entries, [{ id: 'demo', disabled: true }])
})

test('卸载清理直接、replace 和 insert 形式的孤儿 patch 行', () => {
  const result = removePatchEntries([
    { id: 'demo', disabled: true },
    { replace: { id: 'real-demo', disabled: false } },
    { insert: [{ id: 'demo', name: 'demo-plugin' }, { id: 'keep', disabled: true }] },
    { id: 'keep-outer', disabled: true },
  ], ['demo', 'real-demo'])
  assert.equal(result.removed, 3)
  assert.deepEqual(result.entries, [
    { insert: [{ id: 'keep', disabled: true }] },
    { id: 'keep-outer', disabled: true },
  ])
})

test('嵌套 group 配置中的插件行可以更新和清理', () => {
  const nested = [{ group: true, config: [{ id: 'nested-plugin', disabled: false }] }]
  const updated = updatePatchEntries(nested, 'nested-plugin', true)
  assert.equal(updated.matched, true)
  assert.equal(updated.entries[0].config[0].disabled, true)
  const cleaned = removePatchEntries(updated.entries, ['nested-plugin'])
  assert.equal(cleaned.removed, 1)
  assert.deepEqual(cleaned.entries, [{ group: true, config: [] }])
})

test('未知插件和核心插件不能通过 HTTP 操作接口修改', async () => {
  const report = { plugins: [{ id: '@deepseek-ai/dsh-base', source: 'core', name: 'DSH base', status: 'active', role: '', provides: [], dependsOn: [], dependents: [], findings: [], compatibility: { status: 'compatible', label: 'ok' } }] }
  const route = createInsightTreeRoute(() => report, 'web')
  const response = { status: 0, body: '', writeHead(status) { this.status = status }, end(body) { this.body = body } }
  await route.handler({ method: 'POST', headers: { host: '127.0.0.1:3080' }, url: '/dsh-insight-tree/disable?id=missing' }, response)
  assert.equal(response.status, 404)
})
