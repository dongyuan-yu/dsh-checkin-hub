/**
 * lib/yabook.mjs —— 雅书（帝国CMS）这一侧的三个动作：登录 / 签到 / 读状态
 * ============================================================================
 * 全部是 2026-11-05 在这台机器上**对着真站点验过**的，不是猜的：
 *
 * ① 登录  POST https://yabook.blog/e/member/doaction.php
 *        body: enews=login&username=<账号>&password=<密码>&tobind=0&lifetime=86400&is_ajax=1&ecmsfrom=
 *        成功：正文含 `登录成功!`，同时下发 cookie rysnzmlauth / rysnzmlrnd / rysnzmluserid / rysnzmlusername
 *        失败：正文含 `您的用户名或密码有误!`
 *    ⚠️ 登录页本身**不下发任何 cookie**（`curl -c` 后罐是空的），所以"先拿 CSRF"这一步是多余的；
 *       真正的凭证只在登录成功那一下给。照抄"先 GET 登录页"只是浪费一次请求。
 *
 * ② 签到  GET https://yabook.blog/e/extend/sign/sign_ajax.php?action=sign
 *        成功：{"status":1,"message":"...","data":...}
 *        已签：{"status":0,"message":"您今天已经签到过了，明天再来吧！"}
 *        未登录：{"status":0,"message":"请先登录！"}
 *        认不出的 action：{"status":0,"message":"未知操作！"}   ← 我们试过 sign/1/do/daily/check，只有 `sign` 对
 *    ⇒ **幂等且安全**：重复调用只会告诉你"已经签过了"，不会重复发币。这一点很关键，
 *      它让「每天多试几次」「失败了重试」都不会有副作用。
 *
 * ③ 状态  GET https://yabook.blog/e/member/sign/
 *        页面里能读出：今日已签/未签、当前排名、今日雅币、连续签到天数、今日排行榜
 *    ⚠️ 路径**必须带尾斜杠**：不带会 301，多花一次往返。
 * ============================================================================
 */
import { CookieJar, request } from './http.mjs'

export const BASE = 'https://yabook.blog'
export const LOGIN_URL = `${BASE}/e/member/doaction.php`
export const SIGN_AJAX = `${BASE}/e/extend/sign/sign_ajax.php`
export const SIGN_PAGE = `${BASE}/e/member/sign/`
export const CP_PAGE = `${BASE}/e/member/cp/`

/** 站点上「没登录」的判定文案（三个页面用的都是这张提示页） */
const NOT_LOGGED_IN = /您还没登录/

