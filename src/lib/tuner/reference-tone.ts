// Еталонний тон: синус заданої частоти з плавним входом і виходом.

import { getAudioContext } from '../audio'

interface Voice {
  gain: GainNode
  oscs: OscillatorNode[]
}

export class ReferenceTone {
  /** Викликається, коли тон закінчився (сам або через stop). */
  onEnd: () => void = () => {}
  private voice: Voice | null = null

  get playing(): boolean {
    return this.voice !== null
  }

  /** Викликати з обробника кліку: AudioContext створюється під час жесту користувача. */
  play(freq: number, seconds = 4) {
    this.stop()
    const ctx = getAudioContext()
    const now = ctx.currentTime
    const end = now + seconds

    const gain = ctx.createGain()
    gain.gain.setValueAtTime(0, now)
    gain.gain.linearRampToValueAtTime(0.3, now + 0.04)
    gain.gain.setValueAtTime(0.3, end - 0.15)
    gain.gain.linearRampToValueAtTime(0, end)
    gain.connect(ctx.destination)

    const oscs: OscillatorNode[] = []
    const addPartial = (f: number, level: number) => {
      const osc = ctx.createOscillator()
      osc.type = 'sine'
      osc.frequency.value = f
      const g = ctx.createGain()
      g.gain.value = level
      osc.connect(g).connect(gain)
      osc.start(now)
      osc.stop(end)
      oscs.push(osc)
    }
    addPartial(freq, 1)
    // Динаміки телефонів не відтворюють нижче ~100 Гц: додаємо тиху другу гармоніку, щоб бас було чути.
    if (freq < 110) addPartial(freq * 2, 0.5)

    const voice: Voice = { gain, oscs }
    this.voice = voice
    oscs[0].onended = () => {
      voice.gain.disconnect()
      if (this.voice === voice) {
        this.voice = null
        this.onEnd()
      }
    }
  }

  stop() {
    const v = this.voice
    if (!v) return
    this.voice = null
    const ctx = getAudioContext()
    const now = ctx.currentTime
    v.gain.gain.cancelScheduledValues(now)
    v.gain.gain.setValueAtTime(v.gain.gain.value, now)
    v.gain.gain.linearRampToValueAtTime(0, now + 0.05)
    for (const o of v.oscs) {
      try {
        o.stop(now + 0.06)
      } catch {
        // вже зупинений
      }
    }
    this.onEnd()
  }

  destroy() {
    this.onEnd = () => {}
    this.stop()
  }
}
