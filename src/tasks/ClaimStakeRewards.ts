import Logger from "../Logger";
import { PAGE_WAXWALLET_STACK, TIME_15_MINITE, TIME_5_MINITE, TIME_DAY, TIME_MINITE, URL_WAX_WALLET_STAKING, WAX_API_GET_ACCOUNT, WAX_API_PUSH_TRANSACTION } from "../utils/constant";
import BaseTask, { NextActionType, TaskState } from "./BaseTask";
import { sleep } from '../utils/utils'
import { getAwakeTime, random } from "../utils/utils";
import { DATA_KEY_ACCOUNT_INFO, DATA_KEY_MINING, IAccountInfo, IMiningData } from "../types";
import { HTTPResponse, Page, PageEmittedEvents } from "puppeteer";
import { responseGuard, safeGetJson, sureClick } from "../utils/pputils";
import moment from 'moment'
import config from '../config'
import { UTCtoGMT } from "../utils/datetime";

const CLS_BTN_APPROVE = '.authorize-transaction-container .react-ripples button'

const STEP_PREPARE = 'prepare'
const STEP_CLAIM = 'claim'
const STEP_SKIP = 'skip'
const STEP_CONFIRM = 'confirm'
export interface IStackRewardsResult {
  claimed: number
  balance: number
  staked: number
}

let logger

export default class ClaimStakeRewards extends BaseTask<IStackRewardsResult> {

  private _readyEventFired = false
  private _account: IAccountInfo
  private _miningData: IMiningData
  private _lastClaimDataUpdated = false
  private _transactionOk = false
  private _transactionUpdated = false
  private _transaction = null

  constructor() {
    super('ClaimRewards')

    if (!logger) {
      logger = new Logger(this.name)
    }

    this.registerStep(STEP_PREPARE, this.initialClaim, true)
    this.registerStep(STEP_CLAIM, this.stepClaim)
    this.registerStep(STEP_SKIP, this.stepSkip)
    this.registerStep(STEP_CONFIRM, this.stepConfirm)
  }

  prepare(): boolean {
    this._account = this.provider.getData(DATA_KEY_ACCOUNT_INFO)
    this._miningData = this.provider.getData(DATA_KEY_MINING)
    return super.prepare()
  }


  /**
   * Get account info from API response
   * @param resp HTTPResponse object
   * @returns
   */
  private guardAccountInfo = async (resp: HTTPResponse): Promise<boolean> => {
    const req = resp.request()
    const payload = JSON.parse(req.postData())
    if (payload.account_name !== this._account.account) return false

    return true
  }

  private updateMiningData = async (resp: HTTPResponse) => {
    if (!await responseGuard(resp, [WAX_API_GET_ACCOUNT, this.guardAccountInfo]))
      return

    const dat = await safeGetJson(resp)
    if (dat) {
      const time = UTCtoGMT(dat.voter_info.last_claim_time)
      this._miningData.lastClaimDate = time
      this._lastClaimDataUpdated = true
      this.fireReadyEvent()
    }
  }

  private updateTransaction = async (resp: HTTPResponse) => {
    if (!await responseGuard(resp, WAX_API_PUSH_TRANSACTION))
      return

    if (!resp.ok()) {
      this._transactionOk = false
      this._transactionUpdated = true
      this._transaction = await safeGetJson(resp)
      if (!this._transaction) {
        this._transaction = `Transaction fail with status ${resp.status()}, ${resp.statusText()}`
      }
      return
    }

    this._transaction = await safeGetJson(resp)
    if (!this._transaction) return

    this._transactionOk = resp.ok()
    logger.debug('update trasaction', this._transaction)
    this._transactionUpdated = true
    this.fireReadyEvent()
  }

  private fireReadyEvent(): boolean {
    if (!this._lastClaimDataUpdated) return false
    if (this._readyEventFired) return false
    this._readyEventFired = true

    this.determineClaim()
    return true
  }

