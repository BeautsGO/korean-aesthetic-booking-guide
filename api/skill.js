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
 * 打开浏览器（系统默认浏览器，用于简单打开链接）
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
 * 创建一个预授权的 Playwright 页面（避免权限弹窗）
 * 用于自动化场景，自动点击"允许"按钮
 * 返回 { browser, page }，调用方负责关闭 browser
 */
async function createAuthorizedPage(url) {
  const browser = await playwright.chromium.launch({
    headless: false,
    args: [
      // 禁止浏览器弹出"打开外部应用"对话框
      '--disable-external-intent-requests',
      '--disable-features=ExternalProtocolDialog',
      '--no-default-browser-check',
    ]
  })

  // 预授权所有可能触发弹窗的权限
  const context = await browser.newContext({
    permissions: [
      'geolocation',
      'notifications',
      'clipboard-read',
      'clipboard-write',
    ],
    bypassCSP: true,
  })

  // 拦截 dialog 弹窗，全部自动接受
  context.on('page', page => {
    page.on('dialog', async dialog => {
      console.log(`[Booking Skill] Auto-accepting dialog: ${dialog.type()} - ${dialog.message()}`)
      await dialog.accept().catch(() => dialog.dismiss().catch(() => {}))
    })
  })

  const page = await context.newPage()

  // 拦截自定义协议跳转（如 beautsgo:// / intent:// 等），直接阻断避免弹窗
  await page.route('**/*', async (route) => {
    const reqUrl = route.request().url()
    if (!reqUrl.startsWith('http://') && !reqUrl.startsWith('https://')) {
      console.log(`[Booking Skill] Blocked custom protocol: ${reqUrl}`)
      await route.abort()
    } else {
      await route.continue()
    }
  })

  // page 本身的 dialog 监听
  page.on('dialog', async dialog => {
    console.log(`[Booking Skill] Page dialog auto-accepted: ${dialog.type()} - ${dialog.message()}`)
    await dialog.accept().catch(() => dialog.dismiss().catch(() => {}))
  })

  await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {
    console.warn('[Booking Skill] networkidle timeout, continuing anyway')
  })

  console.log(`[Booking Skill] Page loaded: ${url}`)
  return { browser, page }
}

/**
 * 自动点击预约按钮
 */
