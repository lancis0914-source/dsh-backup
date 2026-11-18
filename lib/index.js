/**
 * dsh-snapshot-backup 3.0 — 宿主侧。
 *
 * 跟 2.0 比，改的是四件要命的事：
 *   1. 快照先写 .partial，带逐文件 sha256 的 manifest，完整了才改名；清理只认带完整 manifest 的。
 *   2. 定时器改用 ctx.interval（0.2.2 把 timer helper 挪到 ctx 上了，ctx.timer.interval 已不存在）。
 *   3. 路径不再写死：源取 DSH_HOME，落点取配置，默认 DSH_HOME\backups。
 *   4. 路由对 GET 也查 Origin，POST 还查 content-type；不再让本机随便哪个网页读路径、改落点。
 *
 * 另外两件是为「起不来了怎么办」加的：
 *   - 复原脚本：每次启动都把 restore.ps1 / 覆盖复原.cmd 刷新到备份目录，双击就能覆盖回去。
 *   - 外置插件源：指向 .dsh 之外的链接（link: 装的插件）内容会被抄进快照，复原时写回原位并重建 junction。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync, chmodSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  MANIFEST,
  listSnapshots,
  nextSnapshotName,
  pruneSnapshots,
  readManifest,
  stamp,
  verifySnapshot,
  writeSnapshot,
} from './snapshot.js'
import { RESTORE_CMD, RESTORE_PS1, buildRestoreScript } from './restore.js'

export const name = 'dsh-snapshot-backup'

/**
 * timer 必须声明：ctx.interval 属于 timer 服务；webServer 用来挂状态接口；
 * tools 必须声明：老版 Cordis 拒绝访问未声明的服务属性（见 dsh-free-search 的注释）。
 */
export const inject = ['timer', 'webServer', 'tools']

const WORK_DIR_NAME = 'dsh-snapshot-backup'
const PREFIX = '/plugins/dsh-backup'

export const DEFAULTS = {
  enabled: true,
  intervalHours: 1,
  sourceDir: '',
  targetDir: '',
  retain: 5,
  excludes: ['logs', 'node_modules/.cache', 'dsh-snapshot-backup/backup.log'],
  backupOnStart: false,
}

/* ---------- 小工具 ---------- */

function errmsg(err) {
  return err instanceof Error ? err.message : String(err)
}

export function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (fromEnv && fromEnv.trim()) return path.resolve(fromEnv.trim())
  return path.join(os.homedir(), '.dsh')
}

function workDir() {
  return path.join(dshHome(), WORK_DIR_NAME)
}

