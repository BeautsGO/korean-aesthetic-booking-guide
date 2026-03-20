const { pinyin } = require('pinyin-pro')

// ── Stop words for keyword filtering ─────────────────────────────────────────

const STOP_WORDS = [
  '整形外科&皮肤科', '&皮肤科', '抗老化医学美容中心',
  '皮肤科医院', '皮肤医院', '整形医院', '整形外科',
  '韩国', '牙科', '皮肤科', '眼科', '妇科',
  '总店', '国际店', '分店', '分馆', '诊所', '本院', '医院', '国际', '店'
]

const PINYIN_STOP = ['pifuke', 'pfk']

function filterName(name) {
  let result = name.replace(/[（(][^）)]*[）)]/g, '')
  const sorted = [...STOP_WORDS].sort((a, b) => b.length - a.length)
  sorted.forEach(w => { result = result.split(w).join('') })
  return result.trim()
}

function filterPinyin(str) {
  return PINYIN_STOP.reduce(
    (acc, kw) => acc.replace(new RegExp(kw, 'gi'), ''),
    str
  )
}

// ── Search keyword generation ─────────────────────────────────────────────────

function generateSearchKeywords(hospital) {
  const cnName = filterName(hospital.name || '')
  const enName = (hospital.en_name || '')
    .replace(/\bclinic\b/gi, '')
    .replace(/\bhospital\b/gi, '')
    .trim()

  const chineseForPinyin = cnName ? extractChineseOnly(cnName) : ''
  const py = chineseForPinyin
    ? filterPinyin(pinyin(chineseForPinyin, { toneType: 'none', separator: '', type: 'string' }))
    : ''
  const abbr = chineseForPinyin
    ? filterPinyin(pinyin(chineseForPinyin, { toneType: 'none', separator: '', type: 'string', pattern: 'first' }))
    : ''

  const parts = [['中文名', cnName], ['英文名', enName], ['拼音', py], ['首字母', abbr]]
  const seen = new Set()
  const keywords = []

  for (const [label, value] of parts) {
    if (!value) continue
    const key = value.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    keywords.push(`${label}"${value}"`)
  }

  return keywords.join('、')
}

// ── Dynamic pinyin generation for matching ────────────────────────────────────

/**
 * Extract only the Chinese characters from a string for pinyin generation.
 * e.g. "CNP狎鸥亭" → "狎鸥亭", "JD皮肤科" → "皮肤科"
 */
function extractChineseOnly(str) {
  return str.replace(/[^\u4e00-\u9fff]/g, '')
}

function getDynamicPinyin(hospital) {
  const cnName = filterName(hospital.name || '')
  if (!cnName) return { py: '', abbr: '' }
  // Only run pinyin over Chinese characters to avoid mixing in Latin prefixes
  const chineseOnly = extractChineseOnly(cnName)
  if (!chineseOnly) return { py: '', abbr: '' }
  const py = filterPinyin(pinyin(chineseOnly, { toneType: 'none', separator: '', type: 'string' }))
  const abbr = filterPinyin(pinyin(chineseOnly, { toneType: 'none', separator: '', type: 'string', pattern: 'first' }))
  return { py, abbr }
}

// ── Hospital matching (4-tier strategy) ──────────────────────────────────────

// Minimum token length for bidirectional alias matching to avoid false positives
const MIN_ALIAS_MATCH_LEN = 2

function matchHospital(query, hospitals) {
  const q = query.toLowerCase()

  // Strategy 1: exact match on name / en_name / alias
  let found = hospitals.find(h =>
    [h.name, h.en_name, h.alias].some(v => v && v.toLowerCase() === q)
  )
  if (found) return found

  // Strategy 2: exact dynamic pinyin / pinyin abbreviation (no manual field required)
  found = hospitals.find(h => {
    const { py, abbr } = getDynamicPinyin(h)
    return (py && py.toLowerCase() === q) || (abbr && abbr.toLowerCase() === q)
  })
  if (found) return found

  // Strategy 3: fuzzy name contains query (require query length >= 2 to avoid single-char false positives)
  if (q.length >= MIN_ALIAS_MATCH_LEN) {
    found = hospitals.find(h => h.name && h.name.toLowerCase().includes(q))
    if (found) return found
  }

  // Strategy 4: other fields fuzzy + aliases bidirectional
  if (q.length >= MIN_ALIAS_MATCH_LEN) {
    found = hospitals.find(h => {
      const { py, abbr } = getDynamicPinyin(h)
      const fields = [h.en_name, h.alias, py, abbr]
      if (fields.some(v => v && v.toLowerCase().includes(q))) return true
      if (h.aliases && h.aliases.some(a => {
        const al = a.toLowerCase()
        // Guard against very short tokens causing false positives
        if (al.length < MIN_ALIAS_MATCH_LEN || q.length < MIN_ALIAS_MATCH_LEN) return false
        return q.includes(al) || al.includes(q)
      })) return true
      return false
    })
  }

  return found || null
}

module.exports = { matchHospital, generateSearchKeywords }
