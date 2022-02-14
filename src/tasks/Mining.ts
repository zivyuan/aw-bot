import BaseTask, { TaskState } from "./BaseTask";
import { getAwakeTime } from "../utils/utils";
import Logger from "../Logger";
import { PAGE_ALIEN_WORLDS, AW_API_GET_TABLE_ROWS, AW_API_PUSH_TRANSACTION } from "../utils/constant";
import { DATA_KEY_ACCOUNT_INFO, DATA_KEY_MINING, IAccountInfo, IMiningData } from "../types";
import { IMiningDataProvider } from "../Minion";
import { HTTPResponse, Page, PageEmittedEvents } from "puppeteer";
import moment from "moment";
import { sleep } from 'sleep'

// const CLS_TXT_BALANCE = '.css-1tan345 .css-ov2nki'
const CLS_BTN_MINE = '.css-1i7t220 .css-f33lh6 .css-10opl2l .css-t8p16t'
const CLS_BTN_CLAIM = '.css-1i7t220 .css-f33lh6 .css-1knsxs2 .css-t8p16t'
// const CLS_BTN_COOLDOWN = '.css-1i7t220 .css-f33lh6 .css-2s09f0'
const CLS_TXT_COOLDOWN = '.css-1i7t220 .css-f33lh6 .css-2s09f0 .css-ov2nki'
// const CLS_TXT_NEXT_MINE = '.css-1i7t220 .css-f33lh6 .css-2s09f0 .css-1phfdwl'
const CLS_BTN_APPROVE = '.authorize-transaction-container .react-ripples button'

const STEP_PREPARE = 'prepare'
const STEP_MINE = 'mine'
const STEP_CLAIM = 'claim'
const STEP_CONFIRM = 'comfirm'

enum MiningStage {
  None,
  Mine,
  Claim,
  Cooldown,
  Complete,
}


const logger = new Logger('Mining')

export interface IMiningResult {
  nextAttemptAt: number
  total: number
  reward: number
  cpu?: number
  net?: number
  ram?: number
}

export default class Mining extends BaseTask<IMiningResult> {

  static initial(provider: IMiningDataProvider) {
    const data = provider.getData<IMiningData>(DATA_KEY_MINING)
    data.counter = 0
    provider.setData(DATA_KEY_MINING, data)
  }

  private _account: IAccountInfo
  private _miningStage = MiningStage.None
  private _miningSuccess = false
  private _balanceInitialed = false
  private _balance = 0
  private _balanceChange = 0
  private _addEventListener
  private _removeEventListener

  constructor() {
    super('Mining')

    this.registerStep(STEP_PREPARE, this.stepPrepare, true)
    this.registerStep(STEP_MINE, this.stepMine)
    this.registerStep(STEP_CLAIM, this.stepClaim)
    this.registerStep(STEP_CONFIRM, this.stepConfirm)
  }

  private async getCurrentStage(): Promise<MiningStage> {
    let stage = MiningStage.None

    try {
      const page = await this.provider.getPage(PAGE_ALIEN_WORLDS)
      const btnMine = await page.$(CLS_BTN_MINE)
      const btnClaim = await page.$(CLS_BTN_CLAIM)
      const txtCooldown = await page.$(CLS_TXT_COOLDOWN)
      if (btnMine) {
        stage = MiningStage.Mine
      } else if (btnClaim) {
        stage = MiningStage.Claim
      } else if (txtCooldown) {
        stage = MiningStage.Cooldown
      }
    } catch (err) { }

    this._miningStage = stage

    return stage
  }

  private async getCooldown(page: Page): Promise<number> {
    const txtCooldown = await page.$eval(CLS_TXT_COOLDOWN, item => item.textContent)
    const multiplier = [60 * 60, 60, 1]
    const cooldown = txtCooldown.split(':')
      .map((item, idx) => (multiplier[idx] * parseInt(item)))
      .reduce((a, b) => a + b)
    return cooldown * 1000
  }