function unquote(value) {
  if (typeof value !== 'string') return value
  let v = value.trim()
  if (v.length >= 2 && ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'")))) v = v.slice(1, -1)
  return v
}

function num(value, fallback, min, max) {
  const n = typeof value === 'number' ? value : Number(unquote(value))
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

const LOG_LIMIT = 2 * 1024 * 1024

function writeLog(level, message) {
  try {
    mkdirSync(workDir(), { recursive: true })
    const file = path.join(workDir(), 'backup.log')
    try {
      if (existsSync(file) && statSync(file).size > LOG_LIMIT) renameSync(file, `${file}.1`)
    } catch {}
    appendFileSync(file, `${new Date().toISOString()} [${level}] ${message}\n`)
  } catch {}
  if (level === 'error') {
    try {
      console.error(`[dsh-snapshot-backup] ${message}`)
    } catch {}
  }
}

function makeLogger(scope) {
  const prefix = scope ? `${scope}: ` : ''
  return {
    info: (msg) => writeLog('info', prefix + msg),
    warn: (msg) => writeLog('warn', prefix + msg),
    error: (msg) => writeLog('error', prefix + msg),
  }
}

const STATE = {
  cfg: null,
  log: null,
  timerDispose: null,
  nextAt: null,
  running: false,
  phase: 'idle',
  startedAt: null,
  progress: { done: 0, total: 0, bytes: 0 },
  last: null,
  lastError: null,
  restoreScript: null,
}

/* ---------- 配置 ---------- */

function readUserCfg() {
  try {
    const file = path.join(workDir(), 'config.json')
    if (!existsSync(file)) return null
    const raw = readFileSync(file, 'utf8')
    if (!raw.trim()) return null
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch (err) {
    writeLog('warn', `config.json 读不动，忽略: ${errmsg(err)}`)
    return null
  }
}

function resolveConfig(config, userCfg) {
  const merged = { ...DEFAULTS, ...(config && typeof config === 'object' ? config : {}), ...(userCfg || {}) }

  const hours = num(merged.intervalHours ?? merged.backupIntervalHours ?? merged.hours, DEFAULTS.intervalHours, 0.25, 168)
  const retain = Math.round(num(merged.retain ?? merged.retainBackups, DEFAULTS.retain, 0, 200))
  const sourceRaw = unquote(merged.sourceDir ?? merged.backupSourceDir) || dshHome()
  const targetRaw = unquote(merged.targetDir ?? merged.backupTargetDir) || path.join(dshHome(), 'backups')

  const excludes = Array.isArray(merged.excludes ?? merged.excludePrefixes)
    ? (merged.excludes ?? merged.excludePrefixes)
        .filter((x) => typeof x === 'string' && x.trim())
        .map((x) => x.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''))
    : DEFAULTS.excludes.slice()

  return {
    enabled: merged.enabled !== false,
    intervalHours: hours,
    intervalMs: Math.round(hours * 3600_000),
    sourceDir: path.resolve(sourceRaw),
    targetDir: path.resolve(targetRaw),
    retain,
    excludes,
    backupOnStart: merged.backupOnStart === true,
  }
}

function publicConfig(cfg) {
  return {
    enabled: cfg.enabled,
    intervalHours: cfg.intervalHours,
    intervalMs: cfg.intervalMs,
    sourceDir: cfg.sourceDir,
    targetDir: cfg.targetDir,
    retain: cfg.retain,
    excludes: cfg.excludes,
    backupOnStart: cfg.backupOnStart,
  }
}

function persistConfig(cfg) {
  try {
    mkdirSync(workDir(), { recursive: true })
    writeFileSync(
      path.join(workDir(), 'config.json'),
      JSON.stringify(
        {
          enabled: cfg.enabled,
          intervalHours: cfg.intervalHours,
          sourceDir: cfg.sourceDir,
          targetDir: cfg.targetDir,
          retain: cfg.retain,
          excludes: cfg.excludes,
          backupOnStart: cfg.backupOnStart,
        },
        null,
        2,
      ) + '\n',
      'utf8',
    )
    return true
  } catch (err) {
    writeLog('error', `写 config.json 失败: ${errmsg(err)}`)
    return false
  }
}

function writeStatus() {
  try {
    mkdirSync(workDir(), { recursive: true })
    writeFileSync(
      path.join(workDir(), 'status.json'),
      JSON.stringify(
        {
          cfg: STATE.cfg ? publicConfig(STATE.cfg) : null,
          nextAt: STATE.nextAt,
          running: STATE.running,
          phase: STATE.phase,
          startedAt: STATE.startedAt,
          progress: STATE.progress,
          last: STATE.last,
          lastError: STATE.lastError,
          restoreScript: STATE.restoreScript,
          time: new Date().toISOString(),
        },
        null,
        2,
      ) + '\n',
      'utf8',
    )
  } catch {}
}

/* ---------- 复原脚本 ---------- */

function writeRestoreScript(cfg) {
  const scripts = buildRestoreScript({ dshHome: dshHome(), targetDir: cfg.targetDir })
  mkdirSync(cfg.targetDir, { recursive: true })
  const ps1 = path.join(cfg.targetDir, RESTORE_PS1)
  const cmd = path.join(cfg.targetDir, RESTORE_CMD)
  writeFileSync(ps1, '\uFEFF' + scripts.ps1, 'utf8')
  writeFileSync(cmd, '\uFEFF' + scripts.cmd, 'utf8')
  chmodSync(ps1, 0o644)
  chmodSync(cmd, 0o644)
  STATE.restoreScript = { ps1, cmd }
  return STATE.restoreScript
}

/* ---------- 跑一次快照 ---------- */

async function runSnapshot(options = {}) {
  const reason = typeof options.reason === 'string' ? options.reason : 'manual'
  if (STATE.running) return { ok: false, busy: true, error: '已经有一次快照在跑，等它完' }

  const cfg = STATE.cfg || resolveConfig()
  const log = STATE.log || makeLogger('snapshot')
  const startedAt = new Date()

  STATE.running = true
  STATE.phase = 'scanning'
  STATE.startedAt = startedAt.toISOString()
  STATE.progress = { done: 0, total: 0, bytes: 0 }
  STATE.lastError = null
  writeLog('info', `开始快照(${reason}) ${cfg.sourceDir} -> ${cfg.targetDir}`)
  writeStatus()

  try {
    if (!existsSync(cfg.sourceDir)) throw new Error(`源目录不存在: ${cfg.sourceDir}`)
    writeRestoreScript(cfg)
    const name = await nextSnapshotName(cfg.targetDir, `.dsh-${stamp(startedAt)}`)
    const result = await writeSnapshot({
      sourceDir: cfg.sourceDir,
      targetDir: cfg.targetDir,
      name,
      excludes: cfg.excludes,
      host: { node: process.versions.node, dsh: process.env.DSH_VERSION || null },
      onProgress: (progress) => {
        STATE.phase = progress.phase
        STATE.progress = { done: progress.done || 0, total: progress.total || 0, bytes: progress.bytes || 0 }
      },
    })

    let pruned = { removed: [] }
    if (result.ok) {
      STATE.phase = 'pruning'
      pruned = await pruneSnapshots(cfg.targetDir, cfg.retain, name)
    }

    const summary = {
      ok: result.ok,
      name,
      dir: result.dir || result.partial,
      reason,
      fileCount: result.manifest.fileCount,
      bytes: result.manifest.bytes,
      failureCount: result.manifest.failureCount,
      pruned: pruned.removed,
      startedAt: result.manifest.startedAt,
      finishedAt: result.manifest.finishedAt,
      durationMs: result.manifest.durationMs,
    }
    STATE.last = summary
    STATE.phase = result.ok ? 'finished' : 'finished-with-errors'
    STATE.lastError = result.ok ? null : `${result.manifest.failureCount} 个条目失败，留在 ${path.basename(result.partial)}`
    writeLog(
      result.ok ? 'info' : 'warn',
      `快照结束 ${name}: ${summary.fileCount} 文件, ${(summary.bytes / 1048576).toFixed(1)} MB, 失败 ${summary.failureCount}, 清理 ${pruned.removed.length}`,
    )
    return summary
  } catch (err) {
    const message = errmsg(err)
    STATE.phase = 'failed'
    STATE.lastError = message
    writeLog('error', `快照失败: ${message}`)
    return { ok: false, error: message, reason }
  } finally {
    STATE.running = false
    writeStatus()
    if (STATE.nextAt && STATE.cfg) {
      STATE.nextAt = new Date(Date.now() + STATE.cfg.intervalMs).toISOString()
      writeStatus()
    }
  }
}

/* ---------- 定时器 ---------- */

function clearTimer() {
  const dispose = STATE.timerDispose
  STATE.timerDispose = null
  STATE.nextAt = null
  if (typeof dispose === 'function') {
    try {
      dispose()
    } catch {}
  }
}

function installTimer(ctx) {
  clearTimer()
  const cfg = STATE.cfg
  const log = makeLogger('timer')
  if (!cfg.enabled) {
    log.info('自动快照已关闭（enabled=false）')
    writeStatus()
    return
  }

  const tick = () => {
    runSnapshot({ reason: 'schedule' }).catch((err) => writeLog('error', `周期快照异常: ${errmsg(err)}`))
  }

  try {
    STATE.timerDispose = ctx.interval(tick, cfg.intervalMs)
    STATE.nextAt = new Date(Date.now() + cfg.intervalMs).toISOString()
    log.info(`定时器已注册(ctx.interval): 每 ${cfg.intervalHours} 小时, 下次 ${STATE.nextAt}`)
  } catch (err) {
    log.error(`ctx.interval 注册失败: ${errmsg(err)}`)
    STATE.lastError = `定时器注册失败: ${errmsg(err)}`
  }
  writeStatus()
}

/* ---------- HTTP ---------- */

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload, null, 2)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/**
 * 同源校验：Origin 存在就必须和 Host 一致；
 * Host 头也必需（挡住没有 Host 的原始连接）。
 * GET 同样要过这一关 —— 2.0 只查 POST，本机任何网页都能读路径和日志。
 */
function trusted(req) {
  const host = req.headers.host
  if (!host) return false
  const origin = req.headers.origin
  if (origin) {
    try {
      const parsed = new URL(origin)
      if ((parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.host !== host) return false
    } catch {
      return false
    }
  }
  const site = String(req.headers['sec-fetch-site'] || '')
  if (site && site !== 'same-origin' && site !== 'none') return false
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const contentType = String(req.headers['content-type'] || '')
    if (!contentType.includes('application/json')) return false
  }
  return true
}

function tailLog(lines = 40) {
  try {
    const file = path.join(workDir(), 'backup.log')
    if (!existsSync(file)) return []
    return readFileSync(file, 'utf8').trimEnd().split('\n').slice(-lines)
  } catch {
    return []
  }
}

async function snapshotOfState() {
  const cfg = STATE.cfg
  return {
    ok: true,
    cfg: cfg ? publicConfig(cfg) : null,
    state: {
      running: STATE.running,
      phase: STATE.phase,
      startedAt: STATE.startedAt,
      progress: STATE.progress,
      last: STATE.last,
      lastError: STATE.lastError,
      nextAt: STATE.nextAt,
      enabled: cfg ? cfg.enabled : false,
    },
    snapshots: cfg ? await listSnapshots(cfg.targetDir) : [],
    restoreScript: STATE.restoreScript,
    log: tailLog(40),
    files: {
      workDir: workDir(),
      log: path.join(workDir(), 'backup.log'),
      config: path.join(workDir(), 'config.json'),
    },
  }
}

function applyConfigPatch(body) {
  const cfg = STATE.cfg
  if (!cfg) return { ok: false, error: '插件还没初始化完' }
  let patch
  try {
    patch = JSON.parse(body || '{}')
  } catch {
    return { ok: false, error: 'JSON 解析失败' }
  }
  if (!patch || typeof patch !== 'object') return { ok: false, error: '要一个对象' }

  if ('intervalHours' in patch || 'backupIntervalHours' in patch) {
    const value = Number(patch.intervalHours ?? patch.backupIntervalHours)
    if (!Number.isFinite(value) || value < 0.25 || value > 168) return { ok: false, error: '间隔得在 0.25 到 168 小时之间' }
    cfg.intervalHours = Math.round(value * 100) / 100
    cfg.intervalMs = Math.round(cfg.intervalHours * 3600_000)
  }
  if ('retain' in patch) {
    const value = Math.round(Number(patch.retain))
    if (!Number.isFinite(value) || value < 0 || value > 200) return { ok: false, error: '保留份数得在 0 到 200 之间' }
    cfg.retain = value
  }
  if ('enabled' in patch) cfg.enabled = patch.enabled !== false
  if ('targetDir' in patch && unquote(patch.targetDir)) cfg.targetDir = path.resolve(unquote(patch.targetDir))
  if ('sourceDir' in patch && unquote(patch.sourceDir)) cfg.sourceDir = path.resolve(unquote(patch.sourceDir))
  if (Array.isArray(patch.excludes)) {
    cfg.excludes = patch.excludes.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim())
  }
  if ('backupOnStart' in patch) cfg.backupOnStart = patch.backupOnStart === true

  const saved = persistConfig(cfg)
  try {
    writeRestoreScript(cfg)
  } catch (err) {
    writeLog('warn', `刷新复原脚本失败: ${errmsg(err)}`)
  }
  installTimer(CURRENT_CTX || {})
  return { ok: true, saved, cfg: publicConfig(cfg), nextAt: STATE.nextAt, restoreScript: STATE.restoreScript }
}

