<script lang="ts" module>
  export type IconName =
    | 'music'
    | 'metronome'
    | 'tuner'
    | 'keyboard'
    | 'file'
    | 'folder'
    | 'sparkle'
    | 'minus'
    | 'plus'
    | 'volume'
    | 'lock'
    | 'stop'
    | 'play'
    | 'pause'
    | 'loop'
    | 'click'
    | 'timer'
    | 'headphones'
    | 'layers'
    | 'search'
    | 'link'
    | 'check'
    | 'x'
    | 'chevron-down'
    | 'chevron-left'
    | 'chevron-up'
    | 'grip'
    | 'upload'
    | 'clock'
    | 'mic'
    | 'moon'
    | 'sun'
</script>

<script lang="ts">
  // Набір лінійних іконок інтерфейсу (24×24, обведення currentColor). Декоративні: aria-hidden.
  let { name, size = 18, stroke = 2 }: { name: IconName; size?: number; stroke?: number } = $props()
</script>

{#if name === 'play' || name === 'pause' || name === 'stop' || name === 'grip'}
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    {#if name === 'play'}
      <polygon points="7 4 20 12 7 20 7 4" />
    {:else if name === 'pause'}
      <rect x="6" y="4" width="4" height="16" rx="1" /><rect x="14" y="4" width="4" height="16" rx="1" />
    {:else if name === 'stop'}
      <rect x="5" y="5" width="14" height="14" rx="2" />
    {:else}
      <circle cx="9" cy="6" r="1.6" /><circle cx="15" cy="6" r="1.6" /><circle cx="9" cy="12" r="1.6" />
      <circle cx="15" cy="12" r="1.6" /><circle cx="9" cy="18" r="1.6" /><circle cx="15" cy="18" r="1.6" />
    {/if}
  </svg>
{:else}
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width={stroke}
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    {#if name === 'music'}
      <path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" />
    {:else if name === 'metronome'}
      <path d="M8.5 3h7L20 21H4z" /><path d="M12 16l4.5-9" /><path d="M7 16h10" />
    {:else if name === 'click'}
      <path d="M8.5 3h7L20 21H4z" /><path d="M12 16l4.5-9" />
    {:else if name === 'tuner'}
      <path d="M9 2v8a3 3 0 0 0 6 0V2" /><path d="M12 13v9" />
    {:else if name === 'keyboard'}
      <rect x="2" y="6" width="20" height="12" rx="2" /><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M8 14h8" />
    {:else if name === 'file'}
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /><path d="M10 17v-5l4-1v5" />
    {:else if name === 'folder'}
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    {:else if name === 'sparkle'}
      <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" />
    {:else if name === 'minus'}
      <path d="M5 12h14" />
    {:else if name === 'plus'}
      <path d="M5 12h14" /><path d="M12 5v14" />
    {:else if name === 'volume'}
      <path d="M11 5 6 9H2v6h4l5 4V5z" /><path d="M15.5 8.5a5 5 0 0 1 0 7" />
    {:else if name === 'lock'}
      <rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" />
    {:else if name === 'loop'}
      <path d="M17 2l4 4-4 4" /><path d="M3 11v-1a4 4 0 0 1 4-4h14" /><path d="M7 22l-4-4 4-4" /><path d="M21 13v1a4 4 0 0 1-4 4H3" />
    {:else if name === 'timer'}
      <circle cx="12" cy="13" r="8" /><path d="M12 9v4l2 2" /><path d="M9 2h6" />
    {:else if name === 'headphones'}
      <path d="M3 18v-6a9 9 0 0 1 18 0v6" /><path d="M21 19a2 2 0 0 1-2 2h-1v-6h3z" /><path d="M3 19a2 2 0 0 0 2 2h1v-6H3z" />
    {:else if name === 'layers'}
      <path d="M12 2 2 7l10 5 10-5-10-5z" /><path d="M2 17l10 5 10-5" /><path d="M2 12l10 5 10-5" />
    {:else if name === 'search'}
      <circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" />
    {:else if name === 'link'}
      <path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7" /><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" />
    {:else if name === 'check'}
      <path d="M5 12l5 5 9-10" />
    {:else if name === 'x'}
      <path d="M6 6l12 12M18 6 6 18" />
    {:else if name === 'chevron-down'}
      <path d="m6 9 6 6 6-6" />
    {:else if name === 'chevron-up'}
      <path d="m6 15 6-6 6 6" />
    {:else if name === 'chevron-left'}
      <path d="m15 6-6 6 6 6" />
    {:else if name === 'upload'}
      <path d="M12 15V3" /><path d="m7 8 5-5 5 5" /><path d="M5 21h14" />
    {:else if name === 'clock'}
      <circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" />
    {:else if name === 'mic'}
      <rect x="9" y="2" width="6" height="12" rx="3" /><path d="M5 10v1a7 7 0 0 0 14 0v-1" /><path d="M12 18v4" />
    {:else if name === 'moon'}
      <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
    {:else if name === 'sun'}
      <circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    {/if}
  </svg>
{/if}
