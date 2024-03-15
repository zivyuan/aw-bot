import { sleep } from '../utils/utils'
import Logger from "../Logger"
import BaseTask, { TaskState } from "./BaseTask"
import { PAGE_WAX_WALLET_TESTER, PAGE_WAXWALLET as PAGE_WAX_WALLET, WAX_API_SESSION, URL_WAX_WALLET, URL_WAX_WALLET_LOGIN } from "../utils/constant"
import DingBot from "../DingBot"
import { DATA_KEY_ACCOUNT_INFO, DATA_KEY_COOKIE, IAccountInfo, CookieObject } from "../types"
import { PageEmittedEvents } from "puppeteer"
import { safeGetJson } from "../utils/pputils"

export interface IWaxLoginResult {
  account: string
  balance: number
}

// const STEP_CHECK_COOKIE_CACHE = 'check_cookie_cache'
const STEP_RESTORE_COOKIE = 'restore_cookie'
const STEP_FILL_FORM = 'login'
const STEP_SAVE_COOKIE = 'save_cookie'

const SEL_IPT_USERNAME = '.button-container input[name="userName"]'
const SEL_IPT_PASSWORD = '.button-container input[name="password"]'

let logger
export class WaxLogin extends BaseTask<IWaxLoginResult> {

  constructor() {
    super('Wax Login')

    this.registerStep(STEP_RESTORE_COOKIE, this.stepAutoLogin, true)
    this.registerStep(STEP_FILL_FORM, this.stepFillForm)
    this.registerStep(STEP_SAVE_COOKIE, this.stepSaveSession)

    if (!logger) {
      logger = new Logger(this.name)
    }
  }

  private async stepAutoLogin() {
    const page = await this.provider.getPage(PAGE_WAX_WALLET)
    const title = await page.title()

    // Reload cookies after page loaded

    const handleDomLoaded = async () => {
      const url = await page.evaluate(() => document.location.href)

      if (url === URL_WAX_WALLET_LOGIN) {
        setTimeout(async () => {
          try {
            const ipt = await page.$(SEL_IPT_USERNAME)
            if (ipt) {
              unregisterEvents()
              this.nextStep(STEP_FILL_FORM)
            }
          } catch (err) { }
        }, 3000)

      } else if (url === URL_WAX_WALLET) {
        // Delay 3 seconds for page update
        await sleep(3)
        unregisterEvents()
        this.nextStep(STEP_SAVE_COOKIE)
      }
    }
    // Handle errors
    const handleError = (err) => {
      unregisterEvents()
      this.complete(TaskState.Canceled, err.message, null, new Date().getTime() + 60 * 1000)
    }

    const unregisterEvents = () => {
      page.off(PageEmittedEvents.DOMContentLoaded, handleDomLoaded)
      page.off(PageEmittedEvents.Error, handleError)
      page.off(PageEmittedEvents.PageError, handleError)
    }
    //

    // Register events
    page.on(PageEmittedEvents.Error, handleError)
    page.on(PageEmittedEvents.PageError, handleError)
    if (!PAGE_WAX_WALLET_TESTER.test(title || '')) {
      const cookie = this.provider.getData<CookieObject[]>(DATA_KEY_COOKIE)
      if (cookie && cookie.length) {
        await page.setCookie(...cookie)
        await sleep(1)
      }
    }

    page.on(PageEmittedEvents.DOMContentLoaded, handleDomLoaded)
    page.goto(URL_WAX_WALLET_LOGIN)
      .catch(err => {
        handleError(err)
      })
  }


  private async stepFillForm() {
    // Wax login page
    const page = await this.provider.getPage(PAGE_WAX_WALLET)

    // Chcek if account was baned
    const checkLoginStatus = async (resp) => {
      const respUrl = resp.url()
      const status = resp.status()
      if (respUrl.indexOf(WAX_API_SESSION) > -1) {
        if (resp.ok()) {
          // Login success
          await sleep(3)
          unregisterEvents()
          this.nextStep(STEP_SAVE_COOKIE)

        } else {
          // Api error, try again later, max try 5 times
          const dat = await safeGetJson(resp)
          let resons: string[]
          if (dat) {
            if (dat.challengeToken) {
              // Require e-mail verify code
              // {"challengeToken":"a424c879ccd645439d4ff9970e06220d"}
              resons = ['e-mail verify code required.']
            } else if (dat.token2fa) {
              // Require 2FA verfiy code
              // {"token2fa":"a8f4b6f9221c05ef5764b1e35e9d3bb6"}
              resons = ['2FA verify code required.']
            } else {
              if (dat.errors) {
                resons = dat.errors.map(item => `[${status}:${item.error_type}] ${item.message}`)
              } else {
                resons = [JSON.stringify(dat)]
              }
            }
          } else {
            resons = [
              'Response parse error.',
              `Raw: ${JSON.stringify(dat)}`
            ]
          }

          logger.log(`Login fail with statue [${status}]: `, resons)
          if (status === 429) {
            // Too many times, delay task
            const awakeTime = new Date().getTime() + 35 * 60 * 1000
            this.complete(TaskState.Canceled, dat.errors[0].message, null, awakeTime)
          }
        }
      }
    }

    const unregisterEvents = () => {
      page.off(PageEmittedEvents.Response, checkLoginStatus)
    }

    page.on(PageEmittedEvents.Response, checkLoginStatus)

    const btn_submit = '.button-container button'
    const { account, username, password } = this.provider.getData<IAccountInfo>(DATA_KEY_ACCOUNT_INFO)

    if (username) {
      logger.log(`Login with ${username}`)
    }
    await page.waitForSelector(SEL_IPT_USERNAME)
    await sleep(1)
    if (username) {
      await page.type(SEL_IPT_USERNAME, username, {
        delay: 160,
      });
    }
    await sleep(1)
    if (password) {
      await page.type(SEL_IPT_PASSWORD, password, {
        delay: 180,
      });
    }

    if (username && password) {
      await sleep(1)
      await page.click(btn_submit)
    } else {
      logger.log('Username and password were required!')
      DingBot.getInstance().text(`[${account}] Please complete login form!`)
    }
  }

  private async stepSaveSession() {
    logger.log('Save session data ...')
    const page = await this.provider.getPage(PAGE_WAX_WALLET)
    await page.waitForSelector('.profile .avatar')

    const { account } = this.provider.getData<IAccountInfo>(DATA_KEY_ACCOUNT_INFO)
    const cookies = await page.cookies()
    this.provider.setData(DATA_KEY_COOKIE, cookies, true)
    this.provider.setData(DATA_KEY_ACCOUNT_INFO, {
      logined: true,
      password: '',
    })
    logger.log('Wax login success.')
    this._shouldTerminate = true
    this.complete(TaskState.Completed, '', {
      account,
      balance: 0
    })

  }

}

export default WaxLogin