async function clickBookingButton(url) {
  let browser
  try {
    const result = await createAuthorizedPage(url)
    browser = result.browser
    const page = result.page

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
 * 解析用户输入，提取预约表单字段
 * @param {string} query 用户输入，如 "2人，3月26日，想做水光针"
 * @returns {{ persons: number, dateText: string, remark: string }}
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

  // 备注：去掉人数、日期后的剩余内容
  let remark = query
    .replace(/\d+\s*(人|位)/g, '')
    .replace(/两人|两位|三人|三位/g, '')
    .replace(/\d{1,4}[年月\/\-]\d{1,2}[日号月\/\-]?\d{0,2}[日号]?/g, '')
    .replace(/[，,。.、！!？?]/g, ' ')
    .trim()
  if (remark.length < 2) remark = ''

  return { persons, dateText, remark }
}

/**
 * 打开预约表单页面并自动填写提交
 * @param {string} url 医院页面 URL（会先打开医院页，再点预约按钮进入表单）
 * @param {{ persons: number, dateText: string, remark: string }} formData
 * @returns {{ success: boolean, message: string }}
 */
async function fillBookingForm(url, formData) {
  let browser
  try {
    const result = await createAuthorizedPage(url)
    browser = result.browser
    const page = result.page

    // 1. 等待医院页面渲染，点击"预约面诊"按钮
    console.log('[Booking Skill] 等待医院页面加载...')
    await page.waitForTimeout(5000)
    await page.waitForSelector('.btns-right', { timeout: 10000 }).catch(() => {})

    const bookClicked = await page.evaluate(() => {
      const elements = document.querySelectorAll('*')
      let target = null
      let minLen = Infinity
      for (const el of elements) {
        const text = (el.textContent || '').trim()
        if ((text === '预约面诊' || text === '立即预约' || text === '预约') && el.offsetParent !== null) {
          if (text.length < minLen) { minLen = text.length; target = el }
        }
      }
      if (target) { target.click(); return true }
      return false
    })

    if (!bookClicked) {
      return { success: false, message: '未找到预约按钮，请手动点击预约面诊' }
    }

    console.log('[Booking Skill] 已点击预约按钮，等待表单加载...')
    await page.waitForTimeout(5000)

    // 2. 填写人数
    if (formData.persons && formData.persons > 1) {
      console.log(`[Booking Skill] 设置人数：${formData.persons}`)
      // 直接设置 input 值
      await page.evaluate((n) => {
        const input = document.querySelector('.u-number-box__input input, input.uni-input-input[type="number"]')
        if (input) {
          const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
          nativeInputValueSetter.call(input, n)
          input.dispatchEvent(new Event('input', { bubbles: true }))
          input.dispatchEvent(new Event('change', { bubbles: true }))
        }
      }, formData.persons)
      // 用加号按钮逐一点击（更可靠）
      const currentVal = await page.evaluate(() => {
        const input = document.querySelector('input.uni-input-input[type="number"]')
        return input ? parseInt(input.value, 10) : 1
      })
      const clickCount = formData.persons - (currentVal || 1)
      for (let i = 0; i < clickCount; i++) {
        await page.evaluate(() => {
          const plusBtn = document.querySelector('.u-number-box__plus')
          if (plusBtn) plusBtn.click()
        })
        await page.waitForTimeout(300)
      }
    }

    // 3. 选择预约时间（点击时间行，弹出日期选择器）
    if (formData.dateText) {
      console.log(`[Booking Skill] 选择日期：${formData.dateText}`)
      // 点击时间行
      await page.evaluate(() => {
        const rows = document.querySelectorAll('.flex.info.add')
        for (const row of rows) {
          if (row.textContent?.includes('选择预约时间')) {
            row.click(); return
          }
        }
      })
      await page.waitForTimeout(2000)

      // 解析日期中的"日"数字
      const dayMatch = formData.dateText.match(/(\d{1,2})[日号]$/) ||
                       formData.dateText.match(/[月\/\-](\d{1,2})/)
      const targetDay = dayMatch ? parseInt(dayMatch[1], 10) : null

      if (targetDay) {
        // 在日历弹窗中找到对应日期并点击
        const dateClicked = await page.evaluate((day) => {
          // 查找所有文本为 day 的可见元素（日历格子）
          const allEls = document.querySelectorAll('*')
          for (const el of allEls) {
            const text = (el.textContent || '').trim()
            if (text === String(day) && el.offsetParent !== null) {
              // 排除页面其他数字（人数输入框等）
              const cls = el.className || ''
              if (cls.includes('day') || cls.includes('date') || cls.includes('calendar') ||
                  el.closest('[class*="calendar"]') || el.closest('[class*="date"]') ||
                  el.closest('.u-popup')) {
                el.click()
                return true
              }
            }
          }
          // 降级：在所有弹窗中找
          const popups = document.querySelectorAll('.u-popup')
          for (const popup of popups) {
            if (popup.offsetParent !== null) {
              const dayEls = popup.querySelectorAll('*')
              for (const el of dayEls) {
                if ((el.textContent || '').trim() === String(day) && el.offsetParent !== null) {
                  el.click()
                  return true
                }
              }
            }
          }
          return false
        }, targetDay)

        console.log(`[Booking Skill] 日期 ${targetDay} 点击结果：${dateClicked}`)
        await page.waitForTimeout(1500)

        // 点击"下一步"按钮（日历弹窗底部）
        const nextClicked = await page.evaluate(() => {
          const allEls = document.querySelectorAll('*')
          for (const el of allEls) {
            const text = (el.textContent || '').trim()
            if ((text === '下一步' || text === '确定' || text === '完成') && el.offsetParent !== null) {
              el.click()
              return true
            }
          }
          return false
        })
        console.log(`[Booking Skill] 下一步点击结果：${nextClicked}`)
        await page.waitForTimeout(1500)
      }
    }

    // 4. 填写备注
    if (formData.remark && formData.remark.length > 0) {
      console.log(`[Booking Skill] 填写备注：${formData.remark}`)
      const remarkFilled = await page.evaluate((remark) => {
        // 找 textarea 或 contenteditable
        const ta = document.querySelector('textarea, [contenteditable="true"]')
        if (ta) {
          ta.focus()
          ta.value = remark
          ta.dispatchEvent(new Event('input', { bubbles: true }))
          return true
        }
        // uni-textarea 内的原生 textarea
        const uniTa = document.querySelector('uni-textarea textarea')
        if (uniTa) {
          uniTa.focus()
          uniTa.value = remark
          uniTa.dispatchEvent(new Event('input', { bubbles: true }))
          return true
        }
        return false
      }, formData.remark)
      console.log(`[Booking Skill] 备注填写结果：${remarkFilled}`)
      await page.waitForTimeout(500)
    }

    // 5. 勾选服务条款
    console.log('[Booking Skill] 勾选服务条款...')
    await page.evaluate(() => {
      // 找条款区域的图片（作为复选框）或包含条款文字的可点击元素
      const termsEl = document.querySelector('.text')
      if (termsEl) {
        // 点击条款区域的图标（通常是前面的 checkbox 图片）
        const img = termsEl.querySelector('img, uni-image')
        if (img) { img.click(); return }
        termsEl.click()
      }
    })
    await page.waitForTimeout(500)

    // 6. 点击"去付款"/"去下单"按钮
    console.log('[Booking Skill] 点击去付款/去下单...')
    const submitClicked = await page.evaluate(() => {
      // 优先 .sub-right（确认为可见的按钮）
      const subRight = document.querySelector('.sub-right')
      if (subRight && subRight.offsetParent !== null) {
        subRight.click()
        return true
      }
      // 降级：文字匹配
      const allEls = document.querySelectorAll('*')
      for (const el of allEls) {
        const text = (el.textContent || '').trim()
        if ((text === '去付款' || text === '去下单' || text === '提交预约') && el.offsetParent !== null) {
          el.click()
          return true
        }
      }
      return false
    })

    if (submitClicked) {
      console.log('[Booking Skill] ✅ 表单已提交')
      await page.waitForTimeout(3000)
      return { success: true, message: '预约已提交' }
    } else {
      return { success: false, message: '点击提交按钮失败，可能需要手动确认' }
    }

  } catch (err) {
    console.error('[Booking Skill] fillBookingForm error:', err.message)
    return { success: false, message: err.message }
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
    const result = await createAuthorizedPage(url)
    browser = result.browser
    const page = result.page

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
    // 第3轮：自动点击预约按钮 → 询问预约信息
    // ——————————————————————————————————————————
    if (intent === 'book') {
      const hospital = resolveHospital()

      if (!hospital) {
        return '❌ 我还不知道你要预约哪家医院，请告诉我医院名称，例如"帮我预约JD皮肤科"。'
      }

      const clicked = await clickBookingButton(hospital.url)

      if (clicked) {
        return `✅ 预约表单已打开！正在加载 **${hospital.name}** 的预约页面...

📝 请告诉我以下预约信息，我来帮你自动填写并提交：

1. **预约人数**（例如：1人、2人）
2. **预约时间**（例如：3月26日）
3. **备注需求**（可选，例如：想做水光针）

👉 直接回复，例如："**2人，3月26日，想做皮肤检测**"`
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
• 备注需求（可选）`
      }

      const result = await fillBookingForm(hospital.url, formData)

      if (result.success) {
        return `✅ **预约已提交！**

📋 **预约信息摘要：**
• 🏥 机构：${hospital.name}
• 👥 人数：${formData.persons} 人
• 📅 时间：${formData.dateText}${formData.remark ? `\n• 📝 备注：${formData.remark}` : ''}

🎉 提交成功！BeautsGO 平台会尽快联系机构为你匹配时间，确认短信将发送到你的账号绑定手机。

还有什么需要帮忙吗？`
      } else {
        return `⚠️ 自动填写遇到问题：${result.message}

你可以在已打开的浏览器中手动完成填写：
1. 选择预约人数
2. 选择预约时间（${formData.dateText}）
3. 勾选服务条款
4. 点击"去付款"提交

如需其他帮助，随时告诉我！`
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
