const { getBookingGuide } = require('../core/service')
const hospitals = require('../data/hospitals.json')
const { matchHospital } = require('../core/resolver')
const { extractHospitalKeyword } = require('../core/preprocessor')
const { openUrl } = require('./browser/open-url')
const { fillForm } = require('./browser/fill-form')

/**
 * 识别用户意图
 *
 * 修复歧义问题：
 * - 首次带医院名的查询（"怎么咨询JD皮肤科"）一律判 view，不误触发 consult
 * - 只有纯操作词（没有医院名）才触发 open / book / consult
 * - 歧义消除规则：含有医院名 + 含有"咨询"= view（查看流程），而非 consult（自动化点击）
 *
 * @param {string} query 用户输入
 * @param {string[]} hospitalNames 所有医院名（用于检测输入是否含有医院名）
 * @returns {string} 意图类型：'view' | 'open' | 'book' | 'consult'
 */
function detectIntent(query, hospitalNames = []) {
  const q = query.trim()
  const qLower = q.toLowerCase()

  // ——— 是否含有明确的医院名（防止误判）———
  const containsHospitalName = hospitalNames.some(name =>
    qLower.includes(name.toLowerCase())
  )

  // ——— 严格操作词检测（只有短句纯操作词才触发自动化）———
  const isOpenIntent = /^(打开链接|打开页面|帮我打开|打开医院页面)$/.test(q.trim())
  const isBookIntent = /^(帮我预约|直接预约|点击预约|自动预约)$/.test(q.trim()) ||
    (!containsHospitalName && (qLower.includes('帮我预约') || qLower.includes('直接预约') || qLower.includes('点击预约')))
  // consult 歧义修复：只有不含医院名的纯"咨询客服"才触发自动化
  const isConsultIntent = /^(咨询客服|联系客服|咨询一下|帮我咨询)$/.test(q.trim()) ||
    (!containsHospitalName && (qLower.includes('咨询客服') || qLower.includes('联系客服')))

  // ——— fill_form：用户提供预约信息（人数 + 时间 / 继续填写 / 提交）———
  // 识别策略：输入包含数字人数、日期词、"继续填写"、"填写信息"等关键词
  const isFillFormIntent =
    /^(继续填写|填写信息|帮我填写|提交预约|确认预约)$/.test(q.trim()) ||
    // 包含人数词（N人、N位）
    (/\d+\s*(人|位)/.test(q) && !containsHospitalName) ||
    // 包含日期（3月25日 / 25号 / 2026-03-25 等）
    (/\d+(月|号|日|\/|-)\d*/.test(q) && !containsHospitalName) ||
    // context 明确标记为 fill_form 阶段
    false

  if (isFillFormIntent) return 'fill_form'
  if (isConsultIntent) return 'consult'
  if (isBookIntent) return 'book'
  if (isOpenIntent) return 'open'

  // 默认：含有医院名 or 含有问询词 → 查看预约流程
  return 'view'
}

/**
 * 从 hospital.url 推导咨询页 URL
 *
 * URL 规则：
 *   详情页：https://i.beautsgo.com/cn/hospital/<slug>?from=skill
 *   咨询页：https://i.beautsgo.com/cn/hospital/<slug>-chat
 *
 * 优先使用 hospital.chat_url（如果有），否则自动推导
 */
