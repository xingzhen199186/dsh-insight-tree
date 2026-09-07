import test from 'node:test'
import assert from 'node:assert/strict'
import { STRUCTURAL_ENTRY_ID_PREFIXES, isStructuralLoaderEntry, loaderEntryBelongsToPlugin, snapshotLoaderEntries } from '../lib/index.js'

test('结构行判定覆盖 group / include / isolate / 容器子树信号', () => {
  assert.equal(isStructuralLoaderEntry({ id: 'n', options: { name: 'demo', group: false } }), false)
  assert.equal(isStructuralLoaderEntry({ id: 'g', options: { name: 'group', group: true } }), true)
  assert.equal(isStructuralLoaderEntry({ id: 'include:demo', options: { name: 'cordis:include' } }), true)
  assert.equal(isStructuralLoaderEntry({ id: 'group:x', options: { name: 'cordis:group', group: false } }), true)
  assert.equal(isStructuralLoaderEntry({ id: 'isolate:x', options: { name: 'cordis:isolate' } }), true)
  assert.equal(isStructuralLoaderEntry({ id: 'include:demo:plugin', options: { name: 'demo' } }), false)
  assert.equal(isStructuralLoaderEntry({ id: 'container', options: { name: 'c' }, subtree: {} }), true)
  assert.equal(isStructuralLoaderEntry({ id: 'container2', options: { name: 'c2' }, subgroup: {} }), true)
  assert.ok(STRUCTURAL_ENTRY_ID_PREFIXES.includes('include:'))
})

test('loader 快照只投影真实模块行，跳过全部结构行并映射 fiber 阶段', () => {
  const loader = {
    entries() {
      return [
        { id: 'a', options: { name: '@deepseek-ai/dsh-base', group: false }, disabled: false, fiber: { state: 2 } },
        { id: 'g', options: { name: 'group', group: true }, disabled: false, fiber: { state: 2 } },
        { id: 'include:demo', options: { name: 'cordis:include' }, disabled: false, fiber: { state: 2 } },
        { id: 'group:x', options: { name: 'cordis:group', group: false }, disabled: false, fiber: { state: 0 } },
        { id: 'isolate:y', options: { name: 'cordis:isolate' }, disabled: false, fiber: { state: 0 } },
        { id: 'container', options: { name: 'c' }, subtree: {}, disabled: false, fiber: { state: 0 } },
        { id: 'b', options: { name: 'dsh-demo' }, disabled: true, fiber: { state: 3 } },
        { id: 'c', options: { name: 'dsh-pending' }, disabled: true, fiber: undefined },
      ]
    },
  }
  const entries = snapshotLoaderEntries(loader)
  assert.equal(entries.length, 3)
  assert.equal(entries[0].fiberPhase, 'active')
  assert.equal(entries[1].enabled, false)
  assert.equal(entries[1].fiberPhase, 'failed')
  assert.equal(entries[2].fiberPhase, null)
  assert.ok(entries.every((entry) => !STRUCTURAL_ENTRY_ID_PREFIXES.some((prefix) => entry.entryId.startsWith(prefix))))
})

test('无 loader 时返回空数组', () => {
  assert.deepEqual(snapshotLoaderEntries(undefined), [])
})

test('聚合 bundle 的根入口和子入口归属于同一个插件', () => {
  assert.equal(loaderEntryBelongsToPlugin({ id: 'include:web-ui-compat', options: { name: '@linxin666/dsh-web-all' } }, '@linxin666/dsh-web-all'), true)
  assert.equal(loaderEntryBelongsToPlugin({ id: 'include:web-ui-market', options: { name: '@linxin666/dsh-web-all/market' } }, '@linxin666/dsh-web-all'), true)
  assert.equal(loaderEntryBelongsToPlugin({ id: 'include:mnemon-source-runtime', options: { name: 'dsh-mnemon-source-runtime' } }, 'dsh-mnemon'), true)
  assert.equal(loaderEntryBelongsToPlugin({ id: 'include:other', options: { name: 'dsh-mnemon-archive' } }, 'dsh-mnemon'), true)
  assert.equal(loaderEntryBelongsToPlugin({ id: 'include:remote', options: { name: '@linxin666/dsh-remote-web-ui' } }, '@linxin666/dsh-web-all'), false)
})
