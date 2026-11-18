// MiniMax Code 签到适配器。
//
// 登录态在 <dataParent>\.minimax\auth\<buildEnv>\<region>\mcode-public\auth.json，
// 而 dataParent 常常不在 ~ 下 —— 要从 %APPDATA%\MiniMax\minimax-agent-cn-config.json
// 的 config.localRuntimeDataParentDir 读出来（用户可能把它改到任意盘）。
//
// 三条硬规矩（都是实测撞出来的）：
// 1) refresh token 一次性。换完必须立刻原子写回，否则旧 RT 作废、磁盘留死凭据。
// 2) 不需要 x-signature / x-timestamp，只发 Bearer 就能 200。
// 3) 签到是幂等的，已签时 claim 也返 200，要看 status.days[is_today].status 判已签。

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'

export const CLIENT_ID = 'mcode-public'
export const SCOPES = ['agent.default']
export const AUDIENCE = 'agent-backend'
export const CHECKIN_TZ = 'Asia/Shanghai'
export const UA =
  'MiniMaxAgent Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'MiniMax/3.1.15 Chrome/148.0.7778.280 Safari/537.36'

const MATRIX = {
  'cn:prod': 'https://agent.minimax.cn',
  'cn:dev': 'https://agent.minimax.cn',
  'en:prod': 'https://agent.minimax.io',
  'en:dev': 'https://agent.minimax.io',
}
const ACCOUNT = {
  cn: 'https://account.minimax.cn',
  en: 'https://account.minimax.io',
}

export const DAY_STATUS = { upcoming: 1, claimable: 2, claimed: 3, disabled: 4 }

function readJsonSafe(p) {
  try {
    return JSON.parse(readFileSync(p, 'utf8').replace(/^\uFEFF/, ''))
  } catch {
    return null
  }
}

// 粗粒度定位凭据目录。返回 {dataDir, buildEnv, region, authFile, stateFile, why}
export function locate(opts = {}) {
  const tried = []
  const env = opts.dataDir && String(opts.dataDir).trim()
  if (env) {
    tried.push(env)
    const r = expand(env)
    if (r) return r
  }

  // %APPDATA%\MiniMax\minimax-agent-cn-config.json → localRuntimeDataParentDir
  const appdata = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming')
  const cfgFile = join(appdata, 'MiniMax', 'minimax-agent-cn-config.json')
  const cfg = readJsonSafe(cfgFile)
  // 注意：这两个键在 config 子对象里，不在顶层（踩过）。
  const c = (cfg && cfg.config) || cfg || {}
  const parents = []
  if (typeof c.localRuntimeDataParentDir === 'string') parents.push(c.localRuntimeDataParentDir)
  if (Array.isArray(c.localRuntimePreviousDataParentDirs)) {
    for (const d of c.localRuntimePreviousDataParentDirs) if (typeof d === 'string') parents.push(d)
  }
  for (const parent of parents) {
    for (const name of ['.minimax', '.mavis']) {
      const d = join(parent, name)
      if (existsSync(d)) {
        tried.push(d)
        const r = expand(d)
        if (r) return r
      }
    }
  }

  for (const name of ['.minimax', '.mavis']) {
    const d = join(homedir(), name)
    tried.push(d)
    const r = expand(d)
    if (r) return r
  }

  return { why: `没找到 MiniMax Code 的登录态。找过：${tried.join(' | ') || '(无)'}` }

  function expand(dataDir) {
    // 先从 auth-state.json 拿 buildEnv / region；拿不到就扫目录
    const namespaces = []
    for (const buildEnv of ['prod', 'dev']) {
      for (const region of ['cn', 'en']) {
        const dir = join(dataDir, 'auth', buildEnv, region, CLIENT_ID)
        if (existsSync(join(dir, 'auth.json'))) namespaces.push({ buildEnv, region, dir })
      }
    }
    if (!namespaces.length) return null
    const stateFile = join(dataDir, 'auth', 'auth-state.json')
    const state = readJsonSafe(stateFile)
    let pick = namespaces[0]
    if (state && state.buildEnv && state.region) {
      const hit = namespaces.find((n) => n.buildEnv === state.buildEnv && n.region === state.region)
      if (hit) pick = hit
    }
    return {
      dataDir,
      buildEnv: pick.buildEnv,
      region: pick.region,
      authFile: join(pick.dir, 'auth.json'),
      stateFile: existsSync(stateFile) ? stateFile : join(pick.dir, 'auth-state.json'),
      namespaces,
    }
  }
}

