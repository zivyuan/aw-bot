/* eslint-disable @typescript-eslint/no-explicit-any */
import { Page } from "puppeteer"
import config from "../config"
import Logger from "../Logger"
import { sleep } from '../utils/utils'
import { Browser } from "puppeteer"
import { IMiningDataProvider } from "../Minion"
import { getAwakeTime } from "../utils/utils"
import { TIME_MINITE } from "../utils/constant"
import moment from "moment"


export enum TaskState {
  Idle,
  Running,

  Completed,
  Canceled,
  Timeout,
  Abort,
  Error,
}

type StepHandle = () => void

export interface TaskStep {
  [step: string]: StepHandle
}

export enum NextActionType {
  Continue,
  Stop
}

export interface InspectorHandle {
  (browser: Browser, page: Page): boolean
}

export interface ITaskResult<T> {
  state: TaskState
  // The next awake time of task, make task tempoary sleep
  message: string
  data: T | null
  awakeTime?: number
}

export enum TaskType {
  Single,
  Group
}

export type ITaskNoResult = null

export interface ITask<T> {
  readonly no: number
  readonly name: string
  readonly state: TaskState
  readonly message: string
  readonly phase: string
  readonly phaseElapseTime: number
  readonly type: TaskType
  readonly shouldTerminate: boolean

  setProvider(provider: IMiningDataProvider): void

  start(): Promise<ITaskResult<T>>

  prepare(): boolean

  stop(): void

  destroy(): void
}

export type TaskClass = typeof BaseTask & { meta: { [prop: string]: any } }

let __uuid = 1
let logger
export default class BaseTask<T> implements ITask<T> {
  private __no: number
  private _name = 'Task'
  private _type: TaskType = TaskType.Single

  protected _message = ''
  protected _state: TaskState = TaskState.Idle
  protected _phase = 'ready'
  protected _phaseTimeMark = 0
  protected _shouldTerminate = false

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  protected _resolve: (value: any) => void
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  protected _reject: (reason?: any) => void
  // 子步骤终止
  protected _terminateHandle: () => void
  private _steps: TaskStep = {}
  private _entrance: string
  private _provider: IMiningDataProvider

  constructor(name: string) {
    this._name = name
    this._phaseTimeMark = new Date().getTime()
    this.__no = __uuid++

    if (!logger) {
      logger = new Logger('this.name')
    }
  }

  get no(): number {
    return this.__no
  }

  get type(): TaskType {
    return this._type
  }

  get name(): string {
    return this._name
  }

  get state(): TaskState {
    return this._state
  }

  get message(): string {
    return this._message
  }

  get phase(): string {
    return this._phase
  }

  get phaseElapseTime(): number {
    const current = new Date().getTime()
    return current - this._phaseTimeMark
  }

  get shouldTerminate(): boolean {
    return this._shouldTerminate
  }

  protected get provider(): IMiningDataProvider {
    return this._provider
  }

  protected get entrance(): string {
    return this._entrance
  }

  protected registerStep(name: string, handle: StepHandle, first = false) {
    this._steps[name] = handle
    if (first === true) {
      this._entrance = name
    }
  }

  protected nextStep(name: string, delay?: number) {
    if (delay) {
      sleep(delay, () => {
        this.nextStep(name)
      })
      return
    }

    const step = this._steps[name]
    this.updatePhase('step-' + name)
    step.call(this)
  }

  /**
   * Call step funciton after a delay
   * @param name Step name
   */
  protected tick(name: string) {
    const step = this._steps[name]
    const elapse = this.phaseElapseTime

    if (elapse > config.taskPhaseTimeout) {
      this.completeWithError('Task timeout')
    } else {
      setTimeout(() => {
        step.call(this)
      }, config.tickInterval)
    }
  }

  /**
   * Test condition until excepted
   * @param condition Test function
   * @returns Test result
   */
  protected async waitUtil<T>(condition: () => any): Promise<T> {
    return new Promise((resolve) => {
      const loop = async () => {
        try {
          const rst = await condition()
          resolve(rst)
        } catch (err) {
          setTimeout(() => {
            this.waitUtil(condition)
          }, 500)
        }
      }
      loop()
    })
  }

