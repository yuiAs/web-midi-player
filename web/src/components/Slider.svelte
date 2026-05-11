<script lang="ts">
  interface Props {
    value?: number;
    min?: number;
    max?: number;
    step?: number;
    label?: string;
    disabled?: boolean;
    /** Optional formatter for the trailing readout (e.g. "80%"). */
    format?: (v: number) => string;
  }
  let {
    value = $bindable(0),
    min = 0,
    max = 100,
    step = 1,
    label,
    disabled = false,
    format,
  }: Props = $props();
</script>

<label class="slider" class:disabled>
  {#if label}<span class="text">{label}</span>{/if}
  <input
    type="range"
    bind:value
    {min}
    {max}
    {step}
    {disabled}
    aria-label={label}
  />
  {#if format}<span class="readout">{format(value)}</span>{/if}
</label>

<style>
  .slider {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.9rem;
    color: var(--fg);
    user-select: none;
  }
  .slider.disabled { opacity: 0.5; }

  input[type='range'] {
    -webkit-appearance: none;
    appearance: none;
    width: 120px;
    height: 4px;
    background: var(--border);
    border-radius: 2px;
    outline: none;
    cursor: pointer;
  }
  input[type='range']:disabled { cursor: not-allowed; }

  input[type='range']::-webkit-slider-thumb {
    -webkit-appearance: none;
    appearance: none;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: var(--accent);
    border: none;
    cursor: pointer;
    transition: transform 0.12s ease;
  }
  input[type='range']::-webkit-slider-thumb:hover { transform: scale(1.15); }

  input[type='range']::-moz-range-thumb {
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: var(--accent);
    border: none;
    cursor: pointer;
  }

  input[type='range']:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 4px;
  }

  .readout {
    min-width: 2.6em;
    text-align: right;
    font-variant-numeric: tabular-nums;
    color: var(--fg-muted);
    font-size: 0.82rem;
  }
</style>