function pickRecord(auth) {
  const records = (auth && auth.records) || {}
  for (const [key, value] of Object.entries(records)) {
    if (key.includes('.mcode.oauth.')) return { key, value }
  }
  const first = Object.entries(records)[0]
  return first ? { key: first[0], value: first[1] } : null
}

export function readCredential(opts = {}) {
  const loc = locate(opts)
  if (!loc.authFile) return { ok: false, reason: loc.why || '没找到 auth.json', tried: loc }
  const auth = readJsonSafe(loc.authFile)
  const rec = pickRecord(auth)
  if (!rec) return { ok: false, reason: 'auth.json 里没有 MiniMax Code 的授权记录', ...loc }
  return { ok: true, ...loc, auth, key: rec.key, rec: rec.value }
}

// 原子写回：先写 .tmp 再 rename，避免半截文件让客户端也读坏。
function writeBack(loc, auth, key, next) {
  auth.records = auth.records || {}
  auth.records[key] = next
  const tmp = `${loc.authFile}.hub.tmp`
  mkdirSync(dirname(loc.authFile), { recursive: true })
  writeFileSync(tmp, JSON.stringify(auth, null, 2), 'utf8')
  renameSync(tmp, loc.authFile)

  if (loc.stateFile && existsSync(loc.stateFile)) {
    const st = readJsonSafe(loc.stateFile) || {}
    st.status = 'authenticated'
    st.buildEnv = loc.buildEnv
    st.region = loc.region
    st.expiresAtMs = next.expiresAtMs
    st.generation = next.generation
    const stTmp = `${loc.stateFile}.hub.tmp`
    writeFileSync(stTmp, JSON.stringify(st, null, 2), 'utf8')
    renameSync(stTmp, loc.stateFile)
  }
}

async function refresh(loc, auth, key, rec, opts = {}) {
  const accountOrigin = ACCOUNT[loc.region] || ACCOUNT.cn
  const form = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: rec.refreshToken,
    client_id: CLIENT_ID,
    scope: SCOPES.join(' '),
    audience: AUDIENCE,
  })
  const res = await fetch(`${accountOrigin}/oauth2/token`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
      'user-agent': UA,
    },
    body: form.toString(),
    signal: AbortSignal.timeout(opts.timeout ?? 20000),
  })
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    /* 非 JSON */
  }

  if (res.status >= 400 || !json || !json.access_token) {
    const code = (json && (json.error || json.error_description)) || text.slice(0, 200)
    const dead = /invalid_grant/i.test(String(code))
    return {
      ok: false,
      needLogin: true,
      reason: dead
        ? 'MiniMax Code 的 refresh token 已失效，需要在客户端里重新登录（插件会再提醒）'
        : `刷新 MiniMax 登录态失败（HTTP ${res.status}）：${String(code).slice(0, 200)}`,
    }
  }

  const generation = Number(rec.generation || 0) + 1
  const loginEpoch = rec.loginEpoch || cryptoRandom()
  const next = {
    ...rec,
    accessToken: json.access_token,
    refreshToken: json.refresh_token || rec.refreshToken,
    tokenType: json.token_type || rec.tokenType || 'Bearer',
    scopes: SCOPES,
    audience: AUDIENCE,
    clientId: CLIENT_ID,
    expiresAtMs: Date.now() + Number(json.expires_in || 43200) * 1000,
    generation,
    loginEpoch,
  }
  // ★ 必须在用之前写回：旧 RT 换完就作废了，写晚一步磁盘上就是死凭据。
  writeBack(loc, auth, key, next)
  return { ok: true, rec: next, refreshed: true, generation }
}

