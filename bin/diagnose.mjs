#!/usr/bin/env node
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import os from 'node:os'
import yaml from 'js-yaml'
import { discoverReport, removePatchEntries, sanitizeReport, renderMarkdownReport, renderPluginCsv, updatePatchEntries } from '../lib/index.js'

const args = process.argv.slice(2)
const profileIndex = args.indexOf('--profile')
const profile = profileIndex >= 0 ? args[profileIndex + 1] || 'web' : 'web'
const portIndex = args.indexOf('--port')
const port = Number(portIndex >= 0 ? args[portIndex + 1] : 3092) || 3092
const tokenIndex = args.indexOf('--token')
const token = tokenIndex >= 0 ? args[tokenIndex + 1] || '' : ''
let mutationLock = false
const securityHeaders = { 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'data:'", 'x-content-type-options': 'nosniff' }
function authOk(req) {
  if (!token) return true
  const given = req.headers['x-dsh-insight-tree-token'] || (new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`).searchParams.get('token') || '')
  return given === token
}
const profileFile = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'profiles', profile, 'cordis.patch.yml')
function dshCommand() {
  const entry = process.argv[1]
  return entry && /[\\/]bin\.(?:js|ts)$/u.test(entry)
    ? { file: process.execPath, args: [...process.execArgv, entry] }
    : { file: process.platform === 'win32' ? 'dsh.cmd' : 'dsh', args: [] }
}
function runDsh(args) {
  const command = dshCommand()
  return spawnSync(command.file, [...command.args, ...args], { encoding: 'utf8', windowsHide: true, shell: process.platform === 'win32', timeout: 20000, maxBuffer: 1024 * 1024 })
}

function runStaticDryRun(overlayFile) {
  const result = runDsh(['--profile', profile, '--patch', overlayFile, '--dump-config'])
  const details = [result.stderr, result.stdout].filter(Boolean).map((value) => value.trim()).filter(Boolean).join('；').slice(0, 400)
  return { ok: result.status === 0, message: result.status === 0 ? '' : `静态配置检查退出码 ${result.status ?? '未知'}：${details || '没有可用错误摘要'}` }
}

function setPluginDisabled(id, disabled, report) {
  if (!/^[\w@./-]+$/u.test(id) || id.startsWith('@deepseek-ai/') || id === 'dsh-insight-tree') return { ok: false, message: '核心 DSH 包或当前诊断插件不能在独立诊断页中修改。' }
  if (!report.plugins.some((plugin) => plugin.id === id)) return { ok: false, message: '找不到这个插件，配置没有修改。' }
  let entries
  try {
    const parsed = fs.existsSync(profileFile) ? yaml.load(fs.readFileSync(profileFile, 'utf8')) : []
    if (!Array.isArray(parsed)) return { ok: false, message: 'patch 文件不是可编辑的条目列表。' }
    entries = parsed
  } catch (error) { return { ok: false, message: `patch 文件无法解析：${error instanceof Error ? error.message : String(error)}` } }
  const backup = `${profileFile}.bak-insight-tree-${Date.now()}`
  const next = updatePatchEntries(entries, id, disabled).entries
  try {
    const roundTrip = yaml.load(yaml.dump(next, { noRefs: true, lineWidth: -1 }))
    if (!Array.isArray(roundTrip)) return { ok: false, message: '生成的 patch 未通过配置校验，原文件未修改。' }
  } catch (error) {
    return { ok: false, message: `生成的 patch 未通过配置校验：${error instanceof Error ? error.message : String(error)}` }
  }
  const overlay = path.join(os.tmpdir(), `dsh-insight-tree-diagnose-${Date.now()}.yml`)
  let dryRunMessage = ''
  try {
    fs.writeFileSync(overlay, yaml.dump([{ id, disabled }], { noRefs: true, lineWidth: -1 }), 'utf8')
    const dryRun = runStaticDryRun(overlay)
    if (!dryRun.ok) dryRunMessage = ` 静态检查未通过，但仍已保存本次修复配置，原因：${dryRun.message}`
  } catch (error) {
    dryRunMessage = ` 静态检查未完成，但仍已保存本次修复配置，原因：${error instanceof Error ? error.message : String(error)}`
  } finally {
    try { fs.unlinkSync(overlay) } catch { /* already removed */ }
  }
  if (fs.existsSync(profileFile)) fs.copyFileSync(profileFile, backup)
  try {
    fs.mkdirSync(path.dirname(profileFile), { recursive: true })
    fs.writeFileSync(profileFile, yaml.dump(next, { noRefs: true, lineWidth: -1 }), 'utf8')
  } catch (error) {
    try { fs.copyFileSync(backup, profileFile) } catch { /* retain the primary error */ }
    return { ok: false, message: `配置未修改：${error instanceof Error ? error.message : String(error)}`, backup }
  }
  const actionText = disabled ? '暂时关闭' : '重新启用'
  return { ok: true, message: `已${actionText} ${id}，配置已保存。当前没有运行中的 DSH 可立即切换，启动后会按新配置加载。${dryRunMessage}`, backup, restartRequired: true, rollbackCommand: `dsh plugin --profile ${profile} add ${id}` }
}

function cleanPatchRows(file, ids) {
  if (!fs.existsSync(file)) return { removed: 0 }
  const parsed = yaml.load(fs.readFileSync(file, 'utf8'))
  if (!Array.isArray(parsed)) return { removed: 0, error: 'patch 文件不是顶层数组，未自动清理。' }
  const cleaned = removePatchEntries(parsed, ids)
  if (cleaned.removed > 0) fs.writeFileSync(file, yaml.dump(cleaned.entries, { noRefs: true, lineWidth: -1 }), 'utf8')
  return { removed: cleaned.removed }
}

function uninstallPlugin(id, report) {
  if (!/^[\w@./-]+$/u.test(id) || id.startsWith('@deepseek-ai/') || id === 'dsh-insight-tree') return { ok: false, message: '核心 DSH 包或当前诊断插件不能在独立诊断页中卸载。' }
  const target = report.plugins.find((plugin) => plugin.id === id)
  if (!target) return { ok: false, message: '找不到这个插件，未执行卸载。' }
  if (target?.dependents?.length) return { ok: false, message: `不能卸载 ${id}：${target.dependents.join('、')} 仍依赖它。请先处理依赖它的插件。` }
  const profileDir = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'profiles', profile)
  const packageJson = path.join(profileDir, 'package.json')
  const snapshots = []
  if (fs.existsSync(packageJson)) { const backup = `${packageJson}.bak-insight-tree-${Date.now()}`; fs.copyFileSync(packageJson, backup); snapshots.push({ target: packageJson, backup, existed: true }) }
  else snapshots.push({ target: packageJson, backup: '', existed: false })
  if (fs.existsSync(profileFile)) { const backup = `${profileFile}.bak-insight-tree-${Date.now()}`; fs.copyFileSync(profileFile, backup); snapshots.push({ target: profileFile, backup, existed: true }) }
  else snapshots.push({ target: profileFile, backup: '', existed: false })
  const backups = snapshots.filter((item) => item.backup).map((item) => item.backup)
  const result = runDsh(['plugin', '--profile', profile, 'remove', id])
  if (result.status === 0) {
    let patchMessage = ''
    try {
      const cleaned = cleanPatchRows(profileFile, [id])
      patchMessage = cleaned.error ? ` ${cleaned.error}` : cleaned.removed > 0 ? ` 已清理 ${cleaned.removed} 条遗留配置。` : ''
    } catch (error) {
      patchMessage = ` 补丁清理未完成：${error instanceof Error ? error.message : String(error)}`
    }
    return { ok: true, message: `已卸载 ${id}（Profile 依赖已移除）。当前没有运行中的 DSH，启动后会按新配置加载。${patchMessage} 备份：${backups.join('；') || '无'}`, backup: backups[0], rollbackCommand: `dsh plugin --profile ${profile} add ${id}` }
  }
  const details = [result.stderr, result.stdout].filter(Boolean).join('；').trim().slice(0, 400)
  let restored = true
  for (const snapshot of snapshots) {
    try {
      if (snapshot.existed) fs.copyFileSync(snapshot.backup, snapshot.target)
      else if (fs.existsSync(snapshot.target)) fs.unlinkSync(snapshot.target)
    } catch { restored = false }
  }
  return { ok: false, message: `卸载失败（exit ${result.status ?? '未知'}${result.error ? `，${result.error.message}` : ''}）：${details || '没有可用错误摘要'}。${restored ? '已自动恢复卸载前配置。' : '自动恢复未完全成功，请使用备份手动恢复。'}（备份：${backups.join('；') || '无'}）`, backup: backups[0], rollbackCommand: `dsh plugin --profile ${profile} add ${id}` }
}

function interactivePage(report) {
  const safe = JSON.stringify(report).replace(/</gu, '\\u003c')
  const STATUS_LABEL = { active: '已正常加载', warning: '存在风险', degraded: '功能受限', blocked: '阻塞启动', disabled: '暂时关闭' }
  const IMPACT_LABEL = { none: '不影响使用', plugin: '仅影响当前插件', capability: '影响一项能力', profile: '影响当前 Profile', startup: '阻塞 DSH 启动' }
  const esc = (value) => String(value).replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/"/gu, '&quot;')
  const rows = report.plugins.map((p) => {
    const protectedPlugin = p.id.startsWith('@deepseek-ai/') || p.id === 'dsh-insight-tree'
    const actions = protectedPlugin ? '' : (p.status === 'disabled' || p.enabled === false)
      ? `<button class="row-act" data-action="enable" data-id="${esc(p.id)}">重新启用</button>`
      : `<button class="row-act" data-action="disable" data-id="${esc(p.id)}">暂时关闭</button>`
    const uninstall = protectedPlugin ? '' : `<button class="row-act danger" data-action="uninstall" data-id="${esc(p.id)}">卸载插件</button>`
    return `<article class="row" data-id="${esc(p.id)}"><div><span class="dot ${p.status === 'blocked' ? 'bad' : p.status === 'active' ? '' : 'warn'}"></span><span class="caret">▸</span><b>${esc(p.name)}</b><span class="meta">　${p.version || '版本未知'} · ${p.compatibility?.label || '兼容性待确认'}</span></div><div class="role">${esc(p.role || '当前 Profile 插件')}</div>${p.description ? `<div class="role">说明：${esc(p.description)}</div>` : ''}<div class="role">状态：${STATUS_LABEL[p.status] ?? p.status} · 具体能力：${(p.provides || []).join('、') || '暂无能力信息'}</div>${(p.dependsOn || []).length ? `<div class="role">依赖：${p.dependsOn.join('、')}</div>` : ''}${(p.findings || []).map((f) => `<div class="finding ${f.severity === 'info' ? 'info' : ''}"><b>${esc(f.title)}</b><br>${esc(f.message)}${f.impact ? `<br>影响：${IMPACT_LABEL[f.impact] || f.impact}` : ''}${f.recommendation ? `<br>建议：${esc(f.recommendation)}` : ''}${f.evidence ? `<br><span class="code">依据：${esc(f.evidence)}</span>` : ''}</div>`).join('')}<div class="detail" hidden><div class="role">标识：${esc(p.id)}</div>${p.packagePath ? `<div class="role">包路径：${esc(p.packagePath)}</div>` : ''}${p.compatibility?.requirement ? `<div class="role">适配范围：${esc(p.compatibility.requirement)}</div>` : ''}${p.compatibility?.evidence ? `<div class="role">适配说明：${esc(p.compatibility.evidence)}</div>` : ''}${(p.dependents?.length ?? 0) > 0 ? `<div class="role">被依赖：${p.dependents.join('、')}` + `</div>` : '<div class="role">被依赖：无</div>'}</div><div class="row-actions">${actions}${uninstall}</div><div class="row-msg" role="status" aria-live="polite"></div></article>`
  }).join('')
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>DSH 启动诊断</title><style>body{margin:0;background:#f6f8fa;color:#17212b;font:14px system-ui,sans-serif}main{max-width:920px;margin:48px auto;padding:0 24px}header{display:flex;justify-content:space-between;align-items:end;border-bottom:1px solid #dfe5eb;padding-bottom:20px}h1{font-size:28px;margin:8px 0}.meta{color:#71808f}.actions{display:flex;gap:8px;margin:18px 0}.actions button{border:1px solid #dfe5eb;background:#fff;padding:8px 12px;border-radius:5px;cursor:pointer}.actions button:disabled{opacity:.55;cursor:wait}.row{cursor:pointer}.row:hover{background:#fafbfc}.row.selected,.row.expanded{background:#f0f5ff}.caret{display:inline-block;width:14px;color:#71808f}.detail{margin:8px 0 0 17px;background:#fff;border:1px solid #edf0f3;border-radius:5px;padding:8px 10px}.row-actions{display:flex;gap:8px;margin:10px 0 0 17px;flex-wrap:wrap}.row-act{border:1px solid #dfe5eb;background:#fff;padding:5px 10px;border-radius:5px;font-size:12px;cursor:pointer}.row-act:hover{background:#f6f8fa}.row-act.danger{border-color:#efc6c6;color:#a33535}.row-msg{margin:6px 0 0 17px;font-size:12px}.summary{display:flex;background:#fff;border:1px solid #dfe5eb;margin:24px 0}.summary div{flex:1;padding:18px;border-right:1px solid #dfe5eb}.summary div:last-child{border:0}.num{font-size:24px;font-weight:650}.tree{background:#fff;border:1px solid #dfe5eb;border-radius:6px;overflow:hidden}.row{padding:15px 18px;border-bottom:1px solid #edf0f3}.row:last-child{border:0}.dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:#14804a;margin-right:9px}.dot.warn{background:#a66b00}.dot.bad{background:#b33535}.role{margin:5px 0 0 17px;color:#71808f;font-size:12px}.finding{margin:10px 0;padding:12px;background:#fff6df;border:1px solid #efd28e;border-radius:5px;color:#815800}.finding.info{background:#f6f8fa;border-color:#e5e9ed;color:#71808f}.code{font-family:ui-monospace,monospace;font-size:12px;color:#71808f}</style><main><header><div><div class="meta">DSH 启动诊断</div><h1>为什么 DSH 没有启动？</h1><div class="meta">DSH 本体 @deepseek-ai/dsh@${report.dshVersion} · Profile ${report.profile} · 配置条目 ${report.patch.entries}</div><div class="meta">${report.runtime.dumpConfig === 'ok' ? '配置可以读取，问题可能来自插件组合或运行阶段。' : '配置读取失败，下面列出最可能的阻塞原因。'}</div></div><div class="code">独立诊断模式 · 当前无运行实例</div></header><div class="actions"><button id="copy">复制诊断报告</button><button id="reload">重新检查</button><span id="message" class="meta"></span></div><section class="summary"><div><div class="num">${report.summary.total}</div><div class="meta">插件条目</div></div><div><div class="num">${report.summary.active}</div><div class="meta">可用</div></div><div><div class="num">${report.summary.attention}</div><div class="meta">需关注</div></div><div><div class="num">${report.summary.blocked}</div><div class="meta">阻塞启动</div></div></section><section class="tree">${rows}</section></main><script>const report=${safe};const msg=document.getElementById('message');document.getElementById('copy').onclick=async()=>{await navigator.clipboard.writeText(JSON.stringify(report,null,2));msg.textContent='已复制诊断报告'};document.getElementById('reload').onclick=()=>location.reload()</script></html>`
}

const server = http.createServer((req, res) => {
  const requestUrl = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`)
  const baseWriteHead = res.writeHead.bind(res)
  res.writeHead = (status, headers) => baseWriteHead(status, { ...securityHeaders, ...headers })
  if (!authOk(req)) {
    res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ error: '缺少或错误的访问令牌' }))
    return
  }
  const report = discoverReport(profile, undefined, {}, [], undefined, { probeRuntime: false })
  if (req.method === 'POST' && requestUrl.pathname === '/disable') {
    if (mutationLock) { res.writeHead(409, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: false, message: '另一个配置操作正在进行，请稍后重试。' })); return }
    mutationLock = true
    let result
    try { result = setPluginDisabled(requestUrl.searchParams.get('id') || '', true, report) } finally { mutationLock = false }
    res.writeHead(result.ok ? 200 : 400, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(result))
    return
  }
  if (req.method === 'POST' && requestUrl.pathname === '/enable') {
    if (mutationLock) { res.writeHead(409, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: false, message: '另一个配置操作正在进行，请稍后重试。' })); return }
    mutationLock = true
    let result
    try { result = setPluginDisabled(requestUrl.searchParams.get('id') || '', false, report) } finally { mutationLock = false }
    res.writeHead(result.ok ? 200 : 400, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(result))
    return
  }
  if (req.method === 'POST' && requestUrl.pathname === '/uninstall') {
    if (mutationLock) { res.writeHead(409, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: false, message: '另一个配置操作正在进行，请稍后重试。' })); return }
    mutationLock = true
    let result
    try { result = uninstallPlugin(requestUrl.searchParams.get('id') || '', report) } finally { mutationLock = false }
    res.writeHead(result.ok ? 200 : 400, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(result))
    return
  }
  if (req.method === 'POST' && requestUrl.pathname === '/recheck') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(discoverReport(profile, undefined, {}, [], undefined, { probeRuntime: false })))
    return
  }
  if (req.method === 'GET' && requestUrl.pathname === '/copy') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(sanitizeReport(report)))
    return
  }
  if (req.method === 'GET' && requestUrl.pathname === '/report') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(report))
    return
  }
  if (req.method === 'GET' && requestUrl.pathname === '/export') {
    const safe = sanitizeReport(report)
    const format = requestUrl.searchParams.get('format') || 'json'
    if (format === 'md') {
      res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8', 'cache-control': 'no-store', 'content-disposition': 'attachment; filename="dsh-insight-tree-report.md"' })
      res.end(renderMarkdownReport(safe))
      return
    }
    if (format === 'csv') {
      res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'cache-control': 'no-store', 'content-disposition': 'attachment; filename="dsh-insight-tree-report.csv"' })
      res.end(renderPluginCsv(safe))
      return
    }
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-disposition': 'attachment; filename="dsh-insight-tree-report.json"' })
    res.end(JSON.stringify(safe))
    return
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  const html = interactivePage(report)
    .replace('配置可以读取，问题可能来自插件组合或运行阶段。', report.runtime.probe === 'skipped' ? '已跳过完整 DSH 加载，仅依据 Profile、patch 和安装包元数据诊断。' : '配置可以读取，问题可能来自插件组合或运行阶段。')
    .replace('<button id="reload">重新检查</button>', '<button id="reload">重新检查</button><button id="export-json">下载 JSON</button><button id="export-md">下载 Markdown</button>')
  .replace("document.getElementById('reload').onclick=()=>location.reload()", `const tk=${JSON.stringify(token)};const headers=tk?{'x-dsh-insight-tree-token':tk}:{};const saved=sessionStorage.getItem('dshit-msg');const msgEl=document.getElementById('message');if(saved){msgEl.textContent=saved;sessionStorage.removeItem('dshit-msg')}document.getElementById('copy').onclick=async()=>{const text=JSON.stringify(report,null,2);try{await navigator.clipboard.writeText(text)}catch{const area=document.createElement('textarea');area.value=text;document.body.append(area);area.select();document.execCommand('copy');area.remove()}msgEl.textContent='已复制诊断报告'};document.getElementById('reload').onclick=async()=>{msgEl.textContent='正在重新检查…';try{const response=await fetch('/recheck',{method:'POST',headers});if(response.ok){location.reload()}else{msgEl.textContent='重新检查失败，请稍后再试'}}catch{msgEl.textContent='重新检查失败，请稍后再试'}};document.querySelectorAll('.row').forEach((row)=>{row.addEventListener('click',(event)=>{if(event.target.closest('.row-act'))return;const expanded=row.classList.toggle('expanded');const detail=row.querySelector('.detail');if(detail)detail.hidden=!expanded;const caret=row.querySelector('.caret');if(caret)caret.textContent=expanded?'▾':'▸'})});document.querySelectorAll('.row-act').forEach((btn)=>{btn.addEventListener('click',async(event)=>{event.stopPropagation();const action=btn.dataset.action,id=btn.dataset.id;const label={disable:'暂时关闭',enable:'重新启用',uninstall:'卸载'}[action];const target=report.plugins.find((plugin)=>plugin.id===id)||{};const capabilities=(target.provides||[]).join('、')||'暂无能力信息';const dependents=(target.dependents||[]).join('、')||'没有插件依赖它';const warn=action==='uninstall'?'已备份配置，仍请谨慎。':'';if(!confirm('确认'+label+'插件 '+id+'？\\n提供能力：'+capabilities+'\\n影响依赖：'+dependents+'\\n'+warn+' 当前没有运行中的 DSH，配置保存后需要重新启动 DSH 才能验证。'))return;btn.disabled=true;try{const response=await fetch('/'+action+'?id='+encodeURIComponent(id),{method:'POST',headers});const result=await response.json();const text=(result.message||'操作完成')+(result.rollbackCommand?'　回滚：'+result.rollbackCommand:'');const rowMsg=btn.closest('.row').querySelector('.row-msg');rowMsg.textContent=text;rowMsg.style.color=result.ok?'#14804a':'#b33535';sessionStorage.setItem('dshit-msg',text);setTimeout(()=>location.reload(),1600)}catch{btn.closest('.row').querySelector('.row-msg').textContent='操作失败，请稍后重试'}})});const exportUrl=(format)=>'/export?format='+format+(tk?'&token='+encodeURIComponent(tk):'');document.getElementById('export-json').onclick=()=>location.href=exportUrl('json');document.getElementById('export-md').onclick=()=>location.href=exportUrl('md')`)
  res.end(html)
})
server.on('error', (error) => {
  console.error(`无法启动独立诊断页面（端口 ${port}）：${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
server.listen(port, '127.0.0.1', () => {
  const query = new URLSearchParams({ profile })
  if (token) query.set('token', token)
  console.log(`DSH Insight Tree 诊断页面：http://127.0.0.1:${port}/?${query.toString()}`)
})
