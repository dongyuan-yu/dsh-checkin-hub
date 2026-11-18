/**
 * dsh-checkin-hub —— host 半端
 * ============================================================================
 * 一句话：把本机上**所有**能签到的软件收进一个定时器、一个设置页、一个工具。
 *
 * 现在收进来的六家（每家的登录态从它自己的客户端里读，本插件不存账号密码）：
 *
 *   id         名字               登录态从哪来
 *   ---------- ------------------ ------------------------------------------------
 *   nano       Nano 加速器         %APPDATA%\test.vpm.pha\nano\shared_preferences.json
 *   yabook     雅书               账号密码（帝国CMS，只能这么来）
 *   minimax    MiniMax Code        <dataParent>\.minimax\auth\prod\cn\mcode-public\auth.json
 *   workbuddy  WorkBuddy          借 dsh-connect-workbuddy 插件的本机路由
 *   trae       TRAE CN            借 dsh-connect-trae 插件的本机路由
 *   doubao     豆包                <User Data>\Local State 的 x-tt-multi-sids
 *
 * 设计上的几条底盘（都是前面单干时撞出来的，别重犯）：
 *   ① **一家失败不能拖垮别家**：六个适配器各自 try，结果各记各的账。
 *   ② **刷新 token 后必须立刻原子写回**（MiniMax 的 RT 是一次性的，
 *      写晚一步磁盘上就是死凭据、用户要重新登录）。
 *   ③ **不存任何第三方密码到 DSH 的 settings 里**：只有本插件自己的 config.json，
 *      而且 /status 永远不回完整密码/token，只回"有没有 + 尾号"。
 *   ④ `ctx.get('dshHomePath')` 返回的是**函数**，不是字符串。
 *   ⑤ 定时器回调抛异常会**带崩宿主进程** ⇒ tick 整体包 try。
 *   ⑥ client bundle 不是 ESM，是 `window.__ModuleLoader__.load({...})` 自注册脚本。
 * ============================================================================
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { join, isAbsolute } from 'node:path'
import { homedir } from 'node:os'

import * as nano from './lib/nano-svc.mjs'
import * as yabook from './lib/yabook-svc.mjs'
import * as minimax from './lib/minimax.mjs'
import * as connect from './lib/connect.mjs'
import * as doubao from './lib/doubao.mjs'

export const name = 'checkin-hub'
/** tools 拿不到也照常加载（只是少一个工具）；webServer 是设置页的命根子 */
export const inject = ['webServer', 'tools']
/** 没有 DSH 原生的设置表单 —— 这一页由 client.js 自己画，值只落插件自己的 config.json */
export const Config = undefined

/* ─────────────────────────── 配置 ─────────────────────────── */

const DEFAULTS = {
  enabled: true,
  time: '09:00',
  retryMinutes: 15,
  maxRetries: 4,
  // 记录目录（留空 = <DSH_HOME>/checkin-hub）
  dataDir: '',
  // DSH 自己的地址：WorkBuddy / TRAE 那两家要走它的本机路由。留空自动猜。
  selfBase: '',
  // 雅书那家可选走本机代理
  proxy: '',
  providers: {
    nano: { enabled: true, token: '', prefsDir: '', baseUrl: '' },
    yabook: { enabled: true, username: '', password: '' },
    minimax: { enabled: true },
    workbuddy: { enabled: true, region: 'cn' },
    trae: { enabled: true, region: 'cn' },
    doubao: { enabled: true, doubaoDir: '' },
  },
}

/** 这些键不回给前端（连尾号都不给的地方另说） */
const SECRET_PATHS = [
  ['providers', 'nano', 'token'],
  ['providers', 'yabook', 'password'],
]

/* ─────────────────────────── 小工具 ─────────────────────────── */

function stateDirOf(ctx, wanted) {
  let dir = ''
  const custom = String(wanted || '').trim()
  if (custom && isAbsolute(custom)) dir = custom
  if (!dir) {
    try {
      const p = typeof ctx.get === 'function' ? ctx.get('dshHomePath') : null
      // ⚠️ dshHomePath 是**函数**，当字符串用会拿到函数源码
      if (typeof p === 'function') dir = p('checkin-hub')
      else if (typeof p === 'string' && p) dir = join(p, 'checkin-hub')
    } catch {
      /* 退到下面 */
    }
  }
  if (!dir) {
    const home = process.env.DSH_HOME || join(homedir(), '.dsh')
    dir = join(home, 'checkin-hub')
  }
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    /* 建不出来就让后面的写操作自己失败 */
  }
  return dir
}

