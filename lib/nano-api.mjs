/**
 * Nano 加速器（v2board 系后端）的最小客户端
 * ============================================================================
 * 这个文件只干一件事：把 Nano 那几个接口调通。UI / 定时器 / 落盘都在 index.js。
 *
 * 🔴 三条踩出来的规矩，别改：
 *   ① **服务端有 User-Agent 白名单。** 不带 `Dart/x.y (dart:io)` 时，几乎全部
 *      `/user/*` 接口都回 `200` + `Content-Type: application/octet-stream` +
 *      `Content-Length: 0` —— 空 body，**静默失败**。用 curl / Mozilla UA 全都这样，
 *      表现为"请求成功但啥也没有"。所以 `call()` 见到 200+空 body 会自动换 UA 重试。
 *   ② **鉴权头是 `Authorization: <token 原样>`**，不加 `Bearer ` 前缀。
 *   ③ **签到是 POST**，GET 回 405；而且必须带 `Content-Type: application/json`，
 *      不然 400。重复签是安全的：回 `400` + `今天已经签到过了`（幂等，可用来判"已签"）。
 *
 * 基址不是写死的：客户端自己会去 OSS 上的一份 u.json 里取 `url`，说明他们随时会换域名。
 * 所以默认先问 u.json，问不到再退回已知地址；也可以由设置页直接填死。
 * ============================================================================
 */

/** 已知可用基址（2026-11-18 实测） */
export const DEFAULT_BASE = 'https://account.alibaba.alicdn.men/api/v1'
/** 客户端自己的"配置中心"，里面 `{ url, chatUrl, owUrl }` */
const DISCOVERY_URL = 'https://nanoapi.oss-ap-northeast-1.aliyuncs.com/u.json'

export const DEFAULT_UA = 'Dart/3.5 (dart:io)'
/** 白名单里还可能认别的版本，主 UA 被拒时挨个试 */
const ALT_UA = ['Dart/3.7 (dart:io)', 'Dart/3.9 (dart:io)', 'Dart/3.3 (dart:io)']

/* ─────────────────────────── 基址发现 ─────────────────────────── */

let baseCache = { at: 0, url: '' }

/**
 * 拿到 API 基址。
 * 优先级：设置页填的死地址 > u.json 里的 url > 已知地址。
 * u.json 结果缓存 1 小时（每次签到都去问一遍太浪费）。
 */
export async function resolveBase({ baseUrl = '', timeout = 15000 } = {}) {
  const fixed = String(baseUrl || '').trim()
  if (fixed) return fixed.replace(/\/+$/, '')

  const now = Date.now()
  if (baseCache.url && now - baseCache.at < 3600_000) return baseCache.url

  try {
    const r = await fetch(DISCOVERY_URL, {
      headers: { 'User-Agent': 'Dart/3.5 (dart:io)', Accept: '*/*' },
      signal: AbortSignal.timeout(Math.min(timeout, 8000)),
    })
    const j = await r.json()
    const u = String(j?.url || '').trim()
    if (/^https?:\/\//i.test(u)) {
      baseCache = { at: now, url: u.replace(/\/+$/, '') }
      return baseCache.url
    }
  } catch { /* 问不到就用已知的 */ }

  baseCache = { at: now, url: DEFAULT_BASE }
  return DEFAULT_BASE
}

/* ─────────────────────────── 底层请求 ─────────────────────────── */

async function once({ base, path, method = 'GET', token = '', ua = DEFAULT_UA, body, timeout = 15000 }) {
  const url = `${base.replace(/\/+$/, '')}${path}`
  const headers = { 'User-Agent': ua, Accept: '*/*' }
  if (token) headers.Authorization = token        // ⚠️ 不要加 Bearer
  if (body !== undefined) headers['Content-Type'] = 'application/json'

  const r = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
    redirect: 'follow',
  })
  const text = await r.text()
  return { status: r.status, text }
}

/**
 * 发一次请求并解析。
 * 见到 `200 + 空 body` 就当"被 UA 白名单丢了"，换个 Dart 版本再试一轮。
 * 全都被丢就如实返回 empty:true，让上层能说清原因。
 */
export async function call(opts) {
  let r
  try {
    r = await once(opts)
  } catch (e) {
    return { ok: false, network: true, reason: `连不上签到服务器：${e?.message ?? e}` }
  }

  if (r.status === 200 && !r.text) {
    for (const ua of ALT_UA) {
      try {
        const r2 = await once({ ...opts, ua })
        if (r2.text) { r = r2; break }
      } catch { /* 换下一个 */ }
    }
  }

  if (!r.text) {
    return {
      ok: false,
      empty: true,
      status: r.status,
      reason: '服务端把请求当成了非客户端流量（UA 白名单），返回了空响应',
    }
  }

  let json = null
  try { json = JSON.parse(r.text) } catch { /* 非 JSON，下面按失败处理 */ }
  if (!json || typeof json !== 'object') {
    return { ok: false, status: r.status, reason: `响应不是 JSON（HTTP ${r.status}）`, raw: r.text.slice(0, 300) }
  }
  return { ok: true, status: r.status, json }
}

