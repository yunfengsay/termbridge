import { BaseApp } from '@zeppos/zml/base-app'
import { log as Logger } from '@zos/utils'

const logger = Logger.getLogger('termbridge-app')

App(
  BaseApp({
    globalData: {},
    onCreate() {
      logger.log('TermBridge companion started')
    },
    onDestroy() {
      logger.log('TermBridge companion stopped')
    }
  })
)
