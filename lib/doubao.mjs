// 豆包（Doubao PC）每日签到。
//
// 登录态不用去解 Chromium 的加密 cookie 库 —— 那玩意被进程锁死、还要过 DPAPI+AES-GCM。
// 更省事的一条路：`<User Data>\Local State` 里的
//   saman.local_storage_app_for_web.enterprise  →  JSON 字符串
//      →  x-tt-multi-sids = "<uid>:<sid>|<uid>:<sid>"（URL 编码）
// sid 就是能直接当 sessionid 用的登录票据，uid 当 uid_tt。
// 一台机器上有几个账号就有几段，逐个试，只有能出签到任务的那个是活的
// （飞书企业号没有 daily_signin 任务，会返 710012001 或没有该 kind）。

import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

export const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'DoubaoDesktop/2.32.6 Chrome/147.0.7727.149 Safari/537.36'
export const DETAIL_URL = 'https://www.doubao.com/alice/ug/campaign/v3/detail/'
export const CHECKIN_URL = 'https://www.doubao.com/alice/ug/campaign/landing/checkin'
export const CAMPAIGN_GROUP = 'pc_incentive_task_mvp_v3'
export const LOGIN_INVALID = 710012001
export const NO_ACTIVITY = 710010702

const COMMON_PARAMS = {
  version_code: '20800',
  language: 'zh',
  device_platform: 'web',
  doubao_device_platform: 'web',
  aid: '497858',
  real_aid: '497858',
  pkg_type: 'release_version',
  pc_version: '2.32.6',
  doubao_pc_version: '5.72.66',
  samantha_web: '1',
  web_platform: 'desktop',
  'use-olympus-account': '1',
  web_tab_id: '0',
}

function userDataDirs(customDir) {
  const out = []
  if (customDir && String(customDir).trim()) out.push(String(customDir).trim())
  const local = process.env.LOCALAPPDATA || ''
  if (local) {
    out.push(join(local, 'Doubao', 'User Data'))
    out.push(join(local, 'DoubaoWork', 'User Data'))
    out.push(join(local, 'Doubao', 'User Data', 'Profile 1'))
  }
  const roaming = process.env.APPDATA || ''
  if (roaming) out.push(join(roaming, 'DoubaoWork', 'User Data'))
  return out
}

// 从一个 User Data 目录里把 Local State 读出来 → 账号数组
function accountsFrom(userDataDir) {
  const p = join(userDataDir, 'Local State')
  if (!existsSync(p)) return []
  let raw
  try {
    raw = JSON.parse(readFileSync(p, 'utf8').replace(/^\uFEFF/, ''))
  } catch {
    return []
  }
  const lsw = raw && raw.saman && raw.saman.local_storage_app_for_web
  if (!lsw) return []
  const ent = typeof lsw.enterprise === 'string' ? safeJson(lsw.enterprise) : lsw.enterprise
  const multi = ent && ent['x-tt-multi-sids']
  if (!multi) return []
  let decoded = multi
  try {
    decoded = decodeURIComponent(multi)
  } catch {
    /* 保持原样 */
  }
  const accounts = []
  for (const seg of String(decoded).split('|')) {
    const idx = seg.indexOf(':')
    if (idx <= 0) continue
    const uid = seg.slice(0, idx).trim()
    const sid = seg.slice(idx + 1).trim()
    if (uid && sid) accounts.push({ uid, sid, userDataDir: userDataDir })
  }
  return accounts
}

function safeJson(s) {
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
}

