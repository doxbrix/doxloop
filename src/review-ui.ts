/**
 * The review center: four screens joined by real URLs.
 *
 *   /                       the proposals waiting for a decision
 *   /runs/:id               what one proposal changes, and why
 *   /runs/:id/pages/:n      one page at a time, current beside proposed
 *   /runs/:id/done          what was applied
 *
 * The reading screen carries one bar above the comparison and one below it;
 * everything else lives on the screen where it belongs.
 */

const ICONS: Record<string, string> = {
  page: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="14" y2="17"/>',
  navigation: '<rect x="3" y="3" width="7" height="18" rx="1.5"/><rect x="14" y="3" width="7" height="8" rx="1.5"/><rect x="14" y="15" width="7" height="6" rx="1.5"/>',
  configuration: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.38a2 2 0 0 0-.73-2.73l-.15-.09a2 2 0 0 1-1-1.74v-.51a2 2 0 0 1 1-1.72l.15-.1a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
  evidence: '<path d="M20 13c0 5-3.5 7.5-8 9-4.5-1.5-8-4-8-9V5l8-3 8 3z"/><path d="m9 12 2 2 4-4"/>',
  asset: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-4.5-4.5L9 18"/>',
  check: '<polyline points="20 6 9 17 4 12"/>',
  'check-circle': '<circle cx="12" cy="12" r="10"/><polyline points="16 9.5 10.8 15 8 12.3"/>',
  x: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-2.6-6.4"/><polyline points="21 3 21 9 15 9"/>',
  clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6.5 12 12 15.5 14"/>',
  columns: '<rect x="3" y="4" width="18" height="16" rx="2"/><line x1="12" y1="4" x2="12" y2="20"/>',
  code: '<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>',
  alert: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
  shield: '<path d="M20 13c0 5-3.5 7.5-8 9-4.5-1.5-8-4-8-9V5l8-3 8 3z"/>',
  keyboard: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M6 9h.01M10 9h.01M14 9h.01M18 9h.01M6 13h.01M18 13h.01M10 13h4"/>',
  inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.5 5h13a2 2 0 0 1 1.9 1.4L22 12v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-6l1.6-5.6A2 2 0 0 1 5.5 5z"/>',
  arrowLeft: '<line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>',
  arrowRight: '<line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/>',
  chevronRight: '<polyline points="9 18 15 12 9 6"/>',
  chevronDown: '<polyline points="6 9 12 15 18 9"/>',
  sliders: '<line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/>',
  sparkle: '<path d="M12 3l1.9 5.8L20 11l-6.1 2.2L12 19l-1.9-5.8L4 11l6.1-2.2z"/>',
  search: '<circle cx="11" cy="11" r="7"/><line x1="20" y1="20" x2="16.65" y2="16.65"/>',
  activity: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
}

export function icon(name: string, size = 16): string {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] ?? ICONS.page}</svg>`
}

export function reviewDocument(token: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Doxloop · Review</title>
  <link rel="icon" href="/brand/favicon.png">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Instrument+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap">
  <style>${shellCss()}</style>
</head>
<body>
  <div id="app" class="rv-app"></div>
  <div id="toast" class="rv-toast" role="status" aria-live="polite"></div>
  <div id="overlay" class="rv-overlay" hidden>
    <div class="rv-modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
      <div class="rv-modal-head"><h2 id="modal-title">Keyboard shortcuts</h2><button class="rv-icon-btn" data-close aria-label="Close">${icon('x', 15)}</button></div>
      <dl class="rv-keys">
        <div><dt><kbd>Enter</kbd> <kbd>A</kbd></dt><dd>Accept this page and continue</dd></div>
        <div><dt><kbd>S</kbd></dt><dd>Skip this page</dd></div>
        <div><dt><kbd>←</kbd> <kbd>→</kbd></dt><dd>Previous / next page</dd></div>
        <div><dt><kbd>D</kbd></dt><dd>Switch between rendered and source</dd></div>
        <div><dt><kbd>Esc</kbd></dt><dd>Back to the proposal</dd></div>
        <div><dt><kbd>?</kbd></dt><dd>This help</dd></div>
      </dl>
      <p class="rv-modal-note">Inside the comparison, <kbd>N</kbd> and <kbd>P</kbd> jump between changed blocks.</p>
    </div>
  </div>
  <script>${shellScript(token)}</script>
</body>
</html>`
}

/* ── Styles ───────────────────────────────────────────────────────────── */

