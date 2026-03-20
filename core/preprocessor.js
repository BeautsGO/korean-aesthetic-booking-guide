// 自然语言查询预处理层
// 从用户输入中提取医院名关键词，去除常见干扰词

const STOP_PHRASES = [
  '怎么预约', '如何预约', '预约流程', '怎么挂号', '在哪预约', '预约',
  '怎么去', '怎么联系', '联系方式', '地址', '电话',
  '我想约一下', '我想预约', '我要预约', '想预约', '要预约',
  '请问', '你好', '您好', '谢谢', '谢谢啦', '谢谢啊',
  '的', '了', '呢', '啊', '呀', '吧', '哦'
]

// 按长度降序排序，优先匹配长短语
const SORTED_STOP_PHRASES = [...STOP_PHRASES].sort((a, b) => b.length - a.length)

/**
 * 从自然语言查询中提取医院名关键词
 * @param {string} query 用户原始输入
 * @returns {string} 清理后的关键词
 */
function extractHospitalKeyword(query) {
  if (!query || typeof query !== 'string') return ''
  
  let cleaned = query.trim()
  
  // 1. 移除常见干扰短语
  for (const phrase of SORTED_STOP_PHRASES) {
    const regex = new RegExp(phrase, 'gi')
    cleaned = cleaned.replace(regex, '')
  }
  
  // 2. 移除多余空格和标点
  cleaned = cleaned
    .replace(/[，,。.!?？、；;]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  
  // 3. 如果清理后为空，返回原始查询（让后续匹配层处理）
  return cleaned || query
}

/**
 * 测试用例
 */
function testPreprocessor() {
  const cases = [
    'CNP皮肤科怎么预约',
    '我想约一下JD皮肤科',
    '请问JD皮肤科的联系方式',
    'CNP狎鸥亭店地址',
    'JD Skin Clinic appointment',
    'cnp',
    '韩国jd',
    '皮', // 单字
    '不存在医院怎么预约'
  ]
  
  console.log('=== 预处理测试 ===')
  for (const q of cases) {
    const extracted = extractHospitalKeyword(q)
    console.log(`"${q}" → "${extracted}"`)
  }
}

// 导出供测试
if (require.main === module) {
  testPreprocessor()
}

module.exports = { extractHospitalKeyword }