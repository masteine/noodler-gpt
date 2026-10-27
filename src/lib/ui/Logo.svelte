<script lang="ts">
  let { size = 28 }: { size?: number } = $props()
</script>

<svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" style="flex: none">
  <path d="M12 2c5 0 9 2 9 5.5 0 5-5.5 12.5-9 14.5C8.5 20 3 12.5 3 7.5 3 4 7 2 12 2z" fill="var(--accent)" />
  <path d="M9 8.5h6" stroke="var(--on-accent)" stroke-width="2" stroke-linecap="round" />
</svg>
