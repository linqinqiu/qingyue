package io.legado.server

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import io.legado.server.ops.UpdateCheck

/**
 * 「关于 → 检查更新」的版本比较（用户 2026-10-02）。
 * 只测纯函数，不打网络 —— 网络那一半失败要有可读的说法，由界面门禁判。
 */
class UpdateCheckTest {
    @Test
    fun `tag 的 v 前缀与位数不齐都不影响判断`() {
        assertTrue(UpdateCheck.isNewer("v0.4.0", "0.3.0"))
        assertTrue(UpdateCheck.isNewer("0.3.1", "0.3.0"))
        assertTrue(UpdateCheck.isNewer("0.3", "0.2.9"))
        assertFalse(UpdateCheck.isNewer("0.3.0", "0.3.0"))
        assertFalse("只是前缀不同，不是新版本", UpdateCheck.isNewer("v0.3.0", "0.3.0"))
        assertFalse("旧版不能反过来报有更新", UpdateCheck.isNewer("0.3.0", "0.4.1"))
    }

    @Test
    fun `拿不到 latest 就说没有，不当成有更新`() {
        assertFalse(UpdateCheck.isNewer("", "0.3.0"))
        assertFalse(UpdateCheck.isNewer("  ", "0.3.0"))
    }

    @Test
    fun `比不了的写法只判字面不同，但绝不把降级算成更新`() {
        // 预发布/后缀这种四段写法没法逐段比数字，保守判"不同即提示"，让用户自己点进去看
        assertTrue(UpdateCheck.isNewer("0.4.0-rc1", "0.3.9"))
        assertFalse(UpdateCheck.isNewer("0.3.0", "0.3.0"))
    }

    @Test
    fun `请求头前缀只能是 ASCII（中文应用名当头像值会把接口炸成 500）`() {
        // 实测：`User-Agent: 青阅/0.6.3` 让 JDK 在建请求时抛 `invalid header value`，
        // 而那段代码在 runCatching 之外 → 异常冲出路由 → 接口 500，界面把它念成「检查请求没有发出去」。
        assertTrue(UpdateCheck.userAgentPrefix.matches(Regex("^[\\x21-\\x7E]+$")))
        assertFalse("显示名不能进请求头", UpdateCheck.userAgentPrefix.contains(BuildInfo.title))
    }

    @Test
    fun `没配仓库地址时如实回 not_configured，不发请求也不抛`() {
        org.junit.Assume.assumeTrue("这台机器配了 LEGADO_REPO，跳过", UpdateCheck.repository.isBlank())
        val result = UpdateCheck.check("0.6.3")
        assertTrue("没配仓库应当回 not_configured，实到 ${result.status}", result.status == "not_configured")
        // 原来这里兜底填了 `lukelzlz/legado-server`（代码 clone 来的地方），于是「关于」页
        // 把别人家名字当成本项目的开发者、项目主页与检查更新目标。用户 2026-10-05 明确不许。
        assertTrue("未配置时不许回落到任何仓库 slug", result.repository.isBlank())
    }
}