  private async stepPrepare() {
    const data = this.provider.getData<IMiningData>(DATA_KEY_MINING)
    logger.log(`👷 Ready for ${data.counter + 1}th mine`)

    const stage = await this.getCurrentStage()

    if (stage === MiningStage.Mine) {
      this.nextStep(STEP_MINE)
    }
    else if (stage === MiningStage.Claim) {
      this.nextStep(STEP_CLAIM)
    }
    else if (stage === MiningStage.Cooldown) {
      const page = await this.provider.getPage(PAGE_ALIEN_WORLDS)
      const cooldown = await this.getCooldown(page)
      const awakeTime = getAwakeTime(cooldown)
      logger.log('Tools cooldown, next mining scheduled at ' + (moment(awakeTime).format('YYYY-MM-DD HH:mm:ss')))
      this.complete(TaskState.Canceled, 'Cooldown', null, awakeTime)
    }
    else {
      // Undetermined stage
      setTimeout(() => {
        this.stepPrepare()
      }, 3000);
    }
  }

  private async stepMine() {
    const page = await this.provider.getPage(PAGE_ALIEN_WORLDS)
    await page.bringToFront()

    const watchBalance = async (resp: HTTPResponse): Promise<unknown> => {
      const url = resp.url()
      if (url.indexOf(AW_API_GET_TABLE_ROWS) === -1) {
        return
      }

      if (!resp.ok()) {
        return
      }

      // Filter by request data
      //
      // {
      //   "json": true,
      //   "code": "alien.worlds",
      //   "scope": "yekm2.c.wam",
      //   "table": "accounts",
      //   "lower_bound": "",
      //   "upper_bound": "",
      //   "index_position": 1,
      //   "key_type": "",
      //   "limit": 10,
      //   "reverse": false,
      //   "show_payer": false
      // }
      const req = resp.request()
      const postData = JSON.parse(req.postData())
      if (postData.scope !== this._account.account
        || postData.table !== 'accounts'
        || postData.code !== 'alien.worlds') {
        return
      }

      let tlm = -1
      try {
        const dat = await resp.json()
        tlm = parseFloat(dat.rows[0].balance)
      } catch (err) {
        return
      }

      if (isNaN(tlm)) return

      if (this._balanceInitialed) {
        const change = tlm - this._balance
        if (change > 0) {
          this._balance = tlm
          this._balanceChange = change
        }
      } else {
        this._balance = tlm
        this._balanceInitialed = true
      }

      return
    }

    const watchTransaction = async (resp: HTTPResponse): Promise<unknown> => {
      const url = resp.url()
      if (url.indexOf(AW_API_PUSH_TRANSACTION) === -1) {
        return
      }

      // console.log('Push transaction match...', resp.ok())
      this._miningStage = MiningStage.Complete
      this._miningSuccess = resp.ok()
      return
    }

    this._addEventListener = () => {
      page.on(PageEmittedEvents.Response, watchBalance)
      page.on(PageEmittedEvents.Response, watchTransaction)
    }
    this._removeEventListener = () => {
      page.off(PageEmittedEvents.Response, watchBalance)
      page.off(PageEmittedEvents.Response, watchTransaction)
    }

    this._addEventListener()

    logger.log('⛏ Mining...')
    await page.click(CLS_BTN_MINE)
    this.nextStep(STEP_CLAIM)
  }