let CURRENT_CTX = null

function registerRoutes(ctx, log) {
  const dispose = ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: PREFIX,
        handler: (req, res) => {
          try {
            if (!trusted(req)) {
              sendJson(res, 403, { ok: false, error: 'forbidden' })
              return
            }
            const url = new URL(req.url || '/', 'http://dsh.internal')
            const sub = url.pathname.slice(PREFIX.length) || '/'

            if (req.method === 'GET' && (sub === '/state' || sub === '/status')) {
              snapshotOfState()
                .then((payload) => sendJson(res, 200, payload))
                .catch((err) => sendJson(res, 500, { ok: false, error: errmsg(err) }))
              return
            }

            if (req.method === 'POST' && sub === '/run') {
              if (STATE.running) {
                sendJson(res, 202, { ok: true, started: false, alreadyRunning: true })
                return
              }
              runSnapshot({ reason: 'manual' }).catch((err) => writeLog('error', `手动快照异常: ${errmsg(err)}`))
              sendJson(res, 202, { ok: true, started: true })
              return
            }

            if (req.method === 'POST' && sub === '/verify') {
              readBody(req)
                .then(async (body) => {
                  const patch = JSON.parse(body || '{}')
                  const cfg = STATE.cfg
                  const list = await listSnapshots(cfg.targetDir)
                  const name = patch.name || (list.find((item) => item.complete) || {}).name
                  if (!name) {
                    sendJson(res, 404, { ok: false, error: '没有可校验的快照' })
                    return
                  }
                  const result = await verifySnapshot(path.join(cfg.targetDir, name), { deep: patch.deep !== false })
                  sendJson(res, 200, { ok: result.ok, name, reason: result.reason, checked: result.checked, missing: result.missing, mismatched: result.mismatched })
                })
                .catch((err) => sendJson(res, 400, { ok: false, error: errmsg(err) }))
              return
            }

            if (req.method === 'POST' && sub === '/config') {
              readBody(req)
                .then((body) => sendJson(res, 200, applyConfigPatch(body)))
                .catch((err) => sendJson(res, 400, { ok: false, error: errmsg(err) }))
              return
            }

            if (req.method === 'POST' && sub === '/clientlog') {
              readBody(req)
                .then((body) => {
                  let parsed = {}
                  try {
                    parsed = JSON.parse(body || '{}')
                  } catch {}
                  const level = parsed.level === 'error' ? 'error' : 'info'
                  writeLog(level, `客户端: ${String(parsed.msg || '').slice(0, 4000)}`)
                  sendJson(res, 200, { ok: true })
                })
                .catch((err) => sendJson(res, 400, { ok: false, error: errmsg(err) }))
              return
            }

            sendJson(res, 404, { ok: false, error: 'not found', path: sub })
          } catch (err) {
            try {
              sendJson(res, 500, { ok: false, error: errmsg(err) })
            } catch {}
          }
        },
      }),
    'dsh-snapshot-backup: routes',
  )
  log.info(`Web 接口已注册: ${PREFIX}/state, /run, /verify, /config`)
  return dispose
}

