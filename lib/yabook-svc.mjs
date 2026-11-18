// 雅书适配器：走它自己的登录（账号密码在插件配置里），签到 + 读状态。
// 返回形状照 dsh-yabook-checkin/lib/yabook.mjs 的真实约定：
//   login()      → { ok, jar, user, viaProxy } | { ok:false, reason, network?, authFailed? }
//   signWithJar()→ { ok, already, message, raw } | { ok:false, message, authFailed?, network? }
//   fetchStatus()→ { ok, signedToday, rank, coins, streak, people, text } | { ok:false, reason }
import { login, signWithJar, fetchStatus } from './yabook-api.mjs'

export function configured(cfg = {}) {
  const has = !!(String(cfg.username || '').trim() && String(cfg.password || '').trim())
  return { ok: has, account: cfg.username || '' }
}

export async function status(cfg = {}) {
  const username = String(cfg.username || '').trim()
  const password = String(cfg.password || '').trim()
  if (!username || !password) return { ok: false, needLogin: true, reason: '雅书要账号密码：在设置里填一次' }
  const proxy = cfg.proxy || ''
  const lr = await login({ username, password, proxy })
  if (!lr.ok) return { ok: false, needLogin: true, reason: lr.reason || '雅书登录失败' }
  const st = await fetchStatus({ jar: lr.jar, proxy })
  if (!st.ok) return { ok: false, needLogin: !!st.authFailed, reason: st.reason || '读不到雅书签到状态' }
  return {
    ok: true,
    signedToday: !!st.signedToday,
    canSignin: !st.signedToday,
    streakDays: Number(st.streak || 0),
    coins: st.coins ?? null,
    rank: st.rank ?? null,
    account: st.user || username,
  }
}

export async function signin(cfg = {}) {
  const username = String(cfg.username || '').trim()
  const password = String(cfg.password || '').trim()
  if (!username || !password) return { ok: false, needLogin: true, reason: '雅书要账号密码：在设置里填一次' }
  const proxy = cfg.proxy || ''
  const lr = await login({ username, password, proxy })
  if (!lr.ok) return { ok: false, needLogin: true, reason: lr.reason || '雅书登录失败' }
  const sr = await signWithJar({ jar: lr.jar, proxy })
  const st = await fetchStatus({ jar: lr.jar, proxy })
  if (!sr.ok) {
    return { ok: false, needLogin: !!sr.authFailed, reason: sr.message || '雅书签到失败' }
  }
  return {
    ok: true,
    already: !!sr.already,
    signedToday: st.ok ? !!st.signedToday : true,
    streakDays: st.ok ? Number(st.streak || 0) : 0,
    coins: st.ok ? (st.coins ?? null) : null,
    message: sr.already ? '今天已经签到过了' : sr.message || '签到成功',
  }
}
