package io.legado.server.ai

/**
 * 文章阅读理解：本地抽取式 stub。
 *
 * 用户原话：「提供文章阅读理解」——但「主要的是搭建一个基础框架，其他的靠用户自己自定义」。
 * 所以这里先放一个**不联网、不依赖任何模型**的基线实现：摘要（按句子打分取前 N）、
 * 关键词（高频非停用词）、简易问答（与问题词重叠最高的句子）。它能让 `POST /api/agent/comprehend`
 * 立刻可用，证明整条链路通；接真实大模型时，由 [io.legado.server.ai.AgentRoutes.comprehend]
 * 在检测到「非内置连接」时改走外部 HTTP，本文件不动。
 */
object LocalComprehension {

    /** 中文 + 英文常见停用词：摘要与关键词都跳过它们。 */
    private val STOPWORDS = setOf(
        "的", "了", "和", "是", "在", "我", "有", "也", "就", "不", "都", "而", "及", "与", "或", "一个",
        "没有", "我们", "你们", "他们", "自己", "这", "那", "这个", "那个", "它", "他", "她", "你", "您",
        "the", "a", "an", "and", "or", "but", "of", "to", "in", "on", "for", "with", "is", "are", "was",
        "were", "be", "been", "being", "this", "that", "it", "as", "at", "by", "from", "your", "you", "we",
        "they", "i", "he", "she", "not", "no", "yes", "do", "did", "does", "can", "will", "would", "should",
    )

    /** 一段中文/英文混排文本切成句子（以 。！？.!? 及换行断句）。 */
    private fun splitSentences(text: String): List<String> {
        val parts = text.replace("\r", "").split(Regex("[。！？!?\\n]+"))
        return parts.map { it.trim() }.filter { it.length >= 4 }
    }

    /** 把句子拆成候选词：中文按 2-gram 滑窗，英文按小写词。 */
    private fun tokenize(sentence: String): List<String> {
        val tokens = mutableListOf<String>()
        val cjk = StringBuilder()
        for (ch in sentence) {
            if (ch.code in 0x4E00..0x9FFF) {
                cjk.append(ch)
            } else {
                if (cjk.length >= 2) tokens += cjk.windowed(2, 1).filter { it !in STOPWORDS }
                cjk.clear()
                if (ch.isLetterOrDigit()) {
                    // 英文词累积
                }
            }
        }
        if (cjk.length >= 2) tokens += cjk.windowed(2, 1).filter { it !in STOPWORDS }
        // 英文词
        Regex("[A-Za-z][A-Za-z0-9]+").findAll(sentence).forEach { m ->
            val w = m.value.lowercase()
            if (w !in STOPWORDS) tokens += w
        }
        return tokens
    }

    /**
     * 综合分析一段文章。
     * @param text 文章正文
     * @param question 可选问题：给出时返回 topSentences 作为「答案句」
     * @param summarySentences 摘要取前几句
     * @param topKeywords 取前几个关键词
     */
    fun analyze(
        text: String,
        question: String? = null,
        summarySentences: Int = 3,
        topKeywords: Int = 8,
    ): ComprehensionResult {
        val sentences = splitSentences(text)
        if (sentences.isEmpty()) {
            return ComprehensionResult(
                summary = "",
                keywords = emptyList(),
                answer = question?.let { "" },
                keywordsRanked = emptyList(),
                sentencesCount = 0,
            )
        }

        // 词频（用于关键词与句子打分）
        val freq = mutableMapOf<String, Int>()
        sentences.forEach { sentence ->
            tokenize(sentence).forEach { w ->
                if (w !in STOPWORDS && w.length >= 2) freq[w] = (freq[w] ?: 0) + 1
            }
        }

        // 句子打分：句子内词频之和 / 长度归一，偏向信息密集句
        val scored = sentences.map { s ->
            val toks = tokenize(s)
            val score = if (toks.isEmpty()) 0.0 else toks.sumOf { (freq[it] ?: 0).toDouble() } / Math.sqrt(toks.size.toDouble() + 1.0)
            s to score
        }

        val summary = scored.sortedByDescending { it.second }
            .take(summarySentences.coerceAtLeast(1))
            .sortedBy { sentences.indexOf(it.first) } // 维持原文顺序
            .joinToString("") { it.first + "。" }

        val keywords = freq.entries.sortedByDescending { it.value }
            .take(topKeywords)
            .map { it.key }

        // 简易问答：与问题中词重叠最高的句子
        val answer = if (question.isNullOrBlank()) {
            null
        } else {
            val qToks = tokenize(question).toSet()
            val best = sentences.map { s ->
                val overlap = tokenize(s).count { it in qToks }
                s to overlap
            }.filter { it.second > 0 }.maxByOrNull { it.second }?.first
            best ?: "(未在文中找到与问题相关的句子)"
        }

        return ComprehensionResult(
            summary = summary,
            keywords = keywords,
            answer = answer,
            keywordsRanked = freq.entries.sortedByDescending { it.value }
                .take(topKeywords)
                .map { (word, weight) -> KeywordRank(word, weight) },
            sentencesCount = sentences.size,
        )
    }

    data class KeywordRank(val word: String, val weight: Int)

    data class ComprehensionResult(
        val summary: String,
        val keywords: List<String>,
        val answer: String?,
        val keywordsRanked: List<KeywordRank>,
        val sentencesCount: Int,
    )
}
