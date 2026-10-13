import test from 'node:test'
import assert from 'node:assert/strict'
import { clampFontSize, READER_FONT_SIZE_MAX, READER_FONT_SIZE_MIN, stepFontSize } from '../src/reader/fontSizeControl'

/**
 * 字号口径的唯一出处（P1 收敛）：设置步进器/快捷键/Ctrl+滚轮都走这里。
 * 边界一变三处齐变 —— 这份测试钉的就是"只有一个出处"这件事。
 */
test('clampFontSize：夹在 15–28，非法值回落', () => {
  assert.equal(clampFontSize(19), 19)
  assert.equal(clampFontSize(5), READER_FONT_SIZE_MIN)
  assert.equal(clampFontSize(99), READER_FONT_SIZE_MAX)
  // 非法值（NaN/±Infinity）一律回落到最小档：宁小勿炸，防呆优先。
  assert.equal(clampFontSize(Number.NaN), READER_FONT_SIZE_MIN)
  assert.equal(clampFontSize(Number.POSITIVE_INFINITY), READER_FONT_SIZE_MIN)
  assert.equal(clampFontSize(Number.NEGATIVE_INFINITY), READER_FONT_SIZE_MIN)
})

test('stepFontSize：步进后仍夹在边界内；到头不再动', () => {
  assert.equal(stepFontSize(19, 1), 20)
  assert.equal(stepFontSize(19, -1), 18)
  assert.equal(stepFontSize(READER_FONT_SIZE_MAX, 1), READER_FONT_SIZE_MAX)
  assert.equal(stepFontSize(READER_FONT_SIZE_MIN, -1), READER_FONT_SIZE_MIN)
})

test('边界值就是旧三处写死的 15/28，不许悄悄改', () => {
  // 旧代码三处各写 Math.min(28, Math.max(15, …)) —— 收敛后边界变了要同步排版设置的范围。
  assert.equal(READER_FONT_SIZE_MIN, 15)
  assert.equal(READER_FONT_SIZE_MAX, 28)
})