/* ---------- 工具 ---------- */

const NOW_TOOL = {
  name: 'dsh-backup-now',
  description: '立刻对宿主 .dsh 目录做一次完整快照（带逐文件校验清单），等跑完才返回。落点与定时快照一致。',
  parameters: {
    type: 'object',
    properties: {
      sourceDir: { type: 'string', description: '源目录，留空用当前设定' },
      targetDir: { type: 'string', description: '落点，留空用当前设定' },
    },
  },
  output: {
    schema: {
      type: 'object',
      properties: {
        ok: { type: 'boolean' },
        name: { type: 'string' },
        dir: { type: 'string' },
        fileCount: { type: 'integer' },
        bytes: { type: 'integer' },
        failureCount: { type: 'integer' },
        durationMs: { type: 'integer' },
        error: { type: 'string' },
      },
    },
    render(args, value) {
      if (!value || typeof value !== 'object') return [{ type: 'text', text: '快照没有返回结果' }]
      if (value.ok) {
        return [
          {
            type: 'text',
            text: `快照完成: ${value.name}，${value.fileCount} 个文件 / ${(Number(value.bytes || 0) / 1048576).toFixed(1)} MB，耗时 ${(Number(value.durationMs || 0) / 1000).toFixed(1)}s。落点 ${value.dir}`,
          },
        ]
      }
      return [
        {
          type: 'text',
          text: `快照未完成: ${value.error || `${value.failureCount} 个条目失败`}。残缺内容留在 ${value.dir || '(见日志)'}，不会被当成可用快照。`,
        },
      ]
    },
  },
  async execute(args) {
    const cfg = STATE.cfg || resolveConfig()
    const patch = args && typeof args === 'object' ? args : {}
    if (typeof patch.sourceDir === 'string' && patch.sourceDir.trim()) cfg.sourceDir = path.resolve(unquote(patch.sourceDir))
    if (typeof patch.targetDir === 'string' && patch.targetDir.trim()) cfg.targetDir = path.resolve(unquote(patch.targetDir))
    return runSnapshot({ reason: 'tool' })
  },
}

