/**
 * dsh-checkin-hub —— 浏览器半端（设置 →「统一签到」那一页）
 * ============================================================================
 * ⭐ client bundle **不是 ESM**，是自注册脚本：
 *
 *     window.__ModuleLoader__.load({
 *       id: '<包名>',                       // 必须等于 package.json 的 name
 *       factory: (require) => { ... return { inject: [...], apply(ctx) {...} } },
 *     })
 *
 * 这一页的形状：
 *   · 一屏看完六家今天签没签、连续几天、多少钱/流量 —— 不用再一个个开客户端
 *   · 每家一个开关；关掉的那家定时器就不碰
 *   · 「全部测一下」只读不签；「全部签一遍」是真签（幂等，签过了只会说已签）
 *   · 单独那家也有自己的按钮，免得为了一个坏掉的重试全部
 *
 * ⚠️ 三个踩过的坑，别重犯：
 *   ① 输入框必须绑**本地草稿 state**，不能直接绑轮询回来的 cfg ——
 *      页面每 5 秒刷新一次 /status，直接绑的话用户打到一半的字会被冲掉。
 *   ② jget/jpost 必须看 `res.ok` —— 否则 HTTP 500 会被当成"保存成功"。
 *   ③ 密码 / token 一律用 `__KEEP__` 哨兵：后端见到它就跳过，不覆盖已有值。
 * ============================================================================
 */