function cryptoRandom() {
  try {
    return globalThis.crypto.randomUUID()
  } catch {
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`
  }
}

async function accessToken(opts = {}) {
  const cred = readCredential(opts)
  if (!cred.ok) return cred
  const { rec, auth, key } = cred
  const loc = { dataDir: cred.dataDir, buildEnv: cred.buildEnv, region: cred.region, authFile: cred.authFile, stateFile: cred.stateFile }
  const minValidity = opts.minValidityMs ?? 5 * 60_000
  if (!opts.force && Number(rec.expiresAtMs || 0) - Date.now() > minValidity) {
    return { ok: true, token: rec.accessToken, loc, refreshed: false }
  }
  const r = await refresh(loc, auth, key, rec, opts)
  if (!r.ok) return { ...r, loc }
  return { ok: true, token: r.rec.accessToken, loc, refreshed: true }
}

async function call(path, opts = {}) {
  const t = await accessToken(opts)
  if (!t.ok) return t
  const base = MATRIX[`${t.loc.region}:${t.loc.buildEnv}`] || MATRIX[`${t.loc.region}:prod`] || MATRIX['cn:prod']
  const res = await fetch(`${base}${path}`, {
    method: opts.method || 'GET',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      'user-agent': UA,
      origin: base,
      referer: `${base}/`,
      authorization: `Bearer ${t.token}`,
    },
    body: opts.body,
    signal: AbortSignal.timeout(opts.timeout ?? 20000),
  })
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    /* ignore */
  }
  if (res.status === 401 || res.status === 403) {
    return {
      ok: false,
      needLogin: true,
      status: res.status,
      reason: `MiniMax 说登录态无效（HTTP ${res.status} ${String(text).slice(0, 120)}）`,
    }
  }
  if (res.status >= 400 || !json) {
    return { ok: false, status: res.status, reason: `MiniMax 接口返回 HTTP ${res.status}：${String(text).slice(0, 200)}` }
  }
  const code = json.base_resp && json.base_resp.status_code
  if (code !== undefined && code !== 0) {
    return {
      ok: false,
      code,
      reason: `MiniMax 接口报错 ${code}：${(json.base_resp && json.base_resp.status_msg) || ''}`,
    }
  }
  return { ok: true, data: json.data !== undefined ? json.data : json, raw: json }
}

export function summarizePanel(panel) {
  const days = (panel && panel.days) || []
  const today = days.find((d) => d.is_today)
  const claimable = days.some((d) => d.status === DAY_STATUS.claimable)
  const claimedToday = !!today && today.status === DAY_STATUS.claimed
  const streak = days.filter((d) => d.status === DAY_STATUS.claimed).length
  return {
    signedToday: claimedToday || (!today && !claimable && days.length > 0),
    canSignin: claimable,
    todayPoints: today ? today.points : null,
    streakDays: streak,
    panel,
  }
}

export async function getStatus(opts = {}) {
  const r = await call(`/minimax-cloud/api/v1/signin/status?timezone_id=${encodeURIComponent(CHECKIN_TZ)}`, opts)
  if (!r.ok) return r
  const panel = (r.data && r.data.days) ? r.data : r.data && r.data.panel ? r.data.panel : r.data
  const s = summarizePanel(panel)
  return { ok: true, ...s }
}

export async function checkin(opts = {}) {
  const r = await call(`/minimax-cloud/api/v1/signin/claim?timezone_id=${encodeURIComponent(CHECKIN_TZ)}`, {
    ...opts,
    method: 'POST',
    body: opts.body ?? '',
  })
  if (!r.ok) return r
  const panel = (r.data && r.data.panel) ? r.data.panel : r.data
  const s = summarizePanel(panel)
  return { ok: true, already: !s.canSignin && s.signedToday, ...s }
}

export async function getCredits(opts = {}) {
  const r = await call('/minimax-cloud/api/v1/credit/details', opts)
  if (!r.ok) return r
  const details = (r.data && r.data.details) || []
  let left = 0
  for (const d of details) left += Number(d.remaining_amount || 0)
  return { ok: true, details, left: Math.round(left * 100) / 100 }
}