const VERIFY_TOOL = {
  name: 'dsh-backup-verify',
  description: '按清单逐个核对快照的文件大小与 sha256，判断它是否真的完整（老快照没有清单会直接判不完整）。',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: '快照目录名，留空校验最新的完整快照' },
      deep: { type: 'boolean', description: '是否逐文件重算哈希，默认 true' },
    },
  },
  output: {
    schema: {
      type: 'object',
      properties: {
        ok: { type: 'boolean' },
        name: { type: 'string' },
        reason: { type: 'string' },
        checked: { type: 'integer' },
        missing: { type: 'array', items: { type: 'string' } },
        mismatched: { type: 'array', items: { type: 'string' } },
        error: { type: 'string' },
      },
    },
    render(args, value) {
      if (!value || typeof value !== 'object') return [{ type: 'text', text: '校验没有返回结果' }]
      if (value.ok) return [{ type: 'text', text: `快照 ${value.name} 完整，核对 ${value.checked} 个文件，结论: ${value.reason}` }]
      return [{ type: 'text', text: `快照 ${value.name || '(未指定)'} 不完整: ${value.reason || value.error}` }]
    },
  },
  async execute(args) {
    const cfg = STATE.cfg || resolveConfig()
    const patch = args && typeof args === 'object' ? args : {}
    const list = await listSnapshots(cfg.targetDir)
    const name = patch.name || (list.find((item) => item.complete) || {}).name
    if (!name) return { ok: false, error: `没有可校验的快照（落点 ${cfg.targetDir}）` }
    const result = await verifySnapshot(path.join(cfg.targetDir, name), { deep: patch.deep !== false })
    return {
      ok: result.ok,
      name,
      reason: result.reason,
      checked: result.checked || 0,
      missing: result.missing || [],
      mismatched: result.mismatched || [],
    }
  },
}

