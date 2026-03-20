const { getBookingGuide } = require('../core/service')

module.exports = async function (input) {
  return getBookingGuide(input.query, input.lang || 'zh')
}
