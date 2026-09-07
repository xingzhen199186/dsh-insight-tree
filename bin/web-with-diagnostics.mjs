#!/usr/bin/env node
import net from 'node:net'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { discoverReport, isPluginRelatedFailure } from '../lib/index.js'

const args = process.argv.slice(2)
const profileIndex = args.indexOf('--profile')
const profile = profileIndex >= 0 ? args[profileIndex + 1] || 'web' : 'web'

function findFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address ? address.port : 3092
      probe.close(() => resolve(port))
    })
  })
}

async function openDiagnostics(exitCode) {
  const port = await findFreePort()
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'diagnose.mjs')
  const url = `http://127.0.0.1:${port}/?profile=${encodeURIComponent(profile)}`
  const diagnostic = spawn(process.execPath, [script, '--profile', profile, '--port', String(port)], { detached: true, stdio: 'ignore', windowsHide: true })
  diagnostic.unref()
  const ready = await waitForHttpReady(port, diagnostic)
  if (!ready) {
    console.error(`dsh web 启动失败（exit ${exitCode ?? '未知'}）。独立诊断页面未能在预期时间内启动，请直接运行：node ${script} --profile ${profile} --port ${port}`)
    return
  }
  console.error(`dsh web 启动失败（exit ${exitCode ?? '未知'}）。已启动独立诊断：${url}`)
  if (process.platform === 'win32') {
    const opener = spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true })
    opener.once('error', () => console.error(`无法自动打开浏览器，请复制诊断地址：${url}`))
    opener.unref()
  } else if (process.platform === 'darwin') {
    const opener = spawn('open', [url], { detached: true, stdio: 'ignore' })
    opener.unref()
  } else {
    const opener = spawn('xdg-open', [url], { detached: true, stdio: 'ignore' })
    opener.unref()
  }
}

function shouldOpenDiagnostics(output) {
  try {
    const report = discoverReport(profile, undefined, {}, [], undefined, { probeRuntime: false })
    return isPluginRelatedFailure(report, output)
  } catch {
    return false
  }
}

function waitForHttpReady(port, child, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const started = Date.now()
    let settled = false
    let timer
    const finish = (value) => { if (settled) return; settled = true; if (timer) clearInterval(timer); child.removeListener('exit', onExit); resolve(value) }
    const onExit = () => finish(false)
    child.once('exit', onExit)
    timer = setInterval(() => {
      if (Date.now() - started >= timeoutMs) { finish(false); return }
      const request = http.get(`http://127.0.0.1:${port}/`, (response) => { response.resume(); if (response.statusCode && response.statusCode < 500) finish(true) })
      request.once('error', () => {})
      request.setTimeout(300, () => request.destroy())
    }, 100)
  })
}

const child = spawn('dsh', ['web', ...args], { stdio: ['inherit', 'pipe', 'pipe'], shell: process.platform === 'win32', windowsHide: false })
let output = ''
child.stdout?.on('data', (chunk) => { const text = chunk.toString(); output += text; process.stdout.write(text) })
child.stderr?.on('data', (chunk) => { const text = chunk.toString(); output += text; process.stderr.write(text) })
child.once('error', async (error) => {
  console.error(`无法启动 dsh web：${error.message}`)
  if (shouldOpenDiagnostics(output)) await openDiagnostics(1)
  else console.error(`未检测到插件相关启动阻塞；如需手动诊断，请运行：node ${path.join(path.dirname(fileURLToPath(import.meta.url)), 'diagnose.mjs')} --profile ${profile}`)
  process.exitCode = 1
})
child.once('exit', async (code, signal) => {
  if (code === 0 || signal !== null) {
    process.exitCode = code ?? 1
    return
  }
  if (shouldOpenDiagnostics(output)) await openDiagnostics(code)
  else console.error(`未检测到插件相关启动阻塞；如需手动诊断，请运行：node ${path.join(path.dirname(fileURLToPath(import.meta.url)), 'diagnose.mjs')} --profile ${profile}`)
  process.exitCode = code ?? 1
})