window.__ModuleLoader__.load({
  id: 'dsh-checkin-hub',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const API = '/api/checkin-hub'

    const asJson = async (res) => {
      if (res.ok) return res.json()
      const why = res.status === 401 ? '（未登录 / 没权限）' : res.status === 403 ? '（被宿主拦了）' : ''
      throw new Error('HTTP ' + res.status + why)
    }
    const jget = async (p) => asJson(await fetch(API + p, { credentials: 'same-origin' }))
    const jpost = async (p, body) => asJson(await fetch(API + p, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    }))

    const CSS = `
[data-ch-page]{display:flex;flex-direction:column;gap:16px;padding:2px 2px 8px;max-width:720px;}
[data-ch-sec]{display:flex;flex-direction:column;gap:9px;}
[data-ch-h]{font-size:11px;font-weight:600;letter-spacing:.04em;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-ch-row]{display:flex;align-items:center;gap:9px;flex-wrap:wrap;}
[data-ch-grow]{flex:1;min-width:0;}
[data-ch-note]{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-ch-card]{display:flex;flex-direction:column;gap:7px;padding:10px 12px;border-radius:10px;
  background:var(--dsw-alias-bg-layer-4,rgba(128,128,128,.09));
  border:1px solid var(--dsw-alias-bg-layer-3,rgba(255,255,255,.08));}
[data-ch-card][data-off]{opacity:.55;}
[data-ch-top]{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
[data-ch-name]{font-size:13px;font-weight:600;}
[data-ch-input]{width:100%;box-sizing:border-box;padding:6px 8px;border-radius:7px;font-size:12px;
  border:1px solid var(--dsw-alias-bg-layer-3,rgba(255,255,255,.14));
  background:var(--dsw-alias-bg-layer-4,rgba(128,128,128,.12));color:inherit;font-family:inherit;}
[data-ch-input]:focus{outline:none;border-color:#3b82f6;}
[data-ch-input][data-short]{width:72px;}
[data-ch-input][data-wide]{width:280px;}
[data-ch-sw]{flex:none;width:34px;height:20px;border-radius:10px;border:0;cursor:pointer;position:relative;
  background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.35));transition:background .15s;padding:0;}
[data-ch-sw][data-on]{background:#3b82f6;}
[data-ch-sw] i{position:absolute;top:3px;left:3px;width:14px;height:14px;border-radius:50%;background:#fff;
  transition:left .15s;display:block;}
[data-ch-sw][data-on] i{left:17px;}
[data-ch-btn]{padding:5px 10px;border-radius:7px;font-size:11px;cursor:pointer;font-family:inherit;white-space:nowrap;
  border:1px solid var(--dsw-alias-bg-layer-3,rgba(255,255,255,.16));
  background:var(--dsw-alias-bg-layer-4,rgba(128,128,128,.14));color:inherit;}
[data-ch-btn]:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.24));}
[data-ch-btn][data-primary]{background:#3b82f6;border-color:#3b82f6;color:#fff;}
[data-ch-btn][disabled]{opacity:.5;cursor:default;}
[data-ch-msg]{font-size:11px;line-height:16px;padding:7px 9px;border-radius:8px;word-break:break-all;
  background:var(--dsw-alias-bg-layer-4,rgba(128,128,128,.12));}
[data-ch-msg][data-good]{background:rgba(34,197,94,.14);color:#22c55e;}
[data-ch-msg][data-bad]{background:rgba(239,68,68,.14);color:#ef4444;}
[data-ch-msg][data-warn]{background:rgba(245,158,11,.14);color:#f59e0b;}
[data-ch-badge]{font-size:10px;padding:2px 7px;border-radius:999px;background:rgba(128,128,128,.2);}
[data-ch-badge][data-good]{background:rgba(34,197,94,.2);color:#22c55e;}
[data-ch-badge][data-bad]{background:rgba(239,68,68,.2);color:#ef4444;}
[data-ch-badge][data-warn]{background:rgba(245,158,11,.2);color:#f59e0b;}
[data-ch-pre]{font-size:11px;line-height:16px;margin:0;padding:9px;border-radius:8px;overflow:auto;max-height:260px;
  white-space:pre-wrap;word-break:break-all;font-family:ui-monospace,Menlo,Consolas,monospace;
  background:var(--dsw-alias-bg-layer-4,rgba(128,128,128,.1));}
`

    function useStatus(intervalMs) {
      const [st, setSt] = React.useState(null)
      const [fails, setFails] = React.useState(0)
      React.useEffect(() => {
        let alive = true
        const tick = async () => {
          try {
            const d = await jget('/status')
            if (!alive) return
            if (d && d.ok) {
              setSt(d)
              setFails(0)
            } else setFails((n) => n + 1)
          } catch {
            if (alive) setFails((n) => n + 1)
          }
        }
        tick()
        const t = setInterval(tick, intervalMs || 5000)
        return () => {
          alive = false
          clearInterval(t)
        }
      }, [intervalMs])
      return [st, fails]
    }

    const Switch = ({ on, onClick, disabled }) => h('button', {
      'data-ch-sw': '', 'data-on': on ? '' : undefined, disabled,
      onClick, title: on ? '开' : '关',
    }, h('i'))

    const Badge = ({ tone, children }) => h('span', {
      'data-ch-badge': '',
      'data-good': tone === 'good' ? '' : undefined,
      'data-bad': tone === 'bad' ? '' : undefined,
      'data-warn': tone === 'warn' ? '' : undefined,
    }, children)

    /** 一家的今天：签没签 / 连续 / 奖励 */
    function todayLine(entry) {
      const t = entry.today || {}
      const s = t.snapshot || {}
      if (t.ok === true) {
        const bits = []
        if (s.streakDays != null && s.streakDays !== 0) bits.push(`连续 ${s.streakDays} 天`)
        if (s.reward != null && s.reward !== '') bits.push(`奖励 ${s.reward}`)
        if (s.trafficLeft) bits.push(`剩余 ${s.trafficLeft}`)
        if (s.creditsLeft != null) bits.push(`积分 ${s.creditsLeft}`)
        // 多账号的（WorkBuddy / TRAE）：先报"N / M 个账号"，不给单个账号名
        if (s.totalCount > 1) bits.push(`${s.signedCount ?? 0} / ${s.totalCount} 个账号`)
        else if (s.account) bits.push(s.account)
        return { tone: 'good', text: `今天已签 ✓　${bits.join(' · ')}`, at: t.at, message: t.message }
      }
      if (t.ok === false) return { tone: 'bad', text: `今天没签上：${t.message || '未知原因'}`, at: t.at, message: '' }
      return { tone: 'warn', text: '今天还没跑', at: t.at, message: '' }
    }

    /**
     * 多账号明细：WorkBuddy / TRAE 每家可能有好几个账号，
     * 全部签成功才算这一家"全签"，所以要逐个列出来谁是没签的。
     */
    function accountLine(entry) {
      const s = entry.today?.snapshot || {}
      const list = Array.isArray(s.accounts) ? s.accounts : []
      if (list.length <= 1) return null
      return h('div', { 'data-ch-note': '' },
        '账号：' + list.map((a) => `${a.name || a.id}${a.skipped ? '（企业号，无签到）' : a.checkedIn ? ' ✓' : ' ✗'}`).join('　'))
    }

    function Panel() {
      const [st, fails] = useStatus(5000)
      const [busy, setBusy] = React.useState('')
      const [msg, setMsg] = React.useState('')
      const [tone, setTone] = React.useState('')

      // ⚠️ 输入框一律绑本地草稿：轮询回来的 cfg 只用来"首次填一次"
      const [time, setTime] = React.useState(null)
      const [yabookUser, setYabookUser] = React.useState(null)
      const [yabookPass, setYabookPass] = React.useState(null)
      const [showAdv, setShowAdv] = React.useState(false)
      const [dataDir, setDataDir] = React.useState(null)
      const [showLog, setShowLog] = React.useState(false)
      const [log, setLog] = React.useState('')
      const [history, setHistory] = React.useState(null)

      const cfg = st?.cfg
      React.useEffect(() => {
        if (!cfg) return
        if (time === null) setTime(cfg.time || '09:00')
        if (dataDir === null) setDataDir(cfg.dataDir || '')
        if (yabookUser === null) setYabookUser(cfg.providers?.yabook?.username || '')
        if (yabookPass === null) setYabookPass(cfg.providers?.yabook?.hasPassword ? '__KEEP__' : '')
      }, [cfg])

      const say = (text, t) => {
        setMsg(text)
        setTone(t || '')
      }

      const save = async (patch, okText) => {
        setBusy('save')
        try {
          const d = await jpost('/config', patch)
          if (d.ok) say(okText || '存好了', 'good')
          else say(d.error || '没存上', 'bad')
        } catch (e) {
          say('没存上：' + (e?.message ?? e), 'bad')
        } finally {
          setBusy('')
        }
      }

      const onSign = async (only) => {
        setBusy('sign:' + (only || 'all'))
        say('正在签到…', '')
        try {
          const d = await jpost('/sign', only ? { only: [only] } : {})
          if (!d.ok) {
            say(d.message || '没签上', 'bad')
            return
          }
          const parts = []
          for (const [id, r] of Object.entries(d.results || {})) {
            if (r?.skipped) continue
            parts.push(`${id}：${r?.ok ? r.message || '好了' : r?.message || '失败'}`)
          }
          const anyBad = Object.values(d.results || {}).some((r) => r && r.ok === false && !r.skipped)
          say(parts.length ? parts.join('　|　') : '没有要签的（都签过了）', anyBad ? 'warn' : 'good')
        } catch (e) {
          say('签到失败：' + (e?.message ?? e), 'bad')
        } finally {
          setBusy('')
        }
      }

      const onCheck = async () => {
        setBusy('check')
        say('', '')
        try {
          const d = await jpost('/check', {})
          const parts = []
          for (const [id, r] of Object.entries(d.results || {})) {
            parts.push(`${id}：${r?.ok ? (r.signedToday ? '已签' : '未签') : r?.reason || r?.message || '失败'}`)
          }
          say(parts.join('　|　'), 'good')
        } catch (e) {
          say('测试失败：' + (e?.message ?? e), 'bad')
        } finally {
          setBusy('')
        }
      }

      const loadLog = async () => {
        if (showLog) {
          setShowLog(false)
          return
        }
        setBusy('log')
        try {
          const d = await jget('/log')
          setLog(d.text || '（还没有日志）')
          setShowLog(true)
        } catch (e) {
          say('读日志失败：' + (e?.message ?? e), 'bad')
        } finally {
          setBusy('')
        }
      }

      const loadHistory = async () => {
        if (history) {
          setHistory(null)
          return
        }
        setBusy('hist')
        try {
          const d = await jget('/history')
          setHistory(d.lines || [])
        } catch (e) {
          say('读流水失败：' + (e?.message ?? e), 'bad')
        } finally {
          setBusy('')
        }
      }

      if (!st) {
        return h('div', { 'data-ch-page': '' },
          h('div', { 'data-ch-h': '' }, '统一签到'),
          h('div', { 'data-ch-msg': '', 'data-warn': '' },
            fails > 3
              ? '读不到插件状态（已经试了 ' + fails + ' 次）。插件可能没加载成功 —— 看一眼 DSH 的日志，或者在设置 → 插件里确认「统一签到」是开着的。'
              : '读设置中…'))
      }

      const rows = st.providers || []
      const signedCount = rows.filter((r) => r.today?.ok === true).length
      const enabledCount = rows.filter((r) => r.enabled).length

      return h('div', { 'data-ch-page': '' },

        /* ── 顶部 ── */
        h('div', { 'data-ch-sec': '' },
          h('div', { 'data-ch-row': '' },
            h('div', { 'data-ch-grow': '', style: { display: 'flex', alignItems: 'center', gap: '8px' } },
              h('div', { style: { fontSize: '15px', fontWeight: 600 } }, '统一签到'),
              h(Badge, { tone: signedCount === enabledCount && enabledCount > 0 ? 'good' : signedCount > 0 ? 'warn' : 'bad' },
                `今天 ${signedCount} / ${enabledCount}`),
              st.version ? h(Badge, null, 'v' + st.version) : null),
            h('div', { 'data-ch-row': '', style: { flex: 'none' } },
              h('span', { 'data-ch-note': '' }, '总开关'),
              h(Switch, { on: Boolean(cfg.enabled), onClick: () => save({ enabled: !cfg.enabled }), disabled: !!busy }))),

          h('div', { 'data-ch-row': '' },
            h('button', { 'data-ch-btn': '', 'data-primary': '', disabled: !!busy, onClick: () => onSign(null) },
              busy === 'sign:all' ? '签…' : '全部签一遍'),
            h('button', { 'data-ch-btn': '', disabled: !!busy, onClick: onCheck },
              busy === 'check' ? '测…' : '全部测一下'),
            h('button', { 'data-ch-btn': '', disabled: !!busy, onClick: loadHistory },
              history ? '收起流水' : '看流水'),
            h('button', { 'data-ch-btn': '', disabled: !!busy, onClick: loadLog },
              showLog ? '收起日志' : '看日志')),
          h('div', { 'data-ch-note': '' },
            '「全部测一下」只看状态，不会把今天的签到用掉；「全部签一遍」是真签（重复点也安全，签过的只会告诉你已签）。'),
          msg ? h('div', {
            'data-ch-msg': '',
            'data-good': tone === 'good' ? '' : undefined,
            'data-bad': tone === 'bad' ? '' : undefined,
            'data-warn': tone === 'warn' ? '' : undefined,
          }, msg) : null),

        /* ── 六家 ── */
        h('div', { 'data-ch-sec': '' },
          h('div', { 'data-ch-h': '' }, '各家今天'),
          ...rows.map((r) => {
            const line = todayLine(r)
            const pc = cfg.providers?.[r.id] || {}
            return h('div', { 'data-ch-card': '', 'data-off': r.enabled ? undefined : '' },
              h('div', { 'data-ch-top': '' },
                h('div', { 'data-ch-grow': '', style: { display: 'flex', alignItems: 'center', gap: '7px', flexWrap: 'wrap' } },
                  h('div', { 'data-ch-name': '' }, r.label),
                  h(Badge, { tone: line.tone }, line.tone === 'good' ? '已签' : line.tone === 'bad' ? '没签上' : '还没跑'),
                  r.configured ? null : h(Badge, { tone: 'warn' }, '未配置')),
                h('div', { 'data-ch-row': '', style: { flex: 'none' } },
                  h('button', {
                    'data-ch-btn': '', disabled: !!busy,
                    onClick: () => onSign(r.id),
                    title: '只签这一家',
                  }, busy === 'sign:' + r.id ? '签…' : '签'),
                  h(Switch, {
                    on: Boolean(r.enabled), disabled: !!busy,
                    onClick: () => save({ providers: { [r.id]: { enabled: !r.enabled } } }),
                  }))),
              h('div', { 'data-ch-note': '' }, line.text),
              accountLine(r),
              line.at ? h('div', { 'data-ch-note': '' },
                `上次：${new Date(line.at).toLocaleString('zh-CN')}${line.message ? '　' + line.message : ''}`) : null,
              h('div', { 'data-ch-note': '' }, r.hint),

              /* 雅书要账号密码 —— 只有这家需要填 */
              r.id === 'yabook' ? h('div', { 'data-ch-sec': '', style: { gap: '6px', marginTop: '2px' } },
                h('div', { 'data-ch-row': '' },
                  h('input', {
                    'data-ch-input': '', 'data-wide': '', type: 'text', placeholder: '雅书账号（邮箱）',
                    value: yabookUser ?? '', disabled: !!busy, spellCheck: false,
                    onChange: (e) => setYabookUser(e.target.value),
                    onBlur: () => {
                      if (yabookUser !== pc.username) {
                        save({ providers: { yabook: { username: yabookUser } } }, '账号存好了')
                      }
                    },
                  }),
                  h('input', {
                    'data-ch-input': '', 'data-wide': '', type: 'password',
                    placeholder: pc.hasPassword ? `密码已存（尾号 ${pc.passwordTail || '***'}，留空不改）` : '雅书密码',
                    value: yabookPass ?? '', disabled: !!busy, spellCheck: false,
                    onChange: (e) => setYabookPass(e.target.value),
                    onBlur: () => {
                      if (yabookPass !== '__KEEP__' && yabookPass !== '') {
                        save({ providers: { yabook: { password: yabookPass } } }, '密码存好了')
                      }
                    },
                  }))) : null,

              /* Nano 的登录态是从客户端读的，这里只报个来源 */
              r.id === 'nano' && pc.prefsFile ? h('div', { 'data-ch-note': '', style: { wordBreak: 'break-all' } },
                `${pc.tokenSource === 'client' ? '用客户端登录态' : pc.hasToken ? '用手填 token' : '没有登录态'}：${pc.prefsFile}`) : null,
            )
          })),

        /* ── 什么时候签 ── */
        h('div', { 'data-ch-sec': '' },
          h('div', { 'data-ch-h': '' }, '什么时候签'),
          h('div', { 'data-ch-row': '' },
            h('span', { 'data-ch-note': '' }, '每天'),
            h('input', {
              'data-ch-input': '', 'data-short': '', type: 'time', value: time ?? '09:00',
              disabled: !!busy,
              onChange: (e) => setTime(e.target.value),
              onBlur: () => {
                if (time !== cfg.time) save({ time })
              },
            }),
            h('span', { 'data-ch-note': '' }, '之后自动签（电脑开着、DSH 在跑就行）')),
          h('div', { 'data-ch-row': '' },
            h('span', { 'data-ch-note': '' }, '没签上就每'),
            h('input', {
              'data-ch-input': '', 'data-short': '', type: 'number', min: 1, max: 120,
              value: cfg.retryMinutes ?? 15, disabled: !!busy,
              onChange: (e) => save({ retryMinutes: Number(e.target.value) || 15 }),
            }),
            h('span', { 'data-ch-note': '' }, '分钟再试，最多'),
            h('input', {
              'data-ch-input': '', 'data-short': '', type: 'number', min: 0, max: 10,
              value: cfg.maxRetries ?? 4, disabled: !!busy,
              onChange: (e) => {
                const v = e.target.value
                if (v !== '') save({ maxRetries: Number(v) })
              },
            }),
            h('span', { 'data-ch-note': '' }, '次'))),

        /* ── 高级 ── */
        h('div', { 'data-ch-sec': '' },
          h('div', { 'data-ch-row': '' },
            h('div', { 'data-ch-grow': '', 'data-ch-h': '' }, '高级'),
            h('button', { 'data-ch-btn': '', disabled: !!busy, onClick: () => setShowAdv(!showAdv) },
              showAdv ? '收起' : '展开')),
          showAdv ? h('div', { 'data-ch-sec': '' },
            h('div', { 'data-ch-h': '' }, 'DSH 自己的地址（WorkBuddy / TRAE 要走它的本机路由）'),
            h('input', {
              'data-ch-input': '', type: 'text',
              placeholder: '留空自动（' + (cfg.effectiveSelfBase || '') + '）',
              value: dataDir === null ? '' : undefined, disabled: true, style: { display: 'none' },
            }),
            h('div', { 'data-ch-note': '' }, '当前用的是：' + (cfg.effectiveSelfBase || '')),

            h('div', { 'data-ch-h': '' }, '记录放哪儿'),
            h('input', {
              'data-ch-input': '', type: 'text',
              placeholder: '留空 = 默认（' + (st.configDir || '') + '）',
              value: dataDir ?? '', disabled: !!busy, spellCheck: false,
              onChange: (e) => setDataDir(e.target.value),
              onBlur: () => {
                if (dataDir !== cfg.dataDir) save({ dataDir })
              },
            }),
            h('div', { 'data-ch-note': '' },
              'today.json / history.log / checkin.log 会写在这里（要绝对路径）。'),
            h('div', { 'data-ch-note': '' }, '当前记录目录：' + (st.stateDir || '')),
            h('div', { 'data-ch-note': '' },
              '配置文件（含雅书密码）在：' + (st.configDir || '') + '\\config.json —— 只有本插件读它，不会推到 DSH 的设置里。')) : null),

        /* ── 记录 ── */
        h('div', { 'data-ch-sec': '' },
          h('div', { 'data-ch-h': '' }, '记录'),
          history ? h('pre', { 'data-ch-pre': '' }, history.length ? history.join('\n') : '（还没有记录）') : null,
          showLog ? h('pre', { 'data-ch-pre': '' }, log) : null,
          h('div', { 'data-ch-note': '' }, '当前记录目录：' + (st.stateDir || ''))),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const style = document.createElement('style')
        style.setAttribute('data-plugin-css', 'dsh-checkin-hub')
        style.textContent = CSS
        document.head.appendChild(style)
        ctx.effect(() => () => style.remove(), 'dsh-checkin-hub: 设置页样式')

        const slots = (typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || ctx.slots
        if (!slots) return
        slots.inject('settings.section', () => slots.register(
          { name: 'settings.section', id: 'checkin-hub', order: 36, label: '统一签到' },
          () => h(Panel),
        ))
      },
    }
  },
})
