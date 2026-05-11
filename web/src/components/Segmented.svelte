<script lang="ts" generics="T extends string | number">
  interface Option {
    value: T;
    label: string;
  }
  interface Props {
    options: Option[];
    value: T;
    onchange: (value: T) => void;
  }
  const { options, value, onchange }: Props = $props();
</script>

<div class="segmented" role="radiogroup">
  {#each options as opt}
    <button
      type="button"
      role="radio"
      aria-checked={opt.value === value}
      class:active={opt.value === value}
      onclick={() => onchange(opt.value)}
    >
      {opt.label}
    </button>
  {/each}
</div>

<style>
  .segmented {
    display: inline-flex;
    background: var(--bg-elev);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 2px;
    gap: 2px;
  }
  button {
    appearance: none;
    border: none;
    background: transparent;
    color: var(--fg-secondary);
    padding: 0.35rem 0.9rem;
    font-size: 0.85rem;
    font-weight: 500;
    border-radius: 8px;
    cursor: pointer;
    transition: background 0.15s ease, color 0.15s ease;
  }
  button:hover:not(.active) {
    color: var(--fg);
  }
  button.active {
    background: var(--accent);
    color: var(--accent-fg);
  }
  button:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
</style>