function getChatUrl(hospital) {
  if (hospital.chat_url) return hospital.chat_url

  // 从 url 提取 slug（去掉查询参数）
  try {
    const parsed = new URL(hospital.url)
    // pathname 形如 /cn/hospital/<slug>
    const slug = parsed.pathname.replace(/^\/cn\/hospital\//, '').replace(/\/$/, '')
    return `https://i.beautsgo.com/cn/hospital/${slug}-chat`
  } catch (e) {
    // url 解析失败时兜底：直接拼
    const base = hospital.url.split('?')[0].replace(/\/$/, '')
    return `${base}-chat`
  }
}

/**
 * 从 hospitals.json 中提取所有医院名（中文 + 英文 + 别名）
 * 用于意图识别中的医院名检测
 */
function getAllHospitalNames(hospitals) {
  const names = []
  for (const h of hospitals) {
    if (h.name) names.push(h.name)
    if (h.en_name) names.push(h.en_name)
    if (h.aliases) names.push(...h.aliases)
  }
  return names
}


/**
 * 解析用户输入，提取预约表单字段
 * @param {string} query 用户输入，如 "2人，3月26日，13800138000"
 * @returns {{ persons: number, dateText: string, contact: string }}
 */
function parseFormInput(query) {
  // 人数：匹配"2人"、"2位"、"两人"等
  let persons = 1
  const personMatch = query.match(/(\d+)\s*(人|位)/)
  if (personMatch) {
    persons = parseInt(personMatch[1], 10)
  } else if (query.includes('两人') || query.includes('两位')) {
    persons = 2
  } else if (query.includes('三人') || query.includes('三位')) {
    persons = 3
  }

  // 日期：匹配"3月26日"、"3月26号"、"26号"、"2026-03-26"、"26日"
  let dateText = ''
  const dateMatch =
    query.match(/(\d{1,2})[月\/\-](\d{1,2})[日号]?/) ||
    query.match(/(\d{4})[年\-\/](\d{1,2})[月\-\/](\d{1,2})/)
  if (dateMatch) {
    dateText = dateMatch[0]
  }

  // 联系方式：优先匹配手机号（11位数字），否则取去除人数、日期后的剩余内容
  let contact = ''
  const phoneMatch = query.match(/1[3-9]\d{9}/)
  if (phoneMatch) {
    contact = phoneMatch[0]
  } else {
    contact = query
      .replace(/\d+\s*(人|位)/g, '')
      .replace(/两人|两位|三人|三位/g, '')
      .replace(/\d{1,4}[年月\/\-]\d{1,2}[日号月\/\-]?\d{0,2}[日号]?/g, '')
      .replace(/[，,。.、！!？?]/g, ' ')
      .trim()
    if (contact.length < 2) contact = ''
  }

  return { persons, dateText, contact }
}

/**
 * 包装 fillForm 脚本，返回 { success, message } 结构
 */
async function fillBookingForm(url, bookingUrl, formData) {
  try {
    const targetUrl = bookingUrl || url
    await fillForm(targetUrl, formData.persons, formData.dateText, formData.contact || '')
    return { success: true, message: '预约已提交' }
  } catch (err) {
    return { success: false, message: err.message }
  }
}

/**
 * 主 Skill 入口
 *
 * context 约定（用于跨轮传递医院信息）：
 *   context.resolvedHospital  — 已解析的医院对象（由第1轮写入，后续轮次读取）
 *   context.lastQuery         — 上一轮含有医院名的原始 query（备用）
 */
module.exports = async function (input) {
  const { query, context = {} } = input
  const lang = input.lang || 'zh'

  // 预先加载所有医院名，用于意图识别的歧义消除
  const allHospitalNames = getAllHospitalNames(hospitals)
  const intent = detectIntent(query, allHospitalNames)

  /**
   * 获取当前医院对象的统一方法
   *
   * 优先级：
   * 1. context.resolvedHospital（AI 框架传入的上下文）
   * 2. 从当前 query 解析
   * 3. 扫描 context 所有字符串字段（兜底：AI 框架可能把历史文本放在不同字段）
   * 4. 只有 1 家医院时直接返回（单医院兜底）
   */
  function resolveHospital() {
    // 1. 优先从 context.resolvedHospital 读取
    if (context.resolvedHospital && context.resolvedHospital.name) {
      const h = matchHospital(context.resolvedHospital.name, hospitals)
      if (h) return h
      // context 里有 url 也能直接用
      if (context.resolvedHospital.url) return context.resolvedHospital
    }

    // 2. 从当前 query 解析
    const keyword = extractHospitalKeyword(query)
    if (keyword) {
      const h = matchHospital(keyword, hospitals)
      if (h) return h
    }

    // 3. 扫描 context 所有字符串字段（lastQuery / history / text / message 等）
    const contextTexts = []
    function collectStrings(obj, depth = 0) {
      if (depth > 4) return
      if (typeof obj === 'string' && obj.length > 1) {
        contextTexts.push(obj)
      } else if (Array.isArray(obj)) {
        obj.forEach(item => collectStrings(item, depth + 1))
      } else if (obj && typeof obj === 'object') {
        Object.values(obj).forEach(v => collectStrings(v, depth + 1))
      }
    }
    collectStrings(context)
    for (const text of contextTexts) {
      const kw = extractHospitalKeyword(text)
      if (kw) {
        const h = matchHospital(kw, hospitals)
        if (h) return h
      }
      // 直接用文本做模糊匹配
      const h2 = matchHospital(text, hospitals)
      if (h2) return h2
    }

    // 4. 单医院兜底：只有一家医院时直接返回
    if (hospitals.length === 1) {
      return hospitals[0]
    }

    return null
  }

  try {
    // ——————————————————————————————————————————
    // 第1轮：查看预约流程
    // 解析医院并写入返回值，供后续轮次使用
    // ——————————————————————————————————————————
    if (intent === 'view') {
      const guide = await getBookingGuide(query, lang)

      // 解析医院信息写入 context（供后续轮次跨轮读取）
      const keyword = extractHospitalKeyword(query)
      const hospital = matchHospital(keyword, hospitals)

      // 通过 __context__ 字段返回需要持久化的状态（由 AI 框架注入到下一轮 context）
      const hospitalHint = hospital
        ? `\n\n<!-- __context__:resolvedHospital=${JSON.stringify({ name: hospital.name, url: hospital.url, en_name: hospital.en_name })} lastQuery=${encodeURIComponent(query)} -->`
        : ''

      return `${guide}

---
💡 **接下来，选择你想要的操作：**

📖 **打开医院页面**
说"打开链接" → 我帮你打开 ${hospital ? hospital.name : '医院'} 的页面

⚡ **自动预约**
说"帮我预约" → 我帮你自动点击【预约面诊】按钮，跳转到预约表单

💬 **在线咨询**
说"咨询客服" → 我帮你自动点击【咨询一下】按钮，联系医院客服

---
你想做哪个？${hospitalHint}`
    }

    // ——————————————————————————————————————————
    // 第2轮：打开链接
    // ——————————————————————————————————————————
    if (intent === 'open') {
      const hospital = resolveHospital()

      if (!hospital) {
        return '❌ 我还不知道你要查看哪家医院，请告诉我医院名称，例如"打开JD皮肤科的链接"。'
      }

      const opened = await openUrl(hospital.url).then(() => true).catch(() => false)
      if (!opened) {
        return `❌ 链接打开失败，请手动访问：${hospital.url}`
      }

      return `✅ 已打开 **${hospital.name}** 的页面！

页面地址：${hospital.url}

页面上你可以看到：
• 📍 医院地址和地图
• ⏰ 营业时间
• 💰 价格表和优惠
• 👨‍⚕️ 医生团队介绍
• ✅ 预约面诊 / 咨询按钮

接下来可以：
• 说"帮我预约" → 自动点击预约按钮
• 说"咨询客服" → 自动点击咨询按钮
• 说"换一家"并告诉我医院名 → 切换医院`
    }

    // ——————————————————————————————————————————
    // 第3轮：直接打开预约表单页 → 询问预约信息
    // ——————————————————————————————————————————
    if (intent === 'book') {
      const hospital = resolveHospital()

      if (!hospital) {
        return '❌ 我还不知道你要预约哪家医院，请告诉我医院名称，例如"帮我预约JD皮肤科"。'
      }

      const bookingUrl = hospital.booking_url || hospital.url
      await openUrl(bookingUrl).catch(() => {})

      return `✅ 预约表单已打开！

📝 请告诉我以下预约信息，我来帮你自动填写并提交：

1. **预约人数**（例如：1人、2人）
2. **预约时间**（例如：3月26日）
3. **联系方式**（手机号或微信号）

👉 直接回复，例如："**2人，3月26日，13800138000**"`
    }

    // ——————————————————————————————————————————
    // 第4轮：用户提供信息 → 自动填表 + 提交
    // ——————————————————————————————————————————
    if (intent === 'fill_form') {
      const hospital = resolveHospital()

      if (!hospital) {
        return '❌ 我还不知道你要预约哪家医院，请先告诉我医院名称，例如"帮我预约JD皮肤科"。'
      }

      // 解析用户输入的表单字段
      const formData = parseFormInput(query)
      console.log(`[Booking Skill] 解析表单数据：`, JSON.stringify(formData))

      // 校验必填字段
      if (!formData.dateText) {
        return `⚠️ 请告诉我预约时间，例如："3月26日"。

其他信息可选：
• 预约人数（默认1人）
• 联系方式（手机号或微信号）`
      }

      const result = await fillBookingForm(hospital.url, hospital.booking_url, formData)

      if (result.success) {
        return `✅ **预约已提交！**

📋 **预约信息摘要：**
• 🏥 机构：${hospital.name}
• 👥 人数：${formData.persons} 人
• 📅 时间：${formData.dateText}${formData.contact ? `\n• 📞 联系方式：${formData.contact}` : ''}

🎉 提交成功！BeautsGO 平台会尽快联系机构为你匹配时间，确认短信将发送到你的账号绑定手机。

还有什么需要帮忙吗？`
      } else {
        return `⚠️ 自动填写遇到问题：${result.message}

你可以在已打开的浏览器中手动完成填写：
1. 选择预约人数
2. 选择预约时间（${formData.dateText}）
3. 填写联系方式
4. 点击"去付款"提交

如需其他帮助，随时告诉我！`
      }
    }

    // ——————————————————————————————————————————
    // 第4轮：咨询客服 → 直接打开咨询页
    // ——————————————————————————————————————————
    if (intent === 'consult') {
      const hospital = resolveHospital()

      if (!hospital) {
        return '❌ 我还不知道你要咨询哪家医院，请告诉我医院名称，例如"帮我咨询JD皮肤科"。'
      }

      const chatUrl = getChatUrl(hospital)
      const opened = await openUrl(chatUrl).then(() => true).catch(() => false)

      if (opened) {
        return `✅ 已为你打开 **${hospital.name}** 的在线客服对话页面！

客服页面：${chatUrl}

你可以直接向客服咨询：
• 询问价格和套餐详情
• 询问指定医生是否有档期
• 确认预约时间
• 了解术前术后注意事项

还需要预约或其他帮助吗？`
      } else {
        return `⚠️ 自动打开咨询页面失败，请手动访问：

${chatUrl}

除了网页客服，你也可以通过：
• 微信公众号搜索「BeautsGO 彼此美 APP」
• 添加客服微信：BeautsGOkr

还需要其他帮助吗？`
      }
    }

  } catch (err) {
    console.error('[Booking Skill] Error:', err.message)
    return `❌ 处理请求时出错：${err.message}。请重试或告诉我具体需求。`
  }
}
