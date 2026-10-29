import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { resolve, join } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const listed = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8', windowsHide: true })
if (listed.status !== 0) throw new Error('无法检查公开文件清单。')
const files = [...new Set(listed.stdout.split('\0').filter(Boolean))]
const findings = []
for (const file of files) {
  if (/^(?:node_modules|out|dist|release|runtime|test-results)\//.test(file) || /\.(?:sqlite(?:-[a-z]+)?|db(?:-[a-z]+)?|log)$/i.test(file) || /(?:^|\/)\.env(?:\.|$)/.test(file) && file !== '.env.example') {
    findings.push(`${file}：运行数据或构建目录不应公开`); continue
  }
  const bytes = readFileSync(join(root, file))
  if (bytes.includes(0)) continue
  const source = bytes.toString('utf8')
  if (/(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|sk-[A-Za-z0-9_-]{24,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/.test(source)) findings.push(`${file}：疑似凭据，需人工检查`)
  if (/[A-Z]:[\\/]Users[\\/][^\s'"`<>]+/i.test(source)) findings.push(`${file}：含本机用户目录，需改为通用示例`)
}
if (findings.length) { console.error(findings.join('\n')); process.exitCode = 1 }
else console.log(`公开文件检查通过：${files.length} 个候选文件，无运行数据目录或常见凭据标记。`)