function shellCss(): string {
  return `
:root{
  /* Brand, sampled from the Doxloop wordmark. */
  --navy:#022D78;--navy-hover:#01235E;--navy-active:#011A48;
  --navy-light:#E7ECF7;--navy-lighter:#F4F7FC;--navy-rgb:2 45 120;
  --teal:#17B1AC;--teal-hover:#129490;--teal-strong:#0C6F6B;
  --teal-soft:#E5F7F6;--teal-border:#A9E5E2;--teal-rgb:23 177 172;

  --text-primary:#0E1A31;--text-secondary:#4C5875;--text-muted:#6B7695;--text-subtle:#96A0B8;
  --surface-page:#F5F7FB;--surface-card:#FFFFFF;--bg-section:#EEF1F7;--bg-rail:#FAFBFD;
  --border:#E1E6F0;--border-input:#D5DCEA;

  --success:#16A34A;--success-strong:#136B36;--success-soft:#E8F7EE;--success-border:#B7E4C7;
  --danger:#DC2626;--danger-strong:#A81C1C;--danger-soft:#FDECEC;--danger-border:#F5C4C4;
  --warning:#C2760A;--warning-strong:#8F5606;--warning-soft:#FDF3E3;--warning-border:#F0DBAF;

  --shadow-xs:0 1px 2px rgba(2,45,120,.05);
  --shadow-sm:0 1px 4px rgba(2,45,120,.07),0 0 1px rgba(2,45,120,.05);
  --shadow-md:0 6px 18px rgba(2,45,120,.10),0 1px 3px rgba(2,45,120,.06);
  --shadow-lg:0 16px 40px rgba(2,45,120,.16),0 2px 8px rgba(2,45,120,.08);
  --mono:'JetBrains Mono',ui-monospace,SFMono-Regular,Menlo,monospace;
  color-scheme:light;
}
*{box-sizing:border-box}
html,body{height:100%}
body{margin:0;font-family:"Instrument Sans",system-ui,-apple-system,"Segoe UI",sans-serif;font-size:13.5px;line-height:1.5;color:var(--text-primary);background:var(--surface-page);-webkit-font-smoothing:antialiased}
button,input{font-family:inherit}
h1,h2,h3,p,dl,dd,ul{margin:0}
ul{list-style:none;padding:0}
a{color:inherit}
kbd{font-family:var(--mono);font-size:10.5px;background:#fff;border:1px solid var(--border);border-bottom-width:2px;border-radius:4px;padding:1px 5px;color:var(--text-secondary)}
[hidden]{display:none !important}
.rv-app{display:flex;flex-direction:column;height:100%}

/* ── App bar ── */
.rv-appbar{display:flex;align-items:center;gap:14px;height:56px;min-height:56px;padding:0 22px;background:#fff;border-bottom:1px solid var(--border)}
.rv-logo{display:inline-flex;align-items:center;border:0;background:transparent;padding:0;cursor:pointer}
.rv-logo img{height:21px;width:auto;display:block}
.rv-appbar-spacer{flex:1}
.rv-back{display:inline-flex;align-items:center;gap:7px;height:32px;padding:0 11px 0 8px;border:1px solid var(--border);border-radius:8px;background:#fff;color:var(--text-secondary);font-size:12.5px;font-weight:600;cursor:pointer;transition:background .14s,color .14s,border-color .14s}
.rv-back:hover{background:var(--navy-lighter);color:var(--navy);border-color:var(--border-input)}
.rv-appbar-divider{width:1px;height:22px;background:var(--border)}
.rv-appbar-title{min-width:0;display:flex;flex-direction:column;line-height:1.25}
.rv-appbar-title strong{font-size:13.5px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rv-appbar-title span{font-family:var(--mono);font-size:10.5px;color:var(--text-subtle);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}

/* ── Page canvas ── */
.rv-scroll{flex:1;overflow-y:auto}
.rv-page{width:100%;max-width:860px;margin:0 auto;padding:36px 24px 64px}
.rv-page--wide{max-width:1020px}
.rv-page-head{margin-bottom:26px}
.rv-eyebrow{display:block;font-size:10.5px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--text-subtle);margin-bottom:8px}
.rv-page h1{font-size:26px;font-weight:700;letter-spacing:-.02em;line-height:1.2}
.rv-page-sub{margin-top:7px;font-size:14px;color:var(--text-secondary);max-width:60ch}
.rv-section{margin-top:28px}
.rv-section-title{display:flex;align-items:baseline;gap:8px;font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--text-subtle);margin-bottom:10px}

/* ── Buttons ── */
.rv-btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;height:38px;padding:0 16px;border-radius:9px;border:1px solid transparent;font-size:13.5px;font-weight:600;cursor:pointer;white-space:nowrap;transition:background .14s,border-color .14s,color .14s,transform .08s,box-shadow .14s}
.rv-btn:active:not(:disabled){transform:scale(.985)}
.rv-btn:disabled{opacity:.45;cursor:not-allowed}
.rv-btn--primary{background:var(--navy);color:#fff;box-shadow:0 1px 2px rgba(var(--navy-rgb),.35)}
.rv-btn--primary:hover:not(:disabled){background:var(--navy-hover)}
.rv-btn--ghost{background:#fff;border-color:var(--border-input);color:var(--text-secondary)}
.rv-btn--ghost:hover:not(:disabled){background:var(--navy-lighter);color:var(--navy);border-color:var(--navy-light)}
.rv-btn--quiet{background:transparent;color:var(--text-muted);padding:0 10px}
.rv-btn--quiet:hover:not(:disabled){color:var(--danger-strong);background:var(--danger-soft)}
.rv-btn--sm{height:32px;padding:0 12px;font-size:12.5px;border-radius:8px}
.rv-icon-btn{display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;border-radius:8px;border:1px solid var(--border);background:#fff;color:var(--text-muted);cursor:pointer;transition:background .14s,color .14s}
.rv-icon-btn:hover{background:var(--navy-lighter);color:var(--navy)}
.rv-icon-btn.is-busy svg{animation:rv-spin .7s linear infinite}
@keyframes rv-spin{to{transform:rotate(360deg)}}
.rv-link{border:0;background:none;padding:0;font:inherit;font-weight:600;color:var(--navy);cursor:pointer;text-decoration:underline;text-underline-offset:2px;text-decoration-color:rgb(var(--navy-rgb)/.3)}
.rv-link:hover{text-decoration-color:var(--navy)}

/* ── Segmented ── */
.rv-segmented{display:inline-flex;padding:2px;background:var(--bg-section);border-radius:9px}
.rv-segmented button{border:0;background:transparent;font-size:12.5px;font-weight:600;color:var(--text-muted);padding:6px 13px;border-radius:7px;cursor:pointer;transition:background .14s,color .14s}
.rv-segmented button.is-active{background:#fff;color:var(--navy);box-shadow:var(--shadow-xs)}

/* ── Status ── */
.rv-pill{display:inline-flex;align-items:center;gap:6px;height:24px;padding:0 11px;border-radius:100px;font-size:11px;font-weight:700;letter-spacing:.02em;text-transform:capitalize;background:var(--bg-section);color:var(--text-secondary)}
.rv-pill--awaiting-review,.rv-pill--partially-applied{background:var(--warning-soft);color:var(--warning-strong)}
.rv-pill--applied{background:var(--success-soft);color:var(--success-strong)}
.rv-pill--failed,.rv-pill--conflicted,.rv-pill--rejected{background:var(--danger-soft);color:var(--danger-strong)}
.rv-pill--generating{background:var(--teal-soft);color:var(--teal-strong)}
.rv-dot{width:8px;height:8px;border-radius:50%;flex:none;background:var(--text-subtle)}
.rv-dot--awaiting-review,.rv-dot--partially-applied{background:var(--warning)}
.rv-dot--applied{background:var(--success)}
.rv-dot--failed,.rv-dot--conflicted,.rv-dot--rejected{background:var(--danger)}
.rv-dot--generating{background:var(--teal);animation:rv-pulse 1.2s ease-in-out infinite}
@keyframes rv-pulse{50%{opacity:.35}}

/* ── Proposal cards ── */
.rv-cards{display:flex;flex-direction:column;gap:12px}
.rv-card{display:block;width:100%;text-align:left;background:#fff;border:1px solid var(--border);border-radius:14px;padding:18px 20px;box-shadow:var(--shadow-xs);transition:border-color .15s,box-shadow .15s,transform .15s}
button.rv-card{cursor:pointer;font:inherit;color:inherit}
button.rv-card:hover{border-color:var(--navy-light);box-shadow:var(--shadow-md);transform:translateY(-1px)}
.rv-card-top{display:flex;align-items:center;gap:9px;margin-bottom:9px}
.rv-card-meta{margin-left:auto;font-size:11.5px;color:var(--text-muted);white-space:nowrap}
.rv-card h2{font-size:17px;font-weight:700;letter-spacing:-.01em}
.rv-card-why{margin-top:5px;font-size:13px;color:var(--text-muted)}
.rv-card-foot{display:flex;align-items:center;gap:12px;margin-top:14px}
.rv-card-cta{margin-left:auto;display:inline-flex;align-items:center;gap:7px;font-size:13px;font-weight:600;color:var(--navy)}
.rv-bar{flex:1;max-width:180px;height:5px;border-radius:3px;background:var(--bg-section);overflow:hidden}
.rv-bar span{display:block;height:100%;border-radius:3px;background:var(--teal);transition:width .3s ease}
.rv-bar--done span{background:var(--success)}

/* ── Overview ── */
.rv-why{display:flex;gap:12px;padding:14px 16px;background:#fff;border:1px solid var(--border);border-radius:12px;margin-top:18px}
.rv-why-icon{display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;border-radius:9px;background:var(--teal-soft);color:var(--teal-strong);flex:none}
.rv-why-body{min-width:0;font-size:13px;color:var(--text-secondary)}
.rv-why-body strong{display:block;color:var(--text-primary);font-size:12.5px;margin-bottom:2px}
.rv-why-body code{font-family:var(--mono);font-size:11.5px;color:var(--text-muted);word-break:break-word}
.rv-meta-row{display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin-top:12px;font-size:12.5px;color:var(--text-muted)}
.rv-meta-row .rv-sep{color:var(--border-input)}
.rv-meta-ok{display:inline-flex;align-items:center;gap:5px;color:var(--success-strong);font-weight:600}

.rv-rows{border:1px solid var(--border);border-radius:12px;overflow:hidden;background:#fff}
.rv-row{display:flex;align-items:center;gap:13px;width:100%;text-align:left;padding:14px 16px;border:0;border-bottom:1px solid var(--border);background:#fff;cursor:pointer;font:inherit;color:inherit;transition:background .14s}
.rv-row:last-child{border-bottom:0}
.rv-row:hover{background:var(--navy-lighter)}
.rv-row-icon{display:inline-flex;align-items:center;justify-content:center;width:34px;height:34px;border-radius:10px;background:var(--navy-light);color:var(--navy);flex:none}
.rv-row-body{min-width:0;flex:1;display:flex;flex-direction:column}
.rv-row-title{font-size:14px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rv-row-path{font-family:var(--mono);font-size:11px;color:var(--text-subtle);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px}
.rv-row-right{display:flex;align-items:center;gap:12px;flex:none;color:var(--text-muted);font-size:12.5px}
.rv-chip{display:inline-flex;align-items:center;gap:5px;height:22px;padding:0 9px;border-radius:7px;font-size:11px;font-weight:700;letter-spacing:.02em;background:var(--bg-section);color:var(--text-muted)}
.rv-chip--accepted{background:var(--success-soft);color:var(--success-strong)}
.rv-chip--pending{background:var(--warning-soft);color:var(--warning-strong)}

/* Still-authoring state */
.rv-working{display:flex;gap:14px;align-items:flex-start;margin-top:20px;padding:18px 20px;border:1px solid var(--teal-border);border-radius:12px;background:var(--teal-soft)}
.rv-working-body{display:flex;flex-direction:column;gap:4px;min-width:0}
.rv-working-body strong{font-size:14px;color:var(--teal-strong)}
.rv-working-body span{font-size:13px;color:var(--text-secondary);line-height:1.55}
.rv-spinner{flex:none;width:20px;height:20px;margin-top:1px;border-radius:50%;border:2px solid rgb(var(--teal-rgb)/.25);border-top-color:var(--teal);animation:rv-spin .8s linear infinite}
.rv-spinner--sm{width:13px;height:13px;border-width:2px;margin:0}

.rv-support{margin-top:18px;border:1px solid var(--border);border-radius:12px;background:#fff;overflow:hidden}
.rv-support summary{display:flex;align-items:center;gap:10px;padding:13px 16px;cursor:pointer;list-style:none;font-size:13px}
.rv-support summary::-webkit-details-marker{display:none}
.rv-support-chevron{color:var(--text-subtle);transition:transform .15s}
.rv-support[open] .rv-support-chevron{transform:rotate(90deg)}
.rv-support-note{margin-left:auto;font-size:12px;color:var(--text-muted);text-align:right}
.rv-support-body{border-top:1px solid var(--border);background:var(--bg-rail)}

.rv-actionbar{position:sticky;bottom:0;display:flex;align-items:center;gap:10px;margin-top:28px;padding:14px 0 0;border-top:1px solid var(--border);background:linear-gradient(180deg,rgba(245,247,251,0),var(--surface-page) 40%)}
.rv-actionbar .rv-spacer{flex:1}

/* ── Focus screen ── */
.rv-focus{display:flex;flex-direction:column;flex:1;min-height:0}
.rv-focus-bar{display:flex;align-items:center;gap:12px;height:52px;min-height:52px;padding:0 18px;background:#fff;border-bottom:1px solid var(--border)}
.rv-title-btn{display:inline-flex;align-items:center;gap:8px;min-width:0;border:1px solid transparent;background:transparent;border-radius:9px;padding:5px 9px;cursor:pointer;font:inherit;color:inherit;transition:background .14s,border-color .14s}
.rv-title-btn:hover{background:var(--navy-lighter);border-color:var(--navy-light)}
.rv-title-btn strong{font-size:14.5px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rv-title-btn svg{flex:none;color:var(--text-subtle)}
.rv-counter{font-size:12.5px;font-weight:600;color:var(--text-muted);white-space:nowrap}
.rv-menu-wrap{position:relative}
.rv-menu{position:absolute;z-index:60;top:calc(100% + 6px);min-width:284px;max-width:340px;background:#fff;border:1px solid var(--border);border-radius:12px;box-shadow:var(--shadow-lg);padding:6px;display:flex;flex-direction:column;gap:2px}
.rv-menu--right{right:0}
.rv-menu-label{padding:8px 10px 4px;font-size:10.5px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--text-subtle)}
.rv-menu-item{display:flex;align-items:flex-start;gap:9px;width:100%;text-align:left;border:0;background:transparent;border-radius:8px;padding:8px 10px;cursor:pointer;font:inherit;font-size:13px;color:var(--text-primary);transition:background .12s}
.rv-menu-item>svg{flex:none;margin-top:2px;color:var(--text-muted)}
.rv-menu-item.is-active>svg{color:var(--navy)}
.rv-menu-item:hover{background:var(--navy-lighter)}
.rv-menu-item.is-active{color:var(--navy);font-weight:600}
.rv-menu-item .rv-menu-check{margin-left:auto;color:var(--navy)}
.rv-menu-item small{display:block;font-size:11px;color:var(--text-subtle);font-weight:400}
.rv-menu-sep{height:1px;background:var(--border);margin:4px 2px}

.rv-stage{position:relative;flex:1;min-height:0;background:var(--surface-page)}
.rv-stage iframe{width:100%;height:100%;border:0;display:block;background:#fff}
.rv-source{position:absolute;inset:0;overflow:auto;padding:18px 20px 40px}

.rv-focus-foot{display:flex;align-items:center;gap:14px;height:60px;min-height:60px;padding:0 18px;background:#fff;border-top:1px solid var(--border)}
.rv-progress-dots{display:flex;align-items:center;gap:6px}
.rv-pdot{width:9px;height:9px;border-radius:50%;background:var(--border-input);transition:background .2s,transform .2s}
.rv-pdot--done{background:var(--success)}
.rv-pdot--current{background:var(--navy);transform:scale(1.25)}
.rv-foot-count{font-size:13px;color:var(--text-muted)}
.rv-foot-actions{margin-left:auto;display:flex;align-items:center;gap:10px}
.rv-applied-note{display:inline-flex;align-items:center;gap:7px;font-size:13px;font-weight:600;color:var(--success-strong)}

/* ── Source diff ── */
.rv-hunk{border:1px solid var(--border);border-radius:11px;background:#fff;overflow:hidden;margin-bottom:12px;box-shadow:var(--shadow-xs)}
.rv-hunk--accepted{border-color:var(--success-border)}
.rv-hunk--rejected{opacity:.6}
.rv-hunk-head{display:flex;align-items:center;gap:10px;padding:10px 13px;border-bottom:1px solid var(--border);background:var(--bg-rail)}
.rv-hunk-title{font-size:12.5px;font-weight:700}
.rv-hunk-lines{font-family:var(--mono);font-size:10.5px;color:var(--text-subtle)}
.rv-hunk-actions{margin-left:auto;display:flex;align-items:center;gap:8px}
.rv-hunk-state{display:inline-flex;align-items:center;gap:5px;font-size:12px;font-weight:700}
.rv-hunk-state--accepted{color:var(--success-strong)}
.rv-hunk-state--rejected{color:var(--danger-strong)}
.rv-btn--accept{background:var(--success-soft);border-color:var(--success-border);color:var(--success-strong)}
.rv-btn--accept:hover:not(:disabled){background:var(--success);border-color:var(--success);color:#fff}
.rv-lines{font-family:var(--mono);font-size:12px;line-height:1.7}
.rv-line{display:grid;grid-template-columns:46px 46px 18px minmax(0,1fr);align-items:baseline}
.rv-line-num{padding-right:9px;text-align:right;font-size:10.5px;color:#AAB3C7;user-select:none}
.rv-line-sign{text-align:center;font-weight:700;color:#AAB3C7;user-select:none}
.rv-line-code{padding:0 12px 0 4px;white-space:pre-wrap;overflow-wrap:anywhere}
.rv-line--insert{background:#EDFAF2}
.rv-line--insert .rv-line-sign{color:var(--success)}
.rv-line--delete{background:#FDF1F1}
.rv-line--delete .rv-line-sign{color:var(--danger)}
.rv-line--gap{grid-template-columns:110px minmax(0,1fr);background:var(--bg-rail);border-block:1px solid var(--border);color:var(--text-subtle);font-size:11px;padding:3px 0}
.rv-line--gap span:first-child{text-align:center}
.rv-word{border-radius:3px;padding:0 2px;box-decoration-break:clone;-webkit-box-decoration-break:clone}
.rv-word--ins{background:#C4EFD5;color:#0A5330}
.rv-word--del{background:#FACFCF;color:#851B1B}
.rv-hint{display:flex;align-items:center;gap:9px;margin-bottom:14px;padding:10px 14px;border-radius:10px;background:var(--teal-soft);border:1px solid var(--teal-border);color:var(--teal-strong);font-size:12.5px;font-weight:500}
.rv-hint svg{flex:none}

/* ── Feedback ── */
.rv-banner{display:flex;align-items:flex-start;gap:10px;padding:12px 15px;border-radius:11px;font-size:13px;line-height:1.5;margin-top:16px}
.rv-banner--error{background:var(--danger-soft);border:1px solid var(--danger-border);color:var(--danger-strong)}
.rv-banner--warn{background:var(--warning-soft);border:1px solid var(--warning-border);color:var(--warning-strong)}
.rv-banner svg{flex:none;margin-top:1px}
.rv-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:9px;text-align:center;padding:70px 24px;color:var(--text-muted)}
.rv-empty-icon{display:inline-flex;align-items:center;justify-content:center;width:58px;height:58px;border-radius:17px;background:#fff;border:1px solid var(--border);color:var(--navy);margin-bottom:4px;box-shadow:var(--shadow-xs)}
.rv-empty h2{font-size:17px;font-weight:700;color:var(--text-primary)}
.rv-empty p{max-width:44ch;font-size:13.5px}
.rv-empty code,.rv-code{font-family:var(--mono);font-size:12px;background:var(--bg-section);border-radius:5px;padding:2px 7px;color:var(--text-secondary)}
.rv-skeleton{height:74px;border-radius:12px;margin-bottom:12px;background:linear-gradient(90deg,var(--bg-section) 25%,#F8FAFD 50%,var(--bg-section) 75%);background-size:200% 100%;animation:rv-shimmer 1.2s infinite}
@keyframes rv-shimmer{to{background-position:-200% 0}}

.rv-done{display:flex;flex-direction:column;align-items:center;text-align:center;padding:70px 24px}
.rv-done-mark{display:inline-flex;align-items:center;justify-content:center;width:66px;height:66px;border-radius:50%;background:var(--success-soft);color:var(--success);border:1px solid var(--success-border);margin-bottom:18px}
.rv-done-mark--neutral{background:#fff;color:var(--text-subtle);border-color:var(--border)}
.rv-done h1{font-size:26px;font-weight:700;letter-spacing:-.02em}
.rv-done p{margin-top:8px;font-size:14.5px;color:var(--text-secondary);max-width:46ch}
.rv-done-actions{display:flex;gap:10px;margin-top:26px;flex-wrap:wrap;justify-content:center}
.rv-done-list{margin-top:26px;width:100%;max-width:520px;text-align:left}

/* ── Overlay & toast ── */
.rv-overlay{position:fixed;inset:0;z-index:120;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(6,18,45,.45);backdrop-filter:blur(2px)}
.rv-modal{width:100%;max-width:430px;background:#fff;border-radius:16px;padding:22px;box-shadow:var(--shadow-lg)}
.rv-modal-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:16px}
.rv-modal-head h2{font-size:16.5px;font-weight:700}
.rv-keys{display:flex;flex-direction:column;gap:10px}
.rv-keys>div{display:flex;align-items:center;justify-content:space-between;gap:16px}
.rv-keys dt{display:flex;gap:4px}
.rv-keys dd{font-size:13px;color:var(--text-secondary);text-align:right}
.rv-modal-note{margin-top:16px;padding-top:13px;border-top:1px solid var(--border);font-size:12px;color:var(--text-muted)}
.rv-toast{position:fixed;left:50%;bottom:26px;z-index:200;display:flex;align-items:center;gap:10px;max-width:min(560px,calc(100vw - 40px));padding:12px 16px;border-radius:11px;background:#0E1A31;color:#fff;font-size:13px;font-weight:500;box-shadow:var(--shadow-lg);opacity:0;transform:translate(-50%,14px);pointer-events:none;transition:opacity .18s,transform .18s}
.rv-toast.is-visible{opacity:1;transform:translate(-50%,0)}
.rv-toast--success{background:#12603C}
.rv-toast--error{background:#8E1D1D}
.rv-toast svg{flex:none}

/* ── Review center shell ── */
.rv-shell{display:grid;grid-template-columns:260px minmax(0,1fr);height:100%;min-height:0;background:#fff}
.rv-sidebar{display:flex;flex-direction:column;min-height:0;padding:27px 12px 22px;border-right:1px solid var(--border);background:#fff}
.rv-sidebar-logo{display:flex;align-items:center;height:30px;padding:0 5px;margin-bottom:40px;border:0;background:transparent;cursor:pointer}
.rv-sidebar-logo img{display:block;width:98px;height:auto}
.rv-sidebar-label{padding:0 5px 10px;font-size:11px;font-weight:600;letter-spacing:.035em;text-transform:uppercase;color:var(--text-muted)}
.rv-nav{display:flex;flex-direction:column;gap:4px}
.rv-nav-item{display:flex;align-items:center;gap:13px;width:100%;height:42px;padding:0 14px;border:0;border-radius:8px;background:transparent;color:var(--text-primary);font:inherit;font-size:14px;text-align:left;cursor:pointer}
.rv-nav-item svg{color:var(--text-secondary);flex:none}
.rv-nav-item:hover{background:var(--navy-lighter)}
.rv-nav-item.is-active{background:#EEF3FD;color:#062D91;font-weight:600}
.rv-nav-item.is-active svg{color:#2876E8}
.rv-sidebar-safe{display:flex;align-items:center;gap:13px;margin-top:auto;padding:21px 7px 0;border-top:1px solid var(--border);color:var(--text-secondary)}
.rv-sidebar-safe>svg{width:28px;height:28px;color:var(--text-primary);flex:none}
.rv-sidebar-safe strong,.rv-sidebar-safe span{display:block;font-size:12.5px;line-height:1.45}
.rv-sidebar-safe strong{font-weight:500}
.rv-sidebar-safe span{color:var(--text-muted)}
.rv-main{display:flex;flex-direction:column;min-width:0;min-height:0;background:#fff}

.rv-appbar{height:64px;min-height:64px;padding:0 24px;background:#fff}
.rv-appbar-search{position:relative;width:min(520px,46vw);margin-left:auto}
.rv-appbar-search svg{position:absolute;left:14px;top:50%;transform:translateY(-50%);color:var(--text-secondary);pointer-events:none}
.rv-appbar-search input{width:100%;height:42px;padding:0 14px 0 43px;border:1px solid var(--border-input);border-radius:9px;background:#fff;color:var(--text-primary);font-size:14px;outline:0;transition:border-color .14s,box-shadow .14s}
.rv-appbar-search input::placeholder{color:var(--text-muted)}
.rv-appbar-search input:focus{border-color:#7AA7F8;box-shadow:0 0 0 3px rgba(40,118,232,.1)}
.rv-appbar .rv-icon-btn{width:42px;height:42px;margin-left:10px}
.rv-back{height:auto;padding:6px 0;border:0;background:transparent;border-radius:0;font-size:14px;font-weight:500}
.rv-back:hover{border-color:transparent;background:transparent;color:var(--navy)}

.rv-scroll{background:linear-gradient(135deg,#fff 0%,#fbfcff 55%,#f8faff 100%)}
.rv-page{max-width:1200px;padding:30px 32px 58px}
.rv-page--wide{max-width:1200px}
.rv-page-head{display:flex;align-items:flex-start;gap:24px;margin-bottom:25px}
.rv-page-head-copy{min-width:0}
.rv-page-head .rv-btn{margin-left:auto}
.rv-page h1{font-size:25px;line-height:1.22;letter-spacing:-.025em}
.rv-page-sub{margin-top:5px;max-width:none;font-size:13.5px}
.rv-eyebrow{font-size:13px;font-weight:400;letter-spacing:0;text-transform:capitalize;margin-bottom:7px;color:var(--text-muted)}
.rv-section{margin-top:24px}
.rv-section-title{font-size:15px;letter-spacing:0;text-transform:none;color:var(--text-primary);margin-bottom:10px}
.rv-count{display:inline-flex;align-items:center;justify-content:center;min-width:31px;height:24px;padding:0 9px;border-radius:999px;background:var(--bg-section);color:var(--text-secondary);font-size:12px;font-weight:600}

.rv-metrics{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:18px;margin-bottom:25px}
.rv-metric{display:flex;align-items:center;gap:20px;min-height:116px;padding:22px;border:1px solid var(--border-input);border-radius:9px;background:rgba(255,255,255,.86)}
.rv-metric-icon{display:flex;align-items:center;justify-content:center;width:60px;height:60px;border-radius:9px;background:#EAF2FF;color:#2876E8;flex:none}
.rv-metric-icon svg{width:28px;height:28px}
.rv-metric:nth-child(2) .rv-metric-icon{background:#E7F8F7;color:#0AA59F}
.rv-metric:nth-child(3) .rv-metric-icon{background:#FFF4E6;color:#C77900}
.rv-metric-copy{display:flex;flex-direction:column;min-width:0}
.rv-metric-label{font-size:12.5px;font-weight:600;color:var(--text-secondary)}
.rv-metric-value{font-size:25px;font-weight:600;line-height:1.2;color:var(--text-primary);letter-spacing:-.02em}
.rv-metric-note{font-size:12px;color:var(--text-muted)}

.rv-queue-head{display:flex;align-items:center;gap:10px;margin-bottom:7px}
.rv-queue-head h2{font-size:15px;line-height:1.3}
.rv-segmented{padding:0;background:transparent;border-radius:0;margin-bottom:2px}
.rv-segmented button{padding:7px 13px;border:1px solid transparent;border-radius:7px;font-size:12.5px}
.rv-segmented button.is-active{border-color:var(--border-input);background:#fff;box-shadow:var(--shadow-xs)}
.rv-cards{gap:10px}
.rv-card{border-radius:8px;padding:17px 20px 14px;box-shadow:none}
button.rv-card:hover{transform:none;border-color:#AFC5EB;box-shadow:0 4px 14px rgba(2,45,120,.07)}
.rv-card-top{margin-bottom:11px}
.rv-pill{height:23px;font-size:10.5px;text-transform:uppercase}
.rv-card-meta{font-size:12px}
.rv-card h2{font-size:17px}
.rv-card-why{margin-top:3px;font-size:13px}
.rv-card-foot{min-height:44px;margin-top:12px;padding-top:11px;border-top:1px solid var(--border);flex-wrap:wrap}
.rv-card-fact{display:inline-flex;align-items:center;gap:7px;color:var(--text-secondary);font-size:12.5px}
.rv-card-fact svg{color:var(--text-secondary)}
.rv-card-fact--ok{margin-left:8px;padding-left:22px;border-left:1px solid var(--border);color:var(--success-strong)}
.rv-card-fact--ok svg{color:var(--success-strong)}
.rv-card-cta{height:40px;padding:0 18px;border-radius:8px;background:var(--navy);color:#fff}
.rv-card-cta:hover{background:var(--navy-hover)}

.rv-activity{margin-top:18px;border:1px solid var(--border-input);border-radius:8px;background:#fff;overflow:hidden}
.rv-activity h2{padding:14px 18px 5px;font-size:15px}
.rv-activity-row{display:grid;grid-template-columns:minmax(0,1fr) 190px 120px;gap:20px;align-items:center;min-height:50px;padding:0 18px;border-top:1px solid var(--border);font-size:13px}
.rv-activity-row--head{min-height:34px;border-top:0;color:var(--text-secondary);font-size:12px;font-weight:600}
.rv-activity .rv-pill{justify-self:start}

.rv-overview-head{margin-bottom:24px}
.rv-overview-head .rv-meta-row{margin-top:14px}
.rv-overview-grid{display:grid;grid-template-columns:minmax(0,1fr) 360px;gap:24px;align-items:start}
.rv-overview-grid .rv-section{margin-top:0}
.rv-rows{border-radius:9px;border-color:var(--border-input)}
.rv-row{min-height:69px;padding:12px 20px;gap:16px}
.rv-row-icon{width:46px;height:46px;border-radius:9px;background:#EEF3FD}
.rv-row-title{font-size:15px}
.rv-row-path{font-family:inherit;font-size:12.5px;color:var(--text-muted);margin-top:0}
.rv-chip{height:25px;border-radius:999px;background:#FFF3DE;color:#A55E00}
.rv-summary{position:sticky;top:24px;border:1px solid var(--border-input);border-radius:9px;background:#fff;padding:18px}
.rv-summary h2{font-size:16px;margin-bottom:20px}
.rv-summary-why{display:flex;gap:14px;margin-bottom:18px}
.rv-summary-why .rv-why-icon{width:40px;height:40px;margin:0}
.rv-summary-label{display:block;font-size:12.5px;color:var(--text-secondary);margin-bottom:5px}
.rv-summary-why strong{display:block;font-size:13.5px;font-weight:600;line-height:1.45}
.rv-summary-stats{display:flex;flex-direction:column;gap:11px;padding:4px 0 17px}
.rv-summary-stat{display:flex;justify-content:space-between;gap:16px;color:var(--text-secondary);font-size:13px}
.rv-summary-stat strong{color:var(--text-primary);font-weight:500}
.rv-summary-stat .is-success{color:var(--success-strong);font-weight:600}
.rv-summary-support{border-block:1px solid var(--border);margin-bottom:15px}
.rv-summary-support summary{display:flex;align-items:center;gap:8px;min-height:50px;cursor:pointer;list-style:none;font-size:13px}
.rv-summary-support summary::-webkit-details-marker{display:none}
.rv-summary-support summary svg{margin-left:auto}
.rv-summary-support[open] summary svg{transform:rotate(90deg)}
.rv-summary-support .rv-rows{margin:0 -8px 10px;border:0}
.rv-summary-support .rv-row{min-height:54px;padding:8px}
.rv-summary-support .rv-row-icon{width:34px;height:34px}
.rv-summary-note{margin-bottom:16px;text-align:center;font-size:11.5px;color:var(--text-muted)}
.rv-summary-actions{display:flex;flex-direction:column;gap:9px}
.rv-summary-actions .rv-btn{width:100%}
.rv-summary-actions .rv-btn--quiet{color:var(--danger)}
.rv-safe-note{display:flex;align-items:center;gap:10px;margin-top:13px;padding:0 5px;color:var(--text-muted);font-size:12.5px}
.rv-safe-note svg{flex:none}
.rv-why{margin-top:0}

@media(max-width:960px){
  .rv-shell{grid-template-columns:200px minmax(0,1fr)}
  .rv-overview-grid{grid-template-columns:minmax(0,1fr) 300px}
  .rv-page{padding-inline:24px}
  .rv-metric{gap:13px;padding:17px}.rv-metric-icon{width:48px;height:48px}
}
@media(max-width:760px){
  .rv-shell{display:block;overflow:hidden}.rv-sidebar{display:none}.rv-main{height:100%}
  .rv-page{padding:24px 16px 56px}.rv-appbar,.rv-focus-bar,.rv-focus-foot{padding:0 14px}
  .rv-appbar-search{width:100%}.rv-metrics{grid-template-columns:1fr;gap:10px}.rv-metric{min-height:88px}
  .rv-overview-grid{grid-template-columns:1fr}.rv-summary{position:static}.rv-counter,.rv-foot-count{display:none}
  .rv-activity-row{grid-template-columns:minmax(0,1fr) 100px}.rv-activity-row>*:last-child{display:none}
}
  `
}