const readJson = (file, fallback) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
  } catch {
    return fallback
  }
}
const writeJson = (file, value) => {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}
const dayKey = (now = new Date()) => {
  const p = (n) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`
}
function normTime(t) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(t || '').trim())
  if (!m) return '09:00'
  const hh = Math.min(23, Math.max(0, Number(m[1])))
  const mm = Math.min(59, Math.max(0, Number(m[2])))
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`
}
const safe = (v) => {
  if (v === undefined || v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v
  try {
    return JSON.parse(JSON.stringify(v))
  } catch {
    return String(v)
  }
}

/** 深合并 + 类型纠正：配置文件被手改坏了也别让插件起不来 */
function normalize(patch, base) {
  const out = { ...base, ...(patch && typeof patch === 'object' ? patch : {}) }
  out.enabled = patch?.enabled === undefined ? Boolean(base.enabled) : Boolean(patch.enabled)
  out.time = normTime(out.time)
  out.retryMinutes = Math.max(1, Math.min(1440, Number(out.retryMinutes) || 15))
  out.maxRetries = Math.max(0, Math.min(50, Number(out.maxRetries) || 0))
  for (const k of ['dataDir', 'selfBase', 'proxy']) out[k] = String(out[k] ?? '').trim()
  const p = patch && patch.providers && typeof patch.providers === 'object' ? patch.providers : null
  const bp = base.providers || DEFAULTS.providers
  out.providers = {}
  for (const id of Object.keys(DEFAULTS.providers)) {
    const d = DEFAULTS.providers[id]
    const b = { ...(bp[id] || d), ...(p?.[id] && typeof p[id] === 'object' ? p[id] : {}) }
    const row = { ...b }
    row.enabled = b.enabled === undefined ? d.enabled : Boolean(b.enabled)
    for (const k of Object.keys(d)) {
      if (k === 'enabled') continue
      if (typeof d[k] === 'string') row[k] = String(b[k] ?? d[k]).trim()
    }
    out.providers[id] = row
  }
  return out
}

/* ─────────────────────────── 适配器注册表 ─────────────────────────── */

/**
 * 每个 provider 都收敛成两个动作：
 *   status(cfg) → { ok, signedToday, streakDays, reward, message?, needLogin?, reason? }
 *   signin(cfg) → { ok, already, signedToday, streakDays, reward, message }
 * 适配器的差异全部在这里抹平，上层（定时器 / HTTP / 工具）只认这两个形状。
 */
const PROVIDERS = [
  {
    id: 'nano',
    label: 'Nano 加速器',
    hint: '直接读客户端的登录态，不用开客户端',
    configured: (c) => nano.configured(c).ok,
    status: (c) => nano.status(c),
    signin: (c) => nano.signin(c),
  },
  {
    id: 'yabook',
    label: '雅书',
    hint: '帝国CMS，只能账号密码登录',
    configured: (c) => Boolean(String(c.username || '').trim() && String(c.password || '').trim()),
    status: (c) => yabook.status({ ...c, proxy: c.__proxy || '' }),
    signin: (c) => yabook.signin({ ...c, proxy: c.__proxy || '' }),
  },
  {
    id: 'minimax',
    label: 'MiniMax Code',
    hint: '读客户端 OAuth 凭据，refresh token 一次性、换完即写回',
    configured: () => minimax.readCredential({}).ok,
    status: async () => {
      const r = await minimax.getStatus({})
      if (!r.ok) return r
      const cr = await minimax.getCredits({})
      return { ...r, reward: cr.ok ? cr.left : undefined, creditsLeft: cr.ok ? cr.left : undefined }
    },
    signin: async () => {
      const r = await minimax.checkin({})
      if (!r.ok) return r
      const cr = await minimax.getCredits({})
      return {
        ...r,
        message: r.already ? '今天已经签到过了' : '签到成功',
        reward: cr.ok ? cr.left : undefined,
        creditsLeft: cr.ok ? cr.left : undefined,
      }
    },
  },
  {
    id: 'workbuddy',
    label: 'WorkBuddy',
    hint: '借 dsh-connect-workbuddy 的本机路由，不重复实现登录；走 /pool 批量，能签全部账号',
    configured: () => true,
    status: async (c) => {
      const r = await connect.workbuddyStatus({ region: c.region || 'cn', selfBase: c.__selfBase })
      if (!r.ok) return r
      return {
        ok: true,
        ready: r.ready,
        signedToday: r.signedToday,
        streakDays: r.streakDays,
        reward: r.todayCredit,
        account: r.account || '',
        accounts: r.accounts,
        signedCount: r.signedCount,
        totalCount: r.totalCount,
        skippedCount: r.skippedCount,
        unsigned: r.unsigned,
      }
    },
    signin: async (c) => {
      const r = await connect.workbuddySignin({ region: c.region || 'cn', selfBase: c.__selfBase })
      if (!r.ok) return r
      return {
        ok: true,
        already: r.already,
        signedToday: r.signedToday,
        streakDays: r.streakDays,
        reward: r.todayCredit,
        accounts: r.accounts,
        signedCount: r.signedCount,
        totalCount: r.totalCount,
        message: r.message,
      }
    },
  },
  {
    id: 'trae',
    label: 'TRAE CN',
    hint: '借 dsh-connect-trae 的本机路由；checkedIn 与 didCheckedIn 是两件事，走 /pool 批量签全部账号',
    configured: () => true,
    status: async (c) => {
      const r = await connect.traeStatus({ region: c.region || 'cn', selfBase: c.__selfBase })
      if (!r.ok) return r
      return {
        ok: true,
        ready: r.ready,
        signedToday: r.signedToday,
        deviceSigned: r.deviceSigned,
        reward: r.todayCredit,
        account: r.account || '',
        accounts: r.accounts,
        signedCount: r.signedCount,
        totalCount: r.totalCount,
        skippedCount: r.skippedCount,
        unsigned: r.unsigned,
      }
    },
    signin: async (c) => {
      const r = await connect.traeSignin({ region: c.region || 'cn', selfBase: c.__selfBase })
      if (!r.ok) return r
      return {
        ok: true,
        already: r.already,
        signedToday: r.signedToday,
        deviceSigned: r.deviceSigned,
        reward: r.todayCredit,
        accounts: r.accounts,
        signedCount: r.signedCount,
        totalCount: r.totalCount,
        message: r.message,
      }
    },
  },
  {
    id: 'doubao',
    label: '豆包',
    hint: '从 Local State 的 x-tt-multi-sids 拿登录票据，不解加密 cookie 库',
    configured: (c) => doubao.configured({ doubaoDir: c.doubaoDir }).ok,
    status: (c) => doubao.status({ doubaoDir: c.doubaoDir, seed: c.__seed }),
    signin: (c) => doubao.signin({ doubaoDir: c.doubaoDir, seed: c.__seed }),
  },
]

const BY_ID = new Map(PROVIDERS.map((p) => [p.id, p]))

/* ─────────────────────────── 插件本体 ─────────────────────────── */

export function apply(ctx, config) {
  const homeDir = stateDirOf(ctx, DEFAULTS.dataDir)
  const cfgFile = join(homeDir, 'config.json')
  // 上次见到的 DSH 本机地址（DSH 每次重启换端口，所以只能边跑边记）
  const selfBaseFile = join(homeDir, 'self-base.json')

  let dataDir = homeDir
  let todayFile = join(dataDir, 'today.json')
  let historyFile = join(dataDir, 'history.log')
  let logFile = join(dataDir, 'checkin.log')

  const log = (msg) => {
    try {
      appendFileSync(logFile, `[${new Date().toISOString()}] ${msg}\n`, 'utf8')
    } catch {
      /* 日志写不进去不该影响签到 */
    }
  }

  let cfg = normalize(readJson(cfgFile, {}), DEFAULTS)

  const applyDataDir = () => {
    const want = String(cfg.dataDir || '').trim()
    const dir = want && isAbsolute(want) ? want : homeDir
    if (dir === dataDir) return
    const from = dataDir
    dataDir = dir
    todayFile = join(dataDir, 'today.json')
    historyFile = join(dataDir, 'history.log')
    logFile = join(dataDir, 'checkin.log')
    try {
      mkdirSync(dataDir, { recursive: true })
      for (const f of ['today.json', 'history.log', 'checkin.log']) {
        const src = join(from, f)
        const dst = join(dataDir, f)
        if (existsSync(src) && !existsSync(dst)) writeFileSync(dst, readFileSync(src))
      }
    } catch {
      /* 搬不动就算了，新记录照样往新目录写 */
    }
  }

  const refreshCfg = () => {
    cfg = normalize(readJson(cfgFile, {}), DEFAULTS)
    applyDataDir()
    return cfg
  }
  applyDataDir()

  /** 存配置：只写本插件自己的文件，**绝不推给 DSH 的 settings**（那里会留明文密码） */
  const saveCfg = (patch) => {
    cfg = normalize(patch, { ...cfg, providers: { ...cfg.providers } })
    writeJson(cfgFile, cfg)
    applyDataDir()
    return cfg
  }

  /**
   * DSH 自己的本机地址 —— WorkBuddy / TRAE 那两家要走它的 loopback 路由。
   *
   * 为什么不能写死：DSH 每次重启都换端口，写死任何一个端口，重启一次就错。
   * 三个来源，按可信度排：
   *   1. `learned` —— 这次启动后真的收到过请求，从 Host 头学到的。最可信。
   *   2. `DSH_WEB_URL` 环境变量 —— DSH 启动时注入的，重启就跟着变。次可信。
   *   3. `self-base.json` 里上次记的 —— 只在没有环境变量时兜底（可能已过期）。
   * 用户在设置页手填的 `cfg.selfBase` 永远排第一。
   */
  const learned = { base: '' }
  let savedBase = ''
  {
    const saved = readJson(selfBaseFile, {})
    const b = saved && typeof saved.base === 'string' ? saved.base : ''
    if (/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(b)) savedBase = b
  }
  const selfBaseNow = () => {
    const trim = (s) => String(s).replace(/\/+$/, '')
    if (cfg.selfBase) return trim(cfg.selfBase)
    if (learned.base) return learned.base
    const env = process.env.DSH_WEB_URL
    if (env) return trim(env)
    return savedBase
  }

  /** 把公共字段塞进每家 provider 的 cfg（selfBase / proxy / 设备种子） */
  const cfgOf = (id) => {
    const c = { ...(cfg.providers[id] || {}) }
    c.__selfBase = selfBaseNow()
    c.__proxy = cfg.proxy
    c.__seed = process.env.COMPUTERNAME || 'hub'
    return c
  }

  /* ── 今天的账 ── */
  const readToday = () => readJson(todayFile, {})
  const todayState = () => {
    const t = readToday()
    const d = dayKey()
    if (!t || t.day !== d) return { day: d, providers: {} }
    return { day: d, providers: t.providers && typeof t.providers === 'object' ? t.providers : {} }
  }
  const putProviderState = (id, patch) => {
    const t = todayState()
    t.providers[id] = { ...(t.providers[id] || {}), ...patch }
    writeJson(todayFile, t)
    return t
  }

  const lastRun = { busy: false, at: 0 }

  /* ── 单家跑一次 ── */
  async function runProvider(id, { force = false, reason = 'manual' } = {}) {
    const def = BY_ID.get(id)
    if (!def) return { ok: false, reason: `没有这家：${id}` }
    const c = cfgOf(id)
    if (!c.enabled) return { ok: false, skipped: true, message: '这家没开' }

    const st = todayState().providers[id] || {}
    if (!force && st.ok === true) return { ok: true, skipped: true, message: `今天（${todayState().day}）已经签过了`, state: st }

    const attempt = Number(st.attempts || 0) + 1
    putProviderState(id, { lastTry: new Date().toISOString(), attempts: attempt })

    const at = () => new Date().toISOString()
    try {
      if (!def.configured(c)) {
        const message = '还没有登录态 —— 打开一次客户端登录上，或在设置页里补上'
        putProviderState(id, { ok: false, message, at: at() })
        log(`[${id}] 未配置：${message}`)
        return { ok: false, needLogin: true, message }
      }

      let r
      if (force) {
        r = await def.signin(c)
      } else {
        const now = await def.status(c)
        if (!now.ok) {
          const message = now.needLogin
            ? `登录态失效（${now.reason || now.message || '需要重新登录'}）`
            : now.reason || now.message || '读状态失败'
          putProviderState(id, { ok: false, message, at: at() })
          log(`[${id}] 读状态失败：${message}`)
          return { ok: false, needLogin: Boolean(now.needLogin), message }
        }
        if (now.signedToday) {
          const snap = { ...now }
          delete snap.panel
          delete snap.raw
          putProviderState(id, { ok: true, message: '今天已经签到过了', at: at(), snapshot: snap })
          return { ok: true, already: true, message: '今天已经签到过了', snapshot: snap }
        }
        r = await def.signin(c)
      }

      if (!r.ok) {
        const message = r.needLogin
          ? `登录态失效（${r.reason || r.message || '需要重新登录'}）`
          : r.reason || r.message || '签到失败'
        putProviderState(id, { ok: false, message, at: at() })
        log(`[${id}] 签到失败：${message}`)
        return { ok: false, needLogin: Boolean(r.needLogin), message }
      }

      // 签完复读一次，拿最新的连续天数 / 余额
      let after = null
      try {
        after = await def.status(c)
      } catch {
        after = null
      }
      const snap = after && after.ok ? after : r
      delete snap.panel
      delete snap.raw
      const message = r.already ? '今天已经签到过了' : r.message || '签到成功'
      putProviderState(id, { ok: true, message, at: at(), snapshot: snap })

      try {
        appendFileSync(
          historyFile,
          `${todayState().day} ${id} ${r.already ? 'ALREADY' : 'OK'} ` +
            `days=${snap.streakDays ?? '-'} 奖励=${snap.reward ?? '-'} — ${message}\n`,
          'utf8',
        )
      } catch {
        /* 记不上不影响主流程 */
      }
      log(`[${id}] ${r.already ? '已签过' : '成功'}：连续 ${snap.streakDays ?? '?'} 天（attempt ${attempt}，${reason}）`)
      return { ok: true, already: Boolean(r.already), message, snapshot: snap }
    } catch (e) {
      const message = `出错了：${e?.message ?? e}`
      putProviderState(id, { ok: false, message, at: at() })
      log(`[${id}] 抛异常：${message}`)
      return { ok: false, message }
    }
  }

  /** 全部跑一遍（一家抛异常不影响别家） */
  async function runAll({ force = false, only = null, reason = 'manual' } = {}) {
    if (lastRun.busy) return { ok: false, busy: true, message: '上一次还在跑，等它跑完' }
    lastRun.busy = true
    try {
      const ids = (only && only.length ? only : PROVIDERS.map((p) => p.id)).filter((id) => BY_ID.has(id))
      const results = {}
      for (const id of ids) {
        results[id] = await runProvider(id, { force, reason })
      }
      lastRun.at = Date.now()
      return { ok: true, day: todayState().day, results }
    } finally {
      lastRun.busy = false
    }
  }

  /* ── 定时器：每分钟醒一次对墙上时间（长 setTimeout 熬不过睡眠/改时钟） ── */
  let timer = null
  const tick = async () => {
    try {
      refreshCfg()
      if (!cfg.enabled) return
      const now = new Date()
      const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
      if (hhmm < cfg.time) return
      const st = todayState()
      for (const def of PROVIDERS) {
        const pcfg = cfg.providers[def.id] || {}
        if (!pcfg.enabled) continue
        const s = st.providers[def.id] || {}
        if (s.ok === true) continue
        if (Number(s.attempts || 0) > cfg.maxRetries) continue
        if (s.lastTry) {
          const gapMin = (now.getTime() - new Date(s.lastTry).getTime()) / 60000
          if (gapMin < cfg.retryMinutes) continue
        }
        await runProvider(def.id, { reason: 'timer' })
      }
    } catch (e) {
      log(`定时器出错（已兜住，不影响宿主）：${e?.message ?? e}`)
    }
  }

  try {
    ctx.effect(() => {
      timer = setInterval(() => {
        tick()
      }, 60_000)
      // 启动时先看一眼：万一 DSH 下午才开、今天还没签，别等到明天
      setTimeout(() => {
        tick()
      }, 10_000)
      return () => {
        if (timer) clearInterval(timer)
        timer = null
      }
    }, 'checkin-hub: 每日签到定时器')
    log(`已挂载（配置：${homeDir}，记录：${dataDir}，每天 ${cfg.time}，${PROVIDERS.length} 家）`)
  } catch (e) {
    log(`定时器没挂上：${e?.message ?? e}`)
  }

  /* ── 给设置页用的 HTTP 接口 ── */
  const sendJson = (res, code, obj) => {
    try {
      res.statusCode = code
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      res.setHeader('Cache-Control', 'no-store')
      res.end(JSON.stringify(obj))
    } catch {
      /* 连接早断了 */
    }
  }
  const readBody = (req) =>
    new Promise((resolve) => {
      const chunks = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8')
        try {
          resolve(raw ? JSON.parse(raw) : {})
        } catch {
          resolve({})
        }
      })
      req.on('error', () => resolve({}))
    })

  /** DSH 的信任栅栏：真鉴权在这里（认 cookie/token），我们那层同源只是兜底 */
  let connCached = null
  let connTried = false
  const getConnection = () => {
    if (connTried) return connCached
    connTried = true
    const tries = [
      () => (typeof ctx.get === 'function' ? ctx.get('connection') : null),
      () => Reflect.get(ctx, 'connection'),
      () => (ctx.root && typeof ctx.root === 'object' ? ctx.root.connection : null),
    ]
    for (const fn of tries) {
      try {
        const c = fn()
        if (c && typeof c.requestRejection === 'function') {
          connCached = c
          return c
        }
      } catch {
        /* 换下一个 */
      }
    }
    return null
  }
  const fenceReject = (req, res) => {
    const conn = getConnection()
    if (!conn) return false
    try {
      const rejection = conn.requestRejection({ headers: req.headers })
      if (rejection === undefined) return false
      res.statusCode = typeof rejection === 'number' ? rejection : 403
      try {
        res.end()
      } catch {
        /* 忽略 */
      }
      return true
    } catch {
      res.statusCode = 403
      try {
        res.end()
      } catch {
        /* 忽略 */
      }
      return true
    }
  }
  const sameOriginOk = (req) => {
    const origin = req.headers?.origin || req.headers?.referer || ''
    if (!origin) return true
    try {
      const o = new URL(origin)
      const host = String(req.headers?.host || '')
      if (o.host === host) return true
      return o.hostname === '127.0.0.1' || o.hostname === 'localhost'
    } catch {
      return false
    }
  }

  /** 给前端的一面镜子：**绝不返回完整密码 / token**，只给"有没有 + 尾号" */
  const publicCfg = () => {
    const p = {}
    for (const def of PROVIDERS) {
      const c = cfg.providers[def.id] || {}
      const row = { enabled: Boolean(c.enabled) }
      if (def.id === 'nano') {
        row.prefsDir = c.prefsDir || ''
        row.baseUrl = c.baseUrl || ''
        row.hasToken = Boolean(c.token) || nano.configured({ prefsDir: c.prefsDir }).ok
        row.tokenSource = nano.configured({ prefsDir: c.prefsDir }).tokenSource
        row.tokenTail = c.token ? String(c.token).slice(-6) : ''
        row.prefsFile = nano.configured({ prefsDir: c.prefsDir }).prefsFile
      } else if (def.id === 'yabook') {
        row.username = c.username || ''
        row.hasPassword = Boolean(c.password)
        row.passwordTail = c.password ? String(c.password).slice(-3) : ''
      } else if (def.id === 'workbuddy' || def.id === 'trae') {
        row.region = c.region || 'cn'
      } else if (def.id === 'doubao') {
        row.doubaoDir = c.doubaoDir || ''
      }
      p[def.id] = row
    }
    return {
      enabled: cfg.enabled,
      time: cfg.time,
      retryMinutes: cfg.retryMinutes,
      maxRetries: cfg.maxRetries,
      dataDir: cfg.dataDir,
      selfBase: cfg.selfBase,
      proxy: cfg.proxy,
      effectiveSelfBase: selfBaseNow(),
      providers: p,
    }
  }

  const handle = async (req, res, url) => {
    const p = url.pathname.replace(/^\/api\/checkin-hub/, '') || '/'
    const method = (req.method || 'GET').toUpperCase()

    // 记下这次请求的 authority：DSH 每次重启换端口，这是唯一永远正确的来源。
    // 定时器（没有请求上下文）之后就用它。
    try {
      const host = String(req.headers?.host || '')
      if (/^(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(host)) {
        const b = `http://${host}`
        if (learned.base !== b) {
          learned.base = b
          if (savedBase !== b) {
            savedBase = b
            writeJson(selfBaseFile, { base: b, at: new Date().toISOString() })
          }
        }
      }
    } catch {
      /* 记不上不影响主流程 */
    }

    if (method === 'GET' && (p === '/status' || p === '/')) {
      refreshCfg()
      const st = todayState()
      const rows = []
      for (const def of PROVIDERS) {
        const c = cfgOf(def.id)
        let configured = false
        try {
          configured = def.configured(c)
        } catch {
          configured = false
        }
        rows.push({
          id: def.id,
          label: def.label,
          hint: def.hint,
          enabled: Boolean(c.enabled),
          configured,
          today: st.providers[def.id] || null,
        })
      }
      sendJson(res, 200, {
        ok: true,
        version: myVersion(),
        day: st.day,
        configDir: homeDir,
        stateDir: dataDir,
        cfg: publicCfg(),
        providers: rows,
        busy: lastRun.busy,
        serverNow: new Date().toISOString(),
      })
      return
    }

    if (method === 'POST' && p === '/config') {
      const patch = await readBody(req)
      const clean = {}
      for (const k of ['enabled', 'time', 'retryMinutes', 'maxRetries', 'dataDir', 'selfBase', 'proxy']) {
        if (k in patch) clean[k] = patch[k]
      }
      if (patch.providers && typeof patch.providers === 'object') {
        clean.providers = {}
        for (const id of Object.keys(DEFAULTS.providers)) {
          const src = patch.providers[id]
          if (!src || typeof src !== 'object') continue
          const row = {}
          for (const [k, v] of Object.entries(src)) {
            if (!(k in DEFAULTS.providers[id])) continue
            if (v === '__KEEP__') continue // 前端没改就别覆盖（密码/token 都走这条）
            row[k] = v
          }
          if (Object.keys(row).length) clean.providers[id] = row
        }
      }
      if (!Object.keys(clean).length) {
        sendJson(res, 400, { ok: false, error: '没有可保存的项' })
        return
      }
      saveCfg(clean)
      sendJson(res, 200, { ok: true, stateDir: dataDir, configDir: homeDir, cfg: publicCfg() })
      return
    }

    // 「测一下」：只读状态，**不签到**（别把今天的签掉）
    if (method === 'POST' && p === '/check') {
      refreshCfg()
      const body = await readBody(req)
      const only = Array.isArray(body?.only) ? body.only : null
      const ids = (only || PROVIDERS.map((x) => x.id)).filter((id) => BY_ID.has(id))
      const out = {}
      for (const id of ids) {
        const def = BY_ID.get(id)
        const c = cfgOf(id)
        try {
          if (!def.configured(c)) {
            out[id] = { ok: false, needLogin: true, reason: '还没有登录态' }
            continue
          }
          out[id] = await def.status(c)
        } catch (e) {
          out[id] = { ok: false, reason: `出错了：${e?.message ?? e}` }
        }
      }
      sendJson(res, 200, { ok: true, results: safe(out) })
      return
    }

    if (method === 'POST' && p === '/sign') {
      const body = await readBody(req)
      const only = Array.isArray(body?.only) ? body.only : null
      const r = await runAll({ force: true, only, reason: 'manual' })
      sendJson(res, 200, safe(r))
      return
    }

    if (method === 'GET' && p === '/history') {
      let text = ''
      try {
        text = readFileSync(historyFile, 'utf8')
      } catch {
        text = ''
      }
      sendJson(res, 200, { ok: true, lines: text.trim() ? text.trim().split('\n').slice(-80) : [] })
      return
    }

    if (method === 'GET' && p === '/log') {
      let text = ''
      try {
        text = readFileSync(logFile, 'utf8')
      } catch {
        text = ''
      }
      sendJson(res, 200, { ok: true, text: text.split('\n').slice(-150).join('\n') })
      return
    }

    sendJson(res, 404, { ok: false, error: `没有这个接口：${method} ${p}` })
  }

  try {
    ctx.effect(
      () =>
        ctx.webServer.register({
          kind: 'prefix',
          path: '/api/checkin-hub',
          handler: async (req, res) => {
            if (fenceReject(req, res)) return
            if (!sameOriginOk(req)) {
              try {
                sendJson(res, 403, { ok: false, error: '只接受本机同源请求' })
              } catch {
                /* 忽略 */
              }
              return
            }
            try {
              await handle(req, res, new URL(req.url, 'http://127.0.0.1'))
            } catch (e) {
              try {
                sendJson(res, 500, { ok: false, error: e?.message ?? String(e) })
              } catch {
                /* 忽略 */
              }
            }
          },
        }),
      'checkin-hub: /api/checkin-hub 路由',
    )
  } catch (e) {
    log(`HTTP 路由没挂上：${e?.message ?? e}`)
  }

  /* ── 给模型用的工具（拿不到 tools 就跳过，别让整条插件不激活） ──
   * ⚠️ spec **必须带 `output: { schema, render }`**，否则宿主直接拒。
   */
  try {
    if (ctx.tools?.register) {
      const textOutput = {
        schema: { type: 'object', properties: {}, additionalProperties: true },
        render: (_args, value) => [
          { type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) },
        ],
      }

      ctx.tools.register({
        name: 'checkin_hub',
        description:
          '统一签到中心：Nano 加速器 / 雅书 / MiniMax Code / WorkBuddy / TRAE / 豆包。' +
          'action=sign 立刻全部签一次（幂等，已签会如实说明）；action=status 只查各家今日状态不签到。' +
          '可选 service 只处理某一家（nano/yabook/minimax/workbuddy/trae/doubao）。',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['sign', 'status'], description: 'sign=签到，status=只查状态' },
            service: {
              type: 'string',
              enum: ['all', 'nano', 'yabook', 'minimax', 'workbuddy', 'trae', 'doubao'],
              description: '只处理这一家，默认 all',
            },
          },
          required: ['action'],
          additionalProperties: false,
        },
        output: textOutput,
        async execute(args) {
          const action = String(args?.action || 'status')
          const svc = String(args?.service || 'all')
          const only = svc === 'all' ? null : [svc]
          refreshCfg()

          if (action === 'status') {
            const ids = (only || PROVIDERS.map((x) => x.id)).filter((id) => BY_ID.has(id))
            const out = {}
            for (const id of ids) {
              const def = BY_ID.get(id)
              const c = cfgOf(id)
              try {
                if (!def.configured(c)) {
                  out[id] = { ok: false, message: '还没有登录态' }
                  continue
                }
                const s = await def.status(c)
                out[id] = {
                  ok: Boolean(s.ok),
                  signedToday: s.signedToday ?? null,
                  streakDays: s.streakDays ?? null,
                  reward: s.reward ?? null,
                  message: s.ok ? (s.signedToday ? '今天已经签过了' : '今天还没签') : s.reason || s.message || '失败',
                }
              } catch (e) {
                out[id] = { ok: false, message: `出错了：${e?.message ?? e}` }
              }
            }
            return safe({ ok: true, day: todayState().day, services: out })
          }

          const r = await runAll({ force: true, only, reason: 'tool' })
          return safe(r)
        },
      })
    }
  } catch (e) {
    log(`工具没注册上：${e?.message ?? e}`)
  }

  function myVersion() {
    try {
      return readJson(new URL('./package.json', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), {}).version || ''
    } catch {
      return ''
    }
  }
}