  private async initialClaim() {
    const page = await this.provider.getPage(PAGE_WAXWALLET_STACK)
    await page.bringToFront()

    page.on('response', this.updateMiningData)
    page.on('response', this.updateTransaction)
    await sleep(2)
    logger.debug('goto', URL_WAX_WALLET_STAKING)
    page.goto(URL_WAX_WALLET_STAKING)
      .then((info) => {
        logger.debug('Page ready', info)
      })
      .catch((err) => {
        console.log(err)
      })
  }

  private async removeListener() {
    const page = await this.provider.getPage(PAGE_WAXWALLET_STACK)
    page.off('response', this.updateMiningData)
    page.off('response', this.updateTransaction)
  }

  private async determineClaim() {
    const elapsed = new Date().getTime() - this._miningData.lastClaimDate.getTime()
    if (elapsed < TIME_DAY) {
      //
      this.nextStep(STEP_SKIP)
    } else {
      this.nextStep(STEP_CLAIM)
    }
  }

  private async stepClaim() {
    const page = await this.provider.getPage(PAGE_WAXWALLET_STACK)
    await page.bringToFront()

    const doApprove = async (popup: Page) => {
      const clickApproveButton = async (): Promise<NextActionType> => {
        try {
          await sureClick(popup, CLS_BTN_APPROVE)
          return NextActionType.Stop
        } catch (err) {
          logger.debug('Approve button click attempt failed', err)
        }
        return NextActionType.Continue
      }
      this.waitFor('Wait for approve', clickApproveButton, TIME_5_MINITE)
    }
    page.once(PageEmittedEvents.Popup, doApprove)

    const CLS_BTN_CLAIM = '.stake-card .button-tertiary'
    const waitClaimButton = async (): Promise<NextActionType> => {
      try {
        let btn = null
        const btns = await page.$$(CLS_BTN_CLAIM)
        if (btns && btns.length === 4) {
          btn = btns[3]
          const txt = await btn.evaluate(item => item.textContent)
          if (txt.indexOf('Claim Earnings') !== 0) {
            btn = null
          }
        }

        if (btn) {
          logger.log('🐝 Claiming...')
          await btn.click({
            delay: random(1600, 1000)
          })
          this.nextStep(STEP_CONFIRM)
          return NextActionType.Stop
        }
      } catch (err) { }

      return NextActionType.Continue
    }
    this.waitFor('Wait for Claim button', waitClaimButton, TIME_5_MINITE)
  }

  private async stepSkip() {
    this.removeListener()
    const diff = this._miningData.lastClaimDate.getTime() - new Date().getTime() + TIME_DAY
    const akt = getAwakeTime(diff < TIME_MINITE ? TIME_MINITE : diff)
    logger.log(`Reward already claimed. Next attempt at ${moment(akt).format(config.datetimeFormat)}`)
    this.complete(TaskState.Canceled, 'Wait for next claim', null, akt)
  }

  private async stepConfirm() {
    const checkTransaction = async (): Promise<NextActionType> => {
      if (!this._readyEventFired) return NextActionType.Continue
      if (!this._transactionUpdated) return NextActionType.Continue

      if (this._transactionOk) {
        logger.log('Claim success.')
        const akt = getAwakeTime(TIME_DAY)
        this.complete(TaskState.Completed, 'Claim success', null, akt)
      } else {
        const message = (this._transaction && this._transaction.error)
          ? this._transaction.error.details[0].message
          : 'Server error when mining, it\'s maybe a server problem'
        logger.log(message)
        const akt = getAwakeTime(TIME_15_MINITE)
        this.complete(TaskState.Completed, 'Claim success', null, akt)
      }

      this.removeListener()

      return NextActionType.Stop
    }

    logger.log('Confirming...')
    this.waitFor('confirm claim stake', checkTransaction, 2 * TIME_MINITE, async (): Promise<NextActionType> => {
      this.removeListener()
      return NextActionType.Stop
    })
  }
}
