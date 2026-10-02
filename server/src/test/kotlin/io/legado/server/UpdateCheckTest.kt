package io.legado.server

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

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
}
