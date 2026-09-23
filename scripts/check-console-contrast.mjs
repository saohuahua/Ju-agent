/**
 * 深色控制台配色 WCAG 对比度核验
 *
 * 设计系统双轨（ADR-013）要求深色轨所有文本组合过 WCAG AA
 * 正文 4.5:1 大字与非文本 3:1 本脚本是该要求的可执行凭据
 * 色值与 apps/web/src/app/globals.css 的 console 轨 token 保持一致
 * 改色后必须重跑 npm run check:contrast 输出表落进 docs/redesign-audit.md
 */

/** 十六进制色值转 sRGB 分量 仅接受 #rrggbb 形式 */
const toRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255)

/** sRGB 分量线性化 WCAG 2.1 相对亮度公式前置步骤 */
const linearize = (c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4))

/** 相对亮度 L = 0.2126R + 0.7152G + 0.0722B */
const luminance = (hex) => {
  const [r, g, b] = toRgb(hex).map(linearize)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** 对比度 (L_lighter + 0.05) / (L_darker + 0.05) 取值区间 1:1 到 21:1 */
export const contrast = (a, b) => {
  const [lighter, darker] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (lighter + 0.05) / (darker + 0.05)
}

/** 三层深色背景 卡片浮起时前景对比度最低 故 raised 是最严格的一列 */
const BACKGROUNDS = { canvas: '#0d100e', surface: '#151a17', raised: '#1d2420' }

/**
 * 状态徽章配色对 深色轨把「浅底深字」反转为「深底亮字」
 * 每对是 [色名, 徽章底色(-50 档), 徽章字色] 字色需对底色过 AA 4.5:1
 */
const STATUS_PAIRS = [
  ['emerald', '#102a1f', '#6ee7a8'],
  ['red', '#2e1414', '#f78a8a'],
  ['amber', '#2d2310', '#f5c563'],
  ['orange', '#2f1f12', '#f5c563'],
  ['sky', '#10222e', '#7fb4e8'],
  ['blue', '#121f33', '#7fb4e8'],
  ['purple', '#241a2e', '#c4a5f0'],
  ['violet', '#201a2e', '#c4a5f0'],
  ['sage', '#141a15', '#86a489'],
]

/**
 * 前景色及其达标门槛
 * text  正文级 需 4.5:1
 * large 大字级 需 3:1 仅用于 18px 以上或粗体文本
 * ui    非文本 需 3:1 用于控件边界与图形 WCAG 1.4.11
 * decor 装饰性 无门槛 仅作分隔不承载信息
 */
const FOREGROUNDS = [
  ['ink', '#e6eae7', 'text'],
  ['muted', '#8b948d', 'text'],
  ['dim', '#7a847d', 'large'],
  ['accent', '#86a489', 'text'],
  ['accent-dim', '#5a7d62', 'ui'],
  ['border', '#6b756e', 'ui'],
  ['hairline', '#323b35', 'decor'],
  ['ok', '#6ee7a8', 'text'],
  ['warn', '#f5c563', 'text'],
  ['danger', '#f78a8a', 'text'],
  ['info', '#7fb4e8', 'text'],
  // 中性 ramp 在控制台轨被反转 既有页面的 text-stone-* 直接落到这些值上
  ['stone-600→', '#a2aba5', 'text'],
  ['stone-700→', '#b9c1bc', 'text'],
  ['stone-800→', '#d0d6d2', 'text'],
]

const THRESHOLDS = { text: 4.5, large: 3, ui: 3, decor: 0 }

const pad = (s, n) => String(s).padEnd(n)
let failed = 0

console.log(
  pad('token', 13) +
    pad('门槛', 8) +
    Object.keys(BACKGROUNDS)
      .map((b) => pad(b, 11))
      .join(''),
)
console.log('-'.repeat(13 + 8 + 11 * 3))

for (const [name, value, kind] of FOREGROUNDS) {
  const need = THRESHOLDS[kind]
  const cells = Object.values(BACKGROUNDS).map((bg) => {
    const r = contrast(value, bg)
    const ok = r >= need
    if (!ok) failed++
    return pad(`${r.toFixed(2)}${ok ? '' : ' ✗'}`, 11)
  })
  console.log(pad(name, 13) + pad(need ? `${need}:1` : '—', 8) + cells.join(''))
}

if (failed > 0) {
  console.error(`\n✗ ${failed} 个组合未达门槛 请提亮对应 token 后重跑`)
  process.exit(1)
}
console.log('\n✓ 深色控制台基础组合达标')

console.log('\n' + pad('状态徽章', 13) + pad('门槛', 8) + pad('字对徽章底', 13) + '字对三层背景')
console.log('-'.repeat(13 + 8 + 13 + 28))

for (const [name, tint, fg] of STATUS_PAIRS) {
  const onTint = contrast(fg, tint)
  if (onTint < 4.5) failed++
  // 状态字除了压在徽章底上 也会直接用在面板上 两种场合都要达标
  const onBg = Object.values(BACKGROUNDS).map((bg) => {
    const r = contrast(fg, bg)
    if (r < 4.5) failed++
    return `${r.toFixed(2)}`
  })
  console.log(
    pad(name, 13) +
      pad('4.5:1', 8) +
      pad(`${onTint.toFixed(2)}${onTint >= 4.5 ? '' : ' ✗'}`, 13) +
      onBg.map((v) => pad(v, 9)).join(''),
  )
}

if (failed > 0) {
  console.error(`\n✗ ${failed} 个组合未达门槛 请提亮对应 token 后重跑`)
  process.exit(1)
}
console.log('\n✓ 深色控制台全部组合达标')
