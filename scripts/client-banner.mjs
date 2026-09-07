import fs from 'node:fs'

const src = 'lib/client.cjs'
const out = 'lib/client.js'
if (!fs.existsSync(src)) throw new Error('lib/client.cjs 不存在，请先构建 client')
const raw = fs.readFileSync(src, 'utf8')
const preamble = '    var module = { exports: {} };\n    var exports = module.exports;\n'
const body = raw.split('\n').map((line) => `    ${line}`).join('\n')
const wrapped = `window.__ModuleLoader__.load({\n  id: "dsh-insight-tree",\n  factory: (require) => {\n${preamble}${body}\n    return module.exports;\n  }\n});\n`
fs.writeFileSync(out, wrapped)