const RESTORE_TOOL = {
  name: 'dsh-backup-restore',
  description: '准备「覆盖式复原」：校验指定/最新快照，刷新备份目录里的覆盖复原.cmd 与 restore.ps1，并返回下一步要做什么。不做运行中的热覆盖（会毁掉正在写的文件）。',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: '要复原的快照目录名，留空用最新的完整快照' },
    },
  },
  output: {
    schema: {
      type: 'object',
      properties: {
        ok: { type: 'boolean' },
        name: { type: 'string' },
        complete: { type: 'boolean' },
        reason: { type: 'string' },
        script: { type: 'string' },
        instructions: { type: 'string' },
      },
    },
    render(args, value) {
      if (!value || typeof value !== 'object') return [{ type: 'text', text: '复原准备没有返回结果' }]
      return [{ type: 'text', text: `${value.instructions || ''}\n脚本: ${value.script || '(未生成)'}` }]
    },
  },
  async execute(args) {
    const cfg = STATE.cfg || resolveConfig()
    const patch = args && typeof args === 'object' ? args : {}
    const list = await listSnapshots(cfg.targetDir)
    const name = patch.name || (list.find((item) => item.complete) || {}).name
    if (!name) return { ok: false, error: `落点 ${cfg.targetDir} 里没有完整快照` }
    const dir = path.join(cfg.targetDir, name)
    const manifest = await readManifest(dir)
    const scripts = writeRestoreScript(cfg)
    const verify = await verifySnapshot(dir, { deep: false })
    const instructions = verify.ok
      ? `快照 ${name} 可用。步骤: 1) 彻底退出 DSH；2) 双击 ${scripts.cmd}；3) 启动 DSH。脚本会先把现在的 .dsh 改名成 .broken 留档，覆盖失败会自动改回来。`
      : `快照 ${name} 校验没通过（${verify.reason}），不建议覆盖。要么换一个快照，要么先跑 dsh-backup-verify 看缺哪些文件。`
    return {
      ok: verify.ok,
      name,
      complete: Boolean(manifest && manifest.complete),
      reason: verify.reason,
      script: scripts.cmd,
      instructions,
    }
  },
}

