export const random = (max: number, min = 0): number => {
  return min + Math.floor(Math.random() * (max - min))
}

/**
 * 生成随机休眠时间, 避免程序执行间隔过于工整
 *
 * @param delay 基础休眠时间, 毫秒
 * @param rnd 随机性, 最小值 36000. 在基础休眠时间上增加一个随机时间
 * @returns
 */
export const getAwakeTime = (delay: number, rnd = 180000): number => {
  rnd = rnd < 180000 ? 180000 : rnd
  return (new Date().getTime() + delay + random(rnd, rnd / 4))
}


export function sleep(second: number): void;
export function sleep(second: number, callback: () => void): Promise<void>
export function sleep(second: number, callback?: () => void) {
  if (!callback) {
    return new Promise((resolve) => {
      setTimeout(resolve, second * 1000)
    })
  } else {
    return setTimeout(callback, second * 1000)
  }
}
