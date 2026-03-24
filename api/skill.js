const { getBookingGuide } = require('../core/service')
const { exec } = require('child_process')
const { promisify } = require('util')
const playwright = require('playwright')
const hospitals = require('../data/hospitals.json')
const { matchHospital } = require('../core/resolver')
const { extractHospitalKeyword } = require('../core/preprocessor')

const execAsync = promisify(exec)

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

  if (isConsultIntent) return 'consult'
  if (isBookIntent) return 'book'
  if (isOpenIntent) return 'open'

  // 默认：含有医院名 or 含有问询词 → 查看预约流程
  return 'view'
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
 * 打开浏览器
 */
async function openBrowser(url) {
  try {
    if (process.platform === 'darwin') {
      await execAsync(`open "${url}"`)
    } else if (process.platform === 'win32') {
      await execAsync(`start "${url}"`)
    } else {
      await execAsync(`xdg-open "${url}"`)
    }
    console.log(`[Booking Skill] Browser opened: ${url}`)
    return true
  } catch (err) {
    console.error('[Booking Skill] Failed to open browser:', err.message)
    return false
  }
}

/**
 * 自动点击预约按钮
 */
async function clickBookingButton(url) {
  let browser
  try {
    browser = await playwright.chromium.launch({ headless: false })
    const context = await browser.newContext()
    const page = await context.newPage()

    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {})
    console.log(`[Booking Skill] Page loaded: ${url}`)
    await page.waitForTimeout(5000)

    // 等待预约按钮出现
    await page.waitForSelector('.btns-right', { timeout: 10000 }).catch(() => {})

    // 策略1: DOM 直接点击
    const clicked = await page.evaluate(() => {
      // 查找"预约面诊"按钮
      const elements = document.querySelectorAll('*')
      let target = null
      let minLen = Infinity
      for (const el of elements) {
        const text = (el.textContent || '').trim()
        if ((text === '预约面诊' || text === '立即预约' || text === '预约') && el.offsetParent !== null) {
          if (text.length < minLen) {
            minLen = text.length
            target = el
          }
        }
      }
      if (target) {
        target.click()
        return true
      }
      // 备选：class 包含 book 或 reservation
      const btn = document.querySelector('[class*="book"],[class*="reservation"],[class*="appoint"]')
      if (btn) { btn.click(); return true }
      return false
    })

    if (clicked) {
      console.log(`[Booking Skill] ✅ Booking button clicked`)
      await page.waitForTimeout(3000)
      return true
    }

    console.warn('[Booking Skill] Booking button not found')
    return false
  } catch (err) {
    console.error('[Booking Skill] Failed to click booking button:', err.message)
    return false
  } finally {
    if (browser) await browser.close()
  }
}

/**
 * 自动点击客服咨询按钮
 * 优化：使用 waitForSelector + 直接 DOM 操作的混合策略
 */
