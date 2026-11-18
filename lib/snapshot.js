/**
 * 快照核心：遍历、复制+哈希、清单、校验、清理。
 *
 * 设计要点（对应 2.0 的坑）：
 *   1. 先写到 `<目标>/.dsh-<stamp>.partial`，全部写完才写 manifest.json 并改名成正名，
 *      中途失败就留着 .partial 且永不进清理名单 —— 半截快照不会再冒充完整快照。
 *   2. manifest 里逐文件记 size+sha256，校验时能指出缺哪个、坏哪个，不是只看目录在不在。
 *   3. 遇到指向源目录之外的链接（link: 安装的插件就是这种 junction）不跳过，
 *      把内容抄进 `_external/<rel>` 并记下原始绝对路径，复原脚本会把它写回原位。
 */
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, realpathSync } from 'node:fs'
import { lstat, mkdir, opendir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'

export const MANIFEST = 'manifest.json'
export const PARTIAL_SUFFIX = '.partial'
export const EXTERNAL_DIR = '_external'
export const SNAPSHOT_RE = /^\.dsh-\d{4}-\d{2}-\d{2}-\d{4}(-\d+)?$/
export const PARTIAL_RE = /^\.dsh-\d{4}-\d{2}-\d{2}-\d{4}(-\d+)?\.partial$/

export function stamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`
}

function toPosix(p) {
  return p.replace(/\\/g, '/')
}

export function isExcluded(prefixes, rel) {
  if (!prefixes || !prefixes.length) return false
  const normalized = toPosix(rel)
  return prefixes.some((p) => normalized === p || normalized.startsWith(p + '/'))
}

/** 判断子路径是否真的在父路径里（防止 realpath 之后跑到别处） */
export function isInside(parent, child) {
  const rel = path.relative(path.resolve(parent), path.resolve(child))
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

function safeName(rel) {
  return toPosix(rel).replace(/[^A-Za-z0-9._@-]+/g, '_').slice(0, 120) || 'external'
}

function samePath(a, b) {
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()
}

/**
 * 目录项是不是重定向点（符号链接，或 NTFS junction —— link: 装插件用的就是 junction）。
 * 坑：Windows 上 Node 18+ 把 junction 的 lstat 报成「普通目录」，readlink 也 EINVAL，
 * 唯一可靠的办法是用原生 realpath 解析一次看落点有没有变。
 */
function redirectTarget(abs, info) {
  if (info.isSymbolicLink()) {
    try {
      return realpathSync.native(abs)
    } catch (err) {
      throw new Error(`链接目标读不到: ${err.message}`)
    }
  }
  if (!info.isDirectory()) return null
  let resolved
  try {
    resolved = realpathSync.native(abs)
  } catch {
    return null
  }
  return samePath(resolved, abs) ? null : resolved
}

/**
 * 深度优先遍历。链接（含 junction）不外抛：指向源目录之外的收进 external 列表。
 * 返回 { entries, externals, errors }
 */
export async function scanTree(root, excludes = []) {
  const entries = []
  const externals = []
  const errors = []

  async function walk(abs, rel) {
    let dir
    try {
      dir = await opendir(abs)
    } catch (err) {
      errors.push({ rel: rel || '.', error: err.message })
      return
    }
    try {
      for await (const dirent of dir) {
        const childRel = rel ? `${rel}/${dirent.name}` : dirent.name
        if (isExcluded(excludes, childRel)) continue
        const childAbs = path.join(abs, dirent.name)
        let info
        try {
          info = await lstat(childAbs)
        } catch (err) {
          errors.push({ rel: childRel, error: err.message })
          continue
        }
        if (info.isSymbolicLink() || info.isDirectory()) {
          let linkTarget = null
          try {
            linkTarget = redirectTarget(childAbs, info)
          } catch (err) {
            errors.push({ rel: childRel, error: err.message })
            continue
          }
          if (linkTarget) {
            if (samePath(linkTarget, root) || isInside(root, linkTarget)) {
              errors.push({ rel: childRel, error: '指向源目录内部的链接，跳过（内容另有副本）' })
              continue
            }
            const name = safeName(childRel)
            externals.push({ rel: childRel, from: linkTarget, to: path.join(EXTERNAL_DIR, name) })
            continue
          }
        }
        if (info.isDirectory()) {
          entries.push({ type: 'dir', rel: childRel })
          await walk(childAbs, childRel)
          continue
        }
        if (info.isFile()) {
          entries.push({ type: 'file', rel: childRel, size: info.size })
          continue
        }
        errors.push({ rel: childRel, error: '既不是文件也不是目录，跳过' })
      }
    } finally {
      await dir.close().catch(() => {})
    }
  }

  await walk(root, '')
  return { entries, externals, errors }
}

/** 单文件复制并算 sha256；一次读、一次写 */
export async function copyFileHashed(from, to) {
  const hash = createHash('sha256')
  let bytes = 0
  await mkdir(path.dirname(to), { recursive: true })
  await pipeline(
    createReadStream(from),
    async function* (source) {
      for await (const chunk of source) {
        hash.update(chunk)
        bytes += chunk.length
        yield chunk
      }
    },
    createWriteStream(to),
  )
  return { size: bytes, sha256: hash.digest('hex') }
}

export async function sha256File(file) {
  const hash = createHash('sha256')
  let bytes = 0
  await pipeline(createReadStream(file), async function* (source) {
    for await (const chunk of source) {
      hash.update(chunk)
      bytes += chunk.length
      yield chunk
    }
  })
  return { size: bytes, sha256: hash.digest('hex') }
}

/**
 * 跑一次快照到 `<target>/<name>.partial`，完整才改名。
 * onProgress({done,total,bytes,phase}) 每 200 个文件回调一次。
 */
export async function writeSnapshot(options) {
  const {
    sourceDir,
    targetDir,
    name,
    excludes = [],
    host = {},
    onProgress = () => {},
    shouldStop = () => false,
  } = options

  const partialDir = path.join(targetDir, `${name}${PARTIAL_SUFFIX}`)
  const finalDir = path.join(targetDir, name)
  const startedAt = new Date()

  await mkdir(targetDir, { recursive: true })
  await rm(partialDir, { recursive: true, force: true })
  await mkdir(partialDir, { recursive: true })

  onProgress({ phase: 'scanning', done: 0, total: 0, bytes: 0 })
  const { entries, externals, errors } = await scanTree(sourceDir, excludes)
  const files = entries.filter((entry) => entry.type === 'file')
  const totalBytes = files.reduce((sum, entry) => sum + (entry.size || 0), 0)
  onProgress({ phase: 'copying', done: 0, total: files.length, bytes: 0, totalBytes })

  const treeHash = createHash('sha256')
  const index = []
  const failures = []
  let done = 0
  let bytes = 0

  for (const entry of entries) {
    if (shouldStop()) throw new Error('已取消')
    if (entry.type === 'dir') {
      try {
        await mkdir(path.join(partialDir, entry.rel), { recursive: true })
      } catch (err) {
        failures.push({ rel: entry.rel, error: err.message })
      }
      continue
    }
    try {
      const result = await copyFileHashed(path.join(sourceDir, entry.rel), path.join(partialDir, entry.rel))
      index.push([entry.rel, result.size, result.sha256])
      treeHash.update(`${entry.rel}\u0000${result.size}\u0000${result.sha256}\n`)
      done += 1
      bytes += result.size
      if (done % 200 === 0) onProgress({ phase: 'copying', done, total: files.length, bytes, totalBytes })
    } catch (err) {
      failures.push({ rel: entry.rel, error: err.message })
    }
  }

  // 外置链接（link: 安装的插件等）：内容抄进 _external，复原脚本按 from 写回
  const externalsDone = []
  for (const item of externals) {
    if (shouldStop()) throw new Error('已取消')
    try {
      const target = path.join(partialDir, item.to)
      const copied = await copyTreeInto(item.from, target, excludes)
      externalsDone.push({ ...item, fileCount: copied.files.length, bytes: copied.bytes, files: copied.files })
      for (const [rel, size, sha] of copied.files) treeHash.update(`${item.to}/${rel}\u0000${size}\u0000${sha}\n`)
    } catch (err) {
      failures.push({ rel: item.rel, error: `外置复制失败: ${err.message}` })
    }
  }

  for (const error of errors) failures.push(error)

  const finishedAt = new Date()
  const manifest = {
    formatVersion: 1,
    complete: failures.length === 0,
    name,
    sourceDir: path.resolve(sourceDir),
    targetDir: path.resolve(targetDir),
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    fileCount: index.length,
    bytes,
    treeSha256: treeHash.digest('hex'),
    files: index,
    excludes,
    externals: externalsDone,
    failures: failures.slice(0, 200),
    failureCount: failures.length,
    host,
  }
  await writeFile(path.join(partialDir, MANIFEST), JSON.stringify(manifest, null, 2), 'utf8')

  if (failures.length) {
    // 有失败：保留 .partial 当证据，但改名带后缀好一眼看出没完
    return { ok: false, partial: partialDir, manifest }
  }

  await rm(finalDir, { recursive: true, force: true })
  await rename(partialDir, finalDir)
  onProgress({ phase: 'done', done: index.length, total: index.length, bytes, totalBytes: totalBytes })
  return { ok: true, dir: finalDir, manifest }
}

/** 复制一整棵树（用于外置链接内容），跳过排除项与内部链接；返回逐文件 size+sha256 */
async function copyTreeInto(from, to, excludes) {
  const { entries, errors } = await scanTree(from, excludes)
  if (errors.length) throw new Error(errors[0].error)
  const files = []
  let bytes = 0
  for (const entry of entries) {
    if (entry.type === 'dir') {
      await mkdir(path.join(to, entry.rel), { recursive: true })
    } else {
      const result = await copyFileHashed(path.join(from, entry.rel), path.join(to, entry.rel))
      files.push([entry.rel, result.size, result.sha256])
      bytes += result.size
    }
  }
  return { files, bytes }
}

export async function readManifest(dir) {
  try {
    const raw = await readFile(path.join(dir, MANIFEST), 'utf8')
    return JSON.parse(raw)
  } catch {
    return null
  }
}

/** 按 manifest 逐个核 size+sha256；没 manifest 的一律判不完整 */
export async function verifySnapshot(dir, { deep = true } = {}) {
  const manifest = await readManifest(dir)
  if (!manifest) {
    return { ok: false, reason: '没有 manifest.json（可能是 2.x 时代的快照，或还没写完）', manifest: null }
  }
  if (!manifest.complete) {
    return {
      ok: false,
      reason: `快照自身记录为不完整（失败 ${manifest.failureCount} 项）`,
      manifest,
      failures: manifest.failures,
    }
  }
  const missing = []
  const mismatched = []
  let checked = 0
  let bytes = 0
  for (const item of manifest.files || manifest.index || []) {
    const [rel, size, sha] = item
    const abs = path.join(dir, rel)
    let info
    try {
      info = await stat(abs)
    } catch {
      missing.push(rel)
      continue
    }
    if (info.size !== size) {
      mismatched.push(`${rel}: 大小 ${info.size} ≠ 记录 ${size}`)
      continue
    }
    if (deep) {
      const result = await sha256File(abs)
      if (result.sha256 !== sha) mismatched.push(`${rel}: 内容哈希不符`)
      else bytes += result.size
    } else {
      bytes += info.size
    }
    checked += 1
  }
  const externalsMissing = []
  let externalChecked = 0
  for (const item of manifest.externals || []) {
    try {
      await stat(path.join(dir, item.to))
    } catch {
      externalsMissing.push(item.rel)
      continue
    }
    for (const [rel, size, sha] of item.files || []) {
      const abs = path.join(dir, item.to, rel)
      let info
      try {
        info = await stat(abs)
      } catch {
        externalsMissing.push(`${item.to}/${rel}`)
        continue
      }
      if (info.size !== size) {
        mismatched.push(`${item.to}/${rel}: 大小 ${info.size} ≠ 记录 ${size}`)
        continue
      }
      if (deep) {
        const result = await sha256File(abs)
        if (result.sha256 !== sha) mismatched.push(`${item.to}/${rel}: 内容哈希不符`)
      }
      externalChecked += 1
    }
  }
  const ok = missing.length === 0 && mismatched.length === 0 && externalsMissing.length === 0
  return {
    ok,
    reason: ok ? '完整' : `缺失 ${missing.length}、内容不符 ${mismatched.length}、外置缺 ${externalsMissing.length}`,
    manifest,
    checked: checked + externalChecked,
    bytes,
    missing: missing.slice(0, 50),
    mismatched: mismatched.slice(0, 50),
    externalsMissing,
  }
}

/** 列出目标目录下的快照（按名字倒序＝新的在前） */
export async function listSnapshots(targetDir) {
  const out = []
  let dir
  try {
    dir = await opendir(targetDir)
  } catch {
    return out
  }
  try {
    for await (const dirent of dir) {
      const name = dirent.name
      const full = path.join(targetDir, name)
      if (SNAPSHOT_RE.test(name)) {
        let info = null
        try {
          info = await stat(full)
        } catch {}
        const manifest = await readManifest(full)
        out.push({
          name,
          path: full,
          partial: false,
          mtime: info ? info.mtimeMs : 0,
          complete: Boolean(manifest && manifest.complete),
          fileCount: manifest ? manifest.fileCount : null,
          bytes: manifest ? manifest.bytes : null,
          startedAt: manifest ? manifest.startedAt : null,
          legacy: manifest === null,
        })
        continue
      }
      if (PARTIAL_RE.test(name)) {
        let info = null
        try {
          info = await stat(full)
        } catch {}
        out.push({ name, path: full, partial: true, mtime: info ? info.mtimeMs : 0, complete: false, legacy: false })
      }
    }
  } finally {
    await dir.close().catch(() => {})
  }
  out.sort((a, b) => b.name.localeCompare(a.name))
  return out
}

/**
 * 只清理带完整 manifest 的正名快照，保留最新 retain 个。
 * .partial、2.x 的老快照（没有 manifest）、以及任何别的目录/文件一律不碰。
 */
export async function pruneSnapshots(targetDir, retain, protectName) {
  const removed = []
  const kept = []
  if (!retain || retain <= 0) return { removed, kept }
  const all = await listSnapshots(targetDir)
  const complete = all.filter((item) => !item.partial && item.complete)
  const keepSet = new Set(complete.slice(0, retain).map((item) => item.name))
  if (protectName) keepSet.add(protectName)
  for (const item of complete) {
    if (keepSet.has(item.name)) {
      kept.push(item.name)
      continue
    }
    try {
      await rm(item.path, { recursive: true, force: true })
      removed.push(item.name)
    } catch {}
  }
  return { removed, kept }
}

/** 找一个可用且没被占用的快照名 */
export async function nextSnapshotName(targetDir, base) {
  let candidate = base
  let i = 2
  for (;;) {
    const exists = await stat(path.join(targetDir, candidate)).then(
      () => true,
      () => false,
    )
    const partialExists = await stat(path.join(targetDir, `${candidate}${PARTIAL_SUFFIX}`)).then(
      () => true,
      () => false,
    )
    if (!exists && !partialExists) return candidate
    candidate = `${base}-${i}`
    i += 1
  }
}
