/**
 * dsh-snapshot-backup 3.0 — 浏览器侧：设置 → 快照。
 *
 * 只做四件事：看状态、立刻拍一张、校验最新那张能不能用、调间隔与保留份数。
 * 一切数据都走 /plugins/dsh-backup/*（同源校验在宿主侧，GET 也查）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-snapshot-backup',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback, useRef } = React

    const NS = 'snapshot-backup'
    const name = 'snapshot-backup-client'
    const inject = ['slots', 'locale']

    const zh = {
      nav: '快照备份',
      title: '快照备份',
      subtitle: '把整个 .dsh 拍成可校验的快照；起不来的时候双击备份目录里的「覆盖复原.cmd」原样盖回去。',
      runNow: '立刻拍一张',
      running: '正在拍…',
      verify: '校验最新快照',
      verifying: '校验中…',
      autoTitle: '自动快照',
      intervalLabel: '间隔（小时）',
      intervalHint: '0.25 到 168，支持小数',
      retainLabel: '保留份数',
      retainHint: '只清理带完整清单的快照；残缺的和老快照不碰',
      enabledLabel: '自动开关',
      save: '保存',
      saved: '已保存，定时器已按新间隔重启',
      nextAt: '下次自动快照',
      never: '未排程',
      pathsTitle: '路径',
      source: '源目录',
      target: '落点',
      restoreTitle: '起不来的时候',
      restoreHint: '彻底退出 DSH 后双击：',
      recentTitle: '最近的快照',
      noSnapshots: '还没有快照',
      logTitle: '日志尾部',
      complete: '完整',
      incomplete: '残缺',
      legacy: '老格式（无清单）',
      partial: '未写完',
      verifyOk: '校验通过',
      verifyFail: '校验没通过',
      loadFail: '读不到插件状态',
      runFail: '快照没启动起来',
      busy: '已经有一张在拍了',
      phase: '阶段',
      copied: '已复制',
      progress: '进度',
    }

    const en = {
      nav: 'Snapshots',
      title: 'Snapshots',
      subtitle: 'Snapshot the whole .dsh with a verifiable manifest; when DSH will not start, double-click the restore script in the snapshot folder.',
      runNow: 'Snapshot now',
      running: 'Snapshotting…',
      verify: 'Verify newest',
      verifying: 'Verifying…',
      autoTitle: 'Scheduled snapshots',
      intervalLabel: 'Interval (hours)',
      intervalHint: '0.25 to 168, decimals allowed',
      retainLabel: 'Keep',
      retainHint: 'Only complete snapshots are pruned; partial and legacy ones are left alone',
      enabledLabel: 'Automatic',
      save: 'Save',
      saved: 'Saved. The timer restarted on the new interval.',
      nextAt: 'Next snapshot',
      never: 'Not scheduled',
      pathsTitle: 'Paths',
      source: 'Source',
      target: 'Destination',
      restoreTitle: 'When DSH will not start',
      restoreHint: 'Quit DSH fully, then double-click:',
      recentTitle: 'Recent snapshots',
      noSnapshots: 'No snapshots yet',
      logTitle: 'Log tail',
      complete: 'complete',
      incomplete: 'incomplete',
      legacy: 'legacy (no manifest)',
      partial: 'unfinished',
      verifyOk: 'Verification passed',
      verifyFail: 'Verification failed',
      loadFail: 'Could not read plugin state',
      runFail: 'Snapshot did not start',
      busy: 'A snapshot is already running',
      phase: 'Phase',
      copied: 'Copied',
      progress: 'Progress',
    }

    function api(pathname) {
      const relative = String(pathname).replace(/^\/+/, '')
      if (typeof document === 'undefined' || !document.baseURI) return '/' + relative
      try {
        return new URL(relative, document.baseURI).pathname
      } catch {
        return '/' + relative
      }
    }

    async function getState() {
      const res = await fetch(api('/plugins/dsh-backup/state'), { headers: { accept: 'application/json' } })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res.json()
    }

    async function post(pathname, body) {
      const res = await fetch(api(pathname), {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body || {}),
      })
      const payload = await res.json().catch(() => ({}))
      if (!res.ok || payload.ok === false) throw new Error(payload.error || `HTTP ${res.status}`)
      return payload
    }

    function bytes(value) {
      const n = Number(value || 0)
      if (n >= 1073741824) return (n / 1073741824).toFixed(2) + ' GB'
      if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB'
      if (n >= 1024) return (n / 1024).toFixed(1) + ' KB'
      return n + ' B'
    }

    function when(iso) {
      if (!iso) return '—'
      try {
        return new Date(iso).toLocaleString()
      } catch {
        return String(iso)
      }
    }

    const C = {
      page: { display: 'flex', flexDirection: 'column', gap: 14, padding: '4px 2px 28px', fontSize: 13, color: 'var(--dsw-alias-label-primary)' },
      head: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' },
      h1: { fontSize: 19, fontWeight: 600, margin: 0 },
      sub: { fontSize: 12.5, color: 'var(--dsw-alias-label-secondary)', marginTop: 6, lineHeight: 1.55, maxWidth: 720 },
      card: { border: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-layer-1)', borderRadius: 10, padding: '14px 16px' },
      cardTitle: { fontSize: 13.5, fontWeight: 600, marginBottom: 10 },
      row: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, flexWrap: 'wrap' },
      label: { minWidth: 92, fontSize: 12.5, color: 'var(--dsw-alias-label-secondary)' },
      input: { width: 100, padding: '4px 8px', borderRadius: 6, border: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-primary)', fontSize: 12.5 },
      btn: { padding: '5px 14px', borderRadius: 6, border: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-primary)', cursor: 'pointer', fontSize: 12.5 },
      chip: { padding: '3px 9px', borderRadius: 999, border: '1px solid var(--dsw-alias-border-l1)', background: 'transparent', color: 'var(--dsw-alias-label-secondary)', cursor: 'pointer', fontSize: 11.5 },
      hint: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary)', lineHeight: 1.6 },
      bad: { color: 'var(--dsw-alias-state-error-primary)' },
      ok: { color: 'var(--dsw-alias-state-success-primary)' },
      mono: { fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 12, wordBreak: 'break-all' },
      dim: { color: 'var(--dsw-alias-label-tertiary)', fontSize: 12 },
      log: { margin: 0, maxHeight: 180, overflow: 'auto', fontSize: 11.5, lineHeight: 1.5, whiteSpace: 'pre-wrap', color: 'var(--dsw-alias-label-secondary)' },
      bar: { height: 4, borderRadius: 999, background: 'var(--dsw-alias-bg-layer-2)', overflow: 'hidden', marginTop: 8 },
    }

    function Panel(props) {
      const t = props.t
      const [data, setData] = useState(null)
      const [error, setError] = useState('')
      const [notice, setNotice] = useState('')
      const [busy, setBusy] = useState('')
      const [hours, setHours] = useState('1')
      const [retain, setRetain] = useState('5')
      const [enabled, setEnabled] = useState(true)
      const timer = useRef(null)

      const refresh = useCallback(async () => {
        try {
          const payload = await getState()
          setData(payload)
          setError('')
          if (payload && payload.cfg) {
            setHours(String(payload.cfg.intervalHours))
            setRetain(String(payload.cfg.retain))
            setEnabled(Boolean(payload.cfg.enabled))
          }
        } catch (err) {
          setError(err.message || String(err))
        }
      }, [])

      useEffect(() => {
        refresh()
        return () => {
          if (timer.current) clearInterval(timer.current)
        }
      }, [refresh])

      useEffect(() => {
        if (timer.current) clearInterval(timer.current)
        const running = data && data.state && data.state.running
        timer.current = setInterval(refresh, running ? 1500 : 8000)
        return () => {
          if (timer.current) clearInterval(timer.current)
        }
      }, [data && data.state && data.state.running, refresh])

      const cfg = data ? data.cfg : null
      const st = data && data.state ? data.state : {}
      const snapshots = data && data.snapshots ? data.snapshots : []
      const lines = data && data.log ? data.log : []

      async function runNow() {
        setBusy('run')
        setNotice('')
        try {
          const result = await post('/plugins/dsh-backup/run', {})
          setNotice(result && result.alreadyRunning ? t('busy') : '')
          setTimeout(refresh, 600)
        } catch (err) {
          setError(`${t('runFail')}: ${err.message || err}`)
        } finally {
          setBusy('')
        }
      }

      async function verifyLatest() {
        setBusy('verify')
        setNotice('')
        try {
          const result = await post('/plugins/dsh-backup/verify', { deep: true })
          setNotice(`${result.ok ? t('verifyOk') : t('verifyFail')}: ${result.reason || ''} · ${result.checked || 0}`)
        } catch (err) {
          setError(`${t('verifyFail')}: ${err.message || err}`)
        } finally {
          setBusy('')
        }
      }

      async function save() {
        setBusy('save')
        setNotice('')
        try {
          await post('/plugins/dsh-backup/config', {
            intervalHours: Number(hours),
            retain: Number(retain),
            enabled,
          })
          setNotice(t('saved'))
          refresh()
        } catch (err) {
          setError(err.message || String(err))
        } finally {
          setBusy('')
        }
      }

      const progress = st.progress || {}
      const pct = progress.total ? Math.min(100, Math.round((progress.done / progress.total) * 100)) : 0

      return h(
        'div',
        { style: C.page },

        h(
          'div',
          { style: C.head },
          h('div', null, h('h1', { style: C.h1 }, t('title')), h('div', { style: C.sub }, t('sub'))),
          h(
            'div',
            { style: { display: 'flex', gap: 8 } },
            h('button', { style: { ...C.btn, opacity: busy === 'run' ? 0.6 : 1 }, onClick: runNow, disabled: Boolean(busy) || st.running }, st.running || busy === 'run' ? t('running') : t('runNow')),
            h('button', { style: C.btn, onClick: verifyLatest, disabled: Boolean(busy) }, busy === 'verify' ? t('verifying') : t('verify')),
          ),
        ),

        st.running
          ? h(
              'div',
              { style: C.card },
              h('div', { style: C.cardTitle }, `${t('phase')}: ${st.phase || '—'}   ${t('copied')} ${progress.done || 0} / ${progress.total || 0}  ${bytes(progress.bytes)}`),
              h('div', { style: C.bar }, h('div', { style: { width: pct + '%', height: '100%', background: 'var(--dsw-alias-state-success-primary)' } })),
            )
          : null,

        h(
          'div',
          { style: C.card },
          h('div', { style: C.cardTitle }, t('autoTitle')),
          h(
            'div',
            { style: C.row },
            h('div', { style: C.label }, t('intervalLabel')),
            h('input', { style: C.input, type: 'number', min: 0.25, max: 168, step: 0.25, value: hours, onChange: (e) => setHours(e.target.value) }),
            [1, 3, 6, 12, 24].map((value) => h('button', { key: value, style: C.chip, onClick: () => setHours(String(value)) }, `${value}h`)),
          ),
          h('div', { style: C.hint }, t('intervalHint')),
          h(
            'div',
            { style: { ...C.row, marginTop: 12 } },
            h('div', { style: C.label }, t('retainLabel')),
            h('input', { style: C.input, type: 'number', min: 0, max: 200, step: 1, value: retain, onChange: (e) => setRetain(e.target.value) }),
          ),
          h('div', { style: C.hint }, t('retainHint')),
          h(
            'div',
            { style: { ...C.row, marginTop: 12, marginBottom: 0 } },
            h('div', { style: C.label }, t('enabledLabel')),
            h('button', { style: { ...C.btn, borderColor: enabled ? 'var(--dsw-alias-state-success-primary)' : undefined }, onClick: () => setEnabled(!enabled) }, enabled ? '开' : '关'),
            h('button', { style: { ...C.btn, opacity: busy === 'save' ? 0.6 : 1 }, onClick: save, disabled: Boolean(busy) }, t('save')),
            h('div', { style: C.dim }, `${t('nextAt')}: ${st.nextAt ? when(st.nextAt) : t('never')}`),
          ),
          notice ? h('div', { style: { ...C.hint, ...C.ok, marginTop: 8 } }, notice) : null,
          st.lastError ? h('div', { style: { ...C.hint, ...C.bad, marginTop: 8 } }, `上次问题: ${st.lastError}`) : null,
          error ? h('div', { style: { ...C.hint, ...C.bad, marginTop: 8 } }, `${t('loadFail')}: ${error}`) : null,
        ),

        h(
          'div',
          { style: C.card },
          h('div', { style: C.cardTitle }, t('pathsTitle')),
          h('div', { style: C.row }, h('div', { style: C.label }, t('source')), h('div', { style: C.mono }, cfg ? cfg.sourceDir : '—')),
          h('div', { style: { ...C.row, marginBottom: 0 } }, h('div', { style: C.label }, t('target')), h('div', { style: C.mono }, cfg ? cfg.targetDir : '—')),
        ),

        h(
          'div',
          { style: C.card },
          h('div', { style: C.cardTitle }, t('restoreTitle')),
          h('div', { style: C.hint }, t('restoreHint')),
          h('div', { style: { ...C.mono, marginTop: 6 } }, data && data.restoreScript ? data.restoreScript.cmd : '—'),
        ),

        h(
          'div',
          { style: C.card },
          h('div', { style: C.cardTitle }, t('recentTitle')),
          snapshots.length === 0
            ? h('div', { style: C.hint }, t('noSnapshots'))
            : h(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
                snapshots.slice(0, 10).map((item) =>
                  h(
                    'div',
                    { key: item.name, style: { display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 12, alignItems: 'baseline' } },
                    h(
                      'div',
                      { style: { display: 'flex', gap: 8, alignItems: 'baseline', minWidth: 0 } },
                      h('div', { style: C.mono }, item.name),
                      h(
                        'div',
                        { style: item.partial ? C.dim : item.legacy ? C.dim : item.complete ? C.ok : C.bad },
                        item.partial ? t('partial') : item.legacy ? t('legacy') : item.complete ? t('complete') : t('incomplete'),
                      ),
                    ),
                    h('div', { style: C.dim }, `${item.fileCount != null ? item.fileCount + ' 文件 · ' : ''}${item.bytes != null ? bytes(item.bytes) : ''} ${item.mtime ? when(new Date(item.mtime).toISOString()) : ''}`),
                  ),
                ),
              ),
        ),

        h(
          'div',
          { style: C.card },
          h('div', { style: C.cardTitle }, t('logTitle')),
          h('pre', { style: C.log }, lines.length ? lines.join('\n') : '—'),
        ),
      )
    }

    function mount(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'snapshot-backup: dictionaries')
      const t = ctx.locale.bind(NS)

      report('info', 'client 半加载')

      const offInject = ctx.slots.inject('settings.section', () => {
        const off = ctx.slots.register(
          {
            name: 'settings.section',
            id: 'snapshot-backup',
            order: 17,
            label: () => t('nav'),
            locale: NS,
            inject: () => ({ t }),
          },
          (ownerProps) => h(Panel, { ...ownerProps, t }),
        )
        report('info', 'settings.section 已声明，快照页注册完成')
        return typeof off === 'function' ? off : () => {}
      })

      return typeof offInject === 'function' ? offInject : () => {}
    }

    function report(level, msg) {
      try {
        if (level === 'error') console.error('[dsh-snapshot-backup]', msg)
        fetch(api('/plugins/dsh-backup/clientlog'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ level, msg }),
        }).catch(() => {})
      } catch {}
    }

    function apply(ctx) {
      try {
        return mount(ctx)
      } catch (error) {
        report('error', `挂载失败: ${(error && (error.stack || error.message)) || String(error)}`)
        return () => {}
      }
    }

    return { name, inject, apply }
  },
})
