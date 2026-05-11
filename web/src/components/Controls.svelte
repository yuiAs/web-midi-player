<script lang="ts">
  interface Props {
    canPlay: boolean;
    isPlaying: boolean;
    onplaypause: () => void;
    onstop: () => void;
  }

  const { canPlay, isPlaying, onplaypause, onstop }: Props = $props();
</script>

<div class="controls">
  <button class="primary" onclick={onplaypause} disabled={!canPlay}>
    {isPlaying ? 'Pause' : 'Play'}
  </button>
  <button onclick={onstop} disabled={!canPlay}>Stop</button>
</div>

<style>
  .controls {
    display: flex;
    gap: 0.5rem;
    margin: 0.5rem 0;
  }
  button {
    padding: 0.4rem 1.1rem;
    font-size: 0.95rem;
    min-width: 5.5rem;
  }
  .primary:not(:disabled) {
    border-color: var(--accent);
  }
</style>