/** 服务端的统一包络：{ status, message, data, error }。把"业务失败"和"网络失败"分开报 */
function unwrap(r, what) {
  if (!r.ok) return r
  const j = r.json
  const msg = String(j.message || '')
  if (j.status === 'success') return { ok: true, status: r.status, data: j.data ?? null, message: msg }
  // 「未登录或登陆已过期」= token 废了，要人回客户端重登
  if (/未登录|登陆已过期|登录已过期|token/i.test(msg)) {
    return { ok: false, needLogin: true, status: r.status, message: msg || `${what}：登录已失效` }
  }
  return { ok: false, status: r.status, message: msg || `${what}失败` }
}

/* ─────────────────────────── 业务接口 ─────────────────────────── */

/**
 * 读签到状态。
 * 返回的关键字段：canCheckin / checkinDays / lastCheckinAt(秒) / nextRewardTraffic /
 * checkinTraffic / totalTraffic。
 * ⚠️ 光看 `can_checkin` 分不出"今天签过了"和"不许签" —— 判"今天签没签"要看 last_checkin_at。
 */
export async function getCheckinStatus(opts) {
  const r = await call({ ...opts, path: '/user/checkinStatus', method: 'GET' })
  const u = unwrap(r, '读签到状态')
  if (!u.ok) return u
  const d = u.data || {}
  return {
    ok: true,
    canCheckin: d.can_checkin === true,
    checkinDays: Number(d.checkin_days) || 0,
    lastCheckinAt: Number(d.last_checkin_at) || 0,
    nextRewardGb: Number(d.next_reward_gb) || 0,
    nextRewardTraffic: String(d.next_reward_traffic || ''),
    checkinTraffic: String(d.checkin_traffic || ''),
    totalTraffic: String(d.total_traffic || ''),
  }
}

/** 账号信息：邮箱 / 总流量(字节) / 到期(秒) / 套餐 id */
export async function getUser(opts) {
  const r = await call({ ...opts, path: '/user/info', method: 'GET' })
  const u = unwrap(r, '读账号信息')
  if (!u.ok) return u
  const d = u.data || {}
  return {
    ok: true,
    email: String(d.email || ''),
    transferEnable: Number(d.transfer_enable) || 0,
    expiredAt: Number(d.expired_at) || 0,
    planId: Number(d.plan_id) || 0,
    balance: Number(d.balance) || 0,
  }
}

/** 订阅：上行 u / 下行 d（字节）+ 套餐名 —— 用来看"还剩多少流量" */
export async function getSubscribe(opts) {
  const r = await call({ ...opts, path: '/user/getSubscribe', method: 'GET' })
  const u = unwrap(r, '读订阅信息')
  if (!u.ok) return u
  const d = u.data || {}
  const plan = d.plan || {}
  return {
    ok: true,
    up: Number(d.u) || 0,
    down: Number(d.d) || 0,
    transferEnable: Number(d.transfer_enable) || 0,
    expiredAt: Number(d.expired_at) || 0,
    planName: String(plan.name || ''),
  }
}

/**
 * 签到。幂等：今天签过了服务端回 400 +「今天已经签到过了」，这里翻成 already:true / ok:true，
 * 免得定时器把"已签"当失败一直重试。
 */
export async function checkin(opts) {
  const r = await call({ ...opts, path: '/user/checkin', method: 'POST', body: {} })
  if (!r.ok) return r

  const j = r.json
  const msg = String(j.message || '')
  if (j.status === 'success') return { ok: true, already: false, message: msg || '签到成功' }
  if (/已经签到|已签到|重复签到/.test(msg)) return { ok: true, already: true, message: msg || '今天已经签到过了' }
  if (/未登录|登陆已过期|登录已过期/.test(msg)) {
    return { ok: false, needLogin: true, status: r.status, message: msg || '登录已失效，需要重新登录 Nano 客户端' }
  }
  return { ok: false, status: r.status, message: msg || `签到失败（HTTP ${r.status}）` }
}

/* ─────────────────────────── 小工具 ─────────────────────────── */

/** 字节 → "5.54 GB" */
export function fmtGb(bytes) {
  const n = Number(bytes) || 0
  if (n <= 0) return '0 GB'
  const gb = n / 1024 / 1024 / 1024
  return gb >= 100 ? `${gb.toFixed(0)} GB` : `${gb.toFixed(2)} GB`
}

/** 秒级时间戳 → 本机 "YYYY-MM-DD HH:MM" */
export function fmtTime(sec) {
  const n = Number(sec) || 0
  if (!n) return ''
  const d = new Date(n * 1000)
  const p = (x) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 秒级时间戳 → 本机日期 "YYYY-MM-DD"（判"今天签没签"用） */
export function dayOf(sec) {
  const n = Number(sec) || 0
  if (!n) return ''
  const d = new Date(n * 1000)
  const p = (x) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
