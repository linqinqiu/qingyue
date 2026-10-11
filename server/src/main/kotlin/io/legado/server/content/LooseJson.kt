package io.legado.server.content

/**
 * 把书源里手写的 JS 对象字面量 `,{...}` 转成严格 JSON。
 *
 * 上游 Legado 的做法是先 `GSONStrict`、失败再退回宽松 `GSON` 并打一行
 * 「链接参数 JSON 格式不规范，请改为规范格式」（`model/analyzeRule/AnalyzeUrl.kt:253-259`）。
 * 服务端用的 kotlinx.serialization 没有宽松模式，所以这里自己把常见的非规范写法规范化，
 * 覆盖库内实测到的形态（4,876 源里严格 JSON 失败 1,571 处）：
 * - 单引号键值：`{'method':'POST','body':'kw={{key}}'}` —— 最大一桶（335 + 64 + …处）
 * - 裸标识符键：`{webView: true}`
 * - 全角引号：`{webView:“true”}`（46 处，中文输入法下写出来的）
 * - 字符串里裸换行/裸制表符
 * - 尾随逗号：`{"method":"POST",}`
 * - `//` 与 `/* */` 注释
 *
 * 只做规范化，不做求值：里面出现的 `{{key}}` 之类的占位符原样留在字符串里，交给后续 renderUrl。
 */
object LooseJson {

    private const val MAX_LENGTH = 8_192

    /** 解析不出来时返回 null，由调用方决定「丢掉参数尾巴」还是「整串当 URL」。 */
    fun toStrict(text: String): String? {
        if (text.isBlank() || text.length > MAX_LENGTH) return null
        val out = StringBuilder(text.length + 16)
        var index = 0
        // 记录最后一个逗号在 out 里的位置，遇到 } ] 时回删，用来吃掉尾随逗号
        var pendingComma = -1
        while (index < text.length) {
            val ch = text[index]
            when {
                ch == '"' -> { index = appendString(text, index, '"', out); pendingComma = -1 }
                ch == '\'' -> { index = appendString(text, index, '\'', out); pendingComma = -1 }
                ch == '“' || ch == '”' || ch == '‘' || ch == '’' -> {
                    index = appendFullWidthString(text, index, out); pendingComma = -1
                }
                ch == '/' && index + 1 < text.length && text[index + 1] == '/' -> {
                    while (index < text.length && text[index] != '\n') index++
                }
                ch == '/' && index + 1 < text.length && text[index + 1] == '*' -> {
                    val end = text.indexOf("*/", index + 2)
                    index = if (end < 0) text.length else end + 2
                }
                isIdentifierStart(ch) -> {
                    val start = index
                    while (index < text.length && isIdentifierPart(text[index])) index++
                    val word = text.substring(start, index)
                    // 后面紧跟 `:` 才是键；否则是 true/false/null/undefined 这类字面量
                    val next = skipSpace(text, index)
                    if (next < text.length && text[next] == ':') {
                        out.append('"').append(word.replace("\"", "\\\"")).append('"')
                        // 回到标识符末尾，让冒号与它后面的空白按原样走普通分支，规范化结果只改必要部分
                        index = start + word.length
                    } else {
                        out.append(
                            when (word) {
                                "true", "false", "null" -> word
                                "undefined" -> "null"
                                else -> "\"" + word.replace("\"", "\\\"") + "\""
                            }
                        )
                    }
                    pendingComma = -1
                }
                ch == ',' -> {
                    pendingComma = out.length
                    out.append(ch); index++
                }
                ch == '}' || ch == ']' -> {
                    if (pendingComma >= 0) out.deleteCharAt(pendingComma)
                    pendingComma = -1
                    out.append(ch); index++
                }
                else -> { out.append(ch); index++ }
            }
        }
        val strict = out.toString()
        return if (runCatching { kotlinx.serialization.json.Json.parseToJsonElement(strict) }.isSuccess) strict else null
    }

    /** 从 [start] 处的引号开始抄一个字符串，输出成双引号 JSON 串；引号没闭合则走到结尾。 */
    private fun appendString(text: String, start: Int, quote: Char, out: StringBuilder): Int {
        var index = start + 1
        out.append('"')
        while (index < text.length) {
            val ch = text[index]
            when (ch) {
                '\\' -> {
                    val next = if (index + 1 < text.length) text[index + 1] else ' '
                    // JS 的 `\'` 在 JSON 里是多余的转义，`\/` 同理；其余转义原样保留
                    if (next == quote || next == '/') { out.append(next); index += 2 }
                    else { out.append(ch).append(next); index += 2 }
                }
                quote -> { out.append('"'); return index + 1 }
                '"' -> { out.append("\\\""); index++ }
                '\n' -> { out.append("\\n"); index++ }
                '\r' -> { out.append("\\r"); index++ }
                '\t' -> { out.append("\\t"); index++ }
                else -> { out.append(ch); index++ }
            }
        }
        out.append('"')
        return index
    }

    /** 全角引号成对出现（“…”），也可能左右符号混着用，所以按「遇到另一种全角引号或半角引号结束」处理。 */
    private fun appendFullWidthString(text: String, start: Int, out: StringBuilder): Int {
        var index = start + 1
        out.append('"')
        while (index < text.length) {
            val ch = text[index]
            if (ch in "“”‘’\"'") { out.append('"'); return index + 1 }
            when (ch) {
                '\n' -> out.append("\\n")
                '\r' -> out.append("\\r")
                '\t' -> out.append("\\t")
                '"' -> out.append("\\\"")
                else -> out.append(ch)
            }
            index++
        }
        out.append('"')
        return index
    }

    private fun skipSpace(text: String, from: Int): Int {
        var index = from
        while (index < text.length && text[index].isWhitespace()) index++
        return index
    }

    // 只认 ASCII 标识符：全角引号 “ ” ‘ ’ 的码点也 > 127，若一并放行会把 `{webView:“true”}` 
    // 整个吞成一个「键名」，反而解析不出来。
    private fun isIdentifierStart(ch: Char) = ch.isLetter() || ch == '_' || ch == '$'

    private fun isIdentifierPart(ch: Char) = isIdentifierStart(ch) || ch.isDigit()

    /**
     * 按花括号配对切出 `,` 之后的参数尾巴。
     * 返回 `Pair(去掉尾巴的 URL, 尾巴文本)`；没有 `,{` 或括号不闭合时尾巴为 null。
     * 现有实现是「取到字符串结尾」，源里 `,{...}` 后面还跟着别的东西时严格 JSON 直接解析失败。
     */
    fun extractTail(value: String): Pair<String, String?> {
        val start = value.indexOf(",{")
        if (start < 0) return value to null
        var depth = 0
        var quote: Char? = null
        var index = start + 1
        while (index < value.length) {
            val ch = value[index]
            if (quote != null) {
                when (ch) {
                    '\\' -> index++
                    quote -> quote = null
                }
            } else when (ch) {
                '"', '\'' -> quote = ch
                '{' -> depth++
                '}' -> {
                    depth--
                    if (depth == 0) return value.substring(0, start) to value.substring(start + 1, index + 1)
                }
            }
            index++
        }
        return value to null
    }
}