/* ── Client behaviour ─────────────────────────────────────────────────── */

function shellScript(token: string): string {
  const iconLiterals = JSON.stringify({
    page: icon('page', 16),
    navigation: icon('navigation', 16),
    configuration: icon('configuration', 16),
    evidence: icon('evidence', 16),
    asset: icon('asset', 16),
    check: icon('check', 15),
    checkCircle: icon('check-circle', 15),
    checkBig: icon('check', 30),
    x: icon('x', 15),
    refresh: icon('refresh', 15),
    clock: icon('clock', 14),
    columns: icon('columns', 15),
    code: icon('code', 15),
    alert: icon('alert', 16),
    shield: icon('shield', 16),
    keyboard: icon('keyboard', 14),
    inbox: icon('inbox', 26),
    arrowLeft: icon('arrowLeft', 15),
    arrowRight: icon('arrowRight', 15),
    chevronRight: icon('chevronRight', 14),
    chevronDown: icon('chevronDown', 14),
    sliders: icon('sliders', 15),
    sparkle: icon('sparkle', 15),
    search: icon('search', 18),
    activity: icon('activity', 18),
  })

  return `
const TOKEN = ${JSON.stringify(token)};
const ICON = ${iconLiterals};
const ACTIONABLE = ['awaiting-review', 'partially-applied', 'conflicted'];

const app = document.getElementById('app');
let runs = [];
let run = null;
let filter = 'pending';
let query = '';
let prefs = loadPrefs();
let busy = false;

function loadPrefs() {
  try {
    const saved = JSON.parse(localStorage.getItem('doxloop-review-prefs') || '{}');
    return { layout: saved.layout === 'unified' ? 'unified' : 'split', onlyChanges: !!saved.onlyChanges, source: !!saved.source };
  } catch (error) { return { layout: 'split', onlyChanges: false, source: false }; }
}
function savePrefs() { localStorage.setItem('doxloop-review-prefs', JSON.stringify(prefs)); }

function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]));
}

async function request(path, options) {
  const config = options || {};
  const response = await fetch(path, Object.assign({}, config, {
    headers: Object.assign({ 'content-type': 'application/json', 'x-doxloop-review-token': TOKEN }, config.headers || {}),
  }));
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || 'The review action failed.');
  return value;
}

/* ── Model helpers ── */

// Data files carry site configuration, never prose. Older proposals classified
// anything under the content directory as a page, so the guard stays here to
// keep those runs out of the page-by-page reading flow.
const DATA_FILE = /\\.(json|ya?ml|toml|ini|csv|lock)$/i;
function isPage(change) {
  return change.category === 'page' && !change.binary && !DATA_FILE.test(change.path);
}
function pagesOf(item) { return item.changes.filter(isPage); }
function supportingOf(item) { return item.changes.filter((change) => !isPage(change)); }
function pending(item) { return ACTIONABLE.indexOf(item.status) !== -1; }
function hunksOf(list) { return list.reduce((all, change) => all.concat(change.hunks), []); }
function settled(change) { return change.hunks.every((hunk) => hunk.acceptedAt || hunk.rejectedAt); }
function accepted(change) { return change.hunks.length > 0 && change.hunks.every((hunk) => hunk.acceptedAt); }
function openCount(change) { return change.hunks.filter((hunk) => !hunk.acceptedAt && !hunk.rejectedAt).length; }

function relativeTime(value) {
  const seconds = Math.max(0, (Date.now() - Date.parse(value)) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return Math.floor(seconds / 60) + ' min ago';
  if (seconds < 86400) return Math.floor(seconds / 3600) + ' h ago';
  return Math.floor(seconds / 86400) + ' d ago';
}
function label(value) { return String(value).replace(/-/g, ' '); }
function plural(count, one, many) { return count + ' ' + (count === 1 ? one : many); }

function generating(item) { return item.status === 'generating'; }

/** Machine wording like "3 proposed file changes" reads badly to a writer. */
function headline(item) {
  const pages = pagesOf(item).length;
  if (generating(item)) return 'Drafting a documentation update';
  if (item.status === 'failed') return 'This proposal could not be generated';
  if (pages === 0) return 'Supporting files need an update';
  return plural(pages, 'page needs', 'pages need') + ' an update';
}

/** "3 changed source files: M\\ta.js, M\\tb.js" -> "Because a.js and 2 other files changed". */
function reason(item) {
  const match = /^(\\d+) changed source files?: (.*)$/.exec(item.sourceSummary || '');
  if (!match) return item.sourceSummary || '';
  // The listed paths are truncated after twelve entries, so the count in the
  // summary is the total; counting the visible entries would under-report it.
  const total = Number(match[1]);
  // Git status letters are separated from the path by a tab, not a space.
  const first = match[2].split(', ')[0].replace(/^[A-Z]\\s+/, '').trim();
  if (total <= 1) return first + ' changed';
  return first + ' and ' + plural(total - 1, 'other file', 'other files') + ' changed';
}

/* ── Routing ── */

function go(path, replace) {
  if (replace) history.replaceState({}, '', path); else history.pushState({}, '', path);
  void render();
}
window.addEventListener('popstate', () => void render());

let pollTimer;
/** Re-read a run that is still being authored until it settles. */
function pollRun() {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(async () => {
    if (!run || !generating(run)) return;
    try {
      const next = await request('/api/runs/' + run.id);
      if (!run || next.id !== run.id) return;
      run = next;
      if (generating(run)) { pollRun(); return; }
      runs = await request('/api/runs').catch(() => runs);
      await render();
    } catch (error) { pollRun(); }
  }, 4000);
}

async function render() {
  const path = location.pathname;
  clearTimeout(pollTimer);
  closeMenus();
  if (path === '/' || path === '') { await screenList(); return; }
  const match = /^\\/runs\\/([a-z0-9-]+)(?:\\/pages\\/(\\d+)|\\/files\\/(change-\\d+)|\\/(done))?\\/?$/.exec(path);
  if (!match) { go('/', true); return; }
  try {
    if (!run || run.id !== match[1]) run = await request('/api/runs/' + match[1]);
  } catch (error) { showToast(error.message, 'error'); go('/', true); return; }
  if (match[4]) { screenDone(); return; }
  if (match[3]) { screenFile(match[3]); return; }
  if (match[2]) { screenFocus(Number(match[2])); return; }
  screenOverview();
}

/* ── Screen 1: proposals ── */

function sidebar() {
  return '<aside class="rv-sidebar">' +
    '<button class="rv-sidebar-logo" data-home aria-label="Doxloop review home"><img src="/brand/logo.png" alt="Doxloop"></button>' +
    '<div class="rv-sidebar-label">Review center</div><nav class="rv-nav" aria-label="Review center">' +
    '<button class="rv-nav-item is-active" data-home>' + ICON.page + '<span>Proposals</span></button>' +
    '<button class="rv-nav-item" data-activity>' + ICON.activity + '<span>Activity</span></button>' +
    '<button class="rv-nav-item" data-shortcuts>' + ICON.keyboard + '<span>Keyboard shortcuts</span></button>' +
    '</nav><div class="rv-sidebar-safe">' + ICON.shield + '<span><strong>Safe review mode</strong><span>Files stay unchanged</span></span></div></aside>';
}

function shell(inner) {
  return '<div class="rv-shell">' + sidebar() + '<main class="rv-main">' + inner + '</main></div>';
}

function appbar(inner) {
  return '<header class="rv-appbar">' + (inner || '<span class="rv-appbar-spacer"></span>') + '</header>';
}

async function screenList() {
  run = null;
  app.dataset.focusKey = '';
  app.innerHTML = shell(appbar('<label class="rv-appbar-search">' + ICON.search +
    '<input id="proposal-search" type="search" placeholder="Search proposals..." aria-label="Search proposals"></label>' +
    '<button class="rv-icon-btn" id="refresh" title="Refresh" aria-label="Refresh">' + ICON.refresh + '</button>') +
    '<div class="rv-scroll"><div class="rv-page"><div class="rv-page-head">' +
    '<div class="rv-page-head-copy"><h1>Proposals</h1><p class="rv-page-sub">Review documentation updates drafted from product changes. Nothing is written until you approve.</p></div>' +
    '<button class="rv-btn rv-btn--ghost rv-btn--sm" id="refresh-page">' + ICON.refresh + 'Refresh</button>' +
    '</div><div id="list-controls"><div class="rv-skeleton"></div></div><div id="list"><div class="rv-skeleton"></div></div><div id="activity"></div></div></div>');
  document.getElementById('refresh').addEventListener('click', reload);
  document.getElementById('refresh-page').addEventListener('click', reload);
  document.getElementById('proposal-search').addEventListener('input', (event) => { query = event.target.value.trim().toLowerCase(); paintList(); });
  try { runs = await request('/api/runs'); } catch (error) { showToast(error.message, 'error'); return; }
  if (runs.length > 0 && runs.filter(pending).length === 0) filter = 'all';
  paintList();
  if (location.hash === '#activity') requestAnimationFrame(() => document.getElementById('activity')?.scrollIntoView({ behavior: 'smooth' }));
}

function paintList() {
  const controls = document.getElementById('list-controls');
  if (!controls) return;
  const actionable = runs.filter(pending);
  const pages = actionable.reduce((count, item) => count + pagesOf(item).length, 0);
  const latest = runs[0];
  controls.innerHTML = '<div class="rv-metrics">' +
    metricHtml(ICON.page, 'Needs review', actionable.length, 'Awaiting your decision') +
    metricHtml(ICON.navigation, 'Pages impacted', pages, 'Across open proposals') +
    metricHtml(ICON.clock, 'Last generated', latest ? relativeTime(latest.createdAt).replace(/ ago$/, '') : '—', latest ? label(latest.trigger) + ' sync' : 'No proposals yet') +
    '</div>' +
    '<div class="rv-queue-head"><h2>Review queue</h2><span class="rv-count">' + actionable.length + '</span></div>' +
    (runs.length === 0 ? '' : '<div class="rv-segmented" role="group" aria-label="Filter proposals">' +
    '<button type="button" data-filter="pending"' + (filter === 'pending' ? ' class="is-active"' : '') + '>Needs review</button>' +
    '<button type="button" data-filter="all"' + (filter === 'all' ? ' class="is-active"' : '') + '>All</button></div>');
  controls.querySelectorAll('[data-filter]').forEach((button) => {
    button.addEventListener('click', () => { filter = button.dataset.filter; paintList(); });
  });

  const list = document.getElementById('list');
  const visible = runs.filter((item) => (filter === 'all' || pending(item)) && (!query || (headline(item) + ' ' + reason(item) + ' ' + label(item.status)).toLowerCase().includes(query)));
  if (runs.length === 0) {
    list.innerHTML = '<div class="rv-empty"><span class="rv-empty-icon">' + ICON.inbox + '</span>' +
      '<h2>No proposals yet</h2><p>Run <code>doxloop sync now</code> to check your documentation against the product and draft an update.</p></div>';
    paintActivity(); return;
  }
  if (visible.length === 0) {
    list.innerHTML = '<div class="rv-empty"><span class="rv-empty-icon">' + ICON.checkCircle + '</span>' +
      (query ? '<h2>No matching proposals</h2><p>Try a different search term or clear the search.</p>' : '<h2>Nothing is waiting for you</h2><p>Every proposal has been reviewed. Switch to <strong>All</strong> to look back over the history.</p>') + '</div>';
    paintActivity(); return;
  }
  list.innerHTML = '<div class="rv-cards">' + visible.map(cardHtml).join('') + '</div>';
  list.querySelectorAll('[data-run]').forEach((card) => {
    card.addEventListener('click', () => go('/runs/' + card.dataset.run));
  });
  paintActivity();
}

function metricHtml(iconSvg, title, value, note) {
  return '<div class="rv-metric"><span class="rv-metric-icon">' + iconSvg + '</span><span class="rv-metric-copy">' +
    '<span class="rv-metric-label">' + esc(title) + '</span><strong class="rv-metric-value">' + esc(value) + '</strong><span class="rv-metric-note">' + esc(note) + '</span></span></div>';
}

function paintActivity() {
  const target = document.getElementById('activity');
  if (!target) return;
  const history = runs.filter((item) => !pending(item) && !generating(item)).slice(0, 4);
  if (history.length === 0) { target.innerHTML = ''; return; }
  target.innerHTML = '<section class="rv-activity"><h2>Recent activity</h2>' +
    '<div class="rv-activity-row rv-activity-row--head"><span>Proposal</span><span>Status</span><span>Created</span></div>' +
    history.map((item) => '<button class="rv-activity-row" data-run="' + esc(item.id) + '" style="width:100%;border-inline:0;border-bottom:0;background:#fff;text-align:left;font:inherit;cursor:pointer">' +
      '<span>' + esc(headline(item).replace(' need an update', ' updated').replace(' needs an update', ' updated')) + '</span>' +
      '<span class="rv-pill rv-pill--' + esc(item.status) + '">' + esc(label(item.status)) + '</span><span>' + esc(relativeTime(item.createdAt)) + '</span></button>').join('') + '</section>';
  target.querySelectorAll('[data-run]').forEach((row) => row.addEventListener('click', () => go('/runs/' + row.dataset.run)));
}

function cardHtml(item) {
  const done = hunksOf(item.changes).filter((hunk) => hunk.acceptedAt).length;
  const open = pending(item);
  const pages = pagesOf(item).length;
  const navigation = item.changes.filter((change) => change.category === 'navigation').length;
  const configuration = item.changes.filter((change) => change.category === 'configuration').length;
  const detail = generating(item)
    ? item.summary + ' · ' + reason(item)
    : open
    ? reason(item)
    : item.status === 'applied' ? plural(done, 'change was', 'changes were') + ' applied to your documentation'
    : item.status === 'rejected' ? 'Rejected — nothing was written'
    : item.error ? item.error : reason(item);
  return '<button class="rv-card" data-run="' + esc(item.id) + '">' +
    '<span class="rv-card-top"><span class="rv-dot rv-dot--' + esc(item.status) + '"></span>' +
    '<span class="rv-pill rv-pill--' + esc(item.status) + '">' + esc(label(item.status)) + '</span>' +
    '<span class="rv-card-meta">' + esc(label(item.trigger)) + ' · ' + esc(relativeTime(item.createdAt)) + '</span></span>' +
    '<h2>' + esc(headline(item)) + '</h2>' +
    '<p class="rv-card-why">' + esc(detail) + '</p>' +
    '<span class="rv-card-foot">' +
    '<span class="rv-card-fact">' + ICON.page + plural(pages, 'page', 'pages') + '</span>' +
    (navigation ? '<span class="rv-card-fact">' + ICON.navigation + plural(navigation, 'navigation', 'navigation') + '</span>' : '') +
    (configuration ? '<span class="rv-card-fact">' + ICON.configuration + plural(configuration, 'configuration', 'configurations') + '</span>' : '') +
    (item.validation && item.validation.errors === 0 ? '<span class="rv-card-fact rv-card-fact--ok">' + ICON.checkCircle + 'Validation passed</span>' : '') +
    '<span class="rv-card-cta">' +
    (generating(item) ? '<span class="rv-spinner rv-spinner--sm"></span>In progress' : (open ? 'Review proposal' : 'View proposal') + ICON.arrowRight) +
    '</span></span></button>';
}

/* ── Screen 2: proposal overview ── */

function screenOverview() {
  app.dataset.focusKey = '';
  const pages = pagesOf(run);
  const support = supportingOf(run);
  const open = pending(run);
  const nextIndex = firstOpenPage();
  const validation = run.validation;

  // A run that is still being authored has no changes yet; saying "nothing
  // changed" would be wrong, so the screen reports that it is still working.
  if (generating(run)) {
    app.innerHTML = shell(appbar('<button class="rv-back" data-home>' + ICON.arrowLeft + 'Back to proposals</button><span class="rv-appbar-spacer"></span>' +
      '<button class="rv-icon-btn" data-shortcuts title="Keyboard shortcuts">' + ICON.keyboard + '</button>') +
      '<div class="rv-scroll"><div class="rv-page">' +
      '<div class="rv-page-head"><span class="rv-eyebrow">' + esc(label(run.trigger)) + ' · ' + esc(relativeTime(run.createdAt)) + '</span>' +
      '<h1>' + esc(headline(run)) + '</h1></div>' +
      '<div class="rv-why"><span class="rv-why-icon">' + ICON.sparkle + '</span><span class="rv-why-body">' +
      '<strong>' + esc(reason(run)) + '</strong><code>' + esc(run.sourceSummary || '') + '</code></span></div>' +
      '<div class="rv-working"><span class="rv-spinner"></span><span class="rv-working-body">' +
      '<strong>Doxloop is writing the update</strong>' +
      '<span>' + esc(run.summary) + '. Your documentation stays untouched while this runs, and the pages appear here as soon as the draft is ready.</span>' +
      '</span></div>' +
      '</div></div>');
    pollRun();
    return;
  }

  const rows = pages.length === 0
    ? '<div class="rv-empty" style="padding:34px 20px"><p>No page content changed in this proposal.</p></div>'
    : '<div class="rv-rows">' + pages.map((change, index) => {
        const state = accepted(change) ? '<span class="rv-chip rv-chip--accepted">' + ICON.check + 'Accepted</span>'
          : settled(change) ? '<span class="rv-chip">Resolved</span>'
          : '<span class="rv-chip rv-chip--pending">' + plural(openCount(change), 'change', 'changes') + '</span>';
        return '<button class="rv-row" data-page="' + (index + 1) + '">' +
          '<span class="rv-row-icon">' + ICON.page + '</span>' +
          '<span class="rv-row-body"><span class="rv-row-title">' + esc(change.title) + '</span>' +
          '<span class="rv-row-path">' + esc(change.path) + '</span></span>' +
          '<span class="rv-row-right">' + state + ICON.chevronRight + '</span></button>';
      }).join('') + '</div>';

  const supportBlock = support.length === 0 ? '' :
    '<details class="rv-summary-support"><summary><strong>' + plural(support.length, 'supporting file', 'supporting files') + '</strong>' + ICON.chevronRight + '</summary>' +
    '<div class="rv-rows">' +
    support.map((change) => '<button class="rv-row" data-support="' + esc(change.id) + '">' +
      '<span class="rv-row-icon">' + (ICON[change.category] || ICON.configuration) + '</span>' +
      '<span class="rv-row-body"><span class="rv-row-title">' + esc(change.title) + '</span>' +
      '<span class="rv-row-path">' + esc(change.path) + '</span></span>' +
      '<span class="rv-row-right">' + (accepted(change) ? '<span class="rv-chip rv-chip--accepted">' + ICON.check + 'Applied</span>' : ICON.chevronRight) + '</span></button>').join('') +
    '</div></details>';

  app.innerHTML = shell(appbar('<button class="rv-back" data-home>' + ICON.arrowLeft + 'Back to proposals</button><span class="rv-appbar-spacer"></span>' +
    '<button class="rv-icon-btn" data-shortcuts title="Keyboard shortcuts" aria-label="Keyboard shortcuts">' + ICON.keyboard + '</button>' +
    '<button class="rv-icon-btn" id="refresh" title="Refresh" aria-label="Refresh">' + ICON.refresh + '</button>') +
    '<div class="rv-scroll"><div class="rv-page">' +
    '<div class="rv-overview-head"><span class="rv-eyebrow">' + esc(label(run.trigger)) + ' &nbsp;·&nbsp; ' + esc(relativeTime(run.createdAt)) + '</span>' +
    '<h1>' + esc(headline(run)) + '</h1>' +
    '<div class="rv-meta-row"><span class="rv-pill rv-pill--' + esc(run.status) + '">' + esc(label(run.status)) + '</span>' +
    (validation ? '<span class="rv-sep">·</span>' + (validation.errors > 0
      ? '<span style="color:var(--danger-strong);font-weight:600">' + plural(validation.errors, 'validation error', 'validation errors') + '</span>'
      : '<span class="rv-meta-ok">' + ICON.check + 'Validates cleanly</span>') : '') +
    '</div></div>' +
    (run.error ? '<div class="rv-banner rv-banner--error">' + ICON.alert + '<span>' + esc(run.error) + '</span></div>' : '') +
    '<div class="rv-overview-grid"><div class="rv-section"><div class="rv-section-title">Pages to review <span class="rv-count">' + pages.length + '</span></div>' + rows + '</div>' +
    '<aside><div class="rv-summary"><h2>Proposal summary</h2>' +
    '<div class="rv-summary-why"><span class="rv-why-icon">' + ICON.sparkle + '</span><span><span class="rv-summary-label">Why this proposal</span><strong>' + esc(reason(run)) + '</strong></span></div>' +
    '<div class="rv-summary-stats"><div class="rv-summary-stat"><span>Pages</span><strong>' + pages.length + '</strong></div>' +
    '<div class="rv-summary-stat"><span>Source files</span><strong>' + (String(run.sourceSummary || '').match(/^\d+/) || [support.length])[0] + '</strong></div>' +
    '<div class="rv-summary-stat"><span>Validation</span><strong class="' + (validation && validation.errors === 0 ? 'is-success' : '') + '">' + (validation ? validation.errors === 0 ? 'Passed' : plural(validation.errors, 'error', 'errors') : 'Not run') + '</strong></div></div>' +
    supportBlock +
    (support.length ? '<p class="rv-summary-note">Updated automatically after every page is accepted.</p>' : '') +
    (open ? '<div class="rv-summary-actions">' +
      (nextIndex > 0 ? '<button class="rv-btn rv-btn--primary" id="start">' + (firstOpenPage() === 1 && pages.every((change) => !settled(change)) ? 'Start review' : 'Continue review') + ICON.arrowRight + '</button>' : '<button class="rv-btn rv-btn--primary" id="accept-all-only">Apply supporting updates</button>') +
      (pages.length > 0 ? '<button class="rv-btn rv-btn--ghost" id="accept-all">Accept all</button>' : '') +
      '<button class="rv-btn rv-btn--quiet" id="reject">Reject proposal</button></div>' : '') +
    '</div><div class="rv-safe-note">' + ICON.shield + '<span>Nothing is written until you approve.</span></div></aside></div>' +
    '</div></div>');

  app.querySelectorAll('[data-page]').forEach((row) => {
    row.addEventListener('click', () => go('/runs/' + run.id + '/pages/' + row.dataset.page));
  });
  app.querySelectorAll('[data-support]').forEach((row) => {
    row.addEventListener('click', () => go('/runs/' + run.id + '/files/' + row.dataset.support));
  });
  const start = document.getElementById('start');
  if (start) start.addEventListener('click', () => go('/runs/' + run.id + '/pages/' + firstOpenPage()));
  const acceptAll = document.getElementById('accept-all') || document.getElementById('accept-all-only');
  if (acceptAll) acceptAll.addEventListener('click', () => void acceptEverything());
  const reject = document.getElementById('reject');
  if (reject) reject.addEventListener('click', () => void rejectRun());
  document.getElementById('refresh').addEventListener('click', reload);
}

function firstOpenPage() {
  const pages = pagesOf(run);
  const index = pages.findIndex((change) => !settled(change));
  return index === -1 ? (pages.length > 0 ? pages.length : 0) : index + 1;
}

/* ── Screen 3: one page at a time ── */

function screenFocus(index) {
  const pages = pagesOf(run);
  if (pages.length === 0) { go('/runs/' + run.id, true); return; }
  const position = Math.min(Math.max(1, index), pages.length);
  if (position !== index) { go('/runs/' + run.id + '/pages/' + position, true); return; }
  const change = pages[position - 1];
  const open = pending(run) && !settled(change);
  const key = [run.id, change.id, prefs.source ? 'src' : 'doc', change.hunks.filter((hunk) => hunk.acceptedAt).length].join('|');

  if (app.dataset.focusKey !== key) {
    app.dataset.focusKey = key;
    // One bar above the comparison: where you are, which page, how to view it.
    app.innerHTML = shell(appbar(
      '<button class="rv-back" data-overview>' + ICON.arrowLeft + 'Proposal</button>' +
      '<span class="rv-appbar-divider"></span>' +
      '<span class="rv-menu-wrap"><button class="rv-title-btn" data-menu="pages" aria-haspopup="true">' +
      '<strong>' + esc(change.title) + '</strong>' + ICON.chevronDown + '</button></span>' +
      '<span class="rv-counter">Page ' + position + ' of ' + pages.length + '</span>' +
      '<span class="rv-appbar-spacer"></span>' +
      '<span class="rv-menu-wrap"><button class="rv-btn rv-btn--ghost rv-btn--sm" data-menu="view" aria-haspopup="true">' +
      ICON.sliders + 'View' + ICON.chevronDown + '</button></span>' +
      '<button class="rv-icon-btn" data-shortcuts title="Keyboard shortcuts" aria-label="Keyboard shortcuts">' + ICON.keyboard + '</button>') +
      '<div class="rv-focus">' +
      '<div class="rv-stage">' +
      (prefs.source
        ? '<div class="rv-source" id="source"><div class="rv-skeleton"></div></div>'
        : '<iframe id="preview" title="The current page beside the proposed update" src="' + previewSrc(change) + '"></iframe>') +
      '</div>' +
      '<div class="rv-focus-foot" id="focus-foot"></div></div>');
    if (prefs.source) void paintSource(change);
  }
  paintFocusFoot(change, position, pages, open);
  wireFocus(change, position, pages);
}

function previewSrc(change) {
  return '/preview/' + run.id + '/' + change.id +
    '?layout=' + prefs.layout + (prefs.onlyChanges ? '&only=1' : '') + '&v=' + Date.now();
}

function paintFocusFoot(change, position, pages, open) {
  const foot = document.getElementById('focus-foot');
  if (!foot) return;
  const dots = pages.map((entry, index) => '<span class="rv-pdot' +
    (index + 1 === position ? ' rv-pdot--current' : accepted(entry) ? ' rv-pdot--done' : '') + '"></span>').join('');
  const count = openCount(change);
  foot.innerHTML = '<span class="rv-progress-dots">' + dots + '</span>' +
    '<span class="rv-foot-count">' +
    (count > 0
      ? '<button class="rv-link" data-source>' + plural(count, 'change', 'changes') + ' on this page</button>'
      : '<button class="rv-link" data-source>See the source diff</button>') +
    '</span>' +
    '<span class="rv-foot-actions">' +
    (open
      ? '<button class="rv-btn rv-btn--ghost rv-btn--sm" data-skip>Skip for now</button>' +
        '<button class="rv-btn rv-btn--primary" data-accept>Accept page' + ICON.arrowRight + '</button>'
      : '<span class="rv-applied-note">' + (accepted(change) ? ICON.check + 'Applied' : 'No pending changes') + '</span>' +
        (position < pages.length ? '<button class="rv-btn rv-btn--ghost rv-btn--sm" data-next>Next page' + ICON.arrowRight + '</button>'
          : '<button class="rv-btn rv-btn--ghost rv-btn--sm" data-overview>Back to proposal</button>')) +
    '</span>';
}

function wireFocus(change, position, pages) {
  app.querySelectorAll('[data-overview]').forEach((button) => {
    button.addEventListener('click', () => go('/runs/' + run.id));
  });
  const shortcuts = app.querySelector('[data-shortcuts]');
  if (shortcuts) shortcuts.addEventListener('click', () => { document.getElementById('overlay').hidden = false; });
  const skip = app.querySelector('[data-skip]');
  if (skip) skip.addEventListener('click', () => advance(position, pages));
  const next = app.querySelector('[data-next]');
  if (next) next.addEventListener('click', () => advance(position, pages));
  const accept = app.querySelector('[data-accept]');
  if (accept) accept.addEventListener('click', () => void acceptPage(change, position, pages));
  const source = app.querySelector('[data-source]');
  if (source) source.addEventListener('click', () => toggleSource());

  app.querySelectorAll('[data-menu]').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      const wrap = button.parentElement;
      const isOpen = wrap.querySelector('.rv-menu');
      closeMenus();
      if (isOpen) return;
      wrap.insertAdjacentHTML('beforeend', button.dataset.menu === 'pages' ? pagesMenu(pages, position) : viewMenu());
      wrap.querySelectorAll('[data-goto]').forEach((item) => {
        item.addEventListener('click', () => go('/runs/' + run.id + '/pages/' + item.dataset.goto));
      });
      wrap.querySelectorAll('[data-pref]').forEach((item) => {
        item.addEventListener('click', () => {
          const [name, value] = item.dataset.pref.split(':');
          if (name === 'layout') prefs.layout = value;
          if (name === 'only') prefs.onlyChanges = !prefs.onlyChanges;
          if (name === 'source') prefs.source = !prefs.source;
          savePrefs();
          closeMenus();
          app.dataset.focusKey = '';
          void render();
        });
      });
    });
  });
}

function pagesMenu(pages, position) {
  return '<div class="rv-menu"><div class="rv-menu-label">Pages in this proposal</div>' +
    pages.map((change, index) => '<button class="rv-menu-item' + (index + 1 === position ? ' is-active' : '') +
      '" data-goto="' + (index + 1) + '">' + ICON.page + '<span>' + esc(change.title) +
      '<small>' + (accepted(change) ? 'Accepted' : plural(openCount(change), 'change', 'changes')) + '</small></span>' +
      (index + 1 === position ? '<span class="rv-menu-check">' + ICON.check + '</span>' : '') + '</button>').join('') +
    '</div>';
}

function viewMenu() {
  const tick = '<span class="rv-menu-check">' + ICON.check + '</span>';
  return '<div class="rv-menu rv-menu--right"><div class="rv-menu-label">Layout</div>' +
    '<button class="rv-menu-item' + (prefs.layout === 'split' ? ' is-active' : '') + '" data-pref="layout:split">' + ICON.columns + '<span>Side by side</span>' + (prefs.layout === 'split' ? tick : '') + '</button>' +
    '<button class="rv-menu-item' + (prefs.layout === 'unified' ? ' is-active' : '') + '" data-pref="layout:unified">' + ICON.page + '<span>Stacked</span>' + (prefs.layout === 'unified' ? tick : '') + '</button>' +
    '<div class="rv-menu-sep"></div>' +
    '<button class="rv-menu-item' + (prefs.onlyChanges ? ' is-active' : '') + '" data-pref="only:toggle">' + ICON.sparkle + '<span>Only the changes</span>' + (prefs.onlyChanges ? tick : '') + '</button>' +
    '<div class="rv-menu-sep"></div>' +
    '<button class="rv-menu-item' + (prefs.source ? ' is-active' : '') + '" data-pref="source:toggle">' + ICON.code + '<span>' + (prefs.source ? 'Rendered comparison' : 'Source diff') + '<small>' + (prefs.source ? 'Read it as a finished page' : 'Line by line, accept one change at a time') + '</small></span></button>' +
    '</div>';
}

function toggleSource() {
  prefs.source = !prefs.source;
  savePrefs();
  app.dataset.focusKey = '';
  void render();
}

function closeMenus() { document.querySelectorAll('.rv-menu').forEach((menu) => menu.remove()); }
document.addEventListener('click', closeMenus);

async function paintSource(change) {
  const target = document.getElementById('source');
  if (!target) return;
  let diff;
  try { diff = await request('/api/runs/' + run.id + '/changes/' + change.id + '/diff'); }
  catch (error) { target.innerHTML = '<div class="rv-banner rv-banner--error">' + ICON.alert + '<span>' + esc(error.message) + '</span></div>'; return; }
  if (!document.getElementById('source')) return;

  if (diff.binary) {
    target.innerHTML = '<div class="rv-hint">' + ICON.sparkle + '<span>This is a binary asset, so there is no line-by-line diff.</span></div>';
    return;
  }
  const groups = [];
  diff.rows.forEach((row) => {
    const last = groups[groups.length - 1];
    if (row.hunkId && last && last.hunkId === row.hunkId) { last.rows.push(row); return; }
    if (!row.hunkId && last && !last.hunkId) { last.rows.push(row); return; }
    groups.push({ hunkId: row.hunkId, state: row.hunkState, rows: [row] });
  });
  let number = 0;
  const body = groups.map((group) => {
    const lines = group.rows.map(lineHtml).join('');
    if (!group.hunkId) return '<div class="rv-hunk"><div class="rv-lines">' + lines + '</div></div>';
    number += 1;
    const first = group.rows[0];
    const actionable = pending(run) && group.state === 'pending';
    return '<div class="rv-hunk rv-hunk--' + esc(group.state) + '"><div class="rv-hunk-head">' +
      '<span class="rv-hunk-title">Change ' + number + '</span>' +
      '<span class="rv-hunk-lines">line ' + (first.oldNumber || first.newNumber || 1) + '</span>' +
      '<span class="rv-hunk-actions">' +
      (actionable ? '<button class="rv-btn rv-btn--accept rv-btn--sm" data-hunk="' + esc(group.hunkId) + '">' + ICON.check + 'Accept</button>'
        : '<span class="rv-hunk-state rv-hunk-state--' + esc(group.state) + '">' +
          (group.state === 'accepted' ? ICON.check + 'Accepted' : group.state === 'rejected' ? ICON.x + 'Rejected' : '') + '</span>') +
      '</span></div><div class="rv-lines">' + lines + '</div></div>';
  }).join('');

  target.innerHTML = '<div class="rv-hint">' + ICON.sparkle + '<span>' +
    plural(diff.added, 'line', 'lines') + ' added and ' + plural(diff.removed, 'line', 'lines') +
    ' removed. Accept changes one at a time here' +
    (isPage(change) ? ', or switch back to the rendered comparison from the View menu.' : '.') +
    '</span></div>' + body;
  target.querySelectorAll('[data-hunk]').forEach((button) => {
    button.addEventListener('click', () => void acceptHunk(change, button.dataset.hunk));
  });
}

function lineHtml(row) {
  if (row.type === 'gap') {
    return '<div class="rv-line rv-line--gap"><span>⋯</span><span>' + plural(row.hidden, 'unchanged line', 'unchanged lines') + '</span></div>';
  }
  const sign = row.type === 'insert' ? '+' : row.type === 'delete' ? '−' : '';
  return '<div class="rv-line rv-line--' + row.type + '">' +
    '<span class="rv-line-num">' + (row.oldNumber || '') + '</span>' +
    '<span class="rv-line-num">' + (row.newNumber || '') + '</span>' +
    '<span class="rv-line-sign">' + sign + '</span>' +
    '<span class="rv-line-code">' + (row.html || ' ') + '</span></div>';
}

/* ── Supporting file: source diff only, reached from the overview ── */

function screenFile(changeId) {
  const change = run.changes.find((entry) => entry.id === changeId);
  if (!change) { go('/runs/' + run.id, true); return; }
  const key = ['file', run.id, change.id, change.hunks.filter((hunk) => hunk.acceptedAt).length].join('|');
  if (app.dataset.focusKey === key) return;
  app.dataset.focusKey = key;

  app.innerHTML = shell(appbar(
    '<button class="rv-back" data-overview>' + ICON.arrowLeft + 'Proposal</button>' +
    '<span class="rv-appbar-divider"></span>' +
    '<span class="rv-appbar-title"><strong>' + esc(change.title) + '</strong><span>' + esc(change.path) + '</span></span>' +
    '<span class="rv-appbar-spacer"></span>') +
    '<div class="rv-focus"><div class="rv-focus-bar">' +
    '<span class="rv-chip">' + esc(label(change.category)) + '</span>' +
    '<span class="rv-foot-count">Supporting file — Doxloop keeps this in step with your pages.</span>' +
    '<span class="rv-appbar-spacer"></span>' +
    (pending(run) && openCount(change) > 0
      ? '<button class="rv-btn rv-btn--ghost rv-btn--sm" data-accept-file>' + ICON.check + 'Apply now</button>'
      : '<span class="rv-applied-note">' + (accepted(change) ? ICON.check + 'Applied' : 'No pending changes') + '</span>') +
    '</div><div class="rv-stage"><div class="rv-source" id="source"><div class="rv-skeleton"></div></div></div></div>');

  app.querySelectorAll('[data-overview]').forEach((button) => {
    button.addEventListener('click', () => go('/runs/' + run.id));
  });
  const apply = app.querySelector('[data-accept-file]');
  if (apply) apply.addEventListener('click', () => void acceptSupporting(change));
  void paintSource(change);
}

async function acceptSupporting(change) {
  if (busy) return;
  busy = true;
  try {
    run = await request('/api/runs/' + run.id + '/accept', { method: 'POST', body: JSON.stringify({ scope: 'page', changeId: change.id }) });
    showToast(change.title + ' was applied and validated.', 'success');
  } catch (error) { showToast(error.message, 'error'); }
  busy = false;
  app.dataset.focusKey = '';
  await render();
}

/* ── Screen 4: done ── */

function screenDone() {
  app.dataset.focusKey = '';
  const pages = pagesOf(run);
  const done = pages.filter(accepted);
  const waiting = pages.filter((change) => !settled(change));
  const support = supportingOf(run);
  const supportDone = support.filter(accepted).length;

  // Nothing was written, so nothing is celebrated.
  const nothingDone = done.length === 0;
  app.innerHTML = shell(appbar('<button class="rv-back" data-home>' + ICON.arrowLeft + 'Proposals</button><span class="rv-appbar-spacer"></span>') +
    '<div class="rv-scroll"><div class="rv-page"><div class="rv-done">' +
    '<span class="rv-done-mark' + (nothingDone ? ' rv-done-mark--neutral' : '') + '">' + (nothingDone ? ICON.inbox : ICON.checkBig) + '</span>' +
    '<h1>' + (waiting.length === 0 ? 'All set' : nothingDone ? 'Nothing applied yet' : 'Progress saved') + '</h1>' +
    '<p>' + plural(done.length, 'page was', 'pages were') + ' updated and validated' +
    (supportDone > 0 ? ', along with ' + plural(supportDone, 'supporting file', 'supporting files') : '') + '.' +
    (waiting.length > 0 ? ' ' + plural(waiting.length, 'page is', 'pages are') + ' still waiting for a decision.' : '') + '</p>' +
    '<div class="rv-done-actions">' +
    (waiting.length > 0 ? '<button class="rv-btn rv-btn--primary" id="resume">Review the remaining ' + (waiting.length === 1 ? 'page' : 'pages') + ICON.arrowRight + '</button>' : '') +
    '<button class="rv-btn ' + (waiting.length > 0 ? 'rv-btn--ghost' : 'rv-btn--primary') + '" data-home>Back to proposals</button>' +
    '</div>' +
    (waiting.length > 0 && support.length > 0 && supportDone === 0
      ? '<div class="rv-banner rv-banner--warn" style="max-width:520px">' + ICON.alert +
        '<span>' + plural(support.length, 'supporting file', 'supporting files') + ' will be updated once every page is accepted.</span></div>' : '') +
    '</div></div></div>');
  const resume = document.getElementById('resume');
  if (resume) resume.addEventListener('click', () => go('/runs/' + run.id + '/pages/' + firstOpenPage()));
}

/* ── Actions ── */

function advance(position, pages) {
  if (position < pages.length) { go('/runs/' + run.id + '/pages/' + (position + 1)); return; }
  go('/runs/' + run.id + '/done');
}

async function acceptPage(change, position, pages) {
  if (busy) return;
  busy = true;
  try {
    showToast('Applying ' + change.title + '…');
    run = await request('/api/runs/' + run.id + '/accept', { method: 'POST', body: JSON.stringify({ scope: 'page', changeId: change.id }) });
    // Supporting files carry the bookkeeping for the pages; they are written
    // once every page in the proposal has been accepted.
    if (pagesOf(run).every(accepted) && supportingOf(run).some((entry) => openCount(entry) > 0)) {
      run = await request('/api/runs/' + run.id + '/accept', { method: 'POST', body: JSON.stringify({ scope: 'all' }) });
    }
    showToast(change.title + ' was applied and validated.', 'success');
    busy = false;
    app.dataset.focusKey = '';
    advance(position, pages);
  } catch (error) {
    busy = false;
    showToast(error.message, 'error');
    await reload();
  }
}

async function acceptHunk(change, hunkId) {
  if (busy) return;
  busy = true;
  try {
    run = await request('/api/runs/' + run.id + '/accept', { method: 'POST', body: JSON.stringify({ scope: 'hunk', changeId: change.id, hunkId: hunkId }) });
    if (pagesOf(run).every(accepted) && supportingOf(run).some((entry) => openCount(entry) > 0)) {
      run = await request('/api/runs/' + run.id + '/accept', { method: 'POST', body: JSON.stringify({ scope: 'all' }) });
    }
    showToast('The change was applied and validated.', 'success');
  } catch (error) { showToast(error.message, 'error'); }
  busy = false;
  app.dataset.focusKey = '';
  await render();
}

async function acceptEverything() {
  if (busy) return;
  if (!confirm('Apply every remaining change in this proposal to your documentation?')) return;
  busy = true;
  try {
    showToast('Applying every remaining change…');
    run = await request('/api/runs/' + run.id + '/accept', { method: 'POST', body: JSON.stringify({ scope: 'all' }) });
    showToast('The proposal was applied and validated.', 'success');
    busy = false;
    go('/runs/' + run.id + '/done');
  } catch (error) {
    busy = false;
    showToast(error.message, 'error');
    await reload();
  }
}

async function rejectRun() {
  if (!confirm('Reject this proposal? Nothing will be written to your documentation.')) return;
  try {
    run = await request('/api/runs/' + run.id + '/reject', { method: 'POST', body: '{}' });
    showToast('The proposal was rejected. No documentation was changed.', 'success');
    go('/');
  } catch (error) { showToast(error.message, 'error'); }
}

async function reload() {
  const button = document.getElementById('refresh');
  if (button) button.classList.add('is-busy');
  try {
    runs = await request('/api/runs');
    if (run) run = await request('/api/runs/' + run.id);
    app.dataset.focusKey = '';
    await render();
  } catch (error) { showToast(error.message, 'error'); }
  if (button) button.classList.remove('is-busy');
}

let toastTimer;
function showToast(message, tone) {
  const toast = document.getElementById('toast');
  toast.innerHTML = (tone === 'success' ? ICON.checkCircle : tone === 'error' ? ICON.alert : '') + '<span>' + esc(message) + '</span>';
  toast.className = 'rv-toast is-visible' + (tone ? ' rv-toast--' + tone : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.className = 'rv-toast'; }, tone === 'error' ? 8000 : 3400);
}

/* ── Global wiring ── */

document.addEventListener('click', (event) => {
  const home = event.target.closest('[data-home]');
  if (home) { event.preventDefault(); go('/'); }
  const activity = event.target.closest('[data-activity]');
  if (activity) {
    event.preventDefault(); filter = 'all';
    if (location.pathname === '/') { paintList(); document.getElementById('activity')?.scrollIntoView({ behavior: 'smooth' }); }
    else go('/#activity');
  }
  const shortcuts = event.target.closest('[data-shortcuts]');
  if (shortcuts) document.getElementById('overlay').hidden = false;
  const close = event.target.closest('[data-close]');
  if (close || event.target === document.getElementById('overlay')) document.getElementById('overlay').hidden = true;
});

document.addEventListener('keydown', (event) => {
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  const tag = document.activeElement ? document.activeElement.tagName : '';
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;
  const overlay = document.getElementById('overlay');
  if (event.key === '?') { overlay.hidden = !overlay.hidden; return; }
  if (event.key === 'Escape') {
    // Escape dismisses whatever is open before it navigates anywhere.
    if (!overlay.hidden) { overlay.hidden = true; return; }
    if (document.querySelector('.rv-menu')) { closeMenus(); return; }
    if (run && /\\/(pages|files)\\//.test(location.pathname)) go('/runs/' + run.id);
    return;
  }
  const match = /^\\/runs\\/([a-z0-9-]+)\\/pages\\/(\\d+)$/.exec(location.pathname);
  if (!match || !run) return;
  const pages = pagesOf(run);
  const position = Number(match[2]);
  const change = pages[position - 1];
  if (!change) return;
  if (event.key === 'ArrowRight') { if (position < pages.length) go('/runs/' + run.id + '/pages/' + (position + 1)); return; }
  if (event.key === 'ArrowLeft') { if (position > 1) go('/runs/' + run.id + '/pages/' + (position - 1)); return; }
  if (event.key === 'd') { toggleSource(); return; }
  if (event.key === 's') { advance(position, pages); return; }
  if ((event.key === 'a' || event.key === 'Enter') && pending(run) && !settled(change)) {
    event.preventDefault();
    void acceptPage(change, position, pages);
  }
});

void render();
  `
}
