// Тема інтерфейсу. Без явного вибору слідуємо системі; перемикач запам’ятовує світлу чи темну в localStorage.

export type Theme = 'light' | 'dark'

const KEY_THEME = 'noodler.theme'

function loadSaved(): Theme | null {
  try {
    const v = localStorage.getItem(KEY_THEME)
    if (v === 'light' || v === 'dark') return v
  } catch {
    // сховище недоступне
  }
  return null
}

const media = typeof matchMedia === 'undefined' ? null : matchMedia('(prefers-color-scheme: dark)')

export const theme = $state({
  saved: loadSaved(),
  systemDark: media?.matches ?? false,
})

media?.addEventListener('change', (e) => (theme.systemDark = e.matches))

export function currentTheme(): Theme {
  return theme.saved ?? (theme.systemDark ? 'dark' : 'light')
}

function apply() {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  if (theme.saved) root.dataset.theme = theme.saved
  else delete root.dataset.theme
}
apply()

export function toggleTheme() {
  theme.saved = currentTheme() === 'dark' ? 'light' : 'dark'
  apply()
  try {
    localStorage.setItem(KEY_THEME, theme.saved)
  } catch {
    // сховище недоступне
  }
}
