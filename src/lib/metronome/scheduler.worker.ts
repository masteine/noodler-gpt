// Таймер для метронома живе у Worker: таймери головного потоку браузер
// пригальмовує у фоновій вкладці, а Worker тікає стабільно.
// Сам час кліків рахується по AudioContext.currentTime, Worker лише будить планувальник.

export type SchedulerCommand = { type: 'start'; interval: number } | { type: 'stop' }

let timer: ReturnType<typeof setInterval> | null = null

self.onmessage = (e: MessageEvent<SchedulerCommand>) => {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
  if (e.data.type === 'start') {
    timer = setInterval(() => self.postMessage('tick'), e.data.interval)
  }
}
