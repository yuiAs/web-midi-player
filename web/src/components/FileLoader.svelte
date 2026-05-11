<script lang="ts">
  import { fileOpen, type FileWithHandle } from 'browser-fs-access';

  interface Props {
    label: string;
    /** Comma-separated extensions, e.g. ".sf2,.sf3". Mirrors <input accept>. */
    accept: string;
    /** Currently displayed file name (lets the parent show restored files). */
    fileName?: string | null;
    /** Currently displayed file size in bytes. */
    fileSize?: number | null;
    onload: (
      bytes: Uint8Array,
      name: string,
      handle: FileSystemFileHandle | undefined,
    ) => void;
    disabled?: boolean;
  }

  const {
    label,
    accept,
    fileName = null,
    fileSize = null,
    onload,
    disabled = false,
  }: Props = $props();

  let loading = $state(false);

  // ".sf2,.sf3" -> [".sf2", ".sf3"]. fileOpen() expects leading dots.
  const extensions = $derived(
    accept
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.startsWith('.')),
  );

  // `id` lets the picker remember the directory per-extension between sessions
  // in Chromium; a stable string keyed on extensions is enough.
  const pickerId = $derived(`wmp-${extensions.join('').replace(/\./g, '')}`);

  async function pick() {
    if (loading || disabled) return;
    loading = true;
    try {
      const file = (await fileOpen({
        description: label,
        extensions,
        id: pickerId,
        multiple: false,
      })) as FileWithHandle;
      const buf = await file.arrayBuffer();
      onload(new Uint8Array(buf), file.name, file.handle);
    } catch (e) {
      // User cancellation throws AbortError / DOMException — stay quiet.
      if (!isAbortError(e)) throw e;
    } finally {
      loading = false;
    }
  }

  function isAbortError(e: unknown): boolean {
    return (
      typeof e === 'object' &&
      e !== null &&
      'name' in e &&
      (e as { name: string }).name === 'AbortError'
    );
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
    onclick={pick}
  >
    {loading ? 'Loading…' : 'Choose…'}
  </button>
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
