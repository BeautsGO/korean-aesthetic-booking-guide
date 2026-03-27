#!/usr/bin/env node
/**
 * fill-form.js — 打开预约表单页并自动填写提交
 *
 * 用法：
 *   node api/browser/fill-form.js <booking_url> <persons> <dateText> [contact]
 *
 *   booking_url — 预约表单页 URL
 *   persons     — 预约人数（数字）
 *   dateText    — 预约日期文本，例如 "3月26日"
 *   contact     — 联系方式（可选）
 *
 * 退出码：
 *   0 — 提交成功
 *   2 — 部分失败（页面已打开，需手动操作）
 *   1 — 严重错误
 */

const { createAuthorizedPage } = require('./consult')

async function fillForm(bookingUrl, persons, dateText, contact) {
  let browser
  try {
    const result = await createAuthorizedPage(bookingUrl)
    browser = result.browser
    const page = result.page

    console.log('⏳ Waiting for booking form...')
    await page.waitForSelector('.u-number-box__plus, .sub-right', { timeout: 15000 }).catch(() => {})
    await page.waitForTimeout(2000)

    // ── 1. 填写人数 ────────────────────────────────────────
    if (persons && persons > 1) {
      console.log(`👥 Setting persons: ${persons}`)
      await page.evaluate((n) => {
        const input = document.querySelector('.u-number-box__input input, input.uni-input-input[type="number"]')
        if (input) {
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
          setter.call(input, n)
          input.dispatchEvent(new Event('input', { bubbles: true }))
          input.dispatchEvent(new Event('change', { bubbles: true }))
        }
      }, persons)

      const current = await page.evaluate(() => {
        const input = document.querySelector('input.uni-input-input[type="number"]')
        return input ? parseInt(input.value, 10) : 1
      })
      const clicks = persons - (current || 1)
      for (let i = 0; i < clicks; i++) {
        await page.evaluate(() => {
          const btn = document.querySelector('.u-number-box__plus')
          if (btn) btn.click()
        })
        await page.waitForTimeout(300)
      }
    }

    // ── 2. 选择预约时间 ────────────────────────────────────
    if (dateText) {
      console.log(`📅 Selecting date: ${dateText}`)
      await page.evaluate(() => {
        for (const row of document.querySelectorAll('.flex.info.add')) {
          if (row.textContent?.includes('选择预约时间')) { row.click(); return }
        }
      })
      await page.waitForTimeout(2000)

      const dayMatch = dateText.match(/(\d{1,2})[日号]$/) || dateText.match(/[月\/\-](\d{1,2})/)
      const targetDay = dayMatch ? parseInt(dayMatch[1], 10) : null

      if (targetDay) {
        const dateClicked = await page.evaluate((day) => {
          // 优先：在 .u-calendar 内找 SPAN 文本匹配的日期格子
          const calendar = document.querySelector('.u-calendar')
          if (calendar && calendar.offsetParent !== null) {
            for (const span of calendar.querySelectorAll('span')) {
              if ((span.textContent || '').trim() === String(day) && span.offsetParent !== null) {
                span.click(); return true
              }
            }
          }
          // 降级：在所有可见 .u-popup 内找
          for (const popup of document.querySelectorAll('.u-popup')) {
            if (popup.offsetParent !== null) {
              for (const el of popup.querySelectorAll('*')) {
                if ((el.textContent || '').trim() === String(day) && el.offsetParent !== null) {
                  el.click(); return true
                }
              }
            }
          }
          return false
        }, targetDay)

        console.log(`📅 Date ${targetDay} clicked: ${dateClicked}`)
        await page.waitForTimeout(1500)

        const nextClicked = await page.evaluate(() => {
          // 优先：u-calendar__confirm 按钮
          const confirm = document.querySelector('.u-calendar__confirm')
          if (confirm && confirm.offsetParent !== null) { confirm.click(); return true }
          // 降级：文本匹配
          for (const el of document.querySelectorAll('*')) {
            const text = (el.textContent || '').trim()
            if ((text === '下一步' || text === '确定' || text === '完成') && el.offsetParent !== null) {
              el.click(); return true
            }
          }
          return false
        })
        console.log(`⏭️  Next button clicked: ${nextClicked}`)
        await page.waitForTimeout(1500)
      }
    }

    // ── 3. 填写联系方式 ────────────────────────────────────
    if (contact && contact.length > 0) {
      console.log(`📞 Filling contact: ${contact}`)
      await page.evaluate((c) => {
        const inputs = document.querySelectorAll('input.uni-input-input[type="text"], input[type="text"]')
        for (const input of inputs) {
          if (input.offsetParent !== null) {
            const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
            setter.call(input, c)
            input.dispatchEvent(new Event('input', { bubbles: true }))
            return true
          }
        }
        return false
      }, contact)
      await page.waitForTimeout(500)
    }

    // ── 4. 勾选服务条款 ────────────────────────────────────
    console.log('☑️  Accepting terms...')
    await page.evaluate(() => {
      const termsEl = document.querySelector('.text')
      if (termsEl) {
        const img = termsEl.querySelector('img, uni-image')
        if (img) { img.click(); return }
        termsEl.click()
      }
    })
    await page.waitForTimeout(500)

    // ── 5. 点击"去付款" ────────────────────────────────────
    console.log('💳 Clicking submit...')
    const submitted = await page.evaluate(() => {
      const btn = document.querySelector('.sub-right')
      if (btn && btn.offsetParent !== null) { btn.click(); return true }
      for (const el of document.querySelectorAll('*')) {
        const text = (el.textContent || '').trim()
        if ((text === '去付款' || text === '去下单' || text === '提交预约') && el.offsetParent !== null) {
          el.click(); return true
        }
      }
      return false
    })

    if (submitted) {
      console.log('✅ Form submitted')
      await page.waitForTimeout(3000)
      process.exit(0)
    } else {
      console.warn('⚠️  Submit button not found')
      process.exit(2)
    }

  } catch (err) {
    console.error(`❌ Error: ${err.message}`)
    if (browser) await browser.close()
    process.exit(1)
  }
}

if (require.main === module) {
  const [,, bookingUrl, persons, dateText, contact] = process.argv
  if (!bookingUrl || !dateText) {
    console.error('❌ Usage: node fill-form.js <booking_url> <persons> <dateText> [contact]')
    process.exit(1)
  }
  fillForm(bookingUrl, parseInt(persons) || 1, dateText, contact || '')
}

module.exports = { fillForm }