export function listAccounts(customDir) {
  const seen = new Set()
  const out = []
  for (const dir of userDataDirs(customDir)) {
    for (const a of accountsFrom(dir)) {
      const key = `${a.uid}:${a.sid}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push(a)
    }
  }
  return out
}

function deviceIdsFor(seed) {
  const h = createHash('sha256').update(`doubao-dev:${seed}`).digest('hex')
  let webId = '76'
  for (const ch of h.slice(0, 8)) webId += String(Number.parseInt(ch, 16) % 10)
  let tea = ''
  for (const ch of h.slice(8, 16)) tea += String(Number.parseInt(ch, 16) % 10)
  return { web_id: webId, tea_uuid: tea.padEnd(16, '7') }
}

function headersFor(acct) {
  return {
    'content-type': 'application/json',
    accept: 'application/json, text/plain, */*',
    referer: 'https://www.doubao.com/pc/agent-explore',
    origin: 'https://www.doubao.com',
    'user-agent': UA,
    cookie: `sessionid=${acct.sid}; uid_tt=${acct.uid}; uid_tt_ss=${acct.uid}`,
    'x-tt-multi-sids': `${acct.uid}:${acct.sid}`,
  }
}

function queryFor(acct, seed) {
  const ids = deviceIdsFor(seed || acct.uid)
  return new URLSearchParams({
    ...COMMON_PARAMS,
    web_id: ids.web_id,
    tea_uuid: ids.tea_uuid,
    device_id: '',
    region: '',
    sys_region: '',
    uid_tt: acct.uid,
  }).toString()
}

async function post(url, acct, body, seed, timeout) {
  const res = await fetch(url, {
    method: 'POST',
    headers: headersFor(acct),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeout ?? 20000),
  })
  const text = await res.text()
  const json = safeJson(text)
  if (!json) return { ok: false, status: res.status, reason: `豆包返回了非 JSON（HTTP ${res.status}）` }
  if (json.code && json.code !== 0) {
    return {
      ok: false,
      status: res.status,
      code: json.code,
      needLogin: json.code === LOGIN_INVALID,
      noActivity: json.code === NO_ACTIVITY,
      reason: json.msg || json.message || `豆包接口报错 ${json.code}`,
    }
  }
  return { ok: true, status: res.status, data: json.data }
}

function pickSigninTask(data) {
  const tasks = (data && data.tasks) || []
  return tasks.find((t) => t.task_kind === 'daily_signin' || t.campaign_code === 'daily_signin') || null
}

function summarize(acct, data) {
  const task = pickSigninTask(data)
  const dc = (task && task.daily_checkin) || {}
  return {
    ok: true,
    account: acct.uid,
    signedToday: !!dc.checked_in_today,
    canSignin: !dc.checked_in_today,
    streakDays: Number(dc.continuous_days || 0),
    todayReward: Number((dc.reward && dc.reward.reward_amount) || 0),
    totalDays: Number(dc.total_days || 0),
    lastCheckinDate: dc.last_checkin_date || '',
    quota: data && data.progress ? Number(data.progress.total_amount || 0) : null,
    hasTask: !!task,
  }
}

// 逐个账号探测，返回第一个能拿到签到任务的
async function withAccount(accounts, fn, opts) {
  if (!accounts.length) {
    return {
      ok: false,
      needLogin: true,
      reason: '没找到豆包的登录态：Local State 里没有 x-tt-multi-sids（豆包没登录过？）',
    }
  }
  let last = null
  for (const acct of accounts) {
    const r = await fn(acct, opts)
    if (r.ok) return r
    last = r
    if (r.noActivity) continue
  }
  return last || { ok: false, reason: '豆包账号都试过了，没一个有签到活动' }
}

export async function status(cfg = {}) {
  const accounts = listAccounts(cfg.doubaoDir)
  const r = await withAccount(
    accounts,
    async (acct, o) => {
      const url = `${DETAIL_URL}?${queryFor(acct, cfg.seed)}`
      const res = await post(url, acct, { campaign_group_code: CAMPAIGN_GROUP }, cfg.seed, o && o.timeout)
      if (!res.ok) return res
      const s = summarize(acct, res.data)
      if (!s.hasTask) return { ok: false, noActivity: true, reason: '这个豆包账号没有每日签到任务（可能是企业号）' }
      return s
    },
    { timeout: cfg.timeout },
  )
  if (!r.ok) return r
  return { ...r, accounts: accounts.map((a) => a.uid) }
}

export async function signin(cfg = {}) {
  const accounts = listAccounts(cfg.doubaoDir)
  const r = await withAccount(
    accounts,
    async (acct) => {
      const qs = queryFor(acct, cfg.seed)
      const detail = await post(`${DETAIL_URL}?${qs}`, acct, { campaign_group_code: CAMPAIGN_GROUP }, cfg.seed, cfg.timeout)
      if (!detail.ok) return detail
      const before = summarize(acct, detail.data)
      if (!before.hasTask) return { ok: false, noActivity: true, reason: '这个豆包账号没有每日签到任务' }
      if (before.signedToday) return { ok: true, already: true, signedToday: true, streakDays: before.streakDays, todayReward: before.todayReward, account: acct.uid, message: '今天已经签到过了' }

      const claim = await post(`${CHECKIN_URL}?${qs}`, acct, { scene: CAMPAIGN_GROUP }, cfg.seed, cfg.timeout)
      if (!claim.ok) return claim
      const after = await post(`${DETAIL_URL}?${qs}`, acct, { campaign_group_code: CAMPAIGN_GROUP }, cfg.seed, cfg.timeout)
      const sum = after.ok ? summarize(acct, after.data) : before
      return {
        ok: true,
        already: !!(claim.data && claim.data.idempotent),
        signedToday: sum.signedToday,
        streakDays: sum.streakDays,
        todayReward: sum.todayReward,
        account: acct.uid,
        message: claim.data && claim.data.idempotent ? '今天已经签到过了' : '签到成功',
      }
    },
    { timeout: cfg.timeout },
  )
  if (!r.ok) return r
  return { ...r, accounts: accounts.map((a) => a.uid) }
}

export function configured(cfg = {}) {
  const accounts = listAccounts(cfg.doubaoDir)
  return { ok: accounts.length > 0, accounts: accounts.map((a) => a.uid) }
}