/* ---------- 入口 ---------- */

function step(log, label, fn) {
  try {
    return fn()
  } catch (err) {
    log.error(`${label} 失败: ${errmsg(err)}`)
    if (err instanceof Error && err.stack) writeLog('error', `${label} 堆栈: ${err.stack}`)
    return null
  }
}

export function apply(ctx, config) {
  const log = makeLogger('apply')
  CURRENT_CTX = ctx

  writeLog('info', '---- apply 开始 ----')

  const userCfg = step(log, '读 config.json', () => readUserCfg())
  const cfg = step(log, '解析配置', () => resolveConfig(config, userCfg))
  if (!cfg) {
    writeLog('error', '配置解析不出来，插件放弃加载')
    throw new Error('dsh-snapshot-backup: 配置解析失败')
  }

  STATE.cfg = cfg
  STATE.log = log
  writeLog('info', `配置: interval=${cfg.intervalHours}h source=${cfg.sourceDir} target=${cfg.targetDir} retain=${cfg.retain} enabled=${cfg.enabled}`)

  const disposers = []

  step(log, '写复原脚本', () => writeRestoreScript(cfg))
  step(log, '注册定时器', () => installTimer(ctx))

  step(log, '注册工具', () => {
    // 官方写法：ctx.inject(['tools'], sctx => sctx.tools.register(...))。
    // 不用 defineTool：那是 @deepseek-ai/dsh-tools 的导出，本插件是 link 装到工作区的，
    // 裸包名会解析到工作区里那份解压副本而不是宿主里的活包，所以直接给同样形状的普通对象。
    let registered = 0
    ctx.inject(['tools'], (sctx) => {
      const tools = sctx.get('tools')
      if (!tools || typeof tools.register !== 'function') {
        log.warn('tools 服务不在，跳过三个备份工具')
        return
      }
      for (const def of [NOW_TOOL, VERIFY_TOOL, RESTORE_TOOL]) {
        try {
          const dispose = tools.register(def)
          if (typeof dispose === 'function') disposers.push(dispose)
          registered += 1
          log.info(`工具 ${def.name} 已注册`)
        } catch (err) {
          log.error(`工具 ${def.name} 注册失败: ${errmsg(err)}`)
        }
      }
    })
    return registered > 0
  })

  step(log, '注册 Web 接口', () => {
    const dispose = registerRoutes(ctx, log)
    if (typeof dispose === 'function') disposers.push(dispose)
    return true
  })

  if (cfg.backupOnStart) {
    step(log, '启动即快照', () => {
      runSnapshot({ reason: 'startup' }).catch((err) => writeLog('error', `启动快照异常: ${errmsg(err)}`))
      return true
    })
  }

  writeLog('info', '---- apply 结束 ----')
  writeStatus()

  // Cordis 认函数的返回值当 disposer；返回对象会被忽略，清不干净。
  return () => {
    writeLog('info', '---- dispose ----')
    clearTimer()
    for (const dispose of disposers.splice(0)) {
      try {
        dispose()
      } catch (err) {
        writeLog('warn', `dispose 一项失败: ${errmsg(err)}`)
      }
    }
  }
}

export { MANIFEST, listSnapshots, pruneSnapshots, readManifest, verifySnapshot, writeSnapshot }
