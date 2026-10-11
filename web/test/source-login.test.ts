import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { api } from '../src/lib/api.ts'

test('Source Login API Client - getSourceLoginUi, save, action, check, and delete', async () => {
  const originalFetch = globalThis.fetch
  const capturedRequests: { url: string; method?: string; headers: Headers; body?: any }[] = []

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers)
    capturedRequests.push({
      url: input.toString(),
      method: init?.method || 'GET',
      headers,
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    })

    const urlStr = input.toString()
    if (urlStr.includes('/login-ui')) {
      return new Response(JSON.stringify({
        sourceId: 'https://test.com',
        sourceName: '测试源',
        hasLogin: true,
        loginUi: [
          { name: '用户名', type: 'text' },
          { name: '密码', type: 'password' },
          { name: '登录', type: 'button', action: 'login(true)' }
        ],
        loginInfo: { 用户名: 'admin' },
        loginHeader: '{"Token":"abc"}',
        sourceVariable: 'v123',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }

    if (urlStr.includes('/login-action')) {
      return new Response(JSON.stringify({
        success: true,
        toastMessages: ['登录成功'],
        openUrl: 'https://test.com/home',
        copyText: 'token123',
        reRenderUi: true,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }

    if (urlStr.includes('/login-check')) {
      return new Response(JSON.stringify({
        loggedIn: true,
        message: '登录态有效',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  try {

    // 1. getSourceLoginUi
    const ui = await api.getSourceLoginUi('https://test.com')
    assert.equal(ui.sourceName, '测试源')
    assert.equal(ui.loginUi.length, 3)
    assert.equal(ui.loginInfo['用户名'], 'admin')
    assert.equal(capturedRequests[0].method, 'GET')
    assert.ok(capturedRequests[0].url.includes('/api/sources/https%3A%2F%2Ftest.com/login-ui'))

    // 2. saveSourceLoginInfo
    const saveRes = await api.saveSourceLoginInfo('https://test.com', { 用户名: 'newuser', 密码: 'pass' })
    assert.equal(saveRes.ok, true)
    assert.equal(capturedRequests[1].method, 'POST')
    assert.equal(capturedRequests[1].headers.get('X-CSRF-Token'), null)
    assert.deepEqual(capturedRequests[1].body, { loginInfo: { 用户名: 'newuser', 密码: 'pass' } })

    // 3. executeSourceLoginAction
    const actionRes = await api.executeSourceLoginAction('https://test.com', 'login(true)', { 用户名: 'newuser' }, false)
    assert.equal(actionRes.success, true)
    assert.deepEqual(actionRes.toastMessages, ['登录成功'])
    assert.equal(actionRes.openUrl, 'https://test.com/home')
    assert.equal(actionRes.copyText, 'token123')
    assert.equal(actionRes.reRenderUi, true)
    assert.equal(capturedRequests[2].method, 'POST')

    // 4. checkSourceLogin
    const checkRes = await api.checkSourceLogin('https://test.com')
    assert.equal(checkRes.loggedIn, true)
    assert.equal(checkRes.message, '登录态有效')

    // 5. clearSourceLoginHeader
    const delHeader = await api.clearSourceLoginHeader('https://test.com')
    assert.equal(delHeader.ok, true)
    assert.equal(capturedRequests[4].method, 'DELETE')

    // 6. clearSourceLoginInfo
    const delInfo = await api.clearSourceLoginInfo('https://test.com')
    assert.equal(delInfo.ok, true)
    assert.equal(capturedRequests[5].method, 'DELETE')
  } finally {
    globalThis.fetch = originalFetch
  }
})

/**
 * 「书签同步」那段 javascript: 代码跑在**目标站点的页面上**，是跨站请求：
 * 服务端 `POST /api/sources/{id}/login-cookie` 只放行确实属于该书源域名的 Origin
 * （`Routes.kt` 的 `allowCookieSyncOrigin`），跨域不同就回 403 并带一个能 parse 的 JSON 错误体。
 * 第一版写的是 `.then(r => r.json()).then(() => alert('已把…同步进青阅'))` —— 不判 `r.ok`，
 * 于是**被拒绝也报成功**，用户看到的是一句假话加上界面毫无变化。
 * 这段代码是拼在模板字符串里的，跑不进 jsdom，所以钉源码结构。
 */
test('书签代码必须先判响应状态，被闸门挡下时不许报成功', () => {
  const code = fs.readFileSync(path.resolve(import.meta.dirname, '../src/sources', 'SourceLoginModal.tsx'), 'utf8')
  const bookmarklet = code.match(/const bookmarkletCode[\s\S]*?\n  \}, \[sourceId\]\)/)
  assert.ok(bookmarklet, '书签代码要还在（换了实现就同步改这条判据）')
  const body = bookmarklet[0]
  assert.ok(/ok:r\.ok/.test(body), '要带 ok:r.ok —— 否则 403 的 JSON 体也算成功')
  assert.ok(/同步失败/.test(body), '非 2xx 要报失败')
  assert.ok(!/\.then\(function\(r\)\{return r\.json\(\)\}\)\.then\(function\([^)]*\)\{alert\('已把/.test(body),
    '反向对照：不判状态直接 alert 成功的那种写法要清零')
})
