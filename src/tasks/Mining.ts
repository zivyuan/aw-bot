import BaseTask, { NextActionType, TaskState } from './BaseTask';
import { getAwakeTime, random } from '../utils/utils';
import Logger from '../Logger';
import {
  PAGE_ALIEN_WORLDS,
  AW_API_GET_TABLE_ROWS,
  AW_API_PUSH_TRANSACTION,
  TIME_5_MINITE,
  AW_API_ASSETS_INFO,
  TIME_MINITE,
  URL_ALIEN_WORLDS_INVENTORY,
} from '../utils/constant';
import {
  DATA_KEY_ACCOUNT_INFO,
  DATA_KEY_MINING,
  IAccountInfo,
  IMiningData,
} from '../types';
import { IMiningDataProvider } from '../Minion';
import { HTTPResponse, Page, PageEmittedEvents } from 'puppeteer';
import moment from 'moment';
import { responseGuard, safeGetJson, sureClick } from '../utils/pputils';
import { UTCtoGMT } from '../utils/datetime';
import config from '../config';
import { sleep } from '../utils/utils'

const CLS_BTN_START = '.css-rrm59m';
const TXT_BTN_START = 'Start Now';
const CLS_BTN_MINE = '.css-rrm59m';
const TXT_BTN_MINE = 'Mine';
const CLS_BTN_CLAIM = '.css-rrm59m';
const TXT_BTN_CLAIM = 'Claim Mine';
// const CLS_BTN_APPROVE_LOGIN = '.error-container button[type="submit"]'
const CLS_BTN_APPROVE =
  '.authorize-transaction-container .react-ripples button';

const STEP_PREPARE = 'prepare';
const STEP_MINE = 'mine';
const STEP_CLAIM = 'claim';
const STEP_CONFIRM = 'comfirm';

let logger;

export interface IMiningResult {
  nextAttemptAt: number;
  total: number;
  reward: number;
  cpu?: number;
  net?: number;
  ram?: number;
}

const getMiningSpeed = (conf: [number, string][], hour: number) => {
  let i;
  for (i = 0; i < conf.length; i++) {
    if (hour < conf[i][0]) {
      return conf[i - 1][1];
    }
  }
  return conf[i - 1][1];
};

export default class Mining extends BaseTask<IMiningResult> {
  static initial(provider: IMiningDataProvider) {
    const data = provider.getData<IMiningData>(DATA_KEY_MINING);
    data.counter = 0;
    provider.setData(DATA_KEY_MINING, data);
  }

  private _account: IAccountInfo;
  // Status
  private _pageReady = false;
  private _balanceUpdated = false;
  private _assetsUpdated = false;
  private _bagUpdated = false;
  private _mineStatusUpdated = false;
  private _transactionUpdated = false;
  private _readyEventFired = false;

