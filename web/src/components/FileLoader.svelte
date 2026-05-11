<script lang="ts">
  interface Props {
    label: string;
    accept: string;
    onload: (bytes: Uint8Array, name: string) => void;
    disabled?: boolean;
  }

  const { label, accept, onload, disabled = false }: Props = $props();

  let inputEl: HTMLInputElement | undefined = $state();
  let fileName = $state<string | null>(null);
  let fileSize = $state<number | null>(null);
  let loading = $state(false);

  async function onChange(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;

    loading = true;
    try {
      const buf = await file.arrayBuffer();
      fileName = file.name;
      fileSize = file.size;
      onload(new Uint8Array(buf), file.name);
    } finally {
      loading = false;
      // Clear so re-picking the SAME file fires onchange again. Because the
      // native input is hidden the user never sees the "No file chosen" text;
      // the meta span on the right is our source of truth for what is loaded.
      input.value = '';
    }
  }

  function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }
</script>

<div class="file-loader">
  <span class="label">{label}</span>
  <button
    type="button"
    class="picker"
    disabled={disabled || loading}
    onclick={() => inputEl?.click()}
  >
    {loading ? 'Loading…' : 'Choose…'}
  </button>
  <input
    bind:this={inputEl}
    type="file"
    {accept}
    disabled={disabled || loading}
    onchange={onChange}
    hidden
  />
  {#if fileName}
    <span class="meta">
      <code>{fileName}</code>
      {#if fileSize !== null}<span class="size">({formatSize(fileSize)})</span>{/if}
    </span>
  {:else}
    <span class="meta empty">no file</span>
  {/if}
</div>

<style>
  .file-loader {
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem;
    align-items: center;
    margin: 0.5rem 0;
  }
  .label {
    min-width: 3rem;
    font-size: 0.9rem;
    font-weight: 500;
    color: var(--fg-secondary);
  }
  .picker {
    padding: 0.3rem 0.9rem;
    font-size: 0.85rem;
  }
  .meta {
    font-size: 0.9rem;
    color: var(--fg-secondary);
  }
  .meta.empty {
    color: var(--fg-dim);
    font-style: italic;
  }
  .size {
    color: var(--fg-dim);
    margin-left: 0.25rem;
  }
  code {
    background: var(--code-bg);
    color: var(--fg);
    padding: 0.1rem 0.3rem;
    border-radius: 3px;
    font-family: ui-monospace, Consolas, monospace;
  }
</style>