  private async stepClaim() {
    const page = await this.provider.getPage(PAGE_ALIEN_WORLDS)

    const doApprove = async (popup: Page) => {
      const onApproved = () => {
        popup.off(PageEmittedEvents.Close, onApproved)

        unregisteEvents()

        // console.log('Approve popup closed')
      }

      popup.on(PageEmittedEvents.Close, onApproved)

      sleep(1)


      const clickApproveButton = async () => {
        try {
          const btnApprove = page.$(CLS_BTN_APPROVE)
          //
          // TODO: When session expired, popup page will display a login button
          //
          // const btnLogin = page.$('.error-container button[type="submit"]')
          // if (btnLogin) {
          //   // Reqeuir login, abort curren task
          //   popup.close()
          // }
          if (!btnApprove) {
            throw new Error('Button not ready')
          }
          await popup.click(CLS_BTN_APPROVE)
          sleep(1)
          this.nextStep(STEP_CONFIRM)
        } catch (err) {
          // Loop until popup closed
          if (!popup.isClosed()) {
            setTimeout(() => {
              clickApproveButton()
            }, 3000);
          } else {
            // What wrong???
          }
        }
      }
      clickApproveButton()
    }

    const unregisteEvents = () => {
      page.off(PageEmittedEvents.Popup, doApprove)
    }

    try {
      await page.waitForSelector(CLS_BTN_CLAIM, { timeout: 5 * 60 * 1000 })
      page.on(PageEmittedEvents.Popup, doApprove)
      logger.log('🐝 Claiming...')
      await page.click(CLS_BTN_CLAIM, { delay: 80 })
    } catch (err) {
      logger.log('Wait for CLS_BTN_CLAIM timeout, retry after 3 seconds')
      unregisteEvents()

      setTimeout(() => {
        this.stepClaim()
      }, 3000)
    }
  }

  private async stepConfirm() {
    logger.log('🐝 Confirming...')
    const page = await this.provider.getPage(PAGE_ALIEN_WORLDS)

    let cooldown = 0
    const confirmMining = () => {
      if (this._miningStage === MiningStage.Complete) {
        if (this._miningSuccess === false) {
          cooldown = 60 * 60 * 1000
        }

        if (cooldown) {
          const reward = Math.round(this._balanceChange * 10000) / 10000
          const awakeTime = getAwakeTime(cooldown)
          const awstr = moment(awakeTime).format('YYYY-MM-DD HH:mm:ss')
          const result: IMiningResult = {
            nextAttemptAt: awakeTime,
            total: this._balance,
            reward,
          }

          const conf = this.provider.getData<IMiningData>(DATA_KEY_MINING)
          this.provider.setData(DATA_KEY_MINING, {
            total: this._balance,
            rewards: conf.rewards + reward,
            counter: conf.counter + 1
          }, true)

          if (this._miningSuccess) {
            logger.log(`✨ ${reward} TLM mined, total ${this._balance} TLM.`)
            logger.log(`Next mine attempt scheduled at ${awstr}`)
          } else {
            logger.log(`Mining failed because of out of resource. Current total ${this._balance} TLM.`)
            logger.log(`Next mine attempt scheduled at ${awstr}`)
          }

          this._removeEventListener()
          this._miningStage = MiningStage.Cooldown
          this.complete(TaskState.Completed, 'Success', result, awakeTime)

          return
        }
      }

      setTimeout(() => {
        confirmMining()
      }, 1000)
    }

    const updateCooldown = async () => {
      try {
        if (this._miningStage === MiningStage.Complete && !this._miningSuccess) {
          const btnMine = await page.$(CLS_BTN_MINE)
          if (btnMine) {
            // Something error on mining
            const _r = () => {
              page.off(PageEmittedEvents.DOMContentLoaded, _r)
              // Button initial status was mine, wait a small seconds
              sleep(2)
              updateCooldown()
            }
            page.on(PageEmittedEvents.DOMContentLoaded, _r)
            sleep(1)
            page.reload()

            return
          }
        }

        const cdele = await page.$(CLS_TXT_COOLDOWN)
        if (cdele) {
          const cd = await this.getCooldown(page)
          if (cd) {
            cooldown = cd
            return
          }
        }
      } catch (err) {
      }

      setTimeout(() => {
        updateCooldown()
      }, 1000);
    }

    updateCooldown()
    confirmMining()
  }

  prepare(): boolean {
    const data = this.provider.getData<IAccountInfo>(DATA_KEY_ACCOUNT_INFO)
    if (!data.logined) {
      this._message = 'Not login.'
    }
    this._account = data
    return data.logined
  }
}