  private _balance = 0;
  private _balanceChanged = 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _assets: any[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _bagItems = {
    items: [],
    locked: 0,
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _mineStatus: any = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _transaction: any = null;
  private _transactionOk = false;

  constructor() {
    super('Mining');

    if (!logger) {
      logger = new Logger(this.name);
    }

    this.registerStep(STEP_PREPARE, this.stepPrepare, true);
    this.registerStep(STEP_MINE, this.stepMine);
    this.registerStep(STEP_CLAIM, this.stepClaim);
    this.registerStep(STEP_CONFIRM, this.stepConfirm);
  }

  private getSmartAwakeTime(cooldown: number, rnd?: number): number {
    const now = new Date();
    const hour = now.getHours();
    const speed = getMiningSpeed(config.mining.smartSpeed, hour);
    let interval = config.mining.speeds[speed] * 1000;
    if (interval < cooldown) interval = cooldown;
    return getAwakeTime(interval, rnd);
  }

  private getCooldown(): number {
    const tools = this._bagItems.items.map((item) => {
      const assets = this._assets.find((ast) => ast.asset_id === item.asset_id);
      return assets ? assets : item;
    });
    if (tools.length >= 3) {
      tools.sort((a, b) => (a.data.delay < b.data.delay ? 1 : -1));
      tools.splice(2, tools.length - 2);
    }
    const sum = tools.map((item) => item.data.delay).reduce((a, b) => a + b);
    const land = this._assets.find(
      (ast) => ast.asset_id === this._mineStatus.current_land,
    );
    const cooldown = sum * (land.data.delay / 10);
    return cooldown * 1000;
  }

  /**
   *
   *
   * Payload
   * ```
   *   {
   *     "json": true,
   *     "code": "m.federation",
   *     "scope": "m.federation",
   *     "table": "miners",
   *     "lower_bound": "4ryba.wam",
   *     "upper_bound": "4ryba.wam",
   *     "index_position": 1,
   *     "key_type": "",
   *     "limit": 10,
   *     "reverse": false,
   *     "show_payer": false
   *   }
   * ```
   * @param resp
   * @returns
   */
  private guardMineStatus = async (resp: HTTPResponse): Promise<boolean> => {
    const api = AW_API_GET_TABLE_ROWS;
    const url = resp.url();
    if (url.indexOf(api) === -1) return false;
    const req = resp.request();
    const payload = JSON.parse(req.postData());
    if (payload.table !== 'miners') return false;
    if (payload.code !== 'm.federation') return false;
    if (payload.lower_bound !== this._account.account) return false;

    return true;
  };

  /**
   *
   *
   * Payload
   * ```
   *   {
   *     "json": true,
   *     "code": "alien.worlds",
   *     "scope": "4ryba.wam",
   *     "table": "accounts",
   *     "lower_bound": "",
   *     "upper_bound": "",
   *     "index_position": 1,
   *     "key_type": "",
   *     "limit": 10,
   *     "reverse": false,
   *     "show_payer": false
   *   }
   * ```
   * @param resp
   * @returns
   */
  private guardBalance = async (resp: HTTPResponse): Promise<boolean> => {
    // if (!(await responseGuard(resp, AW_API_GET_TABLE_ROWS))) return false
    const req = resp.request();
    const payload = JSON.parse(req.postData());
    if (payload.table !== 'accounts') return false;
    if (payload.code !== 'alien.worlds') return false;
    if (payload.scope !== this._account.account) return false;

    return true;
  };

  /**
   *
   * @param resp
   * @returns
   */
  private guardAssetsInfo = async (resp: HTTPResponse): Promise<boolean> => {
    // if (!(await responseGuard(resp, AW_API_ASSETS_INFO))) return false
    const url = resp.url();
    const pat1 = `&collection_name=alien.worlds`;
    if (url.indexOf(pat1) === -1) return false;

    return true;
  };

  /**
   *
   * Payload:
   *  {
   *    code: "m.federation"
   *    index_position: 1
   *    json: true
   *    key_type: ""
   *    limit: 10
   *    lower_bound: "4ryba.wam"
   *    reverse: false
   *    scope: "m.federation"
   *    show_payer: false
   *    table: "bags"
   *    upper_bound: "4ryba.wam"
   *  }
   * @param resp
   * @returns
   */
  private guardBagInfo = async (resp: HTTPResponse): Promise<boolean> => {
    // if (!(await responseGuard(resp, AW_API_ASSETS_INFO))) return false
    const req = resp.request();
    const payload = JSON.parse(req.postData());
    if (payload.table !== 'bags') return false;
    if (payload.code !== 'm.federation') return false;
    if (payload.lower_bound !== this._account.account) return false;

    return true;
  };

  private updateBalance = async (resp: HTTPResponse) => {
    if (
      !(await responseGuard(resp, [AW_API_GET_TABLE_ROWS, this.guardBalance]))
    )
      return;

    if (!resp.ok()) return;

    const dat = await safeGetJson(resp);
    if (!dat) return;

    const tlm = parseFloat(dat.rows[0].balance);
    if (tlm !== this._balance) {
      this._balanceChanged = tlm - this._balance;
      this._balance = tlm;

      logger.debug(
        `update balance: total ${this._balance.toFixed(
          4,
        )} tlm, changed ${this._balanceChanged.toFixed(4)} tlm`,
      );
      this._balanceUpdated = true;
      this.fireReadyEvent();
    }
  };

  private updateAssetsInfo = async (resp: HTTPResponse) => {
    if (
      !(await responseGuard(resp, [AW_API_ASSETS_INFO, this.guardAssetsInfo]))
    )
      return;

    if (!resp.ok()) return;

    const dat = await safeGetJson(resp);
    if (!dat) return;

    const count = this._assets.length;
    const newAssets = dat.data.filter(
      (item) => !this._assets.find((_t) => _t.asset_id === item.asset_id),
    );
    this._assets = this._assets.concat(newAssets);

    if (this._assets.length !== count) {
      logger.debug('update assets', count, this._assets);
      this._assetsUpdated = true;
      this.fireReadyEvent();
    }
  };

  private updateBagInfo = async (resp: HTTPResponse) => {
    if (
      !(await responseGuard(resp, [AW_API_GET_TABLE_ROWS, this.guardBagInfo]))
    )
      return;

    if (!resp.ok()) return;

    const dat = await safeGetJson(resp);
    if (!dat) return;

    const itemids = this._bagItems.items.map((item) => item.asset_id);
    const items = dat.rows
      .map((item) => ({
        key: item.account,
        value: {
          locked: item.locked,
          items: item.items.map((item) => ({ asset_id: item })),
        },
      }))
      .reduce((a, b) => Object.assign(a, { [b.key]: b.value }), {});
    this._bagItems = items[this._account.account] || {
      items: [],
      locked: 0,
    };
    const itemidsn = this._bagItems.items.map((item) => item.asset_id);
    if (itemids.join() !== itemidsn.join()) {
      logger.debug('update bag', this._bagItems);
      this._bagUpdated = true;
      this.fireReadyEvent();
    }
  };

  private updateMineStatus = async (resp: HTTPResponse) => {
    if (
      !(await responseGuard(resp, [
        AW_API_GET_TABLE_ROWS,
        this.guardMineStatus,
      ]))
    )
      return;

    if (!resp.ok()) return;

    const dat = await safeGetJson(resp);
    if (!dat) return;

    if (dat.rows[0].last_mine !== this._mineStatus.last_mine) {
      this._mineStatus = dat.rows[0];

      logger.debug('update mine status', this._mineStatus);
      this._mineStatusUpdated = true;
      this.fireReadyEvent();
    }
  };

  private updateTransaction = async (resp: HTTPResponse) => {
    if (!(await responseGuard(resp, AW_API_PUSH_TRANSACTION))) return;

    if (!resp.ok()) {
      this._transactionOk = false;
      this._transactionUpdated = true;
      this._transaction = await safeGetJson(resp);
      if (!this._transaction) {
        this._transaction = `Transaction fail with status ${resp.status()}, ${resp.statusText()}`;
      }
      return;
    }

    this._transaction = await safeGetJson(resp);
    if (!this._transaction) return;

    this._transactionOk = resp.ok();
    logger.debug('update trasaction', this._transaction);
    this._transactionUpdated = true;
    this.fireReadyEvent();
  };

  private isDataReady(): boolean {
    // Check tools detail
    const toolsOk = this._bagItems.items
      .map((item): boolean => {
        const assets = this._assets.find(
          (ast) => ast.asset_id === item.asset_id,
        );
        return assets ? true : false;
      })
      .reduce((a, b) => a && b, true);
    // Check land detail
    const land = this._assets.find(
      (ast) => ast.asset_id === this._mineStatus.current_land,
    );
    const landOk = !!land;

    return toolsOk && landOk;
  }

  isReady(): boolean {
    if (!this._pageReady) return false;
    if (!this._balanceUpdated) return false;
    if (!this._bagUpdated) return false;
    if (!this._assetsUpdated) return false;
    if (!this._mineStatusUpdated) return false;
    if (!this.isDataReady()) return false;
    return true;
  }

  private fireReadyEvent() {
    if (this.isReady() && this._readyEventFired === false) {
      this._readyEventFired = true;

      this.determinStage();
    }
  }

  private updatePageStatus = () => {
    logger.debug('dom content loaded');
    this._pageReady = true;

    // Wait two miniute for page ready
    const waitReadyEvent = async (): Promise<NextActionType> => {
      if (this._readyEventFired) return NextActionType.Stop;
      else return NextActionType.Continue;
    };
    const waitTimeout = async (): Promise<NextActionType> => {
      try {
        const page = await this.provider.getPage(PAGE_ALIEN_WORLDS);
        await page.bringToFront();
        const btn = await page.$(CLS_BTN_START);
        if (btn) {
          let count = 3;
          while (count > 0) {
            const txt = await btn.$eval(
              CLS_BTN_START,
              (item) => item.textContent,
            );
            if (txt === TXT_BTN_START) {
              await btn.click();
              return NextActionType.Continue;
            }
            await sleep(15);
            count--;
          }
        }
      } catch (err) {}

      return NextActionType.Stop;
    };

    sleep(3, () => {
      this.waitFor(
        'Prepare for mine',
        waitReadyEvent,
        3 * TIME_MINITE,
        waitTimeout,
      );
    });
  };

  private async stepPrepare() {
    logger.log('🔧 Prepare...');
    const page = await this.provider.getPage(PAGE_ALIEN_WORLDS);
    await page.bringToFront();

    // Try click start button until ready event fired
    const clickStart = async (): Promise<void> => {
      if (this.state !== TaskState.Running) return
      if (this._readyEventFired) return;

      try {
        const btn = await page.$(CLS_BTN_START);
        if (btn) {
          const txt = await btn.$eval(
            CLS_BTN_START,
            (item) => item.textContent,
          );
          if (txt === TXT_BTN_START) {
            await btn.click();
          }
        }
      } catch (err) {}

      await sleep(5)
      await clickStart();
    };

    page.on(PageEmittedEvents.DOMContentLoaded, this.updatePageStatus);
    page.on(PageEmittedEvents.Response, this.updateBalance);
    page.on(PageEmittedEvents.Response, this.updateAssetsInfo);
    page.on(PageEmittedEvents.Response, this.updateBagInfo);
    page.on(PageEmittedEvents.Response, this.updateMineStatus);
    page.on(PageEmittedEvents.Response, this.updateTransaction);
    page
      .goto(URL_ALIEN_WORLDS_INVENTORY, {
        timeout: TIME_5_MINITE,
      })
      .then(async () => {
        await clickStart();
      })
      .catch((err) => {
        logger.log('Page reload error: ');
        logger.log(err.message);
      });
  }

  private determinStage() {
    const lastMine = UTCtoGMT(this._mineStatus.last_mine);
    const cooldown = this.getCooldown();
    const nextMineTime = lastMine.getTime() + cooldown + random(5000, 1000);
    const currentTime = new Date().getTime();

    if (currentTime > nextMineTime) {
      this.nextStep(STEP_MINE);
    } else {
      const akt = this.getSmartAwakeTime(
        nextMineTime - currentTime,
        config.mining.maxAwakeDelay * 1000,
      );
      logger.log(
        `🍸 Tools cooldown, next mine attempt at ${moment(akt).format(
          config.datetimeFormat,
        )}`,
      );
      this.complete(TaskState.Canceled, 'tools cooldown', null, akt);
    }
  }

  private async stepMine() {
    logger.log('🚂 Mining...');
    const page = await this.provider.getPage(PAGE_ALIEN_WORLDS);
    await page.bringToFront();

    // Set a 5 seconds delay to wait page script running
    const clickMine = async (): Promise<NextActionType> => {
      const clicked = sureClick(page, CLS_BTN_MINE, TXT_BTN_MINE);
      if (clicked) {
        await sleep(2);
        this.nextStep(STEP_CLAIM);
        return NextActionType.Stop;
      } else {
        return NextActionType.Continue;
      }
    };
    this.waitFor('Wait for mine button', clickMine, 0.5 * TIME_MINITE);
  }

  private async stepClaim() {
    const page = await this.provider.getPage(PAGE_ALIEN_WORLDS);
    await page.bringToFront();

    const doApprove = async (popup: Page) => {
      popup.once(PageEmittedEvents.Close, () => {
        this.nextStep(STEP_CONFIRM);
      });

      const clickApproveButton = async (): Promise<NextActionType> => {
        try {
          await sureClick(popup, CLS_BTN_APPROVE);
          return NextActionType.Stop;
        } catch (err) {
          logger.debug('Approve button click attempt failed', err);
        }
        return NextActionType.Continue;
      };
      this.waitFor('Wait for approve', clickApproveButton, TIME_5_MINITE);
    };
    page.once(PageEmittedEvents.Popup, doApprove);

    const waitClaimButton = async (): Promise<NextActionType> => {
      try {
        let btn = await page.$(CLS_BTN_CLAIM);
        if (btn) {
          const txt = await btn.evaluate((item) => item.textContent);
          if (txt !== TXT_BTN_CLAIM) {
            btn = null;
          }
        }

        if (btn) {
          logger.log('🐝 Claiming...');
          this._balanceUpdated = false;
          this._mineStatusUpdated = false;
          await btn.click({
            delay: random(1600, 1000),
          });
          return NextActionType.Stop;
        }
      } catch (err) {}

      return NextActionType.Continue;
    };
    this.waitFor('Wait for Claim button', waitClaimButton, TIME_5_MINITE);
  }

  private async stepConfirm() {
    logger.log('📜 Confirming...');
    const confirmMining = async (): Promise<NextActionType> => {
      if (!this._transactionUpdated) return NextActionType.Continue;
      if (this._transactionOk && !this._mineStatusUpdated)
        return NextActionType.Continue;
      if (this._transactionOk && !this._balanceUpdated)
        return NextActionType.Continue;

      if (this._transactionOk) {
        const now = new Date();
        const lastMineTime = UTCtoGMT(this._mineStatus.last_mine);
        const cooldown = this.getCooldown();
        const akt = this.getSmartAwakeTime(
          lastMineTime.getTime() + cooldown - now.getTime(),
          config.mining.maxAwakeDelay * 1000,
        );
        logger.debug(
          'next attempt:',
          lastMineTime,
          cooldown,
          now,
          new Date(akt),
        );
        const rst = {
          nextAttemptAt: akt,
          total: this._balance,
          reward: this._balanceChanged,
        };
        logger.log(
          `💎 ${this._balanceChanged.toFixed(
            4,
          )} TLM mined, current total ${this._balance.toFixed(4)} TLM.`,
        );
        logger.log(
          `⏰ Next attempt at ${moment(akt).format(config.datetimeFormat)}`,
        );
        this.complete(TaskState.Completed, 'success', rst, akt);
      } else {
        const message =
          this._transaction && this._transaction.error
            ? this._transaction.error.details[0].message
            : "Server error when mining, it's maybe a server problem";
        const akt = this.getSmartAwakeTime(
          45 * TIME_MINITE,
          config.mining.maxAwakeDelay * 1000,
        );
        logger.log(`❌ ${message}.`);
        logger.log(
          `⏰ Next attempt at ${moment(akt).format(config.datetimeFormat)}`,
        );
        this.complete(TaskState.Completed, message, null, akt);
      }

      return NextActionType.Stop;
    };

    const confirmTimeout = async (): Promise<NextActionType> => {
      if (this._transactionOk) {
        logger.log(
          '❓ Transaction seems ok, but balance and miner status not change.',
        );
        logger.log('❓ tx:', this._transaction.transaction_id);
      } else {
        logger.log('Confirm mining status timeout, please check network.');
      }
      const akt = this.getSmartAwakeTime(
        15 * TIME_MINITE,
        config.mining.maxAwakeDelay * 1000,
      );
      logger.log(
        `⏰ Next attempt at ${moment(akt).format(
          config.mining.datetimeFormat,
        )}`,
      );
      this.complete(TaskState.Timeout, 'Confirming timeout', null, akt);

      // try {
      //   // Close siging window if exists
      //   const page = await this.provider.getPages()
      // }

      return NextActionType.Stop;
    };
    this.waitFor(
      'Wait for confirm',
      confirmMining,
      TIME_5_MINITE,
      confirmTimeout,
    );
  }

  protected async cleanUp() {
    const page = await this.provider.getPage(PAGE_ALIEN_WORLDS);
    page.off(PageEmittedEvents.DOMContentLoaded, this.updatePageStatus);
    page.off(PageEmittedEvents.Response, this.updateBalance);
    page.off(PageEmittedEvents.Response, this.updateAssetsInfo);
    page.off(PageEmittedEvents.Response, this.updateBagInfo);
    page.off(PageEmittedEvents.Response, this.updateMineStatus);
    page.off(PageEmittedEvents.Response, this.updateTransaction);
  }

  prepare(): boolean {
    const data = this.provider.getData<IAccountInfo>(DATA_KEY_ACCOUNT_INFO);
    if (!data.logined) {
      this._message = 'Not login.';
    }
    this._account = data;
    return data.logined;
  }
}
