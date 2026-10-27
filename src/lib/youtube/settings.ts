// Налаштування YouTube: власний API-ключ користувача у localStorage.
// Кожен доступ у try/catch — у приватному режимі сховище може кидати помилки.

const KEY = 'noodler.youtube.apiKey'

export function getApiKey(): string | null {
  try {
    const v = localStorage.getItem(KEY)
    return v && v.trim() ? v.trim() : null
  } catch {
    return null
  }
}

export function setApiKey(key: string | null): void {
  try {
    const v = key?.trim()
    if (v) localStorage.setItem(KEY, v)
    else localStorage.removeItem(KEY)
  } catch {
    // сховище недоступне — ігноруємо
  }
}