  private _waitKeys = {}
  /**
   * Wait loop for no block process and controlable
   * @param name A short describe
   * @param func function
   * @param timeout number. Default timeout is 2 minutes, config key: mining.timeout
   * @param timeoutHandle Custom timeout handle, return false to continue to wait
   * @returns
   */
  protected async waitFor(name: string, func: () => Promise<NextActionType>, timeout = 0, timeoutHandle?: () => Promise<NextActionType>) {
    if (!this._waitKeys[name]) this._waitKeys[name] = new Date().getTime()

    if (this.state !== TaskState.Running || (await func() === NextActionType.Stop)) {
      delete this._waitKeys[name]
      return
    }

    setTimeout(async () => {
      const elapsed = new Date().getTime() - this._waitKeys[name]
      if (elapsed > (timeout ? timeout : (config.mining.timeout * 1000))) {
        if (timeoutHandle) {
          const rst = await timeoutHandle()
          if (rst === NextActionType.Continue) {
            this._waitKeys[name] = new Date().getTime()
            this.waitFor(name, func, timeout)
            return
          }
        }

        const msg = `${name} timeout`
        const akt = getAwakeTime(15 * TIME_MINITE)
        logger.setScope(this.name)
        logger.log(`${msg}, next attempt at ${moment(akt).format(config.mining.datetimeFormat)}`)
        this.complete(TaskState.Timeout, msg, null, akt)
        delete this._waitKeys[name]
      } else {
        this.waitFor(name, func, timeout)
      }
    }, 1000)
  }

  protected waitForSelector(page: Page, selector: string, timeout = 0): Promise<any> {
    const timemark = new Date().getTime()
    let __iid = 0
    const __looper = async (resolve: (value: unknown) => void, reject: (reason?: any) => void, page: Page, selector: string, interval: number) => {
      clearTimeout(__iid)
      try {
        const obj = await page.$(selector)
        if (obj) {
          resolve(obj)
          return
        }
        // eslint-disable-next-line no-empty
      } catch (err) { }

      const elapse = (new Date().getTime()) - timemark
      if (timeout > 0 && elapse > timeout) {
        reject('waitforselector timeout')
        return
      }

      __iid = setTimeout(() => {
        __looper(resolve, reject, page, selector, interval)
      }, interval)
    }

    return new Promise((resolve, reject) => {
      __looper(resolve, reject, page, selector, timeout)
    })
  }

  protected updatePhase(phase: string) {
    if (this._phase === phase) {
      return
    }

    this._phaseTimeMark = new Date().getTime()
    this._phase = phase
  }

  protected completeWithError(message) {
    this._state = TaskState.Error
    this._message = message
    this._reject(message)
  }

  protected async cleanUp() { }

  protected complete(state: TaskState, message?: string, data?: T, awake?: number) {
    this.cleanUp()

    this._state = state
    this._message = message || ''
    this._resolve({
      state: this._state,
      message: this._message,
      data: data || null,
      awakeTime: awake
    })
  }

  setProvider(provider: IMiningDataProvider): void {
    this._provider = provider
  }

  prepare(): boolean {
    return true
  }

  start(): Promise<ITaskResult<T>> {
    this._state = TaskState.Running

    return new Promise((resolve, reject) => {
      this._resolve = resolve
      this._reject = reject

      this.nextStep(this.entrance)
    })
  }

  stop(): void {
    if (this._terminateHandle) {
      this._terminateHandle()
    }
    this._reject(new Error('User terminated.'))
  }

  destroy(): void { }

  isReady(): boolean {
    return true
  }

  /**
   *
   * @param handle An inspect function, accept a browser and a page as parameter
   * @param interval
   * @returns
   */
  inspect<T>(handle: InspectorHandle, interval: 200): Promise<T> {
    return new Promise((resolve, reject) => {
      const loop = async () => {
        let rst
        try {
          rst = await handle(null, null)
        } catch (err) {
          reject(err)
        }

        if (typeof rst !== 'undefined') {
          resolve(rst)
          return
        }

        setTimeout(() => {
          loop()
        }, interval)
      }

      loop()
    })
  }

}
