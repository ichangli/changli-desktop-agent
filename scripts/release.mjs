import { createHash } from 'node:crypto'
import { createReadStream, readFileSync, appendFileSync } from 'node:fs'
import { readdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const root = resolve(import.meta.dirname, '..')

export function validateVersionTag(tag, version) {
  if (typeof tag !== 'string' || !/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/.test(tag))
    throw new Error('版本标签须为 vX.Y.Z 或 vX.Y.Z-beta.1 等形式。')
  if (tag.slice(1) !== version) throw new Error('版本标签与 package.json 的 version 不一致。')
  return { tag, prerelease: version === '0.1.0' || version.includes('-') }
}

export async function writeManifest(directory = join(root, 'release')) {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = entries.filter(entry => entry.isFile() && /\.(exe|zip)$/i.test(entry.name)).map(entry => entry.name).sort()
  if (!files.some(name => /\.exe$/i.test(name)) || !files.some(name => /\.zip$/i.test(name)))
    throw new Error('发布目录须同时包含 Windows .exe 与 .zip 文件。')
  if (files.some(name => !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name)))
    throw new Error('发布文件名须使用 ASCII 字母、数字、点、连字符或下划线。')
  const lines = []
  for (const file of files) {
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(join(directory, file))) hash.update(chunk)
    lines.push(`${hash.digest('hex')}  ${file}`)
  }
  await writeFile(join(directory, 'SHA256SUMS.txt'), lines.join('\n') + '\n', 'utf8')
  return files
}

async function main() {
  const command = process.argv[2]
  if (command === 'validate') {
    const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    const result = validateVersionTag(process.env.RELEASE_TAG || process.argv[3], version)
    const git = args => {
      const child = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true })
      if (child.status !== 0) throw new Error('无法确认本地版本标签，请先推送该标签。')
      return child.stdout.trim()
    }
    if (git(['rev-parse', `refs/tags/${result.tag}^{commit}`]) !== git(['rev-parse', 'HEAD']))
      throw new Error('检出的提交与版本标签不一致。')
    if (process.env.GITHUB_OUTPUT)
      appendFileSync(process.env.GITHUB_OUTPUT, `tag=${result.tag}\nprerelease=${result.prerelease}\n`, 'utf8')
    console.log(`版本校验通过：${result.tag}，${result.prerelease ? '预发布' : '正式发布'}。`)
  } else if (command === 'manifest') {
    const files = await writeManifest()
    console.log(`已为 ${files.length} 个发布文件生成 release/SHA256SUMS.txt。`)
  } else throw new Error('用法：node scripts/release.mjs validate [vX.Y.Z] 或 manifest。')
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch(error => { console.error(error.message); process.exitCode = 1 })
