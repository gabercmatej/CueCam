/**
 * The Control window's stylesheet. Dark and quiet: it sits next to a call and is read at a glance.
 * One accent, the "on air" tally red, used only for the armed state. Health uses green / amber / red dots.
 *
 * Cost rules (this document shares the Output's main thread): no infinite animations, no blur or
 * backdrop filters, meters move by transform only, transitions are short and only on state changes.
 */
export const PREVIEW = { width: 640, height: 360 }

export const STYLE = `
  :root {
    color-scheme: dark;
    --bg: oklch(0.185 0.006 40);
    --raised: oklch(0.225 0.007 40);
    --sunk: oklch(0.155 0.005 40);
    --line: oklch(0.3 0.008 40);
    --ink: oklch(0.95 0.004 60);
    --muted: oklch(0.74 0.01 60);
    --faint: oklch(0.64 0.01 60);
    --tally: oklch(0.6 0.2 27);
    --tally-ink: oklch(0.985 0.01 27);
    --ok: oklch(0.76 0.13 152);
    --warn: oklch(0.8 0.13 78);
    --error: oklch(0.7 0.17 18);
    --error-bg: oklch(0.26 0.04 18);
    --warn-bg: oklch(0.26 0.03 78);
    --radius: 8px;
    --mono: ui-monospace, "SF Mono", Menlo, monospace;
    --ease: cubic-bezier(0.22, 1, 0.36, 1);
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; background: var(--bg); color: var(--ink); }
  body { font: 13px/1.45 -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif; -webkit-font-smoothing: antialiased; }
  main { padding: 16px 18px 28px; display: grid; gap: 22px; max-width: 760px; margin: 0 auto; }
  h2 { margin: 0 0 10px; font-size: 13px; font-weight: 600; color: var(--muted); }
  button, input { font: inherit; color: inherit; }
  button { cursor: pointer; }
  :focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }
  .num { font-family: var(--mono); font-variant-numeric: tabular-nums; font-size: 12px; }

  /* Arm state: the one thing to read at a glance. */
  .top { display: flex; gap: 14px; align-items: stretch; }
  .arm {
    flex: 1; display: grid; grid-template-columns: auto 1fr; column-gap: 14px; align-items: center; text-align: left;
    padding: 14px 18px; border-radius: 12px; border: 1px solid var(--line); background: var(--raised);
    transition: background-color 160ms var(--ease), border-color 160ms var(--ease);
  }
  .arm:hover { border-color: oklch(0.4 0.01 40); }
  .arm .lamp { grid-row: span 2; width: 14px; height: 14px; border-radius: 50%; background: var(--faint); }
  .arm .state { font-size: 26px; font-weight: 650; letter-spacing: -0.01em; line-height: 1.1; }
  .arm .hint { color: var(--muted); }
  .arm[aria-pressed="true"] { background: var(--tally); border-color: var(--tally); color: var(--tally-ink); }
  .arm[aria-pressed="true"] .lamp { background: var(--tally-ink); box-shadow: 0 0 0 4px oklch(0.985 0.01 27 / 0.25); }
  .arm[aria-pressed="true"] .hint { color: oklch(0.96 0.03 27); }
  .hotkey { display: grid; align-content: center; justify-items: end; gap: 4px; min-width: 128px; color: var(--muted); text-align: right; }
  kbd { font: 600 15px/1 -apple-system, system-ui, sans-serif; padding: 6px 9px; border-radius: 6px; background: var(--raised); border: 1px solid var(--line); color: var(--ink); letter-spacing: 0.04em; }
  .hotkey.bad kbd { color: var(--warn); border-color: var(--warn); }

  /* Health strip: each link of the chain. */
  .health { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); border: 1px solid var(--line); border-radius: var(--radius); background: var(--sunk); }
  .health li { padding: 9px 12px; display: grid; grid-template-columns: auto 1fr; column-gap: 8px; align-items: center; min-width: 0; }
  .health li + li { border-left: 1px solid var(--line); }
  .health .dot { grid-row: span 2; width: 8px; height: 8px; border-radius: 50%; background: var(--faint); }
  .health .name { font-weight: 600; }
  .health .sum { color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .health [data-level="ok"] .dot { background: var(--ok); }
  .health [data-level="warn"] .dot { background: var(--warn); }
  .health [data-level="error"] .dot { background: var(--error); }
  .health [data-level="error"] .sum { color: var(--error); }
  .health [data-level="warn"] .sum { color: var(--warn); }
  .health [data-level="off"] .dot { background: transparent; border: 1.5px solid var(--faint); }

  /* Problems, in words: health reasons first, then config, files, hotkey. */
  .issues { list-style: none; margin: -10px 0 0; padding: 0; display: grid; gap: 6px; }
  .issues:empty { display: none; }
  .issues li { padding: 9px 12px; border-radius: var(--radius); background: var(--error-bg); display: grid; gap: 2px; }
  .issues li.warn { background: var(--warn-bg); }
  .issues b { font-weight: 600; color: var(--error); }
  .issues li.warn b { color: var(--warn); }
  .issues pre { margin: 4px 0 0; font: 12px/1.45 var(--mono); white-space: pre-wrap; color: var(--muted); max-height: 9em; overflow: auto; }

  /* Live */
  .preview { width: 100%; aspect-ratio: 16 / 9; display: block; background: #000; border-radius: var(--radius); }
  .facts { display: grid; grid-template-columns: 1.3fr 1fr 1.3fr; gap: 16px; margin-top: 12px; }
  .fact { min-width: 0; }
  .fact .label { color: var(--muted); font-size: 12px; margin-bottom: 2px; }
  .fact .big { font-size: 15px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .fact .small { color: var(--muted); font-size: 12px; overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
  .fact.fresh .big { color: var(--ink); }
  .words { display: flex; flex-wrap: wrap; gap: 4px; min-height: 22px; }
  .words span { padding: 1px 7px; border-radius: 999px; background: var(--raised); border: 1px solid var(--line); font-size: 12px; }
  .words span.fired { border-color: var(--ink); }

  /* Effects */
  .rules { width: 100%; border-collapse: collapse; }
  .rules td { padding: 7px 8px; border-top: 1px solid var(--line); vertical-align: middle; }
  .rules tr:first-child td { border-top: 0; }
  .rules td.trigger { font-weight: 600; white-space: nowrap; }
  .rules td.what { color: var(--muted); width: 100%; }
  .rules td.what .note { display: block; color: var(--faint); font-size: 12px; }
  .rules td.what .problem { display: block; color: var(--warn); font-size: 12px; }
  .rules tr { transition: background-color 600ms var(--ease); }
  .rules tr.fired { background: oklch(0.6 0.2 27 / 0.16); transition: none; }
  .rules tr.off td.trigger, .rules tr.off td.what { opacity: 0.45; }
  .test {
    padding: 4px 12px; border-radius: 6px; border: 1px solid var(--line); background: var(--raised);
    transition: background-color 120ms var(--ease), border-color 120ms var(--ease);
  }
  .test:hover { border-color: oklch(0.45 0.01 40); background: oklch(0.26 0.008 40); }
  .test:active { background: oklch(0.3 0.008 40); }

  /* Native checkbox drawn as a switch (same control, same keyboard behaviour). */
  .switch { appearance: none; margin: 0; flex: none; width: 30px; height: 18px; border-radius: 999px; background: oklch(0.34 0.008 40); position: relative; cursor: pointer; transition: background-color 150ms var(--ease); vertical-align: middle; }
  .switch::after { content: ""; position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; border-radius: 50%; background: var(--ink); transition: transform 150ms var(--ease); }
  /* On = light track, dark knob: clear without adding a second green next to the health dots. */
  .switch:checked { background: oklch(0.86 0.005 60); }
  .switch:checked::after { background: var(--bg); }
  .switch:checked::after { transform: translateX(12px); }

  /* Audio */
  .audio { display: grid; gap: 12px; }
  .row { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
  .row label { display: flex; gap: 8px; align-items: center; cursor: pointer; }
  .route { color: var(--muted); }
  input[type=range] { accent-color: var(--ink); width: 160px; }
  .meters { display: grid; grid-template-columns: auto 1fr auto; gap: 6px 10px; align-items: center; }
  .meter { height: 6px; border-radius: 3px; background: var(--sunk); overflow: hidden; border: 1px solid var(--line); }
  .meter i { display: block; height: 100%; background: var(--ok); transform-origin: left; transform: scaleX(0); transition: transform 200ms linear; }
  .meter.hot i { background: var(--warn); }
  .meters .num { color: var(--muted); min-width: 52px; text-align: right; }

  /* Debug */
  details { border-top: 1px solid var(--line); padding-top: 12px; }
  summary { cursor: pointer; color: var(--muted); font-weight: 600; }
  details[open] summary { margin-bottom: 10px; }
  .debug pre { margin: 10px 0 0; font: 11.5px/1.5 var(--mono); white-space: pre-wrap; color: var(--muted); }
  .debug .row { color: var(--muted); }

  @media (max-width: 620px) {
    .health { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .health li:nth-child(3) { border-left: 0; }
    .health li:nth-child(n + 3) { border-top: 1px solid var(--line); }
    .facts { grid-template-columns: 1fr; gap: 10px; }
    .top { flex-direction: column; }
    .hotkey { justify-items: start; text-align: left; }
  }
  @media (prefers-reduced-motion: reduce) {
    *, *::after { transition: none !important; }
  }
`
