package io.legado.server


/**
 * 规则切分层：对应上游 model/analyzeRule/RuleAnalyzer —— 先把整条规则切成分支、内联 JS 段、索引段，再交给取值层。
 */

/**
 * 切分 Legado 的 `a||b||c` 备选规则，只在 `{{…}}` 之外切：
 * `{{$.book_id||$.BookID}}` 里的 `||` 属于占位符内部的路径备选，不能当外层分支。
 */
internal fun splitLegadoAlternatives(rule: String): List<String> {
    val (separator, parts) = splitLegadoBranches(rule)
    return if (separator == "||") parts else listOf(rule.trim()).filter { it.isNotEmpty() }
}

/**
 * Legado 的分支规则：`||` 取第一个有结果的分支，`&&` 把所有分支的结果拼接起来。
 * 依据上游 `RuleAnalyzer.splitRule("&&","||","%%")`：**无优先级、最左边的分隔符说了算**，
 * 并且切分要跳过 `{{…}}`、`[…]`（JSONPath 过滤谓词里本来就带 `&&`/`||`）、引号与 `##正则##` 段，
 * 否则 `$.book[?(@.price<10 && @.cat=="x")]` 会被从中间劈开。
 */
internal fun splitLegadoBranches(rule: String): Pair<String?, List<String>> {
    val separators = topLevelSeparators(rule)
    val separator = separators.firstOrNull()?.second ?: return null to listOf(rule.trim()).filter { it.isNotEmpty() }
    val parts = mutableListOf<String>()
    var start = 0
    for ((index, token) in separators.filter { it.second == separator }) {
        parts += rule.substring(start, index)
        start = index + token.length
    }
    parts += rule.substring(start)
    return separator to parts.map { it.trim() }.filter { it.isNotEmpty() }
}

private fun topLevelSeparators(rule: String): List<Pair<Int, String>> {
    val found = mutableListOf<Pair<Int, String>>()
    var depth = 0
    var quote: Char? = null
    var index = 0
    while (index < rule.length) {
        val ch = rule[index]
        when {
            quote != null -> if (ch == quote) quote = null
            ch == '\'' || ch == '"' -> quote = ch
            ch == '{' || ch == '[' -> depth++
            ch == '}' || ch == ']' -> depth = (depth - 1).coerceAtLeast(0)
            ch == '#' && rule.startsWith("##", index) -> {
                val end = rule.indexOf("##", index + 2)
                index = if (end < 0) rule.length else end + 1
            }
            depth == 0 && rule.startsWith("||", index) -> { found += index to "||"; index++ }
            depth == 0 && rule.startsWith("&&", index) -> { found += index to "&&"; index++ }
        }
        index++
    }
    return found
}

/**
 * 在 `{{…}}` 之外找内联 JS 分隔符，返回「位置 + 分隔符长度」。
 * 行首的 `@js:` 由调用方先行处理，所以只认下标 > 0 的情况。
 */
internal fun findInlineJsMarker(rule: String): Pair<Int, Int>? {
    var depth = 0
    var index = 0
    while (index < rule.length) {
        when (val ch = rule[index]) {
            '{' -> depth++
            '}' -> depth = (depth - 1).coerceAtLeast(0)
            '@' -> if (depth == 0 && rule.startsWith("@js:", index)) return index to 4
            'j' -> if (depth == 0 && rule.startsWith("js:", index) &&
                (index == 0 || rule[index - 1] == ' ' || rule[index - 1] == '\n')
            ) return index to 3
        }
        index++
    }
    return null
}

/**
 * Legado 选择器尾部的**索引段**（上游 `AnalyzeByJSoup` 的「索引列表处理器」）：
 * `tag!0,2` 从结果列表里排除第 0、2 个，`tag[1]`/`tag[-1]` 取第 2 个/最后一个，
 * `tag[1:4]`、`tag[0:6:2]` 是区间与步长。负数一律从尾部数。
 *
 * 注意 `[attr=val]` 这种 CSS 属性选择器**不是**索引，内容必须是数字/冒号/逗号/负号才算。
 * 以前 `!N` 被映射成 `:not(:nth-child(N+1))`：nth-child 数的是同一父元素下的兄弟，
 * 而 Legado 数的是**这条规则匹配到的列表**，两者在真实 DOM 里通常不等，取错元素还不报错。
 */
internal fun splitIndexSuffix(rule: String): Pair<String, List<String>> {
    val tokens = mutableListOf<String>()
    var text = rule.trimEnd()
    while (text.isNotEmpty()) {
        if (text.endsWith("]")) {
            val open = text.lastIndexOf('[')
            val inner = if (open >= 0) text.substring(open + 1, text.length - 1) else ""
            if (open < 0 || !Regex("[\\d\\s,:\\-]+").matches(inner) || !inner.any { it.isDigit() }) break
            tokens.add(0, inner)
            text = text.substring(0, open).trimEnd()
        } else {
            val match = Regex("!([\\d\\s,:\\-]*)$").find(text) ?: break
            val inner = match.groupValues[1]
            if (!inner.any { it.isDigit() }) break
            tokens.add(0, "!$inner")
            text = text.substring(0, match.range.first).trimEnd()
        }
    }
    return text to tokens
}

/** 把索引段作用到已匹配列表上（保持文档顺序）。 */
internal fun <T> applyIndexTokens(input: List<T>, tokens: List<String>): List<T> {
    var current = input
    for (token in tokens) {
        if (current.isEmpty()) return emptyList()
        current = if (token.startsWith("!")) {
            val drop = parseIndexSpec(token.removePrefix("!"), current.size).toSet()
            current.filterIndexed { index, _ -> index !in drop }
        } else {
            parseIndexSpec(token, current.size).mapNotNull { current.getOrNull(it) }
        }
    }
    return current
}

/** `3` 单个、`0,2` 多选、`1:4` 区间、`0:6:2` 带步长；负数从尾部数。 */
internal fun parseIndexSpec(spec: String, size: Int): List<Int> {
    val out = mutableListOf<Int>()
    for (raw in spec.split(',')) {
        val part = raw.trim()
        if (part.isEmpty()) continue
        if (':' in part) {
            val bits = part.split(':').map { it.trim() }
            val start = bits.getOrNull(0)?.toIntOrNull() ?: 0
            val end = bits.getOrNull(1)?.toIntOrNull() ?: size
            val step = bits.getOrNull(2)?.toIntOrNull()?.takeIf { it > 0 } ?: 1
            var index = if (start < 0) start + size else start
            val stop = if (end < 0) end + size else end
            while (index < stop && index < size) {
                if (index >= 0) out += index
                index += step
            }
        } else {
            val value = part.toIntOrNull() ?: continue
            out += if (value < 0) value + size else value
        }
    }
    return out
}
