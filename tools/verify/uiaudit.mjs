import { createRequire } from 'node:module';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

import { ROOT } from './env.mjs';

const require = createRequire(path.join(ROOT, 'web', 'package.json'));
const puppeteer = require('puppeteer-core');

const BASE = process.env.UI_AUDIT_URL || 'http://127.0.0.1:1234';
// CHROME 不再写死任何一台机器的安装路径：用 CHROME_BIN 指定，缺省时启动前报错提示（见下）。
const CHROME = process.env.CHROME_BIN || '';
const OUT = path.join(ROOT, 'tools', 'verify', 'out', 'shots');
fs.mkdirSync(OUT, { recursive: true });

const consoleErrors = [];
const networkIssues = [];
const steps = [];

const lum = (rgb) => {
  const [r, g, b] = rgb.map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const parseRgb = (c) => (c.match(/\d+(\.\d+)?/g) || []).slice(0, 3).map(Number);
const ratio = (fg, bg) => {
  const a = lum(parseRgb(fg)), b = lum(parseRgb(bg));
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
};

const metricsFn = () => {
  const px = (v) => Math.round(parseFloat(v) || 0);
  const bgOf = (el) => {
    let cur = el;
    while (cur && cur !== document.documentElement) {
      const c = getComputedStyle(cur).backgroundColor;
      if (c && !/rgba\(0, 0, 0, 0\)|transparent/.test(c)) return c;
      cur = cur.parentElement;
    }
    return getComputedStyle(document.body).backgroundColor || 'rgb(255,255,255)';
  };
  const pick = (sel) => document.querySelector(sel);
  const body = document.body;
  const bs = getComputedStyle(body);
  const main = pick('.library-results, .source-list, .reader-content, main, section');
  const ms = main ? getComputedStyle(main) : bs;
  const btn = pick('button');
  const btns = btn ? getComputedStyle(btn) : null;
  const tiny = [];
  document.querySelectorAll('p, small, span, button, a, li, td').forEach((el) => {
    const t = (el.textContent || '').trim();
    if (!t) return;
    const f = px(getComputedStyle(el).fontSize);
    if (f < 12) tiny.push(`${el.tagName.toLowerCase()}.${String(el.className).split(' ')[0]}@${f}px:${t.slice(0, 18)}`);
  });
  return {
    docScrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
    overflowX: document.documentElement.scrollWidth > window.innerWidth + 1,
    bodyFont: px(bs.fontSize),
    bodyColor: bs.color,
    bodyBg: bgOf(body),
    mainFont: px(ms.fontSize),
    mainColor: ms.color,
    mainBg: main ? bgOf(main) : bgOf(body),
    buttonBg: btns ? btns.backgroundColor : '',
    buttonColor: btns ? btns.color : '',
    buttonRadius: btns ? btns.borderRadius : '',
    accentSample: btns ? btns.backgroundColor : '',
    tinyTextCount: tiny.length,
    tinyTextSample: tiny.slice(0, 6),
    headingSizes: Array.from(document.querySelectorAll('h1,h2,h3')).slice(0, 4).map((h) => `${h.tagName.toLowerCase()}=${px(getComputedStyle(h).fontSize)}px ${h.textContent.trim().slice(0, 12)}`),
  };
};

if (!CHROME) {
  console.error('uiaudit 需要一个 Chromium 内核浏览器：请先设环境变量 CHROME_BIN 指向本机 Chrome/Edge 的可执行文件路径。');
  process.exit(1);
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  userDataDir: fs.mkdtempSync(os.tmpdir() + '/legado-ui-audit-'),
  args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--force-device-scale-factor=1', '--window-size=1440,900'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900 });
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') consoleErrors.push(`${m.type()}: ${m.text().slice(0, 160)}`); });
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${String(e.message).slice(0, 160)}`));
page.on('requestfailed', (r) => networkIssues.push(`${r.failure()?.errorText} ${r.url().slice(0, 90)}`));
page.on('response', (r) => { if (r.status() >= 400) networkIssues.push(`HTTP ${r.status()} ${r.url().slice(0, 90)}`); });

const shoot = async (name) => {
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file, fullPage: false });
  return file;
};
const step = async (name, fn) => {
  try {
    const detail = await fn();
    steps.push({ name, ok: true, detail });
    console.log(`OK    ${name}${detail ? '  ' + JSON.stringify(detail).slice(0, 150) : ''}`);
  } catch (e) {
    steps.push({ name, ok: false, detail: String(e.message).slice(0, 140) });
    console.log(`SKIP  ${name}  ${String(e.message).slice(0, 140)}`);
  }
};
const waitFor = (sel, ms = 12000) => page.waitForSelector(sel, { visible: true, timeout: ms }).then(() => true);
const settle = async (min = 150) => page.waitForFunction((n) => document.querySelectorAll('body *').length > n, { timeout: 9000, polling: 250 }, min).catch(() => undefined);

let readerReached = false;
await step('打开首页', async () => {
  await page.goto(BASE, { waitUntil: 'networkidle2', timeout: 40000 });
  await waitFor('input[placeholder="输入书名或作者"]');
  await settle();
  return await shoot('01-library');
});

const screens = [['02-sources', '#sources'], ['03-subscriptions', '#subscriptions'], ['04-rules', '#rules'], ['05-backup', '#backup'], ['06-shelf', '#shelf'], ['13-explore', '#explore']];
for (const [name, hash] of screens) {
  await step(`页面 ${hash}`, async () => {
    await page.goto(BASE + '/' + hash, { waitUntil: 'networkidle2', timeout: 30000 });
    await settle();
    return await shoot(name);
  });
}

await step('搜索 都市', async () => {
  await page.goto(BASE + '/', { waitUntil: 'networkidle2', timeout: 30000 });
  const input = await page.waitForSelector('input[placeholder="输入书名或作者"]', { visible: true });
  await input.click();
  await input.type('都市', { delay: 40 });
  await page.keyboard.press('Enter');
  await new Promise((r) => setTimeout(r, 45000));
  const n = await page.$$eval('.library-results-grid button', (els) => els.length).catch(() => 0);
  const shot = await shoot('07-search');
  return { results: n, shot };
});

await step('打开书籍详情弹窗', async () => {
  await page.click('.library-results-grid button');
  await waitFor('.book-detail-modal', 60000);
  await new Promise((r) => setTimeout(r, 2000));
  return await shoot('08-book-detail');
});

await step('从书架进入阅读器', async () => {
  await page.goto(BASE + '#shelf', { waitUntil: 'networkidle2', timeout: 30000 });
  await page.waitForSelector('.shelf-card', { visible: true, timeout: 15000 });
  const cards = await page.$$eval('.shelf-card', (els) => els.map((e) => e.innerText.replace(/\s+/g, ' ').slice(0, 26)));
  const brokenCovers = await page.$$eval('.shelf-card img', (imgs) => imgs.filter((i) => i.complete && i.naturalWidth === 0).length);
  await page.click('.shelf-card .shelf-card-cover');
  await waitFor('.reader-header, .reader-chapter-title', 30000);
  await new Promise((r) => setTimeout(r, 12000));
  readerReached = true;
  return { cards, brokenCovers, file: await shoot('09-reader') };
});

await step('阅读器设置抽屉', async () => {
  const opened = await page.evaluate(() => {
    const cands = Array.from(document.querySelectorAll('.reader-header button, .reader-header-actions button, .mobile-reader-nav button, button[title], button[aria-label]'));
    const b = cands.find((x) => /设置|Aa|字体|外观/.test(`${x.getAttribute('aria-label') || ''} ${x.title || ''} ${x.textContent || ''}`));
    if (b) { b.click(); return `${b.getAttribute('aria-label') || b.title || b.textContent}`.trim().slice(0, 10); }
    return null;
  });
  if (!opened) throw new Error('没找到设置按钮');
  await new Promise((r) => setTimeout(r, 1200));
  return await shoot('10-reader-settings');
});

await step('阅读器正文指标', async () => {
  const m = await page.evaluate(() => {
    const el = document.querySelector('.reader-content, article, [class*=content]');
    if (!el) return null;
    const s = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return { font: parseFloat(s.fontSize), lineHeight: s.lineHeight, measure: Math.round(r.width), textLen: (el.innerText || '').length, color: s.color, bg: s.backgroundColor };
  });
  return m;
});

await step('发现页选番茄并出书', async () => {
  await page.goto(BASE + '#explore', { waitUntil: 'networkidle2', timeout: 30000 });
  // 这个控件早就不是原生 <select> 了：几千个源用原生下拉没法过滤（见 web/src/Select.tsx），
  // 所以按界面真实的用法走一遍 —— 点开、打关键字、点那条，而不是 page.select()。
  await page.waitForSelector('.explore-source-picker .ui-select-trigger', { timeout: 25000 });
  const target = await page.evaluate(async () => {
    const list = await (await fetch('/api/explore/sources')).json();
    return list.find((item) => item.id === 'https://fq-book.netsite.cc')?.name ?? null;
  });
  if (!target) throw new Error('接口里没有 https://fq-book.netsite.cc 这个源（本机书源变了，这一屏要另挑）');
  await page.click('.explore-source-picker .ui-select-trigger');
  await page.waitForSelector('.ui-select-search', { timeout: 10000 });
  await page.evaluate((text) => {
    const node = document.querySelector('.ui-select-search');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(node, text);
    node.dispatchEvent(new Event('input', { bubbles: true }));
  }, target);
  await new Promise((r) => setTimeout(r, 600));
  const chose = await page.evaluate((name) => {
    const option = Array.from(document.querySelectorAll('.ui-select-option')).find((node) => node.querySelector('span')?.textContent?.trim() === name);
    if (!option) return null;
    option.click();
    return name;
  }, target);
  if (!chose) throw new Error(`源列表里有「${target}」，但界面下拉里筛不出它`);
  await page.waitForSelector('.explore-tab', { visible: true, timeout: 30000 });
  const clicked = await page.evaluate(() => {
    const tab = Array.from(document.querySelectorAll('.explore-tab')).find((b) => /巅峰榜单|出版榜单/.test(b.textContent || ''));
    if (tab) { tab.click(); return tab.textContent.trim(); }
    return null;
  });
  if (!clicked) throw new Error('没有榜单分栏可点');
  await page.waitForSelector('.explore-card', { visible: true, timeout: 45000 });
  await new Promise((r) => setTimeout(r, 2500));
  const n = await page.$$eval('.explore-card', (els) => els.length);
  const tabs = await page.$$eval('.explore-tab', (els) => els.length);
  const covers = await page.$$eval('.explore-cover', (els) => ({ total: els.length, loaded: els.filter((i) => i.complete && i.naturalWidth > 0).length }));
  return { chosen: chose, tabs, tab: clicked, cards: n, covers, file: await shoot('14-explore-books') };
});

const desktopMetrics = await page.evaluate(metricsFn);
await step('移动端首页 390x844', async () => {
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  await page.goto(BASE, { waitUntil: 'networkidle2', timeout: 30000 });
  await new Promise((r) => setTimeout(r, 1500));
  const m = await page.evaluate(metricsFn);
  const shot = await shoot('11-mobile-library');
  return { overflowX: m.overflowX, scrollWidth: m.docScrollWidth, shot };
});
await step('移动端书架/规则', async () => {
  await page.goto(BASE + '#rules', { waitUntil: 'networkidle2', timeout: 30000 });
  await new Promise((r) => setTimeout(r, 1200));
  const m = await page.evaluate(metricsFn);
  return { overflowX: m.overflowX, scrollWidth: m.docScrollWidth, file: await shoot('12-mobile-rules') };
});

const perScreen = [];
await page.setViewport({ width: 1440, height: 900 });
for (const [label, hash] of [['library', ''], ['sources', '#sources'], ['rules', '#rules'], ['shelf', '#shelf'], ['reader', '#reader']]) {
  await step(`量测 ${label}`, async () => {
    await page.goto(BASE + (hash || '/'), { waitUntil: 'networkidle2', timeout: 30000 });
    await settle();
    const m = await page.evaluate(metricsFn);
    perScreen.push({ label, ...m });
    return { 正文对比度: ratio(m.mainColor, m.mainBg).toFixed(2), 次要文字: m.bodyColor, 按钮底色: m.buttonBg, 溢出: m.overflowX };
  });
}

await browser.close();

const contrast = {
  桌面正文: ratio(desktopMetrics.mainColor, desktopMetrics.mainBg).toFixed(2),
  桌面次要: ratio(desktopMetrics.bodyColor, desktopMetrics.bodyBg).toFixed(2),
  按钮文字: ratio(desktopMetrics.buttonColor, desktopMetrics.buttonBg || 'rgb(255,255,255)').toFixed(2),
};
console.log('\n== 汇总 ==');
console.log('桌面指标:', JSON.stringify(desktopMetrics, null, 1).slice(0, 900));
console.log('对比度(WCAG 正文≥4.5 大字≥3):', JSON.stringify(contrast));
console.log('各屏:');
for (const m of perScreen) console.log(` ${m.label.padEnd(9)} 正文 ${m.mainFont}px 对比 ${ratio(m.mainColor, m.mainBg).toFixed(2)} 溢出 ${m.overflowX} 小字 ${m.tinyTextCount} 圆角 ${m.buttonRadius}`);
console.log(`\n控制台告警/错误 ${consoleErrors.length} 条：`);
for (const e of [...new Set(consoleErrors)].slice(0, 12)) console.log('  ' + e);
console.log(`网络异常 ${networkIssues.length} 条：`);
for (const e of [...new Set(networkIssues)].slice(0, 12)) console.log('  ' + e);
fs.writeFileSync(path.join(OUT, '..', 'ui-metrics.json'), JSON.stringify({ desktop: desktopMetrics, perScreen, consoleErrors, networkIssues, readerReached }, null, 1));