/** 从一页 HTML 里剥掉脚本样式，压成一行纯文本（用来找关键词最省事） */
export function toText(html) {
  return String(html || '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&copy;/g, '©')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 静态资源 / 表单以外的页面判断：这页是不是那张"您还没登录"的提示页 */
export function looksLoggedOut(html) {
  return NOT_LOGGED_IN.test(String(html || ''))
}

/**
 * 登录。成功返回 { ok:true, jar, user:{id,name} }；失败返回 { ok:false, reason }
 * ⚠️ 绝不把密码写进日志 / 返回值。
 */
export async function login({ username, password, proxy = '', timeout = 30_000 }) {
  if (!username || !password) return { ok: false, reason: '还没填账号或密码' }

  const jar = new CookieJar()
  const body = new URLSearchParams({
    enews: 'login',
    username,
    password,
    tobind: '0',
    lifetime: '86400',
    is_ajax: '1',
    ecmsfrom: '',
  }).toString()

  let res
  try {
    res = await request({
      url: LOGIN_URL,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer': `${BASE}/e/member/login/`,
        'X-Requested-With': 'XMLHttpRequest',
        'Origin': BASE,
      },
      body,
      proxy,
      timeout,
      jar,
    })
  } catch (e) {
    return { ok: false, reason: `连不上雅书：${e?.message ?? e}`, network: true }
  }

  const text = res.text || ''
  // ⚠️ 帝国CMS 连密码错都返 200，所以**只能看正文**，不能看状态码
  if (/登录成功/.test(text)) {
    const user = {
      id: jar.get('rysnzmluserid') || '',
      name: jar.get('rysnzmlusername') || '',
      groupId: jar.get('rysnzmlgroupid') || '',
    }
    return { ok: true, jar, user, viaProxy: res.viaProxy }
  }

  // ⚠️ 正则**不能**写成 `<b[^>]*>` —— 那个会匹配到 `<body>`，于是"提示文字"变成整页的
  //    `- MESSAGE - 您的用户名或密码有误!`（2026-11-05 实测踩到）。
  //    合法开标签是 `<b>` 或 `<b class="...">`，中间必须有空白，所以用 `<b(?:\s[^>]*)?>`。
  const all = [...text.matchAll(/<b(?:\s[^>]*)?>([\s\S]*?)<\/b>/g)].map((m) => toText(m[1])).filter(Boolean)
  const msg = all.length ? all[all.length - 1] : ''
  return {
    ok: false,
    reason: msg || `登录没成功（HTTP ${res.status}，站点没给提示文字）`,
    authFailed: /密码|用户名|帐号/.test(msg || ''),
    viaProxy: res.viaProxy,
  }
}

/**
 * 对现成的 cookie 罐签到。
 * 返回 { ok, already, message, raw }
 *    ok=true  already=false ⇒ 这次真签上了
 *    ok=true  already=true  ⇒ 今天早签过了（正常，不是错误）
 *    ok=false               ⇒ 出错，message 里是原因；authFailed=true 表示 cookie 失效要重新登录
 */
export async function signWithJar({ jar, proxy = '', timeout = 30_000 }) {
  let res
  try {
    res = await request({
      url: `${SIGN_AJAX}?action=sign`,
      headers: {
        'Referer': SIGN_PAGE,
        'X-Requested-With': 'XMLHttpRequest',
        'Accept': 'application/json, text/javascript, */*; q=0.01',
      },
      proxy,
      timeout,
      jar,
    })
  } catch (e) {
    return { ok: false, message: `连不上雅书：${e?.message ?? e}`, network: true }
  }

  if (res.status !== 200) {
    return { ok: false, message: `签到接口返回 HTTP ${res.status}` }
  }

  // 正常是个 JSON；万一被踢去登录页会是整页 HTML —— 两种都兜住
  if (!res.json) {
    if (looksLoggedOut(res.text)) return { ok: false, message: '登录已失效，要重新登录', authFailed: true }
    return { ok: false, message: '签到接口没给 JSON（站点可能改了）', raw: String(res.text || '').slice(0, 200) }
  }

  const { status, message } = res.json
  const msg = String(message || '')

  if (status === 1) return { ok: true, already: false, message: msg, raw: res.json }

  if (/已经签到过|已签到/.test(msg)) return { ok: true, already: true, message: msg, raw: res.json }
  if (/请先登录|还没登录/.test(msg)) return { ok: false, message: msg, authFailed: true }
  return { ok: false, message: msg || '签到失败（站点没给原因）', raw: res.json }
}

/**
 * 读签到页，把页面上那几个数字扒出来。
 * 返回 { ok, signed, rank, coins, streak, signedToday, people } 或 { ok:false, reason }
 *
 * 页面结构（2026-11-05 实测）：
 *   已签：<button class="layui-btn layui-btn-disabled" disabled>今日已签到 ✓</button>
 *   未签：按钮可点，文案里没有「今日已签到」
 *   三个数字：当前排名 `第 <b ...>0</b> 名` / 今日雅币 `<b ...>0</b> 个` / 连续签到 `<b ...>4</b> 天`
 */
export async function fetchStatus({ jar, proxy = '', timeout = 30_000 }) {
  let res
  try {
    res = await request({ url: SIGN_PAGE, proxy, timeout, jar })
  } catch (e) {
    return { ok: false, reason: `连不上雅书：${e?.message ?? e}`, network: true }
  }

  if (looksLoggedOut(res.text)) return { ok: false, reason: '登录已失效', authFailed: true }
  if (res.status !== 200) return { ok: false, reason: `签到页返回 HTTP ${res.status}` }

  const html = res.text
  const text = toText(html)

  const signedToday = /今日已签到/.test(text)

  const numAfter = (re) => {
    const m = re.exec(html)
    return m ? Number(String(m[1]).replace(/<[^>]*>/g, '').trim()) : null
  }
  // 三个数字各认两遍：先按结构找，再按纯文本兜底（站点改 class 名时不至于全崩）
  const rank = numAfter(/当前排名[\s\S]{0,80}?<b[^>]*>(\d+)<\/b>/) ?? numAfter(/当前排名\s*第\s*(\d+)\s*名/)
  const coins = numAfter(/今日雅币[\s\S]{0,80}?<b[^>]*>(\d+)<\/b>/) ?? numAfter(/今日雅币\s*(\d+)\s*个/)
  const streak = numAfter(/连续签到[\s\S]{0,80}?<b[^>]*>(\d+)<\/b>/) ?? numAfter(/连续签到\s*(\d+)\s*天/)

  // 今日排行榜：`1 A apollodsa 10 雅币` 这种四段
  const people = []
  const rankBlock = /今日签到排行榜([\s\S]*?)签到规则/.exec(text)
  if (rankBlock) {
    const seg = rankBlock[1]
    const rowRe = /(\d{1,3})\s+(\S)\s+(\S+)\s+(\d+)\s*雅币/g
    let m
    while ((m = rowRe.exec(seg)) && people.length < 10) {
      people.push({ rank: Number(m[1]), initial: m[2], name: m[3], coins: Number(m[4]) })
    }
  }

  return { ok: true, signedToday, rank, coins, streak, people, text: text.slice(0, 600) }
}

/** 一步到位：登录 + 签到 + 读状态（每次真正执行签到都走这条，省一次会话复用） */
export async function loginSignAndRead({ username, password, proxy = '', timeout = 30_000 }) {
  const lg = await login({ username, password, proxy, timeout })
  if (!lg.ok) return { ok: false, stage: 'login', message: lg.reason, authFailed: lg.authFailed, network: lg.network }

  const sg = await signWithJar({ jar: lg.jar, proxy, timeout })
  const st = await fetchStatus({ jar: lg.jar, proxy, timeout })

  return {
    ok: sg.ok,
    stage: 'sign',
    already: Boolean(sg.already),
    message: sg.message,
    authFailed: sg.authFailed,
    network: sg.network,
    user: lg.user,
    status: st.ok ? { signedToday: st.signedToday, rank: st.rank, coins: st.coins, streak: st.streak, people: st.people } : null,
    statusError: st.ok ? '' : st.reason,
    viaProxy: Boolean(lg.viaProxy),
  }
}
