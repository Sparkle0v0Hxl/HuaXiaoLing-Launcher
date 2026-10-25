// 上报设备中心设备名称
// 官方 PC 端在登录成功后调用此接口，将当前登录设备在“登录设备管理”中的名称设置为自定义名称

const createOption = require('../util/option.js')

module.exports = async (query, request) => {
  const deviceName = String(query.deviceName || query.name || '').trim()

  if (!deviceName) {
    return Promise.reject({
      status: 400,
      body: {
        code: 400,
        msg: '缺少必要参数: deviceName',
      },
    })
  }

  const data = {
    deviceName,
  }

  return request(
    `/api/deviceinfo/center/upload`,
    data,
    createOption(query, 'eapi'),
  )
}
