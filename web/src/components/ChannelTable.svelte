<script lang="ts">
  import { gmName, type ChannelState, CHANNELS_PER_PORT } from '../lib/channelState';

  interface Props {
    states: (ChannelState | null)[];
    /** When >1 we prefix the channel column with "P<n>-" to disambiguate. */
    portCount: number;
  }

  let { states, portCount }: Props = $props();

  // Skip null slots so only channels that have actually emitted an event
  // appear. `states` is already in port*16+ch order, so the filtered
  // result is sorted without an explicit comparator.
  const rows = $derived(states.filter((s): s is ChannelState => s !== null));
</script>

{#if rows.length > 0}
  <table class="ch-table" aria-label="Channel state">
    <thead>
      <tr>
        <th class="col-ch">Ch</th>
        <th class="col-inst">Instrument</th>
        <th class="col-num">Prg</th>
        <th class="col-num">Vol</th>
        <th class="col-num">Pan</th>
        <th class="col-num">Exp</th>
      </tr>
    </thead>
    <tbody>
      {#each rows as state (state.port * CHANNELS_PER_PORT + state.channel)}
        <tr>
          <td class="col-ch">
            {#if portCount > 1}<span class="port-tag">P{state.port + 1}</span>{/if}{state.channel + 1}
          </td>
          <td class="col-inst">{gmName(state.program)}</td>
          <td class="col-num">{state.program}</td>
          <td class="col-num">{state.volume}</td>
          <td class="col-num">{state.pan}</td>
          <td class="col-num">{state.expression}</td>
        </tr>
      {/each}
    </tbody>
  </table>
{/if}

<style>
  .ch-table {
    width: 100%;
    border-collapse: collapse;
    font-family: ui-monospace, Consolas, monospace;
    font-size: 0.8rem;
    line-height: 1.35;
    margin: 0 0 0.5rem;
    background: var(--code-bg);
    border: 1px solid var(--border);
    border-radius: 4px;
    overflow: hidden;
  }
  .ch-table th,
  .ch-table td {
    padding: 0.18rem 0.55rem;
    border-bottom: 1px solid var(--border);
  }
  .ch-table tbody tr:last-child td {
    border-bottom: none;
  }
  .ch-table th {
    font-weight: 500;
    font-size: 0.72rem;
    color: var(--fg-muted);
    text-transform: uppercase;
    letter-spacing: 0.02em;
    background: var(--bg-elev);
  }
  .col-ch {
    text-align: right;
    width: 4.5rem;
    color: var(--fg-secondary);
  }
  .col-inst {
    text-align: left;
  }
  .col-num {
    text-align: right;
    width: 3.2rem;
    font-variant-numeric: tabular-nums;
  }
  .port-tag {
    color: var(--fg-dim);
    margin-right: 0.25rem;
    font-size: 0.7rem;
  }
  .ch-table tbody tr:hover {
    background: color-mix(in srgb, var(--accent) 8%, transparent);
  }
</style>
