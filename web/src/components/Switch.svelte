<script lang="ts">
  interface Props {
    checked?: boolean;
    label?: string;
    disabled?: boolean;
  }
  let { checked = $bindable(false), label, disabled = false }: Props = $props();
</script>

<label class="switch" class:disabled>
  <input type="checkbox" bind:checked {disabled} />
  <span class="track"><span class="thumb"></span></span>
  {#if label}<span class="text">{label}</span>{/if}
</label>

<style>
  .switch {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    cursor: pointer;
    user-select: none;
    font-size: 0.9rem;
    color: var(--fg);
  }
  .switch.disabled { opacity: 0.5; cursor: not-allowed; }

  /* Visually hide the underlying checkbox but keep it focusable. */
  input {
    position: absolute;
    opacity: 0;
    pointer-events: none;
    width: 0; height: 0;
  }

  .track {
    position: relative;
    width: 36px;
    height: 20px;
    background: var(--border);
    border-radius: 10px;
    transition: background 0.18s ease;
    flex-shrink: 0;
  }
  .thumb {
    position: absolute;
    top: 2px;
    left: 2px;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: #fff;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.25);
    transition: transform 0.18s ease;
  }

  input:checked + .track {
    background: var(--accent);
  }
  input:checked + .track .thumb {
    transform: translateX(16px);
  }
  input:focus-visible + .track {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
</style>
