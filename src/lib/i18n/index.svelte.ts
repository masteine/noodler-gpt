// Мова інтерфейсу. t() читає i18n.locale, тож шаблони й $derived перераховуються при зміні мови.
// Вибір зберігається в localStorage; без нього — українська для uk-браузерів, інакше англійська.

import uk from './uk'
import en from './en'

export type Key = keyof typeof uk
export type Dict = Record<Key, string>
export type Locale = 'uk' | 'en'

export const LOCALES: { id: Locale; label: string; name: string }[] = [
  { id: 'uk', label: 'UA', name: 'Українська' },
  { id: 'en', label: 'EN', name: 'English' },
]

const KEY_LANG = 'noodler.lang'
const dicts: Record<Locale, Dict> = { uk, en }

function detect(): Locale {
  try {
    const saved = localStorage.getItem(KEY_LANG)
    if (saved === 'uk' || saved === 'en') return saved
  } catch {
    // сховище недоступне
  }
  const langs = typeof navigator === 'undefined' ? [] : (navigator.languages ?? [navigator.language])
  return langs.some((l) => l?.toLowerCase().startsWith('uk')) ? 'uk' : 'en'
}

export const i18n = $state({ locale: detect() })

function applyLang(l: Locale) {
  if (typeof document !== 'undefined') document.documentElement.lang = l
}
applyLang(i18n.locale)

export function setLocale(l: Locale) {
  i18n.locale = l
  applyLang(l)
  try {
    localStorage.setItem(KEY_LANG, l)
  } catch {
    // сховище недоступне
  }
}

export function t(key: Key, params?: Record<string, string | number>): string {
  const s = dicts[i18n.locale][key] ?? uk[key]
  if (!params) return s
  return s.replace(/\{(\w+)\}/g, (m, p: string) => (p in params ? String(params[p]) : m))
}

/** Рядок із числом у правильній граматичній формі: ключі `${base}.one|few|many|other`, параметр {n}. */
export function tn(base: 'n.tracks' | 'n.strings' | 'n.bars', n: number): string {
  const cat = new Intl.PluralRules(i18n.locale).select(n)
  const form = cat === 'one' || cat === 'few' || cat === 'many' ? cat : 'other'
  return t(`${base}.${form}` as Key, { n })
}