async function clickConsultButton(url) {
  let browser
  try {
    browser = await playwright.chromium.launch({ headless: false })
    const context = await browser.newContext()
    const page = await context.newPage()

    console.log(`[Booking Skill] Loading page: ${url}`)
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {})

    console.log(`[Booking Skill] Waiting for Vue components to render...`)
    await page.waitForTimeout(8000)

    console.log(`[Booking Skill] Looking for consult button...`)

    // 策略1: waitForSelector 等待元素出现
    await page.waitForSelector('.btns-consult', { timeout: 10000 }).catch(() => {})

    // 策略2: DOM 直接点击
    const clickSuccess = await page.evaluate(() => {
      try {
        // 方法1: class 精确定位
        let button = document.querySelector('.btns-consult')
        if (button) {
          button.click()
          return true
        }

        // 方法2: 精确文本"咨询一下"
        const elements = document.querySelectorAll('*')
        for (const el of elements) {
          const text = (el.textContent || '').trim()
          if (text === '咨询一下' && el.offsetParent !== null) {
            el.click()
            return true
          }
        }

        // 方法3: 最小可见含"咨询"元素
        let targetButton = null
        let minTextLength = Infinity
        for (const el of elements) {
          const text = (el.textContent || '').trim()
          if (text.includes('咨询') && el.offsetParent !== null && text.length < 100) {
            if (text.length < minTextLength) {
              minTextLength = text.length
              targetButton = el
            }
          }
        }
        if (targetButton) {
          targetButton.click()
          return true
        }

        return false
      } catch (e) {
        return false
      }
    })

    if (clickSuccess) {
      console.log(`[Booking Skill] ✅ Consult button clicked successfully`)
      await page.waitForTimeout(3000)
      return true
    }

    // 策略3: Playwright fallback
    const fallbackSelectors = ['text=/咨询一下/', '[class*="consult"]', 'text=/咨询/']
    for (const selector of fallbackSelectors) {
      try {
        const locator = page.locator(selector).first()
        if (await locator.count() > 0 && await locator.isVisible().catch(() => false)) {
          await locator.click()
          console.log(`[Booking Skill] ✅ Clicked with fallback selector: ${selector}`)
          await page.waitForTimeout(2000)
          return true
        }
      } catch (e) {
        // 继续
      }
    }

    console.warn('[Booking Skill] ❌ Consult button could not be found or clicked')
    return false
  } catch (err) {
    console.error('[Booking Skill] Failed to click consult button:', err.message)
    return false
  } finally {
    if (browser) await browser.close()
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
   * 优先级：context.resolvedHospital > 从 query 解析 > 从 context.lastQuery 解析
   */
  function resolveHospital() {
    // 优先从 context 中读取上一轮已解析的医院
    if (context.resolvedHospital && context.resolvedHospital.name) {
      return context.resolvedHospital
    }

    // 尝试从当前 query 解析
    const keyword = extractHospitalKeyword(query)
    if (keyword) {
      const h = matchHospital(keyword, hospitals)
      if (h) return h
    }

    // 尝试从上一轮保存的原始 query 解析
    if (context.lastQuery) {
      const keyword2 = extractHospitalKeyword(context.lastQuery)
      if (keyword2) {
        const h2 = matchHospital(keyword2, hospitals)
        if (h2) return h2
      }
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

      const opened = await openBrowser(hospital.url)
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
    // 第3轮：自动点击预约按钮
    // ——————————————————————————————————————————
    if (intent === 'book') {
      const hospital = resolveHospital()

      if (!hospital) {
        return '❌ 我还不知道你要预约哪家医院，请告诉我医院名称，例如"帮我预约JD皮肤科"。'
      }

      await openBrowser(hospital.url)
      const clicked = await clickBookingButton(hospital.url)

      if (clicked) {
        return `✅ 已帮你点击 **${hospital.name}** 的预约按钮！页面已跳转到预约表单。

📝 请在表单中填写以下信息：
• 你的姓名（拼音或中文均可）
• 联系电话（建议填写可接收短信的号码）
• 预约日期和时间
• 选择医生（如有选项）
• 希望咨询的项目或症状描述

✅ 填写完成后点击"确认预约"或"提交"即可。

预约成功后，医院通常会在 1 个工作日内通过电话或短信与你确认。

还需要帮助吗？`
      } else {
        return `⚠️ 自动点击预约按钮未成功，但页面已为你打开。

请在浏览器中手动操作：
1. 找到页面上的蓝色"预约面诊"按钮
2. 点击进入预约表单
3. 填写信息后提交

医院页面：${hospital.url}

如需帮助，可以告诉我"咨询客服"，我帮你联系医院客服。`
      }
    }

    // ——————————————————————————————————————————
    // 第4轮：自动点击咨询按钮
    // ——————————————————————————————————————————
    if (intent === 'consult') {
      const hospital = resolveHospital()

      if (!hospital) {
        return '❌ 我还不知道你要咨询哪家医院，请告诉我医院名称，例如"帮我咨询JD皮肤科"。'
      }

      await openBrowser(hospital.url)
      const clicked = await clickConsultButton(hospital.url)

      if (clicked) {
        return `✅ 已帮你打开 **${hospital.name}** 的在线客服对话！

我已经：
1. 打开了医院页面
2. 自动点击了"咨询一下"按钮

现在客服对话窗口应该已打开，你可以直接：
• 询问价格和套餐详情
• 询问指定医生是否有档期
• 确认预约时间
• 了解术前术后注意事项

如果对话窗口没有自动打开，请手动点击页面上的"咨询一下"按钮。

还需要预约或其他帮助吗？`
      } else {
        return `⚠️ 自动点击咨询按钮未成功，但页面已为你打开。

请在浏览器中手动操作：
1. 找到页面上的"咨询一下"按钮（通常在页面右上方）
2. 点击后会打开在线客服对话窗口

医院页面：${hospital.url}

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
