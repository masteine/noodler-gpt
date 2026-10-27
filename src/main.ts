import { mount } from 'svelte'
// Шрифти лежать у бандлі, а не тягнуться з Google Fonts: застосунок працює офлайн і нікуди не ходить.
import '@fontsource-variable/onest'
import '@fontsource-variable/jetbrains-mono'
import './app.css'
import App from './App.svelte'

const app = mount(App, {
  target: document.getElementById('app')!,
})

export default app
