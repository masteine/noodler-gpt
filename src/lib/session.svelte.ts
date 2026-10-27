// Спільний стан між модулями (плеєр → метроном → тюнер).
// Модулі не залежать один від одного напряму, а читають те, що тут лежить.

export interface TimeSignature {
  numerator: number
  denominator: number
}

export const session = $state({
  /** Темп відкритого табу (BPM) або null, якщо файл не відкрито. */
  tabTempo: null as number | null,
  /** Розмір першого такту відкритого табу. */
  tabTimeSignature: null as TimeSignature | null,
  /** Назва відкритого табу — для підказок у метрономі та тюнері. */
  tabTitle: '',
  /** Стрій активної доріжки: MIDI від найтовстішої струни до найтоншої. null для ударних і без файлу. */
  tabTuning: null as { name: string; midi: number[] } | null,
  /** Налаштування метронома, щоб не губити їх при зміні вкладки. */
  metronome: { bpm: 120, sigIndex: 2, subdivision: 1, accent: true, volume: 80 },
})
