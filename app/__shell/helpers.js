// Shell-side helpers exposed to any XMLUI app served by Bram
// binary. Include from your project's index.html with:
//
//   <script src="tauri://localhost/__shell/helpers.js"></script>
//
// Both iframes (right pane and agent-tools drawer) are same-origin with
// the parent shell at tauri://localhost, so these helpers call Tauri IPC
// directly via window.parent.__TAURI__.core.invoke. `getTauriInvoke()`
// formalizes the lookup with a window.__TAURI__ → window.parent → window.top
// fallback chain. The legacy postMessage bridge to app/main.js has been
// retired; voice recording (voiceStart / voiceStop) is the one remaining
// exception, because the parent shell owns the MediaRecorder pipeline.

window._xsLogs = window._xsLogs || [];

// ResizeObserver flood detector (diagnostic, #150 startup unresponsiveness).
// The browser logs "ResizeObserver loop completed with undelivered
// notifications" but names no culprit. We wrap the constructor (class extends
// so observe/disconnect/instanceof keep working natively; we only intercept
// the callback to count fires) and, once per second while the global fire rate
// exceeds a flood threshold, log to bram-trace WHICH element(s) are looping.
// Loaded before xmlui-standalone (tools/index.html), so it wraps every XMLUI
// Splitter/layout observer. Remove once the flood source is identified.
(function installResizeObserverFloodDetector() {
  var Native = window.ResizeObserver;
  if (!Native || Native.__bramFloodWrapped) return;
  var FLOOD_PER_SEC = 50;
  var RING_MAX = 60;
  var total = 0;
  var counts = Object.create(null);
  // Identity + geometry ring (ro-flood-identity-ring-buffer): the flood
  // line alone cannot distinguish (a) one row oscillating between two
  // heights, (b) many rows re-measuring under container size churn, or
  // (c) rows remounting — observe() fires one initial notification per
  // new element, so a remount loop floods the counter with zero real
  // resizes. Each fire records element identity (data-index, seen-before)
  // and contentRect geometry; the detail line dumps the ring when the
  // flood threshold trips.
  var seen = typeof WeakSet === "function" ? new WeakSet() : null;
  var newElements = 0;
  var repeatFires = 0;
  var ring = [];
  var lastFireMs = 0;
  // Sync in-callback dump (ro-flood-sync-dump): the interval dump below
  // requires the main thread to yield, so a non-converging RO loop — the
  // terminal-freeze variant, e.g. 2026-07-11T17:07 (last iframe line, then
  // 53 min of silence) — dies without testifying. firesSinceTick is reset
  // by every interval tick; if it reaches SYNC_BURST_FIRES the thread has
  // NOT yielded through a whole flooding second, and we emit the detail
  // line directly from the callback via logToHost → invoke, whose IPC
  // dispatch the host logs even if the iframe never yields again (the
  // describe-patch precedent).
  var SYNC_BURST_FIRES = 120;
  var SYNC_MIN_GAP_MS = 2000;
  var firesSinceTick = 0;
  var lastSyncDumpMs = 0;
  function describe(el) {
    try {
      if (!el || el.nodeType !== 1) return String(el);
      var id = el.id ? "#" + el.id : "";
      var cls = (typeof el.className === "string" && el.className.trim())
        ? "." + el.className.trim().split(/\s+/).slice(0, 2).join(".")
        : "";
      return el.tagName.toLowerCase() + id + cls;
    } catch (e) { return "?"; }
  }
  function shortKey(k) {
    if (k.indexOf("._row_") >= 0) return "row";
    if (k.indexOf("._mainContentArea_") >= 0) return "main";
    if (k.indexOf("html") === 0) return "html";
    return k.slice(0, 24);
  }
  function encodeRing() {
    var enc = ring.map(function (e) {
      return "+" + e[0] + " " + e[1] + (e[2] != null ? "#" + e[2] : "") +
        " " + e[3] + "x" + e[4] + (e[5] ? "*" : "");
    }).join(";");
    ring = [];
    return enc;
  }
  function emitDetail(via, newN, repN, enc) {
    if (typeof window.__bramIframeTrace !== "function") return;
    var detail = {
      context: "iframe", via: via, newElements: newN, repeatFires: repN,
      ring1: enc.slice(0, 480),
    };
    if (enc.length > 480) detail.ring2 = enc.slice(480, 960);
    if (enc.length > 960) detail.ring3 = enc.slice(960, 1440);
    if (enc.length > 1440) detail.ring4 = enc.slice(1440, 1920);
    window.__bramIframeTrace("resizeobserver-flood-detail", detail);
  }
  var Wrapped = class extends Native {
    constructor(cb) {
      super(function (entries, observer) {
        total += entries.length || 1;
        var now = Math.round(performance.now());
        for (var i = 0; i < entries.length; i++) {
          var el = entries[i] && entries[i].target;
          var k = describe(el);
          counts[k] = (counts[k] || 0) + 1;
          var isNew = false;
          if (seen && el && el.nodeType === 1) {
            if (seen.has(el)) { repeatFires++; }
            else { seen.add(el); isNew = true; newElements++; }
          }
          var r = entries[i] && entries[i].contentRect;
          ring.push([
            lastFireMs ? now - lastFireMs : 0,
            shortKey(k),
            el && el.getAttribute ? el.getAttribute("data-index") : null,
            r ? Math.round(r.width * 10) / 10 : null,
            r ? Math.round(r.height * 10) / 10 : null,
            isNew,
          ]);
          lastFireMs = now;
          if (ring.length > RING_MAX) ring.shift();
          firesSinceTick++;
          if (firesSinceTick >= SYNC_BURST_FIRES && now - lastSyncDumpMs >= SYNC_MIN_GAP_MS) {
            firesSinceTick = 0;
            lastSyncDumpMs = now;
            var newN = 0;
            for (var j = 0; j < ring.length; j++) if (ring[j][5]) newN++;
            emitDetail("sync", newN, ring.length - newN, encodeRing());
          }
        }
        return cb.call(this, entries, observer);
      });
    }
  };
  Wrapped.__bramFloodWrapped = true;
  window.ResizeObserver = Wrapped;
  setInterval(function () {
    var t = total; total = 0;
    // Stash the per-second RO fire rate (every second, flood or not) so the
    // heartbeat-batch line can pair it with drift — RO-rate ↔ drift in one grep.
    window.__bramRoFiresPerSec = t;
    var snap = counts; counts = Object.create(null);
    var newN = newElements; newElements = 0;
    var repN = repeatFires; repeatFires = 0;
    // Every tick proves the thread yielded: reset the sync-dump burst
    // counter so the in-callback dump fires only when a whole flooding
    // second passes without this tick running (i.e., a hard freeze).
    firesSinceTick = 0;
    if (t < FLOOD_PER_SEC) return;
    var top = Object.keys(snap)
      .map(function (k) { return [k, snap[k]]; })
      .sort(function (a, b) { return b[1] - a[1]; })
      .slice(0, 6)
      .map(function (p) { return p[0] + "=" + p[1]; });
    // One entry per fire: "+dt key#idx WxH*" — dt is ms since the prior
    // fire, #idx is the element's data-index when present (XMLUI's List
    // Item sets it), trailing * marks a first-ever observation (mount).
    // Encoded as chunked strings because the trace serializer summarizes
    // arrays to 3 samples and truncates strings at 500 chars
    // (__bramTraceSafeValue).
    if (typeof window.__bramIframeTrace === "function") {
      window.__bramIframeTrace("resizeobserver-flood", {
        context: "iframe", firesPerSec: t, top: top,
      });
      emitDetail("interval", newN, repN, encodeRing());
    }
  }, 1000);
})();

// Input-latency probe (diagnostic, #150 startup unresponsiveness). The other
// instruments measure iframe-JS steady state; this measures the actual
// symptom — input responsiveness. Capture-phase pointerdown/keydown stamp a
// time; the next animation frame measures how long the main thread took to
// come back. A gap > threshold means input was starved (JS saturation or
// render jank). hadFocus is logged too, since "needs a double-click after a
// reload" is often a focus artifact, not saturation. Remove once the #150
// responsiveness cause is identified.
(function installInputLatencyProbe() {
  if (window.__bramInputLatencyProbe) return;
  window.__bramInputLatencyProbe = true;
  // describe-backfill-pacing soak: floor dropped 200 -> 100ms. The 2026-07-30
  // storm analysis showed every blocking instrument floored at 200ms while
  // typing feel degrades from ~50-100ms (31.9s of measured settle vs 5.8s of
  // sampled long-task in the same window). Revisit after the soak if
  // steady-state noise appears.
  var THRESHOLD_MS = 100;
  var lastLog = 0;
  function describe(el) {
    try {
      if (!el || el.nodeType !== 1) return String(el);
      var id = el.id ? "#" + el.id : "";
      var cls = (typeof el.className === "string" && el.className.trim())
        ? "." + el.className.trim().split(/\s+/).slice(0, 2).join(".")
        : "";
      return el.tagName.toLowerCase() + id + cls;
    } catch (e) { return "?"; }
  }
  function onInput(ev) {
    var t0 = performance.now();
    var type = ev.type;
    // describe-backfill-pacing: typing-activity timestamp — the issuance
    // hold keys on this (typed within the last 2s), NOT on composer focus,
    // which is sticky and would starve the backfill during reading.
    if (type === "keydown") window.__bramLastKeydownAt = Date.now();
    var hadFocus = false;
    try { hadFocus = document.hasFocus(); } catch (e) {}
    var tgt = describe(ev.target);
    requestAnimationFrame(function () {
      var dt = performance.now() - t0;
      if (dt < THRESHOLD_MS) return;
      if (t0 - lastLog < THRESHOLD_MS) return;
      lastLog = t0;
      if (typeof window.__bramIframeTrace === "function") {
        // describe-backfill-observability: attribute the delay at emit time —
        // how many describe fetches were in flight, and the most recent
        // long task (if within 1.5s). Turns keydown<->storm correlation
        // into direct evidence.
        var llt = window.__bramLastLongTask || null;
        var lltFresh = llt && (Date.now() - llt.at) <= 1500;
        var route = "";
        try { route = String(location.hash || ""); } catch (eRt) { /* ignore */ }
        window.__bramIframeTrace("input-latency", {
          context: "iframe", event: type, latencyMs: Math.round(dt),
          hadFocus: hadFocus, target: tgt, route: route,
          describeInflight: window.__bramDescribeInflight || 0,
          lastLongTaskMs: lltFresh ? llt.ms : 0,
          lastLongTaskName: lltFresh ? llt.name : "",
          lastLongTaskAgoMs: lltFresh ? (Date.now() - llt.at) : -1,
        });
      }
    });
  }
  document.addEventListener("pointerdown", onInput, true);
  document.addEventListener("keydown", onInput, true);
})();

// Persist the tools-pane route across iframe reloads. main.js reassigns
// tools.src on every tools-pane-reload event (drawer code changed under
// app/tools/), which drops the hash and lands the user on the default
// route (Worklist). We solve this from inside the iframe: restore the
// saved hash on boot, save the current hash on change.
//
// Scoped to the tools iframe — user-project apps in the right pane have
// their own route conventions and should not be affected.
(function persistToolsRoute() {
  if (window.location.pathname.indexOf("/tools/") === -1) return;
  var key = "bram.tools.route";
  var legacyKey = "xmlui-desktop.tools.route";
  var bootedAt = Date.now();
  var STARTUP_SUPPRESS_MS = 1500;
  function trace(subkind, fields) {
    setTimeout(function () {
      try {
        if (typeof window.logToHost !== "function") return;
        var payload = {
          kind: "iframe-trace",
          subkind: subkind,
          at: new Date().toISOString(),
        };
        if (fields && typeof fields === "object") {
          Object.assign(payload, fields);
        }
        window.logToHost(payload);
      } catch (e) {}
    }, 0);
  }

  // #279: localStorage is one shared store per machine (tauri://localhost
  // origin), so the plain `key` lets every Bram instance — regardless of
  // which project it's running against — read and overwrite the same
  // saved tab. Suffix by projectKey (from GET /__app-info) so instances
  // stop fighting over one slot. app/main.js computes the identical key
  // from the same projectKey; keep the two formulas in sync.
  function toolsRouteKeyFor(projectKey) {
    return projectKey ? key + ":" + projectKey : key;
  }
  // One-shot migration: the first project to read after upgrade inherits
  // whatever was in the old unsuffixed/legacy keys, then those keys are
  // removed so no later project can inherit them again. No-op when
  // there's no projectKey to suffix with.
  function migrateToolsRouteKey(storage, suffixedKey) {
    if (!storage || suffixedKey === key) return;
    try {
      if (storage.getItem(suffixedKey)) return;
      var legacy = storage.getItem(key) || storage.getItem(legacyKey);
      if (legacy) {
        storage.setItem(suffixedKey, legacy);
        storage.removeItem(key);
        storage.removeItem(legacyKey);
      }
    } catch (e) {}
  }

  function boot(routeKey) {
    try {
      var current = window.location.hash;
      var saved =
        localStorage.getItem(routeKey) ||
        localStorage.getItem(key) ||
        localStorage.getItem(legacyKey) ||
        "";
      trace("tools-route-boot", {
        current: current || "",
        saved: saved,
        pathname: window.location.pathname || "",
      });
      if (!current || current === "#/") {
        if (saved && saved !== "#/") {
          window.location.hash = saved;
          trace("tools-route-restore", {
            from: current || "",
            route: saved,
          });
        }
      }
      // react-router-dom uses history.pushState which doesn't fire
      // hashchange, so poll instead of listening.
      setInterval(function () {
        var h = window.location.hash;
        var stored = localStorage.getItem(routeKey) || "";
        if (
          h === "#/" &&
          stored &&
          stored !== "#/" &&
          Date.now() - bootedAt < STARTUP_SUPPRESS_MS
        ) {
          trace("tools-route-skip-root-save", {
            stored: stored,
            elapsedMs: Date.now() - bootedAt,
          });
          return;
        }
        if (h && h !== localStorage.getItem(routeKey)) {
          localStorage.setItem(routeKey, h);
          trace("tools-route-save", {
            route: h,
            previous: stored,
            elapsedMs: Date.now() - bootedAt,
          });
        }
      }, 500);
    } catch (e) {}
  }

  // Relative fetch: this iframe is served from tauri://localhost/tools/…,
  // and handle_tauri_scheme proxies /__* paths to this instance's own
  // loopback regardless of which project is loaded — no port lookup
  // needed (the .bram-port file is for out-of-band tooling, not this
  // same-origin iframe). On any failure, fall back to the plain
  // unsuffixed key so a saved route still restores.
  try {
    fetch("/__app-info", { cache: "no-store" })
      .then(function (r) {
        return r.json();
      })
      .then(function (info) {
        var projectKey = info && typeof info.projectKey === "string" ? info.projectKey : "";
        var routeKey = toolsRouteKeyFor(projectKey);
        if (projectKey) migrateToolsRouteKey(localStorage, routeKey);
        boot(routeKey);
      })
      .catch(function () {
        boot(key);
      });
  } catch (e) {
    boot(key);
  }
})();

// Main-thread heartbeat for the drawer iframe. setInterval scheduled
// every 200ms; if the actual gap exceeds the threshold the main thread
// was blocked (typically by heavy Markdown re-renders during JSONL
// cascade — the same condition that delays the inflightClaim
// DataSource's onLoaded handler). Emits one record per blockage with
// drift_ms, so a swallowed click can be correlated with main-thread
// busyness in bram-trace.log. Scoped to the drawer because that's
// where worklist clicks live; the right pane is a separate iframe with
// its own load profile.
(function heartbeat() {
  if (window.location.pathname.indexOf("/tools/") === -1) return;
  setTimeout(function () {
    try {
      window.logToHost && window.logToHost({
        kind: "iframe-trace",
        subkind: "helpers-js-loaded",
        build: "batch-v2",
        at: new Date().toISOString(),
      });
    } catch (e) {}
  }, 500);
  var TICK_MS = 200;
  // Threshold is configurable via appGlobals.heartbeatDriftThresholdMs
  // (see config.json). Defaults to 500ms when unset. Lower values
  // catch sub-second blockages at the cost of more records during
  // normal hot-render bursts.
  var DRIFT_THRESHOLD_MS =
    (window.appGlobals && Number(window.appGlobals.heartbeatDriftThresholdMs)) || 500;
  var last = performance.now();
  var batch = { fires: 0, sumDrift: 0, maxDrift: 0, spikes: 0, sinceMs: 0, bgFires: 0 };
  // Batch summary every 50 fires (~10s nominal). Emits aggregate
  // drift stats so we can see overall main-thread health independent
  // of individual spike records.
  function batchTick(drift, bg) {
    if (batch.fires === 0) batch.sinceMs = Date.now();
    batch.fires += 1;
    if (bg) batch.bgFires += 1;
    batch.sumDrift += drift;
    if (drift > batch.maxDrift) batch.maxDrift = drift;
    if (drift >= DRIFT_THRESHOLD_MS) batch.spikes += 1;
    if (batch.fires >= 50) {
      // Gate: skip the emit while a PTY menu is pending.
      // window.__bramMenuPending mirrors bramAgentMenu (set by
      // Globals.xs applyAgentMenu). Reset still runs so a fresh
      // window starts post-dismiss.
      if (!window.__bramMenuPending) {
        try {
          window.logToHost({
            kind: "iframe-trace",
            subkind: "heartbeat-batch",
            fires: batch.fires,
            spanMs: Date.now() - batch.sinceMs,
            sumDriftMs: Math.round(batch.sumDrift),
            avgDriftMs: Math.round(batch.sumDrift / batch.fires),
            maxDriftMs: Math.round(batch.maxDrift),
            spikes: batch.spikes,
            bgFires: batch.bgFires,
            roFiresPerSec: window.__bramRoFiresPerSec || 0,
            at: new Date().toISOString(),
          });
        } catch (e) {}
      }
      batch = { fires: 0, sumDrift: 0, maxDrift: 0, spikes: 0, sinceMs: 0 };
    }
  }
  setInterval(function () {
    var now = performance.now();
    var drift = now - last - TICK_MS;
    last = now;
    // Focus/visibility at this tick. Browsers throttle setInterval to ~1s
    // when the window is hidden/unfocused, so drift then reads ~800ms
    // (1000 - TICK_MS) even though the main thread is idle — a throttle
    // artifact, not lag. Stamp each record with hidden/focused so a
    // backgrounded window is distinguishable from real saturation, and
    // count backgrounded fires per batch (bgFires): a high maxDrift with
    // bgFires≈fires is throttling; with bgFires≈0 it is genuine.
    var hidden = typeof document !== "undefined" && document.hidden === true;
    var focused =
      typeof document === "undefined" || typeof document.hasFocus !== "function"
        ? true
        : document.hasFocus();
    var bg = hidden || !focused;
    batchTick(drift, bg);
    if (drift >= DRIFT_THRESHOLD_MS && !window.__bramMenuPending) {
      try {
        window.logToHost({
          kind: "iframe-trace",
          subkind: "heartbeat-drift",
          drift_ms: Math.round(drift),
          hidden: hidden,
          focused: focused,
          at: new Date().toISOString(),
        });
      } catch (e) {}
    }
    // WebKit has no Long Tasks API, so the PerformanceObserver('longtask')
    // below records nothing. The heartbeat IS the working stall source: a
    // foreground tick late by >=200ms means the main thread was blocked that
    // long. Emit the long-task signal from here (source:"heartbeat"), gated to
    // the foreground so setInterval's ~1s background throttle isn't misread as
    // a stall. Overlaps heartbeat-drift (>=500ms) intentionally — this widens
    // coverage down to 200ms.
    if (drift >= 200 && !bg && !window.__bramMenuPending) {
      // describe-backfill-observability: remember the latest long task so
      // input-latency can attribute a slow keystroke to it at emit time.
      window.__bramLastLongTask = { ms: Math.round(drift), name: "heartbeat", at: Date.now() };
      window.__bramIframeTrace("long-task", {
        ms: Math.round(drift),
        name: "heartbeat",
        source: "heartbeat",
      });
    }
  }, TICK_MS);
})();

// Capture-phase click listener on `document` for the drawer iframe.
// Fires for EVERY click that reaches the DOM, BEFORE XMLUI's own
// onClick handlers. Distinguishes "click reached document but XMLUI's
// onClick didn't run" from "click never registered at all" — the
// former produces a `dom-click` record without a matching XMLUI
// `subkind=click`, pointing at button-disabled/re-rendered/dead-space
// failure modes that helpers.js can't otherwise detect. Capture phase
// (true) ensures this runs before bubbling-phase handlers.
(function captureClicks() {
  if (window.location.pathname.indexOf("/tools/") === -1) return;
  document.addEventListener("click", function (e) {
    try {
      var t = e.target;
      var tagName = t && t.tagName;
      var ariaLabel = (t && t.getAttribute && t.getAttribute("aria-label")) || "";
      var role = (t && t.getAttribute && t.getAttribute("role")) || "";
      var disabled = !!(t && t.disabled);
      window.logToHost({
        kind: "iframe-trace",
        subkind: "dom-click",
        tagName: String(tagName || ""),
        ariaLabel: String(ariaLabel),
        role: String(role),
        disabled: disabled,
        x: e.clientX,
        y: e.clientY,
        at: new Date().toISOString(),
      });
    } catch (le) {}
  }, true);
})();

// Outbound right-pane → PTY intents route through `queue_pty_intent`
// (#86), which appends to `resources/.pty-intent.jsonl` and drains
// under a process-wide mutex. The disk hop keeps each click durably
// recorded even if the iframe context is unsettled when the IPC fires
// — the host drains independently of the originating iframe state.
//
// `toShell` / `toTurn` / `sendKeys` keep their application-level
// responsibilities (whitespace normalization in `toTurn`, the
// implicit "\n" semantic in `toShell`, the "no framing" contract in
// `sendKeys`); PTY framing (bracketed-paste markers around toTurn
// data, trailing newline for toShell) is applied host-side in the
// drain so the right pane stays ignorant of terminal escape
// sequences.
// Write per-item feedback to resources/feedback-drafts/<feedbackId>.md
// without going through the PTY paste channel. toTurn collapses every
// whitespace run into a single space (line 227) and the receiving TUI's
// bracketed-paste buffer has its own content limits, so long Iterate
// feedback can lose structure or get truncated. Iterate now writes the
// feedback to disk via this helper and sends only a small feedbackRef
// in the toTurn payload; the agent reads the draft file directly. See
// #144.
window.queueFeedbackDraft = function (feedbackId, text) {
  var id = String(feedbackId || "");
  var s = String(text == null ? "" : text);
  // stage=source: what the iframe got from the textbox. stage=sink:
  // what was passed to the invoke. Identical lengths confirm no
  // client-side mangling; a delta points at iframe-side regression.
  try {
    window.logToHost({
      kind: "iframe-trace",
      subkind: "feedback-draft-write",
      stage: "source",
      feedback_id: id,
      source_bytes: s.length,
      at: new Date().toISOString(),
    });
  } catch (e) {}
  var invoke = getTauriInvoke();
  if (!invoke) return Promise.resolve(false);
  try {
    invoke("log_from_right_pane", {
      payload: {
        kind: "iframe-trace",
        subkind: "feedback-draft-write",
        stage: "sink",
        feedback_id: id,
        sink_bytes: s.length,
        at: new Date().toISOString(),
      },
    }).catch(function () {});
  } catch (e) {}
  return invoke("queue_feedback_draft", { payload: { feedback_id: id, text: s } })
    .then(function () {
      return true;
    })
    .catch(function (e) {
      console.error("queueFeedbackDraft invoke", e);
      try {
        window.logToHost({
          kind: "iframe-trace",
          subkind: "feedback-draft-write-failed",
          feedback_id: id,
          error: String((e && e.message) || e),
          at: new Date().toISOString(),
        });
      } catch (le) {}
      return false;
    });
};

window.sendIterateWithFeedbackDraft = function (items, selectedId, text) {
  var feedbackId = Date.now() + "-" + selectedId;
  window.queueFeedbackDraft(feedbackId, text).then(function (wroteDraft) {
    window.toTurn("iterate: " + JSON.stringify({
      items: (items || []).filter(function (i) { return i.id === selectedId; })
        .map(function (i) {
          return wroteDraft
            ? { id: i.id, feedbackRef: feedbackId, gate: window.__bramItemGate(i) }
            : { id: i.id, feedback: text, gate: window.__bramItemGate(i) };
        }),
    }));
  });
};

// issue-221-skill-launcher: build and submit a `/skill args` turn from the
// Skills launcher — straight to the agent via toTurn. One trace line per launch.
window.__bramRunSkill = function (name, argsRaw) {
  if (!name) return;
  var args = String(argsRaw || "").trim();
  var cmd = args ? "/" + name + " " + args : "/" + name;
  try {
    window.logToHost({
      kind: "iframe-trace",
      subkind: "skill-invoke",
      name: name,
      args_len: args.length,
      at: new Date().toISOString(),
    });
  } catch (e) {}
  window.toTurn(cmd);
};

window.toShell = function (text) {
  var s = String(text);
  // Trace the entry so #86's "click swallowed" diagnostic flow can
  // distinguish between "helper never invoked" (no trace line) and
  // "helper invoked but queue / drain lost" (trace line present but
  // no [pty-intent] op=enqueue follows). kind: "iframe-trace" routes
  // through log_from_right_pane's iframe-trace branch into the
  // [iframe] category of resources/bram-traces/bram-trace.log.
  try {
    window.logToHost({
      kind: "iframe-trace",
      subkind: "to-shell",
      stage: "source",
      textLength: s.length,
      textPreview: s.slice(0, 80),
      at: new Date().toISOString(),
    });
  } catch (e) {}
  var invoke = getTauriInvoke();
  if (!invoke) {
    // issue-343: affirmative evidence at the link that died. In the target
    // pane this no-op is by design and the trace goes nowhere (host routes
    // refused); in the agent pane a line here names the wedge.
    window.__bramIframeTrace("host-helper", { op: "no-invoke", fn: "toShell" });
    return;
  }
  invoke("queue_pty_intent", { payload: { kind: "toShell", data: s } }).catch(function (e) {
    console.error("toShell queue_pty_intent", e);
    try {
      window.logToHost({
        kind: "iframe-trace",
        subkind: "to-shell-invoke-failed",
        error: String((e && e.message) || e),
        at: new Date().toISOString(),
      });
    } catch (le) {}
  });
};
window.toTurn = function (text) {
  var s = String(text);
  try {
    window.logToHost({
      kind: "iframe-trace",
      subkind: "to-turn",
      stage: "source",
      textLength: s.length,
      textPreview: s.slice(0, 80),
      at: new Date().toISOString(),
    });
  } catch (e) {}
  // Send the text RAW. Per-transport normalization is the host's job now
  // (docs/turn-transport-redesign.md step 6): the host collapses whitespace
  // only for small inline sends, while substantial/image-bearing sends ride
  // a filesystem envelope with full fidelity — multiline text survives.
  var normalized = s;
  var invoke = getTauriInvoke();
  if (!invoke) {
    // issue-343: see toShell — the wedge's breadcrumb, silent where refusal
    // is by design.
    window.__bramIframeTrace("host-helper", { op: "no-invoke", fn: "toTurn" });
    return;
  }
  invoke("log_from_right_pane", {
    payload: {
      kind: "iframe-trace",
      subkind: "to-turn",
      stage: "sink",
      textLength: normalized.length,
      textPreview: normalized.slice(0, 80),
      at: new Date().toISOString(),
    },
  }).catch(function () {});
  invoke("queue_pty_intent", { payload: { kind: "toTurn", data: normalized } }).catch(function (e) {
    console.error("toTurn queue_pty_intent", e);
    try {
      window.logToHost({
        kind: "iframe-trace",
        subkind: "to-turn-invoke-failed",
        error: String((e && e.message) || e),
        at: new Date().toISOString(),
      });
    } catch (le) {}
  });
};

window.recordWorklistActionAuthorization = function (payload) {
  var invoke = getTauriInvoke();
  if (!invoke || !payload) return Promise.resolve(false);
  return invoke("record_worklist_action_authorization", { payload: payload })
    .then(function () { return true; })
    .catch(function (e) {
      console.error("recordWorklistActionAuthorization invoke", e);
      try {
        window.logToHost({
          kind: "iframe-trace",
          subkind: "worklist-action-auth-failed",
          error: String((e && e.message) || e),
          at: new Date().toISOString(),
        });
      } catch (le) {}
      return false;
    });
};

// issue-350-gate-click-brackets: synchronous stage marks via the IPC trace
// channel (logToHost dispatches before a renderer death that follows it —
// the describe-patch precedent). #350's two freezes died inside this
// pipeline with no evidence; a freeze now names its last completed stage.
// Notably: occurrence 1 left a host-side auth record with no sentinel —
// under these brackets that reads as submit-begin + missing auth-recorded,
// pinning the death to the invoke continuation.
window.submitAuthorizedWorklistTurn = function (result, onFailure) {
  result = result || {};
  var payload = result.authorizationPayload || null;
  var turnText = result.turnText || "";
  window.__bramIframeTrace("gate-click", {
    stage: "submit-begin",
    hasAuth: !!payload,
    textLength: turnText.length,
  });
  if (!payload) {
    if (turnText) window.toTurn(turnText);
    window.__bramIframeTrace("gate-click", { stage: "submit-end", via: "no-auth" });
    return;
  }
  window.recordWorklistActionAuthorization(payload).then(function (ok) {
    window.__bramIframeTrace("gate-click", { stage: ok ? "auth-recorded" : "auth-failed" });
    if (ok && turnText) window.toTurn(turnText);
    if (!ok && typeof onFailure === "function") onFailure();
    window.__bramIframeTrace("gate-click", { stage: "submit-end", via: ok ? "auth" : "auth-failed" });
  });
};
// sendKeys writes raw bytes to the PTY with NO trailing newline (unlike
// toShell which always appends \n). Use it for control sequences like ESC,
// arrow keys, or single-keypress menu shortcuts.
window.sendKeys = function (text) {
  var invoke = getTauriInvoke();
  if (!invoke) {
    // issue-343: see toShell.
    window.__bramIframeTrace("host-helper", { op: "no-invoke", fn: "sendKeys" });
    return;
  }
  invoke("queue_pty_intent", { payload: { kind: "sendKeys", data: String(text) } }).catch(function (e) {
    console.error("sendKeys queue_pty_intent", e);
    try {
      window.logToHost({
        kind: "iframe-trace",
        subkind: "send-keys-invoke-failed",
        error: String((e && e.message) || e),
        at: new Date().toISOString(),
      });
    } catch (le) {}
  });
};
// Permission-menu answers are not generic PTY keystrokes. Carry the host's
// prompt identity so a button that survives one render past dismissal cannot
// submit its numeral into the composer. The client-side set closes the
// immediate double-click window synchronously; the host independently checks
// the identity against its current OpenPrompt before writing any bytes.
if (!window.__bramSentMenuAnswerIds) window.__bramSentMenuAnswerIds = new Set();
window.__bramSendMenuAnswer = function (text, promptId) {
  var id = String(promptId || "");
  var data = String(text || "");
  var invoke = getTauriInvoke();
  if (!invoke || !id || !data) return;
  if (window.__bramSentMenuAnswerIds.has(id)) {
    window.__bramIframeTrace("menu-answer-client", {
      op: "duplicate-rejected",
      promptId: id,
    });
    return;
  }
  while (window.__bramSentMenuAnswerIds.size >= 64) {
    window.__bramSentMenuAnswerIds.delete(window.__bramSentMenuAnswerIds.values().next().value);
  }
  window.__bramSentMenuAnswerIds.add(id);
  invoke("queue_pty_intent", {
    payload: { kind: "menuAnswer", data: data, promptId: id },
  }).catch(function (e) {
    window.__bramSentMenuAnswerIds.delete(id);
    console.error("menuAnswer queue_pty_intent", e);
    try {
      window.logToHost({
        kind: "iframe-trace",
        subkind: "menu-answer-invoke-failed",
        promptId: id,
        error: String((e && e.message) || e),
        at: new Date().toISOString(),
      });
    } catch (le) {}
  });
};
window.__bramAgentSwitcherTrace = function (stage, fields) {
  try {
    var payload = Object.assign({ stage: stage, at: new Date().toISOString() }, fields || {});
    window.__bramIframeTrace("agent-switcher", payload);
  } catch (e) {}
};
window.__bramAgentSwitcherLabel = function (provider) {
  return String(provider || "").toLowerCase() === "codex" ? "Codex" : "Claude";
};
var __bramAgentSwitcherBusy = false;
var __bramAgentSwitcherBusySubscribers = new Set();
function __bramPublishAgentSwitcherBusy(value) {
  __bramAgentSwitcherBusy = !!value;
  __bramAgentSwitcherBusySubscribers.forEach(function (fn) {
    try { fn(__bramAgentSwitcherBusy); } catch (e) {
      console.error("[bramSubscribeAgentSwitcherBusy] subscriber threw:", e);
    }
  });
}
window.bramSubscribeAgentSwitcherBusy = (function () {
  var factory;
  return function () {
    if (factory) return factory;
    factory = function (emit) {
      var fire = function (value) { emit(value == null ? __bramAgentSwitcherBusy : !!value); };
      __bramAgentSwitcherBusySubscribers.add(fire);
      fire();
      return function () { __bramAgentSwitcherBusySubscribers.delete(fire); };
    };
    return factory;
  };
})();
window.__bramWithAgentCommandTimeout = function (promise, label) {
  var timeoutMs = 8000;
  var timeout = new Promise(function (_, reject) {
    setTimeout(function () {
      reject(new Error((label || "agent command") + " did not finish within " + (timeoutMs / 1000) + "s"));
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]);
};
window.__bramSwitchAgent = function (provider) {
  var key = String(provider || "").toLowerCase() === "codex" ? "codex" : "claude";
  var invoke = getTauriInvoke();
  if (!invoke) return Promise.reject(new Error("Tauri IPC unavailable"));
  window.__bramAgentSwitcherTrace("invoke", { provider: key });
  return window.__bramWithAgentCommandTimeout(invoke("switch_agent", { provider: key }), "agent switch").then(function () {
    window.__bramAgentSwitcherTrace("sent", { provider: key });
    return key;
  }).catch(function (e) {
    window.__bramAgentSwitcherTrace("error", {
      provider: key,
      error: String((e && e.message) || e),
    });
    throw e;
  });
};
window.__bramHandleAgentSwitcherChange = function (next, previous, select, toastApi) {
  var key = String(next || "").toLowerCase() === "codex" ? "codex" : (String(next || "").toLowerCase() === "claude" ? "claude" : "");
  var prev = String(previous || "").toLowerCase() === "codex" ? "codex" : "claude";
  window.__bramAgentSwitcherTrace("change", { next: key, previous: prev, hasSelect: !!select });
  if (!key || key === prev) return;
  __bramPublishAgentSwitcherBusy(true);
  window.__bramSwitchAgent(key).then(function () {
    window.__bramAgentSwitcherTrace("complete", { provider: key });
    __bramPublishAgentSwitcherBusy(false);
  }).catch(function (e) {
    window.__bramAgentSwitcherTrace("revert", {
      provider: key,
      previous: prev,
      error: String((e && e.message) || e),
    });
    if (select && typeof select.setValue === "function") select.setValue(prev);
    __bramPublishAgentSwitcherBusy(false);
    try {
      if (toastApi && typeof toastApi.error === "function") {
        toastApi.error("Could not switch agent: " + String((e && e.message) || e));
      }
    } catch (le) {}
  });
};
window.__bramReloadAgentSession = function (provider, sessionId) {
  var key = String(provider || "").toLowerCase() === "codex" ? "codex" : "claude";
  var id = String(sessionId || "");
  var invoke = getTauriInvoke();
  if (!invoke) return Promise.reject(new Error("Tauri IPC unavailable"));
  try {
    window.__bramIframeTrace("agent-reload", {
      stage: "invoke",
      provider: key,
      session: id,
      at: new Date().toISOString(),
    });
  } catch (e) {}
  return window.__bramWithAgentCommandTimeout(invoke("reload_agent_session", { provider: key, session: id }), "agent reload").then(function () {
    try {
      window.__bramIframeTrace("agent-reload", {
        stage: "sent",
        provider: key,
        session: id,
        at: new Date().toISOString(),
      });
    } catch (e) {}
    return key;
  }).catch(function (e) {
    try {
      window.__bramIframeTrace("agent-reload", {
        stage: "error",
        provider: key,
        session: id,
        error: String((e && e.message) || e),
        at: new Date().toISOString(),
      });
    } catch (le) {}
    throw e;
  });
};
// sessions-new-named-session: start a fresh session for the current provider,
// optionally naming it. The host kills+relaunches the agent without --continue
// and applies the name when the new session's JSONL surfaces.
window.__bramCreateNewSession = function (provider, title) {
  var key = String(provider || "").toLowerCase() === "codex" ? "codex" : "claude";
  var invoke = getTauriInvoke();
  if (!invoke) return Promise.reject(new Error("Tauri IPC unavailable"));
  return window.__bramWithAgentCommandTimeout(
    invoke("create_new_session", { provider: key, title: String(title || "") }),
    "new session"
  );
};
window.__bramCreateNewSessionClick = function (provider, name, toastApi) {
  if (typeof toastApi === "function") toastApi("Starting a new session…");
  window.__bramCreateNewSession(provider, name).catch(function (e) {
    if (toastApi && typeof toastApi.error === "function") {
      toastApi.error("Could not create session: " + String((e && e.message) || e));
    }
  });
};
window.__bramReloadAgentSessionClick = function (provider, sessionId, toastApi) {
  var key = String(provider || "").toLowerCase() === "codex" ? "codex" : "claude";
  var id = String(sessionId || "");
  try {
    window.__bramIframeTrace("agent-reload", {
      stage: "click",
      provider: key,
      session: id,
      at: new Date().toISOString(),
    });
  } catch (e) {}
  window.__bramReloadAgentSession(key, id).catch(function (e) {
    try {
      if (toastApi && typeof toastApi.error === "function") {
        toastApi.error("Could not reload session: " + String((e && e.message) || e));
      }
    } catch (le) {}
  });
  try {
    if (typeof toastApi === "function") toastApi("Reloading session - killing the running agent and resuming.");
  } catch (e) {}
};
// Pick the live session from a /__sessions/list payload: the entry flagged
// current, else the first returned. Shared by the Transcript header and the
// footer echo so both point at the same session.
window.__bramCurrentSessionOf = function (list) {
  var arr = Array.isArray(list) ? list : [];
  return arr.find(function (s) { return s && s.current; }) || arr[0] || null;
};
// One-line session metadata used at the top of the Transcript and echoed
// under the footer message box. Plain-JS date formatting (no formatDateTime
// dependency) keeps it usable from any surface. Returns "" for no session.
window.__bramSessionMetaLine = function (s) {
  if (!s) return "";
  var provider = String(s.provider || "").toUpperCase();
  var title = s.title || "(untitled)";
  var id = String(s.id || "");
  var shortId = id.length > 12 ? id.slice(0, 12) : (id || "unknown");
  var when = "";
  if (s.mtime) {
    var d = new Date(s.mtime * 1000);
    var pad = function (n) { return n < 10 ? "0" + n : "" + n; };
    when =
      d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) +
      " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
  }
  var kb = Math.round((s.size || 0) / 1024) + " KB";
  var parts = [title, "id " + shortId];
  if (when) parts.push(when);
  parts.push(kb);
  return (provider ? provider + "  " : "") + parts.join("  ·  ");
};
window.recordToolbarPendingMenuFromEvent = function (event) {
  window.__bramToolbarMenuState = {
    present: !!(event && event.payload),
    atMs: Date.now(),
  };
};
window.getToolbarPendingMenuState = function () {
  return window.__bramToolbarMenuState || { present: false, atMs: 0 };
};
// Toolbar PTY subscribers. Invoked via xs delegators in Globals.xs.
//
// Originally migrated in commit d532432 step 5: the xs declarations
// were removed and Main.xmlui's bare-name calls were expected to
// resolve directly to `window.setToolbarPendingMenuFromEvent` etc.
// — that worked for the toolbar onClick handlers where the call is a
// top-level expression, but XMLUI's expression engine analyzes
// identifiers inside arrow-function bodies passed to
// subscribeTauriEvent and silently aborts the registration when a
// bare name has no xs declaration. Main.xmlui's onInit then stopped
// running its remaining statements partway through (statement 5
// onward), AgentMenu's mount cascade was disrupted, and menus
// stopped appearing. The fix: distinct __bram-prefixed window
// helpers paired with thin xs delegators below — the same pattern
// every other migrated function uses.
window.__bramSetToolbarPendingMenuFromEvent = function (e) {
  window.recordToolbarPendingMenuFromEvent(e);
};
window.__bramSetToolbarPendingMenuFromTurnState = function (turnState) {
  window.recordToolbarPendingMenuFromEvent({ payload: turnState && turnState.pendingMenu });
};
window.__bramTraceToolbarKey = function (key, extra) {
  var state = window.getToolbarPendingMenuState();
  var payload = {
    key: key,
    menuPresent: state.present ? 1 : 0,
    menuAgeMs: state.atMs ? (Date.now() - state.atMs) : -1,
  };
  if (extra && typeof extra === "object") {
    Object.keys(extra).forEach(function (k) {
      payload[k] = extra[k];
    });
  }
  window.__bramIframeTrace("toolbar-key", payload);
};
window.logToHost = function (payload) {
  // Master-flag short-circuit. Paired with `window.iframeTrace`
  // below. When traces are off, skip the Tauri IPC invoke (the
  // dominant per-event cost). Default-ON so behavior is preserved
  // during the brief startup window before the self-init fetch
  // below resolves the actual setting.
  if (window.__bramTracesEnabled === false) return;
  var invoke = getTauriInvoke();
  if (!invoke) {
    // issue-343: the trace transport must not share its only channel with
    // the commands it witnesses. With the invoke bridge gone (the wedge
    // class #343 reported), fall back to the loopback route so evidence
    // still lands; transport=fetch-fallback marks each line as proof of
    // which channel died. In the cross-origin target pane both channels
    // are refused by design — the catch keeps that case silent, as before.
    try {
      var marked = Object.assign({ transport: "fetch-fallback" }, payload);
      window
        .fetch("/__trace/pane", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(marked),
        })
        .catch(function () {});
    } catch (e) {}
    return;
  }
  invoke("log_from_right_pane", { payload: payload }).catch(function () {});
};
window.__bramSensitiveTraceKey = function (key) {
  var normalized = String(key || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  return /(?:token|password|secret|apikey|accesskey|privatekey|credential)$/.test(normalized);
};
window.__bramRedactSensitiveText = function (value) {
  var marker = "[REDACTED]";
  var text = String(value == null ? "" : value);
  text = text.replace(
    /-----BEGIN [^\r\n]*PRIVATE KEY-----[\s\S]*?-----END [^\r\n]*PRIVATE KEY-----/g,
    marker
  );
  text = text.replace(/-----BEGIN [^\r\n]*PRIVATE KEY-----[\s\S]*$/g, marker);
  text = text.replace(
    /\b(?:sk-ant-|sk-proj-|github_pat_|gh[pousr]_)[A-Za-z0-9._+\-\/=]{12,}/g,
    marker
  );
  text = text.replace(/\bsk-[A-Za-z0-9._+\-\/=]{20,}/g, marker);
  text = text.replace(/\bAKIA[A-Z0-9]{16}\b/g, marker);
  text = text.replace(
    /\b(Bearer|Basic)(\s+)[A-Za-z0-9._~+\-\/=]+/gi,
    function (_, scheme, space) { return scheme + space + marker; }
  );
  text = text.replace(
    /(\b(?:token|password|secret|api[_-]?key|access[_-]?key|private[_-]?key|credential)\b\s*[:=]\s*)(["'])([\s\S]*?)\2/gi,
    function (_, prefix, quote) { return prefix + quote + marker + quote; }
  );
  text = text.replace(
    /(\b(?:token|password|secret|api[_-]?key|access[_-]?key|private[_-]?key|credential)\b\s*[:=]\s*)(?!["'\[])([^\s,;}\]]+)/gi,
    function (_, prefix) { return prefix + marker; }
  );
  return text;
};
window.__bramTraceSafeValue = function (value, depth) {
  depth = depth || 0;
  if (value == null) return value;
  var t = typeof value;
  if (t === "string") {
    var redacted = window.__bramRedactSensitiveText(value);
    return redacted.length > 500
      ? redacted.slice(0, 500) + "...[truncated " + redacted.length + " chars]"
      : redacted;
  }
  if (t === "number" || t === "boolean") return value;
  if (t !== "object") return String(value);
  if (depth >= 2) {
    if (Array.isArray(value)) return { __summary: "array", length: value.length };
    var keys = Object.keys(value);
    return { __summary: "object", keys: keys.slice(0, 12), keyCount: keys.length };
  }
  if (Array.isArray(value)) {
    return {
      __summary: "array",
      length: value.length,
      sample: value.slice(0, 3).map(function (v) { return window.__bramTraceSafeValue(v, depth + 1); }),
    };
  }
  var out = {};
  var objectKeys = Object.keys(value);
  for (var i = 0; i < objectKeys.length && i < 20; i++) {
    var key = objectKeys[i];
    out[key] = window.__bramSensitiveTraceKey(key)
      ? "[REDACTED]"
      : window.__bramTraceSafeValue(value[key], depth + 1);
  }
  if (objectKeys.length > 20) out.__truncatedKeys = objectKeys.length - 20;
  return out;
};

// iframeTrace: the [iframe] category of the comms-path trace log
// (issue #49). Forwards a structured record to the host's
// `log_from_right_pane` Tauri command, which routes records whose
// `kind` is `"iframe-trace"` into resources/bram-traces/bram-trace.log
// when BRAM_TRACE=1 is set on the host. No-op when logToHost isn't
// wired up. subkind is a token from the spec's maintained vocabulary
// (click, inflight-set, inflight-clear, listener-fired, ...); fields
// are arbitrary per-event metadata.
//
// Lives in plain JS so callers from XMLUI-evaluated arrow function
// bodies and xs functions don't pay the per-statement-await cost of
// processStatementQueueAsync
// (xmlui/src/components-core/script-runner/process-statement-async.ts:115-166).
// The xs declaration in Globals.xs is a thin delegator that calls
// this; the window helper uses the `__bram` prefix to avoid the
// trap where xs's `function iframeTrace` declaration overwrites
// `window.iframeTrace` (browser scripts hoist top-level function
// declarations onto window), which would turn the delegator's
// `window.iframeTrace(...)` call into recursion-to-itself. Same
// pattern as `window.__bramApplyAgentMenu` paired with the xs
// `applyAgentMenu` delegator (commit ea9480e).
window.__bramIframeTrace = function (subkind, fields) {
  try {
    if (window.__bramTracesEnabled === false) return;
    if (typeof window.logToHost !== "function") return;
    var payload = { kind: "iframe-trace", subkind: subkind, at: new Date().toISOString() };
    if (fields && typeof fields === "object") {
      Object.keys(fields).forEach(function (key) {
        payload[key] = window.__bramTraceSafeValue(fields[key], 0);
      });
    }
    window.logToHost(payload);
  } catch (e) {}
};

// Iframe long-task tracer (2026-07-09 describe-freeze hunt). The
// xterm-liveness watchdog covers the PARENT main thread; a frozen
// IFRAME was invisible — the trace just went silent at the freeze
// instant with nothing attributing the block. This logs every iframe
// main-thread task ≥200ms at recovery, so the next freeze names its
// duration instead of leaving a gap. Attribution granularity is
// whatever the webview provides (often just "self"), but duration +
// timing against the surrounding trace is the diagnostic payload.
//
// NOTE: WebKit (Bram's WKWebView) does NOT implement the Long Tasks API,
// so this observer records nothing here — a platform gap, not a bug. The
// working stall source is the heartbeat above, which emits the same
// `long-task` subkind with source:"heartbeat" for foreground ticks late by
// >=200ms. This observer stays for Chromium-based webviews and future WebKit.
try {
  if (typeof PerformanceObserver === "function") {
    new PerformanceObserver(function (list) {
      var entries = list.getEntries();
      for (var i = 0; i < entries.length; i++) {
        var e = entries[i];
        if (e.duration >= 200) {
          window.__bramLastLongTask = { ms: Math.round(e.duration), name: e.name || "", at: Date.now() };
          window.__bramIframeTrace("long-task", {
            ms: Math.round(e.duration),
            name: e.name || "",
          });
        }
      }
    }).observe({ entryTypes: ["longtask"] });
  }
} catch (e) { /* longtask unsupported: instrument absent, not broken */ }

// backgrounded-pane-menu-paint-observer: pane visibility transitions.
// One line per transition; pairs with the menu-paint marker (see
// __bramApplyAgentMenu) to prove/refute that a backgrounded window
// starves the menu paint until refocus (2026-07-19: a Write menu sat
// 28.8s, answered only after the focus-in escape). Observe-only.
// __bramPaneLastVisibleMs is the correlation timestamp: a menu-paint
// whose paint lands after this refocus instant is the specimen.
window.__bramPaneLastVisibleMs = 0;
try {
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden) window.__bramPaneLastVisibleMs = Date.now();
    window.__bramIframeTrace("pane-visibility", {
      state: document.hidden ? "hidden" : "visible",
      via: "visibilitychange",
    });
  });
  window.addEventListener("blur", function () {
    window.__bramIframeTrace("pane-visibility", { state: "blur", via: "window" });
  });
  window.addEventListener("focus", function () {
    window.__bramPaneLastVisibleMs = Date.now();
    window.__bramIframeTrace("pane-visibility", { state: "focus", via: "window" });
  });
} catch (e) { /* observe-only: absent, not broken */ }

// asset-probe (promote-tool-descriptions-to-row forensics): the pane
// rendered pre-feature markup while the host provably served enriched
// projections, and a full WebKit cache clear did not change it. Every
// layer was verified EXCEPT the bytes the webview receives for the
// component markup itself — so observe them. 3s after boot in the
// tools pane, fetch our own Transcript.xmlui through the same origin
// the component loader uses, cached and no-store, and trace size +
// whether the new bindings are present. One grep then names the stale
// layer: cached==old & no-store==new -> cache; both old -> the serving
// store is stale (embedded assets); both new -> the loader itself.
try {
  if (window.location.pathname.indexOf("/tools/") !== -1) {
    setTimeout(function () {
      ["default", "no-store"].forEach(function (mode) {
        try {
          window
            .fetch("components/Transcript.xmlui", mode === "no-store" ? { cache: "no-store" } : {})
            .then(function (r) {
              return r.text().then(function (t) {
                window.__bramIframeTrace("asset-probe", {
                  path: "components/Transcript.xmlui",
                  mode: mode,
                  status: r.status,
                  bytes: t.length,
                  hasNameDetail: t.indexOf("nameDetail") >= 0,
                  hasAiDescription: t.indexOf("aiDescription") >= 0,
                  hasEagerComment: t.indexOf("inverted") >= 0,
                  origin: String(window.location.origin || ""),
                });
              });
            })
            .catch(function (e) {
              window.__bramIframeTrace("asset-probe", {
                path: "components/Transcript.xmlui",
                mode: mode,
                error: String(e),
              });
            });
        } catch (e) {}
      });
    }, 3000);
  }
} catch (e) { /* observe-only */ }

// Cascade-diagnosis instrumentation (refs #93). Emits a helper-call
// record when a hot JSONL-walking helper exceeds the threshold. Cheap
// paths (no-op early returns, cache hits) don't log because their _t0
// measurement is sub-ms. Threshold deliberately low to catch
// sub-frame stalls that compound across the cascade.
window.__bramTraceHelperTiming = function (name, t0, extra) {
  try {
    var elapsed = (typeof performance !== "undefined" && performance.now)
      ? performance.now() - t0
      : Date.now() - t0;
    if (elapsed < 2) return;
    if (typeof window.logToHost !== "function") return;
    var payload = {
      kind: "iframe-trace",
      subkind: "helper-call",
      name: name,
      ms: Math.round(elapsed),
      at: new Date().toISOString(),
    };
    if (extra && typeof extra === "object") Object.assign(payload, extra);
    window.logToHost(payload);
  } catch (e) {}
};

// Plain-JS equivalents of XMLUI's xs-only readLocalStorage /
// writeLocalStorage built-ins
// (xmlui/src/components-core/appContext/local-storage-functions.ts).
// Same dot-path semantics: the first segment is the localStorage entry
// name, remaining segments are a property path inside the parsed JSON
// object. Used by the __bram-prefixed localStorage shim helpers below
// so they can run in plain JS without re-entering XMLUI's statement
// queue. `bram.worklistMessageDraft` reads
// `JSON.parse(localStorage.bram).worklistMessageDraft`. Splitter keys
// like `bram.splitter.worklist` are two-level.
function __bramSplitKey(key) {
  var s = String(key);
  var dot = s.indexOf(".");
  return dot === -1 ? [s, undefined] : [s.substring(0, dot), s.substring(dot + 1)];
}

function __bramReadLS(key, fallback) {
  try {
    var parts = __bramSplitKey(key);
    var raw = localStorage.getItem(parts[0]);
    if (raw === null) return fallback;
    var root;
    try { root = JSON.parse(raw); } catch (e) { return fallback; }
    if (parts[1] === undefined) return root;
    var sub = parts[1].split(".");
    var cur = root;
    for (var i = 0; i < sub.length; i++) {
      if (cur == null || typeof cur !== "object") return fallback;
      cur = cur[sub[i]];
    }
    return cur === undefined ? fallback : cur;
  } catch (e) { return fallback; }
}

function __bramWriteLS(key, value) {
  try {
    var parts = __bramSplitKey(key);
    if (parts[1] === undefined) {
      if (value === undefined) localStorage.removeItem(parts[0]);
      else localStorage.setItem(parts[0], JSON.stringify(value));
      return;
    }
    var raw = localStorage.getItem(parts[0]);
    var root;
    if (raw === null) {
      root = {};
    } else {
      try { root = JSON.parse(raw); } catch (e) { root = {}; }
      if (!root || typeof root !== "object") root = {};
    }
    var sub = parts[1].split(".");
    var cur = root;
    for (var i = 0; i < sub.length - 1; i++) {
      var k = sub[i];
      if (!cur[k] || typeof cur[k] !== "object") cur[k] = {};
      cur = cur[k];
    }
    var last = sub[sub.length - 1];
    if (value === undefined) delete cur[last];
    else cur[last] = value;
    localStorage.setItem(parts[0], JSON.stringify(root));
  } catch (e) {}
}

function __bramReadSS(key, fallback) {
  try {
    if (!window.sessionStorage) return fallback;
    var v = sessionStorage.getItem(key);
    return v === null ? fallback : v;
  } catch (e) { return fallback; }
}

function __bramWriteSS(key, value) {
  try {
    if (!window.sessionStorage) return;
    if (value === undefined || value === null || value === "") {
      sessionStorage.removeItem(key);
    } else {
      sessionStorage.setItem(key, String(value));
    }
  } catch (e) {}
}

// Worklist "message agent" persistence + lifecycle shims. Counterparts
// for the xs delegators in Globals.xs (audit step 3, 2026-06-14).
// Each is invoked through bare-name `restoreWorklistDraft(...)` from
// xmlui markup or other xs code, which resolves to the xs delegator,
// which routes here. The cost saving is per-call body collapse: each
// of these used to run through processStatementQueueAsync's 3-await
// loop for every statement in the body; now the entire body runs as
// one plain-JS function call (one xs statement total).

var __bramWorklistDraftPersistTimer = null;
var __bramWorklistDraftPending = null;

function __bramFlushWorklistDraft() {
  if (__bramWorklistDraftPersistTimer) {
    clearTimeout(__bramWorklistDraftPersistTimer);
    __bramWorklistDraftPersistTimer = null;
  }
  if (__bramWorklistDraftPending !== null) {
    __bramWriteLS("bram.worklistMessageDraft", __bramWorklistDraftPending);
    __bramWorklistDraftPending = null;
  }
}

window.__bramRestoreWorklistDraft = function () {
  return __bramReadLS("bram.worklistMessageDraft", "");
};

window.__bramPersistWorklistDraft = function (text) {
  __bramWorklistDraftPending = String(text || "");
  if (__bramWorklistDraftPersistTimer) clearTimeout(__bramWorklistDraftPersistTimer);
  __bramWorklistDraftPersistTimer = setTimeout(__bramFlushWorklistDraft, 400);
};

window.__bramClearWorklistDraft = function () {
  if (__bramWorklistDraftPersistTimer) {
    clearTimeout(__bramWorklistDraftPersistTimer);
    __bramWorklistDraftPersistTimer = null;
  }
  __bramWorklistDraftPending = null;
  __bramWriteLS("bram.worklistMessageDraft", "");
};

window.__bramFlushWorklistDraft = __bramFlushWorklistDraft;

window.addEventListener("beforeunload", __bramFlushWorklistDraft);

// Message Agent composer fast path. Normal typing pays only the existing
// debounced draft-persistence call plus one false branch. The frame probe is
// opt-in so performance instrumentation cannot itself tax ordinary input:
// call `window.__bramArmMessageAgentPerf()` in the Inspector console, type a
// representative burst, then blur the box (or call
// `window.__bramFlushMessageAgentPerf('manual')`). One aggregate trace is
// emitted; no message text or per-key trace leaves the iframe.
var __bramMessageAgentPerf = {
  armed: false,
  pending: 0,
  samples: [],
  startedAt: 0,
};

function __bramMessageAgentPerfSummary() {
  var values = __bramMessageAgentPerf.samples.slice().sort(function (a, b) { return a - b; });
  var count = values.length;
  function percentile(p) {
    if (!count) return 0;
    return values[Math.min(count - 1, Math.floor((count - 1) * p))];
  }
  var sum = values.reduce(function (n, value) { return n + value; }, 0);
  return {
    samples: count,
    pending: __bramMessageAgentPerf.pending,
    meanMs: count ? Math.round((sum / count) * 10) / 10 : 0,
    medianMs: Math.round(percentile(0.5) * 10) / 10,
    p95Ms: Math.round(percentile(0.95) * 10) / 10,
    maxMs: count ? Math.round(values[count - 1] * 10) / 10 : 0,
    over16Ms: values.filter(function (value) { return value > 16.7; }).length,
    over33Ms: values.filter(function (value) { return value > 33.4; }).length,
    durationMs: __bramMessageAgentPerf.startedAt
      ? Math.max(0, Math.round(performance.now() - __bramMessageAgentPerf.startedAt))
      : 0,
  };
}

window.__bramArmMessageAgentPerf = function () {
  __bramMessageAgentPerf.armed = true;
  __bramMessageAgentPerf.pending = 0;
  __bramMessageAgentPerf.samples = [];
  __bramMessageAgentPerf.startedAt = performance.now();
  return true;
};

window.__bramMessageAgentPerfSnapshot = function () {
  return __bramMessageAgentPerfSummary();
};

window.__bramFlushMessageAgentPerf = function (reason) {
  if (!__bramMessageAgentPerf.armed) return null;
  var summary = __bramMessageAgentPerfSummary();
  __bramMessageAgentPerf.armed = false;
  window.__bramIframeTrace("message-agent-latency", Object.assign({
    stage: "change-to-frame",
    reason: reason || "manual",
  }, summary));
  return summary;
};

// The Footer composer and WorklistGateBar are isolated sibling components.
// A plain window mirror lets the gate read the text at click time, but it does
// not give XMLUI a reactive dependency for the Refine button's enabled state.
// Publish the mirror through the same External/PushSource factory shape as the
// Worklist selection bridge below, so each keystroke invalidates only the gate
// bar rather than widening the composer's hot render boundary.
window.__bramMessageAgentText = String(window.__bramMessageAgentText || "");
window.bramSubscribeMessageAgentText = (function () {
  var factory;
  var subscribers = new Set();
  window.__bramSetMessageAgentText = function (text) {
    var next = typeof text === "string" ? text : "";
    if (next === window.__bramMessageAgentText) return;
    window.__bramMessageAgentText = next;
    subscribers.forEach(function (fn) {
      try { fn(); } catch (e) { console.error("[bramSubscribeMessageAgentText] subscriber threw:", e); }
    });
  };
  return function () {
    if (factory) return factory;
    factory = function (emit) {
      var fire = function () { emit(String(window.__bramMessageAgentText || "")); };
      subscribers.add(fire);
      fire();
      return function () { subscribers.delete(fire); };
    };
    return factory;
  };
})();

// Gate actions run in a sibling component, so let the mounted composer clear
// its own TextArea inside XMLUI context. Exporting a closure over `composerBox`
// to a window singleton proved unreliable when the action changed Worklist
// state before invoking it: the persisted draft cleared, but the live control
// kept its value when the user returned to another tab.
window.__bramComposerClearTick = Number(window.__bramComposerClearTick || 0);
window.bramSubscribeComposerClear = (function () {
  var factory;
  var subscribers = new Set();
  window.__bramRequestComposerClear = function () {
    window.__bramComposerClearTick += 1;
    subscribers.forEach(function (fn) {
      try { fn(); } catch (e) { console.error("[bramSubscribeComposerClear] subscriber threw:", e); }
    });
  };
  return function () {
    if (factory) return factory;
    factory = function (emit) {
      var fire = function () { emit(window.__bramComposerClearTick); };
      subscribers.add(fire);
      return function () { subscribers.delete(fire); };
    };
    return factory;
  };
})();

window.__bramMessageAgentInputChanged = function (text) {
  // issue-278: live mirror of the composer's text.
  //
  // The Worklist had its own "Message about the selection" box, duplicating
  // this one. Jon: "The duplication of the message box here is resolved by
  // only having one of them ... when you're on the Worklist page, it's
  // targeting the selected set." So the gate buttons move to the Footer and
  // read THIS box. The persisted draft below is debounced and would lag a
  // click; this mirror is synchronous.
  window.__bramSetMessageAgentText(text);
  window.__bramPersistWorklistDraft(text);
  if (!__bramMessageAgentPerf.armed || typeof requestAnimationFrame !== "function") return;
  var started = performance.now();
  __bramMessageAgentPerf.pending += 1;
  requestAnimationFrame(function () {
    __bramMessageAgentPerf.pending = Math.max(0, __bramMessageAgentPerf.pending - 1);
    if (!__bramMessageAgentPerf.armed) return;
    if (__bramMessageAgentPerf.samples.length < 500) {
      __bramMessageAgentPerf.samples.push(performance.now() - started);
    }
  });
};

// True when the composer is acting on a Worklist selection rather than
// speaking to the agent generally. Drives the placeholder and the gate
// buttons' enablement from one place, so they cannot disagree.
window.__bramComposerTargetsSelection = function () {
  var onWorklist = false;
  try { onWorklist = String(location.hash || "").indexOf("/worklist2") >= 0; } catch (e) {}
  return onWorklist && (window.__bramW2Selection || []).length > 0;
};

// switch-to-transcript-on-action: the placeholder IS the addressee label
// (Jon: "No extra line. We need to reuse the placeholder that we already
// have."). Claim-aware per the item draft's resolution 1 — work in flight
// outranks the tab, because the auto-switch relocates the user as a side
// effect of acting and must not silently re-address their next message.
// Signal only: authorization behavior is unchanged until this model
// survives a drive. Args are the caller's reactive deps; each falls back
// to the window read for any legacy caller.
// No claim-aware branch here, deliberately (Jon, 2026-09-07): a placeholder
// that turns into a status message conflates teaching with reporting — the
// combined footer context line (__bramFooterContextLine) carries in-flight
// status now, and the placeholder always tells you what Enter will do.
window.__bramComposerPlaceholder = function (pathname, sel) {
  var selection = sel || window.__bramW2Selection || [];
  var route = String(
    pathname != null ? pathname : (function () { try { return location.hash; } catch (e) { return ""; } })()
  );
  // The root route renders the Worklist (and its gate bar) too — Main.xmlui's
  // gate-bar `when` includes '/', so the buttons-above sentence is true there.
  var onWorklist = route.indexOf("/worklist") >= 0 || route === "/" || route === "#/";
  // Feedback elevated to a first-class concept (Jon's spec, 2026-09-07;
  // the Feedback button retired same day — with a selection, Enter and the
  // gate buttons all send feedback, so the placeholder carries the
  // teaching): with a selection the composer IS a feedback box everywhere;
  // the Worklist wording names the buttons, since there they are. Chat is
  // the per-message escape. Idle, it chats.
  if (selection.length > 0) {
    // Refine retired (same item, later round): Enter IS the feedback-only
    // verb now, and the gate buttons are pure lifecycle — each sends this
    // message along WITH its action. The wording teaches that split.
    if (onWorklist) {
      return "Feedback about selection: Enter sends it; the buttons above send it with their action. Shift+Enter newline, Ctrl-V/Cmd-V paste screenshot. Chat to talk with the agent about anything.";
    }
    return "Feedback about selection: Enter sends, Shift+Enter newline, Ctrl-V/Cmd-V paste screenshot. Chat to talk with the agent about anything.";
  }
  return "Chat with agent: Enter sends, Shift+Enter newline, Ctrl-V/Cmd-V paste screenshot.";
};

// switch-to-transcript-on-action: Feedback as a first-class verb. The
// composer's Feedback path is the gate's Refine in composer clothing — the
// same fan-out machinery (__bramWorklist2BatchIterate), the same staged-image
// markers, the same post-send transcript switch — so "message the items" is
// one mechanism whichever surface invokes it.
window.__bramSubmitFeedbackForSelection = function (box) {
  var sel = (window.__bramW2Selection || []).slice();
  if (!sel.length) return false;
  var message = "";
  try { message = String((box && box.value) || "").trim(); } catch (e) {}
  if (!message) return false;
  window.__bramIframeTrace("click", { target: "composer-feedback", op: "act", count: sel.length });
  var body = window.__bramWithStagedImageMarkers(message, "feedback");
  window.__bramWorklist2BatchIterate(sel, body);
  // The selection deliberately SURVIVES a feedback send (Jon's repro,
  // 2026-09-07: send → auto-switch → return → "found it unselected").
  // Clearing was inherited from gate-Refine, but clearing fits LIFECYCLE
  // actions, whose selection is consumed by the stage change; feedback is a
  // conversation, and conversations continue — the next Enter addresses the
  // same set, and the footer context line keeps naming it.
  window.__bramClearComposer();
  try { if (box && typeof box.setValue === "function") box.setValue(""); } catch (e) {}
  window.__bramGateGoTranscript();
  return true;
};

// Enter routes by selection (spec cases 1 / 2A / 2B): a live selection makes
// Enter send feedback about it; idle, Enter chats. The Chat button bypasses
// this router and always chats — the per-message escape the placeholder names.
window.__bramComposerEnterSubmit = function (box) {
  if ((window.__bramW2Selection || []).length > 0) {
    return window.__bramSubmitFeedbackForSelection(box);
  }
  return window.__bramSubmitMessageAgentComposer(box, "");
};

// The Footer composer is now the Worklist's message box too, so the gate
// buttons must be able to clear it after a send. Same register/clear shape as
// registerContextMemorySelector: the composer owns the widget, the gate owns
// the action, and neither imports the other.
// One entry point for every gate button, so the five actions cannot drift
// apart and the markup stays a single call per handler (the xs engine's hard
// rule). Ports the inline gate row's handlers verbatim; the only substitutions
// are where the state now lives: selection from the pane-wide store, message
// text from the single Footer composer.
window.__bramGateSent = [];
window.__bramGateBarLabel = function (sel) {
  var ids = sel || [];
  if (!ids.length) return "";
  return ids.length + " selected \u00b7 " + ids[0] +
    (ids.length > 1 ? " +" + (ids.length - 1) : "");
};
window.__bramGateHasText = function () {
  return String(window.__bramMessageAgentText || "").trim().length > 0;
};
window.__bramW2ShareMode = "together";
window.__bramW2SetShareMode = function (m) { window.__bramW2ShareMode = m || "together"; };
window.__bramW2CloseMap = {};
window.__bramW2SetCloseMap = function (m) { window.__bramW2CloseMap = m || {}; };

// issue-328: close consent at the gate. The row-expansion toggles were the
// only consent surface and lived behind an expansion nobody is required to
// open, so `close-issue: N` reached the payload invisibly (Walt's 0.6.2
// receipt: "closes #8" as settled fact, no tick box in sight). These two
// helpers put a real checkbox per issue in the gate bar, wired to the SAME
// map the row toggles and the payload builder use, so the surfaces cannot
// disagree. Known small caveat: a later row-expansion toggle replaces the
// whole map from the page var and can drop a gate untick made for a
// DIFFERENT item in the same window — acceptable for the look/feel trial,
// noted here so the next editor inherits it.
window.__bramGateCloseToggle = function (itemId, issueNumber, checked, closesIssues) {
  window.__bramW2CloseMap = window.__bramInlineCloseToggle(
    window.__bramW2CloseMap, itemId, issueNumber, checked, closesIssues);
};
// The row-expansion comment box writes the window map directly too (the
// expansion's own checkbox is GONE — gate-only toggle, Jon 2026-09-05),
// which retires the whole-map-replace clobber the page-var mirror had.
// issue-338 dismiss, driven directly from the CLICK. Jon's testbed drive
// (2026-09-05) showed the host records the dismiss instantly (POST returns
// in 0 ms) but the row lingered ~30 s before the event-driven refetch ran.
// Root cause not established — and deliberately NOT blamed on general
// PushSource latency, which the rest of the pane disproves every day; an
// exact 30 s reads more like a timer this listener happened to wait for.
// The fix stands on principle regardless: a user action should drive its
// own feedback synchronously. This POSTs via fetch (real JS, as
// replayLatest already does) and refetches the DataSource the moment the
// POST returns — a DataSource value change re-renders promptly. The
// needs-you-changed listener stays for background "new activity" updates,
// where a beat of latency is invisible.
window.__bramDismissForgeItem = function (ds, id, marker) {
  if (typeof window.fetch !== "function") return;
  window.__bramIframeTrace("inbox-dismiss-click", { id: id });
  window
    .fetch("/__needs-you/dismiss", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: id, activityMarker: marker }),
    })
    .then(function () {
      if (ds && typeof ds.refetch === "function") ds.refetch();
    })
    .catch(function () {});
};

window.__bramGateCloseComment = function (itemId, issueNumber, text, closesIssues) {
  window.__bramW2CloseMap = window.__bramInlineCloseComment(
    window.__bramW2CloseMap, itemId, issueNumber, text, closesIssues);
};
// Flat rows for the gate line: selected items' closesIssues with their
// current effective tick state (absent map entry = default all-ticked,
// same rule as __bramInlineCloseState).
window.__bramGateCloseItems = function (items, sel) {
  var out = [];
  var chosen = sel || [];
  (items || []).forEach(function (it) {
    if (!it || chosen.indexOf(it.id) < 0) return;
    var closes = it.closesIssues || [];
    if (!closes.length) return;
    var st = window.__bramInlineCloseState(window.__bramW2CloseMap, it);
    closes.forEach(function (e) {
      var n = e && typeof e === "object" ? e.number : e;
      var t = e && typeof e === "object" ? e.title || "" : "";
      var cur = st[n] || { close: true, comment: "" };
      out.push({
        itemId: it.id,
        number: n,
        title: t,
        close: !!cur.close,
        closesIssues: closes,
      });
    });
  });
  return out;
};

// Ported verbatim from the five inline gate handlers. The differences between
// them are real and easy to lose, so they are spelled out rather than folded:
//   start          kind=approved
//   start-commit   kind=approved + oneShot + closeMap
//   commit         kind=approved + oneShot computed from the selection + closeMap
//   drop           kind=drop
//   iterate        a DIFFERENT call entirely (__bramWorklist2BatchIterate),
//                  taking the raw feedback string rather than a fanned map
window.__bramGateAct = function (kind, items, sel, shareMode) {
  // Selection is literal user intent. Shared-file handling may change how the
  // agent prepares the commit, but never which ids this action authorizes.
  var ids0 = sel || [];
  // issue-343: the trace comes FIRST — the old order (guard, then trace)
  // made a click with an empty selection a perfectly silent no-op, which is
  // exactly the evidence signature Andrew reported: no click line, no
  // publish, no auth write, three times. The guard stays; it just can no
  // longer hide.
  window.__bramIframeTrace("click", {
    target: "gatebar-" + kind,
    count: ids0.length,
    op: ids0.length ? "act" : "empty-selection",
    store: (window.__bramW2Selection || []).length,
  });
  if (!ids0.length) return;
  var text = String(window.__bramMessageAgentText || "");
  var body = window.__bramWithStagedImageMarkers(text, "feedback");
  if (kind === "commit" || kind === "start-commit") {
    body = window.__bramWithShareMode(body, shareMode || "together", items, ids0, null);
  }
  var filter = (kind === "start" || kind === "start-commit") ? "proposed" : "";
  var ids = window.__bramSelectionIds(items, ids0, filter);
  window.__bramGateSent = window.__bramWorklist2CaptureSent(
    window.__bramGateSent, ids, text, Date.now());

  if (kind === "iterate") {
    window.__bramWorklist2BatchIterate(ids, body);
    window.__bramW2SetSelection([]);
    window.__bramClearComposer();
    window.__bramGateGoTranscript();
    return;
  }

  // issue-340: a FEEDBACK-LESS drop goes host-direct — POST /__worklist/drop
  // does record-auth + resolve + prune in ~0.1s, instead of toTurn-ing a
  // `drop:` turn to the agent (a ~90s window an accidental Drop could not
  // interrupt from the pane). A drop carrying feedback still goes through the
  // agent below so it can answer the feedback. The refetch that clears the
  // rows fires from the worklist-changed event the route emits.
  if (kind === "drop" && !String(text || "").trim()) {
    window
      .fetch("/__worklist/drop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: ids }),
      })
      .catch(function () {});
    window.__bramW2SetSelection([]);
    window.__bramClearComposer();
    return;
  }

  var opts = {
    items: items,
    selectedIds: ids,
    feedbackDraftsById: window.__bramFanFeedback(ids, body),
  };
  if (kind === "drop") {
    opts.kind = "drop";
  } else {
    opts.kind = "approved";
    if (kind === "start-commit") {
      opts.oneShot = true;
      opts.closeMap = window.__bramW2CloseMap;
    } else if (kind === "commit") {
      opts.oneShot = window.__bramSelectionNeedsProposedCommit(items, ids0);
      opts.closeMap = window.__bramW2CloseMap;
    }
  }
  var r = window.__bramPrepareBatchWorklistActionSubmission(opts);
  window.__bramW2SetSelection([]);
  window.__bramClearComposer();
  window.__bramWorklistActApply(r);
  window.__bramGateGoTranscript();
};

// prototype-gate-on-transcript round 4 (docs/transcript-gate-unification.md):
// a gate press hands the user the evidence surface — the Transcript — where
// the agent's work on the just-approved items streams in. The Worklist's
// last-exchange dock retired in the same round; this is its replacement
// direction (act → watch, instead of excerpt-beside-buttons). Agent-bound
// actions only: the host-direct feedback-less Drop resolves in ~0.1s with
// nothing to watch, so it stays put (see the drop branch above, which
// returns before reaching the callers of this helper).
window.__bramGateGoTranscript = function () {
  try {
    if (String(window.location.hash || "").indexOf("/transcript") < 0) {
      window.location.hash = "#/transcript";
    }
  } catch (e) {}
};

window.__bramClearComposer = function () {
  window.__bramSetMessageAgentText("");
  try { window.__bramRequestComposerClear(); } catch (e) {}
  try { window.__bramClearWorklistDraft(); } catch (e) {}
};

window.__bramMessageAgentBlur = function () {
  __bramFlushWorklistDraft();
  return window.__bramFlushMessageAgentPerf("blur");
};

window.__bramSubmitMessageAgentComposer = function (box, mode) {
  var message = "";
  try { message = String((box && box.value) || "").trim(); } catch (e) {}
  if (!message) return false;
  var result = window.__bramPrepareWorklistMessageSubmission({
    text: message,
    mode: mode || "",
    voiceTarget: "message-agent",
  });
  if (!result || !result.submitted) return false;
  try { if (box && typeof box.setValue === "function") box.setValue(""); } catch (e) {}
  window.__bramClearWorklistDraft();
  return true;
};

window.__bramOpenSkillsLauncher = function (skillsList, skillsDialog) {
  try { if (skillsList && typeof skillsList.refetch === "function") skillsList.refetch(); } catch (e) {}
  try { if (skillsDialog && typeof skillsDialog.open === "function") skillsDialog.open(); } catch (e) {}
};

// Worklist UI state model is now multi-expand: any number of items can be
// "open" simultaneously, each with its own feedback-draft text. State shape:
//   { expandedItemIds: string[], feedbackDraftsById: Record<string, string> }
// Legacy fields (selected, expandedItemId, feedbackExpanded, selectedFeedback)
// are honored on read for migration from pre-sticky-expansion sessions; they
// are never written back. After the first save in the new shape, the legacy
// keys disappear.
window.__bramReadWorklistUiStateObject = function () {
  var raw = __bramReadLS("bram.worklistUiState", "");
  if (!raw) return {};
  var saved;
  if (typeof raw === "object") {
    saved = raw;
  } else {
    try { saved = JSON.parse(raw); } catch (e) { saved = null; }
  }
  return (saved && typeof saved === "object") ? saved : {};
};

window.__bramRestoreWorklistUiState = function (field) {
  var saved = window.__bramReadWorklistUiStateObject();
  if (field === "expandedItemIds") {
    // New canonical field. Fall back to legacy single-id on first migration.
    var arr = Array.isArray(saved.expandedItemIds) ? saved.expandedItemIds.slice() : null;
    if (!arr) {
      var legacy = saved.expandedItemId || saved.selected || null;
      arr = legacy ? [legacy] : [];
    }
    window.__bramIframeTrace("worklist-ui-state-restore", { field: field, count: arr.length });
    return arr;
  }
  if (field === "feedbackDraftsById") {
    // New canonical field. Migrate legacy { selected, selectedFeedback }.
    var map = (saved.feedbackDraftsById && typeof saved.feedbackDraftsById === "object")
      ? Object.assign({}, saved.feedbackDraftsById)
      : null;
    if (!map) {
      map = {};
      if (saved.selected && saved.selectedFeedback) {
        map[saved.selected] = String(saved.selectedFeedback);
      }
    }
    window.__bramIframeTrace("worklist-ui-state-restore", { field: field, count: Object.keys(map).length });
    return map;
  }
  // Legacy single-value fields retained for any stragglers; new code shouldn't read these.
  if (field === "feedbackExpanded") return !!saved.feedbackExpanded;
  if (field === "selectedFeedback") return String(saved.selectedFeedback || "");
  if (field === "selected") return saved.selected || null;
  if (field === "expandedItemId") return saved.expandedItemId || null;
  return null;
};

window.__bramPersistWorklistUiState = function (state) {
  // state: { expandedItemIds: string[], feedbackDraftsById: Record<string, string> }
  var ids = (state && Array.isArray(state.expandedItemIds)) ? state.expandedItemIds.slice() : [];
  var drafts = (state && state.feedbackDraftsById && typeof state.feedbackDraftsById === "object") ? state.feedbackDraftsById : {};
  // Garbage-collect drafts whose item is no longer expanded — keeps storage bounded.
  var prunedDrafts = {};
  for (var i = 0; i < ids.length; i++) {
    var id = ids[i];
    if (drafts[id]) prunedDrafts[id] = String(drafts[id]);
  }
  window.__bramIframeTrace("worklist-ui-state-save", {
    expandedCount: ids.length,
    draftCount: Object.keys(prunedDrafts).length,
  });
  __bramWriteLS("bram.worklistUiState", JSON.stringify({
    expandedItemIds: ids,
    feedbackDraftsById: prunedDrafts,
  }));
};

window.__bramClearWorklistUiState = function () {
  window.__bramIframeTrace("worklist-ui-state-clear", {});
  __bramWriteLS("bram.worklistUiState", "");
};

window.__bramRestoreWorklistSubmittedMessage = function () {
  return __bramReadLS("bram.worklistSubmittedMessage", "");
};

window.__bramRestoreWorklistSessionSubmittedMessage = function () {
  return __bramReadSS("bram.worklistSessionSubmittedMessage", "");
};

window.__bramShouldDimAgentDockOnMount = function () {
  var key = "bram.agentDockLaunchDimConsumed";
  var consumed = __bramReadSS(key, "");
  if (consumed === "1") return false;
  __bramWriteSS(key, "1");
  return true;
};

window.__bramRestoreWorklistSubmittedKind = function () {
  var kind = __bramReadLS("bram.worklistSubmittedKind", "");
  return kind === "message" || kind === "action" ? kind : null;
};

window.__bramSetWorklistSubmittedKind = function (kind) {
  if (kind === "message" || kind === "action") {
    __bramWriteLS("bram.worklistSubmittedKind", kind);
  } else {
    __bramWriteLS("bram.worklistSubmittedKind", "");
  }
  return kind || null;
};

window.__bramRestoreSplitterSize = function (key, fallback) {
  var raw = __bramReadLS("bram.splitter." + key, "");
  var s = String(raw || "").trim();
  var n = parseFloat(s);
  var hasUnit = /(?:px|%)$/i.test(s);
  var result = (!isNaN(n) && n > 0)
    ? (hasUnit ? s : (n < 100 ? (n + "%") : (n + "px")))
    : fallback;
  window.__bramIframeTrace("splitter-restore", { key: key, raw: raw, result: result });
  return result;
};

window.__bramSaveSplitterSize = function (key, sizes) {
  if (Array.isArray(sizes)) {
    var a = Number(sizes[0]);
    var b = Number(sizes[1]);
    var total = a + b;
    var pct = total > 0 ? (a / total) * 100 : 0;
    window.__bramIframeTrace("splitter-save", { key: key, sizes: sizes, pct: pct, unit: "%" });
    if (pct > 0 && pct < 100) {
      __bramWriteLS("bram.splitter." + key, String(Math.round(pct * 10) / 10) + "%");
    }
    return;
  }
  var px = Number(sizes);
  window.__bramIframeTrace("splitter-save", { key: key, sizes: sizes, px: px, unit: "px" });
  if (px > 0) {
    __bramWriteLS("bram.splitter." + key, String(Math.round(px)) + "px");
  }
};

// Body strings for the Settings tab info dialogs. Lifted out of
// Settings.xmlui to keep the markup readable; the dialog itself
// stays inline in Settings since it's a single consumer.
window.settingsInfoBodies = {
  shell:
    "## Agent\n\n" +
    "The default agent used by agent-scoped launch choices and as the fallback when no valid last-active Bram session exists.\n\n" +
    "## On Bram launch\n\n" +
    "**Resume selected agent's most recent session** uses the Agent selection above.\n\n" +
    "**Resume most-recently-active agent's session** reopens the exact Claude or Codex session Bram was actually using before shutdown.\n\n" +
    "**Start a new session** starts the selected Agent fresh.\n\n" +
    "## Advanced\n\n" +
    "Launch arguments are extra CLI flags. First command is sent to the agent's TUI after startup. Both apply whichever startup choice is used.",
  batchCommitActions:
    "## Mirror Worklist lifecycle to GitHub issues\n\n" +
    "Post Worklist lifecycle comments to linked GitHub issues.",
  ui:
    "## Show target app\n\n" +
    "Show the embedded target-app preview pane. Usually off.\n\n" +
    "## Agent-pane hot-reload\n\n" +
    "Auto-reload the agent pane as you edit Bram's own source. For developing Bram.\n\n" +
    "## Show tips in the footer\n\n" +
    "Show rotating tips in the footer.\n\n" +
    "## Soft beep on menus and turn completion\n\n" +
    "Play a soft beep when a permission menu appears or a turn finishes.\n\n" +
    "## Dismissed tips return after\n\n" +
    "How long a dismissed tip stays hidden before showing again.\n\n" +
    "## Search badges start all on\n\n" +
    "Whether the Search tab opens with all facet badges selected, or none.",
  ai:
    "## Tool Descriptions\n\n" +
    "The one-line intent header on Transcript tool rows.\n\n" +
    "**For Claude** — rows already lead with Claude's own words: Bash tool " +
    "descriptions, and the narration preceding other calls. No key, nothing " +
    "to turn on. When the toggle is on, Bram uses Haiku to enhance them.\n\n" +
    "**For Codex** — no native descriptions; rows show the raw command. " +
    "When the toggle is on, Bram uses Haiku to create descriptions.\n\n" +
    "Flipping the toggle off hides existing Haiku descriptions; flipping it " +
    "back on restores them from cache at no cost — flip freely to compare.\n\n" +
    "On sends tool material (command, diff, context, result excerpt) to the " +
    "Anthropic API — needs `ANTHROPIC_API_KEY`, billed per-token. " +
    "Credentials are redacted heuristically, not guaranteed. If Claude Code " +
    "also accepts the key, run `/config` → turn off \"Use custom API key\" " +
    "to keep it Bram-only.\n\n" +
    "Stored in `.bram.json` as `ai.describeCommands`.",
  search:
    "## Commit depth\n\n" +
    "How many of the newest commits the search index covers, messages and " +
    "diffs (100–20,000, default 2,000); deeper indexing lengthens the next " +
    "cold rebuild proportionally.\n\n" +
    "## Issue limit\n\n" +
    "How many forge issues the Issues tab and search index fetch " +
    "(50–2,000, default 500).",
  traces:
    "## Tracing enabled\n\n" +
    "Master switch for writes to `bram-trace.log`. **On by default** — " +
    "switch it off here to silence traces for this project. `BRAM_TRACE` " +
    "in the environment overrides either way.\n\n" +
    "## Inspector trace tap\n\n" +
    "Forward XMLUI Inspector events into the trace log. Requires Tracing " +
    "enabled.\n\n" +
    "## Keep raw traces for (days)\n\n" +
    "Raw archives older than this are sanitized and gzipped at startup " +
    "(1–3650, default 14). Compressed history is kept indefinitely.",
};

// Settings.xmlui owns its explicit-save drafts with scoped Forms. This is the
// small host-shape adapter around the native Form reset(data) lifecycle.
window.__bramSettingsFormData = function (settings, section) {
  var s = settings || {};
  if (section === "shell") {
    var shell = s.shell || {};
    var policy = shell.startupPolicy;
    if (policy !== "lastActive" && policy !== "agentRecent" && policy !== "newSession") {
      policy = shell.continueLast === false ? "newSession" : "agentRecent";
    }
    return {
      agent: shell.agent === "codex" ? "codex" : "claude",
      startupPolicy: policy,
      args: shell.args == null ? "" : String(shell.args),
      firstCommand: shell.firstCommand == null ? "" : String(shell.firstCommand),
    };
  }
  if (section === "traces") {
    var traces = s.traces || {};
    return { archiveAfterDays: Number(traces.archiveAfterDays || 14) };
  }
  if (section === "search") {
    var search = s.search || {};
    return {
      commitDepth: Number(search.commitDepth || 2000),
      issueLimit: Number(search.issueLimit || 500),
    };
  }
  return {};
};

window.__bramSettingsSectionUpdate = function (section, data) {
  var update = {};
  update[section] = data || {};
  return update;
};

window.__bramAdoptSettingsForm = function (form, settings, section) {
  if (!form || typeof form.reset !== "function") return;
  form.reset(window.__bramSettingsFormData(settings, section));
};

window.__bramSyncSettingsForm = function (settings, form, section) {
  if (!settings || !form || typeof form.isDirty !== "function" || form.isDirty()) return;
  var next = window.__bramSettingsFormData(settings, section);
  var current = typeof form.getData === "function" ? form.getData() : {};
  if (JSON.stringify(current) !== JSON.stringify(next)) form.reset(next);
};

// "Claude Code" for the claude provider, Title-cased provider name
// otherwise ("codex" → "Codex"). Falls back through
// mainAgentStatus.provider → enhanceStatus.activeProvider → '' so the
// idle state still gets a label. Guards mainAgentStatus against null.
window.providerDisplayName = function (mainAgentStatus, enhanceStatusValue) {
  var p =
    (mainAgentStatus && mainAgentStatus.provider) ||
    (enhanceStatusValue && enhanceStatusValue.activeProvider) ||
    "";
  if (p === "claude") return "Claude Code";
  return p ? p.charAt(0).toUpperCase() + p.slice(1) : p;
};

// Should the idle-state provider label be visible? True when we have
// some agent state, we're NOT currently working or finished, and
// there's a provider name available to display.
window.shouldShowIdleProvider = function (mainAgentStatus, enhanceStatusValue) {
  if (!mainAgentStatus && !enhanceStatusValue) return false;
  if (mainAgentStatus &&
      (mainAgentStatus.state === "working" || mainAgentStatus.state === "finished")) {
    return false;
  }
  return Boolean(
    (mainAgentStatus && mainAgentStatus.provider) ||
    (enhanceStatusValue && enhanceStatusValue.activeProvider)
  );
};

// "<provider> <verb>… (<elapsed> · <substate>)" for the working state. Now
// that the grid supplies clean full-fidelity elapsed + the substate signal
// ("thinking", "almost done thinking", …), surface them on the row. Tokens
// intentionally omitted (per user: distracting).
window.headerWorkingLabel = function (mainAgentStatus, enhanceStatusValue) {
  var s = mainAgentStatus || {};
  var verb = s.verb || "working";
  var label =
    window.providerDisplayName(mainAgentStatus, enhanceStatusValue) +
    ": " +
    verb +
    "…";
  var detail = [s.elapsedText, s.substate].filter(Boolean).join(" · ");
  return detail ? label + " (" + detail + ")" : label;
};

// "<provider> <verb> · <elapsed>[ · N subagent(s) working]" for the finished
// state. Verb fall-through: status.verb (when finished) → status.verb (when
// non-working) → lastSeenAgentVerb (when non-working) → "Finished".
// surface-delegated-work-in-flight: the optional 4th arg is the count of
// still-running roster entries. Kept as a plain number (not a store read)
// so the caller controls reactivity — FooterAgentStatus.xmlui passes it as
// a $props value derived from the footerAgents DataSource in Main.xmlui,
// which the binding engine tracks as a dependency the same way it already
// tracks $props.enhanceStatus. A store read inside this function would NOT
// re-evaluate on roster change; this function stays pure (label in, label
// out) precisely to avoid that trap.
window.headerFinishedLabel = function (mainAgentStatus, enhanceStatusValue, lastSeenAgentVerb, runningSubagentCount) {
  var s = mainAgentStatus || {};
  var verb;
  if (s.state === "finished") {
    verb = s.verb || "Finished";
  } else if (s.verb && s.verb !== "working") {
    verb = s.verb;
  } else if (lastSeenAgentVerb && lastSeenAgentVerb !== "working") {
    verb = lastSeenAgentVerb;
  } else {
    verb = "Finished";
  }
  var base = window.providerDisplayName(mainAgentStatus, enhanceStatusValue) + ": " + verb;
  var label = base + (s.elapsedText ? " · " + s.elapsedText : "");
  var n = runningSubagentCount || 0;
  if (n > 0) {
    label += " · " + n + " " + (n === 1 ? "subagent" : "subagents") + " working";
  }
  return label;
};

// Compute the next sort state for a clickable table-header. If the
// column is already active, flip the direction; otherwise switch to
// the new column with its default direction. Returns {field, dir}.
window.toggleSort = function (currentField, currentDir, newField, defaultDir) {
  if (currentField === newField) {
    return { field: newField, dir: currentDir === "asc" ? "desc" : "asc" };
  }
  return { field: newField, dir: defaultDir };
};

// Render a table-header label with an active-column arrow.
// "STATE ↑" / "STATE ↓" if currentField matches; "STATE" otherwise.
window.sortLabel = function (label, currentField, currentDir, fieldName) {
  if (currentField !== fieldName) return label;
  return label + (currentDir === "asc" ? " ↑" : " ↓");
};

// Select the list to display in a searchable tab. If query is 2+
// chars, return the search results (accepting either the raw-array
// shape Sessions uses or the {results} wrapper used elsewhere).
// Otherwise return the full list. Used by Feedback, History, Issues,
// Sessions.
window.selectDisplayed = function (query, searchValue, fullList) {
  if (query && query.trim().length >= 2) {
    if (Array.isArray(searchValue)) return searchValue;
    return (searchValue && searchValue.results) || [];
  }
  return fullList || [];
};

// Normalize a path/URL for an XMLUI Image's src binding. Pass through
// data: and http(s) URLs verbatim; otherwise route through the
// /__file?path= shim with optional file://(localhost)? prefix stripped.
// Used by every Image preview in the agent pane.
window.imageSrcForPath = function (path) {
  var p = path || "";
  if (p.startsWith("data:") || p.startsWith("http")) return p;
  var cleaned = p.startsWith("file://")
    ? p.replace(/^file:\/\/(localhost)?/, "")
    : p;
  return "/__file?path=" + encodeURIComponent(cleaned);
};

// extractImagePaths — extracts [Image: source: <path>] marker paths.
// Used by the submit path (staged-image bookkeeping); turn display
// resolution lives in the host projection.
window.__bramExtractImagePaths = function (text) {
  if (!text) return [];
  var paths = [];
  var imagePath = "(?:/[^\\]]+|[A-Za-z]:\\\\[^\\]]+)\\.(?:png|jpg|jpeg|gif|webp)";
  var re = new RegExp("\\[Image: source: (" + imagePath + ")\\]", "gi");
  var m;
  while ((m = re.exec(text)) !== null) paths.push(m[1]);
  return paths;
};
function __bramExtractImagePaths(text) {
  // Kept as a local alias so the step-3 submission trio above (defined
  // before the window helper) still resolves.
  return window.__bramExtractImagePaths(text);
}

// Submission trio. submitWorklistMessageFast needs the xs-side
// voiceTarget (still an xs var; step 4 will mirror it onto window).
// For now the xs delegator passes it as the third argument.
window.__bramSubmitWorklistMessageFast = function (text, voiceTarget) {
  if (!text || !text.trim()) return false;
  var userTyped = text.trim();
  var toSend = window.__bramWithStagedImageMarkers(userTyped, "message-agent", voiceTarget);
  var sentAt = Date.now();
  window.__bramIframeTrace("message-agent-submit", { stage: "before-toTurn", chars: toSend.length, sentAt: sentAt });
  if (typeof window.toTurn === "function") window.toTurn(toSend);
  window.__bramIframeTrace("message-agent-submit", { stage: "after-toTurn", chars: toSend.length, sentAt: sentAt });
  var baseline = 0;
  __bramWriteLS("bram.worklistMessageDraft", "");
  __bramWriteLS("bram.worklistSubmittedMessage", userTyped);
  __bramWriteSS("bram.worklistSessionSubmittedMessage", userTyped);
  window.__bramSetWorklistSubmittedKind("message");
  return { message: userTyped, images: __bramExtractImagePaths(toSend), baseline: baseline, sentAtText: new Date().toLocaleTimeString() };
};

window.__bramWithStagedImageMarkers = function (text, target, voiceTarget) {
  var requestedTarget = target || voiceTarget || "";
  var consumeTarget = requestedTarget;
  if (requestedTarget === "feedback") {
    var focusedFeedback = window.bramActiveFocusedFeedbackItemIdMirror || "";
    if (focusedFeedback) {
      consumeTarget = "feedback:" + focusedFeedback;
    } else if (window.bramCurrentPasteTarget) {
      consumeTarget = window.bramCurrentPasteTarget() || requestedTarget;
    }
  }
  bramTracePasteImage("with-markers", {
    requestedTarget: requestedTarget,
    voiceTarget: voiceTarget || "",
    consumeTarget: consumeTarget,
    pendingBefore: bramPendingPastedImageSummary()
  });
  var paths = window.bramConsumePastedImagePaths
    ? window.bramConsumePastedImagePaths(consumeTarget)
    : [];
  if (!paths || paths.length === 0) return text;
  var lines = paths.map(function (p) { return "Read this screenshot: @" + p + "\n[Image: source: " + p + "]"; });
  var markers = lines.join("\n");
  var skipPrefix = "skip-worklist:";
  var trimmedStart = (text || "").trimStart();
  if (trimmedStart.indexOf(skipPrefix) === 0) {
    var leading = text.slice(0, text.length - trimmedStart.length);
    var rest = trimmedStart.slice(skipPrefix.length).trimStart();
    return leading + skipPrefix + " " + markers + (rest ? "\n\n" + rest : "");
  }
  return text ? markers + "\n\n" + text : markers;
};

// Pure predicate — voice-target whitelist for text-input destinations.
// xs delegator in Globals.xs preserves the bare-name callability.
// Delivery allowlist for dictated text. A target NOT listed here falls through
// to `toTurn('voice: ' + t)` — the transcript is sent to the terminal as a user
// turn instead of landing in the box the user dictated into.
//
// This is a registration list, not a validation: IsolatedDraftEditor accepts any
// `voiceTarget` string and will happily set it, record with it, and trace it
// end to end, so a target missing from here fails ONLY at the last step and
// looks like a routing bug in the component. Observed 2026-08-18: the issue
// comment box was wired with `issue-comment:<n>`, the trace showed
// target=issue-comment:253 through `processing-start`, and the transcript still
// landed in the transcript pane via `stage=fallback-terminal`.
//
// Adding a voiceTarget prefix to any editor means adding it here too, in a
// different file on the rebuild path.
// Compose an IsolatedDraftEditor placeholder from what is actually wired.
//
// Callers pass only the lead ("Type a note"); the affordance clauses are
// derived from the props, so a placeholder cannot advertise a capability the
// editor does not have. Before this, each call site hand-wrote the whole
// string and they had drifted in both directions: the queue invited a
// screenshot paste with no pasteTarget (so no PastedImageStrip rendered and
// pasted images staged invisibly under the voice key), while the one editor
// that HAD paste wired never mentioned it.
//
// Wording is the queue's, which read well and is the reason this is a
// narrowing rather than a redesign.
window.__bramEditorPlaceholder = function (lead, hasPaste, hasVoice) {
  var base = String(lead == null ? "" : lead).trim();
  if (!base) return "";
  var clauses = [];
  if (hasPaste) clauses.push("paste a screenshot (Ctrl-V/Cmd-V)");
  if (hasVoice) clauses.push("dictate with the mic");
  if (!clauses.length) return base;
  if (clauses.length === 1) return base + ", or " + clauses[0] + ".";
  return base + ", " + clauses[0] + ", or " + clauses[1] + ".";
};

window.__bramIsWorklistTextVoiceTarget = function (target) {
  var t = target || "";
  return ["message-agent", "feedback", "new-item", "new-issue"].indexOf(t) !== -1
    || t.indexOf("feedback:") === 0
    || t.indexOf("queue-item:") === 0
    || t.indexOf("issue-comment:") === 0;
};

// Inflight + submitted-message helpers (audit step 6). All pure data
// transforms; xs delegators in Globals.xs preserve bare-name calls.
// The `approved` KIND is wire format and does not change; only the word the
// user reads does. The gate button is Start, so the verb is Starting.
window.__bramInflightActionLabel = function (kind) {
  if (kind === "approved") return "Starting";
  if (kind === "iterate") return "Refining";
  if (kind === "drop") return "Dropping";
  return "";
};

// Full header inflight-banner label: "<Action> <ids> (TO APPLY|TO COMMIT)".
// statusLabel is supplied by the /__inflight route from worklist.json.
// header-inflight-verbs: one verb, derived from host facts (claim kind +
// the claimed item's gate), replacing the kind-label + "(TO APPLY)"
// parenthetical — approving an applied item's commit is Committing, in
// the user's vocabulary, and the status badge language retires from the
// banner.
window.__bramClaimVerb = function (kind, statusLabel) {
  if (kind === "drop") return "Dropping";
  if (kind === "iterate") return "Refining";
  if (kind === "approved") {
    // The statusLabel test reads the LEGACY tab's badge string, which the host
    // still writes. Left as-is deliberately: it is a host fact rather than a
    // label, and changing what the host writes is a wider blast radius than
    // this rename. Starting/Committing match the two gate buttons.
    return statusLabel === "TO COMMIT" ? "Committing" : "Starting";
  }
  return kind ? kind.charAt(0).toUpperCase() + kind.slice(1) : "";
};

window.__bramInflightBannerLabel = function (claim) {
  if (!claim || !claim.ids || !claim.ids.length) return "";
  var ids = (claim.ids || []).join(", ");
  return window.__bramClaimVerb(claim.kind, claim.statusLabel) + " " + ids;
};

// switch-to-transcript-on-action: ONE footer context line instead of three
// competing signals (Jon: the selection must be visible from the Transcript,
// but no new footer lines — combine). Names the working set and, when work
// is in flight, the claim verb parenthesized:
//   "Selected in Worklist: a, b"            — selection, idle
//   "Selected in Worklist: a (Refining…)"   — claim live (claim ids win;
//     the gate clears the selection at submit, so the claim is the truth)
// Empty when neither, so the slot reserves space silently.
// switch-to-transcript-on-action: the new-below chip pulses gently while
// unseen content waits AND the agent is done — the beep's visual twin,
// answering "it registers activity but when you are done it just sits
// there". A working turn doesn't pulse: content is still arriving and the
// climbing count is the signal; the pulse marks finished-and-unlooked-at,
// and stops the moment the chip is clicked (unseen goes 0, chip unmounts).
window.__bramChipShouldPulse = function (status) {
  return !(status && status.state === "working");
};

window.__bramFooterContextLine = function (claim, sel) {
  var ids = (claim && claim.ids) || [];
  if (ids.length) {
    return "Selected in Worklist: " + ids.join(", ") +
      " (" + window.__bramClaimVerb(claim.kind, claim.statusLabel) + "…)";
  }
  var selection = sel || [];
  if (selection.length) return "Selected in Worklist: " + selection.join(", ");
  return "";
};

// issue-265: the per-item indicator's kind, resolved from ONE source with a
// bounded local echo. Host state wins whenever the claim covers the item;
// the echo only fills the gap between the click and the host's sentinel
// write, and Workspace expires it so a completion callback that never fires
// cannot leave an indicator running against a clean sentinel. Returns ''
// when nothing is in flight for this item.
// The echo is bounded by the caller's tick rather than by a separate timer or
// piece of state: Workspace's existing 2 s Timer advances actionProgressTick
// while a submission is outstanding, so ECHO_MAX_TICKS is simply how long we
// will believe a click the host never confirmed. Expiry is therefore derived,
// not stored — there is no way for it to get stuck out of sync.
var BRAM_ECHO_MAX_TICKS = 15; // ~30 s at the 2 s tick

window.__bramItemInflightKind = function (claim, itemId, echoItemId, echoKind, echoTick) {
  if (!itemId) return "";
  var ids = (claim && claim.ids) || [];
  if (ids.indexOf(itemId) !== -1) return claim.kind || "";
  if (!echoItemId || echoItemId !== itemId || !echoKind) return "";
  if ((echoTick || 0) >= BRAM_ECHO_MAX_TICKS) {
    // Host never claimed this item. Stop asserting it is in flight; the row
    // falls back to its authorization state (or to nothing).
    return "";
  }
  return echoKind;
};

// serialize-decisions-while-inflight: the single reason buttons ever
// disable — an unconsumed authorization being carried out. Returns the
// first claimed id while a claim is live, else ''. Keyed on the claim's
// ids, not a boolean: when parallel agent work later brings multi-claim
// host state, the evolution happens here and call sites stay put.
window.__bramInflightBlocker = function (claim) {
  var ids = (claim && claim.ids) || [];
  return ids.length ? ids[0] : "";
};

// strip-label-tense-for-applied-items: the Worklist2 summary strip's
// four-state priority, as one pure function so the binding stays a single
// call. (1) A live claim covering the item reports the claim verb — the
// HOST's record of a decision being carried out, never an inference about
// agent activity. (2) Changes on disk report the activity strip. (3) A
// quiet proposed item reads "no changes yet". (4) A quiet applied item
// says NOTHING — badge alone (the just-committed drain window and the
// stale applied-with-no-work shape alike): badge and message appear
// together or neither appears.
// Split an item's CHANGED paths into the ones only it claims and the ones
// another BEGUN item claims too.
//
// `changedFiles` counts are per-PATH: every item declaring a path reports that
// path's whole uncommitted diff, so an item that has done nothing shows its
// neighbour's work as its own. Live 2026-08-22: `notice-banner-component`
// displayed "files: 1 of 7 planned · lines: +128 −23 · edits: 2" while its
// six other files were clean and the seventh -- the component the item exists
// to create -- did not exist. Every one of those lines was another item's edit
// to a shared Worklist.xmlui, and the row read as work in progress.
//
// Authorship is not recoverable -- nothing records which item wrote which
// hunk. But EXCLUSIVITY is: a changed path no other begun item claims cannot
// be anyone else's, so its numbers are safely this item's. That is the half
// worth reporting, and the rest is reported as shared rather than as owned.
// Un-begun sharers are ignored on the same reasoning __bramWorklistOverlapGroups
// uses: an item that has never been approved has not run, so it cannot have
// contributed.
window.__bramItemChangedSplit = function (item, items, claim, coSelected) {
  var out = { exclusive: [], shared: [], sharedDeclared: [], added: 0, removed: 0, sharedAdded: 0, sharedRemoved: 0 };
  var files = (item && item.changedFiles) || [];
  var byId = {};
  var list = items || [];
  for (var i = 0; i < list.length; i++) byId[list[i].id] = list[i];
  // issue-337: exclusivity is scoped to the OPERATION being gated. A begun
  // sharer that is co-selected for the same commit does not entangle — the
  // #336 inversion (committing all N together is safe: every line is
  // accounted for by an id in that commit), and the exact scope the host
  // backstop already uses (owners outside the REQUEST refuse; owners inside
  // it pass). Callers with no selection context omit the param and get the
  // strict per-item reading unchanged.
  var co = coSelected || [];
  for (var j = 0; j < files.length; j++) {
    var f = files[j];
    if (!f) continue;
    var sharers = f.sharedWith || [];
    var begunSharer = false;
    for (var k = 0; k < sharers.length; k++) {
      if (co.indexOf(sharers[k]) !== -1) continue;
      var other = byId[sharers[k]];
      if (other && window.__bramWorklist2Begun(other, claim)) begunSharer = true;
    }
    // Declared-shared is independent of whether anything changed there: the
    // stage tooltip reports what an item SHARES, a standing fact, while the
    // strip reports what CHANGED.
    if (begunSharer) out.sharedDeclared.push(f.path);
    if ((f.added || 0) <= 0 && (f.removed || 0) <= 0) continue;
    if (begunSharer) {
      out.shared.push(f.path);
      out.sharedAdded += f.added || 0;
      out.sharedRemoved += f.removed || 0;
    } else {
      out.exclusive.push(f.path);
      out.added += f.added || 0;
      out.removed += f.removed || 0;
    }
  }
  return out;
};

// The shared paths behind the strip's counts. Filenames only -- the row
// stays a scan line and the paths are one hover away.
window.__bramWorklist2StripTooltip = function (item, claim, items, attributionTotals) {
  var split = window.__bramItemChangedSplit(item, items, claim);
  // For a committable row, the terse label dropped the on-disk total, the
  // shared paths, the plan denominator and the last-change time; the tooltip
  // is where they land, expanded rather than compressed. (worklist2-strip-terse)
  if (window.__bramSelectionAllCommittable(items || [], [item.id], claim)) {
    var cs = item.changeSummary || {};
    var fileAdded = split.added + split.sharedAdded;
    var fileRemoved = split.removed + split.sharedRemoved;
    // will-commit-matches-the-button: same preference order as the strip, so
    // header and tooltip quote one number with one meaning.
    var wc = item.willCommit;
    var totals = (attributionTotals || {})[item.id];
    var takesAdded = wc ? wc.added : totals ? totals.added : fileAdded;
    var takesRemoved = wc ? wc.removed : totals ? totals.removed : fileRemoved;
    var changed = split.exclusive.length + split.shared.length;
    var lines = [];
    lines.push(
      "Commits +" + takesAdded + " −" + takesRemoved +
        " — exclusive files whole, own hunks on shared files",
    );
    if (takesAdded !== fileAdded || takesRemoved !== fileRemoved) {
      lines.push(
        "On disk: +" + fileAdded + " −" + fileRemoved +
          " — shared files carry neighbours' lines too",
      );
    }
    lines.push("Files: " + changed + " of " + (cs.total || 0) + " planned");
    if (split.shared.length) {
      lines.push(
        "Shares " + split.shared.length + " file" +
          (split.shared.length === 1 ? "" : "s") + " with begun items: " +
          split.shared.join(", "),
      );
    }
    if (cs.lastChangeMs) {
      lines.push("Last change: " + new Date(cs.lastChangeMs).toLocaleTimeString());
    }
    // Rendered via tooltipMarkdown: a blank line between facts makes each a
    // markdown paragraph, so they render with paragraph spacing (Jon,
    // 2026-09-03: "a bit of line separation"). The plain `tooltip` prop
    // collapsed newlines to spaces and the Tooltip has no max-width, so it
    // ran off-screen as one line before the switch to tooltipMarkdown.
    return lines.join("\n\n");
  }
  // Non-committable rows: name the shared paths that block this row, or
  // nothing when it isn't entangled.
  if (!split.shared.length) return "";
  return "Shares " + split.shared.join(", ");
};

// Can every ticked item be STARTED — that is, does each need a fresh
// green light before the agent can touch its files?
//
// This gated on begun-ness and got it wrong in a way that produced a dead-end
// row. `begunAtMs` is DURABLE by design (2585e5f: a displaced approval must
// not erase the fact that work was authorized). Authorization is TRANSIENT:
// the record is single-slot, so any later approval displaces it.
//
// Gating a transient action on a durable fact meant an item green-lit hours
// earlier, whose authorization had long since been displaced, showed Start
// dimmed forever — while the agent had no authorization to act and the guard
// would deny its edits. Live 2026-08-23: notice-banner-component, green-lit
// eleven hours before, no live authorization, nothing on disk. Start, Start &
// commit and Commit all dark; only Drop worked. The row could not be advanced,
// only abandoned.
//
// The earlier rationale — "Iterate says it better, because it carries a
// message" — was wrong for exactly this case. Iterate sends a message to an
// agent that still cannot touch the files; the message lands and the guard
// still denies the edit.
//
// So: an item needs starting when nothing currently authorizes it. That covers
// the never-started item (no stamp, no record) and the displaced one (stamp,
// no record) with the same test, and it stays false while an authorization or
// a live claim exists, so Start cannot re-fire under a running turn.
window.__bramItemNeedsStart = function (item, claim) {
  if (!item) return false;
  if ((item.status || "proposed") === "applied") return false;
  if (item.activeAuthorization === "approved") return false;
  return !window.__bramItemInflightKind(claim, item.id, "", "", 0);
};

window.__bramSelectionAllNeedStart = function (items, sel, claim) {
  var chosen = sel || [];
  if (!chosen.length) return false;
  var list = items || [];
  var picked = list.filter(function (i) { return chosen.indexOf(i.id) !== -1; });
  if (picked.length !== chosen.length) return false;
  return picked.every(function (i) {
    if (!window.__bramItemNeedsStart(i, claim)) return false;
    // A committable item does not need starting. `__bramItemNeedsStart` asks
    // only whether an authorization is live, which is true of an item whose
    // work is already done and waiting to commit -- so Start lit beside Commit
    // on a row whose own icon read "Commit it" (Jon, 2026-08-24: "the checked
    // item is ready to commit, start should not be lit").
    //
    // The since-removed stage icon had this right: it tested committable
    // BEFORE needsStart, while the button did not consult it at all, so the
    // two disagreed about the same row. Testing it here is what survived the
    // icon column (6d5d05b) -- the property outlived the glyphs that showed
    // it.
    //
    // (An earlier oneClickApproveCommit setting made "committable" config-
    // dependent, and a hardcoded `true` here produced a Drop-only dead-end
    // row when the flag was off — 0.5.3 gate run, Phase 9. The setting was
    // retired in that same run; committable is unconditional again.)
    return !window.__bramSelectionAllCommittable(list, [i.id], claim);
  });
};

// Can every ticked item be committed right now?
//
// The gate verb read raw `status`, so an item carrying finished work on disk
// was offered Start -- a step already taken -- and never Commit. Live
// 2026-08-22: a row showing changes on disk sat beside a Start button, and the
// reading from the chair was flat -- "we are obviously started, i can commit".
//
// `applied` is not the only committable state. What makes an item committable
// is having work of its own on disk, and a begun `proposed` item with
// EXCLUSIVE changes has exactly that. Exclusivity is load-bearing: an item
// whose every changed path is shared must NOT offer Commit, because committing
// it would land a neighbour's work under its name.
//
// No host change was needed -- `gate: "apply-and-commit"` sets `commit_too`,
// which is what lets worklist_commit_files_for_ids accept `proposed`
// (allow_proposed). This widens WHEN the pane offers it, not what the host
// permits. (The worklist.oneClickApproveCommit gate that once conditioned
// this was retired in the 0.5.3 run.)
//
// This predicate is also what the stage icon and the strip key on, so all
// three surfaces agree by construction rather than by coincidence.
window.__bramSelectionAllCommittable = function (items, sel, claim) {
  var chosen = sel || [];
  if (!chosen.length) return false;
  var list = items || [];
  var picked = list.filter(function (i) { return chosen.indexOf(i.id) !== -1; });
  if (picked.length !== chosen.length) return false;
  for (var i = 0; i < picked.length; i++) {
    var it = picked[i];
    // #336: no `applied` short-circuit. Exclusivity is what makes the Commit
    // offer safe, and it must cover every committable population -- the old
    // short-circuit guarded the newer begun-`proposed` items while leaving
    // the historical `applied` ones unguarded, so two entangled applied
    // items were both offered a button that would land one item's work
    // under the other's id. Begun-ness is trivially true for applied items.
    if (!window.__bramWorklist2Begun(it, claim)) return false;
    // issue-327: exclusivity is no longer required to OFFER Commit. The host
    // now interval-stages an entangled item's own hunks (scratch index, HEAD
    // parent, worktree untouched), so a shared path is committable — the
    // neighbour's uncommitted work simply stays in the worktree. What remains
    // required is that the item has CHANGES of its own to commit (exclusive OR
    // shared); a begun item with nothing on disk is not committable. The host
    // still refuses a genuinely dependent commit (git apply --check fails) and
    // names the item to commit first, so offering here is safe — the #336
    // withholding and the #337 selection-scoping both retire into this.
    var split = window.__bramItemChangedSplit(it, list, claim, chosen);
    if (!split.exclusive.length && !split.shared.length) return false;
  }
  return true;
};

// #336: the begun items this one shares CHANGED paths with -- the claimants
// whose existence is why Commit is withheld. Named on the strip so the
// missing button reads as an instruction rather than a regression.
window.__bramItemShareBlockers = function (item, items, claim) {
  var byId = {};
  var list = items || [];
  for (var i = 0; i < list.length; i++) byId[list[i].id] = list[i];
  var out = [];
  var seen = {};
  var files = (item && item.changedFiles) || [];
  for (var j = 0; j < files.length; j++) {
    var f = files[j];
    if (!f || ((f.added || 0) <= 0 && (f.removed || 0) <= 0)) continue;
    var sharers = f.sharedWith || [];
    for (var k = 0; k < sharers.length; k++) {
      var id = sharers[k];
      var other = byId[id];
      if (other && window.__bramWorklist2Begun(other, claim) && !seen[id]) {
        seen[id] = true;
        out.push(id);
      }
    }
  }
  return out;
};

// Does this commit need the allow_proposed path? True when any ticked item is
// still `proposed`, which is what the payload's `gate` has to declare.
window.__bramSelectionNeedsProposedCommit = function (items, sel) {
  var chosen = sel || [];
  return (items || []).some(function (i) {
    return chosen.indexOf(i.id) !== -1 && (i.status || "proposed") !== "applied";
  });
};

// A stable colour per item id, so the same item reads the same wherever it
// appears -- its row badge, and its name in the Shared files table's "claimed
// by" column. Entanglement is a relation BETWEEN rows, and the table names
// claimants in text: matching a long kebab-case id back to the row it belongs
// to meant reading both. Colour makes that join pre-attentive.
//
// Hashed from the id rather than assigned by position, because position moves
// as items are approved, dropped and pruned, and a colour that changes under
// you is worse than no colour.
//
// The six families are the ones xmlui actually defines. `$color-warning` is
// NOT one of them (the token is `$color-warn`) -- a name that looks right,
// resolves to nothing, and renders unstyled.
window.__bramItemColorFamily = function (id) {
  var families = window.__bramItemColorFamilies;
  var key = String(id || "");
  var h = 5381;
  for (var i = 0; i < key.length; i++) {
    h = ((h << 5) + h + key.charCodeAt(i)) | 0;
  }
  return Math.abs(h) % families.length;
};

window.__bramItemColorFamilies = ["primary", "success", "info", "danger", "warn", "secondary"];

// Hash alone is not enough: with six families and a handful of items,
// collisions are likely, and two entangled items sharing a colour defeats the
// whole point. So hash for a starting bucket, then probe forward for a free
// one, walking ids in sorted order so the result depends only on WHICH items
// are on the board, never on their order in the file. Distinct up to six
// items; beyond that reuse is unavoidable and the probe wraps.
window.__bramItemColorMap = function (items) {
  var ids = (items || [])
    .map(function (i) { return i && i.id; })
    .filter(Boolean)
    .sort();
  var families = window.__bramItemColorFamilies;
  var taken = {};
  var out = {};
  for (var i = 0; i < ids.length; i++) {
    var start = window.__bramItemColorFamily(ids[i]);
    var pick = start;
    for (var step = 0; step < families.length; step++) {
      var cand = (start + step) % families.length;
      if (!taken[cand]) { pick = cand; break; }
    }
    taken[pick] = true;
    out[ids[i]] = families[pick];
  }
  return out;
};

window.__bramItemColor = function (id, items, shade) {
  var fam = window.__bramItemColorMap(items)[id];
  if (!fam) fam = window.__bramItemColorFamilies[window.__bramItemColorFamily(id)];
  return "$color-" + fam + "-" + (shade || 600);
};


// Coarse age of the green light, for the Stalled strip. Deliberately coarse:
// the age is what makes Stalled a diagnosis rather than a restatement, but a
// per-minute value in a binding is re-render churn for no added meaning, so
// the returned string changes at most once an hour.
window.__bramGreenLitAge = function (item) {
  var ms = item && typeof item.begunAtMs === "number" ? item.begunAtMs : 0;
  if (!(ms > 0)) return "";
  var hrs = Math.floor((Date.now() - ms) / 3600000);
  if (hrs < 1) return "under an hour ago";
  if (hrs < 24) return hrs + "h ago";
  var days = Math.floor(hrs / 24);
  return days === 1 ? "yesterday" : days + "d ago";
};

// issue-327: how many of a file's changed lines this item actually wrote,
// from the claim-interval runs in the payload. Runs describe lines PRESENT in
// the final file, so this counts additions only -- a deletion leaves no line to
// attribute. Reporting a "-" figure here would be inventing one.
window.__bramOwnClause = function (item, attribution) {
  var own = window.__bramItemOwnAdded(item, attribution);
  return own === null ? "" : " \u00b7 unique: +" + own;
};

// issue-327: the Ownership tab's rows -- the file's changed lines in file
// order, as CURRENT content rather than a diff, with elisions where nothing
// changed. Built from the patch the payload already carries, so no extra fetch:
// every owned line is an addition, and the patch holds exactly those.
//
// Not a diff. Four attempts at rendering attribution inside one failed on
// supersession (a rewritten line's earlier version has nowhere to appear) and on
// interleaving (per-line alternation reads as breakage). A file view sidesteps
// both: it shows what is there and who put it there, which is what every blame
// tool has always shown.
// worklist-file-context-view: the whole current file as line rows, each
// tagged with its claimant (from the attribution runs) so the File tab can
// show WHERE each item's work sits in the full document — the big-picture
// companion to the scoped Diff and the Ownership summary. Unowned lines carry
// owner=null and render plain; owned regions read as marked passages in
// context rather than as isolated hunks.
window.__bramFileContextRows = function (content, runs, rowId, items) {
  // worklist2-file-tab-rerender-blowup: this is called from a binding that
  // re-evaluates on every worklist refetch tick, so it MUST return the SAME
  // array object when its inputs are value-equal — a fresh array is a new
  // identity, and a new identity re-renders every row (the 2026-09-04
  // freeze class). Ownership colors are baked into each row here for the
  // same reason: per-row markup bindings that reach into worklist.value
  // re-fire on every tick, one per rendered line.
  var spans = runs || [];
  var text = String(content == null ? "" : content);
  var sig =
    JSON.stringify(spans) +
    "|" +
    String(rowId) +
    "|" +
    (items || [])
      .map(function (it) {
        return it.id;
      })
      .join(",");
  var cache = (window.__bramFileContextRowsCache =
    window.__bramFileContextRowsCache || {});
  var hit = cache[rowId];
  if (hit && hit.sig === sig && hit.content === text) return hit.rows;
  var ownerAt = function (n) {
    for (var i = 0; i < spans.length; i++) {
      if (n >= spans[i].startLine && n <= spans[i].endLine) {
        if (spans[i].itemId) return spans[i].itemId;
        // joint-interval-files-disambiguation: a shared-claim run still
        // highlights (neutral tint) — it is a marked passage, just not one
        // item's.
        if (spans[i].itemIds) return "__joint";
        return null;
      }
    }
    return null;
  };
  var lines = text.split("\n");
  // A trailing newline yields a spurious final empty element; drop it.
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  var full = [];
  for (var i = 0; i < lines.length; i++) {
    var owner = ownerAt(i + 1);
    full.push({
      k: i + 1,
      n: i + 1,
      text: lines[i],
      owner: owner,
      bg: owner
        ? owner === "__joint"
          ? "$color-surface-200"
          : window.__bramItemColor(owner, items, owner === rowId ? 100 : 50)
        : "transparent",
      fg: owner && owner !== rowId ? "$textColor-secondary" : "$textColor-primary",
    });
  }
  // worklist-file-hunk-navigation: in a large file (lib.rs-sized), the
  // highlights sit screens apart; elide the unhighlighted stretches into
  // labeled cut rows so every highlight can come into view. Context lines
  // survive around each highlight; small gaps are not worth a cut row; a
  // file with no highlights at all stays whole (a cut would eat everything
  // and there is nothing to navigate anyway).
  var ELIDE_MIN_FILE = 400;
  var CONTEXT = 3;
  var MIN_GAP = 12;
  var rows = full;
  var anyOwned = false;
  for (var j = 0; j < full.length; j++) {
    if (full[j].owner) {
      anyOwned = true;
      break;
    }
  }
  if (anyOwned && full.length > ELIDE_MIN_FILE) {
    var keep = new Array(full.length);
    for (var j2 = 0; j2 < full.length; j2++) {
      if (full[j2].owner) {
        for (
          var c = Math.max(0, j2 - CONTEXT);
          c <= Math.min(full.length - 1, j2 + CONTEXT);
          c++
        ) {
          keep[c] = true;
        }
      }
    }
    rows = [];
    var g = 0;
    while (g < full.length) {
      if (keep[g]) {
        rows.push(full[g]);
        g += 1;
        continue;
      }
      var gapStart = g;
      while (g < full.length && !keep[g]) g += 1;
      var gapLen = g - gapStart;
      if (gapLen > MIN_GAP) {
        var a = full[gapStart].n;
        var b = full[g - 1].n;
        rows.push({
          k: "cut-" + a,
          cut: true,
          n: "⋯",
          text: "lines " + a + "–" + b + " (" + gapLen + " lines without highlights)",
          owner: null,
          bg: "$color-surface-100",
          fg: "$textColor-secondary",
        });
      } else {
        for (var e = gapStart; e < g; e++) rows.push(full[e]);
      }
    }
  }
  cache[rowId] = { sig: sig, content: text, rows: rows };
  return rows;
};

// worklist-file-hunk-navigation: highlight blocks in a File-view rows array —
// the indexes (in the possibly-elided array) where a run of highlighted rows
// begins. Memoized by array identity: the rows array itself is memoized
// above, so a WeakMap entry lives exactly as long as its rows do.
window.__bramFileHighlightBlocks = function (rows) {
  var memo = (window.__bramFileBlocksMemo = window.__bramFileBlocksMemo || new WeakMap());
  var list = rows || [];
  if (memo.has(list)) return memo.get(list);
  var blocks = [];
  for (var i = 0; i < list.length; i++) {
    if (list[i].owner && (i === 0 || !list[i - 1].owner)) blocks.push(i);
  }
  if (list.length) memo.set(list, blocks);
  return blocks;
};
window.__bramFileHunkCount = function (rows) {
  return window.__bramFileHighlightBlocks(rows).length;
};

// issues-blank-bram-cell-starts-item: a ResultList row is clickable
// anywhere (Card onClick → detail modal), so a link INSIDE a row also
// opened the modal on its way to navigating — the "transited through the
// issue page" interstitial. A click landing on (or within) an anchor or
// button belongs to that control alone; the row returns the previous
// selection unchanged. Fixed at the shared Card so every ResultList
// consumer's embedded controls are covered.
window.__bramRowClickHit = function (e, item, prev) {
  var t = e && e.target;
  while (t && t.tagName) {
    // XMLUI's Link renders a DIV (observed: dom-click tagName=DIV on the
    // new-item link), so tag sniffing alone misses — in-row controls carry
    // an explicit testId marker (data-testid="row-control-…") instead.
    var tid = (t.getAttribute && t.getAttribute("data-testid")) || "";
    if (t.tagName === "A" || t.tagName === "BUTTON" || tid.indexOf("row-control") === 0) {
      return prev;
    }
    t = t.parentElement;
  }
  return item;
};

// file-tab-truncation-misses-changes: when the preview payload is still
// truncated (file beyond even the File tab's raised budget), say so instead
// of silently rendering a wrong-looking prefix — the pre-fix failure was a
// 2.4 MB lib.rs served as its first 200 KB with the item's changes far past
// the cut, so the view showed an unrelated prefix with no highlights and no
// hint why. Returns '' when not truncated so the Text's `when` hides it.
window.__bramFileTruncationNote = function (payload) {
  if (!payload || !payload.truncated) return "";
  var mb = function (n) {
    return (Number(n || 0) / (1024 * 1024)).toFixed(1) + " MB";
  };
  var served = String(payload.content || "").length;
  return (
    "This file is " +
    mb(payload.size) +
    "; the preview shows only the first " +
    mb(served) +
    ". Changes beyond that point appear in the Diff tab."
  );
};

// Hunk-navigation cursor state, id-keyed like diffScopes: one map, keys
// "<rowId>::<path>:<view>", never component-local (the controlled-state
// discipline; positional reuse in the Items loop would carry a cursor
// across files).
window.__bramHunkNavGet = function (map, rowId, path, view) {
  var v = (map || {})[window.__bramDiffExpansionKey(rowId, path) + ":" + view];
  return typeof v === "number" ? v : 0;
};
window.__bramHunkCount = function (patchText) {
  var m = String(patchText || "").match(/^@@ -/gm);
  return m ? m.length : 0;
};
// Diff view step: clamp the cursor, scroll via the ACTIVE DiffView's
// scrollToHunk method (its full mode is a virtualized List — the first cut
// of this scanned the DOM for "@@" leaves and silently reached nothing,
// because unmounted rows have no DOM), and return the updated map. Deltas
// arrive pre-clamped from HunkNav's position-aware enablement; the clamp
// here is belt and braces.
window.__bramDiffHunkStep = function (map, rowId, path, delta, patchText, viewRef) {
  var count = window.__bramHunkCount(patchText);
  if (!count) return map || {};
  var cur = window.__bramHunkNavGet(map, rowId, path, "diff");
  var next = Math.max(0, Math.min(count - 1, cur + delta));
  if (viewRef && typeof viewRef.scrollToHunk === "function") {
    viewRef.scrollToHunk(next);
  } else {
    window.__bramIframeTrace("hunk-nav", { op: "no-scroll-method", path: String(path) });
  }
  return window.__bramMapSet(
    map,
    window.__bramDiffExpansionKey(rowId, path) + ":diff",
    next
  );
};
// The method body behind DiffView.scrollToHunk: nth kind==='hunk' row in the
// plan, scrolled through the inner List's own API
// (https://www.xmlui.org/docs/reference/components/List#scrolltoindex).
window.__bramDiffViewScrollToHunk = function (listRef, plan, n) {
  var rows = (plan && plan.rows) || [];
  var seen = 0;
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].kind === "hunk") {
      if (seen === n) {
        if (listRef && listRef.scrollToIndex) listRef.scrollToIndex(i);
        return true;
      }
      seen += 1;
    }
  }
  return false;
};
// File view step: same cursor discipline; the target is a virtualized List
// row, so scrolling goes through the component's own scrollToIndex — a DOM
// query cannot reach an unmounted row
// (https://www.xmlui.org/docs/reference/components/List#scrolltoindex).
window.__bramFileHunkStep = function (map, rowId, path, delta, rows, listRef) {
  var blocks = window.__bramFileHighlightBlocks(rows);
  if (!blocks.length) return map || {};
  var cur = window.__bramHunkNavGet(map, rowId, path, "file");
  var next = Math.max(0, Math.min(blocks.length - 1, cur + delta));
  if (listRef && listRef.scrollToIndex) listRef.scrollToIndex(blocks[next]);
  return window.__bramMapSet(
    map,
    window.__bramDiffExpansionKey(rowId, path) + ":file",
    next
  );
};

window.__bramOwnershipRows = function (patch, runs) {
  var spans = runs || [];
  var ownerAt = function (n) {
    for (var i = 0; i < spans.length; i++) {
      if (n >= spans[i].startLine && n <= spans[i].endLine) return spans[i].itemId;
    }
    return null;
  };
  var lines = String(patch == null ? "" : patch).split("\n");
  var hits = [];
  var n = 0;
  for (var i = 0; i < lines.length; i++) {
    var l = lines[i];
    var m = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(l);
    if (m) {
      n = parseInt(m[1], 10);
      continue;
    }
    if (l.charAt(0) === "+") {
      if (l.indexOf("+++ ") === 0) continue;
      hits.push({ n: n, text: l.slice(1), owner: ownerAt(n) });
      n += 1;
    } else if (l.charAt(0) === "-") {
      // deletions leave no line in the file, so nothing to own or show
    } else if (l.charAt(0) === " ") {
      n += 1;
    }
  }
  // Elide the unowned stretches between changed regions, so the tab stays
  // proportional to the CHANGE rather than the file: helpers.js is 11,000 lines
  // and would show 55.
  var out = [];
  var prevLine = 0;
  var prevOwner = "\u0000";
  for (var k = 0; k < hits.length; k++) {
    var h = hits[k];
    var gap = h.n - prevLine - 1;
    if (gap > 0) {
      out.push({ kind: "elide", count: gap });
      prevOwner = "\u0000";
    }
    out.push({
      kind: "line",
      n: h.n,
      text: h.text,
      owner: h.owner,
      // One label per run, the rule that survived review. In a file view this
      // is uncontroversial: it is what blame output has always looked like.
      runStart: h.owner !== prevOwner,
    });
    prevOwner = h.owner;
    prevLine = h.n;
  }
  return out;
};

// issue-327 file-table experiment: map a Table row selection onto the keyed
// diff-expansion store. Single-select master-detail per the documented
// pattern (https://www.xmlui.org/docs/howto/build-a-master-detail-layout):
// selecting a file row opens its Tabs, selecting another switches, an empty
// selection closes. One expansion per item; diffKeys stays the source of
// truth (Table selection is component-internal and positional, the
// ExpandableItem class of state, so nothing but the highlight relies on it).
window.__bramTableSelectDiff = function (keys, itemId, sel) {
  var prefix = String(itemId) + "::";
  var next = (keys || []).filter(function (k) {
    return String(k).indexOf(prefix) !== 0;
  });
  var picked = sel && sel.length ? sel[sel.length - 1] : null;
  if (picked && picked.path) next.push(window.__bramDiffExpansionKey(itemId, picked.path));
  return next;
};

// issue-327 scoped diff: the scopes a file's Diff tab offers. "All changes" is
// the combined patch (commit truth: whole-file staging takes all of it); each
// claimant with attributed lines is its own scope, rendered as that item's
// interval diff -- one owner per view, the Gerrit patch-set / GitHub
// per-commit convention (scope, don't annotate); "unattributed" appears only
// when some changed line has no owner. The row's own item is listed first: it
// is the default lens.
window.__bramDiffScopeOptions = function (patch, runs, rowId) {
  var opts = [{ value: "__all", label: "All" }];
  var spans = runs || [];
  var seen = {};
  var order = [];
  for (var i = 0; i < spans.length; i++) {
    var id = spans[i].itemId;
    if (id && !seen[id]) {
      seen[id] = true;
      if (id === rowId) order.unshift(id);
      else order.push(id);
    }
  }
  for (var j = 0; j < order.length; j++) {
    opts.push({
      value: order[j],
      label: order[j] + (order[j] === rowId ? " (this item)" : ""),
    });
  }
  var rows = window.__bramOwnershipRows(patch, spans);
  for (var k = 0; k < rows.length; k++) {
    if (rows[k].kind === "line" && !rows[k].owner) {
      opts.push({ value: "__unattributed", label: "unattributed" });
      break;
    }
  }
  return opts;
};

// Scope selection is CONTROLLED and id-keyed, the diffKeys discipline one
// level down: Select's own state is positional inside an Items loop, so the
// map -- not the widget -- is what the DiffViews and the DataSource read.
// Default lens: the row you opened from, when it owns lines here; else all.
window.__bramDiffScope = function (scopeKeys, itemId, path, runs) {
  var k = window.__bramDiffExpansionKey(itemId, path);
  var map = scopeKeys || {};
  if (Object.prototype.hasOwnProperty.call(map, k)) return map[k];
  var spans = runs || [];
  for (var i = 0; i < spans.length; i++) {
    if (spans[i].itemId === itemId) return itemId;
  }
  return "__all";
};
window.__bramSetDiffScope = function (scopeKeys, itemId, path, value) {
  var map = scopeKeys || {};
  var next = {};
  for (var k in map) {
    if (Object.prototype.hasOwnProperty.call(map, k)) next[k] = map[k];
  }
  next[window.__bramDiffExpansionKey(itemId, path)] = value;
  return next;
};

// issue-327 ownership summary: the Ownership tab's rows, one per claimant of
// this file, seen from the ROW ITEM's point of view. The line-by-line file
// view was rejected at rendered review as illegible; what a reader needs
// beside the scoped diff is the one thing it cannot show -- who else is in
// this file, how much is theirs, and whether each claimant's work is
// separable. Separability is MEASURED, never inferred from hunk geometry:
// `independence` is /__worklist/independence's per-claimant `git apply
// --check` verdict (the 5fb78fe rule -- hunk-sharing is adjacency, dependence
// is directional). Absent a verdict the relation says nothing rather than
// guessing. Added lines only, the "yours: +22" convention: deletions leave no
// line to own, so runs cannot count them.
window.__bramOwnershipSummary = function (patch, runs, rowId, independence) {
  var spans = runs || [];
  // joint-interval-files-disambiguation: a run may carry itemIds (a joint
  // set from a one-click plural approval) instead of itemId. Bucket those
  // under a composite key so they render as their own "shared" row rather
  // than folding into unattributed.
  var ownerAt = function (n) {
    for (var i = 0; i < spans.length; i++) {
      if (n >= spans[i].startLine && n <= spans[i].endLine) {
        if (spans[i].itemId) return spans[i].itemId;
        if (spans[i].itemIds) return "__joint:" + spans[i].itemIds.join("+");
        return null;
      }
    }
    return null;
  };
  var lines = String(patch == null ? "" : patch).split("\n");
  var n = 0;
  var hunk = -1;
  var per = {};
  var order = [];
  for (var i = 0; i < lines.length; i++) {
    var l = lines[i];
    var m = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(l);
    if (m) {
      n = parseInt(m[1], 10);
      hunk += 1;
      continue;
    }
    if (l.charAt(0) === "+") {
      if (l.indexOf("+++ ") === 0) continue;
      var who = ownerAt(n) || "";
      if (!per[who]) {
        per[who] = { added: 0, hunks: {} };
        order.push(who);
      }
      per[who].added += 1;
      per[who].hunks[hunk] = true;
      n += 1;
    } else if (l.charAt(0) === " ") {
      n += 1;
    }
  }
  // Row item first, then by contribution; unattributed last.
  order.sort(function (a, b) {
    if (a === rowId) return -1;
    if (b === rowId) return 1;
    if (!a) return 1;
    if (!b) return -1;
    return per[b].added - per[a].added;
  });
  var verdicts = (independence && independence.items) || {};
  var out = [];
  for (var k = 0; k < order.length; k++) {
    var id = order[k];
    var relation = "";
    // ownership-reports-consequences (Jon, 2026-09-04): every row states what
    // a Commit click DOES, in the reader's language — never a bookkeeping
    // adjective the reader must translate. The old strings ("independently
    // committable", "no claim was live…") reported mechanism; a designer-level
    // reader needed a forensic session per row to find the action in them.
    // The unattributed row asks nothing of the reader — it exists only so
    // the claimant counts visibly sum to the file's total. Say the one
    // plain fact and stop; the ordering nuance (they commit under whichever
    // item goes last) lives in the docs, not in a table cell. Two rounds of
    // cleverer copy here both failed the "what am I supposed to DO with
    // this?" test (Jon, 2026-09-04).
    if (id && id.indexOf("__joint:") === 0) {
      // Shared claim (approved together in one click), no sole declarer:
      // name the candidates and state the same commit consequence the
      // unattributed row states — plain fact, no action demanded.
      out.push({
        id: null,
        jointIds: id.slice("__joint:".length).split("+"),
        added: per[id].added,
        relation:
          "claimed together in one approval — no single owner; these lines go with this file's last commit",
      });
      continue;
    }
    if (!id)
      relation = "no action needed — these lines will go along with this file's last commit";
    else if (Object.prototype.hasOwnProperty.call(verdicts, id)) {
      var v = verdicts[id];
      // issue-327: the gate stages by claim interval, so an independent
      // patch commits exactly its own lines.
      if (v.independent) relation = "commits cleanly on its own, in any order";
      else if ((v.dependsOn || []).length)
        relation =
          "commit " +
          v.dependsOn.join(", ") +
          " first — these changes build on its work";
      else
        relation =
          "cannot commit alone — commit together with this file's other items";
    }
    out.push({ id: id || null, added: per[id].added, relation: relation });
  }
  return out;
};

// Ownership claimant cell text: a single item id (suffixed for the row's
// own item), a joint set ("shared: a + b"), or the no-item placeholder.
window.__bramClaimantCell = function (item, rowId) {
  if (item && item.jointIds) return "shared: " + item.jointIds.join(" + ");
  if (item && item.id) return item.id === rowId ? item.id + " (this item)" : item.id;
  return "no item";
};

// will-commit-matches-the-button: the CHANGES cell for a file row. On an
// entangled path the row leads with the item's own take — the number that
// actually sums to the "Will commit" header — with the file total as
// context ("+170 −1 of +404 −18"). On exclusive paths take == total and
// the cell reads as it always did. Extracted from an inline markup
// expression per the single-call handler rule.
window.__bramFileChangesCell = function (rec, rowBegun) {
  if (!rowBegun || !rec || rec.status === "unchanged") return "";
  var suffix =
    rec.status === "new" ? " (new)" : rec.status === "deleted" ? " (deleted)" : "";
  var total = "+" + rec.added + " −" + rec.removed;
  var hasTake = typeof rec.takeAdded === "number";
  if (hasTake && (rec.takeAdded !== rec.added || rec.takeRemoved !== rec.removed)) {
    return "+" + rec.takeAdded + " −" + rec.takeRemoved + " of " + total + suffix;
  }
  return total + suffix;
};

window.__bramItemOwnAdded = function (item, attribution) {
  var attr = attribution || {};
  var files = (item && item.changedFiles) || [];
  var own = 0;
  var covered = false;
  for (var i = 0; i < files.length; i++) {
    var runs = attr[files[i] && files[i].path] || [];
    if (runs.length) covered = true;
    for (var j = 0; j < runs.length; j++) {
      if (runs[j].itemId === item.id) own += runs[j].endLine - runs[j].startLine + 1;
    }
  }
  // `covered` distinguishes "wrote none of it" from "nothing is attributable
  // here" -- work predating the capture phase, or done with no claim live.
  // Only the first is a number worth printing.
  return covered ? own : null;
};

// The "shared with" cell, narrowed to claimants that have BEGUN. Same rule and
// reason as d1798ca in the overlaps panel: an item that has not begun cannot
// have written anything, so it cannot be sharing the file with anyone. That fix
// did not reach this column because only the panel was looked at.
window.__bramSharedWithBegun = function (file, items, claim) {
  var sharers = (file && file.sharedWith) || [];
  var list = items || [];
  var byId = {};
  for (var i = 0; i < list.length; i++) if (list[i] && list[i].id) byId[list[i].id] = list[i];
  var out = [];
  for (var j = 0; j < sharers.length; j++) {
    var it = byId[sharers[j]];
    if (it && window.__bramWorklist2Begun(it, claim)) out.push(sharers[j]);
  }
  return out;
};

// worklist-surface-planned-overlap: the complement — sharers that have NOT
// begun. Plan overlap, not work overlap. d1798ca correctly stopped naming
// these as claimants of CHANGES (a never-begun item shares no work); the
// Start decision still needs them, and the row marks the tense (`· planned`)
// so the credit lie d1798ca fixed cannot return through this door.
window.__bramSharedWithPlanned = function (file, items, claim) {
  var sharers = (file && file.sharedWith) || [];
  var list = items || [];
  var byId = {};
  for (var i = 0; i < list.length; i++) if (list[i] && list[i].id) byId[list[i].id] = list[i];
  var out = [];
  for (var j = 0; j < sharers.length; j++) {
    var it = byId[sharers[j]];
    if (it && !window.__bramWorklist2Begun(it, claim)) out.push(sharers[j]);
  }
  return out;
};

window.__bramWorklist2Strip = function (item, claim, items, attribution, attributionTotals) {
  if (!item) return "";
  // issue-266: the close declaration belongs on the status line for
  // scannability, never buried in the expanded body.
  var closes = "";
  var ci = item.closesIssues;
  if (ci && ci.length) {
    closes =
      "closes " +
      ci
        .map(function (c) {
          return "#" + (c && c.number != null ? c.number : c);
        })
        .join(", ");
  }
  var withCloses = function (base) {
    if (!base) return base;
    return closes ? base + " · " + closes : base;
  };
  var kind = window.__bramItemInflightKind(claim, item.id, "", "", 0);
  if (kind) {
    // worklist-advance-verify-window (#286): a live claim covering this item
    // (which is also what makes it begun, by construction — see
    // `__bramWorklist2Begun`'s last branch) plus a change summary showing
    // every planned file already moved is NOT "still working" — it is an
    // apply whose edits are done and whose agent is verifying before calling
    // advance. The 2026-08-25 specimen ran minutes of legitimate
    // verification on a three-item apply; the generic verb below read
    // "Starting…" the whole time, indistinguishable from a stuck spinner.
    // Named separately so it takes priority over the generic verb, never the
    // reverse.
    var csDone = item.changeSummary;
    if (csDone && csDone.total > 0 && csDone.changed === csDone.total) {
      // strip-changes-in-progress-honesty: was "Changes complete, not yet
      // advanced" — wave 3 falsified the wording (both entangled items
      // showed it while their subagents' chips were visibly still running).
      // files_changed == files_total measures COVERAGE, not completion; a
      // subagent touches every planned file early and keeps editing. Say
      // only what is observable; true mid-edit AND mid-verification.
      return withCloses("Changes in progress");
    }
    // header-inflight-verbs, corrected (2026-08-20 sighting: the strip
    // flipped Approving… → Committing… mid-apply as the first edits
    // landed): the verb reads the claim's statusLabel — the gate FIXED at
    // approval time, same host fact the banner reads — never inferred
    // from the moving changed-count.
    return withCloses(
      window.__bramClaimVerb(kind, (claim && claim.statusLabel) || "") + "…",
    );
  }
  // worklist2-plan-vs-activity: activity counts render only for items
  // that have BEGUN (applied, or covered by a live claim — host facts,
  // never agent-state inference). A proposed, unclaimed item is a PLAN:
  // sibling work on shared paths is not this item's activity, so its
  // strip stays at "no changes yet" and its files render as a plain
  // Will-touch list.
  var begun = window.__bramWorklist2Begun(item, claim);
  var cs = item.changeSummary;
  if (begun && cs && cs.changed > 0) {
    var t = cs.lastChangeMs ? new Date(cs.lastChangeMs).toLocaleTimeString() : "";
    var split = window.__bramItemChangedSplit(item, items, claim);
    var sharedNote = split.shared.length
      ? " · " + split.shared.length + " shared"
      : "";
    // COMMITTABLE, not `applied`: the strip keys on the same predicate as the
    // icon and the Commit button, so all three agree. It used to key on
    // `applied`, which meant an advanced item and a not-yet-advanced one with
    // identical disk state printed different sentences for a difference the
    // user cannot see or cause (live 2026-08-22: throwaway-commit-a and -b,
    // identical strips and file tables, differing only in an icon).
    if (window.__bramSelectionAllCommittable(items || [], [item.id], claim)) {
      // Two readings in one line, both action-relevant: what a commit would
      // TAKE (whole files, whoever wrote them) and how far the work has got
      // against its own plan -- "1 of 2 planned" is the signal that a commit
      // now would be committing something unfinished.
      // issue-327: lead with what a commit actually TAKES. Interval staging
      // commits the item's own hunks, so the headline is its interval-patch
      // shortstat (attributionTotals). On a contended path that is less than
      // the file total, which is shown as "on disk" context; for an
      // unentangled item the two are equal and it reads as it always did. The
      // old dual-number collapses into one honest figure. Items predating
      // capture have no totals -- fall back to the file sum (what whole-file
      // staging takes for them).
      // worklist2-strip-terse (2026-09-03): the label carries only what
      // decides "commit or not" — the item's own take, a partial-plan flag
      // when the work is unfinished, and a bare "shared" flag when a commit
      // would be entangled. Everything else (the on-disk file total, the
      // shared paths by name, the last-change time, the plan denominator)
      // moved to __bramWorklist2StripTooltip. The strip was a run-on
      // sentence; the tooltip is where the expansion belongs.
      var fileAdded = split.added + split.sharedAdded;
      var fileRemoved = split.removed + split.sharedRemoved;
      // will-commit-matches-the-button: prefer the host's willCommit, which
      // is computed the way worklist-commit executes (whole-file on
      // exclusive paths, interval take on entangled ones). The older
      // fallbacks — interval totals, then file sums — cover hosts that
      // predate it.
      var wc = item.willCommit;
      var totals = (attributionTotals || {})[item.id];
      var takesAdded = wc ? wc.added : totals ? totals.added : fileAdded;
      var takesRemoved = wc ? wc.removed : totals ? totals.removed : fileRemoved;
      var changedCount = split.exclusive.length + split.shared.length;
      var partialFlag =
        (cs.total || 0) > changedCount
          ? " · " + changedCount + " of " + (cs.total || 0)
          : "";
      var sharedFlag = split.shared.length ? " · shared" : "";
      return withCloses(
        "Will commit +" + takesAdded + " −" + takesRemoved +
          partialFlag + sharedFlag,
      );
    }
    // Not committable: every changed path is claimed by another begun item.
    // (The pre-#327 version of this comment said "not one line is attributable
    // here", which is now false — attribution knows exactly whose lines these
    // are, and the own-clause below reports this item's share. What is still
    // true: the whole-file TOTALS would credit neighbours' work to this row.)
    // ...and if it is ALSO stalled, say which button unsticks it. This is the
    // branch the motivating row lands in (notice-banner-component: begun,
    // 1 of 7 files changed, that file shared with issue-269), so omitting the
    // hint here would have left the very case that prompted the split showing
    // a Stalled icon above a line that never names Start.
    var nShared = split.shared.length;
    // #336: this branch now also receives entangled APPLIED items (the
    // exclusivity check covers them since the short-circuit fell). Two
    // truths, both said: whether this item has work of its own here (the
    // old wording claimed "nothing" for an item with 70 attributed lines),
    // and WHO is blocking, so the absent Commit button names its cause.
    var own = window.__bramOwnClause(item, attribution);
    var blockers = window.__bramItemShareBlockers(item, items, claim);
    var head = own
      ? "Changes only on shared files" + own
      : "Nothing of its own changed";
    return withCloses(
      head + " · " + nShared + " shared file" +
        (nShared === 1 ? "" : "s") + " changed" +
        (blockers.length
          ? " with " + blockers.join(", ") + " — commit " +
            (blockers.length === 1 ? "it" : "those") + " first"
          : "") +
        (window.__bramItemNeedsStart(item, claim) ? " · Start again" : ""),
    );
  }
  // The strip names the same state the icon does. Both branches used to return
  // "No changes yet", so the visible line distinguished nothing while the
  // tooltip carried the whole distinction one hover away.
  if (!begun) {
    window.__bramWorklistStripAnomaly(item, claim, cs);
    // Just the state. The "· Start to green-light" tail instructed the user to
    // press a button that is already sitting in the footer, labelled -- the
    // strip's job is to name where the item IS, not to narrate the next click.
    return withCloses("Proposed");
  }
  // Nothing on disk yet, and begun -- the two states the icon now separates.
  // Earlier this returned "" (brief, because begun-ness was transient), then
  // "No changes yet" (identical to the branch above, which was the defect),
  // then the bare word "Green-lit" (a fact, naming no action). The strip's job
  // is the history the icon cannot carry PLUS the button that acts on it.
  if (window.__bramItemNeedsStart(item, claim)) {
    var age = window.__bramGreenLitAge(item);
    return withCloses(
      "Green-lit" + (age ? " " + age : "") +
        ", nothing came of it · Start again",
    );
  }
  // issue-350-stranded-approval-reconciliation: the host marks an approved
  // authorization with no claim and no agent activity since issue — the
  // gate click's turn never reached the agent. "With the agent" would
  // promise work nobody is doing (the #350 dead-end); say the true state
  // and the way out.
  if (item.strandedApproval) {
    return withCloses(
      "Approved — agent not yet notified · tell the agent to proceed, or Refine with a note",
    );
  }
  return withCloses("With the agent · nothing to do");
};

// strip-vs-diff-disagreement-instrument. A row was observed printing
// "No changes yet" directly above a rendered diff of its own edits
// (2026-08-21 ~07:12Z, on 0.5.0), correcting itself at the next refetch about
// a minute later. The two halves have different sources of truth, which is why
// they CAN disagree: `diff` / `changedFiles` derive from disk state (997017a),
// while this strip is gated on `__bramWorklist2Begun` — a status/authorization
// fact. Three inputs could each have produced it (a payload predating the
// approval, an authorization consumed earlier than assumed, or
// `changeSummary.changed === 0` beside a non-empty `changedFiles`), and the
// existing trace records none of them: `/__worklist` route lines carry only
// method, status, body size and duration.
//
// So this records the CONTRADICTION with the fields that discriminate, rather
// than guessing which of the three to fix. Same conclusion #259 reached after
// 420 observations that could not self-classify: a better instrument, not more
// soak.
//
// This is a TRIPWIRE, not a soak observer. It fires only when the row is
// actively lying, so its steady state is zero lines — and a tripwire's zero is
// indistinguishable from a dead instrument's zero in a grep. Its provenance
// check is a deliberate fire, never a wait. Deduped per item per contradicting
// signature so a re-render storm cannot bury the first occurrence.
var __bramStripAnomalySeen = {};
window.__bramWorklistStripAnomaly = function (item, claim, cs) {
  try {
    if (!item) return;
    var files = item.changedFiles || [];
    var moved = 0;
    for (var i = 0; i < files.length; i++) {
      var f = files[i];
      if (!f) continue;
      if ((f.added || 0) > 0 || (f.removed || 0) > 0) moved++;
    }
    // No moved files means "No changes yet" is simply true.
    if (!moved) return;
    var sig =
      String(item.id) +
      "|" +
      String(item.status || "") +
      "|" +
      String(item.activeAuthorization || "") +
      "|" +
      String((cs && cs.changed) || 0) +
      "|" +
      moved;
    if (__bramStripAnomalySeen[sig]) return;
    __bramStripAnomalySeen[sig] = true;
    window.__bramIframeTrace("worklist-strip", {
      op: "anomaly",
      reason: "no-changes-yet-with-changed-files",
      item: item.id,
      status: item.status || "",
      claimed: !!window.__bramItemInflightKind(claim, item.id, "", "", 0),
      auth: item.activeAuthorization || "",
      auth_age_ms: item.authorizationAgeMs == null ? -1 : item.authorizationAgeMs,
      cs_changed: (cs && cs.changed) || 0,
      cs_total: (cs && cs.total) || 0,
      files_moved: moved,
      files_total: files.length,
    });
  } catch (e) {
    /* an instrument must never break the surface it watches */
  }
};
// worklist2-checkbox-during-action: the row checkbox stays ticked and
// disabled while a live claim covers the item — the tick is part of the
// sentence ("Start 1" = this row), so it freezes until the action
// resolves. Thin wrapper so the Checkbox bindings stay single calls.
window.__bramWorklist2RowClaimed = function (claim, itemId) {
  return !!window.__bramItemInflightKind(claim, itemId, "", "", 0);
};

// Can this row's checkbox be toggled right now?
//
// The board already serializes decisions while a claim is in flight -- every
// gate button reads `__bramInflightBlocker`, "the single reason buttons ever
// disable". The checkboxes did not: only the CLAIMED row was locked, so an
// unrelated item could still be ticked while another said "Refining…". That
// builds a selection whose every action is disabled, and it obscures which
// item owns the turn.
//
// Same fact, same lock: while any claim is live no row changes. The claimed
// row stays visibly ticked (its `initialValue` already reports the claim), so
// the selection remains represented but inert, and ordinary selection resumes
// the moment the claim clears -- no local latch to go stale if the claim is
// cleared by a turn-completion detector rather than by us.
window.__bramWorklist2RowSelectable = function (claim) {
  return !window.__bramInflightBlocker(claim);
};
window.__bramWorklist2Begun = function (item, claim) {
  if (!item) return false;
  if ((item.status || "proposed") === "applied") return true;
  // durable-begun-record: the host stamps this when it first records an
  // approved authorization covering the item. The two signals below are both
  // TRANSIENT and single-slot — the authorization file holds one record that
  // any later approval overwrites, and the claim is cleared by turn-completion
  // detectors — so on their own they answered a durable question with facts
  // that expire. Live consequence (2026-08-22): approving one item displaced
  // another's approval, and that item reported "No changes yet" while carrying
  // 70 uncommitted lines. The overlap banner reads this same predicate for
  // attribution, so the displacement also silenced an entanglement warning.
  if (typeof item.begunAtMs === "number" && item.begunAtMs > 0) return true;
  // worklist2-begun-survives-claim-clear: the inflight claim is TRANSIENT --
  // host turn-completion detectors clear it mid-apply on ordinary end-turn
  // signals -- but "has work on this item begun?" is DURABLE. Resting the
  // whole gate on the claim made a row whose files were visibly modified
  // regress to "No changes yet" (live capture: changeSummary read
  // "files: 1 of 2 planned - lines: +779, -130 - edits: 7" while the strip
  // said otherwise, .inflight-claim.json absent 6m into the apply).
  // The approved authorization record is the host fact whose lifetime
  // matches the question: it is consumed at `mutate op:"advance"`, the same
  // call that flips status to `applied`, so these three branches cover the
  // apply window continuously. Age is deliberately not consulted -- an old
  // approval is still an approval, and ageing the gate would reintroduce a
  // time-based proxy for a fact the record already states outright.
  if (item.activeAuthorization === "approved") return true;
  return !!window.__bramItemInflightKind(claim, item.id, "", "", 0);
};

// ---------------------------------------------------------------------------
// #278 rungs 1+2: overlap is a property of FILES, stated once.
//
// Colour cannot carry this job. `__bramItemColorMap` has six families and its
// own comment says the probe wraps past six. Computed exactly (djb2 mod 6,
// forward probe over sorted ids): seven items is the FIRST collision and ten
// produces a triple, so past six the surface asserts an identity that is
// false -- two claimants of one file wearing one hue. These predicates replace
// that job with counts and navigable ids, neither of which wraps.
//
// Begun-ness reuses `__bramWorklist2Begun`, so the index, the row backlink and
// the stage icon agree by construction rather than by coincidence.
// ---------------------------------------------------------------------------

window.__bramItemFiles = function (item) {
  if (!item) return [];
  if (item.files && item.files.length) return item.files;
  return item.file ? [item.file] : [];
};

window.__bramBasename = function (path) {
  var p = String(path || "");
  var i = p.lastIndexOf("/");
  return i >= 0 ? p.slice(i + 1) : p;
};

// Every path claimed by 2+ items, ordered HAZARD BEFORE POPULARITY.
//
// The ordering is not cosmetic. `worklist_commit_files_for_ids` (lib.rs) stages
// whole files, whoever changed them, so a file with begun claimants is the one
// that can produce a mixed commit. A file shared by three items with two begun
// is more consequential than one shared by seventeen unbegun plans.
// The per-item row backlink that used to live here is GONE, and deliberately.
// It put a second meaning of "shared" on a line that already had one (the
// strip counts shared CHANGED files; the backlink counted shared CLAIMED
// files), and it made the scan line longer for information the file table
// already carries. Overlap is a property of files -- the index below and the
// expanded row's file table are its surfaces. See the issue-278 comment in
// Worklist.xmlui for the live evidence.

// Claimant lists render as one joined string, not N adjacent Text nodes.
//
// When these were badges the chip boundary WAS the separator. Dropping the
// chip left ids butting against each other with only a space between them --
// "issue-269-drop-not-blocked-by-unrelated-claim issue-278-semantic-colour"
// reads as one malformed token. A middot cannot be confused with anything
// inside an id, which is hyphen-and-alphanumeric only.
window.__bramJoinIds = function (ids) {
  return (ids || []).join(" \u00b7 ");
};

// Changed files no item declares. The host computes the set (the client
// cannot -- /__worklist carries changedFiles per item, scoped to that item's
// own paths, so a path nobody declares appears in nobody's payload).
//
// TRIPWIRE, not a soak observer: the normal state is zero rows, so zero is
// success rather than absent evidence -- and a tripwire's zero looks identical
// to a dead instrument's zero. Its provenance check is a deliberate fire:
// change a file no item declares, see the row, revert, see it clear.
window.__bramUnclaimedChangedFiles = function (worklistValue) {
  return (worklistValue && worklistValue.unclaimedChangedFiles) || [];
};

window.__bramHasUnclaimedChanges = function (worklistValue) {
  return window.__bramUnclaimedChangedFiles(worklistValue).length > 0;
};

// commit-granularity-and-start-consequence part C: does the SELECTION itself
// contain two or more items claiming one path? __bramOverlapIndex is board-wide
// and selection-blind, which is right for the Shared files table and wrong for
// this question -- the user is about to act on the ticked rows, not the board.
//
// Answers the pre-Start question, so it deliberately does NOT require begun or
// committable: the consequential click is Start, which is what forecloses
// committing either item alone. By the time exclusivity can be evaluated the
// work is already done.
//
// For the same reason it stays on the DECLARED index while the Review-overlaps
// panel moved to __bramOverlapChangedIndex: before Start there is nothing on
// disk to intersect with, so predictions are the only signal there is. Do not
// "fix" the divergence -- the two surfaces answer different questions.
window.__bramSelectionSharedFileCount = function (items, sel, claim) {
  var chosen = sel || [];
  if (chosen.length < 2) return 0;
  var index = window.__bramOverlapIndex(items, claim) || [];
  var n = 0;
  for (var i = 0; i < index.length; i++) {
    var ids = index[i].claimants || [];
    var hits = 0;
    for (var c = 0; c < ids.length; c++) {
      if (chosen.indexOf(ids[c]) !== -1) hits++;
    }
    if (hits >= 2) n++;
  }
  return n;
};

window.__bramSelectionSharesFiles = function (items, sel, claim) {
  return window.__bramSelectionSharedFileCount(items, sel, claim) > 0;
};

// Names offending items instead of counting them. A bare count collides with
// the ordinal reading -- "1 already has changes" parses just as easily as
// "item number 1" -- and a count cannot be acted on, while a name can be
// unticked. (Resurrected from the 2026-08-23 gate-explainer attempt.)
window.__bramNameList = function (ids, max) {
  var n = ids || [];
  // Cap 2: real item ids are long kebab-case names, and three of them turn a
  // one-line explainer into a paragraph.
  var cap = max || 2;
  if (!n.length) return "";
  if (n.length === 1) return n[0];
  if (n.length <= cap) {
    return n.slice(0, -1).join(", ") + " and " + n[n.length - 1];
  }
  return n.slice(0, cap).join(", ") + " and " + (n.length - cap) + " more";
};

// The gate-bar explainer: why THIS button combo, for the current selection.
// Empty string when there is nothing to say, so the caller is one binding
// with no ternary.
//
// The design rule, learned four times over (two wordings deleted 2026-08-23,
// two more caught in the 2026-08-24 0.5.3 release-gate run): the line is
// DERIVED from the same predicates that light the buttons -- begun-ness
// (`__bramWorklist2Begun`) and exclusivity (`__bramItemChangedSplit`, the
// same call `__bramSelectionAllCommittable` makes) -- and it may only name
// an action the footer currently offers, or name a dim action together with
// why it is dim and the selection change that would light it. Prose written
// PARALLEL to the gating inevitably asserts off-screen buttons ("Approve &
// commit does the apply and the commit in one turn" beside a footer without
// that button; "Commit p1 first" beside a footer whose only lit button was
// Drop). Silence for unsurprising combos is deliberate: an always-on
// explainer is furniture (the deleted matrix's lesson).
window.__bramStartConsequence = function (items, sel, claim) {
  var chosen = sel || [];
  if (!chosen.length) return "";
  var list = items || [];
  var byId = {};
  for (var i = 0; i < list.length; i++) if (list[i]) byId[list[i].id] = list[i];
  var begun = [];
  var unbegun = [];
  for (var s = 0; s < chosen.length; s++) {
    var it = byId[chosen[s]];
    if (!it) continue;
    (window.__bramWorklist2Begun(it, claim) ? begun : unbegun).push(it.id);
  }
  var n = window.__bramSelectionSharedFileCount(items, sel, claim);

  // Mixed begun + unbegun: Start is foreclosed by the begun items, Commit by
  // the unbegun ones, so no joint Start or Commit exists for this selection.
  // Direct the selection change that unlocks each half. Names appear once, in
  // the first half; the guidance half refers back ("the started item") rather
  // than repeating long kebab-case ids.
  if (begun.length && unbegun.length) {
    return (
      window.__bramNameList(begun) +
      (begun.length === 1 ? " already has" : " already have") +
      " changes and " + window.__bramNameList(unbegun) +
      (unbegun.length === 1 ? " has" : " have") +
      " not started, so this selection has no joint Start or Commit. Select " +
      (begun.length === 1 ? "the started item alone" : "only the started items") +
      " to commit, or " +
      (unbegun.length === 1 ? "the proposed one to start it" : "one or more proposed ones to start them") +
      (n ? " (their edits would then mix)" : "") + "."
    );
  }

  // All unbegun: Start is lit, and the consequence of clicking it is the
  // one thing worth saying -- and only when the items share files.
  if (!begun.length) {
    if (!n) return "";
    return (
      "These share " + (n === 1 ? "a file" : n + " files") +
      ". Started together, their edits mix. You can later choose to commit " +
      "together or ask the agent to separate them."
    );
  }

  // All begun. Find items Commit is withheld from: `proposed` with no
  // exclusive changed path (applied items skip exclusivity, mirroring
  // __bramSelectionAllCommittable), and collect who blocks them.
  var blocked = [];
  var empty = [];
  var blockerSet = {};
  var sharedPathSet = {};
  for (var b = 0; b < begun.length; b++) {
    var itb = byId[begun[b]];
    if ((itb.status || "proposed") === "applied") continue;
    var split = window.__bramItemChangedSplit(itb, list, claim);
    if (split.exclusive.length) continue;
    // issue-351: zero changes is NOT entanglement. An empty change set has
    // a vacuously empty exclusive list, and with no blockers the `mutual`
    // arm below fired the "entangled in shared files" copy on a lone item
    // with an empty CHANGES column — sending the user to separate edits
    // that do not exist. The ordinary state of a freshly begun item gets
    // the ordinary sentence instead.
    var hasAnyChange =
      (itb.changeSummary && itb.changeSummary.changed > 0) ||
      split.shared.length > 0 ||
      split.sharedDeclared.length > 0;
    if (!hasAnyChange) {
      empty.push(itb.id);
      continue;
    }
    blocked.push(itb.id);
    var paths = split.shared.concat(split.sharedDeclared);
    for (var p = 0; p < paths.length; p++) sharedPathSet[paths[p]] = true;
    var files = itb.changedFiles || [];
    for (var f = 0; f < files.length; f++) {
      var sharers = (files[f] && files[f].sharedWith) || [];
      for (var w = 0; w < sharers.length; w++) {
        var o = byId[sharers[w]];
        if (o && o.id !== itb.id && window.__bramWorklist2Begun(o, claim)) {
          blockerSet[o.id] = true;
        }
      }
    }
  }
  if (empty.length && !blocked.length) {
    return (
      window.__bramNameList(empty) +
      (empty.length === 1 ? " has" : " have") +
      " no changes yet — nothing to commit."
    );
  }
  if (blocked.length) {
    var who = Object.keys(blockerSet);
    var pathCount = Object.keys(sharedPathSet).length;
    // Advise committing a blocker first only when some blocker is itself
    // committable alone; mutually-entangled proposed items have no such
    // exit, and "commit X first" would name another withheld button.
    var advisable = [];
    var mutual = true;
    for (var a = 0; a < who.length; a++) {
      if (blocked.indexOf(who[a]) !== -1) continue;
      mutual = false;
      var oa = byId[who[a]];
      if (!oa) continue;
      if (window.__bramSelectionAllCommittable(list, [oa.id], claim)) {
        advisable.push(oa.id);
      }
    }
    if (mutual) {
      return (
        window.__bramNameList(blocked) + "'s edits are entangled in " +
        (pathCount === 1 ? "a shared file" : "shared files") +
        "; " + (blocked.length === 2 ? "neither" : "none") +
        " has exclusive changes, so Commit is withheld. Ask the agent to " +
        "separate their edits."
      );
    }
    var head =
      window.__bramNameList(blocked) + "'s changes share " +
      (pathCount === 1 ? "a file" : "files") + " with " +
      window.__bramNameList(who) +
      "'s, so nothing is exclusively " +
      (blocked.length === 1 ? "its" : "their") +
      " own and Commit is withheld. ";
    if (advisable.length) {
      // No repeated names in the guidance half: the blockers were just named,
      // so refer back -- unless advisable is a strict subset of them, where
      // the pronoun would be ambiguous and the names earn their keep.
      var advRef =
        advisable.length === who.length
          ? (advisable.length === 1 ? "it alone" : "only those")
          : (advisable.length === 1 ? advisable[0] + " alone" : "only " + window.__bramNameList(advisable));
      return (
        head + "Select " + advRef +
        " to commit first, or ask the agent to separate their edits."
      );
    }
    return head + "Ask the agent to separate their edits.";
  }

  // All begun, all committable: the radio group carries the granularity
  // choice; the line only flags that shared edits are already mixed.
  if (!n) return "";
  return (
    "These share " + (n === 1 ? "a file" : n + " files") + ". " +
    (begun.length === 2 ? "Both" : "All") +
    " already have changes on disk; their edits in shared files mix. " +
    "You can commit together or ask the agent to separate them."
  );
};

// issue-275-a1: the Transcript's unmount cleanup as ONE synchronous call.
// `onUnmount` is synchronous-only by contract and async handlers report a
// lifecycle violation
// (xmlui.org/docs/managed-react/managed-lifecycle-vocabulary). The handler was
// two statements plus an inline Object.assign, which the engine classified as
// async -- so `__bramSetTranscriptMounted(false)` never ran, leaving the
// mounted flag true from another tab. helpers.js:6870 already carries a
// route-check workaround for exactly that consequence.
//
// NOT moved to `onBeforeDispose`, which the engine's own error message
// recommends: that hook is exposed only by container components (App, Page,
// Form, NestedApp, Container). The Transcript's root is a VStack, so the
// advice does not apply and following it would have silently done nothing.
window.__bramTranscriptUnmount = function (atBottom, total) {
  window.__bramSetTranscriptMounted(false);
  window.__bramSetVisibleRange(
    Object.assign({}, window.__bramVisibleRange || {}, {
      atBottom: atBottom,
      total: total,
    }),
  );
};

window.__bramOverlapIndex = function (items, claim) {
  var list = items || [];
  var byId = {};
  var byPath = {};
  var i, f, files;
  for (i = 0; i < list.length; i++) {
    if (list[i] && list[i].id) byId[list[i].id] = list[i];
  }
  for (i = 0; i < list.length; i++) {
    files = window.__bramItemFiles(list[i]);
    for (f = 0; f < files.length; f++) {
      if (!byPath[files[f]]) byPath[files[f]] = [];
      byPath[files[f]].push(list[i].id);
    }
  }
  var out = [];
  Object.keys(byPath).forEach(function (path) {
    var ids = byPath[path];
    if (ids.length < 2) return;
    var begun = 0;
    for (var c = 0; c < ids.length; c++) {
      if (byId[ids[c]] && window.__bramWorklist2Begun(byId[ids[c]], claim)) begun++;
    }
    out.push({ path: path, claimants: ids, begunCount: begun, total: ids.length });
  });
  out.sort(function (a, b) {
    var ao = a.begunCount > 0 ? 1 : 0;
    var bo = b.begunCount > 0 ? 1 : 0;
    if (ao !== bo) return bo - ao;
    if (a.begunCount !== b.begunCount) return b.begunCount - a.begunCount;
    if (a.total !== b.total) return b.total - a.total;
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  });
  return out;
};

// Board header. `across all N items` when a file is claimed by everyone:
// universality is the useful collapsed fact, and it is what the clique
// degenerates to.
window.__bramOverlapHeaderLine = function (items, claim) {
  var list = items || [];
  var n = list.length;
  var index = window.__bramOverlapChangedIndex(list, claim);
  var head = n + " item" + (n === 1 ? "" : "s");
  // Two different absences, and the distinction is the point of this item: no
  // item pair shares a path at all, versus a pair that shares one where
  // nothing has been written yet. The second used to read as contention.
  // worklist-surface-planned-overlap: declared-but-unchanged overlap gets its
  // own clause instead of hiding inside "no shared files changed" \u2014 the live
  // case that motivated this had two proposed items planning the same two
  // files and a header the reader heard as "no overlap".
  var declaredIdx = window.__bramOverlapIndex(list, claim) || [];
  var changedPaths = {};
  index.forEach(function (e) { changedPaths[e.path] = true; });
  var plannedOnly = declaredIdx.filter(function (e) { return !changedPaths[e.path]; }).length;
  var plannedClause = plannedOnly
    ? " \u00b7 " + plannedOnly + " file" + (plannedOnly === 1 ? "" : "s") + " planned by multiple items"
    : "";
  if (!index.length) {
    return head + (declaredIdx.length
      ? " \u00b7 no shared files changed" + plannedClause
      : " \u00b7 no shared files");
  }
  var touched = {};
  index.forEach(function (e) { e.claimants.forEach(function (id) { touched[id] = true; }); });
  var k = Object.keys(touched).length;
  return head + " \u00b7 " + index.length + " shared file" + (index.length === 1 ? "" : "s") +
    " across " + (k === n && n > 1 ? "all " : "") + k + " item" + (k === 1 ? "" : "s") +
    plannedClause;
};

// The overlap that MATTERS AT THE GATE: declared overlap intersected with
// paths that have actually changed. __bramOverlapIndex above answers the
// pre-Start question and must stay on declared `files` -- see its consumer
// __bramSelectionSharedFileCount, whose whole point is that predictions are
// all that exist before work begins. This one answers the commit-gate
// question, and every peer surface (__bramItemChangedSplit and everything
// built on it) already reasons this way; the index was the outlier.
//
// The dirtiness test is about the FILE, not about who wrote it. `changedFiles`
// is per item but scoped to that item's own declared paths, so two claimants
// of a dirty shared path both carry a record for it and neither record says
// who authored a hunk. Bram has no per-hunk authorship (#327, closed
// won't-build) -- and two items on a dirty shared file is contention
// PRECISELY because which of them wrote it cannot be known.
window.__bramOverlapChangedIndex = function (items, claim) {
  var declared = window.__bramOverlapIndex(items, claim) || [];
  if (!declared.length) return [];
  var list = items || [];
  var dirty = {};
  var byId = {};
  for (var i = 0; i < list.length; i++) {
    if (list[i] && list[i].id) byId[list[i].id] = list[i];
    var files = (list[i] && list[i].changedFiles) || [];
    for (var j = 0; j < files.length; j++) {
      var f = files[j];
      if (!f || !f.path) continue;
      if ((f.added || 0) > 0 || (f.removed || 0) > 0) dirty[f.path] = true;
    }
  }
  // Dirty is NOT sufficient, and shipping it alone reproduced the very false
  // positive this item exists to remove: with no per-hunk authorship, a dirty
  // path is credited to every declarant, so one item doing all the work reads
  // as contention with claimants that never started. __bramItemChangedSplit
  // has always required a BEGUN sharer for exactly this reason; begunCount is
  // already on every entry. An item that has not begun cannot have written
  // anything, which is the one authorship fact Bram does know for certain.
  //
  // Narrow the CLAIMANTS too, not only the row. Filtering which rows appear and
  // then handing back __bramOverlapIndex's entry untouched left `claimants` and
  // `total` on the DECLARED basis, so a proposed item with nothing on disk was
  // still named in "claimed by", counted in "items", and counted in the board
  // header. That is this same defect one level down, and it survived a rendered
  // check because the board then held only two declarants per path -- the
  // fixture could not fail.
  var out = [];
  for (var e = 0; e < declared.length; e++) {
    var entry = declared[e];
    if (!dirty[entry.path] || (entry.begunCount || 0) < 2) continue;
    var begun = (entry.claimants || []).filter(function (id) {
      var it = byId[id];
      return !!it && window.__bramWorklist2Begun(it, claim);
    });
    out.push({
      path: entry.path,
      claimants: begun,
      begunCount: begun.length,
      total: begun.length,
    });
  }
  return out;
};

// worklist-surface-planned-overlap: the panel (and its hover→row tint) now
// serves the Start decision too, not only the commit-gate one. Contention
// rows keep primacy (c20b4c9's verdict intact: predictions are not
// contention); planned-only rows follow, tense-marked, because the live case
// that reopened this had two proposed items planning the same files and no
// surface offering the claimant↔row hover at exactly the moment order was
// being decided.
window.__bramOverlapDisplayIndex = function (items, claim) {
  var changed = window.__bramOverlapChangedIndex(items, claim) || [];
  var seen = {};
  var out = [];
  changed.forEach(function (e) {
    seen[e.path] = true;
    e.planned = false;
    out.push(e);
  });
  (window.__bramOverlapIndex(items, claim) || []).forEach(function (e) {
    if (!seen[e.path]) {
      e.planned = true;
      out.push(e);
    }
  });
  return out;
};

window.__bramOverlapAny = function (items, claim) {
  return window.__bramOverlapDisplayIndex(items, claim).length > 0;
};


// One index row. `all N items` for a universal file.
window.__bramOverlapRowCount = function (entry, items) {
  if (!entry) return "";
  var n = (items || []).length;
  return (entry.total === n && n > 1 ? "all " : "") + entry.total + " items";
};

// overlap-hover-row-emphasis: the claimant→row tie. Hovering a Shared files
// row in the Review-overlaps disclosure publishes its claimant ids; worklist
// rows subscribe and tint while their id is in the focused set. This is the
// one thing the dropped issue-278 graph was recruited to deliver
// ("the linking channel isn't wasted work; it's wired to the wrong
// surface") — the store/subscription shape is cherry-picked from that
// item's stash, simplified from graph-neighborhood keys to bare item ids
// because the table row already names its claimants. The trigger is the
// engine's Table rowEnter/rowLeave pair (vendored 869cc89): enter fires
// once per row (not per cell), leave is the documented clearing pair.
window.__bramOverlapFocus = { itemIds: [], pinnedKey: null };
var __bramOverlapFocusSubscribers = new Set();

function __bramPublishOverlapFocus(next) {
  window.__bramOverlapFocus = next;
  __bramOverlapFocusSubscribers.forEach(function (fn) {
    try { fn(next); } catch (e) { console.error("[bramSubscribeOverlapFocus] subscriber threw:", e); }
  });
}

window.bramSubscribeOverlapFocus = (function () {
  var factory;
  return function () {
    if (factory) return factory;
    factory = function (emit) {
      var fire = function (value) { emit(value || window.__bramOverlapFocus); };
      __bramOverlapFocusSubscribers.add(fire);
      fire();
      return function () { __bramOverlapFocusSubscribers.delete(fire); };
    };
    return factory;
  };
})();

window.__bramSetOverlapFocus = function (claimantIds) {
  if (window.__bramOverlapFocus && window.__bramOverlapFocus.pinnedKey) return; // pin wins over hover
  var ids = (claimantIds || []).filter(Boolean);
  var cur = (window.__bramOverlapFocus && window.__bramOverlapFocus.itemIds) || [];
  if (cur.length === ids.length && ids.every(function (id, i) { return cur[i] === id; })) return;
  __bramPublishOverlapFocus({ itemIds: ids, pinnedKey: null });
};

window.__bramClearOverlapFocus = function () {
  if (window.__bramOverlapFocus && window.__bramOverlapFocus.pinnedKey) return; // pin survives rowLeave
  if (!((window.__bramOverlapFocus && window.__bramOverlapFocus.itemIds) || []).length) return;
  __bramPublishOverlapFocus({ itemIds: [], pinnedKey: null });
};

// overlap-pin-on-click: click a row in the overlap table to hold its
// highlight across scrolling. Same-row click releases (falling back to
// hover state, since the pointer is on the row); a different row moves
// the pin. Collapsing the disclosure releases via
// __bramOverlapToggleOpen.
window.__bramToggleOverlapPin = function (key, claimantIds) {
  var ids = (claimantIds || []).filter(Boolean);
  var cur = window.__bramOverlapFocus || {};
  if (cur.pinnedKey === key) {
    __bramPublishOverlapFocus({ itemIds: ids, pinnedKey: null });
  } else {
    __bramPublishOverlapFocus({ itemIds: ids, pinnedKey: key });
  }
};

window.__bramOverlapToggleOpen = function (open) {
  if (open && window.__bramOverlapFocus && window.__bramOverlapFocus.pinnedKey) {
    __bramPublishOverlapFocus({ itemIds: [], pinnedKey: null });
  }
  return !open;
};

window.__bramOverlapFocusedRow = function (focus, itemId) {
  return !!(focus && focus.itemIds && focus.itemIds.includes(itemId));
};

window.__bramOverlapPinnedRow = function (focus, key) {
  return !!(focus && focus.pinnedKey === key);
};

// issue-266-close-declaration-inline: state helpers for the inline close
// declaration at the commit gate. The map holds per-item close state only
// once the user touches a tickbox; untouched items derive default state
// (everything ticked) from closesIssues. Self-contained replicas of
// Globals.xs initCloseIssueState/setCloseIssueClose — the xs functions
// proved NOT reachable as window.* from a click handler
// ("window.initCloseIssueState is not a function", live Approve failure
// 2026-08-20), so helpers.js must not lean on xs hoisting. State shape
// must match __bramBuildCloseIssueLines: { <issueNumber>: {close, comment} }.
function __bramDefaultCloseState(closesIssues) {
  var state = {};
  (closesIssues || []).forEach(function (entry) {
    var n = entry && typeof entry === "object" ? entry.number : entry;
    state[n] = { close: true, comment: "" };
  });
  return state;
}
window.__bramInlineCloseState = function (map, item) {
  if (map && item && map[item.id]) return map[item.id];
  return __bramDefaultCloseState((item && item.closesIssues) || []);
};
window.__bramInlineCloseToggle = function (map, itemId, issueNumber, checked, closesIssues) {
  var next = Object.assign({}, map || {});
  var st = next[itemId] || __bramDefaultCloseState(closesIssues || []);
  var prev = st[issueNumber] || { close: true, comment: "" };
  var updated = Object.assign({}, st);
  updated[issueNumber] = Object.assign({}, prev, { close: !!checked });
  next[itemId] = updated;
  return next;
};
// issue-267-close-comment-box: optional per-issue note, prepended by the
// host to the automatic "Closed by <commit-url>" comment. Same map shape
// as the toggle; the composer already emits `close-issue: N comment: "..."`
// when comment is non-empty.
window.__bramInlineCloseComment = function (map, itemId, issueNumber, text, closesIssues) {
  var next = Object.assign({}, map || {});
  var st = next[itemId] || __bramDefaultCloseState(closesIssues || []);
  var prev = st[issueNumber] || { close: true, comment: "" };
  var updated = Object.assign({}, st);
  updated[issueNumber] = Object.assign({}, prev, { comment: text || "" });
  next[itemId] = updated;
  return next;
};

// issue-265: per-item indicator text. Animated dots come from a tick the
// caller advances; the verb comes from __bramItemInflightKind so the row and
// the header banner cannot disagree about what is happening.
window.__bramItemInflightText = function (claim, itemId, echoItemId, echoKind, tick) {
  var kind = window.__bramItemInflightKind(claim, itemId, echoItemId, echoKind, tick);
  if (!kind) return "";
  var label = window.__bramInflightActionLabel(kind);
  if (!label) return "";
  return label + ".".repeat(1 + (((tick || 0) % 3) + 3) % 3);
};

// issue-265: the ONE per-item indicator. Previously three surfaces reported
// overlapping facts and could contradict each other — a local-only spinner, an
// "Approving..." line with a local fallback, and the authorization badge.
// Precedence: an in-flight transition wins; otherwise an unconsumed
// authorization shows. Empty string means the row has nothing to say.
window.__bramItemStatusText = function (claim, item, echoItemId, echoKind, tick) {
  var id = item && item.id;
  var inflight = window.__bramItemInflightText(claim, id, echoItemId, echoKind, tick);
  if (inflight) return inflight;
  var auth = item && item.activeAuthorization;
  if (auth) return (auth === "drop" ? "DROP" : "APPROVED") + " · awaiting agent";
  return "";
};

window.__bramItemStatusIsInflight = function (claim, item, echoItemId, echoKind, tick) {
  return window.__bramItemInflightKind(claim, item && item.id, echoItemId, echoKind, tick) !== "";
};

window.__bramItemStatusTooltip = function (claim, item, echoItemId, echoKind, tick) {
  if (window.__bramItemStatusIsInflight(claim, item, echoItemId, echoKind, tick)) {
    return "A Worklist lifecycle transition is in flight for this item.";
  }
  var auth = item && item.activeAuthorization;
  if (!auth) return "";
  var mins = Math.round(((item && item.authorizationAgeMs) || 0) / 60000);
  return "An unconsumed " + auth + " authorization from " + mins +
    " min ago covers this item. The agent has not advanced it yet; " +
    "re-clicking the button refreshes the authorization.";
};

// project-identity-chip: deterministic hue for the project chip and the
// AppHeader's bottom border, so two Brams running side by side are told
// apart without reading anything. FNV-1a over the absolute project root
// (stable across restarts and machines with the same checkout path),
// then spread around the wheel by the golden angle so neighbouring hash
// values don't land on neighbouring colors.
window.__bramProjectHue = function (key) {
  var s = String(key || "");
  if (!s) return 210;
  var h = 2166136261;
  for (var i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.round(((h >>> 0) * 137.508) % 360);
};

// Chip background / border color at a fixed saturation+lightness, so the
// tint reads the same weight in either theme and never fights the
// surface colors. `alpha` lets the same hue serve the chip fill and the
// 2px header rule at different strengths.
window.__bramProjectTint = function (key, alpha) {
  var a = typeof alpha === "number" ? alpha : 1;
  return "hsla(" + window.__bramProjectHue(key) + ", 62%, 45%, " + a + ")";
};

// Chip label: the home-shortened project path, with the repo slug in the
// tooltip rather than the label so the chip stays short. Falls back to
// the path when the host published no repo (no origin remote).
window.__bramProjectTooltip = function (info) {
  if (!info) return "";
  return info.repo ? info.project + " · " + info.repo : info.project || "";
};

// Badge takes a dynamic background only through colorMap (value -> color),
// so the chip's one-entry map is built here rather than as an inline
// object literal in the markup.
// https://docs.xmlui.org/components/Badge
window.__bramProjectColorMap = function (info) {
  var map = {};
  if (!info || !info.project) return map;
  map[info.project] = {
    background: window.__bramProjectTint(info.projectKey, 1),
    label: "#ffffff",
  };
  return map;
};

// Header band wash behind the whole AppHeader row. Low alpha so it reads
// as a tint in either theme without touching text contrast. Returned as a
// single helper call (not an inline ternary in the binding) — inline
// ternaries in attribute expressions have defeated XMLUI's dependency
// tracking before; see the search-date endpoint-label bug.
window.__bramProjectBandTint = function (info) {
  if (!info || !info.projectKey) return "transparent";
  return window.__bramProjectTint(info.projectKey, 0.12);
};

window.__bramStripImageMarkerPrefix = function (text) {
  return (text || "").replace(/^(\s*Read this screenshot: @\S+\s*)+/, "").trim();
};

// Plain-JS equivalent of xs `App.mark(label)`. App.mark pushes a
// `kind: "app:mark"` record to the Inspector buffer at window._xsLogs
// (xmlui/src/components-core/appContext/app-utils.ts:49-53). The
// pure-JS helpers below preserve the marks so Inspector exports stay
// comparable across the migration.
function __bramAppMark(label) {
  try {
    if (!window._xsLogs) return;
    var perfTs = (typeof performance !== "undefined" && performance.now) ? performance.now() : 0;
    window._xsLogs.push({ kind: "app:mark", ts: Date.now(), label: label, perfTs: perfTs });
  } catch (e) {}
}

window.__bramWorklistActionStatusLabel = function (item) {
  var status = (item && item.status) || "proposed";
  if (status === "applied") return "To Commit";
  if (status === "proposed") return "To Apply";
  return status ? status.charAt(0).toUpperCase() + status.slice(1) : "Worklist";
};

window.__bramWorklistActionDisplay = function (kind, items) {
  var action =
    kind === "approved" ? "Started" :
    kind === "iterate" ? "Refined" :
    kind === "drop" ? "Dropped" :
    "Submitted";
  var ids = (items || []).map(function (i) {
    if (typeof i === "string") return i;
    return (i && i.id) || "";
  }).filter(Boolean);
  if (ids.length === 0) return action;
  if (ids.length === 1) return action + " " + ids[0];
  return action + " " + ids.length + " items: " + ids.join(", ");
};

window.__bramWorklistActionStatusSuffix = function (item) {
  var status = (item && item.status) || "proposed";
  if (status === "applied") return " to commit";
  if (status === "proposed") return " to apply";
  return "";
};

window.__bramWorklistActionConversationDisplay = function (kind, items, selectedId, feedback) {
  var selected = (items || []).filter(function (i) { return i.id === selectedId; });
  var suffix = selected.length === 1 ? window.__bramWorklistActionStatusSuffix(selected[0]) : "";
  return window.__bramWorklistActionDisplay(kind, selected) + suffix;
};

window.__bramTraceIterateEnabled = function (submitting, selected, selectedFeedback) {
  __bramAppMark("iterate-enabled");
  return !submitting && !!selected && (selectedFeedback || "").trim().length > 0;
};

window.__bramTraceApproveDropEnabled = function (submitting, selected) {
  __bramAppMark("approve-drop-enabled");
  return !submitting && !!selected;
};

// Gate label baked into approve/drop/iterate payloads so the display can show
// TO APPLY vs TO COMMIT even after the item transitions or is pruned
// (approval-turn-specify-gate). The projection can't recover the pre-action
// status, so it must ride in the payload.
window.__bramItemGate = function (i) {
  return (((i && i.status) || "proposed") === "applied") ? "to commit" : "to apply";
};

window.__bramBuildApprovePayload = function (items, selectedId, feedback, oneShot) {
  __bramAppMark("build-approve-payload");
  return JSON.stringify({
    items: (items || []).filter(function (i) { return i.id === selectedId; })
      .map(function (i) { return { id: i.id, feedback: feedback, gate: oneShot ? "apply-and-commit" : window.__bramItemGate(i) }; }),
  });
};

window.__bramBuildIteratePayload = function (items, selectedId, feedback) {
  __bramAppMark("build-iterate-payload");
  // feedback may be either an inline string (backward-compat) or a
  // `{ feedbackRef: "<id>" }` object (new, from queueFeedbackDraft).
  return JSON.stringify({
    items: (items || []).filter(function (i) { return i.id === selectedId; })
      .map(function (i) {
        return feedback && typeof feedback === "object" && feedback.feedbackRef
          ? { id: i.id, feedbackRef: feedback.feedbackRef, gate: window.__bramItemGate(i) }
          : { id: i.id, feedback: feedback, gate: window.__bramItemGate(i) };
      }),
  });
};

window.__bramBuildDropPayload = function (items, selectedId, feedback) {
  __bramAppMark("build-drop-payload");
  return JSON.stringify({
    items: (items || []).filter(function (i) { return i.id === selectedId; })
      .map(function (i) { return { id: i.id, feedback: feedback, gate: window.__bramItemGate(i) }; }),
  });
};

window.__bramBuildApproveItems = function (items, selectedId, feedback, oneShot) {
  return (items || []).filter(function (i) { return i.id === selectedId; })
    .map(function (i) { return { id: i.id, feedback: feedback, gate: oneShot ? "apply-and-commit" : window.__bramItemGate(i) }; });
};

window.__bramBuildDropItems = function (items, selectedId, feedback) {
  return (items || []).filter(function (i) { return i.id === selectedId; })
    .map(function (i) { return { id: i.id, feedback: feedback }; });
};

window.__bramBuildSingleItemApprovePayload = function (itemRef, feedback, oneShot) {
  __bramAppMark("build-single-item-approve-payload");
  return JSON.stringify({
    items: [{ id: itemRef.id, feedback: feedback, gate: oneShot ? "apply-and-commit" : window.__bramItemGate(itemRef) }],
  });
};

window.__bramCountByStatus = function (items, status) {
  return (items || []).filter(function (i) { return (i.status || "proposed") === status; }).length;
};

// rung8-batch-as-selection: batching is selection, not a mode. Targets
// come from an explicit selectedIds list when given (the tickboxes);
// the no-selection fallback keeps the legacy all-applied behavior.
// Feedback may be a string (same for all) or the feedbackDraftsById map
// (per-item feedback boxes keep working in a batch).
function __bramBatchTargets(items, selectedIds) {
  var list = items || [];
  if (selectedIds && selectedIds.length) {
    return list.filter(function (i) {
      return selectedIds.indexOf(i.id) !== -1;
    });
  }
  return list.filter(function (i) {
    return (i.status || "proposed") === "applied";
  });
}
function __bramBatchFeedbackFor(feedback, id) {
  if (feedback && typeof feedback === "object") return feedback[id] || "";
  return feedback || "";
}

// worklist2-batch-close-lines: the single-gate cutover orphaned the
// per-row close-composer path, so batch commits queued no closes. For
// commit-bound batch payloads (Commit N, Approve & commit N) each
// item's feedback gains close-issue: lines from the inline tickbox
// state (default all ticked) when the item declares closesIssues.
function __bramBatchFeedbackWithCloses(feedback, item, closeMap) {
  var base = __bramBatchFeedbackFor(feedback, item.id);
  if (!closeMap || !item.closesIssues || !item.closesIssues.length) return base;
  var lines = __bramBuildCloseIssueLines(window.__bramInlineCloseState(closeMap, item));
  if (!lines.length) return base;
  return (base ? base + "\n" : "") + lines.join("\n");
}

window.__bramBuildBatchApprovePayload = function (items, feedback, selectedIds, oneShot, closeMap) {
  __bramAppMark("build-batch-approve-payload");
  return JSON.stringify({
    items: __bramBatchTargets(items, selectedIds).map(function (i) {
      return { id: i.id, feedback: __bramBatchFeedbackWithCloses(feedback, i, closeMap), gate: oneShot ? "apply-and-commit" : window.__bramItemGate(i) };
    }),
  });
};

window.__bramBuildBatchApproveItems = function (items, feedback, selectedIds, oneShot, closeMap) {
  return __bramBatchTargets(items, selectedIds).map(function (i) {
    return oneShot
      ? { id: i.id, feedback: __bramBatchFeedbackWithCloses(feedback, i, closeMap), gate: "apply-and-commit" }
      : { id: i.id, feedback: __bramBatchFeedbackWithCloses(feedback, i, closeMap) };
  });
};

window.__bramBuildBatchDropPayload = function (items, feedback, selectedIds) {
  __bramAppMark("build-batch-drop-payload");
  return JSON.stringify({
    items: __bramBatchTargets(items, selectedIds).map(function (i) {
      return { id: i.id, feedback: __bramBatchFeedbackFor(feedback, i.id), gate: window.__bramItemGate(i) };
    }),
  });
};

window.__bramBuildBatchDropItems = function (items, feedback, selectedIds) {
  return __bramBatchTargets(items, selectedIds).map(function (i) {
    return { id: i.id, feedback: __bramBatchFeedbackFor(feedback, i.id) };
  });
};

// worklist-action-state-store: submission state (the eight fields the
// worklist action handlers used to juggle as Workspace component vars)
// moves into this helpers-owned store. Workspace subscribes and mirrors
// the fields into its legacy vars via one ChangeListener, so the ~150
// reader bindings stay untouched; every WRITER routes through here.
// __bramWorklistActApply absorbs the shared handler tail (publish the
// prepared submission, submit the turn, reset on completion), leaving
// handlers a prep call plus their UI-state bookkeeping.
window.__bramWorklistActionState = {
  submitting: false,
  actionProgressScope: "",
  actionProgressKind: "",
  actionProgressTick: 0,
  submittedItemId: null,
  submittedKind: "",
  awaitingResponse: false,
  worklistActionResult: null,
  rev: 0,
};
window.__bramWorklistActionSubscribers = new Set();
window.__bramNotifyWorklistActionState = function () {
  window.__bramWorklistActionState.rev++;
  var snap = Object.assign({}, window.__bramWorklistActionState);
  window.__bramWorklistActionSubscribers.forEach(function (fn) {
    try {
      fn(snap);
    } catch (e) {
      console.error("[worklist-action-store] subscriber threw:", e);
    }
  });
};
window.bramSubscribeWorklistActionState = (function () {
  var factory;
  return function () {
    if (factory) return factory;
    factory = function (emit) {
      var fire = function (s) {
        emit(s || Object.assign({}, window.__bramWorklistActionState));
      };
      window.__bramWorklistActionSubscribers.add(fire);
      fire();
      return function () {
        window.__bramWorklistActionSubscribers.delete(fire);
      };
    };
    return factory;
  };
})();
window.__bramSetWorklistActionState = function (partial) {
  Object.assign(window.__bramWorklistActionState, partial || {});
  window.__bramNotifyWorklistActionState();
};
window.__bramWorklistActionTickBump = function () {
  window.__bramSetWorklistActionState({
    actionProgressTick: window.__bramWorklistActionState.actionProgressTick + 1,
  });
};
window.__bramWorklistActReset = function () {
  window.__bramSetWorklistActionState({
    submitting: false,
    actionProgressScope: "",
    actionProgressKind: "",
    actionProgressTick: 0,
    submittedItemId: null,
    submittedKind: "",
    awaitingResponse: false,
    worklistActionResult: null,
  });
};
window.__bramWorklistActApply = function (r) {
  window.__bramSetWorklistActionState({
    submitting: true,
    actionProgressScope: r.actionProgressScope || "",
    actionProgressKind: r.actionProgressKind || "",
    actionProgressTick: 0,
    submittedItemId: r.submittedItemId || null,
    submittedKind: r.submittedKind || "",
    worklistActionResult: r,
  });
  window.submitAuthorizedWorklistTurn(r, function () {
    window.__bramWorklistActReset();
  });
  return r;
};

// worklist2-remember-expansion: Worklist2 expander state, in SESSION storage
// (its own key, so the two tabs' states never interfere). Keys are
// <itemId> for rows, <itemId>::<section> for sections. Prune runs on each
// worklist load against current item ids so dead keys don't accumulate.
//
// sessionStorage, not localStorage, because expansion is FOCUS rather than a
// DECISION. A dismissal is a decision -- "I have seen this, stop telling me" --
// and re-nagging would undo it, so it belongs in localStorage. An expansion is
// "I am looking at this now", which is cheap to re-establish and meaningless
// once the context is gone. Persisting it across restarts made the pane open
// at whatever density you left days ago, defeating the progressive disclosure
// the collapsed default provides: you arrive at complexity you did not ask for
// in this session.
//
// Measured, not assumed (2026-08-23, three-step storage probe on the
// xmlui://localhost origin): sessionStorage is available there, survives a
// tools-pane reload, and dies with the app. A tab switch is a weaker condition
// than a reload -- route changes do not reload the iframe at all -- so the
// requirement "survives tab switches and reloads, not an app quit" is exactly
// what this primitive gives.
//
// Applied here only. Whether the same rule should govern the pane's other
// persisted state is filed rather than assumed.
window.__bramPersistWorklist2Expansion = function (keys) {
  try {
    sessionStorage.setItem("bram.worklist2.expanded", JSON.stringify(keys || []));
  } catch (e) {}
  return keys || [];
};
// inbox-open-lands-expanded: `mergeId` (optional) folds a deep-link target
// into the restored keys at mount — Awaiting You's Open navigates to
// /worklist2?expand=<id> and the row should land expanded and visible.
window.__bramRestoreWorklist2Expansion = function (mergeId) {
  var keys;
  try {
    keys = JSON.parse(sessionStorage.getItem("bram.worklist2.expanded") || "[]") || [];
  } catch (e) {
    keys = [];
  }
  if (mergeId && keys.indexOf(mergeId) === -1) {
    keys = window.__bramPersistWorklist2Expansion(keys.concat([mergeId]));
  }
  if (mergeId) window.__bramScrollWorklistRowIntoView(mergeId);
  return keys;
};
// Param changed while the Worklist is already mounted (a second Open for a
// different row): same merge + scroll, from the live keys.
window.__bramConsumeExpandParam = function (keys, id) {
  if (!id) return keys || [];
  window.__bramScrollWorklistRowIntoView(id);
  return window.__bramToggleExpansionKey(keys, id, true);
};
// rAF retry against the row's data-testid, the settings-highlight scroller's
// shape — the row may not be mounted on the first frames after navigation.
window.__bramScrollWorklistRowIntoView = function (id) {
  var tries = 0;
  var attempt = function () {
    var el = document.querySelector('[data-testid="worklist-row-' + id + '"]');
    if (el && el.scrollIntoView) {
      el.scrollIntoView({ block: "center", behavior: "smooth" });
      return;
    }
    if (tries++ < 30) requestAnimationFrame(attempt);
  };
  requestAnimationFrame(attempt);
};
window.__bramToggleExpansionKey = function (keys, key, open) {
  var next = (keys || []).filter(function (k) {
    return k !== key;
  });
  if (open) next.push(key);
  return window.__bramPersistWorklist2Expansion(next);
};
// worklist2-keyed-expansion: controlled-expander helpers. Expansion lives
// ONLY in expandedKeys (persisted, id-keyed) — never in component
// internals — so positional row reuse in the Items loop cannot carry
// state across items (the pruned-item state-transfer bug, 2026-08-20;
// see https://www.xmlui.org/docs/howto/keep-per-item-state-in-a-loop).
window.__bramChevron = function (keys, key) {
  return (keys || []).indexOf(key) !== -1 ? "▼" : "▶";
};
window.__bramFlipExpansionKey = function (keys, key) {
  var open = (keys || []).indexOf(key) === -1;
  return window.__bramToggleExpansionKey(keys, key, open);
};
window.__bramPruneWorklist2Expansion = function (validIds) {
  var ids = validIds || [];
  var kept = window.__bramRestoreWorklist2Expansion().filter(function (k) {
    return ids.indexOf(String(k).split("::")[0]) !== -1;
  });
  return window.__bramPersistWorklist2Expansion(kept);
};

// worklist2-first-action: Worklist2's first gate. Thin adapter so the
// row's onClick stays near-single-call: compose the standard single-item
// approved payload through the shared prep and submit through the state
// store — same wire, same authorization, same claim as the old tab.
window.__bramMapSet = function (map, key, value) {
  var next = Object.assign({}, map || {});
  next[key] = value;
  return next;
};
window.__bramWorklist2Approve = function (items, itemId, feedback) {
  var r = window.__bramPrepareWorklistActionSubmission({
    kind: "approved",
    items: items || [],
    selectedId: itemId,
    rawFeedback: feedback || "",
    feedbackDraftsById: {},
    expandedItemIds: [],
    voiceTarget: "message-agent",
    inflightTarget: "approve",
  });
  return window.__bramWorklistActApply(r);
};

// (worklist2-batch-close-lines: the per-row __bramWorklist2Commit that
// once ran the close composer was orphaned by the single-gate cutover
// and is deleted; the batch builders now compose close-issue: lines
// via __bramBatchFeedbackWithCloses. The legacy tab still uses
// __bramPrepareCloseIssueWorklistActionSubmission directly.)

// worklist2-iterate-and-drop: the last two verbs. Drop composes the
// standard drop: payload through the shared prep/store. Iterate's prep
// publishes the result into the action store; the send itself rides the
// old tab's sendIterateWithFeedbackDraft (a Globals.xs function, called
// BARE from the XMLUI handler — xs names are reachable in attribute
// positions, though not as window.* from real JS; today's lesson).
window.__bramWorklist2Drop = function (items, itemId, feedback) {
  var r = window.__bramPrepareWorklistActionSubmission({
    kind: "drop",
    items: items || [],
    selectedId: itemId,
    rawFeedback: feedback || "",
    feedbackDraftsById: {},
    expandedItemIds: [],
    voiceTarget: "message-agent",
    inflightTarget: "drop",
  });
  return window.__bramWorklistActApply(r);
};
window.__bramWorklist2IteratePrep = function (items, itemId, feedback) {
  var r = window.__bramPrepareWorklistActionSubmission({
    kind: "iterate",
    items: items || [],
    selectedId: itemId,
    rawFeedback: feedback || "",
    feedbackDraftsById: {},
    expandedItemIds: [],
    voiceTarget: "message-agent",
    inflightTarget: "iterate",
  });
  window.__bramSetWorklistActionState({ worklistActionResult: r });
  return r;
};

// worklist2-batch-selection (as clarified): one gate row serves one or
// several — the selection is part of the sentence. The message box's text
// fans out to every selected item's payload entry; Iterate-N composes a
// plural iterate: turn (no authorization payload — iterate claims no
// slot; the host's toTurn path raises the sentinel from the prefix).
window.__bramWorklist2CaptureSent = function (map, ids, text, atMs) {
  if (!text || !String(text).trim()) return map || {};
  var next = Object.assign({}, map || {});
  (ids || []).forEach(function (id) {
    next[id] = [{ text: text, atMs: atMs }].concat(next[id] || []);
  });
  return next;
};
window.__bramFanFeedback = function (ids, text) {
  var map = {};
  (ids || []).forEach(function (id) {
    map[id] = text || "";
  });
  return map;
};
window.__bramWorklist2BatchIterate = function (ids, text) {
  // issue-285: one iterate wire shape. The gate adopts the queue path's
  // draft-first mechanism — inline feedback rides toTurn, whose `\s+`
  // collapse and the receiving TUI's paste limits mangle anything long
  // (#144, the reason drafts exist). One draft per selected id, ref
  // `<unix-ms>-<item-id>`; a failed draft write degrades THAT item to the
  // inline shape rather than blocking the click, the same fallback
  // sendIterateWithFeedbackDraft has carried all along. Draft writes
  // complete before toTurn fires, so the host-side opt-out matcher (and
  // the agent) read files that exist.
  var list = ids || [];
  var body = text || "";
  window.__bramIframeTrace("gate-click", { stage: "prep-begin", scope: "iterate", count: list.length });
  var now = Date.now();
  var writes = list.map(function (id) {
    var ref = now + "-" + id;
    return window.queueFeedbackDraft(ref, body).then(function (wroteDraft) {
      return wroteDraft
        ? { id: id, feedbackRef: ref }
        : { id: id, feedback: body };
    });
  });
  return Promise.all(writes).then(function (items) {
    window.__bramIframeTrace("gate-click", { stage: "prep-end", scope: "iterate" });
    var r = {
      turnText: "iterate: " + JSON.stringify({ items: items }),
      authorizationPayload: null,
      submitting: true,
      submittedItemId: items.length ? items[0].id : null,
      submittedKind: window.__bramSetWorklistSubmittedKind("action"),
      actionProgressScope: "batch",
      actionProgressKind: "iterate",
      actionProgressTick: 0,
      expandedItemIds: [],
      feedbackDraftsById: {},
    };
    return window.__bramWorklistActApply(r);
  });
};

// Selection state helpers for the row tickboxes and the plural action bar.
window.__bramToggleRowSelection = function (sel, id, on) {
  var next = (sel || []).filter(function (x) {
    return x !== id;
  });
  if (on) next.push(id);
  // issue-343: the missing first link in the page→store chain. Andrew's
  // window could not distinguish "ticks never happened" (disabled box)
  // from "ticks vanished" (publish path dead) — this line makes ticks
  // affirmative evidence, so silence now means the handler never ran.
  window.__bramIframeTrace("w2-selection", {
    op: "tick",
    id: id,
    on: !!on,
    count: next.length,
  });
  return next;
};
// worklist2-approve-and-commit: the one-click gate button shows only when
// every selected row is a PLAN — proposed, with zero changed files in the
// host-computed changeSummary. Begun or mixed selections never see it:
// one-click commits sight-unseen, so it is reserved for rows where there
// is no disk evidence to review yet.
window.__bramSelectionAllPlans = function (items, sel) {
  var chosen = sel || [];
  if (chosen.length === 0) return false;
  var picked = (items || []).filter(function (i) {
    return chosen.indexOf(i.id) !== -1;
  });
  if (picked.length === 0) return false;
  return picked.every(function (i) {
    var cs = i.changeSummary;
    return (
      (i.status || "proposed") === "proposed" &&
      !(cs && cs.changed > 0)
    );
  });
};
// worklist2-mixed-selection-verbs: status-scoped verbs render only when
// the WHOLE selection matches — a verb acts on exactly the selection or
// it doesn't appear, so no click ever discards part of a selection or
// its fanned message. Mixed selections keep Iterate/Drop, which cover
// the whole set.
window.__bramSelectionAllStatus = function (items, sel, status) {
  var chosen = sel || [];
  if (chosen.length === 0) return false;
  return window.__bramSelectionIds(items, sel, status).length === chosen.length;
};
window.__bramSelectionIds = function (items, sel, status) {
  var chosen = sel || [];
  return (items || [])
    .filter(function (i) {
      return (
        chosen.indexOf(i.id) !== -1 &&
        (!status || (i.status || "proposed") === status)
      );
    })
    .map(function (i) {
      return i.id;
    });
};

window.__bramPrepareBatchWorklistActionSubmission = function (opts) {
  opts = opts || {};
  window.__bramIframeTrace("gate-click", { stage: "prep-begin", scope: "batch" });
  var items = opts.items || [];
  var kind = opts.kind === "drop" ? "drop" : "approved";
  var sel = opts.selectedIds && opts.selectedIds.length ? opts.selectedIds : null;
  var feedback = opts.feedbackDraftsById || "";
  var target =
    (kind === "drop" ? "drop" : "approve") + (sel ? "-selection" : "-all");
  var targets = __bramBatchTargets(items, sel);
  window.__bramIframeTrace("click", { target: target, count: targets.length });
  window.__bramClearWorklistUiState();
  var submittedItemId = targets.length > 0 ? targets[0].id : null;
  var submittedKind = window.__bramSetWorklistSubmittedKind("action");
  window.__bramIframeTrace("inflight-set", { item: submittedItemId, via: "click", target: target });
  var authItems = kind === "drop"
    ? window.__bramBuildBatchDropItems(items, feedback, sel)
    : window.__bramBuildBatchApproveItems(items, feedback, sel, opts.oneShot, opts.closeMap);
  window.__bramIframeTrace("gate-click", { stage: "prep-end", scope: "batch", kind: kind });
  return {
    turnText: (kind === "drop" ? "drop: " : "approved: ") + (
      kind === "drop"
        ? window.__bramBuildBatchDropPayload(items, feedback, sel)
        : window.__bramBuildBatchApprovePayload(items, feedback, sel, opts.oneShot, opts.closeMap)
    ),
    authorizationPayload: { kind: kind, items: authItems },
    submitting: true,
    submittedItemId: submittedItemId,
    submittedKind: submittedKind,
    actionProgressScope: "batch",
    actionProgressKind: kind,
    actionProgressTick: 0,
    expandedItemIds: [],
    feedbackDraftsById: {},
  };
};

// Image-marker strip kept as a presentation helper (grid-sourced
// menu-prose and dock text are not projection output). The raw-JSONL →
// turns parser chain that used to live here (sessionTurns,
// _parseLinesToTurns, tool/codex satellites) was deleted after the host
// projection (/__turns) became the single turn source — see
// docs/turn-transport-redesign.md step 7.

window.__bramStripImagePaths = function (text) {
  if (!text) return text;
  var imagePath = "(?:/[^\\]]+|[A-Za-z]:\\\\[^\\]]+)\\.(?:png|jpg|jpeg|gif|webp)";
  return text
    .replace(new RegExp("\\n*\\[Image: source: " + imagePath + "\\]", "gi"), "")
    .replace(/^(\s*Read this screenshot: @\S+\s*)+/, "")
    .trim();
};

window.__bramExtractMarkdownImages = function (text) {
  if (!text) return [];
  var urls = [];
  var md = /!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  var m;
  while ((m = md.exec(text)) !== null) urls.push(m[1]);
  var html = /<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi;
  while ((m = html.exec(text)) !== null) urls.push(m[1]);
  return urls;
};

window.__bramStripMarkdownImages = function (text) {
  if (!text) return text;
  return text
    .replace(/\n*!\[[^\]]*\]\([^)\s]+(?:\s+"[^"]*")?\)/g, "")
    .replace(/\n*<img\b[^>]*\bsrc=["'][^"']+["'][^>]*>/gi, "");
};

// Quote-aware top-level split of a compound command at && / || / ; / |
// boundaries (tool-expansion-wrap-and-describe). Display-only: each
// segment becomes its own line, continuation lines keep their
// separator as a prefix so the chain reads naturally. Separators
// inside single/double/back quotes are never split points. Long
// segments soft-wrap at spaces near the width cap with a hanging
// indent, so the code fence stops needing a horizontal scrollbar.
window.__bramSplitCommandSegments = function (body, widthCap) {
  var cap = widthCap || 96;
  var segs = [];
  var cur = "";
  var q = null;
  var i = 0;
  while (i < body.length) {
    var ch = body.charAt(i);
    if (q) {
      cur += ch;
      if (ch === q && body.charAt(i - 1) !== "\\") q = null;
      i++;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      q = ch;
      cur += ch;
      i++;
      continue;
    }
    var two = body.substr(i, 2);
    if (two === "&&" || two === "||") {
      segs.push(cur);
      cur = two + " ";
      i += 2;
      while (body.charAt(i) === " ") i++;
      continue;
    }
    if (ch === ";" || ch === "|") {
      segs.push(cur);
      cur = ch + " ";
      i += 1;
      while (body.charAt(i) === " ") i++;
      continue;
    }
    cur += ch;
    i++;
  }
  segs.push(cur);
  var lines = [];
  for (var s = 0; s < segs.length; s++) {
    var seg = (s === 0 ? segs[s].trim() : "  " + segs[s].trim());
    while (seg.length > cap) {
      var brk = seg.lastIndexOf(" ", cap);
      // A break point at or inside the 6-char hanging indent means the
      // visible content has no usable space: stop wrapping and leave the
      // long token on one line. With the old `brk <= 4` guard, a wrapped
      // continuation ("      " + >cap spaceless token, e.g. a long session
      // path or rg pattern) found brk=5 forever and rebuilt seg
      // byte-identical each pass — the transcript-expansion freeze
      // (fix-command-wrap-infinite-loop; probe capture 2026-07-12T03:34Z).
      // For brk >= 7 the segment strictly shrinks, so wrapping terminates.
      if (brk <= 6) break;
      lines.push(seg.slice(0, brk));
      seg = "      " + seg.slice(brk + 1);
    }
    lines.push(seg);
  }
  return lines;
};

window.__bramFormatToolCommand = function (command, description) {
  if (command == null) return "";
  var body = String(command);
  if (!body) return "";
  // render-supabase-execute-sql: a commandDisplay that is already a fenced code
  // block (the host emits ```sql for execute_sql) passes through verbatim so it
  // isn't re-wrapped in a bash fence.
  var fencedTrim = body.trim();
  if (fencedTrim.slice(0, 3) === "```" && fencedTrim.slice(-3) === "```") {
    return fencedTrim;
  }
  // Multi-line commands (heredocs, scripts) keep their own layout;
  // splitting/wrapping is for the single-line compound case.
  var display = body.indexOf("\n") >= 0
    ? body
    : window.__bramSplitCommandSegments(body).join("\n");
  // The agent-authored intent sentence renders as a comment above the
  // command — reliable because the calling agent wrote it at call
  // time; absent (e.g. codex shell calls) means no header, no
  // synthesis.
  var head = "";
  if (description) {
    head = "# " + String(description).replace(/\s+/g, " ").trim() + "\n";
  }
  var scan = head + display;
  var longest = 0, run = 0;
  for (var i = 0; i < scan.length; i++) {
    if (scan.charAt(i) === "`") {
      run++;
      if (run > longest) longest = run;
    } else {
      run = 0;
    }
  }
  var fenceLen = Math.max(3, longest + 1);
  var fence = "";
  for (var j = 0; j < fenceLen; j++) fence += "`";
  return fence + "bash\n" + head + display + "\n" + fence;
};

window.__bramToolInputJsonLines = function (input, maxLines) {
  var cap = maxLines || 20;
  if (input === null || input === undefined) return { lines: [], remaining: 0 };
  if (typeof input === "string") {
    var allStr = input.split("\n");
    return { lines: allStr.slice(0, cap), remaining: Math.max(0, allStr.length - cap) };
  }
  var json;
  try {
    json = JSON.stringify(input, null, 2);
  } catch (e) {
    return { lines: ["(unserializable input)"], remaining: 0 };
  }
  var all = json.split("\n");
  return { lines: all.slice(0, cap), remaining: Math.max(0, all.length - cap) };
};

// History helpers (audit step 8). All pure. Internal calls go through
// the window.__bram* versions directly so the whole chain stays in
// plain JS (xs delegators below are entry points only).

window.__bramHistoryPhaseKind = function (phase) {
  var summary = ((phase && phase.summary) || "").toLowerCase();
  if (summary.indexOf("applied") >= 0) return "applied";
  if (summary.indexOf("proposed") >= 0) return "proposed";
  return "";
};

window.__bramHistoryDecodeJsonStringValue = function (raw) {
  if (!raw) return "";
  try {
    return JSON.parse('"' + raw + '"');
  } catch (err) {
    return raw.replace(/\\n/g, "\n").replace(/\\"/g, '"');
  }
};

window.__bramHistoryExtractProseFromDiff = function (diff) {
  var lines = (diff || "").split("\n");
  var before = "";
  var after = "";
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    var afterMatch = line.match(/^\+\s+"after":\s+"(.*)"[,]?$/);
    if (afterMatch) {
      after = window.__bramHistoryDecodeJsonStringValue(afterMatch[1].replace(/",?$/, ""));
      continue;
    }
    var beforeMatch = line.match(/^\+\s+"before":\s+"(.*)"[,]?$/);
    if (beforeMatch) {
      before = window.__bramHistoryDecodeJsonStringValue(beforeMatch[1].replace(/",?$/, ""));
    }
  }
  return after || before;
};

window.__bramHistoryLatestPhase = function (group) {
  var phases = (group && group.phases) || [];
  return phases.length > 0 ? phases[phases.length - 1] : null;
};

window.__bramHistoryCurrentItem = function (group) {
  return (group && group.currentItem) || null;
};

window.__bramHistoryItemProse = function (item) {
  if (!item) return "";
  var after = typeof item.after === "string" ? item.after.trim() : "";
  if (after) return after;
  var before = typeof item.before === "string" ? item.before.trim() : "";
  return before;
};

window.__bramHistoryCurrentProsePhase = function (group) {
  var item = window.__bramHistoryCurrentItem(group);
  var itemProse = window.__bramHistoryItemProse(item);
  if (itemProse) {
    return {
      phase: window.__bramHistoryLatestPhase(group),
      prose: itemProse,
      source: "snapshot",
    };
  }
  var phases = (group && group.phases) || [];
  for (var i = phases.length - 1; i >= 0; i--) {
    var prose = window.__bramHistoryExtractProseFromDiff(phases[i].diff || "");
    if (prose) {
      return { phase: phases[i], prose: prose, source: "diff" };
    }
  }
  return { phase: null, prose: "", source: "" };
};

window.__bramHistoryCardProsePreview = function (group) {
  var current = window.__bramHistoryCurrentProsePhase(group).prose || "";
  var normalized = current.replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  if (normalized.length <= 240) return normalized;
  return normalized.slice(0, 237).trimEnd() + "...";
};

window.__bramHistoryDateParts = function (iso) {
  if (!iso) return { date: "", time: "" };
  var d = new Date(iso);
  if (isNaN(d.getTime())) {
    return { date: iso.slice(0, 10), time: iso.slice(11, 16) };
  }
  var pad = function (n) { return String(n).padStart(2, "0"); };
  return {
    date: d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()),
    time: pad(d.getHours()) + ":" + pad(d.getMinutes()),
  };
};

window.__bramHistoryDateRangeLine = function (group) {
  var phases = (group && group.phases) || [];
  if (!phases.length) return "";
  var first = window.__bramHistoryDateParts((phases[0] || {}).iso || "");
  var last = window.__bramHistoryDateParts((phases[phases.length - 1] || {}).iso || "");
  if (first.date && first.date === last.date) {
    return "On " + first.date + " from " + first.time + " to " + last.time;
  }
  return "From " + first.date + " " + first.time + " to " + last.date + " " + last.time;
};

window.__bramHistoryPhaseLabel = function (phase) {
  if (phase && phase.kind === "feedback") return "Feedback";
  var summary = ((phase && phase.summary) || "").toLowerCase();
  if (summary.indexOf("committed") >= 0) return "Committed";
  if (summary.indexOf("applied") >= 0) return "Applied";
  if (summary.indexOf("proposed") >= 0) return "Proposed";
  if (summary.indexOf("dropped") >= 0 || summary.indexOf("pruned") >= 0) return "Dropped";
  return (phase && phase.summary) || "Changed";
};

window.__bramHistoryPhasePath = function (group) {
  var phases = (group && group.phases) || [];
  var labels = [];
  for (var i = 0; i < phases.length; i++) {
    var label = window.__bramHistoryPhaseLabel(phases[i]);
    if (labels[labels.length - 1] !== label) labels.push(label);
  }
  return labels.join(" -> ");
};

window.__bramHistoryCommitUrl = function (group) {
  var phases = (group && group.phases) || [];
  for (var i = phases.length - 1; i >= 0; i--) {
    var phase = phases[i] || {};
    var summary = (phase.summary || "").toLowerCase();
    var url = typeof phase.commitUrl === "string" ? phase.commitUrl.trim() : "";
    if (url && summary.indexOf("committed") >= 0) return url;
  }
  return "";
};

// issue-277 A2: the group-level twin of __bramHistoryCommitUrl for the
// host's local SHA classification. "orphaned" means the recorded commit is
// no longer an ancestor of HEAD (rebase rewrote it) and its forge link
// would never heal — the detail header says so instead of linking.
window.__bramHistoryCommitStatus = function (group) {
  var phases = (group && group.phases) || [];
  for (var i = phases.length - 1; i >= 0; i--) {
    var phase = phases[i] || {};
    var summary = (phase.summary || "").toLowerCase();
    var st = typeof phase.commitStatus === "string" ? phase.commitStatus : "";
    if (st && summary.indexOf("committed") >= 0) return st;
  }
  return "";
};

window.__bramHistoryItemFieldMarkdown = function (group, field) {
  var item = window.__bramHistoryCurrentItem(group);
  var value = item && typeof item[field] === "string" ? item[field].trim() : "";
  return value || "";
};

window.__bramHistoryItemFilesLine = function (group) {
  var item = window.__bramHistoryCurrentItem(group);
  if (!item) return "";
  if (Array.isArray(item.files)) return item.files.join(", ");
  if (typeof item.file === "string") return item.file;
  return "";
};

window.__bramWorklistItemFiles = function (itemOrGroup) {
  var item = itemOrGroup;
  if (itemOrGroup && itemOrGroup.currentItem) {
    item = itemOrGroup.currentItem;
  }
  if (!item) return [];
  if (Array.isArray(item.files)) {
    return item.files
      .filter(function (file) {
        return typeof file === "string" && file.trim();
      })
      .map(function (file) { return file.trim(); });
  }
  if (typeof item.file === "string" && item.file.trim()) {
    return [item.file.trim()];
  }
  return [];
};

window.__bramHistoryLatestProseChanged = function (group) {
  var phase = window.__bramHistoryLatestPhase(group);
  var diff = (phase && phase.diff) || "";
  return diff.indexOf('"before"') >= 0 || diff.indexOf('"after"') >= 0;
};

window.__bramHistoryDraftWasMissing = function (group) {
  var item = window.__bramHistoryCurrentItem(group);
  return !!(item && item._draftMissing);
};

window.__bramHistoryItemFate = function (group) {
  var phases = (group && group.phases) || [];
  for (var i = phases.length - 1; i >= 0; i--) {
    var summary = ((phases[i] && phases[i].summary) || "").toLowerCase();
    if (summary.indexOf("committed") >= 0) return "Fate: committed.";
    if (summary.indexOf("dropped") >= 0 || summary.indexOf("pruned") >= 0) return "Fate: dropped.";
  }
  return "Fate: still active.";
};

window.__bramInflightSentinelDecide = function (data, prevSubmitting, prevSubmittedItemId) {
  var claimIds = (data && data.ids) || [];
  if (claimIds.length > 0) {
    var targeted = claimIds[0];
    var transitioning = !prevSubmitting || prevSubmittedItemId !== targeted;
    return {
      kind: "submit",
      submitting: transitioning ? true : prevSubmitting,
      submittedItemId: transitioning ? targeted : prevSubmittedItemId,
      actionProgressKind: (data && data.kind) || "",
    };
  } else if (prevSubmitting) {
    return {
      kind: "clear",
      trace: { reason: "sentinel-cleared", item: prevSubmittedItemId || "" },
    };
  }
  return { kind: "none" };
};

window.__bramRecordWorklistFeedbackConversation = function (text) {
  if (!text || !text.trim()) return false;
  var message = text.trim();
  var baseline = 0;
  __bramWriteLS("bram.worklistSubmittedMessage", message);
  __bramWriteSS("bram.worklistSessionSubmittedMessage", message);
  window.__bramSetWorklistSubmittedKind("action");
  return { message: message, images: __bramExtractImagePaths(message), baseline: baseline, sentAtText: new Date().toLocaleTimeString() };
};

window.__bramPrepareWorklistMessageSubmission = function (opts) {
  opts = opts || {};
  var rawText = opts.text || "";
  var skipWorklist = opts.mode === "skip-worklist";
  window.__bramWorklistMessageSubmissionSeq = (window.__bramWorklistMessageSubmissionSeq || 0) + 1;
  var seq = window.__bramWorklistMessageSubmissionSeq;
  // Every submit attempt traces BEFORE any gating/empty checks, so a send that silently goes nowhere is visible in bram-trace (2026-07-03: "message 2 resent got eaten" left zero traces).
  try {
    window.__bramIframeTrace("message-agent-submit", {
      stage: "attempt",
      seq: seq,
      chars: rawText.length,
      skipWorklist: skipWorklist,
    });
  } catch (e) {}
  if (skipWorklist && !rawText.trim()) return { submitted: false, seq: seq };
  var text = skipWorklist ? ("skip-worklist: " + rawText.trim()) : rawText;
  if (!text.trim()) return { submitted: false, seq: seq };

  if (window.__bramFlushWorklistDraft) window.__bramFlushWorklistDraft();
  var sent = window.__bramSubmitWorklistMessageFast(text);
  if (!sent) return { submitted: false, seq: seq };

  var pasteState = window.__bramPasteStateSnapshot(opts.voiceTarget || "message-agent");
  var submittedImages = sent.images || [];
  window.__bramIframeTrace("submitted-images", {
    kind: skipWorklist ? "message-skip-worklist" : "message",
    count: submittedImages.length,
    first: submittedImages[0] || "",
  });

  return {
    submitted: true,
    seq: seq,
    pendingPastedImageCount: pasteState.count,
    pendingPastedImagePaths: pasteState.paths,
    stagingPastedImageCount: pasteState.staging,
    submittedWorklistImages: submittedImages,
    submittedWorklistMessage: sent.message,
    messageSentAtText: sent.sentAtText,
    submittedKind: window.__bramSetWorklistSubmittedKind("message"),
    // Optimistic close; the host-derived awaitingTurn on /__send-ledger
    // takes over on the next refetch (issue-214-tranche-3b).
    awaitingResponse: true,
  };
};

window.__bramPrepareWorklistActionSubmission = function (opts) {
  opts = opts || {};
  window.__bramIframeTrace("gate-click", { stage: "prep-begin", scope: "single", kind: opts.kind || opts.payloadKind || "" });
  window.__bramWorklistActionSubmissionSeq = (window.__bramWorklistActionSubmissionSeq || 0) + 1;
  var seq = window.__bramWorklistActionSubmissionSeq;
  var kind = opts.kind || "";
  var items = opts.items || [];
  var selectedId = opts.selectedId || "";
  var pasteTarget = opts.pasteTarget || ("feedback:" + selectedId);
  var rawFeedback = opts.rawFeedback || "";
  var feedback = window.__bramWithStagedImageMarkers(rawFeedback, pasteTarget);
  var displayItems = opts.displayItems || items;
  var displayText = window.__bramWorklistActionConversationDisplay(kind, displayItems, selectedId, feedback);
  var sent = window.__bramRecordWorklistFeedbackConversation(feedback ? (displayText + "\n\n" + feedback) : displayText);
  var submittedImages = [];
  var awaitingResponse = false;

  if (sent) {
    submittedImages = ((sent.images && sent.images.length > 0) ? sent.images : window.__bramExtractImagePaths(feedback));
    window.__bramIframeTrace("submitted-images", {
      kind: "action",
      action: opts.imageAction || kind,
      count: submittedImages.length,
      first: submittedImages[0] || "",
    });
    // Optimistic close; host-derived awaitingTurn takes over on the
    // next /__send-ledger refetch (issue-214-tranche-3b).
    awaitingResponse = true;
  }

  if (opts.inflightTarget) {
    window.__bramIframeTrace("inflight-set", {
      item: selectedId,
      via: "click",
      target: opts.inflightTarget,
    });
  }

  var feedbackDraftsById = opts.feedbackDraftsById || {};
  var nextFeedbackDrafts = Object.assign({}, feedbackDraftsById);
  delete nextFeedbackDrafts[selectedId];
  window.__bramPersistWorklistUiState({
    expandedItemIds: opts.expandedItemIds || [],
    feedbackDraftsById: nextFeedbackDrafts,
  });

  var payloadFeedback = Object.prototype.hasOwnProperty.call(opts, "payloadFeedback")
    ? opts.payloadFeedback
    : feedback;
  var turnText = "";
  var authorizationPayload = null;
  if (opts.payloadKind === "single-approve") {
    turnText = "approved: " + window.__bramBuildSingleItemApprovePayload(opts.itemRef, payloadFeedback, opts.oneShot);
    authorizationPayload = { kind: "approved", items: [{ id: opts.itemRef.id, feedback: payloadFeedback, gate: opts.oneShot ? "apply-and-commit" : window.__bramItemGate(opts.itemRef) }] };
  } else if (kind === "approved") {
    turnText = "approved: " + window.__bramBuildApprovePayload(items, selectedId, payloadFeedback, opts.oneShot);
    authorizationPayload = { kind: "approved", items: window.__bramBuildApproveItems(items, selectedId, payloadFeedback, opts.oneShot) };
  } else if (kind === "drop") {
    turnText = "drop: " + window.__bramBuildDropPayload(items, selectedId, payloadFeedback);
    authorizationPayload = { kind: "drop", items: window.__bramBuildDropItems(items, selectedId, payloadFeedback) };
  }

  var pasteState = window.__bramPasteStateSnapshot(opts.voiceTarget || "message-agent");
  window.__bramIframeTrace("gate-click", { stage: "prep-end", scope: "single", kind: kind });
  return {
    seq: seq,
    feedback: feedback,
    turnText: turnText,
    authorizationPayload: authorizationPayload,
    pendingPastedImageCount: pasteState.count,
    pendingPastedImagePaths: pasteState.paths,
    stagingPastedImageCount: pasteState.staging,
    submittedWorklistImages: submittedImages,
    submittedWorklistMessage: sent ? sent.message : "",
    messageSentAtText: sent ? sent.sentAtText : "",
    awaitingResponse: awaitingResponse,
    submittedItemId: selectedId,
    submittedKind: window.__bramSetWorklistSubmittedKind("action"),
    submitting: true,
    actionProgressKind: kind,
    actionProgressTick: 0,
    feedbackDraftsById: nextFeedbackDrafts,
  };
};

function __bramBuildCloseIssueLines(state) {
  var lines = [];
  Object.keys(state || {}).forEach(function (key) {
    var v = state[key];
    if (!v || !v.close) return;
    var comment = (v.comment || "").trim();
    if (comment) lines.push("close-issue: " + key + " comment: " + JSON.stringify(comment));
    else lines.push("close-issue: " + key);
  });
  return lines;
}

function __bramCombineFeedbackWithCloseLines(base, lines) {
  var baseTrim = (base || "").trim();
  var generated = [];
  if (lines && lines.length > 0) generated.push.apply(generated, lines);
  if (generated.length === 0) return baseTrim;
  if (!baseTrim) return generated.join("\n");
  return baseTrim + "\n\n" + generated.join("\n");
}

window.__bramPrepareCloseIssueWorklistActionSubmission = function (opts) {
  opts = opts || {};
  var item = opts.item || {};
  var feedbackDraftsById = opts.feedbackDraftsById || {};
  var rawFeedback = feedbackDraftsById[item.id] || "";
  var pasteTarget = "feedback:" + item.id;
  var payloadFeedback = rawFeedback;
  var imageAction = "approved-no-close";

  if (opts.closeIssues) {
    payloadFeedback = __bramCombineFeedbackWithCloseLines(
      window.__bramWithStagedImageMarkers(rawFeedback, pasteTarget),
      __bramBuildCloseIssueLines(opts.closeIssuesState),
    );
    imageAction = "approved-close";
  }

  return window.__bramPrepareWorklistActionSubmission({
    kind: "approved",
    items: [item],
    displayItems: [item],
    selectedId: item.id,
    itemRef: item,
    payloadKind: "single-approve",
    rawFeedback: rawFeedback,
    payloadFeedback: payloadFeedback,
    feedbackDraftsById: feedbackDraftsById,
    expandedItemIds: opts.expandedItemIds || [],
    voiceTarget: opts.voiceTarget || "message-agent",
    imageAction: imageAction,
    oneShot: opts.oneShot,
  });
};

// Self-init: read `traces.enabled` from `/__settings` once at iframe
// load and cache the result on `window.__bramTracesEnabled`. The
// `iframeTrace` (above) and `logToHost` (above) bodies gate on
// this flag so trace-off sessions skip the IPC roundtrip entirely
// instead of paying the cost only for the host to drop the line.
// Default-ON until the fetch resolves preserves current behavior
// during the ~50 ms startup window. Iframe-reload re-runs this on
// every settings change (existing watcher pattern), so live
// reactivity isn't needed here.
(function loadTracesEnabledFlag() {
  if (typeof window === "undefined") return;
  if (window.__bramTracesEnabled !== undefined) return;
  window.__bramTracesEnabled = true;
  if (typeof fetch !== "function") return;
  fetch("/__settings")
    .then(function (r) { return r && r.ok ? r.json() : null; })
    .then(function (s) {
      if (s && s.traces && typeof s.traces.enabled === "boolean") {
        window.__bramTracesEnabled = s.traces.enabled;
      }
    })
    .catch(function () {});
})();

// Interleave devtools console output + unhandled-error paths into
// bram-trace.log via the iframe-trace channel. Catches what previously
// only landed in the browser devtools panel (e.g. the toolbar
// __toolbarPendingMenuPresent scope errors fixed in 4ad0716). Inherits
// the master-flag short-circuit via the gate in `logToHost` above.
//
// Uses window.logToHost directly rather than `window.iframeTrace`
// above; payload shape is the same (kind="iframe-trace", subkind=...)
// but the explicit logToHost call sidesteps a re-entrancy risk if
// iframeTrace ever logged a console error.
(function installConsoleInterleave() {
  if (typeof window.logToHost !== "function") return;
  if (window.__bramConsoleInterleaveInstalled) return;
  window.__bramConsoleInterleaveInstalled = true;

  var inTrace = false;
  function safeStringify(a) {
    try {
      return typeof a === "string" ? a : JSON.stringify(a);
    } catch (e) {
      return String(a);
    }
  }
  function consoleArgDetail(a) {
    var isError = a && (a instanceof Error || a.stack || a.message);
    if (isError) {
      return {
        type: (a && a.name) || "Error",
        message: String((a && a.message) || a),
        stack: a && a.stack ? String(a.stack) : "",
      };
    }
    return {
      type: typeof a,
      preview: safeStringify(a),
    };
  }
  function consoleArgDetails(args) {
    return args.map(consoleArgDetail);
  }
  function firstConsoleStack(args) {
    for (var i = 0; i < args.length; i += 1) {
      if (args[i] && args[i].stack) return String(args[i].stack);
    }
    return "";
  }
  function runtimeErrorFields(message, source, lineno, colno, error, via) {
    return {
      message: message || (error && error.message) || "window error",
      filename: source,
      lineno: lineno,
      colno: colno,
      errorName: error && error.name,
      errorMessage: error && error.message,
      stack: error && error.stack,
      source: via,
    };
  }
  function emit(subkind, fields) {
    if (inTrace) return;
    inTrace = true;
    try {
      var payload = {
        kind: "iframe-trace",
        subkind: subkind,
        at: new Date().toISOString(),
      };
      Object.keys(fields || {}).forEach(function (k) {
        if (fields[k] !== undefined) payload[k] = fields[k];
      });
      window.logToHost(payload);
    } catch (_) {}
    inTrace = false;
  }

  ["log", "warn", "error"].forEach(function (level) {
    var orig = console[level];
    console[level] = function () {
      var args = Array.prototype.slice.call(arguments);
      emit("console-" + level, {
        message: args.map(safeStringify).join(" "),
        args: consoleArgDetails(args),
        stack: firstConsoleStack(args),
      });
      orig.apply(console, args);
    };
  });

  var previousOnError = window.onerror;
  window.onerror = function (message, source, lineno, colno, error) {
    emit("console-error", runtimeErrorFields(message, source, lineno, colno, error, "window.onerror"));
    if (typeof previousOnError === "function") {
      return previousOnError.apply(this, arguments);
    }
    return false;
  };

  window.addEventListener("error", function (e) {
    emit("console-error", runtimeErrorFields(
      e && e.message,
      e && e.filename,
      e && e.lineno,
      e && e.colno,
      e && e.error,
      "window.error"
    ));
  });

  window.addEventListener("unhandledrejection", function (e) {
    var reason = e && e.reason;
    emit("console-unhandledrejection", {
      message:
        (reason && (reason.message || String(reason))) || "unhandled rejection",
      stack: reason && reason.stack,
    });
  });
})();
// Setter for window.__bramMenuPending, called from Globals.xs
// applyAgentMenu. XMLUI's expression engine can't handle
// `window.__bramMenuPending = ...` as an assignment target (it parses
// the LHS as a bare variable and emits "Left value variable
// (__bramMenuPending) not found in the scope"), but function calls on
// window members evaluate fine. Bridging through this setter keeps
// the assignment in plain-JS scope.
window.__bramSetMenuPending = function (v) {
  window.__bramMenuPending = !!v;
};

// Plain-JS wrappers for the agent-menu pty-menu-changed and
// turn-state-changed subscriber callbacks. XMLUI's expression engine runs subscriber
// arrow-function bodies through processStatementQueueAsync
// (xmlui/src/components-core/script-runner/process-statement-async.ts:115-166),
// which `await`s three times per statement — onStatementStarted,
// processStatementAsync, onStatementCompleted. Under iframe load
// each await is a microtask boundary that yields to the event
// loop, queueing the body behind pending macrotasks (DataSource
// polls, ChangeListener fires, JSONL broadcasts). End-to-end:
// 2-3 s between subscriber-fired (callback wrapper returns in 0 ms)
// and listener-fired (the iframeTrace inside setAgentMenuFromEvent
// actually emits). Collapsing the body to one window function call
// keeps applyAgentMenu, agentMenuTraceFields, iframeTrace, and the
// menu-pending mirror all on the synchronous JS side so the entire
// chain is one XMLUI statement instead of N.
// Native plain-JS AgentMenu state + handlers. Source of truth lives
// on window so xs scope can read it (Globals.xs getAgentMenu,
// Main.xmlui suppression gates) and JS scope can write it without
// going through XMLUI's expression engine.
//
// XMLUI evaluates xs function bodies via processStatementQueueAsync,
// awaiting three times per statement
// (xmlui/src/components-core/script-runner/process-statement-async.ts:115-166).
// Under iframe load — DataSource polls, ChangeListener fires, JSONL
// pipeline — each await yields to the event loop and the body
// serialises behind pending macrotasks. The full menu-state update
// (apply + trace) used to take 2-3 s end-to-end despite the JS-level
// subscriber wrapper returning in 0 ms. Doing the work natively
// here, before the XMLUI subscriber runs, drops that to the IPC
// delivery floor.
if (typeof window.bramAgentMenu === "undefined") window.bramAgentMenu = null;
if (typeof window.bramAgentMenuSuppressFallback === "undefined") window.bramAgentMenuSuppressFallback = true;
if (typeof window.bramAgentMenuLastHostMs === "undefined") window.bramAgentMenuLastHostMs = 0;
if (typeof window.bramAgentMenuLastSource === "undefined") window.bramAgentMenuLastSource = "";

function __bramAgentMenuHostMs(menu) {
  return menu && typeof menu.atHostMs === "number" ? menu.atHostMs : 0;
}

window.__bramHashString = function (text) {
  var s = String(text || "");
  var h = 2166136261;
  for (var i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
};

window.__bramMenuIdentity = function (menu) {
  if (!menu) return "(none)";
  var opts = menu.options || [];
  var parts = [
    __bramAgentMenuHostMs(menu) || "",
    menu.cacheSource || "",
    menu.tool || "",
    menu.toolCallSignature || "",
    menu.toolCallContent || "",
    menu.text || "",
  ];
  for (var i = 0; i < opts.length; i++) {
    var opt = opts[i] || {};
    parts.push(opt.key || "");
    parts.push(opt.label || "");
  }
  return window.__bramHashString(parts.join("\n"));
};

function __bramAgentMenuTraceFields(menu) {
  var hostMs = __bramAgentMenuHostMs(menu);
  return {
    tool: (menu && menu.tool) || "",
    menuId: window.__bramMenuIdentity(menu),
    hasSignature: !!(menu && menu.toolCallSignature),
    signatureChars: menu && menu.toolCallSignature ? menu.toolCallSignature.length : 0,
    assignedMenu: window.bramAgentMenu ? window.bramAgentMenu.tool : "",
    suppressFallback: window.bramAgentMenuSuppressFallback,
    at_host_ms: hostMs,
    delta_to_emit_ms: hostMs ? (Date.now() - hostMs) : -1,
    cache_source: (menu && menu.cacheSource) || "",
    last_host_ms: window.bramAgentMenuLastHostMs,
    last_cache_source: window.bramAgentMenuLastSource,
    stale: hostMs && window.bramAgentMenuLastHostMs && hostMs < window.bramAgentMenuLastHostMs ? 1 : 0,
  };
}

function __bramEmitMenuTrace(subkind, fields) {
  if (typeof window.logToHost !== "function") return;
  var payload = { kind: "iframe-trace", subkind: subkind, at: new Date().toISOString() };
  Object.keys(fields || {}).forEach(function (k) {
    if (fields[k] !== undefined) payload[k] = fields[k];
  });
  window.logToHost(payload);
}

window.__bramApplyAgentMenu = function (menu, suppressFallback, source) {
  var hostMs = __bramAgentMenuHostMs(menu);
  var stale = !!(hostMs && window.bramAgentMenuLastHostMs && hostMs < window.bramAgentMenuLastHostMs);
  if (stale) {
    __bramEmitMenuTrace("agent-menu-stale", {
      incoming_host_ms: hostMs,
      current_host_ms: window.bramAgentMenuLastHostMs,
      incoming_source: (menu && menu.cacheSource) || source || "",
      current_source: window.bramAgentMenuLastSource,
      incoming_tool: (menu && menu.tool) || "",
      current_tool: (window.bramAgentMenu && window.bramAgentMenu.tool) || "",
    });
    return true;
  }
  window.bramAgentMenu = menu || null;
  // Menu-row trace at the canonical setter — the single place the applied
  // menu state changes, run once per change with no churning subscriber.
  // Deduped by menu key; emits transcript-menu-row stage=source. Gated to
  // the agent pane (/tools/): helpers.js loads in both iframes and each
  // would emit, but the inline-menu render staleness only manifests where
  // the Transcript lives. Pairs with host pty-menu-changed to localize it:
  // a clean object here + a blended row on screen => render layer; a fused
  // object here => data layer.
  try {
    if (window.location.pathname.indexOf("/tools/") !== -1 &&
        window.__bramMenuRowKey && window.__bramTraceMenuRow) {
      var __menuRowKey = window.__bramMenuRowKey(window.bramAgentMenu);
      if (__menuRowKey !== window.__bramMenuRowTraceLastKey) {
        window.__bramMenuRowTraceLastKey = __menuRowKey;
        window.__bramTraceMenuRow(window.bramAgentMenu, "source");
      }
    }
  } catch (e) {}
  // backgrounded-pane-menu-paint-observer: receive-vs-paint marker.
  // Double-rAF is the paint proxy — the second callback runs only after
  // a real frame, and rAF stalls while the webview is hidden/throttled,
  // so a menu received hidden that paints only on refocus shows up as
  // receive_to_paint_ms spanning the hidden period with
  // painted_after_refocus=true (paired with the pane-visibility lines
  // and the host's prompt-lifecycle op=shown). Gated to the agent pane;
  // observe-only, one probe per applied menu.
  try {
    if (menu && window.location.pathname.indexOf("/tools/") !== -1) {
      var __paintReceiveMs = Date.now();
      var __paintHiddenAtReceive = !!document.hidden;
      var __paintFocusedAtReceive = !!(document.hasFocus && document.hasFocus());
      var __paintTool = menu.tool || "";
      var __paintMenuId = window.__bramMenuIdentity ? window.__bramMenuIdentity(menu) : __paintTool;
      requestAnimationFrame(function () {
        requestAnimationFrame(function () {
          var __paintMs = Date.now();
          window.__bramIframeTrace("menu-paint", {
            tool: __paintTool,
            menuId: __paintMenuId,
            hidden_at_receive: __paintHiddenAtReceive,
            focused_at_receive: __paintFocusedAtReceive,
            receive_to_paint_ms: __paintMs - __paintReceiveMs,
            painted_after_refocus:
              __paintHiddenAtReceive &&
              (window.__bramPaneLastVisibleMs || 0) > __paintReceiveMs,
          });
        });
      });
    }
  } catch (e) {}
  window.bramAgentMenuSuppressFallback = suppressFallback;
  window.__bramMenuPending = !!menu;
  if (hostMs) {
    window.bramAgentMenuLastHostMs = hostMs;
    window.bramAgentMenuLastSource = (menu && menu.cacheSource) || source || "";
  } else if (!menu) {
    window.bramAgentMenuLastHostMs = Date.now();
    window.bramAgentMenuLastSource = source || "";
  }
  return false;
};

window.__bramTraceAgentMenuRender = function (menu, surface) {
  try {
    window.__bramIframeTrace("agent-menu-render", {
      surface: surface || "",
      present: !!menu,
      tool: (menu && menu.tool) || "",
      options: (menu && menu.options && menu.options.length) || 0,
      menuId: window.__bramMenuIdentity(menu),
      transcriptMounted: !!window.__bramTranscriptMounted,
    });
  } catch (e) {}
};

window.__bramSetAgentMenuFromEvent = function (e, surface) {
  var payload = e && e.payload ? e.payload : null;
  var incoming = payload && payload.tool ? payload : null;
  var stale = window.__bramApplyAgentMenu(incoming, !incoming, "setAgentMenuFromEvent");
  var fields = __bramAgentMenuTraceFields(incoming);
  fields.context = "pty-menu-changed";
  fields.surface = surface || "agent-menu";
  fields.stale = stale;
  __bramEmitMenuTrace("listener-fired", fields);
};

window.__bramSetAgentMenuFromTurnState = function (turnState, surface) {
  var p = turnState || {};
  var incoming = p.pendingMenu || null;
  var stale = window.__bramApplyAgentMenu(incoming, !incoming, "setAgentMenuFromTurnState");
  var fields = __bramAgentMenuTraceFields(incoming);
  fields.context = "turn-state-changed";
  fields.surface = surface || "agent-menu";
  fields.phase = p.phase || "";
  fields.source = p.source || "";
  fields.menu = p.pendingMenu ? p.pendingMenu.tool : "";
  fields.stale = stale;
  __bramEmitMenuTrace("listener-fired", fields);
};

// Native subscriber registration lives further down in this file
// (search "__bramNativePtyMenuUnsub"). subscribeTauriEvent is defined
// later than this block, so calling it here at top level throws and
// aborts the rest of the script — taking down voice helpers, the
// console-interleave, and the Tauri-listener machinery itself
// (incident 2026-06-14: blank menus + voice broken). Register after
// subscribeTauriEvent exists.
window.openExternal = function (url) {
  var invoke = getTauriInvoke();
  if (!invoke) {
    // issue-343: see toShell.
    window.__bramIframeTrace("host-helper", { op: "no-invoke", fn: "openExternal" });
    return;
  }
  return invoke("open_url", { url: String(url) }).catch(function (e) {
    console.error("openExternal open_url", e);
    if (typeof window.__bramShowLinkPreviewError === "function") {
      window.__bramShowLinkPreviewError(String(url), String(e && e.message || e));
    }
  });
};
// Capture an interactive screenshot via the host (macOS: screencapture -i)
// and inject the resulting file path into the terminal as a fresh user turn
// so claude reads it via its Read tool. User cancellation (Esc during the
// rect drag) is silent; other errors go to the host log.
window.captureScreenshot = function () {
  function deliver(path) {
    // Dual format: `@<path>` is claude-code's file-reference syntax (tells
    // the model to use its Read tool), and `[Image: source: <path>]` is
    // the marker Talk's extractImagePaths matches to render a thumbnail.
    // stripImagePaths removes the marker from the visible text, so the
    // displayed user turn shows "Read this screenshot: @path" plus the
    // inline thumbnail below.
    if (path) toTurn("Read this screenshot: @" + path + "\n[Image: source: " + path + "]");
  }
  function report(err) {
    var msg = String((err && err.message) || err);
    if (msg !== "cancelled") {
      logToHost({ kind: "screenshot", error: msg });
    }
  }
  var invoke = getTauriInvoke();
  if (!invoke) {
    report(new Error("Tauri IPC unavailable"));
    return;
  }
  invoke("capture_screenshot", {}).then(deliver).catch(report);
};

// Stage a clipboard-pasted image to disk via /__paste-image and remember its
// path so submitWorklistMessageFast can prepend the `[Image: source: <path>]`
// marker on the next form submit. Mirrors the marker protocol that
// captureScreenshot uses and that st_extract_image_paths reads back.
//
// We listen for paste events at document level so any Cmd/Ctrl+V — including
// one fired from the TextArea — stages clipboard images. The original
// FileUploadDropZone-based UX required clicking the dropzone first, but the
// underlying react-dropzone setup is configured with noKeyboard:true, which
// strips the rootDiv's tabIndex (react-dropzone/src/index.js:920); without
// focus the rootDiv never receives the React paste event, so click-then-paste
// silently no-ops. Window-level listening sidesteps the focus problem.
window.bramPendingPastedImages = window.bramPendingPastedImages || [];
window.bramStagingPastedImages = window.bramStagingPastedImages || 0;

// Paste-state pub/sub registry — bridge from helpers.js (canonical store) to
// XMLUI via the <External> component's `(emit) => unsubscribe` contract.
// helpers.js owns window.bramPendingPastedImages and
// window.bramStagingPastedImages above; every mutation site below calls
// bramNotifyPasteState() so the subscribers below re-snapshot and push the
// new value to their XMLUI-side observers. Replaces the 4 Hz <Timer> polling
// loop the strip used to do.
var bramPasteStateSubscribers = new Set();
function bramComputePasteState(target) {
  return {
    count: target
      ? window.bramPendingPastedImageCountForTarget(target)
      : window.bramPendingPastedImageCount(),
    paths: target
      ? window.bramPendingPastedImagePathsForTarget(target)
      : window.bramPendingPastedImagePaths(),
    staging: window.bramStagingPastedImageCount(),
  };
}
window.__bramPasteStateSnapshot = function (target) {
  return bramComputePasteState(target);
};
function bramNotifyPasteState() {
  bramPasteStateSubscribers.forEach(function (cb) {
    try { cb(); } catch (e) { console.error("[bram-paste] subscriber threw:", e); }
  });
}
// Memoize the per-target subscribe closure. XMLUI re-evaluates
// `subscribe="{window.bramSubscribePasteState(target)}"` on every render;
// returning a fresh closure each call makes the <External> useEffect's
// [subscribeFn] dep see a new identity each time, which kicks off a
// subscribe → emit → re-render → re-subscribe loop. Caching keyed on
// target gives every call with the same target the same function
// identity, so useEffect runs exactly once per real target change.
var bramSubscribePasteStateCache = Object.create(null);
window.bramSubscribePasteState = function (target) {
  var key = target == null ? "" : String(target);
  if (bramSubscribePasteStateCache[key]) return bramSubscribePasteStateCache[key];
  var cached = function (emit) {
    var fire = function () { emit(bramComputePasteState(target)); };
    bramPasteStateSubscribers.add(fire);
    fire();  // seed initial value synchronously
    return function () { bramPasteStateSubscribers.delete(fire); };
  };
  bramSubscribePasteStateCache[key] = cached;
  return cached;
};
window.bramActiveVoiceTargetMirror = window.bramActiveVoiceTargetMirror || "";
window.bramActiveFocusedFeedbackItemIdMirror = window.bramActiveFocusedFeedbackItemIdMirror || "";
window.bramSetActiveVoiceTargetMirror = function (v) {
  var prev = window.bramActiveVoiceTargetMirror || "";
  var next = v || "";
  window.bramActiveVoiceTargetMirror = next;
  if (window.__bramIframeTrace) window.__bramIframeTrace("paste-target-mirror", { kind: "voice", value: next, prev: prev });
};
window.bramSetActiveFocusedFeedbackItemIdMirror = function (v) {
  var prev = window.bramActiveFocusedFeedbackItemIdMirror || "";
  var next = v || "";
  window.bramActiveFocusedFeedbackItemIdMirror = next;
  if (window.__bramIframeTrace) window.__bramIframeTrace("paste-target-mirror", { kind: "focused-feedback-item", value: next, prev: prev });
};
window.bramCurrentPasteTarget = function () {
  var voice = window.bramActiveVoiceTargetMirror || "";
  var focusedFeedback = window.bramActiveFocusedFeedbackItemIdMirror || "";
  var active = document.activeElement;
  var placeholder = active && active.getAttribute && (active.getAttribute("placeholder") || "");
  var activeLooksLikeFeedback = placeholder === "Message to agent";
  var activeLooksLikeMessage = placeholder.indexOf("Message agent") === 0;
  var result;
  if (activeLooksLikeFeedback && focusedFeedback) {
    result = "feedback:" + focusedFeedback;
  } else if (activeLooksLikeMessage) {
    result = "message-agent";
  } else {
    result = voice;
  }
  if (window.__bramIframeTrace) window.__bramIframeTrace("paste-current-target", {
    voice: voice,
    focusedFeedback: focusedFeedback,
    placeholder: placeholder,
    activeLooksLikeFeedback: activeLooksLikeFeedback,
    activeLooksLikeMessage: activeLooksLikeMessage,
    result: result
  });
  return result;
};
window.bramPastedImageForCurrentTurn = window.bramPastedImageForCurrentTurn || false;
window.bramPastedImageTarget = window.bramPastedImageTarget || "";
window.bramLastConsumedPastedImages = window.bramLastConsumedPastedImages || [];
window.bramPasteImageTraceSigs = window.bramPasteImageTraceSigs || {};
function bramPendingPastedImageSummary() {
  return (window.bramPendingPastedImages || []).map(function (e) {
    if (typeof e === "string") return { path: e, target: "" };
    return { path: (e && e.path) || "", target: (e && e.target) || "" };
  }).filter(function (e) { return !!e.path; });
}
function bramActiveElementSummary() {
  var el = document.activeElement;
  if (!el) return "";
  var bits = [];
  if (el.tagName) bits.push(String(el.tagName).toLowerCase());
  if (el.id) bits.push("#" + el.id);
  var aria = el.getAttribute && (el.getAttribute("aria-label") || el.getAttribute("placeholder"));
  if (aria) bits.push("[" + String(aria).slice(0, 40) + "]");
  return bits.join("");
}
function bramTracePasteImage(stage, payload, sampleKey) {
  try {
    var p = Object.assign({ stage: stage }, payload || {});
    if (sampleKey) {
      var sig = JSON.stringify(p);
      if (window.bramPasteImageTraceSigs[sampleKey] === sig) return;
      window.bramPasteImageTraceSigs[sampleKey] = sig;
    }
    if (typeof window.__bramIframeTrace === "function") {
      window.__bramIframeTrace("paste-image", p);
    }
  } catch (e) {}
}
document.addEventListener("paste", function (event) {
  if (!event.clipboardData) return;
  var items = event.clipboardData.items || [];
  var imageFiles = [];
  for (var i = 0; i < items.length; i++) {
    var item = items[i];
    if (item.kind === "file" && /^image\//.test(item.type || "")) {
      var f = item.getAsFile();
      if (f) imageFiles.push(f);
    }
  }
  if (imageFiles.length === 0) return;
  // Accumulate pasted images across paste events within a single turn.
  // Originally (804bc37) this point cleared `bramPendingPastedImages`
  // on every paste to avoid sticking on stale images from abandoned
  // drafts, but the clear made multi-paste-event accumulation
  // impossible — pasting four screenshots one after another into a
  // single Iterate feedback box dropped all but one (race-dependent
  // first or last). Staleness is now handled by
  // `bramConsumePastedImagePaths` on turn submission and by the
  // `bramPastedImageForCurrentTurn` flag below.
  window.bramPastedImageForCurrentTurn = true;
  var currentTarget = (window.bramCurrentPasteTarget && window.bramCurrentPasteTarget()) || "";
  var pasteTarget = currentTarget || "message-agent";
  window.bramPastedImageTarget = pasteTarget;
  bramTracePasteImage("intake", {
    source: "paste",
    currentTarget: currentTarget,
    target: pasteTarget,
    activeElement: bramActiveElementSummary(),
    fileCount: imageFiles.length,
    pendingBefore: bramPendingPastedImageSummary()
  });
  // Suppress the default paste so the TextArea doesn't pick up any file-path
  // or filename text the OS may have placed on the clipboard alongside the
  // image (Finder copy-image, macOS screenshot tool, etc.).
  event.preventDefault();
  for (var j = 0; j < imageFiles.length; j++) {
    window.bramStagePastedImage(imageFiles[j], pasteTarget);
  }
});
// Drag-and-drop image intake — parallels the paste handler above.
function bramImageFilesFromDataTransfer(dt) {
  if (!dt) return [];
  var imageFiles = [];
  var items = dt.items || [];
  for (var i = 0; i < items.length; i++) {
    var item = items[i];
    if (item.kind === "file" && /^image\//.test(item.type || "")) {
      var f = item.getAsFile();
      if (f) imageFiles.push(f);
    }
  }
  if (imageFiles.length > 0) return imageFiles;
  var files = dt.files || [];
  for (var j = 0; j < files.length; j++) {
    var file = files[j];
    if (file && /^image\//.test(file.type || "")) imageFiles.push(file);
  }
  return imageFiles;
}
document.addEventListener("dragover", function (event) {
  if (bramImageFilesFromDataTransfer(event.dataTransfer).length === 0) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
});
document.addEventListener("drop", function (event) {
  var imageFiles = bramImageFilesFromDataTransfer(event.dataTransfer);
  if (imageFiles.length === 0) return;
  window.bramPastedImageForCurrentTurn = true;
  var currentTarget = (window.bramCurrentPasteTarget && window.bramCurrentPasteTarget()) || "";
  var dropTarget = currentTarget || "message-agent";
  window.bramPastedImageTarget = dropTarget;
  bramTracePasteImage("intake", {
    source: "drop",
    currentTarget: currentTarget,
    target: dropTarget,
    activeElement: bramActiveElementSummary(),
    fileCount: imageFiles.length,
    pendingBefore: bramPendingPastedImageSummary()
  });
  event.preventDefault();
  for (var i = 0; i < imageFiles.length; i++) {
    window.bramStagePastedImage(imageFiles[i], dropTarget);
  }
});
window.bramStagePastedImage = function (file, target) {
  if (!file) return Promise.reject(new Error("no file"));
  var type = file.type || "image/png";
  var url = "/__paste-image?type=" + encodeURIComponent(type);
  var stageTarget = target || window.bramPastedImageTarget || "message-agent";
  // Read as ArrayBuffer first. `fetch(url, { body: file })` with a File body
  // in this Tauri webview wrote 0-byte files server-side (the host saw an
  // empty request body). Sending an ArrayBuffer via fetch reliably carries
  // the bytes through.
  return new Promise(function (resolve, reject) {
    var reader = new FileReader();
    window.bramStagingPastedImages++;
    bramNotifyPasteState();
    bramTracePasteImage("stage-start", { target: stageTarget, type: type, staging: window.bramStagingPastedImages });
    reader.onload = function () {
      if (!reader.result || reader.result.byteLength === 0) {
        var empty = new Error("paste-image: empty clipboard image");
        bramTracePasteImage("empty", { target: stageTarget });
        window.bramStagingPastedImages = Math.max(0, (window.bramStagingPastedImages || 0) - 1);
        bramNotifyPasteState();
        reject(empty);
        return;
      }
      fetch(url, {
        method: "POST",
        body: reader.result,
        headers: { "Content-Type": type },
      })
        .then(function (r) {
          if (!r.ok) throw new Error("paste-image HTTP " + r.status);
          return r.json();
        })
        .then(function (json) {
          if (!json || !json.path) throw new Error("paste-image: no path in response");
          var entry = { path: json.path, target: stageTarget };
          window.bramPendingPastedImages.push(entry);
          bramNotifyPasteState();
          bramTracePasteImage("staged", {
            path: json.path,
            target: stageTarget,
            currentGlobalTarget: window.bramPastedImageTarget || "",
            bytes: reader.result.byteLength,
            pendingAfter: bramPendingPastedImageSummary()
          });
          resolve(json.path);
        })
        .catch(function (e) {
          bramTracePasteImage("error", { target: stageTarget, message: String((e && e.message) || e) });
          reject(e);
        })
        .finally(function () {
          window.bramStagingPastedImages = Math.max(0, (window.bramStagingPastedImages || 0) - 1);
          bramNotifyPasteState();
        });
    };
    reader.onerror = function () {
      bramTracePasteImage("read-error", { target: stageTarget, message: String(reader.error || "") });
      window.bramStagingPastedImages = Math.max(0, (window.bramStagingPastedImages || 0) - 1);
      bramNotifyPasteState();
      reject(reader.error);
    };
    reader.readAsArrayBuffer(file);
  });
};
window.bramConsumePastedImagePaths = function (target) {
  if (!window.bramPastedImageForCurrentTurn) {
    window.bramPendingPastedImages = [];
    window.bramPastedImageForCurrentTurn = false;
    window.bramPastedImageTarget = "";
    window.bramLastConsumedPastedImages = [];
    bramTracePasteImage("consume", { target: target || "", reason: "no-current-turn", consumed: [], retained: [] });
    bramNotifyPasteState();
    return [];
  }
  var arr = window.bramPendingPastedImages || [];
  if (!target) {
    var allPaths = arr.map(function (e) { return e && e.path; }).filter(Boolean);
    window.bramPendingPastedImages = [];
    window.bramPastedImageForCurrentTurn = false;
    window.bramPastedImageTarget = "";
    window.bramLastConsumedPastedImages = allPaths.slice();
    bramTracePasteImage("consume", { target: "", mode: "drain-all", consumed: allPaths, retained: [] });
    bramNotifyPasteState();
    return allPaths;
  }
  var kept = [];
  var taken = [];
  for (var i = 0; i < arr.length; i++) {
    var e = arr[i];
    if (e && (e.target || "") === target) {
      if (e.path) taken.push(e.path);
    } else if (e) {
      kept.push(e);
    }
  }
  window.bramPendingPastedImages = kept;
  if (kept.length === 0) {
    window.bramPastedImageForCurrentTurn = false;
    window.bramPastedImageTarget = "";
  }
  window.bramLastConsumedPastedImages = taken.slice();
  bramTracePasteImage("consume", {
    target: target,
    mode: "target",
    consumed: taken,
    retained: bramPendingPastedImageSummary()
  });
  bramNotifyPasteState();
  return taken;
};
window.bramLastConsumedPastedImagePaths = function () {
  return (window.bramLastConsumedPastedImages || []).slice();
};
window.bramRemovePastedImagePath = function (path) {
  if (!path) return;
  var arr = window.bramPendingPastedImages || [];
  for (var i = 0; i < arr.length; i++) {
    var e = arr[i];
    if (e && e.path === path) {
      arr.splice(i, 1);
      bramTracePasteImage("removed", { path: path, target: e.target || "", pendingAfter: bramPendingPastedImageSummary() });
      bramNotifyPasteState();
      return;
    }
  }
};
window.bramHasPendingPastedImages = function () {
  return (window.bramPendingPastedImages || []).length > 0;
};
window.bramPendingPastedImageCount = function () {
  return (window.bramPendingPastedImages || []).length;
};
window.bramPendingPastedImageCountForTarget = function (target) {
  var t = target || "";
  var count = (window.bramPendingPastedImages || []).filter(function (e) {
    return e && (e.target || "") === t;
  }).length;
  bramTracePasteImage("query-count", { target: t, count: count }, "count:" + t);
  return count;
};
window.bramPendingPastedImagePaths = function () {
  return (window.bramPendingPastedImages || []).map(function (e) { return e && e.path; }).filter(Boolean);
};
window.bramPendingPastedImagePathsForTarget = function (target) {
  var t = target || "";
  var paths = (window.bramPendingPastedImages || [])
    .filter(function (e) { return e && (e.target || "") === t; })
    .map(function (e) { return e.path; })
    .filter(Boolean);
  bramTracePasteImage("query-paths", { target: t, count: paths.length, paths: paths }, "paths:" + t);
  return paths;
};
window.bramTracePastedImageStrip = function (source, target, count, paths, staging) {
  bramTracePasteImage("strip", {
    source: source || "",
    target: target || "",
    count: count || 0,
    paths: paths || [],
    staging: staging || 0
  }, "strip:" + (source || "") + ":" + (target || ""));
};
window.bramStagingPastedImageCount = function () {
  return window.bramStagingPastedImages || 0;
};

// Click-to-toggle voice. Single in-flight session per iframe.
//   voiceStart()              — starts recording (parent records on iframe's behalf).
//   voiceStop(callback)       — stops; callback(transcript) fires when transcript is ready.
// XMLUI's onClick expression evaluator does not reliably execute .then() callbacks
// attached during expression evaluation; passing a callback function as an argument
// works, since the callback is invoked from plain JS later.
window._voiceSession = null;
window._voiceStartedListener = null;
window._voiceSessionTarget = "";
window.__bramVoiceRecorderState = window.__bramVoiceRecorderState || {
  state: "idle",
  requestId: null,
  target: "",
  at: Date.now(),
};
function _voiceLog(stage, payload) {
  try {
    window.logToHost(
      Object.assign(
        { kind: "voice", stage: stage, at: new Date().toISOString() },
        payload || {},
      ),
    );
  } catch (e) {}
}
window.__bramHasActiveVoiceSession = function () {
  return !!window._voiceSession;
};
window.__bramActiveVoiceSessionTarget = function () {
  return window._voiceSessionTarget || "";
};
window.__bramNotifyVoiceBusy = function (detail) {
  try {
    window.dispatchEvent(new CustomEvent("bram:voice-busy", {
      detail: Object.assign({ at: Date.now() }, detail || {}),
    }));
  } catch (e) {
    console.error("[bram] voice-busy dispatch failed:", e);
  }
};
function _voiceRemoveStartedListener() {
  if (window._voiceStartedListener) {
    try {
      window.removeEventListener("message", window._voiceStartedListener);
    } catch (e) {}
    window._voiceStartedListener = null;
  }
}
window.voiceStart = function (onStarted, onFailed) {
  var meta =
    arguments.length >= 3 && arguments[2] && typeof arguments[2] === "object"
      ? arguments[2]
      : {};
  if (window._voiceSession) {
    _voiceLog("voiceStart-rejected-already-active", {
      currentSession: window._voiceSession,
      target: window._voiceSessionTarget || "",
    });
    if (typeof onFailed === "function") {
      try {
        onFailed({
          requestId: window._voiceSession,
          reason: "already-active",
          target: window._voiceSessionTarget || "",
        });
      } catch (e) {}
    }
    return;
  }
  _voiceRemoveStartedListener();
  var requestId =
    "voice-" + Date.now() + "-" + Math.random().toString(36).slice(2);
  window._voiceSession = requestId;
  window._voiceSessionTarget = meta.target || "";
  _voiceLog("voiceStart", { requestId: requestId, target: window._voiceSessionTarget });
  function onStartedMsg(ev) {
    var data = ev && ev.data;
    if (!data || (data.type !== "voice-recording-started" && data.type !== "voice-into-result")) return;
    if (data.requestId !== requestId) return;
    window.removeEventListener("message", onStartedMsg);
    if (window._voiceStartedListener === onStartedMsg) {
      window._voiceStartedListener = null;
    }
    if (data.type === "voice-into-result") {
      if (window._voiceSession === requestId) {
        window._voiceSession = null;
        window._voiceSessionTarget = "";
      }
      _voiceLog("voiceStart-rejected-by-parent", {
        requestId: requestId,
        reason: data.reason || "",
        activeWas: data.activeWas || "",
        activeRequestId: data.activeRequestId || "",
        transcriptLength: String(data.transcript || "").length,
      });
      if (typeof onFailed === "function") {
        try { onFailed(data); } catch (e) {}
      }
      return;
    }
    if (window._voiceSession !== requestId) {
      _voiceLog("voice-recording-started-stale", { requestId: requestId });
      return;
    }
    _voiceLog("voice-recording-started", { requestId: requestId });
    if (typeof onStarted === "function") {
      try { onStarted(); } catch (e) {}
    }
  }
  window._voiceStartedListener = onStartedMsg;
  window.addEventListener("message", onStartedMsg);
  window.parent.postMessage(
    {
      type: "right-pane",
      kind: "voice-start",
      requestId: requestId,
      target: window._voiceSessionTarget,
    },
    "*",
  );
};
window.voiceStop = function (callback) {
  var requestId = window._voiceSession;
  var target = window._voiceSessionTarget || "";
  var stopAtMs = Date.now();
  window._voiceSession = null;
  window._voiceSessionTarget = "";
  _voiceRemoveStartedListener();
  if (!requestId) {
    _voiceLog("voiceStop-no-session", { stopAtMs: stopAtMs });
    if (typeof callback === "function") callback("");
    return;
  }
  _voiceLog("voiceStop", { requestId: requestId, stopAtMs: stopAtMs, target: target });
  function onResult(ev) {
    var data = ev && ev.data;
    if (!data || data.type !== "voice-into-result") return;
    var resultAtMs = Date.now();
    if (data.requestId !== requestId) {
      _voiceLog("voice-into-result-mismatch", {
        expected: requestId,
        received: data.requestId,
        stopAtMs: stopAtMs,
        stopToResultMs: resultAtMs - stopAtMs,
        transcriptPreview: String(data.transcript || "").slice(0, 80),
      });
      return;
    }
    window.removeEventListener("message", onResult);
    var transcript = String(data.transcript || "");
    var resultStopAtMs = Number(data.stopAtMs || stopAtMs);
    var voiceMeta = {
      requestId: requestId,
      stopAtMs: resultStopAtMs,
      stopToResultMs: resultAtMs - resultStopAtMs,
      parentStopToDeliverMs:
        typeof data.stopToDeliverMs === "number" ? data.stopToDeliverMs : null,
      target: data.target || target || "",
    };
    _voiceLog("voice-into-result", {
      requestId: requestId,
      stopAtMs: resultStopAtMs,
      stopToResultMs: voiceMeta.stopToResultMs,
      parentStopToDeliverMs: voiceMeta.parentStopToDeliverMs,
      target: voiceMeta.target,
      transcriptLength: transcript.length,
      transcriptPreview: transcript.slice(0, 80),
    });
    if (typeof callback === "function") callback(transcript, voiceMeta);
  }
  window.addEventListener("message", onResult);
  window.parent.postMessage(
    {
      type: "right-pane",
      kind: "voice-stop",
      requestId: requestId,
      target: target,
      stopAtMs: stopAtMs,
    },
    "*",
  );
};
// Snapshot of the iframe's current pixel size. Same-origin iframes can
// read their own viewport dimensions directly — no parent round-trip
// needed. Callback receives { width, height } as integers (rounded).
window.getRightPaneSize = function (callback) {
  if (typeof callback !== "function") return;
  callback({
    width: Math.round(window.innerWidth || 0),
    height: Math.round(window.innerHeight || 0),
  });
};

// Subscribe to session-JSONL change events. The parent shell receives
// `talk-session-changed` Tauri events from the file watcher; same-origin
// iframes consume them through this bridge. It is the change-signal tick
// that drives the projected-turns refetch on provider session-file writes.
var __talkSessionSubscribers = [];
var __talkSessionMainUnsub = null;
window.onTalkSessionChange = function (fn) {
  if (typeof __talkSessionMainUnsub === "function") {
    try { __talkSessionMainUnsub(); } catch (e) {}
    __talkSessionMainUnsub = null;
  }
  if (typeof fn !== "function") return function () {};
  __talkSessionMainUnsub = window.subscribeTalkSessionChange("__bramMainTalkSessionUnsub", fn);
  return __talkSessionMainUnsub;
};
window.subscribeTalkSessionChange = function (key, fn) {
  if (typeof window[key] === "function") {
    try { window[key](); } catch (e) {}
  }
  if (typeof fn !== "function") {
    window[key] = null;
    return function () {};
  }
  __talkSessionSubscribers.push(fn);
  // Subscriber-lifecycle trace for the talk-session event-drop
  // investigation (#tsc-drop): a sub/resub churn pattern would explain
  // some of the 175→83 delivery gap if the parent listen() were
  // racing the iframe's swap window.
  try {
    if (typeof window.logToHost === "function") {
      window.logToHost({
        kind: "iframe-trace",
        subkind: "subscriber-changed",
        at: new Date().toISOString(),
        context: "talk-session-changed",
        op: "subscribe",
        key: key,
        count: __talkSessionSubscribers.length,
      });
    }
  } catch (e) {}
  window[key] = function () {
    var idx = __talkSessionSubscribers.indexOf(fn);
    if (idx >= 0) __talkSessionSubscribers.splice(idx, 1);
    try {
      if (typeof window.logToHost === "function") {
        window.logToHost({
          kind: "iframe-trace",
          subkind: "subscriber-changed",
          at: new Date().toISOString(),
          context: "talk-session-changed",
          op: "unsubscribe",
          key: key,
          count: __talkSessionSubscribers.length,
        });
      }
    } catch (e) {}
    window[key] = null;
  };
  return window[key];
};
// Cascade-diagnosis instrumentation (refs #93). Counts every
// talk-session-changed delivery and emits a rolling batch record
// every 10 events so we can see per-event cost + frequency without
// flooding bram-trace.
var __tscBatch = { count: 0, totalMs: 0, maxMs: 0, sinceMs: 0 };
function __tscBatchTick(elapsedMs) {
  if (__tscBatch.count === 0) __tscBatch.sinceMs = Date.now();
  __tscBatch.count += 1;
  __tscBatch.totalMs += elapsedMs;
  if (elapsedMs > __tscBatch.maxMs) __tscBatch.maxMs = elapsedMs;
  if (__tscBatch.count >= 10) {
    try {
      if (typeof window.logToHost === "function" && !window.__bramMenuPending) {
        window.logToHost({
          kind: "iframe-trace",
          subkind: "talk-session-batch",
          at: new Date().toISOString(),
          count: __tscBatch.count,
          sumMs: Math.round(__tscBatch.totalMs * 10) / 10,
          avgMs: Math.round((__tscBatch.totalMs / __tscBatch.count) * 10) / 10,
          maxMs: Math.round(__tscBatch.maxMs * 10) / 10,
          spanMs: Date.now() - __tscBatch.sinceMs,
        });
      }
    } catch (e) {}
    __tscBatch = { count: 0, totalMs: 0, maxMs: 0, sinceMs: 0 };
  }
}
// Parent-window-scoped Tauri-listener dedup, fixing the iframe-reload
// accumulation leak.
//
// Both ev.listen() call sites in this file (the direct
// talk-session-changed listener below and the dynamic one inside
// __ensureTauriEventListener) register on `window.parent.__TAURI__.event`,
// which lives on the parent shell webview and PERSISTS across iframe
// reloads. The iframe's own module-level state
// (__tauriEventListening / __tauriEventSubscribers) re-initialises on
// every load, so each fresh load thought no listener existed and
// registered another one — old closures from prior loads stayed live
// on the parent registry. One host emit then fanned out to N copies
// of every subscriber, multiplying refetch-called fires, debounce
// schedules, DataSource reloads, etc.
//
// Symptom we measured during the Globals.xs migration (commit d532432):
// listener-fired count per pty-menu-changed event grew from 4 → 5
// across two manual reloads of the same Bram session. Same pattern
// for talk-session-changed.
//
// Fix: keep a parent-window-scoped map of eventName → unsub function
// (or pending listen() promise). On each iframe load, drain the
// stale entry before calling ev.listen() again. Trace the drain so
// we can verify the dedup is firing.
function __bramListenWithDedup(ev, eventName, callback) {
  if (!ev || typeof ev.listen !== "function") return Promise.resolve(null);
  var parent;
  try {
    parent = (window.parent && window.parent !== window) ? window.parent : window;
  } catch (e) {
    parent = window;
  }
  try {
    if (!parent.__bramTauriListenerUnsubs) parent.__bramTauriListenerUnsubs = {};
  } catch (e) {}
  var store = null;
  try { store = parent.__bramTauriListenerUnsubs; } catch (e) {}
  // Dedup key must include iframe identity, not just eventName. Tools-pane
  // and right-pane both register Tauri listeners against the parent webview
  // (window.parent.__TAURI__.event), and each iframe's listener callback
  // closes over its OWN __tauriEventSubscribers array. Keying by eventName
  // alone made any later iframe's load drain the prior iframe's listener —
  // leaving the orphaned iframe's subscriber array (AgentMenu + Toolbar +
  // native, for the tools-pane) silently unwatched, so menus didn't render
  // on cold start until a manual reload made the affected iframe the last
  // to register. Same-iframe reloads still drain themselves (the original
  // 4→5 stale-listener bug from commit d532432 stays fixed).
  var iframeKey = (function () {
    try { return window.location.pathname || ""; } catch (e) { return ""; }
  })();
  var storeKey = eventName + "::" + iframeKey;
  var stale = store ? store[storeKey] : null;
  if (stale) {
    try {
      if (typeof stale === "function") {
        try { stale(); } catch (e) {}
      } else if (stale && typeof stale.then === "function") {
        stale.then(function (fn) { if (typeof fn === "function") { try { fn(); } catch (e) {} } }, function () {});
      }
    } catch (e) {}
    try { if (store) store[storeKey] = null; } catch (e) {}
    try {
      if (typeof window.logToHost === "function") {
        window.logToHost({
          kind: "iframe-trace",
          subkind: "tauri-listener-dedup",
          at: new Date().toISOString(),
          event_name: eventName,
          iframe_key: iframeKey,
          stage: "drained-stale",
        });
      }
    } catch (e) {}
  }
  var listenResult;
  try {
    listenResult = ev.listen(eventName, callback);
  } catch (e) {
    return Promise.resolve(null);
  }
  try { if (store) store[storeKey] = listenResult; } catch (e) {}
  Promise.resolve(listenResult).then(function (unsub) {
    try { if (store) store[storeKey] = unsub; } catch (e) {}
  }, function () {});
  return Promise.resolve(listenResult);
}
try {
  if (window.parent && window.parent.__TAURI__ && window.parent.__TAURI__.event) {
    __bramListenWithDedup(window.parent.__TAURI__.event, "talk-session-changed", function (event) {
      var t0 = (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
      // Per-emit correlation id from the host (see Rust
      // emit_talk_session_changed). Logged here so the trace records
      // the parent→iframe hand-off independently of any subscriber's
      // own listener-fired trace. at_host_ms lets each iframe-side
      // trace report delta_to_emit_ms — host emit → this point and,
      // via subscriber forwarding, host emit → listener-fired and
      // host emit → refetch-called.
      var payload = (event && event.payload) || {};
      var correlationId = payload.correlation_id || "";
      var atHostMs = (typeof payload.at_host_ms === "number") ? payload.at_host_ms : 0;
      try {
        if (typeof window.logToHost === "function") {
          window.logToHost({
            kind: "iframe-trace",
            subkind: "event-received",
            at: new Date().toISOString(),
            context: "talk-session-changed",
            correlation_id: correlationId,
            subscribers: __talkSessionSubscribers.length,
            at_host_ms: atHostMs,
            delta_to_emit_ms: atHostMs ? (Date.now() - atHostMs) : -1,
          });
        }
      } catch (e) {}
      var n = __talkSessionSubscribers.length;
      for (var i = 0; i < n; i++) {
        try { __talkSessionSubscribers[i](correlationId, atHostMs, payload); } catch (e) {}
      }
      var t1 = (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
      __tscBatchTick(t1 - t0);
    });
  }
} catch (e) {}

// Generic keyed-slot subscription to a parent-shell Tauri event (#81).
// Mirrors subscribeTalkSessionChange so the same leak fix applies to
// any event name: ONE parent listener per eventName, registered lazily
// on first subscribe and guarded so it attaches exactly once per
// helpers.js load, fanning out to a synchronous subscriber array. The
// per-mount subscribe call is fully synchronous (revoke window[key],
// push, store unsub) — no tauri.event.listen Promise window — so a
// component's onInit re-running on hot-reload keeps the live-subscriber
// count at exactly one. The prior direct tauri.event.listen(...).then()
// blocks stacked one live listener per onInit re-run.
var __tauriEventSubscribers = {};
var __tauriEventListening = {};
var __tauriEventListenReady = {};
function __ensureTauriEventListener(eventName) {
  if (__tauriEventListening[eventName]) return __tauriEventListenReady[eventName] || Promise.resolve(true);
  var ev = (window.parent && window.parent.__TAURI__ && window.parent.__TAURI__.event)
    || (window.__TAURI__ && window.__TAURI__.event);
  if (!ev || typeof ev.listen !== "function") return Promise.resolve(false);
  __tauriEventListening[eventName] = true;
  try {
    var listenResult = __bramListenWithDedup(ev, eventName, function (e) {
      var subs = __tauriEventSubscribers[eventName] || [];
      try {
        if (typeof window.logToHost === "function") {
          window.logToHost({
            kind: "iframe-trace",
            subkind: "event-received",
            at: new Date().toISOString(),
            event_name: eventName,
            subscribers: subs.length,
          });
        }
      } catch (err) {}
      for (var i = 0; i < subs.length; i++) {
        var subStart = (typeof performance !== "undefined" && performance.now)
          ? performance.now()
          : Date.now();
        try { subs[i](e); } catch (err) {}
        try {
          if (typeof window.logToHost === "function") {
            var subEnd = (typeof performance !== "undefined" && performance.now)
              ? performance.now()
              : Date.now();
            window.logToHost({
              kind: "iframe-trace",
              subkind: "subscriber-fired",
              at: new Date().toISOString(),
              event_name: eventName,
              subscriber_index: i,
              elapsed_ms: Math.round(subEnd - subStart),
            });
          }
        } catch (err) {}
      }
    });
    __tauriEventListenReady[eventName] = Promise.resolve(listenResult).then(
      function () { return true; },
      function () {
        __tauriEventListening[eventName] = false;
        return false;
      },
    );
  } catch (err) {
    __tauriEventListening[eventName] = false;
    __tauriEventListenReady[eventName] = Promise.resolve(false);
  }
  return __tauriEventListenReady[eventName];
}
function __notifyStartupReadyForEvent(eventName) {
  if (typeof window.fetch !== "function") return;
  window.fetch("/__startup-ready?event=" + encodeURIComponent(eventName), { cache: "no-store" })
    .then(function () {})
    .catch(function () {});
}
window.subscribeTauriEvent = function (key, eventName, fn, replayOnReady) {
  if (typeof window[key] === "function") {
    try { window[key](); } catch (e) {}
  }
  if (typeof fn !== "function") {
    window[key] = null;
    return function () {};
  }
  if (!__tauriEventSubscribers[eventName]) __tauriEventSubscribers[eventName] = [];
  var listenReady = __ensureTauriEventListener(eventName);
  __tauriEventSubscribers[eventName].push(fn);
  window[key] = function () {
    var subs = __tauriEventSubscribers[eventName] || [];
    var idx = subs.indexOf(fn);
    if (idx >= 0) subs.splice(idx, 1);
    window[key] = null;
  };
  Promise.resolve(listenReady).then(function (ready) {
    if (!ready) return;
    var subs = __tauriEventSubscribers[eventName] || [];
    if (replayOnReady !== false && subs.indexOf(fn) >= 0) {
      __notifyStartupReadyForEvent(eventName);
    }
  });
  return window[key];
};

// Native plain-JS subscribers for the AgentMenu pipeline. Counterpart
// to window.__bramApplyAgentMenu / window.__bramSetAgentMenuFrom*
// defined earlier in this file. Registered here, AFTER
// window.subscribeTauriEvent exists, before any External subscribers
// attach through bramSubscribeAgentMenu. Subscribers are dispatched by
// __ensureTauriEventListener in registration order, so the native handler
// updates window.bramAgentMenu in plain JS before XMLUI consumers read it.
window.subscribeTauriEvent("__bramNativePtyMenuUnsub", "pty-menu-changed", function (e) {
  window.__bramSetAgentMenuFromEvent(e, "agent-menu");
});
// Diagnostic tap for the send-restore chain (2026-07-03): the host emit
// reaches the iframe (event-received traces) but the markup applier has
// never traced. This native subscriber proves whether payloads survive
// the bridge; the actual restore logic stays in __bramApplySendRestore.
window.subscribeTauriEvent("__bramNativeSendRestoreUnsub", "send-restore", function (e) {
  try {
    var p = (e && e.payload) || null;
    window.__bramIframeTrace("send-restore", {
      stage: "native",
      hasPayload: !!p,
      chars: (p && p.text && p.text.length) || 0,
    });
  } catch (err) {}
});
window.subscribeTauriEvent("__bramNativeTurnStateUnsub", "turn-state-changed", function (e) {
  window.__bramSetAgentMenuFromTurnState((e && e.payload) || {}, "agent-menu");
});

// Native subscribers for toolbar pending-menu state. Moved out of
// Main.xmlui's onInit blob (item: main-xmlui-tauri-subscribers-external).
// The arrow bodies that used to live in markup only called
// window.__bramSetToolbarPendingMenuFrom* — pure side-effects on
// window state, no App-level var dependencies. Same pattern as the
// AgentMenu native subscribers above.
window.subscribeTauriEvent("__bramNativeToolbarTurnStateUnsub",
  "turn-state-changed", function (e) {
    window.__bramSetToolbarPendingMenuFromTurnState((e && e.payload) || null);
  });
window.subscribeTauriEvent("__bramNativeToolbarPtyMenuUnsub",
  "pty-menu-changed", function (e) {
    window.__bramSetToolbarPendingMenuFromEvent(e);
  });

// External-driven agent-status bridge. Emits the agent-status-changed
// event payload; also performs the agent-header-status-loaded trace
// emit that used to live in Main.xmlui's onInit arrow body.
// One tauri subscription, two fan-outs:
//  - bramSubscribeAgentStatus (deduped): notifies only when a meaningful field
//    (state/verb/provider/substate/source) changes. The many app-wide consumers
//    use this, so the ~1/sec elapsedText tick no longer re-renders the whole
//    agent-status surface every second.
//  - bramSubscribeAgentStatusRaw: notifies on every push, including the elapsed
//    tick, for the single isolated component that shows the running timer
//    (FooterAgentStatus). See decouple-elapsed-from-agent-status-broadcast.
(function () {
  var rawSubs = new Set();
  var dedupSubs = new Set();
  var lastValue = null;
  var lastSig = null;
  var sigOf = function (v) {
    return v ? [v.state, v.verb, v.provider, v.substate, v.source].join("|") : "";
  };
  var notify = function (set) {
    set.forEach(function (fn) {
      try { fn(); } catch (e) { console.error("[bramSubscribeAgentStatus] subscriber threw:", e); }
    });
  };
  var subscribed = false;
  var ensureSubscribed = function () {
    if (subscribed) return;
    subscribed = true;
    window.subscribeTauriEvent("__bramAgentStatusExternalUnsub",
      "agent-status-changed", function (e) {
        lastValue = (e && e.payload) || null;
        if (!window.bramAgentMenu) {
          window.__bramIframeTrace("agent-header-status-loaded", {
            state: (lastValue && lastValue.state) || "",
            verb: (lastValue && lastValue.verb) || "",
            provider: (lastValue && lastValue.provider) || "",
            source: (lastValue && lastValue.source) || "",
            elapsed: (lastValue && lastValue.elapsedText) || ""
          });
        }
        notify(rawSubs);
        var sig = sigOf(lastValue);
        if (sig !== lastSig) {
          lastSig = sig;
          notify(dedupSubs);
        }
      });
  };
  var makeFactory = function (set) {
    var factory;
    return function () {
      if (factory) return factory;
      ensureSubscribed();
      factory = function (emit) {
        var fire = function () { emit(lastValue); };
        set.add(fire);
        fire();
        return function () { set.delete(fire); };
      };
      return factory;
    };
  };
  window.bramSubscribeAgentStatus = makeFactory(dedupSubs);
  window.bramSubscribeAgentStatusRaw = makeFactory(rawSubs);
})();

// Host suspicious-silence + parent terminal-visibility join. The Rust host
// owns the adaptive PTY/turn predicate; main.js owns terminal visibility.
// This isolated bridge exposes only the derived warning state to the footer.
(function () {
  var subscribers = new Set();
  var hostValue = null;
  var terminalHidden = null;
  var lastTerminalHidden = null;
  var suppressedEpisode = "";
  var lastValue = { active: false, terminalHidden: null };
  var lastSignature = "";
  var hostSubscribed = false;

  var episodeOf = function (value) {
    return value && value.episodeId ? String(value.episodeId) : "";
  };
  var derivedValue = function () {
    var episode = episodeOf(hostValue);
    var active = !!(hostValue && hostValue.active && terminalHidden === true &&
      (!suppressedEpisode || suppressedEpisode !== episode));
    return Object.assign({}, hostValue || {}, {
      active: active,
      terminalHidden: terminalHidden,
    });
  };
  var notify = function (reason) {
    var next = derivedValue();
    var signature = JSON.stringify(next);
    if (signature === lastSignature) return;
    var wasActive = !!(lastValue && lastValue.active);
    lastSignature = signature;
    lastValue = next;
    if (wasActive !== !!next.active) {
      window.__bramIframeTrace("terminal-suspicious-silence", {
        op: next.active ? "warn" : "cleared",
        reason: reason || next.reason || "state-change",
        terminalHidden: terminalHidden,
        provider: next.provider || "",
        turn: next.turnStamp || "",
        episode: next.episodeId || "",
        silence_ms: next.silenceMs || 0,
        threshold_ms: next.thresholdMs || 0,
        gap_p95_ms: next.gapP95Ms || 0,
        gaps_n: next.gapsN || 0,
        test_mode: !!next.testMode,
      });
    }
    subscribers.forEach(function (fn) {
      try { fn(); } catch (e) { console.error("[bram] suspicious-silence subscriber threw:", e); }
    });
  };

  window.addEventListener("message", function (event) {
    var data = event && event.data;
    if (!data || event.source !== window.parent) return;
    if (data.type === "bram-terminal-suspicious-silence-test") {
      var testEpisode = data.episodeId ? String(data.episodeId) : "self-test:" + Date.now();
      if (suppressedEpisode !== testEpisode) suppressedEpisode = "";
      hostValue = {
        active: true,
        reason: "self-test",
        episodeId: testEpisode,
        provider: "self-test",
        turnStamp: "",
        silenceMs: Number(data.silenceMs) || 3000,
        thresholdMs: Number(data.thresholdMs) || 3000,
        gapP95Ms: Number(data.gapP95Ms) || 0,
        gapsN: Number(data.gapsN) || 0,
        testMode: true,
        at: Number(data.at) || Date.now(),
      };
      notify("self-test");
      return;
    }
    if (data.type !== "bram-terminal-visibility") return;
    var nextHidden = !!data.hidden;
    if (data.dismissedEpisode) suppressedEpisode = String(data.dismissedEpisode);
    if (lastTerminalHidden === true && nextHidden === false && hostValue && hostValue.active) {
      // Reopening the terminal dismisses this episode. Hiding it again must
      // not re-warn until real PTY activity rearms the host detector.
      suppressedEpisode = episodeOf(hostValue);
      window.parent.postMessage({
        type: "bram-terminal-silence-dismissed",
        episodeId: suppressedEpisode,
      }, "*");
    }
    lastTerminalHidden = nextHidden;
    terminalHidden = nextHidden;
    notify(nextHidden ? "terminal-closed" : "terminal-opened");
  });

  var ensureHostSubscribed = function () {
    if (hostSubscribed) return;
    hostSubscribed = true;
    window.subscribeTauriEvent(
      "__bramTerminalSuspiciousSilenceUnsub",
      "terminal-suspicious-silence",
      function (event) {
        hostValue = (event && event.payload) || null;
        if (!hostValue || !hostValue.active) suppressedEpisode = "";
        notify((hostValue && hostValue.reason) || "host-state");
      }
    );
  };

  window.bramSubscribeTerminalSuspiciousSilence = (function () {
    var factory;
    return function () {
      if (factory) return factory;
      ensureHostSubscribed();
      factory = function (emit) {
        var fire = function () { emit(lastValue); };
        subscribers.add(fire);
        fire();
        return function () { subscribers.delete(fire); };
      };
      return factory;
    };
  })();

  window.__bramOpenTerminalForSuspiciousSilence = function () {
    if (hostValue && hostValue.active) {
      suppressedEpisode = episodeOf(hostValue);
      notify("open-terminal-click");
    }
    window.parent.postMessage({
      type: "bram-open-terminal",
      episodeId: episodeOf(hostValue),
    }, "*");
  };

  window.parent.postMessage({ type: "bram-terminal-visibility-request" }, "*");
})();

// Terminal-visibility banner bridge factory (issue-270).
//
// The two bridges below answer the same question -- is the host reporting an
// active condition AND is the terminal pane hidden? -- and each used to carry
// its own copy of the same scaffolding: a "bram-terminal-visibility" listener,
// a hostValue slot, a terminalHidden flag, a derived-state flip guard, a
// __bramIframeTrace emit, and a subscriber fan-out with per-subscriber
// try/catch. Adding a shape meant another copy.
//
// The per-bridge ISOLATION those copies provided is deliberate and is kept
// here: every call builds a fresh closure set with its own listener, its own
// state, and its own subscriber list, so one subscriber's derived-state
// recompute still cannot depend on another's internal ordering (the same
// rationale as FooterAgentStatus.xmlui's PushSource split). What is shared is
// the code that BUILDS a bridge, never anything two bridges hold at runtime.
// #270 originally asked for one consolidated bridge, which would have reverted
// that isolation; the issue carries a correction and this is the corrected
// shape.
//
// The suspicious-silence bridge above is deliberately NOT built on this. It
// carries machinery the other two have no analogue for -- reopening the
// terminal dismisses the episode and posts back to the parent, its notify()
// threads a reason through to the trace, and its self-test payload is far
// richer. Folding it in would mean four more hooks in this spec, and the
// factory would become harder to read than the copy it replaced. Fold it in
// only if a shape ever needs that reopen-dismisses behavior too.
//
// spec:
//   event        Tauri event name carrying the host payload
//   unsubGlobal  window key handed to subscribeTauriEvent
//   subkind      __bramIframeTrace subkind for the warn/cleared flip
//   initial      value emitted to subscribers before the first host payload
//   traceFields  optional (next) -> extra fields merged into the trace line
//   episodeOf    optional (hostValue) -> episode key; supplying it enables
//                dismiss(), which suppresses only the current episode
//   testType     optional parent message type carrying a self-test payload
//   onTest       optional (data) -> synthetic host payload for that message
//
// Returns { subscribe, dismiss }. `subscribe` is the memoized
// factory-of-factories the XMLUI PushSources expect.
window.__bramMakeTerminalVisibilityBridge = function (spec) {
  var subscribers = new Set();
  var hostValue = null;
  var terminalHidden = null;
  var suppressedEpisode = "";
  var lastValue = spec.initial || { active: false, terminalHidden: null };
  var lastSignature = "";
  var hostSubscribed = false;

  var episodeOf = function (value) {
    return spec.episodeOf ? spec.episodeOf(value) : "";
  };

  var derivedValue = function () {
    var active = !!(hostValue && hostValue.active && terminalHidden === true);
    if (active && spec.episodeOf && suppressedEpisode &&
        suppressedEpisode === episodeOf(hostValue)) {
      active = false;
    }
    return Object.assign({}, hostValue || {}, {
      active: active,
      terminalHidden: terminalHidden,
    });
  };

  var notify = function () {
    var next = derivedValue();
    var signature = JSON.stringify(next);
    if (signature === lastSignature) return;
    var wasActive = !!(lastValue && lastValue.active);
    lastSignature = signature;
    lastValue = next;
    if (wasActive !== !!next.active) {
      var fields = {
        op: next.active ? "warn" : "cleared",
        terminalHidden: terminalHidden,
      };
      if (spec.traceFields) Object.assign(fields, spec.traceFields(next));
      window.__bramIframeTrace(spec.subkind, fields);
    }
    subscribers.forEach(function (fn) {
      try { fn(); } catch (e) {
        console.error("[bram] " + spec.subkind + " subscriber threw:", e);
      }
    });
  };

  window.addEventListener("message", function (event) {
    var data = event && event.data;
    if (!data || event.source !== window.parent) return;
    if (spec.testType && data.type === spec.testType) {
      hostValue = spec.onTest(data);
      if (!hostValue || !hostValue.active) suppressedEpisode = "";
      notify();
      return;
    }
    if (data.type !== "bram-terminal-visibility") return;
    terminalHidden = !!data.hidden;
    notify();
  });

  var ensureHostSubscribed = function () {
    if (hostSubscribed) return;
    hostSubscribed = true;
    window.subscribeTauriEvent(spec.unsubGlobal, spec.event, function (event) {
      hostValue = (event && event.payload) || null;
      if (!hostValue || !hostValue.active) suppressedEpisode = "";
      notify();
    });
  };

  var subscribe = (function () {
    var factory;
    return function () {
      if (factory) return factory;
      ensureHostSubscribed();
      factory = function (emit) {
        var fire = function () { emit(lastValue); };
        subscribers.add(fire);
        fire();
        return function () { subscribers.delete(fire); };
      };
      return factory;
    };
  })();

  window.parent.postMessage({ type: "bram-terminal-visibility-request" }, "*");

  return {
    subscribe: subscribe,
    dismiss: function () {
      if (hostValue && hostValue.active) {
        suppressedEpisode = episodeOf(hostValue);
        notify();
      }
    },
  };
};

// Host terminal-attention + parent terminal-visibility join (issue-234).
// The Rust host owns the no-open-turn + byte-silent + prompt-shape
// predicate (`terminal-attention-changed`); main.js owns terminal
// visibility. The banner is active only when BOTH the host says an
// unattended prompt is showing AND the terminal pane is hidden. No episode
// bookkeeping and no dismiss: this banner has no ✕ — it clears itself the
// moment either side of the join goes false (host clear on PTY activity, or
// the terminal becoming visible), so there is no dismissed-episode state to
// track and no episodeOf in its spec.
(function () {
  var bridge = window.__bramMakeTerminalVisibilityBridge({
    event: "terminal-attention-changed",
    unsubGlobal: "__bramNativeTerminalAttentionUnsub",
    subkind: "terminal-attention",
    initial: { active: false, shape: null, terminalHidden: null },
    traceFields: function (next) {
      return { shape: next.shape || "", atMs: next.atMs || 0 };
    },
  });
  window.bramSubscribeTerminalAttention = bridge.subscribe;

  // Banner button (issue-234 iterate): reveal the terminal from the pane,
  // via the parent's existing bram-open-terminal handler (the
  // suspicious-silence button's mechanism). No episode bookkeeping — the
  // reveal flips terminalHidden, which alone clears the derived banner.
  window.__bramOpenTerminalForAttention = function () {
    window.parent.postMessage({ type: "bram-open-terminal" }, "*");
  };
})();

// Host compaction + parent terminal-visibility join
// (compaction-in-progress-banner). The Rust host owns a text-PRESENCE
// detector (`compaction-changed`) that is deliberately NOT the
// terminal-attention byte-silence path above: compaction actively prints a
// spinner, so it fires when the live PTY tail CONTAINS the provider's
// "Compacting conversation" progress line and clears the instant it no
// longer does. Same join shape as terminal-attention, plus an episode-keyed
// dismiss modeled on the suspicious-silence bridge further up this file: a ✕
// click suppresses only the CURRENT compaction episode, and the next
// compaction (a fresh host Fire, which carries a new `atMs`) re-shows the
// banner. The host payload has no explicit episode id, so `atMs` — stable
// for the whole active span since the host only emits on Fire/Clear, not
// continuously — stands in as the episode key.
(function () {
  var bridge = window.__bramMakeTerminalVisibilityBridge({
    event: "compaction-changed",
    unsubGlobal: "__bramCompactionUnsub",
    subkind: "compaction",
    initial: { active: false, provider: "", terminalHidden: null },
    traceFields: function (next) {
      return { provider: next.provider || "", atMs: next.atMs || 0 };
    },
    episodeOf: function (value) {
      return value && value.active ? String(value.atMs || "") : "";
    },
    // Self-test hook (compaction-in-progress-banner testing), dispatched by
    // app/main.js's postCompactionSelfTest -- posted directly as a fake host
    // payload rather than routed through a real Tauri event.
    testType: "bram-compaction-test",
    onTest: function (data) {
      return {
        active: !!data.active,
        provider: data.provider || "self-test",
        atMs: Number(data.atMs) || Date.now(),
      };
    },
  });
  window.bramSubscribeCompaction = bridge.subscribe;

  // Banner ✕ (compaction-in-progress-banner): suppress only the episode
  // active right now. A later compaction fires a new `atMs`, a new episode
  // key, and re-shows the banner unconditionally.
  window.__bramDismissCompaction = bridge.dismiss;
})();

// External-driven PTY-throughput bridge (transcript-nav-activity-sparkline).
// The host emits `pty-throughput` a few times/sec with a 0..1 intensity
// derived from the byte rate flowing through the PTY reader loop. Subscribers
// (the Transcript nav activity row) map it to a dot count + pulse. Mirrors
// bramSubscribeAgentStatus above.
window.bramSubscribePtyThroughput = (function () {
  var factory;
  return function () {
    if (factory) return factory;
    var subscribers = new Set();
    var lastValue = 0;
    var notify = function () {
      subscribers.forEach(function (fn) {
        try { fn(); } catch (e) { console.error("[bramSubscribePtyThroughput] subscriber threw:", e); }
      });
    };
    window.subscribeTauriEvent("__bramPtyThroughputExternalUnsub",
      "pty-throughput", function (e) {
        lastValue = (e && typeof e.payload === "number") ? e.payload : 0;
        notify();
      });
    factory = function (emit) {
      var fire = function () { emit(lastValue); };
      subscribers.add(fire);
      fire();
      return function () { subscribers.delete(fire); };
    };
    return factory;
  };
})();

// External-driven enhance-status tick. Emits an incrementing tick on
// each enhance-status-changed event so a downstream ChangeListener can
// trigger DataSource.refetch() (a markup-only operation).
window.bramSubscribeEnhanceStatusTick = (function () {
  var factory;
  return function () {
    if (factory) return factory;
    var subscribers = new Set();
    var tick = 0;
    window.subscribeTauriEvent("__bramEnhanceStatusExternalUnsub",
      "enhance-status-changed", function () {
        tick += 1;
        subscribers.forEach(function (fn) {
          try { fn(); } catch (e) { console.error("[bramSubscribeEnhanceStatusTick] subscriber threw:", e); }
        });
      });
    factory = function (emit) {
      var fire = function () { emit(tick); };
      subscribers.add(fire);
      fire();
      return function () { subscribers.delete(fire); };
    };
    return factory;
  };
})();

// Voice transcript scratch setter — invoked from xs arrow bodies that
// can't write `window.foo = x` as an LValue (XMLUI's expression engine
// rejects member-expression LValues with "Left value variable not
// found in scope" — see bram-trace 2026-06-17 00:43:03). Plain JS, no
// xs evaluator involvement.
// Plain-JS append helper. xs `function foo()` declarations do NOT
// reliably hoist onto window from the iframe's runtime context — see
// 2026-06-17 voice debugging where window.appendVoiceTranscript and
// window.bumpWorklistVoiceSeq calls returned without entering the
// function body. Defining the append helper directly on window
// guarantees the call lands.
window.__bramAppendVoiceToBox = function (component, transcript) {
  try { window.__bramIframeTrace && window.__bramIframeTrace("voice-trace", { stage: "windowAppend-enter", tLen: (transcript || "").length, hasComponent: !!component }); } catch (e) {}
  if (!component || !transcript) {
    try { window.__bramIframeTrace && window.__bramIframeTrace("voice-trace", { stage: "windowAppend-early-return", reason: !component ? "no-component" : "no-transcript" }); } catch (e) {}
    return false;
  }
  var current = String(component.value || "");
  var cleaned = transcript.replace(/\r?\n/g, " ").replace(/[ \t]+/g, " ").trim();
  if (!cleaned) {
    try { window.__bramIframeTrace && window.__bramIframeTrace("voice-trace", { stage: "windowAppend-cleaned-empty" }); } catch (e) {}
    return false;
  }
  var spacer = current && !/\s$/.test(current) ? " " : "";
  var next = current + spacer + cleaned;
  try { window.__bramIframeTrace && window.__bramIframeTrace("voice-trace", { stage: "windowAppend-calling-setValue", currentLen: current.length, nextLen: next.length }); } catch (e) {}
  try {
    component.setValue(next);
    try { window.__bramIframeTrace && window.__bramIframeTrace("voice-trace", { stage: "windowAppend-after-setValue" }); } catch (e) {}
  } catch (e) {
    try { window.__bramIframeTrace && window.__bramIframeTrace("voice-trace", { stage: "windowAppend-setValue-threw", error: String(e && e.message) }); } catch (e2) {}
    return false;
  }
  try {
    if (typeof component.focus === "function") component.focus();
    if (typeof component.setSelectionRange === "function") component.setSelectionRange(next.length, next.length);
  } catch (e) {}
  return next;
};

window.__bramSetLatestVoiceState = function (t, meta) {
  try { window.__bramIframeTrace && window.__bramIframeTrace("voice-trace", { stage: "setLatest-enter", tLen: (t || "").length }); } catch (e) {}
  window.__bramLatestVoiceTranscript = t || "";
  window.__bramLatestVoiceMeta = meta || null;
  try {
    window.dispatchEvent(new CustomEvent("bram:voice-arrival", {
      detail: { transcript: t || "", meta: meta || null, at: Date.now() },
    }));
    try { window.__bramIframeTrace && window.__bramIframeTrace("voice-trace", { stage: "setLatest-dispatched" }); } catch (e) {}
  } catch (e) {
    console.error("[bram] voice-arrival dispatch failed:", e);
  }
};

window.addEventListener("message", function (ev) {
  var data = ev && ev.data;
  if (!data || data.type !== "voice-state") return;
  var state = data.state || "idle";
  var requestId = data.requestId || null;
  window.__bramVoiceRecorderState = {
    state: state,
    requestId: requestId,
    target: data.target || "",
    reason: data.reason || "",
    transcriptLength:
      typeof data.transcriptLength === "number" ? data.transcriptLength : null,
    at: Date.now(),
  };
  if (state === "idle" && (!requestId || requestId === window._voiceSession)) {
    window._voiceSession = null;
    window._voiceSessionTarget = "";
    _voiceRemoveStartedListener();
  }
  try {
    window.dispatchEvent(new CustomEvent("bram:voice-recorder-state", {
      detail: window.__bramVoiceRecorderState,
    }));
  } catch (e) {
    console.error("[bram] voice-recorder-state dispatch failed:", e);
  }
});

window.bramSubscribeVoiceRecorderState = (function () {
  var factory;
  return function () {
    if (factory) return factory;
    var subscribers = new Set();
    var notify = function () {
      subscribers.forEach(function (fn) {
        try { fn(); } catch (e) { console.error("[bram] voice-recorder-state subscriber threw:", e); }
      });
    };
    window.addEventListener("bram:voice-recorder-state", notify);
    factory = function (emit) {
      var fire = function () { emit(window.__bramVoiceRecorderState); };
      subscribers.add(fire);
      fire();
      return function () { subscribers.delete(fire); };
    };
    return factory;
  };
})();

// External-driven voice-arrival bridge. xs-side writes to module vars
// (worklistVoiceSeq, worklistVoiceText) don't propagate through XMLUI's
// reactive system when triggered from arrow-body callbacks (see
// 2026-06-17 voice debugging). This External listens to a window-side
// CustomEvent that __bramSetLatestVoiceState dispatches, giving the
// XMLUI reactivity layer a path it can observe.
window.bramSubscribeVoiceArrival = (function () {
  var factory;
  return function () {
    if (factory) return factory;
    var subscribers = new Set();
    var currentEvent = null;
    var notify = function () {
      subscribers.forEach(function (fn) {
        try { fn(); } catch (e) { console.error("[bram] voice-arrival subscriber threw:", e); }
      });
    };
    window.addEventListener("bram:voice-arrival", function (evt) {
      currentEvent = (evt && evt.detail) || null;
      try { window.__bramIframeTrace && window.__bramIframeTrace("voice-trace", { stage: "external-event-received", tLen: ((currentEvent && currentEvent.transcript) || "").length, subscribers: subscribers.size }); } catch (e) {}
      notify();
      currentEvent = null;
    });
    factory = function (emit) {
      var fire = function () {
        try { window.__bramIframeTrace && window.__bramIframeTrace("voice-trace", { stage: "external-fire", hasEvent: !!currentEvent }); } catch (e) {}
        emit(currentEvent);
      };
      subscribers.add(fire);
      try { window.__bramIframeTrace && window.__bramIframeTrace("voice-trace", { stage: "external-subscribed", totalSubscribers: subscribers.size }); } catch (e) {}
      emit(null);
      return function () { subscribers.delete(fire); };
    };
    return factory;
  };
})();

// Parent → agent-pane bridge for whisper-server failure notices.
// main.js posts { type: "bram-whisper-unavailable", reason, kind?, detail? }
// to the tools-pane iframe when voice cannot start or transcription fails.
// Re-dispatch as a window CustomEvent that the External below observes,
// giving XMLUI markup a path to toast. Same indirection as
// __bramSetLatestVoiceState / voice-arrival.
window.addEventListener("message", function (event) {
  var data = event && event.data;
  if (!data || data.type !== "bram-whisper-unavailable") return;
  try {
    window.dispatchEvent(new CustomEvent("bram:whisper-unavailable", {
      detail: {
        reason: String(data.reason || ""),
        kind: String(data.kind || ""),
        detail: String(data.detail || ""),
        at: Date.now(),
      },
    }));
  } catch (e) {
    console.error("[bram] whisper-unavailable dispatch failed:", e);
  }
});

window.addEventListener("message", function (event) {
  var data = event && event.data;
  if (!data || data.type !== "bram-voice-busy") return;
  try {
    window.dispatchEvent(new CustomEvent("bram:voice-busy", {
      detail: {
        requester: String(data.requester || ""),
        activeWas: String(data.activeWas || ""),
        activeRequestId: String(data.activeRequestId || ""),
        activeTarget: String(data.activeTarget || ""),
        at: Date.now(),
      },
    }));
  } catch (e) {
    console.error("[bram] voice-busy dispatch failed:", e);
  }
});

window.bramSubscribeWhisperUnavailable = (function () {
  var factory;
  return function () {
    if (factory) return factory;
    var subscribers = new Set();
    var lastEvent = null;
    var notify = function () {
      subscribers.forEach(function (fn) {
        try { fn(); } catch (e) { console.error("[bram] whisper-unavailable subscriber threw:", e); }
      });
    };
    window.addEventListener("bram:whisper-unavailable", function (evt) {
      lastEvent = (evt && evt.detail) || null;
      notify();
    });
    factory = function (emit) {
      var fire = function () { emit(lastEvent); };
      subscribers.add(fire);
      fire();
      return function () { subscribers.delete(fire); };
    };
    return factory;
  };
})();

window.__bramToastWhisperNotice = function (notice, toastApi) {
  if (!notice || !toastApi || typeof toastApi.error !== "function") return;
  if (notice.kind === "transcription-failed") {
    toastApi.error(
      "Voice transcription failed (" + String(notice.detail || "unknown error") +
      "). Recording worked; the whisper server could not transcribe it."
    );
    return;
  }
  toastApi.error(
    "Whisper server is not running and could not be started automatically. " +
    "Start it manually — see the README Voice input section: " +
    "https://github.com/judell/bram#voice-input"
  );
};

window.bramSubscribeVoiceBusy = (function () {
  var factory;
  return function () {
    if (factory) return factory;
    var subscribers = new Set();
    var lastEvent = null;
    var notify = function () {
      subscribers.forEach(function (fn) {
        try { fn(); } catch (e) { console.error("[bram] voice-busy subscriber threw:", e); }
      });
    };
    window.addEventListener("bram:voice-busy", function (evt) {
      lastEvent = (evt && evt.detail) || null;
      notify();
    });
    factory = function (emit) {
      var fire = function () { emit(lastEvent); };
      subscribers.add(fire);
      fire();
      return function () { subscribers.delete(fire); };
    };
    return factory;
  };
})();

// External-driven right-pane-size bridge. Same shape as the Tauri /
// agent-status / agent-menu factories, but the underlying source is
// the custom subscribeRightPaneSize API (window resize observer).
window.bramSubscribeRightPaneSize = (function () {
  var factory;
  return function () {
    if (factory) return factory;
    var subscribers = new Set();
    var lastSize = null;
    var notify = function () {
      subscribers.forEach(function (fn) {
        try { fn(); } catch (e) { console.error("[bramSubscribeRightPaneSize] subscriber threw:", e); }
      });
    };
    window.subscribeRightPaneSize(function (s) {
      lastSize = s || null;
      notify();
    });
    factory = function (emit) {
      var fire = function () { emit(lastSize); };
      subscribers.add(fire);
      fire();
      return function () { subscribers.delete(fire); };
    };
    return factory;
  };
})();

window.__bramLocalLinkPreview = null;
window.__bramLocalLinkPreviewSubscribers = new Set();
window.__bramNotifyLocalLinkPreview = function () {
  window.__bramLocalLinkPreviewSubscribers.forEach(function (fn) {
    try { fn(); } catch (e) { console.error("[bramLocalLinkPreview] subscriber threw:", e); }
  });
};
window.bramSubscribeLocalLinkPreview = (function () {
  var factory;
  return function () {
    if (factory) return factory;
    factory = function (emit) {
      var fire = function () { emit(window.__bramLocalLinkPreview); };
      window.__bramLocalLinkPreviewSubscribers.add(fire);
      fire();
      return function () { window.__bramLocalLinkPreviewSubscribers.delete(fire); };
    };
    return factory;
  };
})();
window.__bramCloseLocalLinkPreview = function () {
  window.__bramLocalLinkPreview = null;
  window.__bramNotifyLocalLinkPreview();
};
window.__bramSetLocalLinkPreview = function (payload) {
  window.__bramLocalLinkPreview = payload || null;
  window.__bramNotifyLocalLinkPreview();
};
window.__bramShowLinkPreviewError = function (href, error) {
  window.__bramSetLocalLinkPreview({
    ok: false,
    href: String(href || ""),
    displayPath: String(href || ""),
    title: "Link unavailable",
    error: String(error || "Could not open this link."),
    content: "",
    language: "",
    renderMode: "error",
    at: Date.now(),
  });
};
window.__bramLocalLinkPreviewTitle = function (preview) {
  if (!preview) return "File";
  if (preview.title) return preview.title;
  return preview.name || preview.displayPath || preview.path || preview.href || "File";
};
window.__bramLocalLinkPreviewMeta = function (preview) {
  if (!preview) return "";
  if (preview.error) return preview.displayPath || preview.href || "";
  var bits = [];
  if (preview.displayPath) bits.push(preview.displayPath);
  if (preview.line) bits.push("line " + preview.line);
  if (preview.truncated) bits.push("truncated");
  return bits.join(" · ");
};
window.__bramFormatLocalLinkPreview = function (preview) {
  if (!preview) return "";
  if (preview.error) return preview.error;
  var content = preview.content == null ? "" : String(preview.content);
  if (preview.renderMode === "markdown") return content;
  return window.__bramFenceMarkdown(content, preview.language || "");
};
window.__bramFenceMarkdown = function (body, lang) {
  body = body == null ? "" : String(body);
  var longest = 0, run = 0;
  for (var i = 0; i < body.length; i++) {
    if (body.charAt(i) === "`") { run++; if (run > longest) longest = run; }
    else { run = 0; }
  }
  var fence = "";
  var fenceLen = Math.max(3, longest + 1);
  for (var j = 0; j < fenceLen; j++) fence += "`";
  return fence + (lang || "") + "\n" + body + "\n" + fence;
};
window.__bramLocalLinkRequestFromHref = function (href) {
  href = String(href || "").trim();
  if (!href) return null;
  // XMLUI/Markdown rewrites many local hrefs into hash routes
  // (`/Users/me/x.md` -> `#/Users/me/x.md`, `README.md` -> `#README.md`).
  // Treat hash-prefixed file-like values as local links, but leave ordinary
  // page anchors (`#section`) alone.
  if (href.charAt(0) === "#") {
    var hashPath = href.slice(1);
    if (
      !hashPath ||
      !(/^\/|^~\/|^\.\.?\/|^[A-Za-z]:[\\/]/.test(hashPath) || /\.[A-Za-z0-9]+(?::\d+)?(?:[?#].*)?$/.test(hashPath))
    ) {
      return null;
    }
    href = hashPath;
  }
  if (/^(mailto|tel|javascript):/i.test(href)) {
    return { skip: true, reason: "scheme", href: href };
  }

  var raw = href;
  var m;
  if ((m = raw.match(/^file:\/\/(?:localhost)?([^?#]*)(?:[?#].*)?$/i))) {
    raw = decodeURIComponent(m[1] || "");
  } else if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) {
    return { skip: true, reason: "external-scheme", href: href };
  }
  raw = raw.replace(/[?#].*$/, "");

  // Bram nav routes render as hash routes (#/transcript, #/worklist). But
  // XMLUI's Markdown resolves RELATIVE links against the current route, so a
  // link like `[x](src/foo.rs)` from the transcript arrives as
  // `#/transcript/src/foo.rs`. Distinguish the two: a bare route (no
  // remainder) is navigation -> skip; a route followed by a file-like
  // remainder is a relative file link XMLUI prefixed with the current route
  // -> strip the route segment and preview the remainder. Absolute links
  // (/Users, /etc, ...) don't start with a known route and fall through.
  // Keep this alternation in sync with Main.xmlui's NavLink routes — a nav
  // route missing here gets intercepted as a local FILE link and the click
  // opens a "File unavailable" preview instead of the page (the /queue
  // launch bug, 2026-07-23).
  var routeMatch = raw.match(
    /^\/(needs-you|worklist2?|transcript|search|issues|commits|queue|history|sessions|tips|settings|status|context)(\/.*)?$/
  );
  if (routeMatch) {
    var rest = routeMatch[2] ? routeMatch[2].slice(1) : "";
    if (!rest || !/\.[A-Za-z0-9]+(?::\d+)?$/.test(rest)) {
      return { skip: true, reason: "app-route", href: href, raw: raw };
    }
    raw = rest;
  }

  var line = null;
  var lineMatch = raw.match(/^(.*):(\d+)$/);
  if (lineMatch && !/^[A-Za-z]:\\/.test(raw)) {
    raw = lineMatch[1];
    line = parseInt(lineMatch[2], 10);
  }
  if (!raw) return null;
  if (raw.indexOf("://") >= 0) return { skip: true, reason: "unknown-url", href: href, raw: raw };
  return { path: raw, line: line, href: href };
};
// issue-230 Search facets: add/remove a type from the selectedTypes array
// (keeps array-mutation logic out of the Checkbox onDidChange attribute).
window.__bramToggleType = function (types, t, on) {
  var set = Array.isArray(types) ? types.slice() : [];
  if (on) {
    if (set.indexOf(t) < 0) set.push(t);
  } else {
    set = set.filter(function (x) { return x !== t; });
  }
  return set;
};
// issue-230: measure the session-transcript render cost. Called on /__turns
// load; a double-rAF waits through any synchronous render freeze, then logs the
// paint delta + turn count as a `search-render` trace line (persistent, so we
// always see render-to-paint vs. turn count).
window.__bramMeasureTurnsRender = function (count) {
  var now = function () {
    return window.performance && performance.now ? performance.now() : Date.now();
  };
  var t0 = now();
  var raf = window.requestAnimationFrame || function (f) { return setTimeout(f, 16); };
  raf(function () {
    raf(function () {
      try {
        window.__bramIframeTrace("search-render", {
          op: "turns",
          turns: count,
          ms: Math.round(now() - t0),
        });
      } catch (e) {}
    });
  });
};
// search-list-render-forensics: the Search result List runs in outside-scroll
// mode, so a nonempty data prop can coexist with a stale/empty virtualized
// range. Keep this probe deliberately cheap and only call it from Search.
// `range` is the List's first-class visible-range event; the optional ref is
// useful for the data-change receipt before that event fires. The DOM count
// is a fallback signal for whether any virtualized rows actually materialized.
window.__bramTraceSearchList = function (op, hits, range, listRef) {
  try {
    var r = range || (listRef && listRef.getVisibleRange ? listRef.getVisibleRange() : null);
    var rows = 0;
    if (typeof document !== "undefined") {
      rows = document.querySelectorAll("[data-index]").length;
    }
    var root = document && (document.scrollingElement || document.documentElement);
    window.__bramIframeTrace("search-render", {
      op: op || "unknown",
      hits: Array.isArray(hits) ? hits.length : -1,
      visibleStart: r && typeof r.startIndex === "number" ? r.startIndex : -1,
      visibleEnd: r && typeof r.endIndex === "number" ? r.endIndex : -1,
      domRows: rows,
      scrollTop: root ? Math.round(root.scrollTop || 0) : -1,
      viewportHeight: root ? root.clientHeight : -1,
    });
  } catch (e) { /* diagnostics must never affect rendering */ }
};
window.__bramOpenLocalLinkPreview = function (request) {
  if (!request || !request.path) return;
  var qs = "path=" + encodeURIComponent(request.path);
  if (request.line) qs += "&line=" + encodeURIComponent(String(request.line));
  // history-file-links-local-at-commit: with a sha the host serves the file as
  // that commit had it (`git show <sha>:<path>`) instead of the working tree.
  // A History entry records what happened, so the working copy answers a
  // different question — wrongly, whenever the file changed since, which is
  // exactly when history is being read.
  if (request.sha) qs += "&sha=" + encodeURIComponent(String(request.sha));
  window.__bramSetLocalLinkPreview({
    ok: true,
    href: request.href || request.path,
    displayPath: request.path,
    title: "Loading file...",
    content: "",
    renderMode: "loading",
    at: Date.now(),
  });
  try {
    window.__bramIframeTrace("local-link-preview", {
      stage: "fetch",
      href: request.href || "",
      path: request.path || "",
      line: request.line || null,
    });
  } catch (e) {}
  window.fetch("/__local-file-preview?" + qs, { cache: "no-store" })
    .then(function (r) { return r.json(); })
    .then(function (payload) {
      payload = payload || {};
      payload.href = request.href || request.path;
      payload.at = Date.now();
      try {
        window.__bramIframeTrace("local-link-preview", {
          stage: "response",
          ok: !!payload.ok,
          href: request.href || "",
          path: payload.path || request.path || "",
          displayPath: payload.displayPath || "",
          renderMode: payload.renderMode || "",
          error: payload.error || "",
        });
      } catch (e) {}
      window.__bramSetLocalLinkPreview(payload);
    })
    .catch(function (e) {
      try {
        window.__bramIframeTrace("local-link-preview", {
          stage: "fetch-error",
          href: request.href || "",
          path: request.path || "",
          error: String(e && e.message || e),
        });
      } catch (traceErr) {}
      window.__bramShowLinkPreviewError(request.href || request.path, String(e && e.message || e));
    });
};

// External-driven talk-session-change bridge. Emits an event with
// the correlation id and host timestamp on each talk-session
// rotation.
window.bramSubscribeTalkSessionChange = (function () {
  var factory;
  return function () {
    if (factory) return factory;
    var subscribers = new Set();
    var lastEvent = null;
    var notify = function () {
      subscribers.forEach(function (fn) {
        try { fn(); } catch (e) { console.error("[bramSubscribeTalkSessionChange] subscriber threw:", e); }
      });
    };
    window.subscribeTalkSessionChange(
      "__bramTalkSessionExternalUnsub",
      function (correlationId, atHostMs) {
        lastEvent = {
          correlationId: correlationId || "",
          atHostMs: atHostMs || 0,
          at: Date.now(),
        };
        notify();
      }
    );
    factory = function (emit) {
      var fire = function () { emit(lastEvent); };
      subscribers.add(fire);
      fire();
      return function () { subscribers.delete(fire); };
    };
    return factory;
  };
})();

// Generic External-driven Tauri event factory. Memoizes per event
// name. Emits { tick, payload } on each fire — tick strictly
// increments to guarantee identity-change for listenTo expressions;
// payload carries the event data for consumers that need it.
window.bramSubscribeTauriEvent = (function () {
  var byEvent = Object.create(null);
  return function (eventName, replayLatestEvent) {
    var shouldReplayLatest = replayLatestEvent !== false;
    var cacheKey = eventName + (shouldReplayLatest ? "::replay" : "::live");
    if (byEvent[cacheKey]) return byEvent[cacheKey];
    var subscribers = new Set();
    var tick = 0;
    var lastPayload = null;
    window.subscribeTauriEvent(
      "__bramTauriExternal_" + eventName + (shouldReplayLatest ? "_replay" : "_live"),
      eventName,
      function (e) {
        tick += 1;
        lastPayload = (e && e.payload) || null;
        var snapshot = { tick: tick, payload: lastPayload };
        subscribers.forEach(function (fn) {
          try { fn(snapshot); } catch (err) {
            console.error("[bramSubscribeTauriEvent] subscriber threw:", err);
          }
        });
      },
      shouldReplayLatest
    );
    var replayLatest = function () {
      if (typeof window.fetch !== "function") return;
      window.fetch("/__event/latest?name=" + encodeURIComponent(eventName), { cache: "no-store" })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          if (!data || !data.exists) return;
          tick += 1;
          lastPayload = data.payload || null;
          var snapshot = { tick: tick, payload: lastPayload, replayed: true };
          subscribers.forEach(function (fn) {
            try { fn(snapshot); } catch (err) {
              console.error("[bramSubscribeTauriEvent] replay subscriber threw:", err);
            }
          });
        })
        .catch(function () {});
    };
    var factory = function (emit) {
      var fire = function (snapshot) {
        emit(snapshot || { tick: tick, payload: lastPayload });
      };
      subscribers.add(fire);
      if (shouldReplayLatest) fire();
      if (shouldReplayLatest) replayLatest();
      return function () { subscribers.delete(fire); };
    };
    byEvent[cacheKey] = factory;
    return factory;
  };
})();

// A live-only PushSource still causes ChangeListener to evaluate its initial
// null state as tick 0. Treat only a real host event (positive tick, not a
// replay snapshot) as invalidation, then refetch each supplied DataSource.
window.__bramRefetchOnLiveEvent = function (eventValue) {
  if (!eventValue || !eventValue.tick || eventValue.replayed) return false;
  for (var i = 1; i < arguments.length; i++) {
    var source = arguments[i];
    if (source && typeof source.refetch === "function") source.refetch();
  }
  return true;
};

// External-driven AgentMenu bridge — emits the current pending menu
// when either Tauri event fires. Subscribes lazily on first call so
// the native subscribers above (registered at module load) are
// guaranteed to fire FIRST and update window.bramAgentMenu before
// compute() reads it.
window.bramSubscribeAgentMenu = (function () {
  var factory;
  return function () {
    if (factory) return factory;
    var lastTurnState = null;
    var subscribers = new Set();
    var compute = function () {
      var current = window.bramAgentMenu || null;
      var suppress = window.bramAgentMenuSuppressFallback !== false;
      return current ||
        (!suppress && lastTurnState && lastTurnState.pendingMenu) ||
        null;
    };
    var notify = function () {
      subscribers.forEach(function (fn) {
        try { fn(); } catch (e) { console.error("[bramSubscribeAgentMenu] subscriber threw:", e); }
      });
    };
    window.subscribeTauriEvent(
      "__bramAgentMenuExternalTurnUnsub",
      "turn-state-changed",
      function (e) { lastTurnState = (e && e.payload) || null; notify(); }
    );
    window.subscribeTauriEvent(
      "__bramAgentMenuExternalPtyUnsub",
      "pty-menu-changed",
      notify
    );
    factory = function (emit) {
      var fire = function () { emit(compute()); };
      subscribers.add(fire);
      fire();
      return function () { subscribers.delete(fire); };
    };
    return factory;
  };
})();

// (issue-214 candidate #5: the shared raw-JSONL cache, its startup
// gating, and bramSubscribeLatestJsonl were retired here — no consumer
// remained. talk-session-changed is now a slim change-signal tick; see
// startBramLatestJsonlPush below.)

// --- Projected turns (single host projection; docs/turn-transport-redesign.md)
// Turn-display surfaces bound to the LIVE session consume /__turns through
// this pipeline instead of parsing raw JSONL. talk-session-changed is the
// CHANGE SIGNAL: each tick coalesces into one projection refetch. Turn
// objects are reference-preserved across fetches
// so XMLUI lists don't re-mount unchanged rows.
var __projectedTurnsValue = null; // { sid, provider, turns } | null
var __projectedTurnsSubscribers = [];
var __projectedTurnsTimer = null;
var __projectedTurnsSeq = 0;
var __projectedTurnsRevision = 0;

window.getProjectedTurns = function () { return __projectedTurnsValue; };
window.onProjectedTurnsChange = function (fn) {
  if (typeof fn !== "function") return function () {};
  __projectedTurnsSubscribers.push(fn);
  return function () {
    var idx = __projectedTurnsSubscribers.indexOf(fn);
    if (idx >= 0) __projectedTurnsSubscribers.splice(idx, 1);
  };
};

// Loose per-turn equality for reference preservation. Includes result
// value + error/layout flags because tool results stream onto entries that
// otherwise look unchanged.
window.__bramProjectedTurnEqual = function (a, b) {
  if (!a || !b) return false;
  if (a.role !== b.role || a.text !== b.text) return false;
  var ae = a.entries || [], be = b.entries || [];
  if (ae.length !== be.length) return false;
  var ai = a.images || [], bi = b.images || [];
  if (ai.length !== bi.length) return false;
  for (var i = 0; i < ae.length; i++) {
    var x = ae[i] || {}, y = be[i] || {};
    if (x.kind !== y.kind) return false;
    if (x.kind === "tool") {
      if (
        x.id !== y.id ||
        x.name !== y.name ||
        x.summary !== y.summary ||
        x.commandDisplay !== y.commandDisplay ||
        x.commandMarkdown !== y.commandMarkdown ||
        // description participates: the ai-describe overlay changes ONLY
        // this field, and an "equal" verdict would reuse the stale turn
        // reference and silently drop the new header (2026-07-08 "no
        // description line appeared").
        (x.description || "") !== (y.description || "") ||
        // aiDescription participates for the same reason description does:
        // the eager/expand describe patch changes ONLY this field, and an
        // equality check that ignores it discards the splice on rebroadcast
        // (2026-07-22, the second field-whitelist bite in one day).
        (x.aiDescription || "") !== (y.aiDescription || "") ||
        // menuAnswer participates for the same reason: the menu-answer
        // overlay changes ONLY this field on an otherwise-unchanged turn.
        (x.menuAnswer || "") !== (y.menuAnswer || "") ||
        x.result !== y.result ||
        !!x.isError !== !!y.isError ||
        !!x.resultStructured !== !!y.resultStructured
      ) return false;
      if ((x.agentId || "") !== (y.agentId || "")) return false;
    } else if (x.text !== y.text) {
      return false;
    }
  }
  return true;
};

// native-intent-for-read-edit-rows: shape a narration sentence for row
// display — the LAST sentence of the prose, end-capped with a trailing
// ellipsis (the probe's front-truncation artifact, "…se two things", is
// exactly what this forbids), and a minimum-length guard so bare "Now:"
// fragments fall back to the mechanical summary.
// The collapsed row's intent chain: Haiku's header when resolved, else the
// agent-authored description (Bash/Task), else the preceding narration
// (annotated below), else empty — the caller falls back to the mechanical
// summary.
window.__bramRowIntent = function (item) {
  if (!item) return "";
  return item.aiDescription || item.description || item.precedingIntent || "";
};

window.__bramShapePrecedingIntent = function (prose) {
  if (!prose) return "";
  var flat = String(prose).replace(/\s+/g, " ").trim();
  if (!flat) return "";
  var m = flat.match(/[^.!?]*[.!?:]?\s*$/);
  var tail = ((m && m[0]) || flat).trim();
  if (!tail) tail = flat;
  if (tail.length > 90) tail = tail.slice(0, 89).trim() + "…";
  if (tail.length < 12) return "";
  return tail;
};

// native-intent-for-read-edit-rows: annotate tool entries that carry no
// agent-authored description (Read/Edit/Write/Grep — only Bash and Task
// have the param) with the narration immediately preceding them, so the
// native tier stops alternating between intent and bare filenames. Probe
// receipts (2026-09-06, this session's projection: 293 such rows, 84%
// gain a line) shaped the three guards:
// - AGENT text entries only — the describe pipeline's user-turn fallback
//   presented the user's own words as agent intent (circular on
//   @-mention reads), so a user turn resets the narration instead;
// - first row of a consecutive same-narration group only — three Reads
//   under one sentence each captioned identically read as noise;
// - sentence shaping via __bramShapePrecedingIntent above.
// Runs once per broadcast, before reference preservation; the field is
// derived deterministically from turn content, so a reused prior turn
// reference already carries it.
window.__bramAnnotatePrecedingIntent = function (turns) {
  var list = turns || [];
  for (var i = 0; i < list.length; i++) {
    var t = list[i] || {};
    if (t.role !== "assistant") continue;
    var lastProse = "";
    var lastApplied = "";
    var es = t.entries || [];
    for (var k = 0; k < es.length; k++) {
      var e = es[k];
      if (!e) continue;
      if (e.kind === "text" && e.text) {
        lastProse = e.text;
        lastApplied = "";
        continue;
      }
      if (e.kind !== "tool") continue;
      if (e.description) continue; // native intent exists; group continues
      var shaped = window.__bramShapePrecedingIntent(lastProse);
      e.precedingIntent = shaped && shaped !== lastApplied ? shaped : "";
      if (e.precedingIntent) lastApplied = shaped;
    }
  }
  return list;
};

window.__bramBroadcastProjectedTurns = function (payload, reason) {
  var __bcastT0 = Date.now();
  if (payload && payload.turns) window.__bramAnnotatePrecedingIntent(payload.turns);
  var prev = __projectedTurnsValue;
  if (payload && prev && prev.sid === payload.sid) {
    var prevTurns = prev.turns || [];
    var nextTurns = payload.turns || [];
    var limit = Math.min(prevTurns.length, nextTurns.length);
    for (var i = 0; i < limit; i++) {
      if (window.__bramProjectedTurnEqual(prevTurns[i], nextTurns[i])) {
        nextTurns[i] = prevTurns[i];
      }
    }
  }
  payload.revision = ++__projectedTurnsRevision;
  __projectedTurnsValue = payload;
  var n = __projectedTurnsSubscribers.length;
  for (var j = 0; j < n; j++) {
    try { __projectedTurnsSubscribers[j](payload); } catch (e) {}
  }
  __bramEagerDescribe(payload);
  // projection-broadcast-attribution (round 2 of the boot-latency work):
  // every broadcast names its trigger, the active route, and its cost —
  // sync ms here, render settle via double-rAF. The 2026-07-30 finding
  // that motivated this: ~195ms settles on #/worklist, a page that
  // renders no transcript rows (Workspace subscribes to the projection).
  try {
    var __bcastRoute = "";
    try { __bcastRoute = String(location.hash || ""); } catch (eR) { /* ignore */ }
    var __bcastTurns = (payload && payload.turns && payload.turns.length) || 0;
    var __bcastReason = reason || "unknown";
    window.__bramIframeTrace("projection-broadcast", {
      reason: __bcastReason,
      route: __bcastRoute,
      subscribers: window.__bramProjectionEmitCount || 0,
      turns: __bcastTurns,
      ms: Date.now() - __bcastT0,
      tail_emits: window.__bramProjectionTailEmits || 0,
      tail_skips: window.__bramProjectionTailSkips || 0,
    });
    var __bcastSettleT0 = Date.now();
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        try {
          window.__bramIframeTrace("projection-broadcast", {
            stage: "settle",
            reason: __bcastReason,
            route: __bcastRoute,
            turns: __bcastTurns,
            settleMs: Date.now() - __bcastSettleT0,
          });
        } catch (eS) { /* ignore */ }
      });
    });
  } catch (eB) { /* ignore */ }
};

// promote-tool-descriptions-to-row (eager): request descriptions only as
// genuinely new command-bearing rows ARRIVE. The first projection for a
// session is the historical baseline: cached descriptions render through
// the host overlay, but uncached history is left for manual expand. This
// prevents a Bram restart or an old-session open from replaying the whole
// transcript through Haiku. Subsequent rows retain the existing visibility
// ordering, bounded concurrency, typing hold, and per-id dedupe.
var __bramDescribeQueue = [];
var __bramDescribeBaseline = { stream: "", initialized: false, complete: false, seen: {} };
// subagent-transcript-describe: the chip-selected subagent view keeps
// its own queue so main-session rotation cannot drop subagent entries.
// The pump drains main first (visibility-ordered), then subagent. Delivery
// for subagent entries is a refetch of the subagent DataSource (the
// host injects cached descriptions via apply_describe_overlay), fired
// from the flush when it completes ids this view requested.
var __bramSubagentDescribeQueue = [];
var __bramSubagentDescribeIds = {};
var __bramSubagentDescribeBaselines = {};
var __bramSubagentDescribeRefetch = null;
var __bramDescribeInFlight = 0;
var __BRAM_DESCRIBE_CONCURRENCY = 3;
// The List is virtualized: only near-viewport rows exist in the DOM,
// so mounted rows (virtua data-index wrappers) ARE the visibility
// signal. Re-partition on every pump — scrolling re-prioritizes a
// draining queue with no extra listeners.
// Primary signal: the List's visibleRangeDidChange event (first-class API,
// added upstream in xmlui feat/list-visible-range). The [data-index] DOM
// scrape remains as fallback for the window before the first event lands.
window.__bramSetVisibleRange = function (range) {
  window.__bramVisibleRange = range || null;
  try { __bramPumpDescribeQueue(); } catch (e) {}
};
function __bramVisibleToolIds() {
  var ids = {};
  try {
    var evs = window.__bramLastTranscriptEvents || [];
    var r = window.__bramVisibleRange;
    if (r && r.startIndex >= 0) {
      for (var j = r.startIndex; j <= r.endIndex && j < evs.length; j++) {
        var ev = evs[j];
        if (ev && ev.kind === "tool" && ev.id) ids[ev.id] = true;
      }
      return ids;
    }
    var nodes = document.querySelectorAll("[data-index]");
    for (var i = 0; i < nodes.length; i++) {
      var idx = parseInt(nodes[i].getAttribute("data-index"), 10);
      var e = evs[idx];
      if (e && e.kind === "tool" && e.id) ids[e.id] = true;
    }
  } catch (e) {}
  return ids;
}
function __bramPumpDescribeQueue() {
  // eager-describe-scan-instrumentation: bracket the visibility work.
  // On non-Transcript pages the visible-range signal is absent and
  // __bramVisibleToolIds falls back to a [data-index] DOM scrape — a
  // layout query that also rides the 1.5s drain interval. `via` names
  // which path ran; emitted only when the queue had work, so
  // steady-state noise is zero.
  var __pumpT0 = Date.now();
  var __pumpVia = "";
  var __pumpVisible = 0;
  try {
    if (__bramDescribeQueue.length || __bramSubagentDescribeQueue.length) {
      __pumpVia = (window.__bramVisibleRange && window.__bramVisibleRange.startIndex >= 0)
        ? "range" : "dom-scrape";
    }
    var vis = __bramVisibleToolIds();
    try { __pumpVisible = Object.keys(vis).length; } catch (eV) { /* ignore */ }
    if (__bramDescribeQueue.length > 1) {
      var front = [], rest = [];
      for (var qi = 0; qi < __bramDescribeQueue.length; qi++) {
        (vis[__bramDescribeQueue[qi].id] ? front : rest).push(__bramDescribeQueue[qi]);
      }
      __bramDescribeQueue = front.concat(rest);
    }
  } catch (e) {}
  if (__pumpVia) {
    try {
      var __pumpRoute = "";
      try { __pumpRoute = String(location.hash || ""); } catch (eR) { /* ignore */ }
      window.__bramIframeTrace("describe-scan", {
        op: "pump",
        ms: Date.now() - __pumpT0,
        via: __pumpVia,
        visible: __pumpVisible,
        queue: __bramDescribeQueue.length,
        subQueue: __bramSubagentDescribeQueue.length,
        route: __pumpRoute,
      });
    } catch (eT) { /* ignore */ }
  }
  while (__bramDescribeInFlight < __BRAM_DESCRIBE_CONCURRENCY &&
         (__bramDescribeQueue.length || __bramSubagentDescribeQueue.length)) {
    var e = __bramDescribeQueue.length
      ? __bramDescribeQueue.shift()
      : __bramSubagentDescribeQueue.shift();
    if (!e || !e.id || window.__bramDescribeRequested[e.id]) continue;
    __bramDescribeInFlight++;
    window.__bramRequestCommandDescription(e, function () {
      __bramDescribeInFlight--;
      __bramPumpDescribeQueue();
    });
  }
}
setInterval(function () {
  if ((__bramDescribeQueue.length || __bramSubagentDescribeQueue.length) &&
      !window.__bramDescribeUnavailable) {
    __bramPumpDescribeQueue();
  }
}, 1500);

// Return describable rows that appeared after this stream's historical
// frontier. Main projections can initially be a latest=N suffix; until a
// windowStart=0 payload arrives, every newly revealed id is still baseline.
// Rows without material remain unseen so a streaming update can make them
// eligible later. The helper is exported for focused regression tests.
window.__bramCollectNewDescribeRows = function (payload, state, stream) {
  var turns = (payload && payload.turns) || [];
  var reset = !state.initialized || state.stream !== stream;
  if (reset) {
    state.stream = stream;
    state.initialized = true;
    state.complete = false;
    state.seen = {};
  }
  var baseline = reset || !state.complete;
  var queue = [];
  var entriesSeen = 0;
  for (var i = turns.length - 1; i >= 0; i--) {
    var entries = (turns[i] && turns[i].entries) || [];
    for (var k = entries.length - 1; k >= 0; k--) {
      entriesSeen++;
      var e = entries[k];
      if (!e || e.kind !== "tool" || !e.id) continue;
      if (state.seen[e.id]) continue;
      if (baseline || e.aiDescription) {
        state.seen[e.id] = true;
        continue;
      }
      if (!window.__bramDescribeMaterial(e)) continue;
      state.seen[e.id] = true;
      if (!window.__bramDescribeRequested[e.id]) queue.push(e);
    }
  }
  // Subagent payloads and older hosts omit windowStart because they always
  // carry the full transcript. Main windowed payloads complete the frontier
  // only when the prefix has arrived.
  if (!payload || typeof payload.windowStart !== "number" || payload.windowStart === 0) {
    state.complete = true;
  }
  return { queue: queue, reset: reset, baseline: baseline, entries: entriesSeen };
};

// A transient request failure must reopen the frontier entry so the next
// projection can queue it again. Persistent failures stay seen and rely on
// manual expand, matching the unavailable latch's existing contract.
window.__bramForgetDescribeSeen = function (id) {
  if (!id) return;
  try { delete __bramDescribeBaseline.seen[id]; } catch (e) {}
  try {
    var streams = Object.keys(__bramSubagentDescribeBaselines);
    for (var i = 0; i < streams.length; i++) {
      delete __bramSubagentDescribeBaselines[streams[i]].seen[id];
    }
  } catch (e) {}
};

function __bramEagerDescribe(payload) {
  try {
    if (window.__bramDescribeUnavailable) return;
    if (!payload || !payload.turns) return;
    if (window.location.pathname.indexOf("/tools/") === -1) return;
    // The scan still walks the projection to recognize unseen ids, but only
    // post-frontier rows can enter the API queue. op=scan exposes whether a
    // payload was baseline and how many genuinely new rows it added.
    var __scanT0 = Date.now();
    var turns = payload.turns;
    var collected = window.__bramCollectNewDescribeRows(
      payload,
      __bramDescribeBaseline,
      String(payload.sid || "")
    );
    if (collected.reset) __bramDescribeQueue = [];
    if (collected.queue.length) {
      __bramDescribeQueue = __bramDescribeQueue.concat(collected.queue);
    }
    try {
      var __scanRoute = "";
      try { __scanRoute = String(location.hash || ""); } catch (eR) { /* ignore */ }
      window.__bramIframeTrace("describe-scan", {
        op: "scan",
        ms: Date.now() - __scanT0,
        turns: turns.length,
        entries: collected.entries,
        queued: collected.queue.length,
        baseline: collected.baseline ? 1 : 0,
        route: __scanRoute,
      });
    } catch (eT) { /* ignore */ }
    __bramPumpDescribeQueue();
  } catch (err) {}
}

// subagent-transcript-describe: each sid/agent stream gets the same first-view
// historical frontier. Queues are retained across chip switches so a row
// already classified as new cannot be dropped before the pump requests it.
// The refetch thunk is how a completed description reaches the active view.
window.__bramEagerDescribeSubagent = function (payload, refetch) {
  try {
    if (window.__bramDescribeUnavailable) return;
    if (!payload || !payload.turns) return;
    if (window.location.pathname.indexOf("/tools/") === -1) return;
    if (typeof refetch === "function") __bramSubagentDescribeRefetch = refetch;
    var __subScanT0 = Date.now();
    var turns = payload.turns;
    var stream = String(payload.sid || "") + "\u0001" + String(payload.agentId || "");
    var state = __bramSubagentDescribeBaselines[stream];
    if (!state) {
      state = { stream: stream, initialized: false, complete: false, seen: {} };
      __bramSubagentDescribeBaselines[stream] = state;
    }
    var collected = window.__bramCollectNewDescribeRows(payload, state, stream);
    if (collected.queue.length) {
      __bramSubagentDescribeQueue = __bramSubagentDescribeQueue.concat(collected.queue);
    }
    for (var q = 0; q < collected.queue.length; q++) {
      __bramSubagentDescribeIds[collected.queue[q].id] = true;
    }
    try {
      window.__bramIframeTrace("describe-scan", {
        op: "scan-subagent",
        agentId: String(payload.agentId || ""),
        ms: Date.now() - __subScanT0,
        turns: turns.length,
        entries: collected.entries,
        queued: collected.queue.length,
        baseline: collected.baseline ? 1 : 0,
      });
    } catch (eT) { /* ignore */ }
    __bramPumpDescribeQueue();
  } catch (err) {}
};

// Splice a latest=N window onto the accumulated full projection
// (bound-turns-projection-and-gate-edit-hints). Returns null when the
// window cannot be aligned — sid change (rotation), total shrink
// (compaction), or a gap (more than N new turns since the last fetch)
// — and the caller falls back to a full fetch. Prefix turns are reused
// by reference, so the broadcast's index-wise reference preservation
// keeps unchanged rows mounted for free.
window.__bramMergeProjectedTurnsWindow = function (prev, payload) {
  if (!prev || !payload) return null;
  if (!payload.sid || payload.sid !== prev.sid) return null;
  var ws = payload.windowStart;
  var total = payload.total;
  if (typeof ws !== "number" || typeof total !== "number") return null;
  var prevTurns = prev.turns || [];
  if (ws > prevTurns.length) return null;
  if (total < prevTurns.length) return null;
  var turns = prevTurns.slice(0, ws).concat(payload.turns || []);
  if (turns.length !== total) return null;
  return { sid: payload.sid, provider: payload.provider, turns: turns };
};

// ai-describe delivery: patch the described entry into the accumulated
// projection directly and re-broadcast. A refetch cannot deliver it —
// tick refetches are windowed (latest=8) and an expanded row usually
// sits OUTSIDE that window, so the merge keeps the stale entry
// (2026-07-08 "no description line appeared"); it's also ~1s of wasted
// projection work on multi-MB codex sessions. The describe response
// already carries the description, so this is a pure client-side splice:
// clone the turn/entry (never mutate — the broadcast's reference
// preservation depends on prev staying pristine) and re-push.
// describe-rebroadcast-coalesce (perf audit 2026-07-22): completions are
// ENQUEUED and flushed in one rebroadcast per ~400ms window, not one per
// result. The full-backscroll eager describe made 524 calls on an 18MB /
// 1200-turn session, and a fan-out per completion (each subscriber re-runs
// the events adapter) degraded heartbeat drift to avg 277ms / max 4.1s and
// a tab-switch subscribe refetch to 3.1s. Cache-hit boots are denser still
// (no Haiku latency between completions), so per-result broadcasting gets
// WORSE after first backfill. setTimeout is fine here (helpers.js is real
// JS, outside the XMLUI expression engine).
var __describePendingPatches = {};
var __describeFlushArmed = false;
window.__bramPatchProjectedToolDescription = function (toolId, description) {
  if (!toolId || !description) return false;
  __describePendingPatches[toolId] = description;
  if (!__describeFlushArmed) {
    __describeFlushArmed = true;
    // Adaptive window (describe-backfill-pacing): 2s during backfill,
    // 400ms otherwise — the guarded call tolerates load order (the
    // window fn is defined later in this file; by first patch it exists).
    var win = 400;
    try {
      if (typeof window.__bramDescribeFlushWindowMs === "function") {
        win = window.__bramDescribeFlushWindowMs();
      }
    } catch (e) { /* ignore */ }
    setTimeout(function () { window.__bramFlushDescribePatches(); }, win);
  }
  return true;
};
window.__bramFlushDescribePatches = function () {
  __describeFlushArmed = false;
  var pending = __describePendingPatches;
  __describePendingPatches = {};
  var ids = Object.keys(pending);
  if (!ids.length) return;
  // subagent-transcript-describe: descriptions for subagent entries are
  // delivered host-side (apply_describe_overlay on /__turns?agent=...);
  // the client's job is one refetch per flush window. This must run
  // before the main-projection early returns below.
  try {
    var subMatched = 0;
    for (var si = 0; si < ids.length; si++) {
      if (__bramSubagentDescribeIds[ids[si]]) {
        subMatched++;
        delete __bramSubagentDescribeIds[ids[si]];
      }
    }
    if (subMatched && typeof __bramSubagentDescribeRefetch === "function") {
      try {
        window.__bramIframeTrace("describe-patch", {
          stage: "subagent-refetch",
          patches: subMatched,
        });
      } catch (subTraceErr) { /* ignore */ }
      __bramSubagentDescribeRefetch();
    }
  } catch (subErr) { /* ignore */ }
  var prev = __projectedTurnsValue;
  if (!prev || !prev.turns) return;
  var turns = prev.turns;
  var newTurns = null;
  var applied = 0;
  for (var i = 0; i < turns.length; i++) {
    var entries = (turns[i] && turns[i].entries) || [];
    var newEntries = null;
    for (var k = 0; k < entries.length; k++) {
      var e = entries[k];
      if (!e || e.kind !== "tool" || !e.id) continue;
      var desc = pending[e.id];
      if (!desc || (e.aiDescription || "") === desc) continue;
      // Clone, never mutate — the broadcast's per-turn reference
      // preservation depends on prev staying pristine.
      if (!newEntries) newEntries = entries.slice();
      newEntries[k] = Object.assign({}, e, { aiDescription: desc });
      applied++;
    }
    if (newEntries) {
      if (!newTurns) newTurns = turns.slice();
      newTurns[i] = Object.assign({}, turns[i], { entries: newEntries });
    }
  }
  if (!newTurns) return;
  // Observe-only bracket (describe-freeze lineage, 2026-07-11): begin rides
  // logToHost -> invoke so the host records the attempt even if the iframe
  // freezes inside the broadcast; a begin with no end names the culprit.
  // The bracket now measures the real unit of work: one flush of N patches.
  try {
    window.__bramIframeTrace("describe-patch", {
      stage: "begin",
      patches: applied,
      queued: ids.length,
      provider: prev.provider || "",
      turns: turns.length,
    });
  } catch (traceErr) { /* ignore */ }
  var __describePatchT0 = Date.now();
  window.__bramBroadcastProjectedTurns({
    sid: prev.sid,
    provider: prev.provider,
    turns: newTurns,
  }, "describe-flush");
  try {
    window.__bramIframeTrace("describe-patch", {
      stage: "end",
      patches: applied,
      provider: prev.provider || "",
      turns: turns.length,
      ms: Date.now() - __describePatchT0,
    });
  } catch (traceErr2) { /* ignore */ }
  // describe-backfill-observability: the sync end above shows ms:0-1 —
  // the real cost lands in the subscriber fan-out + React re-render after
  // the broadcast. Measure to the second next paint (menu-paint /
  // search-render pattern). Kept separate from the sync begin/end pair,
  // whose freeze-forensics contract must not move into rAF.
  try {
    var __describeSettleT0 = Date.now();
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        try {
          window.__bramIframeTrace("describe-patch", {
            stage: "settle",
            patches: applied,
            settleMs: Date.now() - __describeSettleT0,
            sinceBeginMs: Date.now() - __describePatchT0,
          });
        } catch (e) { /* ignore */ }
      });
    });
  } catch (settleErr) { /* ignore */ }
};

// Adaptive coalesce (2026-07-07 codex esc wedge): one full /__turns
// fetch+parse+broadcast of a long session costs real main-thread time
// (~1.3 s p50 observed on multi-MB sessions), so the window scales to
// the LAST observed cost (4x, floor 250 ms, cap 5 s). With the windowed
// tick below, steady-state fetches are small and the cadence stays at
// the 250 ms floor; the scaling still guards the full-fetch fallbacks.
var __projectedTurnsLastCostMs = 0;
// Tail-window size for tick refreshes. Streaming mutates only the
// in-flight turn (tool results appending) and appends new turns; 8
// covers both with margin. Worst-case tick payload is bounded by turn
// size, not session size.
var __projectedTurnsTickWindow = 8;
window.__bramRefetchProjectedTurns = function (reason, forceFull) {
  if (typeof window.fetch !== "function") return;
  if (__projectedTurnsTimer) return; // trailing-edge coalesce
  var delayMs = Math.max(250, Math.min(4 * __projectedTurnsLastCostMs, 5000));
  __projectedTurnsTimer = window.setTimeout(function () {
    __projectedTurnsTimer = null;
    var seq = ++__projectedTurnsSeq;
    var startedMs = Date.now();
    var prev = __projectedTurnsValue;
    // forceFull: the window-miss re-entry below must NOT re-window against the
    // stale prev — on a session rotation prev still holds the old (>window)
    // session, so a recomputed windowed=true would merge-miss forever. A full
    // fetch converges (rotation or gap).
    var windowed = !forceFull && !!(prev && prev.sid && prev.turns
      && prev.turns.length > __projectedTurnsTickWindow);
    var url = windowed
      ? "/__turns?latest=" + __projectedTurnsTickWindow
      : "/__turns";
    window.fetch(url, { cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(function (payload) {
        if (seq !== __projectedTurnsSeq) return; // superseded by a later fetch
        var next = windowed
          ? window.__bramMergeProjectedTurnsWindow(prev, payload)
          : payload;
        if (!next) {
          // Rotation/compaction/gap: re-enter for a full fetch (the
          // timer is clear, so this schedules normally). forceFull=true so
          // the re-entry ignores the stale prev and actually fetches full —
          // otherwise it re-windows against the old session and loops.
          window.__bramRefetchProjectedTurns((reason || "") + "-window-miss", true);
          return;
        }
        window.__bramBroadcastProjectedTurns(next, "refetch:" + (reason || ""));
        __projectedTurnsLastCostMs = Date.now() - startedMs;
        try {
          if (window.logToHost && !window.__bramMenuPending) {
            window.logToHost({
              kind: "iframe-trace",
              subkind: "projected-turns",
              at: new Date().toISOString(),
              reason: reason || "",
              windowed: windowed ? 1 : 0,
              sid: (next && next.sid) || "",
              turns: (next && next.turns && next.turns.length) || 0,
              ms: Date.now() - startedMs,
            });
          }
        } catch (e) {}
      })
      .catch(function () {});
  }, delayMs);
};

// External subscribe factory for projected turns. Same memoized-singleton
// shape as bramSubscribeLatestJsonl above.
window.bramSubscribeProjectedTurns = (function () {
  var factory;
  return function () {
    if (factory) return factory;
    var subscribers = new Set();
    var lastValue = window.getProjectedTurns();
    var notify = function () {
      // projection-broadcast-attribution: time each PushSource emit's sync
      // slice; >=50ms names a consumer directly. (React may defer the real
      // render — the broadcast's settleMs catches that half.)
      var idx = 0;
      subscribers.forEach(function (fn) {
        var __subT0 = Date.now();
        try { fn(); } catch (e) { console.error("[bramSubscribeProjectedTurns] subscriber threw:", e); }
        var __subMs = Date.now() - __subT0;
        if (__subMs >= 50) {
          try {
            window.__bramIframeTrace("projection-subscriber", {
              idx: idx, ms: __subMs, total: subscribers.size,
            });
          } catch (eT) { /* ignore */ }
        }
        idx++;
      });
      try { window.__bramProjectionEmitCount = subscribers.size; } catch (eC) { /* ignore */ }
    };
    window.onProjectedTurnsChange(function (v) { lastValue = v; notify(); });
    factory = function (emit) {
      var fire = function () { emit(lastValue); };
      subscribers.add(fire);
      fire();
      window.__bramRefetchProjectedTurns(lastValue == null ? "first-subscribe" : "subscribe");
      return function () { subscribers.delete(fire); };
    };
    return factory;
  };
})();

// workspace-tail-subscription (graduation of projection-broadcast-attribution
// c0e88c1): tail-only consumers subscribe here instead of to the full
// projection. The last exchange is computed ONCE per broadcast in plain JS
// and re-emitted ONLY when the fields tail consumers read change
// (lastAssistantText.text, lastExchange.userText/assistantText, image
// count). During a describe backfill — old rows gaining aiDescription —
// that is essentially never, so a tail consumer's reactive graph idles
// through the storm instead of re-evaluating per broadcast (the
// 153-310ms-per-settle #/worklist cost that produced 20 slow keystrokes
// vs the Transcript boot's 1). tail_emits/tail_skips ride the
// projection-broadcast trace line, so the fix reports through the same
// instrument that convicted the problem.
window.__bramProjectionTailEmits = 0;
window.__bramProjectionTailSkips = 0;
window.bramSubscribeProjectedLastExchange = (function () {
  var factory;
  return function () {
    if (factory) return factory;
    var subscribers = new Set();
    var lastKey = null;
    var lastValue = null;
    var keyOf = function (t) {
      if (!t) return "";
      var a = (t.lastAssistantText && t.lastAssistantText.text) || "";
      var ex = t.lastExchange || {};
      return a + "\u0000" + (ex.userText || "") + "\u0000" +
        (ex.assistantText || "") + "\u0000" + ((ex.userImages || []).length);
    };
    var recompute = function (v) {
      var next = window.__bramProjectedLastExchange(v);
      var k = keyOf(next);
      if (lastValue !== null && k === lastKey) {
        window.__bramProjectionTailSkips++;
        return;
      }
      lastKey = k;
      lastValue = next;
      window.__bramProjectionTailEmits++;
      subscribers.forEach(function (fn) {
        try { fn(); } catch (e) { console.error("[bramSubscribeProjectedLastExchange] subscriber threw:", e); }
      });
    };
    window.onProjectedTurnsChange(function (v) { recompute(v); });
    recompute(window.getProjectedTurns());
    factory = function (emit) {
      var fire = function () { emit(lastValue); };
      subscribers.add(fire);
      fire();
      // Preserve the full-projection factory's subscribe-refetch semantics:
      // on a Worklist-only boot this subscription is what pulls the first
      // projection (provider-start/talk-session ticks also trigger, but do
      // not depend on them).
      window.__bramRefetchProjectedTurns(
        window.getProjectedTurns() == null ? "tail-first-subscribe" : "tail-subscribe"
      );
      return function () { subscribers.delete(fire); };
    };
    return factory;
  };
})();

// issue-278 gate-row docking: the Worklist selection, published pane-wide.
//
// The gate row cannot be pinned where it lives. `StickySection stickTo="bottom"`
// is two CSS rules (`position: sticky; bottom: 0`) and sticky cannot escape its
// containing block, so wrapping a near-last child buys nothing. The `dock`
// pattern needs an explicit parent height and `scrollWholePage="false"`, and
// Bram scrolls the whole page - load-bearing for Transcript and Search.
//
// What Bram DOES have is a Footer that this App layout genuinely pins:
// `vertical-sticky` is documented as "the footer sticks to the bottom", and it
// demonstrably does - the status line and composer sit there on every screen.
// So the gate row moves to the one surface that already works, which needs the
// selection to be readable outside Worklist.xmlui.
//
// Same factory shape as bramSubscribeProjectedLastExchange: `emit` is called
// once on subscribe and on every change; the return value unsubscribes.
window.__bramW2Selection = [];
window.bramSubscribeW2Selection = (function () {
  var factory;
  return function () {
    if (factory) return factory;
    var subscribers = new Set();
    window.__bramW2SetSelection = function (ids) {
      var next = (ids || []).slice();
      var prev = window.__bramW2Selection || [];
      if (next.length === prev.length && next.every(function (v, i) { return v === prev[i]; })) {
        return;
      }
      window.__bramW2Selection = next;
      subscribers.forEach(function (fn) {
        try { fn(); } catch (e) { console.error("[bramSubscribeW2Selection] subscriber threw:", e); }
      });
    };
    factory = function (emit) {
      var fire = function () { emit((window.__bramW2Selection || []).slice()); };
      subscribers.add(fire);
      fire();
      return function () { subscribers.delete(fire); };
    };
    return factory;
  };
})();

// transcript-new-below-badge: pane-wide unseen-below counter. The echo guard
// made READING stable, which removed the yank's accidental "agent responded"
// signal; this counter feeds the footer status-line chip that replaces it on
// every tab. base = the turn count last seen at the transcript bottom;
// unseen = turns beyond it. Auto-bases while the Transcript sits mounted at
// the bottom (content you watched arrive is seen); any transition to
// FOLLOWING clears it explicitly and logs follow-state op=unseen-clear with
// the recruited count — how often the chip earned the click.
window.__bramUnseenCount = 0;
window.bramSubscribeTranscriptUnseen = (function () {
  var factory;
  var base = -1;
  var lastTotal = 0;
  var subscribers = new Set();
  function totalOf(v) { return (v && v.turns && v.turns.length) || 0; }
  function notify() {
    subscribers.forEach(function (fn) {
      try { fn(); } catch (e) { console.error("[bramSubscribeTranscriptUnseen] subscriber threw:", e); }
    });
  }
  var lastSid = null;
  function recompute(v) {
    // unseen-counter-seed-fix: pre-load null projections must not seed the
    // baseline (base=0 made the first real projection count all history as
    // unseen — the "1230 new" boot chip; archive receipts count=1233/1230).
    // Identity-aware re-base: a sid change (boot, /clear, session or
    // provider switch) adopts the new total — history is never "new";
    // only same-session growth counts as arrivals.
    if (!v) return;
    var sid = (v && v.sid) || "";
    lastTotal = totalOf(v);
    if (base < 0 || sid !== lastSid || lastTotal < base) {
      base = lastTotal;
      lastSid = sid;
    }
    // follow-state-source-of-truth hardening: "watched at the bottom"
    // requires the route to corroborate the mounted flag (a skipped
    // Transcript unmount cleanup — see the Lifecycle-violation console
    // errors — leaves the flag true from another tab, silently
    // swallowing arrivals), and reads the synchronous follow truth
    // instead of the stale-able visibleRange snapshot.
    var onTranscript = false;
    try { onTranscript = String(location.hash || "").indexOf("/transcript") >= 0; } catch (e) { /* ignore */ }
    var atBottomLive = onTranscript && window.__bramTranscriptMounted &&
      window.__bramFollowAtBottom !== false;
    if (atBottomLive) base = lastTotal;
    var next = Math.max(0, lastTotal - base);
    if (next !== window.__bramUnseenCount) {
      window.__bramUnseenCount = next;
      notify();
    }
  }
  window.__bramUnseenMarkSeen = function (cause) {
    base = lastTotal;
    var had = window.__bramUnseenCount;
    if (had > 0) {
      var route = "";
      try { route = String(location.hash || ""); } catch (e) { /* ignore */ }
      if (cause === "unseen-jump" && window.__bramUnseenJumpRoute) {
        route = window.__bramUnseenJumpRoute;
        window.__bramUnseenJumpRoute = "";
      }
      window.__bramIframeTrace("follow-state", {
        op: "unseen-clear", count: had, cause: cause || "", route: route,
      });
      window.__bramUnseenCount = 0;
      notify();
    }
  };
  window.onProjectedTurnsChange(function (v) { recompute(v); });
  recompute(window.getProjectedTurns());
  return function () {
    if (factory) return factory;
    factory = function (emit) {
      var fire = function () { emit(window.__bramUnseenCount); };
      subscribers.add(fire);
      fire();
      return function () { subscribers.delete(fire); };
    };
    return factory;
  };
})();
window.__bramUnseenValue = function () { return window.__bramUnseenCount || 0; };
// Transcript find clearing crosses from the app footer into the Transcript
// component. Publish a value through PushSource instead of retaining an XMLUI
// closure with component ids and xs state on window. The component observes
// the tick and owns both reactive-state and visible-input updates. Preserve a
// pending clear across navigation so a new-below jump can publish after the
// Transcript route mounts.
window.__bramTranscriptFindClearPending = false;
window.bramSubscribeTranscriptFindClear = (function () {
  var factory;
  var subscribers = new Set();
  var tick = 0;
  var currentEvent = null;

  var publish = function (cause) {
    currentEvent = { tick: ++tick, cause: cause || "" };
    subscribers.forEach(function (fn) {
      try { fn(); } catch (e) {
        console.error("[bramSubscribeTranscriptFindClear] subscriber threw:", e);
      }
    });
  };

  window.__bramClearTranscriptFind = function (cause) {
    var route = "";
    try { route = String(location.hash || ""); } catch (e) { /* ignore */ }
    var live = route.indexOf("/transcript") >= 0 &&
      window.__bramTranscriptMounted && subscribers.size > 0;
    if (!live) {
      window.__bramTranscriptFindClearPending = true;
      window.__bramIframeTrace("follow-state", {
        op: "find-clear", cause: cause || "", route: route, deferred: true,
      });
      return false;
    }
    window.__bramTranscriptFindClearPending = false;
    publish(cause);
    window.__bramIframeTrace("follow-state", {
      op: "find-clear", cause: cause || "", route: route, deferred: false,
    });
    return true;
  };

  window.__bramConsumeTranscriptFindClear = function () {
    if (!window.__bramTranscriptFindClearPending) return;
    setTimeout(function () {
      window.__bramClearTranscriptFind("pending-mount");
    }, 0);
  };

  return function () {
    if (factory) return factory;
    factory = function (emit) {
      var fire = function () { emit(currentEvent); };
      subscribers.add(fire);
      emit(null);
      return function () { subscribers.delete(fire); };
    };
    return factory;
  };
})();

// Chip click: on the Transcript, ride the registered footer-arrow-down
// closure (verified transition + bottom-promise). From any other tab, queue
// the find clear, clear the saved viewport state (the Main-chip precedent
// for forcing a follow-mount), and stamp a short-lived tag;
// __bramTranscriptMount turns the tag into a follow-state transition
// cause=unseen-jump. The markup pairs this call with
// navigate('/transcript'); same-route navigation is a no-op.
window.__bramUnseenJump = function () {
  var onTranscript = false;
  try { onTranscript = String(location.hash || "").indexOf("/transcript") >= 0; } catch (e) { /* ignore */ }
  window.__bramClearTranscriptFind("unseen-jump");
  if (onTranscript && window.__bramTranscriptMounted) {
    window.__bramTranscriptScroll("bottom");
    return;
  }
  window.__bramSetVisibleRange(null);
  window.__bramUnseenJumpAt = Date.now();
  // Recruiting route, so unseen-clear can report which tab the chip
  // converted (the clear itself fires after navigation lands).
  try { window.__bramUnseenJumpRoute = String(location.hash || ""); } catch (e) { /* ignore */ }
};

// transcript-scroll-gestures: the footer's transcript-only jump arrows live
// in Main.xmlui and cannot reach the Transcript component's transcriptList id
// directly, so the Transcript registers its scroll closures at mount. The
// closures capture xs scope (atBottom, transcriptList); this shim only stores
// and dispatches them. Mount-time re-registration overwrites stale closures
// from a prior mount, so no unregister step is needed.
// transcript-follow-contract (layer 1): instrumentation for the Transcript's
// follow/reading contract (the contract text lives in Transcript.xmlui's
// header comment). Transition logs every state flip with its cause; Verify
// measures every bottom-promise against the List's own layout (double-rAF,
// then the visibleRange the List itself reported) and logs a violation when
// the promise missed — the whack-a-mole lineage (9daa693 / f846258 /
// 6a892f6 / 652d9b3 / c4c14ed) becomes self-naming. Observe-only: neither
// helper changes scroll behavior. Caveat: a legitimate append arriving
// inside the verify window can log a violation that the next repin heals —
// violations are leads, not convictions; corroborate with the surrounding
// transition/repin lines.
// transcript-follow-echo-guard (layer 2, policy): programmatic scrolls and
// layout shifts echo scroll events that the onScroll classifier used to
// attribute to the user (layer-1 soak: ~every tool-expand phantom-re-armed
// FOLLOWING within 200-400ms; find-step and mount restores echoed too;
// 1,056 bottom-promises meanwhile landed with zero violations, so only the
// classification half changes). Every deliberate transition (non-user cause)
// opens a one-shot echo window; scroll events inside it are classified
// programmatic — logged op=echo-suppressed, never a state flip. Mount opens
// a longer window because virtua's initial layout echoes precede any
// transition. Cost, documented and accepted: a genuine user scroll within
// the window is deferred until the next scroll event.
window.__bramFollowEchoUntil = 0;
window.__bramFollowEchoCause = "";
window.__bramFollowEchoOpen = function (cause, ms) {
  try {
    window.__bramFollowEchoUntil = performance.now() + (ms || 700);
    window.__bramFollowEchoCause = cause || "";
  } catch (e) { /* ignore */ }
};
// Input corroboration: a scroll event is user intent only with user input
// beside it — wheel (macOS momentum keeps emitting wheel events, so flick
// coasts stay corroborated), keydown, or a recent/held pointer. Machine
// scrolls (virtua shift compensation, expanded-content growth, repins)
// have no input beside them at ANY latency — this is what the fixed echo
// window could not express: the first live soak caught a tool-expand echo
// re-arming FOLLOWING 2.7s after the expand, sailing past the 700ms
// window and pinning a reading user through a full streaming turn
// (2026-07-31 03:53:48). Listeners are passive+capture; pointer "held"
// covers long scrollbar drags where pointerdown ages past the window.
window.__bramLastUserInputMs = 0;
window.__bramPointerHeld = false;
(function () {
  function mark() { window.__bramLastUserInputMs = Date.now(); }
  try {
    window.addEventListener("wheel", mark, { passive: true, capture: true });
    window.addEventListener("keydown", mark, { passive: true, capture: true });
    window.addEventListener("pointerdown", function () {
      window.__bramPointerHeld = true; mark();
    }, { passive: true, capture: true });
    window.addEventListener("pointerup", function () {
      window.__bramPointerHeld = false; mark();
    }, { passive: true, capture: true });
    window.addEventListener("pointercancel", function () {
      window.__bramPointerHeld = false; mark();
    }, { passive: true, capture: true });
  } catch (e) { /* classifier falls back to echo windows alone */ }
})();
// follow-state-source-of-truth: consumers were reading stale copies of
// follow state — the repin ChangeListener fired 240ms into READING off a
// pre-assignment xs var (2026-08-01 04:40:01 live capture) and the verify
// layer couldn't see it (a misfired repin still lands, so it logs
// landed=True). window.__bramFollowAtBottom is written SYNCHRONOUSLY by
// the classifier and every deliberate transition; repins gate on it via
// __bramFollowRepinOk, which logs op=repin-blocked whenever the stale var
// would have misfired — the blind spot becomes a counter.
window.__bramFollowAtBottom = true;
window.__bramFollowReadingAtMs = 0;
window.__bramFollowRepinOk = function (varAtBottom, agentId) {
  var truth = window.__bramFollowAtBottom !== false;
  if (!truth && varAtBottom) {
    try {
      window.__bramIframeTrace("follow-state", {
        op: "repin-blocked", varAtBottom: !!varAtBottom,
        sinceReadingMs: window.__bramFollowReadingAtMs
          ? (Date.now() - window.__bramFollowReadingAtMs) : -1,
        agentId: agentId || "main",
      });
    } catch (e) { /* ignore */ }
  }
  return truth;
};
// A machine scroll that yanks the view off the bottom after a jump already
// landed is the failure the echo guard was never asked to fix.
//
// The guard's job is to stop a programmatic scroll from FLIPPING follow state,
// and it does that correctly. But suppressing the classification does nothing
// about the scroll, so the view moves and nothing re-checks. Across three weeks
// of trace archive this signature -- an uncorroborated suppression 84-1968ms
// after an explicit jump that verified landed=true -- appears 24 times, always
// after footer-arrow-down, about 10% of explicit jumps. That is the "sometimes
// it works" the operator has been reporting.
//
// The repair never acts on the classification alone. It measures: if the final
// row is rendered and its bottom now sits below the fold, the promise made at
// jump time is visibly broken, so re-issue it. If the row is still at the fold,
// the suppressed scroll was jitter and nothing happens -- so a fire in the
// trace is always a real, measured departure, and zero fires means the class
// stopped occurring rather than the instrument going quiet.
//
// Bounded at 3 per rolling 3s: the repair scrolls, which produces more scroll
// events, which re-enter here.
window.__bramFollowRepinBudget = [];
window.__bramFollowEchoRepin = function (agentId) {
  try {
    var listRef = window.__bramJumpListRef;
    if (!listRef || !listRef.scrollToBottom) return false;
    var total = window.__bramFollowLastTotal || 0;
    var probe = __bramLastRowProbe(total);
    if (!probe.lastRowRendered || probe.lastRowGap <= 4) return false;
    var now = performance.now();
    var budget = (window.__bramFollowRepinBudget || []).filter(function (t) {
      return (now - t) < 3000;
    });
    if (budget.length >= 3) {
      window.__bramFollowRepinBudget = budget;
      window.__bramIframeTrace("follow-state", {
        op: "echo-repin-capped", gap: probe.lastRowGap,
        total: total, agentId: agentId || "main",
      });
      return false;
    }
    budget.push(now);
    window.__bramFollowRepinBudget = budget;
    window.__bramIframeTrace("follow-state", {
      op: "echo-repin", gap: probe.lastRowGap, attempt: budget.length,
      maxRenderedIndex: probe.maxRenderedIndex, total: total,
      agentId: agentId || "main",
    });
    window.__bramBottomJumpRetry(listRef, "echo-repin", agentId, total);
    return true;
  } catch (e) { return false; }
};
window.__bramFollowClassify = function (cur, atEnd, agentId) {
  try {
    var suppress = "";
    if (performance.now() < (window.__bramFollowEchoUntil || 0)) {
      suppress = window.__bramFollowEchoCause || "echo-window";
    } else if (!window.__bramPointerHeld &&
               (Date.now() - (window.__bramLastUserInputMs || 0)) > 400) {
      suppress = "uncorroborated";
    }
    if (suppress) {
      if (cur !== atEnd) {
        var sp = __bramLastRowProbe(window.__bramFollowLastTotal || 0);
        window.__bramIframeTrace("follow-state", {
          op: "echo-suppressed", to: !!atEnd, cause: suppress,
          inputAgeMs: window.__bramLastUserInputMs
            ? (Date.now() - window.__bramLastUserInputMs) : -1,
          lastRowRendered: sp.lastRowRendered, lastRowGap: sp.lastRowGap,
          agentId: agentId || "main",
        });
        // Following, and something not-the-user moved us off the bottom.
        if (cur === true && atEnd === false) {
          window.__bramFollowEchoRepin(agentId);
        }
      }
      window.__bramFollowAtBottom = cur !== false;
      return cur;
    }
    if (cur !== atEnd) {
      window.__bramFollowTransition(atEnd,
        atEnd ? "user-scroll-bottom" : "user-scroll-up", agentId);
    } else {
      window.__bramFollowAtBottom = atEnd !== false;
    }
  } catch (e) { /* ignore */ }
  return atEnd;
};
window.__bramFollowTransition = function (to, cause, agentId) {
  try {
    var c = String(cause || "");
    window.__bramFollowAtBottom = !!to;
    if (!to) window.__bramFollowReadingAtMs = Date.now();
    if (c.indexOf("user-scroll") !== 0) window.__bramFollowEchoOpen(c);
    if (to && window.__bramUnseenMarkSeen) window.__bramUnseenMarkSeen(c);
    var route = "";
    try { route = String(location.hash || ""); } catch (e2) { /* ignore */ }
    window.__bramIframeTrace("follow-state", {
      op: "transition", to: !!to, cause: c, route: route,
      agentId: agentId || "main",
    });
  } catch (e) { /* ignore */ }
  return to;
};
function __bramIsScrollable(el) {
  try {
    if (!el || el.scrollHeight <= el.clientHeight + 1) return false;
    var ov = window.getComputedStyle(el).overflowY || "";
    return ov === "auto" || ov === "scroll";
  } catch (e) { return false; }
}

// The transcript List's virtua scroller.
//
// SCOPED to [data-testid="transcript-list"], and that scoping is the whole
// point. The first version walked up from `document.querySelector("[data-index]")`
// — the first virtualized row ANYWHERE in the document. Search results, the
// message queue and the transcript all render Lists with [data-index] rows, so
// when a previously-visited tab was still mounted the check measured THAT
// list's scroller: legitimately at its end, while the transcript sat far from
// its bottom. Observed 2026-08-19: two jump failures reported by the operator,
// both immediately after arriving from another tab, both traced gap=0.
//
// A measurement that names the wrong element is worse than no measurement,
// because it is confident. `how` is traced so a scoping miss is visible rather
// than silently falling back to the old document-wide behaviour.
function __bramTranscriptScrollerInfo() {
  var root = null;
  try { root = document.querySelector('[data-testid="transcript-list"]'); } catch (e) { root = null; }
  if (root) {
    if (__bramIsScrollable(root)) return { el: root, how: "scoped-self" };
    try {
      var inner = root.querySelectorAll("*");
      for (var i = 0; i < inner.length && i < 40; i++) {
        if (__bramIsScrollable(inner[i])) return { el: inner[i], how: "scoped-inner" };
      }
    } catch (e2) { /* ignore */ }
    var up = root.parentElement;
    while (up) {
      if (__bramIsScrollable(up)) return { el: up, how: "scoped-ancestor" };
      up = up.parentElement;
    }
    return { el: null, how: "scoped-miss" };
  }
  // No tagged list in the DOM: the transcript is not mounted, so there is
  // nothing to measure. Deliberately NOT falling back to a document-wide
  // search, which is the bug this function was rewritten to fix.
  return { el: null, how: "unmounted" };
}

function __bramTranscriptScroller() {
  return __bramTranscriptScrollerInfo().el;
}

// Ground truth for "did I land at the bottom", independent of any scroller.
//
// Three times tonight a scroller-gap reading said landed while the operator was
// looking at a screen that said otherwise. The last of those exposed why: every
// reading resolved `scoped-ancestor`, meaning the transcript List is not itself
// scrollable and the measurement walks up to the page/main scroller. That
// scroller can legitimately be at its end while the virtualized List has not
// extended to its final row — two different questions, and only one of them is
// the user's.
//
// So measure the thing the user actually cares about: is the final event's row
// rendered, and is its bottom edge above the fold? `lastRowBottom` is relative
// to the viewport; `lastRowGap` is how far below the fold it sits (0 when
// visible). `lastRowRendered:false` means virtua has not built that row at all,
// which is a different failure from "rendered but scrolled past".
function __bramLastRowProbe(total) {
  var out = { lastRowRendered: false, lastRowGap: -1, lastRowIndex: -1, maxRenderedIndex: -1 };
  try {
    var root = document.querySelector('[data-testid="transcript-list"]');
    var nodes = (root || document).querySelectorAll("[data-index]");
    if (!nodes || !nodes.length) return out;
    var want = (typeof total === "number" && total > 0) ? total - 1 : -1;
    var maxIdx = -1;
    var node = null;
    for (var i = 0; i < nodes.length; i++) {
      var raw = nodes[i].getAttribute("data-index");
      var idx = raw == null ? -1 : parseInt(raw, 10);
      if (isNaN(idx)) continue;
      if (idx > maxIdx) { maxIdx = idx; }
      if (want >= 0 && idx === want) node = nodes[i];
    }
    out.maxRenderedIndex = maxIdx;
    out.lastRowIndex = want;
    if (!node) return out;
    out.lastRowRendered = true;
    var r = node.getBoundingClientRect();
    var vh = window.innerHeight || document.documentElement.clientHeight || 0;
    out.lastRowGap = Math.max(0, Math.round(r.bottom - vh));
  } catch (e) { /* ignore */ }
  return out;
}

// Explicit jump-to-bottom, with the bounded retry the mount path has always
// had and the jump paths never did.
//
// Measured 2026-08-18 with the corrected verifier: footer-arrow-down landed 0
// of 2 (short by 43px, then 522px) while mount-pin landed 5 of 5. The only
// bottom-promise that re-checks is the only one that lands. A jump issues
// scrollToBottom(), verifies two frames later, and if the content is still
// settling it simply stays wrong — in the observed episode, 43px short for
// five seconds until unrelated agent output triggered a repin.
//
// Retry on PIXELS, never on index: five append-time divergences in the same
// soak reported endIndex 0 against totals above 2100, because the visible
// range is stale at exactly those moments. An index-driven retry would spin
// against a lie.
//
// No fixed offset correction: the two misses differed by an order of
// magnitude, which points at content settling after the scroll rather than a
// constant error, so a fudge factor would fix one and miss the other.
window.__bramBottomJumpRetry = function (listRef, cause, agentId, total) {
  window.__bramJumpListRef = listRef;
  var MAX_ATTEMPTS = 40; // ~2s at 50ms; a jump from the top of a long
                         // virtualized list needs virtua to render and measure
                         // its way down, which the old 600ms budget cut short.
  var attempts = 0;
  var settled = 0;
  function jump() {
    try { if (listRef && listRef.scrollToBottom) listRef.scrollToBottom(); } catch (e) { /* ignore */ }
  }
  function step() {
    // The user scrolling up mid-retry takes precedence: __bramFollowTransition
    // sets this false on a corroborated user scroll, and a retry that fought
    // that would be worse than the miss it fixes.
    if (window.__bramFollowAtBottom === false) {
      window.__bramIframeTrace("follow-state", {
        op: "jump-yielded", cause: cause || "", attempts: attempts,
        agentId: agentId || "main",
      });
      return;
    }
    var info = __bramTranscriptScrollerInfo();
    var sc = info.el;
    var gap = sc ? Math.max(0, sc.scrollHeight - (sc.scrollTop + sc.clientHeight)) : 0;
    // Require pixel AND index, and require them twice running.
    //
    // Pixel alone is not enough when jumping from far away: virtua renders and
    // measures rows incrementally, so scrollHeight is still GROWING during the
    // jump and `scrollTop + clientHeight >= scrollHeight - 4` is satisfied
    // against a partial height. Observed 2026-08-19: a chip jump from the top
    // of a 2,224-event transcript reported gap<=4, stopped, and was 3,158px
    // short two frames later — with no pin-abandoned, because the loop thought
    // it had won.
    //
    // Index alone is not enough either: during content appends the visible
    // range lags and reports endIndex 0 against totals above 2,100. The two
    // measures fail in opposite conditions, so the conjunction is the honest
    // test, and the consecutive-tick requirement is what a still-growing
    // scrollHeight cannot fake.
    var r = window.__bramVisibleRange;
    var endIndex = (r && typeof r.endIndex === "number") ? r.endIndex : -1;
    var n = (typeof total === "number" && total >= 0)
      ? total
      : ((window.__bramLastTranscriptEvents || []).length || 0);
    var indexAtEnd = n > 0 && endIndex >= n - 1;
    // Converge on what the user can see. When the final row is rendered, its
    // position relative to the fold IS the answer, and it settles the case a
    // scroller gap cannot: the page scroller at its end while the virtualized
    // List has not extended to its last row. Only when that row does not exist
    // yet do we fall back to the scroller/index conjunction.
    var probe = __bramLastRowProbe(n);
    var atEnd = probe.lastRowRendered
      ? (probe.lastRowGap <= 4)
      : (!!sc && gap <= 4 && indexAtEnd);
    if (!sc) {
      window.__bramFollowVerify(cause, agentId, total);
      return;
    }
    if (atEnd) {
      settled += 1;
      if (settled >= 2) {
        window.__bramFollowVerify(cause, agentId, total);
        return;
      }
    } else {
      settled = 0;
    }
    if (attempts >= MAX_ATTEMPTS) {
      window.__bramIframeTrace("follow-state", {
        op: "pin-abandoned", cause: cause || "", attempts: attempts,
        pixelGap: gap, indexAtEnd: indexAtEnd, endIndex: endIndex,
        lastRowRendered: probe.lastRowRendered, lastRowGap: probe.lastRowGap,
        maxRenderedIndex: probe.maxRenderedIndex,
        scroller: info.how, total: n, agentId: agentId || "main",
      });
      window.__bramFollowVerify(cause, agentId, total);
      return;
    }
    attempts += 1;
    // Re-issue only while genuinely short; a settling tick should not fight
    // the scroller it is waiting on.
    if (!atEnd) jump();
    setTimeout(step, 50);
  }
  jump();
  setTimeout(step, 50);
};

// Did a bottom-promise actually land?
//
// This check was inert from the day it was written: it read
// `window.__bramVisibleRange.atBottom`, and NOTHING populates that field while
// the transcript is mounted. `atBottom` does not exist anywhere in xmlui — the
// List's visibleRangeDidChange payload carries startIndex/endIndex only, and
// Transcript's onCleanup is the one writer, at unmount, for the restore path.
// `undefined !== false` is true, so `landed` was unconditionally true and
// `op=violation` was unreachable. Six fixes to the follow contract were
// evaluated against it, including a soak reported as "1,056 bottom-promises,
// zero violations" (2026-08-18: that soak measured nothing).
//
// Measure two granularities, because they fail differently and the divergence
// is itself diagnostic:
//   index — the last row is inside the visible range;
//   pixel — the scroller is actually at its end.
// A tall final row satisfies index while its body sits below the fold, the
// same class as DiffView's scrollToIndex-reaches-the-row-top note. Pixel is
// authoritative when a scroller can be found, because it is what the user
// sees; index is recorded either way so the two can be compared in the soak.
//
// Deliberately NOT reading the last onScroll `ev.atEnd`: a pin that does not
// move the scroller emits no scroll event, so that value can be stale exactly
// when the promise failed.
window.__bramFollowVerify = function (cause, agentId, total) {
  // Every verify carries the live turn count, so the repair path has a fresh
  // "which row is last" without threading it through the scroll listener.
  if (typeof total === "number" && total > 0) window.__bramFollowLastTotal = total;
  try {
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        try {
          var r = window.__bramVisibleRange;
          var endIndex = (r && typeof r.endIndex === "number") ? r.endIndex : -1;
          var n = (typeof total === "number" && total >= 0)
            ? total
            : ((window.__bramLastTranscriptEvents || []).length || 0);
          var indexAtEnd = n > 0 && endIndex >= n - 1;

          var info = __bramTranscriptScrollerInfo();
          var sc = info.el;
          var pixelAtEnd = null;
          var pixelGap = -1;
          var elDesc = "";
          if (sc) {
            pixelGap = Math.max(0, sc.scrollHeight - (sc.scrollTop + sc.clientHeight));
            pixelAtEnd = pixelGap <= 4;
            try {
              elDesc = (sc.tagName || "?").toLowerCase()
                + "." + String(sc.className || "").split(/\s+/)[0].slice(0, 24)
                + " " + Math.round(sc.scrollTop) + "/" + Math.round(sc.scrollHeight)
                + " h" + Math.round(sc.clientHeight);
            } catch (e5) { elDesc = "?"; }
          }
          var probe = __bramLastRowProbe(n);

          // With no scroller of OUR OWN to measure, fall back to index rather
          // than to another list's scroller. `scroller` names which happened,
          // so a run of `scoped-miss` / `unmounted` is legible as "this reading
          // is index-only" instead of passing for a pixel verdict.
          var landed = (pixelAtEnd === null) ? indexAtEnd : pixelAtEnd;
          var route = "";
          try { route = String(location.hash || ""); } catch (e4) { /* ignore */ }

          window.__bramIframeTrace("follow-state", {
            op: landed ? "verify" : "violation",
            cause: cause || "",
            landed: landed,
            indexAtEnd: indexAtEnd,
            pixelAtEnd: pixelAtEnd,
            pixelGap: pixelGap,
            divergent: (pixelAtEnd !== null && pixelAtEnd !== indexAtEnd),
            scroller: info.how,
            el: elDesc,
            lastRowRendered: probe.lastRowRendered,
            lastRowGap: probe.lastRowGap,
            maxRenderedIndex: probe.maxRenderedIndex,
            endIndex: endIndex,
            total: n,
            route: route,
            agentId: agentId || "main",
          });
        } catch (e3) { /* ignore */ }
      });
    });
  } catch (e) { /* ignore */ }
};

// xmlui eval-trace sink (engine-neutral probe, vendored eval-trace.ts):
// the engine emits evaluation/statement/action lines only while
// window.__xmluiEvalTraceUntil holds a future performance.now() deadline,
// through this registered sink. Bram forwards into its trace channel under
// the existing xmlui-probe subkind (vocabulary unchanged). Arm from
// devtools with: window.__xmluiEvalTraceUntil = performance.now() + 3000
window.__xmluiEvalTraceSink = function (op, d) {
  try { window.__bramIframeTrace("xmlui-probe", { op: op, d: d }); } catch (e) { /* ignore */ }
};

window.__bramRegisterTranscriptScroll = function (goTop, goBottom) {
  window.__bramTranscriptScrollActions = { top: goTop, bottom: goBottom };
};
window.__bramTranscriptScroll = function (dir) {
  var a = window.__bramTranscriptScrollActions;
  if (!a) return;
  try {
    if (dir === "top" && a.top) a.top();
    else if (a.bottom) a.bottom();
  } catch (e) {}
};

window.__bramTranscriptMount = function () {
  // Mount echoes (virtua initial layout + restore scrolls) precede any
  // __bramFollowTransition call, so the echo window opens here, wider.
  if (window.__bramFollowEchoOpen) window.__bramFollowEchoOpen("mount", 1500);
  // Seed the synchronous follow truth from the same expression the
  // Transcript's atBottom var uses at mount.
  window.__bramFollowAtBottom =
    !window.__bramVisibleRange || window.__bramVisibleRange.atBottom !== false;
  // Chip-recruited arrival from another tab: attribute the follow-mount.
  if (window.__bramUnseenJumpAt && Date.now() - window.__bramUnseenJumpAt < 15000) {
    window.__bramUnseenJumpAt = 0;
    window.__bramFollowTransition(true, "unseen-jump");
  }
  if (window.__bramSetTranscriptMounted) window.__bramSetTranscriptMounted(true);
  if (window.__bramConsumeTranscriptFindClear) window.__bramConsumeTranscriptFindClear();
  if (window.__bramRefetchProjectedTurns) window.__bramRefetchProjectedTurns("transcript-mount");
};

window.__bramWorkspaceMount = function (worklistDataSource) {
  if (worklistDataSource && typeof worklistDataSource.refetch === "function") {
    worklistDataSource.refetch();
  }
  if (window.__bramRefetchProjectedTurns) window.__bramRefetchProjectedTurns("worklist-mount");
};

// Map a Read/Write/Edit path hint (the tool summary) to a Markdown code-fence
// language. Used only for file-op tools so a Bash command that merely mentions
// a ".json" path doesn't mislabel its output.
window.__bramLangFromHint = function (hint) {
  if (!hint) return "";
  var m = String(hint).match(/\.([A-Za-z0-9]+)\b/);
  if (!m) return "";
  var map = {
    rs: "rust", js: "javascript", xs: "javascript", ts: "typescript",
    jsx: "jsx", tsx: "tsx", py: "python", json: "json", xml: "xml",
    xmlui: "xml", html: "html", css: "css", sh: "bash", bash: "bash",
    md: "markdown", toml: "toml", yaml: "yaml", yml: "yaml", sql: "sql",
    go: "go", c: "c", h: "c", rb: "ruby", java: "java"
  };
  return map[m[1].toLowerCase()] || "";
};

// Format a tool-result string for the Transcript expansion as a Markdown
// string: detect JSON / diff / file-by-extension and wrap in a fence-safe code
// block so <Markdown overflowMode="scroll"> renders monospace with preserved
// structure and horizontal scroll. Pure, no side effects.
// execute-sql-long-string-cells: resolve the working text for the
// execute_sql formatters. Unwraps (a) the MCP content-block array
// (`[{"type":"text","text":"…"}]` — older-host transcripts and hot loads
// reach the client un-normalized, and parsing the wrapper as rows
// rendered a nonsense |type|text| table) and (b) the `{"result":"…"}`
// envelope. Returns the innermost prose+rows text.
window.__bramExecuteSqlInnerText = function (text) {
  var inner = String(text == null ? "" : text);
  var t = inner.trim();
  if (t.charAt(0) === "[") {
    try {
      var blocks = JSON.parse(t);
      if (
        Array.isArray(blocks) && blocks.length > 0 &&
        blocks.every(function (b) {
          return b && b.type === "text" && typeof b.text === "string";
        })
      ) {
        inner = blocks.map(function (b) { return b.text; }).join("\n");
        t = inner.trim();
      }
    } catch (e) {}
  }
  if (t.charAt(0) === "{") {
    try {
      var obj = JSON.parse(t);
      if (obj && typeof obj.result === "string") inner = obj.result;
    } catch (e) {}
  }
  return inner;
};

// execute-sql-long-string-cells: single-row rendering when a value is a
// whole document (pg_get_viewdef's view definition et al). Short values
// render as `key: value` lines; long strings as fenced code blocks —
// `sql` when the text looks like SQL; nested objects as fenced JSON.
window.__bramExecuteSqlRowSections = function (row) {
  var LONG = 300, CAP = 16384;
  var parts = [];
  var keys = Object.keys(row);
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i], v = row[k];
    if (typeof v === "string" && v.length > LONG) {
      var s = v;
      if (s.length > CAP) s = s.slice(0, CAP) + "\n… (truncated)";
      var lang = /^\s*(with|select|create|alter|insert|update|delete)\b/i.test(s) ? "sql" : "";
      parts.push("**" + k + "**:\n\n```" + lang + "\n" + s + "\n```");
    } else if (v !== null && typeof v === "object") {
      var js = JSON.stringify(v, null, 2);
      if (js.length > CAP) js = js.slice(0, CAP) + "\n… (truncated)";
      parts.push("**" + k + "**:\n\n```json\n" + js + "\n```");
    } else {
      parts.push("**" + k + "**: " + (v === null || v === undefined ? "" : String(v)));
    }
  }
  return parts.join("\n\n");
};

// mcp-sql-shape-driven-rendering: does this MCP tool result carry a
// SQL-shaped payload? Two positive signatures, no tool-name list:
// - the `<untrusted-data-…>` boundary tag — the Supabase MCP wrapper's
//   own prompt-injection fence, stamped on every SQL-backed result
//   (execute_sql, get_logs, get_advisors, …) and never on prose;
// - the result parses WHOLESALE as a JSON rows-array or object
//   (bare-rows servers like the postgres MCP) — wholesale, so a JSON
//   array merely embedded in prose can't false-fire.
// Content-block arrays (elements with an MCP `type` tag) are excluded:
// they are transport wrapper, not rows — a wrapped SQL payload is
// caught by the boundary-tag arm after unwrap instead.
window.__bramMcpSqlShaped = function (text) {
  try {
    var inner = window.__bramExecuteSqlInnerText(text);
    if (inner.indexOf("<untrusted-data-") >= 0) return true;
    var t = inner.trim();
    if (t.charAt(0) !== "[" && t.charAt(0) !== "{") return false;
    var parsed = JSON.parse(t);
    if (Array.isArray(parsed)) {
      if (parsed.length === 0) return false;
      var blockTypes = { text: 1, image: 1, audio: 1, resource: 1, resource_link: 1, tool_use: 1, tool_result: 1 };
      var allObjects = parsed.every(function (r) {
        return r && typeof r === "object" && !Array.isArray(r);
      });
      if (!allObjects) return false;
      var contentBlocks = parsed.every(function (r) {
        return typeof r.type === "string" && blockTypes[r.type] === 1;
      });
      return !contentBlocks;
    }
    return parsed !== null && typeof parsed === "object";
  } catch (e) {
    return false;
  }
};

// render-supabase-execute-sql: turn a Supabase execute_sql result into a
// Markdown table, or null if it doesn't look like rows (DDL, no rows, parse
// failure) so the caller falls back to generic formatting. The rows are a JSON
// array inside the tool's `{"result": "…<untrusted-data-…>[rows]</…>…"}` shape.
window.__bramSupabaseSqlTable = function (text) {
  try {
    var inner = window.__bramExecuteSqlInnerText(text);
    // The rows are the one JSON array in the result. Extract first "[" to last
    // "]"; the preamble/postamble are prose (they even mention the
    // <untrusted-data-…> tag, so keying on that tag mis-captures the prose).
    var lb = inner.indexOf("["), rb = inner.lastIndexOf("]");
    if (lb < 0 || rb <= lb) return null;
    var arrText = inner.slice(lb, rb + 1);
    var rows = JSON.parse(arrText);
    if (!Array.isArray(rows) || rows.length === 0) return null;
    var cols = [];
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (!r || typeof r !== "object" || Array.isArray(r)) return null;
      for (var k in r) {
        if (Object.prototype.hasOwnProperty.call(r, k) && cols.indexOf(k) < 0) cols.push(k);
      }
    }
    if (cols.length === 0) return null;
    // execute-sql-json-result-fenced: a single row whose sole value is a
    // nested object/array makes a useless 1x1 table (the whole JSON blob
    // newline-collapsed into one cell — the pa11 STATE specimen). Decline
    // so the caller's JSON formatter pretty-prints it instead.
    if (rows.length === 1 && cols.length === 1) {
      var only = rows[0][cols[0]];
      if (only && typeof only === "object") return null;
    }
    // execute-sql-long-string-cells: tables are for scannable values. A
    // cell holding a whole DOCUMENT (pg_get_viewdef's view definition,
    // 900-2300 chars in the pa11 specimens) is unreadable
    // newline-collapsed and Markdown-mangles its * and _ (count(*)
    // rendered as italic count()) — decline so the caller's section
    // renderer takes it. Merely long-ish cells (a 313-char log
    // event_message across 21 rows — the get_logs specimen) keep the
    // table and truncate below; declining them dropped a genuinely
    // tabular result to the generic envelope blob.
    // Single-row results are document-shaped as soon as any value runs
    // long (a lone view definition deserves a code block, not a cell);
    // multi-row results stay tables up to a document-sized cell, with
    // truncation below keeping them scannable.
    var DOC_CELL = rows.length === 1 ? 300 : 1000;
    for (var ri = 0; ri < rows.length; ri++) {
      for (var rk in rows[ri]) {
        if (!Object.prototype.hasOwnProperty.call(rows[ri], rk)) continue;
        var rv = rows[ri][rk];
        var rs = rv === null || rv === undefined
          ? ""
          : typeof rv === "object" ? JSON.stringify(rv) : String(rv);
        if (rs.length > DOC_CELL) return null;
      }
    }
    var esc = function (v) {
      if (v === null || v === undefined) return "";
      var s = typeof v === "object" ? JSON.stringify(v) : String(v);
      if (s.length > 300) s = s.slice(0, 297) + "…";
      return s.replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ");
    };
    var CAP = 50;
    var out = "| " + cols.map(esc).join(" | ") + " |\n";
    out += "| " + cols.map(function () { return "---"; }).join(" | ") + " |\n";
    var n = Math.min(rows.length, CAP);
    for (var j = 0; j < n; j++) {
      var row = rows[j];
      out += "| " + cols.map(function (c) { return esc(row[c]); }).join(" | ") + " |\n";
    }
    if (rows.length > CAP) out += "\n_+" + (rows.length - CAP) + " more rows_\n";
    return out;
  } catch (e) {
    return null;
  }
};

// execute-sql-json-result-fenced: pretty-print an execute_sql result that is
// JSON but not tabular — a lone object, or a single row whose sole value is
// a nested object/array (the case __bramSupabaseSqlTable declines). Same
// payload extraction as the table formatter; null on anything else so the
// caller falls back to generic formatting.
window.__bramSupabaseSqlJson = function (text) {
  try {
    var inner = window.__bramExecuteSqlInnerText(text);
    var payload = null;
    var lb = inner.indexOf("["), rb = inner.lastIndexOf("]");
    if (lb >= 0 && rb > lb) {
      try { payload = JSON.parse(inner.slice(lb, rb + 1)); } catch (e) {}
    }
    if (payload == null) {
      var lbo = inner.indexOf("{"), rbo = inner.lastIndexOf("}");
      if (lbo >= 0 && rbo > lbo) {
        try { payload = JSON.parse(inner.slice(lbo, rbo + 1)); } catch (e) {}
      }
    }
    if (payload == null || typeof payload !== "object") return null;
    var value = payload;
    if (Array.isArray(payload)) {
      // execute-sql-long-string-cells: rows carrying document-sized
      // strings (view definitions) get the section renderer — the table
      // declined them, and pretty JSON would flatten the document into
      // one escaped line. Bounded to a few rows; larger long-string
      // result sets fall through to generic formatting.
      var objRows = payload.length > 0 && payload.every(function (r) {
        return r && typeof r === "object" && !Array.isArray(r);
      });
      if (objRows) {
        var anyLong = payload.some(function (r) {
          return Object.keys(r).some(function (k) {
            return typeof r[k] === "string" && r[k].length > 300;
          });
        });
        if (anyLong && payload.length <= 5) {
          return payload.map(window.__bramExecuteSqlRowSections).join("\n\n---\n\n");
        }
      }
      if (payload.length !== 1) return null;
      value = payload[0];
      if (value && typeof value === "object" && !Array.isArray(value)) {
        var keys = Object.keys(value);
        if (keys.length === 1 && keys[0] && value[keys[0]] && typeof value[keys[0]] === "object") {
          value = value[keys[0]];
        }
      }
    }
    if (!value || typeof value !== "object") return null;
    var pretty = JSON.stringify(value, null, 2);
    if (!pretty) return null;
    // Same size discipline as the generic formatter's cap: an enormous
    // result stays useful without freezing layout (tool-format lineage).
    if (pretty.length > 16384) {
      pretty = pretty.slice(0, 16384) + "\n… (truncated)";
    }
    return "```json\n" + pretty + "\n```";
  } catch (e) {
    return null;
  }
};

// transcript-wrap-freeform-feedback: a Read of an iterate feedback draft
// (resources/feedback-drafts/<ref>.md) is our own freeform prose — no
// alignment to preserve, so it renders wrapped instead of as a scrolling
// code block. Substring match covers absolute and repo-relative hints.
window.__bramIsFeedbackDraftRead = function (toolName, hint) {
  return String(toolName || "") === "Read" &&
    String(hint || "").indexOf("/feedback-drafts/") >= 0;
};

// Normalize nested structured results from Codex unified exec and standard
// MCP CallToolResult envelopes. The Rust projection performs the same
// normalization for current sessions; this provider-neutral client fallback
// also covers Claude records and hot-loaded transcripts projected by an older
// host binary. Mixed MCP blocks stay as complete JSON so no content is lost.
window.__bramParseStructuredJsonSequence = function (value) {
  var source = String(value == null ? "" : value).trim();
  if (source.charAt(0) !== "{" && source.charAt(0) !== "[") return null;
  var values = [];
  var start = -1, depth = 0, quote = false, escaped = false;
  for (var i = 0; i < source.length; i++) {
    var ch = source.charAt(i);
    if (start < 0) {
      if (/\s/.test(ch)) continue;
      if (ch !== "{" && ch !== "[") return null;
      start = i;
      depth = 1;
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === "\"") quote = false;
      continue;
    }
    if (ch === "\"") quote = true;
    else if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") {
      depth--;
      if (depth < 0) return null;
      if (depth === 0) {
        try { values.push(JSON.parse(source.slice(start, i + 1))); }
        catch (e) { return null; }
        start = -1;
      }
    }
  }
  return start < 0 && values.length > 0 ? values : null;
};

window.__bramNormalizeStructuredToolResult = function (result) {
  var text = String(result == null ? "" : result);
  var failed = text.indexOf("Script failed\n") === 0;
  if (text.indexOf("Script completed\n") === 0 || failed) {
    var outputAt = text.indexOf("\nOutput:\n");
    if (outputAt >= 0) text = text.slice(outputAt + "\nOutput:\n".length);
  }

  var preamble = "";
  var truncated = text.match(/^(Warning: truncated output \(original token count: \d+\)\nTotal output lines: \d+\n\n)([\s\S]*)$/);
  if (truncated) {
    preamble = truncated[1];
    text = truncated[2];
  }
  function withPreamble(value) { return preamble + value; }

  var trimmed = text.trim();
  if (trimmed.charAt(0) !== "{" && trimmed.charAt(0) !== "[") {
    return withPreamble(text);
  }
  var parsedValues = window.__bramParseStructuredJsonSequence(trimmed);
  if (!parsedValues) return withPreamble(text);
  if (parsedValues.length > 1) {
    var normalizedValues = parsedValues.map(function (value) {
      return window.__bramNormalizeStructuredToolResult(JSON.stringify(value));
    }).filter(function (value) { return value !== ""; });
    return withPreamble(normalizedValues.join("\n"));
  }
  var parsed = parsedValues[0];
  try {

    if (!Array.isArray(parsed)) {
      var execKeys = [
        "chunk_id", "wall_time_seconds", "exit_code",
        "original_token_count", "session_id", "metadata"
      ];
      var isExecEnvelope = Object.prototype.hasOwnProperty.call(parsed, "output") &&
        execKeys.some(function (key) {
          return Object.prototype.hasOwnProperty.call(parsed, key);
        });
      if (isExecEnvelope) {
        var useful = parsed.output;
        if ((useful === "" || useful == null) && parsed.stderr != null) useful = parsed.stderr;
        if (typeof useful === "string") {
          return withPreamble(window.__bramNormalizeStructuredToolResult(useful));
        }
        return withPreamble(JSON.stringify(useful, null, 2));
      }

      if (Array.isArray(parsed.content) && parsed.content.length > 0) {
        var allText = parsed.content.every(function (part) {
          return part &&
            /^(text|input_text|output_text)$/.test(String(part.type || "")) &&
            typeof part.text === "string";
        });
        if (allText) {
          return withPreamble(window.__bramNormalizeStructuredToolResult(
            parsed.content.map(function (part) { return part.text; }).join("\n")
          ));
        }
      }
    }
    return withPreamble(JSON.stringify(parsed, null, 2));
  } catch (e) {
    return withPreamble(text);
  }
};

window.__bramIsMcpToolName = function (name) {
  var text = String(name || "");
  return /^mcp__.+__.+$/.test(text) || /^[A-Za-z0-9_-]+\.[A-Za-z0-9_.-]+$/.test(text);
};

window.__bramToolResultIsStructuredJson = function (result) {
  var raw = String(result == null ? "" : result);
  if (raw.indexOf("Script completed\n") === 0 || raw.indexOf("Script failed\n") === 0) {
    var outputAt = raw.indexOf("\nOutput:\n");
    if (outputAt >= 0) raw = raw.slice(outputAt + "\nOutput:\n".length);
  }
  raw = raw.replace(
    /^Warning: truncated output \(original token count: \d+\)\nTotal output lines: \d+\n\n/,
    ""
  ).trim();
  if (window.__bramParseStructuredJsonSequence(raw)) return true;

  var text = window.__bramNormalizeStructuredToolResult(result).trim();
  text = text.replace(
    /^Warning: truncated output \(original token count: \d+\)\nTotal output lines: \d+\n\n/,
    ""
  ).trim();
  return !!window.__bramParseStructuredJsonSequence(text);
};

// transcript-render-menu-answers iterate: AskUserQuestion results arrive as
// a quoted sentence — `Your questions have been answered: "Q"="A", ...` —
// which read as a scrolling monospace blob. Parse the "Q"="A" pairs into
// question/answer prose; null on parse miss so the caller self-declines to
// the generic fence.
window.__bramAskUserQuestionQA = function (text) {
  var pairs = String(text || "").match(/"[^"]+"="[^"]*"/g);
  if (!pairs || !pairs.length) return null;
  var out = [];
  for (var i = 0; i < pairs.length; i++) {
    var mm = /"([^"]+)"="([^"]*)"/.exec(pairs[i]);
    if (mm) out.push("**" + mm[1] + "**\n\n✔ " + mm[2]);
  }
  return out.length ? out.join("\n\n") : null;
};

// Overflow mode for a transcript tool-result Markdown: feedback-draft prose
// and structured JSON wrap ('flow'); everything else keeps horizontal scroll.
window.__bramFreeformResultMode = function (item) {
  if (!item) return "scroll";
  if (window.__bramIsFeedbackDraftRead(item.name, item.summary)) return "flow";
  if (window.__bramIsMcpToolName(item.name)) return "flow";
  if (item.name === "AskUserQuestion") return "flow";
  if (item.resultStructured) return "flow";
  return window.__bramToolResultIsStructuredJson(item.result) ? "flow" : "scroll";
};

// Whether the expanded tool row shows the command/summary block. Only when
// commandDisplay adds something beyond the header: the summary-only fallback
// (MCP tools, Read, Grep, …) would just repeat the summary the row header
// already shows. apply_patch renders its command as a DiffView instead; a
// feedback-draft Read's wrapped content stands alone in the command's place.
window.__bramShowToolCommand = function (item) {
  if (!item || !item.commandDisplay) return false;
  if (item.name === "apply_patch") return false;
  return !window.__bramIsFeedbackDraftRead(item.name, item.summary);
};

window.__bramFormatToolResult = function (result, toolName, hint) {
  if (result == null) return "";
  var text = String(result);
  if (text.trim() === "") return text;
  // mcp-sql-shape-driven-rendering: render SQL-shaped MCP results as a
  // Markdown table / pretty JSON / long-string sections, recognized by
  // result SHAPE (boundary tag or wholesale rows JSON), not tool name —
  // name gates missed twice in one day (the claude.ai connector's server
  // segment, then mcp__supabase__get_logs returning the same envelope).
  // The pipeline self-declines back to generic formatting on anything
  // non-tabular/non-JSON.
  var __toolNameStr = String(toolName || "");
  if (__toolNameStr.indexOf("mcp__") === 0 && window.__bramMcpSqlShaped(text)) {
    var sqlTable = window.__bramSupabaseSqlTable(text);
    if (sqlTable) return sqlTable;
    // execute-sql-json-result-fenced: JSON-but-not-tabular results (lone
    // object, single row wrapping a nested object) render as pretty JSON.
    var sqlJson = window.__bramSupabaseSqlJson(text);
    if (sqlJson) return sqlJson;
  }
  // AskUserQuestion: question/answer prose instead of a code fence
  // (transcript-render-menu-answers iterate); generic path on parse miss.
  if (__toolNameStr === "AskUserQuestion") {
    var qa = window.__bramAskUserQuestionQA(text);
    if (qa) return qa;
  }
  // tool-format sync bracket (variant-B expansion freeze, 2026-07-11
  // 22:48Z): the freeze lives somewhere in formatter → Markdown → WebKit
  // layout of a large expanded row, with the click handler exonerated by
  // the host-side describe route entry. Bracket the formatter's string
  // work synchronously (logToHost → invoke survives a freeze) for large
  // inputs only: begin-no-end names the formatter; begin+end then silence
  // names Markdown/layout by elimination. longestLine captures the
  // dimension the 16KB cap below does NOT bound — the rg row's 11.5K-char
  // single line is the prime layout suspect.
  var bracketT0 = 0;
  var bracketBig = text.length > 8000;
  if (bracketBig) {
    var lineLongest = 0, lineCur = 0;
    for (var bi = 0; bi < text.length; bi++) {
      if (text.charCodeAt(bi) === 10) { lineCur = 0; }
      else { lineCur++; if (lineCur > lineLongest) lineLongest = lineCur; }
    }
    bracketT0 = performance.now();
    window.__bramIframeTrace("tool-format", {
      stage: "begin", tool: String(toolName || ""),
      chars: text.length, longestLine: lineLongest,
    });
  }
  // Strip ANSI escape sequences so raw \x1b[...m bytes don't render literally.
  text = text.replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, "");
  text = window.__bramNormalizeStructuredToolResult(text);

  var MAX_RENDER = 16000;

  // Feedback-draft Reads: strip the cat -n line-number gutter and return
  // unfenced prose; the Transcript pairs this with overflowMode="flow" via
  // __bramFreeformResultMode so it wraps.
  if (window.__bramIsFeedbackDraftRead(toolName, hint)) {
    var prose = text.replace(/^\s*\d+\t/gm, "");
    if (prose.length > MAX_RENDER) {
      prose = prose.slice(0, MAX_RENDER) +
        "\n… (+" + (prose.length - MAX_RENDER) + " more chars — full output in the session JSONL)";
    }
    if (bracketBig) {
      window.__bramIframeTrace("tool-format", {
        stage: "end", tool: String(toolName || ""),
        ms: Math.round(performance.now() - bracketT0), outChars: prose.length,
      });
    }
    return prose;
  }

  var lang = "";
  var body = text;
  var trimmed = text.trim();

  // JSON object/array that round-trips -> pretty-print for structure.
  if (trimmed.charAt(0) === "{" || trimmed.charAt(0) === "[") {
    try {
      var parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object") {
        body = JSON.stringify(parsed, null, 2);
        lang = "json";
      }
    } catch (e) { /* not JSON */ }
  }

  // Unified diff markers (any line).
  if (lang === "" && /^(diff --git |@@ |\+\+\+ |--- )/m.test(text)) {
    lang = "diff";
  }

  // File-op tools: language by extension from the path hint.
  if (lang === "" && /^(Read|Write|Edit|NotebookEdit)$/.test(String(toolName || ""))) {
    lang = window.__bramLangFromHint(hint);
  }

  // Render cap (2026-07-09 describe-freeze): an expanded 41KB result
  // re-rendering through Markdown froze the codex transcript's main
  // thread hard (trace went silent at the describe-patch instant; the
  // 4.8KB row a few seconds earlier sailed through). Unbounded content
  // in the webview is the recurring codex-session killer, so bound the
  // rendered block; the full output remains in the session JSONL
  // (Sessions tab / /__tool-detail).
  if (body.length > MAX_RENDER) {
    body =
      body.slice(0, MAX_RENDER) +
      "\n… (+" + (body.length - MAX_RENDER) + " more chars — full output in the session JSONL)";
  }

  // Fence-safety: the fence must be longer than the longest backtick run in
  // the body, or content containing ``` would break the block.
  var longest = 0, run = 0;
  for (var i = 0; i < body.length; i++) {
    if (body.charAt(i) === "`") { run++; if (run > longest) longest = run; }
    else { run = 0; }
  }
  var fence = "";
  var fenceLen = Math.max(3, longest + 1);
  for (var j = 0; j < fenceLen; j++) { fence += "`"; }

  var out = fence + lang + "\n" + body + "\n" + fence;
  if (bracketBig) {
    window.__bramIframeTrace("tool-format", {
      stage: "end", tool: String(toolName || ""),
      ms: Math.round(performance.now() - bracketT0), outChars: out.length,
    });
  }
  return out;
};

// Append the live pending agent menu (if any) as the last transcript event.
// Called by the projected-turns adapter (__bramTranscriptEventsFromTurns).
window.__bramAppendMenuEvents = function (events, menu) {
  // menu-stack-pty-inflight-prose: while a permission menu is up, Claude hasn't
  // written the turn's assistant record to its JSONL yet, so the explanatory
  // prose is missing from the transcript. Show the grid-sourced prose
  // (menu.inflightProse) as a PROVISIONAL block above the menu. A live menu
  // supplies the prose; once it's dismissed there is a ~0.5–1.6s gap before the
  // real record lands, during which we KEEP showing the prose (bridge) so it
  // doesn't blink out and back. The bridge clears when the real record lands
  // (content match) or after an 8s backstop (a no-tool_use prompt may never
  // produce a record). The provisional is a separate block, never inserted into
  // the record list, so there is no duplicate risk; a stable id keeps XMLUI from
  // remounting (flashing) across the live→bridge→swap transitions.
  var prose = ((menu && menu.inflightProse) || "").trim();
  if (prose) {
    window.__bramPendingProse = { text: prose, atMs: Date.now() };
  } else if (
    window.__bramPendingProse &&
    Date.now() - window.__bramPendingProse.atMs < 8000
  ) {
    prose = window.__bramPendingProse.text;
  }
  if (prose) {
    var key = prose.replace(/\s+/g, " ").trim().toLowerCase().slice(0, 40);
    var present = false;
    for (var k = events.length - 1; k >= 0 && events.length - k <= 10; k--) {
      if (
        events[k].kind === "text" &&
        key &&
        events[k].text.replace(/\s+/g, " ").toLowerCase().indexOf(key) >= 0
      ) {
        present = true;
        break;
      }
    }
    if (present) {
      window.__bramPendingProse = null;
    } else {
      events.push({ id: "menu-prose", kind: "menu-prose", text: prose });
    }
  }
  if (menu) {
    events.push({ id: "menu-pending-" + window.__bramMenuIdentity(menu), kind: "menu", menu: menu });
  }
  return events;
};

// Presentation adapter: flatten projected turns (host shape: { role, text,
// entries[], images[] }) into the Transcript's flat event stream. No JSONL
// parsing and no resolution rules here — that is the host projection's job
// (docs/turn-transport-redesign.md). Per-turn event slices are cached by
// turn object identity: the broadcast preserves unchanged turn refs, so
// unchanged rows keep identical event objects and the List doesn't
// re-mount them.
window.__bramProjectedEventCache = (typeof WeakMap === "function") ? new WeakMap() : null;
window.__bramTranscriptEventsFromTurns = function (payload, menu) {
  // viewport-priority describe: the pump maps mounted rows' data-index
  // back to entries through this snapshot of the adapter's last output.

  var turns = (payload && payload.turns) || [];
  var events = [];
  for (var ti = 0; ti < turns.length; ti++) {
    var t = turns[ti] || {};
    var slice = window.__bramProjectedEventCache && window.__bramProjectedEventCache.get(t);
    if (!slice) {
      slice = [];
      var baseId = "pt" + ti;
      if (t.notification) {
        // Host-reclassified task notification (subagent completion
        // report): a quiet system-note row, never a "You" turn.
        slice.push({
          id: baseId + "-n",
          kind: "notification",
          text: t.text || "",
          taskId: t.taskId || "",
          toolUseId: t.toolUseId || "",
        });
      } else if (t.role === "user") {
        if (t.text && String(t.text).trim()) {
          slice.push({ id: baseId + "-u", kind: "user", text: t.text });
        }
      } else {
        var entries = t.entries || [];
        for (var ei = 0; ei < entries.length; ei++) {
          var e = entries[ei] || {};
          var eid = baseId + "-" + ei;
          if (e.kind === "text") {
            if (e.text && String(e.text).trim()) {
              slice.push({ id: eid, kind: "text", text: e.text });
            }
          } else if (e.kind === "thinking") {
            slice.push({ id: eid, kind: "thinking", text: e.text || "" });
          } else if (e.kind === "tool") {
            // Spread-through, not whitelist: this copy used to enumerate
            // fields, which silently stripped any NEW projection field
            // before the List rendered (the 2026-07-22 "feature does not
            // exist" hunt: host, serving, caches, and markup were all
            // current; this adapter dropped nameDetail/aiDescription).
            // All of e passes through; the explicit keys below only pin
            // defaults and identity.
            slice.push(Object.assign({}, e, {
              id: e.id || eid,
              kind: "tool",
              toolId: e.id || "",
              name: e.name || "Tool",
              summary: e.summary || "",
              commandDisplay: e.commandDisplay || "",
              commandMarkdown: e.commandMarkdown || "",
              description: e.description || "",
              nameDetail: e.nameDetail || "",
              aiDescription: e.aiDescription || "",
              menuAnswer: e.menuAnswer || "",
              result: e.result || "",
              resultStructured: !!e.resultStructured,
              // Edit/MultiEdit reconstructed diff from the host projection
              // (claude-edit-tool-result-diff-preview). Transcript.xmlui
              // renders it via DiffView when present; the adapter must pass
              // it through or $item.diff is undefined and the view never
              // mounts.
              diff: e.diff || "",
              isError: !!e.isError,
              agentId: e.agentId || "",
            }));
          }
        }
      }
      if (t.images && t.images.length) {
        slice.push({ id: baseId + "-images", kind: "images", role: t.role || "", images: t.images });
      }
      if (window.__bramProjectedEventCache) window.__bramProjectedEventCache.set(t, slice);
    }
    for (var si = 0; si < slice.length; si++) events.push(slice[si]);
  window.__bramLastTranscriptEvents = events;
  }
  return window.__bramAppendMenuEvents(events, menu);
};

// Pure consumer shim for the Sessions tab: unwrap the /__turns envelope.
window.__bramProjectedSessionTurns = function (payload) {
  return (payload && payload.turns) || [];
};

// ---- In-view find (search-in-view-find) ----
// Search terms for the in-view find. A double-quoted query is ONE literal
// phrase; otherwise the query is split into terms >= 2 chars on every run of
// non-alphanumeric characters. Returns an array (possibly single-element or
// empty) suitable for Markdown's multi-term highlightText (xmlui #3675). The
// split deliberately breaks a punctuated query like `feedback-history` into
// separate terms so the in-view find surfaces the tokens the outer /__search
// matched on. It does NOT reproduce FTS5's matching; it only keeps the in-view
// find from being stricter than the search that surfaced the row (details in
// the function body).
// Trailing `*` dispatches FTS5 prefix mode. Typing `run*` used to be silently
// NARROWER than intended: the box only ever sent the URL-seeded mode (`and`),
// and __bramSearchTerms splits on non-alphanumerics, so the `*` was discarded
// and the query ran as the bare token `run`. Measured on the wire: `q=run`
// in `and` mode brackets only `run`; in `prefix` mode it brackets `run`,
// `runs` and `runtime` — WHOLE tokens, not just the typed prefix.
//
// An explicit ?mode= always wins, so replay deep links keep `phrase` / `raw`.
// The stem must be >= 2 chars: `__bramSearchTerms` ignores shorter queries, so
// `a*` would highlight nothing and is left as an ordinary AND query.
function __bramSearchPrefixStem(query) {
  var s = (query == null ? "" : String(query)).trim();
  if (s.length < 3 || s.charAt(s.length - 1) !== "*") return null;
  var stem = s.slice(0, -1);
  return stem.length >= 2 ? stem : null;
}

window.__bramSearchMode = function (query, mode) {
  if (mode && mode !== "and") return mode;
  return __bramSearchPrefixStem(query) ? "prefix" : (mode || "and");
};

window.__bramSearchQuery = function (query, mode) {
  var s = (query == null ? "" : String(query)).trim();
  // Only consume the `*` when WE chose prefix mode from it. Under an explicit
  // ?mode=, the query is the user's verbatim — and in `raw` mode a trailing
  // `*` is meaningful FTS5 syntax, so stripping it would rewrite their query.
  if (mode && mode !== "and") return s;
  var stem = __bramSearchPrefixStem(s);
  return stem ? stem : s;
};

window.__bramSearchTerms = function (query) {
  var s = (query == null ? "" : String(query)).trim();
  if (s.length < 2) return [];
  // A double-quoted query is the literal-phrase escape hatch: return it
  // verbatim, unsplit, for an exact-substring find.
  if (s.charAt(0) === '"' && s.charAt(s.length - 1) === '"') {
    var inner = s.slice(1, -1).trim();
    return inner.length >= 2 ? [inner] : [];
  }
  // Split into terms on every run of non-alphanumeric characters, not just
  // whitespace. Why: for a punctuated query like `feedback-history`, the outer
  // /__search wraps it as the FTS5 phrase "feedback-history", which unicode61
  // tokenizes to the ADJACENT token pair `feedback history` (punctuation-
  // insensitive) — so the outer search matches a session that only ever writes
  // "feedback history" with a space. A whitespace-only split left the same
  // query as one literal substring here, so the in-view find reported "No
  // matches" on a row the outer search had legitimately surfaced. Splitting on
  // punctuation lets the multi-term count/highlight path mark `feedback` and
  // `history` separately. This is deliberately MORE FORGIVING than the outer
  // search: it highlights the tokens independently rather than reproducing
  // FTS5's adjacent phrase, which keeps the find from ever being stricter than
  // the search above it (a superset of marks, never an empty one).
  var out = [];
  var parts = s.split(/[^\p{L}\p{N}]+/u);
  for (var i = 0; i < parts.length; i++) {
    if (parts[i].length >= 2) out.push(parts[i]);
  }
  return out;
};


// Step an occurrence count by `dir` (+1 / -1) with wraparound. Returns 0 when
// there are no matches, so callers never address an empty result set.
window.__bramFindCursorStep = function (total, cur, dir) {
  var n = Number(total) || 0;
  return n ? (((Number(cur) || 0) + dir + n) % n) : 0;
};
window.__bramFindStep = function (indices, cur, dir) {
  var n = indices && indices.length ? indices.length : 0;
  if (!n) return 0;
  var c = Number(cur) || 0;
  return (c + dir + n) % n;
};

// ---- Cross-block in-view find (search-in-view-transplant) ----
// The non-virtualized detail views (Commit/Issue/History) render several
// Markdown blocks. A single global cursor steps every match across all blocks;
// the block holding the active match gets its local occurrence index (fed to
// Markdown's highlightActiveIndex), everyone else gets -1.

// Case-insensitive match count in one block of text, summed across all search
// terms (multi-term, to match AND-mode search + multi-term highlightText). The
// per-block total equals the number of <mark>s the component paints, so the
// "N / M matches" counter and the ▲▼ cursor stay in step with the marks.
window.__bramCountOccurrences = function (text, needle) {
  var s = text == null ? "" : String(text);
  if (!s) return 0;
  var terms = Array.isArray(needle) ? needle : window.__bramSearchTerms(needle);
  var hay = s.toLowerCase();
  var total = 0;
  for (var t = 0; t < terms.length; t++) {
    var q = String(terms[t]).trim().toLowerCase();
    if (q.length < 2) continue;
    var i = hay.indexOf(q);
    while (i !== -1) { total++; i = hay.indexOf(q, i + q.length); }
  }
  return total;
};

// findable-list-udc phase 2: the flat block OBJECTS a commit's CommitDetail
// feeds to FindableList as `data` (undecorated — __bramFindPlan owns the search
// decoration). Head block (message + stats) then one per file diff. Stable `id`
// keys the inner List in the no-search pass-through.
window.__bramCommitBlockRows = function (commit) {
  var rows = [{
    id: "head", kind: "head",
    message: (commit && commit.message) || "",
    stats: (commit && commit.stats) || null,
    filesCount: ((commit && commit.files) || []).length,
  }];
  var files = (commit && commit.files) || [];
  for (var i = 0; i < files.length; i++) {
    var f = files[i] || {};
    rows.push({
      id: "file:" + i, kind: "file",
      filename: f.filename, additions: f.additions, deletions: f.deletions,
      patch: f.patch,
    });
  }
  return rows;
};
// The marked surface FindableList counts AND the row template highlights (the
// invariant): file blocks mark the raw patch, the head block marks the message.
window.__bramCommitMarkedText = function (row) {
  if (!row) return "";
  return row.kind === "file" ? (row.patch || "") : (row.message || "");
};
// findable-list-udc IssueDetail: flat typed rows for FindableList. Body row
// (block 0) bakes the header fields so the row template never reads issue.value
// from a frozen List-row scope (first-click-stuck-Loading trap); one comment
// row per comment (blocks 1+N).
window.__bramIssueBlockRows = function (issue) {
  var rows = [{
    id: "body", kind: "body",
    body: (issue && issue.body) || "",
    number: issue && issue.number,
    url: (issue && issue.url) || "",
    state: issue && issue.state,
    title: (issue && issue.title) || "",
    author: issue && issue.author,
    createdAt: issue && issue.createdAt,
  }];
  var comments = (issue && issue.comments) || [];
  for (var i = 0; i < comments.length; i++) {
    var c = comments[i] || {};
    rows.push({ id: "comment:" + i, kind: "comment", body: c.body || "", author: c.author });
  }
  return rows;
};
// Marked surface (counted == highlighted): the body text for both kinds.
window.__bramIssueMarkedText = function (row) {
  return (row && row.body) || "";
};
// findable-list-udc HistoryDetail: flat typed rows for FindableList, preserving
// the current section order. Computed metadata is baked in (frozen row-scope
// trap); searchable rows (before/after/feedback-phase) carry `body`, every
// other kind is a zero-match metadata/header row (markedText -> "").
// `openPath` / `openPreview` carry the inline at-commit file view INTO the row
// data. The rowTemplate must read only `$item.*`: referencing a DataSource id
// declared outside the FindableList silently aborts analysis of the whole row
// subtree — the click handler included — so the symptom is a link that does
// nothing rather than an error (2026-08-22). Threading the state through the
// data also re-renders the row on change, which a virtualized list will not do
// for an external variable.
window.__bramHistoryBlockRows = function (g, openPath, openPreview) {
  if (!g) return [];
  var files = window.__bramWorklistItemFiles(g) || [];
  var commitUrl = window.__bramHistoryCommitUrl(g) || "";
  var before = window.__bramHistoryItemFieldMarkdown(g, "before") || "";
  var after = window.__bramHistoryItemFieldMarkdown(g, "after") || "";
  var siblings = (g && g.commitSiblingIds) || [];
  var rows = [{
    id: "header", kind: "header",
    dateRange: window.__bramHistoryDateRangeLine(g),
    phasePath: window.__bramHistoryPhasePath(g),
    filesCount: files.length,
    commitContextLabel: g.commitContextLabel,
    detailsRestoredLabel: g.detailsRestoredLabel,
    commitUrl: commitUrl,
    commitStatus: window.__bramHistoryCommitStatus(g) || "",
  }];
  if (before) rows.push({ id: "before", kind: "before", body: before });
  if (after) rows.push({ id: "after", kind: "after", body: after });
  if (files.length) {
    // history-file-links-local-at-commit: pair each path with the sha this
    // entry records, so the row opens the file as it stood at that commit via
    // `git show`. An entry with no commit -- dropped, or still in flight --
    // has no sha to pin to, and the working copy would answer a different
    // question, wrongly, precisely when the file has since changed. Those rows
    // keep rendering as plain text.
    //
    // The open panel's content is computed HERE rather than read from the
    // DataSource inside the row template: the template is a virtualized
    // subtree, and a name it cannot resolve (a DataSource declared outside the
    // list) silently aborts analysis of the whole subtree -- taking the Link's
    // own onClick with it, so the click did nothing at all.
    var commitSha = (g && g.commitSha) || "";
    var open = openPath || "";
    rows.push({
      id: "files",
      kind: "files",
      files: files.map(function (path) {
        return { path: path, sha: commitSha };
      }),
      openPath: open,
      openLabel: open ? open + " @ " + String(commitSha).slice(0, 7) : "",
      // Formatted here, through the same helper LocalLinkPreview uses, so
      // markdown-vs-code and fence handling cannot drift between surfaces.
      openBody: open && openPreview
        ? window.__bramFormatLocalLinkPreview(openPreview)
        : "",
      openLoading: !!open && !openPreview,
    });
  }
  if (siblings.length) rows.push({ id: "committed", kind: "committed", ids: siblings });
  if (commitUrl) rows.push({ id: "commit", kind: "commit", url: commitUrl });
  rows.push({ id: "phases-header", kind: "phases-header" });
  var phases = (g && g.phases) || [];
  for (var i = 0; i < phases.length; i++) {
    var p = phases[i] || {};
    rows.push({
      id: "phase:" + i, kind: "phase",
      isFeedback: p.kind === "feedback",
      label: window.__bramHistoryPhaseLabel(p) + " · " + (String(p.iso || "").slice(0, 16)),
      body: p.body || "",
      summary: p.summary || "",
    });
  }
  return rows;
};
// Marked surface (counted == highlighted): before / after / feedback-phase body.
window.__bramHistoryMarkedText = function (row) {
  if (!row) return "";
  if (row.kind === "before" || row.kind === "after") return row.body || "";
  if (row.kind === "phase" && row.isFeedback) return row.body || "";
  return "";
};
// ---- Find-in-diff (search-index-commit-diffs iterate) ----
// Walk every term match in document order across rendered DiffView rows.
// Annotation segments are presentation only: concatenate each row before
// matching so a raw-patch occurrence split by word-diff segments is still one
// visible occurrence. Calls visit(rowIdx, rowStart, len, occ). Returns total.
window.__bramDiffWalkMatches = function (rows, terms, visit) {
  var lower = [];
  for (var t = 0; t < terms.length; t++) lower.push(String(terms[t]).toLowerCase());
  var occ = 0;
  for (var r = 0; r < (rows || []).length; r++) {
    var segs = rows[r].segments || [];
    var rowText = "";
    for (var s = 0; s < segs.length; s++) {
      rowText += segs[s].text == null ? "" : String(segs[s].text);
    }
    var hay = rowText.toLowerCase();
    var pos = 0;
    while (pos < hay.length) {
      var best = -1, bestLen = 0;
      for (var q = 0; q < lower.length; q++) {
        var idx = hay.indexOf(lower[q], pos);
        if (idx !== -1 && (best === -1 || idx < best)) { best = idx; bestLen = lower[q].length; }
      }
      if (best === -1) break;
      if (visit) visit(r, best, bestLen, occ);
      occ++;
      pos = best + bestLen;
    }
  }
  return occ;
};

window.__bramDiffFindPlan = function (rows, needle, activeIndex, expectedTotal) {
  rows = rows || [];
  var terms = window.__bramSearchTerms(needle);
  var act = activeIndex == null ? -1 : Number(activeIndex);
  var expected = expectedTotal == null ? null : Number(expectedTotal);
  // Standard 32-bit FNV-1a constants. This is a cheap, non-cryptographic
  // fingerprint for ChangeListener invalidation: annotation content or segment
  // boundaries must change the plan key even when the diff row count does not.
  var FNV1A_OFFSET_BASIS_32 = 0x811c9dc5;
  var FNV1A_PRIME_32 = 0x01000193;
  var hash = FNV1A_OFFSET_BASIS_32;
  var hashText = function (value) {
    var text = String(value == null ? "" : value);
    for (var hi = 0; hi < text.length; hi++) {
      hash ^= text.charCodeAt(hi);
      hash = Math.imul(hash, FNV1A_PRIME_32);
    }
  };
  for (var hr = 0; hr < rows.length; hr++) {
    hashText(rows[hr].kind || "");
    var hsegs = rows[hr].segments || [];
    hashText(hsegs.length);
    for (var hs = 0; hs < hsegs.length; hs++) {
      hashText("|");
      hashText(hsegs[hs].text);
    }
    hashText("\n");
  }
  if (!terms.length || !rows.length) {
    return {
      rows: rows,
      total: 0,
      activeIndex: -1,
      activeRow: -1,
      expectedTotal: expected,
      countMatches: expected == null || expected === 0,
      key: "",
    };
  }

  // Match spans use ROW offsets, not segment offsets. Decoration below maps
  // each overlap back into the original segments, so a single mark may paint
  // across multiple inline Texts without changing its occurrence identity.
  var spans = {};
  var activeRow = -1;
  var total = window.__bramDiffWalkMatches(rows, terms, function (r, start, len, occ) {
    (spans[r] = spans[r] || []).push({ start: start, len: len, occ: occ });
    if (occ === act && activeRow === -1) activeRow = r;
  });
  var decorated = rows.map(function (row, r) {
    var segs = [];
    var rowOffset = 0;
    var rowSpans = spans[r] || [];
    (row.segments || []).forEach(function (seg) {
      var text = seg.text == null ? "" : String(seg.text);
      var segStart = rowOffset;
      var segEnd = segStart + text.length;
      rowOffset = segEnd;
      var list = rowSpans.filter(function (m) {
        return m.start < segEnd && (m.start + m.len) > segStart;
      });
      if (!list.length) { segs.push(seg); return; }
      var pos = 0;
      for (var i = 0; i < list.length; i++) {
        var m = list[i];
        var localStart = Math.max(m.start, segStart) - segStart;
        var localEnd = Math.min(m.start + m.len, segEnd) - segStart;
        // Overlap semantics, unchanged in behaviour but now expressed in
        // Text.segments' vocabulary (xmlui-org/xmlui#3782): the find wins on
        // the matched run, and the word-diff emphasis survives on the
        // fragments either side. The search is live intent; the emphasis is
        // ambient context still visible around it. Colour is no longer baked
        // here — hits resolve backgroundColor-mark(-Active)-Text and variants
        // resolve backgroundColor-mark-<variant>-Text, from the theme.
        if (localStart > pos) segs.push({ text: text.slice(pos, localStart), variant: seg.variant || null });
        segs.push({
          text: text.slice(localStart, localEnd),
          hit: true,
          active: m.occ === act,
        });
        pos = localEnd;
      }
      if (pos < text.length) segs.push({ text: text.slice(pos), variant: seg.variant || null });
    });
    return { kind: row.kind, bg: row.bg, color: row.color, segments: segs };
  });
  return {
    rows: decorated,
    total: total,
    activeIndex: act,
    activeRow: activeRow,
    expectedTotal: expected,
    countMatches: expected == null || expected === total,
    key: activeRow >= 0
      ? ((hash >>> 0) + "|" + String(needle || "") + "|" + act + "|" + activeRow)
      : "",
  };
};

// Compatibility wrappers for compact/legacy callers. DiffView itself consumes
// the canonical plan directly.
window.__bramDiffFindRows = function (rows, needle, activeIndex) {
  return window.__bramDiffFindPlan(rows, needle, activeIndex, null).rows;
};

window.__bramDiffActiveRow = function (rows, needle, activeIndex) {
  return window.__bramDiffFindPlan(rows, needle, activeIndex, null).activeRow;
};

// Reveal one canonical plan. If its row is not mounted, scrollToIndex first;
// DiffView's visibleRangeDidChange callback invokes this again after the List
// reports the row mounted, at which point the active inline slice is revealed.
// Returns true only when that second, mounted phase is complete.
window.__bramDiffRevealPlan = function (listRef, plan, visibleRange) {
  plan = plan || {};
  var r = Number(plan.activeRow);
  var range = visibleRange || (listRef && listRef.getVisibleRange ? listRef.getVisibleRange() : null);
  var start = range && Number(range.startIndex);
  var end = range && Number(range.endIndex);
  var mounted = r >= 0 && start >= 0 && end >= start && r >= start && r <= end;
  try {
    window.logToHost && window.logToHost({
      kind: "iframe-trace",
      subkind: "diff-find-scroll",
      rows: (plan.rows || []).length,
      active: plan.activeIndex == null ? -1 : Number(plan.activeIndex),
      row: r,
      hasRef: !!(listRef && listRef.scrollToIndex),
      mounted: mounted,
      visibleStart: start == null || isNaN(start) ? -1 : start,
      visibleEnd: end == null || isNaN(end) ? -1 : end,
      total: Number(plan.total) || 0,
      expected: plan.expectedTotal == null ? -1 : Number(plan.expectedTotal),
      countMatches: plan.countMatches !== false,
    });
  } catch (e) {}
  if (r < 0 || !listRef || !listRef.scrollToIndex) return false;
  if (!mounted) {
    listRef.scrollToIndex(r);
    return false;
  }
  if (typeof requestAnimationFrame === "function" && typeof document !== "undefined") {
    // scrollToIndex reaches the row top; a wrapped line wraps into many visual
    // rows inside that one tall List row, so a mark deep in it stays off-screen.
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        // Text renders the active hit as <mark data-active="true"> since
        // 0.14.16, so the anchor is the element itself rather than a testId
        // we attached to a hand-built segment Text. Kept (rather than left
        // to Text's own reveal, which also fires) because ours is
        // block:"nearest" — it scrolls the minimum needed inside a tall
        // wrapped row, where block:"center" would jump the row.
        var el = document.querySelector('mark[data-active="true"]');
        if (el && el.scrollIntoView) el.scrollIntoView({ block: "nearest", inline: "nearest" });
      });
    });
  }
  return true;
};

window.__bramDiffScrollToActive = function (listRef, rows, needle, activeIndex) {
  var plan = window.__bramDiffFindPlan(rows, needle, activeIndex, null);
  return window.__bramDiffRevealPlan(listRef, plan, null);
};

// A List/Items row template is an isolated binding scope — it can read $item
// but NOT the enclosing component's reassigned var.* (appliedNeedle/counts/
// cursor). So the search state must ride in the row's data and be read via
// $item. These decorators fold it in; callers rebuild only when the search
// changes (not every render), so the RO-flood fix stays intact. See the
// feedback_xmlui_list_row_scope_isolated learning.

// transcript-find-in-page-v2: match scan over transcript EVENTS (the
// Transcript's row shape). Scans the fields the rows actually render,
// so a match is a visible match.
window.__bramFindMatchingEventIndices = function (events, needle) {
  var terms = Array.isArray(needle) ? needle : window.__bramSearchTerms(needle);
  if (!terms.length || !events || !events.length) return [];
  var lower = [];
  for (var k = 0; k < terms.length; k++) lower.push(String(terms[k]).toLowerCase());
  var out = [];
  for (var i = 0; i < events.length; i++) {
    var ev = events[i] || {};
    var text = [ev.text, ev.summary, ev.name, ev.nameDetail, ev.aiDescription, ev.commandDisplay, ev.description]
      .filter(Boolean).join("\n").toLowerCase();
    if (!text) continue;
    for (var j = 0; j < lower.length; j++) {
      if (text.indexOf(lower[j]) !== -1) { out.push(i); break; }
    }
  }
  return out;
};


// Return a compact, visible excerpt for event kinds whose searchable text is
// otherwise hidden behind a fold or rendered by plain Text (which cannot mark
// substrings). User/assistant prose already has a top-level highlighted
// Markdown, so it needs no duplicate preview.
window.__bramTranscriptFindPreview = function (event, needle) {
  var ev = event || {};
  if (ev.kind === "user" || ev.kind === "text") return "";
  var terms = Array.isArray(needle) ? needle : window.__bramSearchTerms(needle);
  if (!terms.length) return "";
  var text = [ev.text, ev.name, ev.nameDetail, ev.aiDescription, ev.summary, ev.commandDisplay, ev.description]
    .filter(Boolean).join(" · ").replace(/\s+/g, " ").trim();
  if (!text) return "";
  var lower = text.toLowerCase();
  var first = -1;
  var matchLength = 0;
  for (var i = 0; i < terms.length; i++) {
    var term = String(terms[i]).toLowerCase();
    var at = lower.indexOf(term);
    if (at >= 0 && (first < 0 || at < first)) {
      first = at;
      matchLength = term.length;
    }
  }
  if (first < 0) return "";
  // Widened forward so several occurrences within one event fall inside the
  // counted+marked excerpt (occurrence-granular find counts what it shows).
  var start = Math.max(0, first - 80);
  var end = Math.min(text.length, first + matchLength + 600);
  return (start ? "…" : "") + text.slice(start, end) + (end < text.length ? "…" : "");
};

// __bramMarkdownLiteral lived here: it escaped a plain-text find excerpt into
// Markdown so the excerpt could borrow Markdown's <mark> engine, since Text had
// no highlightText. xmlui 0.14.16 (xmlui-org/xmlui#3779) gives Text the same
// highlightText / highlightActiveIndex props, so the six find-preview rows now
// render as Text directly and the escape hop is gone.

// Bake find state into transcript rows (rows are isolated scopes — they
// can't see the outer find vars). Returns NULL when the find is inactive so
// the caller's `findPlan.rows || events` binding falls back to the live events
// array — the hot refetch path pays nothing and never sees stale copies.
// findable-list-udc (phase 1): generalized occurrence-granular find plan.
// A parameterization of __bramTranscriptFindPlan: the per-row canonical
// marked surface is supplied by markedTextFn(row) instead of the hardcoded
// isProse?text:preview logic, and a row MATCHES iff that surface holds >=1
// occurrence (matching == counting == highlighting: the one invariant).
// opts.keying (bool) turns on the cursor-stable-except-active idKey + memo
// (Transcript; thousands of rows). Bounded views leave it off. markedTextFn
// is passed as a window-helper NAME (string) for robustness — function-valued
// XMLUI props into JS are the shakiest link; window helpers are the idiom.
//   returns { rows, total, activeIndex, cursor } or null (no terms).
// One-shot initial scroll to the active match once a plan first has matches.
// The scroll-on-step ChangeListener fires on cursor CHANGE, not at mount, so a
// query seeded at mount (or resolved from cache) left the first match
// unscrolled — inconsistently, depending on whether the commit loaded async
// (a post-mount change that DID fire the listener) or from cache (no change).
// Driven by the List's onVisibleRangeDidChange (the event-driven "rows are laid
// out" signal, no timer). Returns true so the caller can latch its one-shot
// guard var in a single-expression handler.
window.__bramFindableInitScroll = function (listRef, plan) {
  window.__bramFindableScrollReveal(listRef, plan);
  return true;
};
// scrollToIndex reaches the active block's TOP, but xmlui Markdown renders the
// active occurrence as <mark data-active="true"> and does NOT scroll it into
// view (Markdown has no scroll logic). So a mark deep in a tall block (a long
// turn / comment / phase / commit message) stays off-screen. After the block is
// laid out (double-rAF), scrollIntoView the active mark. Only one exists at a
// time; when the active block is a DiffView (Commit file block) there is no
// Markdown mark — this no-ops and DiffView's own reveal handles it.
window.__bramRevealActiveMark = function () {
  if (typeof requestAnimationFrame !== "function" || typeof document === "undefined") return;
  requestAnimationFrame(function () {
    requestAnimationFrame(function () {
      var el = document.querySelector('mark[data-active="true"]');
      if (el && el.scrollIntoView) el.scrollIntoView({ block: "nearest", inline: "nearest" });
    });
  });
};
// Scroll the inner List to the active block, then reveal its active mark. Used
// on the initial scroll and on every block change.
window.__bramFindableScrollReveal = function (listRef, plan) {
  if (plan && plan.total > 0 && listRef && listRef.scrollToIndex) listRef.scrollToIndex(plan.activeIndex);
  window.__bramRevealActiveMark();
};
// Scalar params (keying, cacheId) — NOT an opts object: an inline object
// literal in the XMLUI binding that calls this is the handler-blob anti-pattern
// (docs/developing-bram.md) that can silently abort the binding.
window.__bramFindPlan = function (data, needle, cursor, markedTextName, keying, cacheId) {
  keying = !!keying;
  var terms = window.__bramSearchTerms(needle);
  var arr = Array.isArray(data) ? data : [];
  if (!terms.length) return null;
  var markedTextFn = (markedTextName && window[markedTextName]) ? window[markedTextName] : null;
  var surfaceOf = function (row) {
    if (markedTextFn) { try { return String(markedTextFn(row) || ""); } catch (e) { return ""; } }
    return String((row && (row.text || row.summary)) || "");
  };
  var needleKey = String(needle || "");
  var cacheSlot = "__bramFindPlanCache_" + (cacheId || "default");
  var cache = window[cacheSlot];
  var cacheHit = !!cache && cache.needle === needleKey && cache.data.length === arr.length;
  if (cacheHit) {
    for (var same = 0; same < arr.length; same++) {
      if (cache.data[same] !== arr[same]) { cacheHit = false; break; }
    }
  }
  if (!cacheHit) {
    var matchIndicesBuilt = [];
    var countsBuilt = [];
    var blockOfBuilt = {};
    var surfacesBuilt = {};
    for (var i0 = 0; i0 < arr.length; i0++) {
      var s0 = surfaceOf(arr[i0]);
      var c0 = window.__bramCountOccurrences(s0, terms);
      if (c0 > 0) {
        blockOfBuilt[i0] = matchIndicesBuilt.length;
        matchIndicesBuilt.push(i0);
        countsBuilt.push(c0);
        surfacesBuilt[i0] = s0;
      }
    }
    var totalBuilt = 0;
    for (var c1 = 0; c1 < countsBuilt.length; c1++) totalBuilt += countsBuilt[c1];
    var keySep = String.fromCharCode(0);
    var baseRows = arr.map(function (row, i) {
      var bi = Object.prototype.hasOwnProperty.call(blockOfBuilt, i) ? blockOfBuilt[i] : -1;
      var idBase = (row.id === undefined || row.id === null || row.id === "") ? ("row-" + i) : String(row.id);
      return Object.assign({}, row, {
        __findKey: keying ? (idBase + keySep + "f:" + needleKey) : idBase,
        __markedText: Object.prototype.hasOwnProperty.call(surfacesBuilt, i) ? surfacesBuilt[i] : "",
        __needle: bi >= 0 ? needleKey : "",
        __matchCount: bi >= 0 ? countsBuilt[bi] : 0,
        __activeOcc: -1,
        __blockIdx: bi,
      });
    });
    cache = { needle: needleKey, data: arr, matchIndices: matchIndicesBuilt,
              counts: countsBuilt, total: totalBuilt, rows: baseRows, keying: keying };
    window[cacheSlot] = cache;
  }
  var matchIndices = cache.matchIndices, counts = cache.counts, total = cache.total;
  var cur = Number(cursor) || 0;
  cur = total > 0 ? (((cur % total) + total) % total) : 0;
  var activeIndex = -1, activeLocalOcc = -1, acc = 0;
  for (var k = 0; k < counts.length; k++) {
    if (cur >= acc && cur < acc + counts[k]) { activeIndex = matchIndices[k]; activeLocalOcc = cur - acc; break; }
    acc += counts[k];
  }
  if (activeIndex < 0 && matchIndices.length) { activeIndex = matchIndices[0]; activeLocalOcc = 0; }
  var rows = cache.rows.slice();
  if (activeIndex >= 0) {
    var base = cache.rows[activeIndex];
    rows[activeIndex] = Object.assign({}, base, {
      __findKey: cache.keying ? (base.__findKey + String.fromCharCode(0) + "a:" + activeLocalOcc) : base.__findKey,
      __activeOcc: activeLocalOcc,
    });
  }
  return { rows: rows, total: total, activeIndex: activeIndex, cursor: cur };
};

window.__bramTranscriptFindPlan = function (events, needle, cursor) {
  // Occurrence-granular transcript find (like the Commit/Issue/History
  // detail views). Each matching event is a "block" with ONE canonical
  // marked surface — prose (user/assistant) marks its body text; tool /
  // thinking / notification mark a compact preview excerpt. Count
  // occurrences in exactly that surface so the counter equals the painted
  // <mark>s, run a global cursor over the total, and light the specific
  // occurrence via highlightActiveIndex. Event-granular navigation skipped
  // intra-event occurrences (2026-08-01: first click jumped 1->3 because
  // event[0] had two visible marks); this steps mark-by-mark.
  var terms = window.__bramSearchTerms(needle);
  var arr = Array.isArray(events) ? events : [];
  if (!terms.length) return null;
  // XMLUI re-evaluates the adapter expression when the cursor changes, so
  // the outer events array is often new even though its cached event objects
  // are unchanged. Compare those identities once (cheap O(rows)); only scan
  // strings, count occurrences, make previews, and clone base rows when the
  // needle or an event object actually changed.
  var needleKey = String(needle || "");
  var cache = window.__bramTranscriptFindCache;
  var cacheHit = !!cache && cache.needle === needleKey && cache.events.length === arr.length;
  if (cacheHit) {
    for (var same = 0; same < arr.length; same++) {
      if (cache.events[same] !== arr[same]) { cacheHit = false; break; }
    }
  }
  if (!cacheHit) {
    var matchIndicesBuilt = window.__bramFindMatchingEventIndices(arr, terms);
    var countsBuilt = [];
    var blockOfEventBuilt = {};
    var previewsBuilt = {};
    for (var b = 0; b < matchIndicesBuilt.length; b++) {
      var ei = matchIndicesBuilt[b];
      var ev = arr[ei] || {};
      var isProse = ev.kind === "user" || ev.kind === "text";
      var preview = isProse ? "" : window.__bramTranscriptFindPreview(ev, terms);
      var surface = isProse ? (ev.text || "") : preview;
      countsBuilt.push(window.__bramCountOccurrences(surface, terms));
      blockOfEventBuilt[ei] = b;
      if (!isProse) previewsBuilt[ei] = preview;
    }
    var totalBuilt = 0;
    for (var c = 0; c < countsBuilt.length; c++) totalBuilt += countsBuilt[c];
    var keySep = String.fromCharCode(0);
    var baseRows = arr.map(function (row, i) {
      var bi = Object.prototype.hasOwnProperty.call(blockOfEventBuilt, i) ? blockOfEventBuilt[i] : -1;
      var idBase = (row.id === undefined || row.id === null || row.id === "") ? ("row-" + i) : String(row.id);
      return Object.assign({}, row, {
        __findKey: idBase + keySep + "f:" + needleKey,
        __findPreview: Object.prototype.hasOwnProperty.call(previewsBuilt, i) ? previewsBuilt[i] : "",
        __needle: bi >= 0 ? needleKey : "",
        __activeOcc: -1,
        __blockIdx: bi,
      });
    });
    cache = {
      needle: needleKey,
      events: arr,
      matchIndices: matchIndicesBuilt,
      counts: countsBuilt,
      total: totalBuilt,
      rows: baseRows,
    };
    window.__bramTranscriptFindCache = cache;
  }
  var matchIndices = cache.matchIndices;
  var counts = cache.counts;
  var total = cache.total;
  var cur = Number(cursor) || 0;
  cur = total > 0 ? (((cur % total) + total) % total) : 0;
  // Locate the active block + the active occurrence WITHIN it, so the row
  // key can stay cursor-stable for every row except the active one. Baking
  // the global cursor into every key (the first cut) remounted all visible
  // rows per step — each re-parsing its Markdown — which is what felt
  // sluggish and let fast clicks outpace rendering. Now a step changes at
  // most two keys (the row losing active, the row gaining it).
  var activeEventIndex = -1, activeLocalOcc = -1, acc = 0;
  for (var k = 0; k < counts.length; k++) {
    if (cur >= acc && cur < acc + counts[k]) {
      activeEventIndex = matchIndices[k];
      activeLocalOcc = cur - acc;
      break;
    }
    acc += counts[k];
  }
  if (activeEventIndex < 0 && matchIndices.length) { activeEventIndex = matchIndices[0]; activeLocalOcc = 0; }
  // A cursor step now copies only the array plus the active row. Every other
  // decorated object is reused, preserving List identity and avoiding an
  // O(rows) object rebuild on every click.
  var rows = cache.rows.slice();
  if (activeEventIndex >= 0) {
    var activeBase = cache.rows[activeEventIndex];
    rows[activeEventIndex] = Object.assign({}, activeBase, {
      __findKey: activeBase.__findKey + String.fromCharCode(0) + "a:" + activeLocalOcc,
      __activeOcc: activeLocalOcc,
    });
  }
  if (window.__bramIframeTrace) {
    window.__bramIframeTrace("transcript-find-plan", {
      events: rows.length, matches: matchIndices.length, occurrences: total,
      cursor: cur, activeEvent: activeEventIndex, terms: terms.length,
      cacheHit: cacheHit,
    });
  }
  return { rows: rows, total: total, activeEventIndex: activeEventIndex, cursor: cur };
};

window.__bramProjectedLastExchange = function (payload) {
  var turns = (payload && payload.turns) || [];
  var lastUser = null;
  var lastAssistantText = "";
  for (var i = 0; i < turns.length; i++) {
    var t = turns[i] || {};
    if (t.notification) continue;
    if (t.role === "user") {
      lastUser = {
        userText: t.text || "",
        userImages: t.images || [],
        assistantText: "",
      };
    } else if (t.role === "assistant") {
      var parts = [];
      var entries = t.entries || [];
      for (var j = 0; j < entries.length; j++) {
        var e = entries[j] || {};
        if (e.kind === "text" && e.text) parts.push(e.text);
      }
      var text = parts.join("\n\n").trim();
      if (text) {
        lastAssistantText = text;
        if (lastUser) lastUser.assistantText = text;
      }
    }
  }
  return {
    lastAssistantText: { text: lastAssistantText },
    lastExchange: lastUser || { userText: "", userImages: [], assistantText: "" },
  };
};

// ---- Subagent visibility (surface-subagent-activity-in-pane) ----
// The Transcript viewport switch is an inline ternary in Transcript.xmlui
// (not a helper here) so the hot-reloaded markup keeps working against a
// running binary that predates this file.

// Footer chip label: description (fallback agentType), truncated, with a
// running/finished glyph.
window.__bramAgentChipLabel = function (agent) {
  if (!agent) return "";
  var label = agent.description || agent.agentType || agent.agentId || "";
  if (label.length > 28) label = label.slice(0, 27) + "…";
  return label + (agent.finished ? " ✓" : " ●");
};

// "claude-fable-5" → "Fable 5", "claude-haiku-4-5-20251001" → "Haiku 4.5":
// strip the vendor prefix and date suffix, capitalize the family, join
// version parts with dots. Display-only; tooltips keep the raw id.
window.__bramPrettyModel = function (model) {
  if (!model) return "";
  var raw = String(model);
  if (/^gpt[-.]/i.test(raw)) return raw.replace(/^gpt/i, "GPT");
  var s = raw.replace(/^claude-/, "").replace(/-\d{8}$/, "");
  var parts = s.split("-");
  if (!parts.length) return model;
  var family = parts[0].charAt(0).toUpperCase() + parts[0].slice(1);
  var nums = parts.slice(1).filter(function (p) { return p !== ""; });
  return nums.length ? family + " " + nums.join(".") : family;
};

// Main-chip tooltip: base text plus the main session's current model
// (roster's mainModel, host-extracted from the session tail).
window.__bramMainChipTooltip = function (roster) {
  var base = "Show the main conversation in the Transcript tab";
  var m = roster && roster.mainModel;
  return m ? base + " — " + m : base;
};

// Chip / overflow-item tooltip: type, description, and the model the
// subagent ran on (host-extracted from the transcript head).
window.__bramAgentChipTooltip = function (agent) {
  if (!agent) return "";
  var s = (agent.agentType || "agent") + ": " + (agent.description || agent.agentId || "");
  if (agent.model) s += " — " + agent.model;
  return s;
};

// Dismissible footer subagent chips (dismissible-subagent-chips): a set of
// dismissed agent ids so a finished subagent's chip can be hidden from the
// footer strip without deleting anything host-side (the roster keeps tracking
// it). Persisted to localStorage (subagent-dismiss-recoverable) so a dismissal
// survives reload/relaunch. Agent ids are unique per dispatch, so a stale id
// from an old session never matches a new session's roster —
// __bramVisibleFooterAgents still shows a genuinely-new session's agents in
// full, preserving the original "fresh roster per session" behavior. The
// "N hidden" footer control restores dismissed panes, so persistence is not a
// black hole. Bounded to the most recent __BRAM_DISMISSED_AGENTS_CAP ids so
// the set can't grow without limit. Stored as a JSON array under one key.
var __BRAM_DISMISSED_AGENTS_KEY = "bram.dismissedAgentIds";
var __BRAM_DISMISSED_AGENTS_CAP = 500;

window.__bramRestoreDismissedAgents = function () {
  var raw = "";
  try { if (window.localStorage) raw = localStorage.getItem(__BRAM_DISMISSED_AGENTS_KEY) || ""; } catch (e) {}
  if (!raw) return [];
  try {
    var arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (e) { return []; }
};

// Persist the dismissed set (capped to the most recent ids) and return the
// capped array the caller should keep.
function __bramPersistDismissedAgents(list) {
  var capped = Array.isArray(list) ? list.slice(-__BRAM_DISMISSED_AGENTS_CAP) : [];
  try {
    if (window.localStorage) {
      if (capped.length) localStorage.setItem(__BRAM_DISMISSED_AGENTS_KEY, JSON.stringify(capped));
      else localStorage.removeItem(__BRAM_DISMISSED_AGENTS_KEY);
    }
  } catch (e) {}
  return capped;
}

// Append agentId to the dismissed set, persist, and return the new (capped)
// array (the XMLUI caller assigns the result back to its var — same shape as
// __bramDismissSendNotice).
window.__bramDismissAgent = function (dismissed, agentId) {
  var list = Array.isArray(dismissed) ? dismissed.slice() : [];
  if (agentId && list.indexOf(agentId) === -1) list.push(agentId);
  return __bramPersistDismissedAgents(list);
};

// Restore (un-dismiss) one agent; persist and return the new dismissed array.
window.__bramRestoreAgent = function (dismissed, agentId) {
  var list = Array.isArray(dismissed) ? dismissed.filter(function (id) { return id !== agentId; }) : [];
  return __bramPersistDismissedAgents(list);
};

// Restore every dismissed agent; clears the set and returns [].
window.__bramRestoreAllAgents = function () {
  return __bramPersistDismissedAgents([]);
};

// The footer roster minus dismissed ids. Drives the strip's when, the
// top-3 Items, and the "+N more" dropdown so a dismissal promotes the next
// agent up from overflow. Returns the raw agents array untouched when
// nothing is dismissed.
window.__bramVisibleFooterAgents = function (roster, dismissed) {
  var agents = (roster && roster.agents) || [];
  if (!dismissed || !dismissed.length) return agents;
  return agents.filter(function (a) {
    return dismissed.indexOf(a && a.agentId) === -1;
  });
};

// The dismissed agents still present in the current roster — drives the
// "N hidden" recovery control (count + restore menu). Empty when nothing
// hidden is in the live roster, so the control is absent unless there is
// something to recover.
window.__bramDismissedInRoster = function (roster, dismissed) {
  var agents = (roster && roster.agents) || [];
  if (!dismissed || !dismissed.length) return [];
  return agents.filter(function (a) {
    return a && dismissed.indexOf(a.agentId) !== -1;
  });
};

// Count of not-yet-finished entries in the footer subagent roster
// (surface-delegated-work-in-flight). Deliberately dismissal-blind — an
// agent still running is still running whether or not its chip is hidden,
// so this counts against the raw roster, not __bramVisibleFooterAgents.
// Feeds headerFinishedLabel's "· N subagent(s) working" suffix via a
// $props value threaded from Main.xmlui (see FooterAgentStatus.xmlui).
window.__bramRunningSubagentCount = function (roster) {
  var agents = (roster && roster.agents) || [];
  var n = 0;
  for (var i = 0; i < agents.length; i++) {
    if (agents[i] && !agents[i].finished) n++;
  }
  return n;
};

// Footer session-info line with the transcript viewport spliced in after
// the provider token: "CLAUDE · Main · july5 · id …" or
// "CLAUDE · subagent: <description> · july5 · id …". The viewport lives
// HERE rather than in chip styling so dropdown-overflow agents get the
// same selection indicator as chip agents.
window.__bramFooterSessionLine = function (session, agentId, roster) {
  var meta = window.__bramSessionMetaLine(session) || "";
  var agents = (roster && roster.agents) || [];
  var mainModel = roster && roster.mainModel;
  // Zero-subagent sessions still get the plain meta line unless we have
  // the main model to report; a bare "Main" is footer noise.
  if (!agentId && agents.length === 0 && !mainModel) return meta;
  var view = "Main";
  if (agentId) {
    var match = null;
    for (var i = 0; i < agents.length; i++) {
      if (agents[i].agentId === agentId) { match = agents[i]; break; }
    }
    view = "subagent: " + ((match && (match.description || match.agentType)) || agentId);
    if (match && match.model) view += " (" + window.__bramPrettyModel(match.model) + ")";
  } else if (mainModel) {
    view = "Main (" + window.__bramPrettyModel(mainModel) + ")";
  }
  if (!meta) return view;
  var sp = meta.indexOf(" ");
  if (sp < 0) return meta + " · " + view;
  return meta.slice(0, sp) + " · " + view + " ·" + meta.slice(sp);
};

// One-line header for a subagent view (Transcript header + inline peek),
// from the /__turns?agent= envelope.
window.__bramSubagentHeaderLine = function (payload) {
  if (!payload || !payload.agentId) return "";
  var label = payload.description || payload.agentId;
  var qual = [];
  if (payload.agentType) qual.push(payload.agentType);
  if (payload.model) qual.push(payload.model);
  var type = qual.length ? " (" + qual.join(" · ") + ")" : "";
  return "Subagent" + type + ": " + label + " — " + (payload.finished ? "finished" : "running…");
};

// Passive send-ledger notice (esc/resend redesign phase 3). Returns the
// status-note text for the most recent RESOLVED ledger entry within the
// last 10 minutes, or "" for silence. No action buttons by design:
// recovery is automatic (restore / trust-gated auto-resend), and
// landed-then-aborted gets silence.
// The ledger entry a notice would be about: latest resolved. Shared by
// the notice text builder and the dismissal key
// (esc-banner-dismissable).
function __bramLatestResolvedLedgerEntry(payload) {
  var entries = (payload && payload.entries) || [];
  var latest = null;
  for (var i = 0; i < entries.length; i++) {
    var e = entries[i];
    if (!e || !e.resolvedAtMs) continue;
    if (!latest || e.resolvedAtMs > latest.resolvedAtMs) latest = e;
  }
  return latest;
}

// Key identifying the current notice for dismissal: the producing
// ledger entry's id. A dismissed key hides THAT notice only; a new
// resolved entry (new id) notices normally.
window.__bramSendLedgerNoticeKey = function (payload) {
  var latest = __bramLatestResolvedLedgerEntry(payload);
  return (latest && latest.id) || "";
};

window.__bramDismissSendNotice = function (key) {
  __bramWriteLS("bram.sendNoticeDismissed", key || "");
  return key || "";
};

window.__bramRestoreSendNoticeDismissed = function () {
  return __bramReadLS("bram.sendNoticeDismissed", "");
};

// Banner dismissed-version restore (banner-dismissed-flash-on-load): read
// synchronously in the App var default so the dismissed version is known on the
// very first render — no async gap where the banner flashes before onInit's
// read lands. Mirrors __bramRestoreSendNoticeDismissed. (The tool-descriptions
// banner's twin retired with retire-tool-desc-launch-banner; its stale
// localStorage key is simply never read again.)
//
// update-banner-dismiss-is-session-scoped: sessionStorage, NOT localStorage.
// The X means "not now", and localStorage made it mean "never, on this whole
// machine". Three properties combined badly: nothing ever cleared the value;
// the tools pane runs at ONE origin, so a dismissal in the main window also
// blanked the banner in every other instance including fresh scratch projects;
// and `latest` comes from the GitHub API with no override, so nothing could
// make the gate pass again. A user who clicked X once had permanently
// forfeited one-click update for that release.
//
// Recovery was worse than it looks, which is why an escape hatch was not the
// fix: the value is not a top-level key. __bramReadLS uses dot-path semantics
// (see __bramSplitKey), so it lived at
// JSON.parse(localStorage.bram).updateBannerDismissedVersion, and the obvious
// localStorage.removeItem("bram.updateBannerDismissedVersion") is a no-op.
//
// sessionStorage fixes all three at once: per-window, so instances stop
// interfering; cleared on relaunch, which is the natural cadence for an update
// prompt; and synchronous, so the no-flash property above still holds. Anyone
// currently stuck by the old localStorage value is freed by this change — it is
// simply never read again, the same disposition the tool-descriptions key has.
window.__bramRestoreUpdateBannerDismissed = function () {
  try {
    return sessionStorage.getItem("bram.updateBannerDismissedVersion") || "";
  } catch (e) {
    return "";
  }
};

window.__bramDismissUpdateBanner = function (version) {
  var v = version || "";
  try {
    sessionStorage.setItem("bram.updateBannerDismissedVersion", v);
  } catch (e) {}
  return v;
};

// worklist-shared-file-split-hint: the Worklist already shows WHICH other item
// touches a file (the "shared with" column, fed by the host's sharedWith on
// changedFiles). It does not say what to do about it, and the commit gate
// stages whole files -- so approving one entangled item alone carries the
// other's changes into that commit. From the pane the only inferable options
// are "commit together" or "give up on separate commits"; separating the
// overlapping changes first is a third, and it was invisible.
//
// The dismiss is keyed on the OVERLAP, not on a version (the tool-desc idiom)
// and not on time. Dismiss silences this overlap; a later, different overlap
// raises a fresh banner. Same reasoning as the compaction banner's
// episode-keyed dismiss: a situational warning that never returns is worse
// than one that never appeared, because absence stops meaning anything.
// "A", "A and B", "A, B and C"
window.__bramJoinNames = function (names) {
  var n = names || [];
  if (!n.length) return "";
  if (n.length === 1) return n[0];
  if (n.length === 2) return n[0] + " and " + n[1];
  return n.slice(0, -1).join(", ") + " and " + n[n.length - 1];
};

// Entanglements worth reporting, grouped by path: [{ path, ids, tier }],
// changed tier first.
//
// MATERIALITY GATE. Begun-ness is the gate; having-changed-it is the TIER.
// The first version of this banner fired on declared overlap between items
// with no work behind them, and told the user that "committing either one on
// its own would include the other's changes" while both sat at +0 -0 on the
// shared path: a consequence with no changes behind it, stated as present
// fact. A warning the reader cannot verify is how a banner earns being
// ignored.
//
// The fix for that was to require two BEGUN items -- items the user approved
// to do exactly this work. Requiring changes ON TOP of that was one step too
// far, and it suppressed the case where the warning is worth most (live
// 2026-08-22: two begun items both listing Worklist.xmlui at +0 -0, banner
// silent). Once both have written to a path, the mixing already happened and
// the remedy is manual separation. Before either writes, the remedy is free --
// commit the first, then start the second. So an unchanged path is not a
// non-entanglement; it is the same entanglement while it is still cheap, and
// it gets its own sentence saying so.
//
// A plain `proposed` item still triggers nothing, which is what the original
// rationale was actually protecting: two intentions, either free to revise
// its `files` list before any work happens.
window.__bramWorklistOverlapGroups = function (items, claim) {
  var list = items || [];
  var byPath = {};
  var i, j;
  for (i = 0; i < list.length; i++) {
    var item = list[i];
    var files = (item && item.changedFiles) || [];
    // BEGUN is the attribution proxy, and it is a proxy because Bram records
    // no per-item hunk attribution anywhere. `changedFiles` counts are
    // per-PATH disk truth: every item declaring a path reports that path's
    // total uncommitted change, so two items declaring the same file both
    // show the same numbers even when only one of them did the work (live
    // case 2026-08-22: parallel-begin-single-claimant and history-file-links
    // both reported +70 on lib.rs; all 70 were the latter's).
    //
    // So "which items changed this path" is not answerable. "Which items
    // could have" is: an item that has never been approved has not run, and
    // cannot have contributed. Same host facts __bramWorklist2Begun uses --
    // status, a live claim, an approved authorization -- never agent-state
    // inference.
    if (!window.__bramWorklist2Begun(item, claim)) continue;
    for (j = 0; j < files.length; j++) {
      var f = files[j];
      if (!f) continue;
      if (!byPath[f.path]) byPath[f.path] = { ids: {}, added: 0, removed: 0 };
      byPath[f.path].ids[item.id] = true;
      // Per-PATH totals, so every sharer reports the same numbers. Taking the
      // max rather than summing is the point: these are the same disk facts
      // seen twice, not two contributions to add up.
      byPath[f.path].added = Math.max(byPath[f.path].added, f.added || 0);
      byPath[f.path].removed = Math.max(byPath[f.path].removed, f.removed || 0);
    }
  }
  var out = [];
  var paths = Object.keys(byPath).sort();
  for (i = 0; i < paths.length; i++) {
    var entry = byPath[paths[i]];
    var ids = Object.keys(entry.ids).sort();
    // TWO or more begun items on the path. One begun item alongside another's
    // un-started intention is not an entanglement: committing the first
    // sweeps in nothing, because the second has not run.
    if (ids.length < 2) continue;
    out.push({
      path: paths[i],
      ids: ids,
      added: entry.added,
      removed: entry.removed,
      tier: entry.added > 0 || entry.removed > 0 ? "changed" : "planned",
    });
  }
  // Changed first: an entanglement that already exists outranks one that
  // has not happened yet.
  out.sort(function (a, b) {
    if (a.tier !== b.tier) return a.tier === "changed" ? -1 : 1;
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  });
  return out;
};

// Appends the shared-file commit choice to the feedback the gate buttons send.
// Folded into the existing actions rather than given its own submit button --
// the same reasoning as the close-on-commit dialog's `close-issue:` lines, and
// the pane convention against a third decision point beside Approve/Drop.
//
// Selection remains literal. If an unselected begun claimant shares a path,
// the agent must isolate that neighbour before committing exactly the chosen
// ids. With several selected ids, `split` additionally asks for one commit per
// selected item; `together` keeps the selected set in one commit.
window.__bramSelectionHasUnselectedShared = function (items, sel, claim) {
  var list = items || [];
  var chosen = {};
  (sel || []).forEach(function (id) { chosen[id] = true; });
  if (!Object.keys(chosen).length) return false;
  var byId = {};
  list.forEach(function (item) { if (item) byId[item.id] = item; });
  return list.some(function (item) {
    if (!item || !chosen[item.id]) return false;
    return (item.changedFiles || []).some(function (file) {
      return (file.sharedWith || []).some(function (otherId) {
        var other = byId[otherId];
        return !chosen[otherId] && other && window.__bramWorklist2Begun(other, claim);
      });
    });
  });
};

window.__bramSelectionHasBegunShared = function (items, sel, claim) {
  var list = items || [];
  var chosen = sel || [];
  return list.some(function (item) {
    return item && chosen.indexOf(item.id) !== -1 &&
      window.__bramItemChangedSplit(item, list, claim).sharedDeclared.length > 0;
  });
};

window.__bramWithShareMode = function (text, mode, items, sel, claim) {
  var body = text || "";
  var chosen = sel || [];
  var hasShared = window.__bramSelectionHasBegunShared(items, chosen, claim);
  if (chosen.length > 1 && mode === "split" && hasShared) {
    return (
      (body ? body + "\n\n" : "") +
      "split-shared-files: separate the selected items' shared-file changes " +
      "so each selected item commits on its own; do not include unselected items."
    );
  }
  if (!window.__bramSelectionHasUnselectedShared(items, chosen, claim)) return body;
  return (
    (body ? body + "\n\n" : "") +
    "selected-only-shared-files: isolate the selected items' shared-file changes from " +
    "unselected claimants before committing; commit exactly the selected item ids" +
    (chosen.length > 1 ? " together." : ".")
  );
};

// One ROW per entangled path, for the banner's table: { path, disk,
// claimantIds, tier }.
//
// This replaced one prose sentence per path. Two things were wrong with the
// sentences, and only the second is about reading.
//
// ACCURACY. They asserted attribution -- "committing X will also carry changes
// from Y" -- which Bram cannot know. `changedFiles` counts are per-PATH, and
// no per-item record of who wrote what exists anywhere. Live 2026-08-22:
// helpers.js sat at +68 -21, ALL of it one item's work, while its co-claimant
// had written nothing; the banner named that bystander as a contributor.
// Begun-ness was the proxy for "could have contributed" and it is far too
// weak -- an approved item that has done nothing looks identical to one that
// did everything.
//
// So the rows assert QUANTITIES, never causes. "+68 -21" and "one commit takes
// all of it" are true whoever wrote them, and check against the number already
// on the row. Attribution is the user's half: they asked for the work, so they
// know whose it is. Guessing at their half and getting it wrong is worse than
// leaving it to them.
//
// READING. Prose grew a paragraph per PAIR and restructured itself on every
// selection tick, so it had to be re-parsed rather than re-scanned. Rows grow
// one line per FILE and are selection-independent -- which the accuracy fix
// makes correct as well as calmer, since without an attribution claim the
// consequence no longer varies with what is ticked: anything claiming this
// path takes all of it.
//
// The banner keeps this job rather than the row's "shared with" column,
// because that column lives inside the per-row expanded file table. With rows
// collapsed it is invisible, and entanglement is a relation BETWEEN rows --
// the banner is the only surface that sees them all at once.
window.__bramWorklistOverlapRows = function (items, claim) {
  var groups = window.__bramWorklistOverlapGroups(items, claim);
  var rows = [];
  for (var i = 0; i < groups.length; i++) {
    var g = groups[i];
    var changed = g.tier === "changed";
    rows.push({
      path: g.path,
      tier: g.tier,
      disk: changed ? "+" + g.added + " \u2212" + g.removed : "nothing yet",
      // The ids themselves, not a joined string: each is rendered separately
      // so it can carry its item's colour (__bramItemColor).
      claimantIds: g.ids,
    });
  }
  return rows;
};

// Should the one-commit / commit-each choice be offered at all?
//
// Only when BOTH hold: this selection could commit, and that commit would
// sweep a path another begun item claims. Without a committable item the
// question is premature -- nothing is about to be committed. Without a shared
// path there is nothing to split.
//
// It was previously shown whenever the Shared files table was, which is a
// scope mismatch: the table is BOARD-wide (every overlap, whatever is ticked)
// while this is SELECTION-scoped (what happens when this commits). Stacking a
// selection-scoped control under a board-wide table is what made it hard to
// predict when it should appear.
window.__bramSelectionCommitSweepsShared = function (items, sel, claim) {
  if ((sel || []).length < 2) return false;
  if (!window.__bramSelectionAllCommittable(items, sel, claim)) return false;
  var chosen = sel || [];
  var list = items || [];
  return list.some(function (i) {
    return (
      chosen.indexOf(i.id) !== -1 &&
      window.__bramItemChangedSplit(i, list, claim).shared.length > 0
    );
  });
};

// issue-329: the Commits tab's phase-2 close banner ("close queued …
// completes when the commit reaches the default branch"), with pending-since
// per issue. The filer's preference, verbatim: visibility over a button —
// "a status that cannot distinguish 'fine' from 'stuck' is the shape we are
// now wary of." With the issues-poll sweep bounding staleness to about one
// poll interval, a pending-since more than a couple of minutes old is
// self-announcing as stuck. Returns "" when nothing is in phase 2; the
// markup's `when` keys on that, keeping the attribute expressions single
// calls instead of the inline filter chains this replaces.
window.__bramCloseQueueBanner = function (queue, commits) {
  var pending = (queue && queue.pending) || [];
  var rows = commits || [];
  var phase2 = pending.filter(function (p) {
    return !rows.some(function (c) {
      return (
        !c.pushed &&
        (c.pendingCloses || []).some(function (x) {
          return x.issue === p.issue;
        })
      );
    });
  });
  if (!phase2.length) return "";
  var names = phase2.map(function (p) {
    var t = p.createdAtMs ? new Date(p.createdAtMs).toLocaleTimeString() : "";
    return "#" + p.issue + (t ? " (pending since " + t + ")" : "");
  });
  return (
    "close queued for " + names.join(", ") +
    " — completes when the commit reaches the default branch"
  );
};

window.__bramSendLedgerNotice = function (payload, dismissedKey) {
  var entries = (payload && payload.entries) || [];
  var nowMs = (payload && payload.nowMs) || Date.now();
  var staleTerminalInput = !!(payload && payload.staleTerminalInput);
  var latest = __bramLatestResolvedLedgerEntry(payload);
  if (!latest) return "";
  if (dismissedKey && latest.id === dismissedKey) return "";
  if (nowMs - latest.resolvedAtMs > 2 * 60 * 1000) return "";
  // The user moving on dismisses the note: any send injected after this
  // entry resolved means they have re-engaged (2026-07-03: "too sticky").
  for (var j = 0; j < entries.length; j++) {
    var n = entries[j];
    if (n && n.injectedAtMs > latest.resolvedAtMs) return "";
  }
  var label = "";
  try {
    var pv = String(latest.preview || "").replace(/\s+/g, " ").trim();
    if (pv.length > 40) pv = pv.slice(0, 40) + "…";
    if (pv) label = " “" + pv + "”";
  } catch (e) { label = ""; }
  if (latest.state === "stranded" && latest.cause === "user") {
    return "Your message" + label + " didn’t go through — it’s back in the composer, edit and send when ready.";
  }
  if (latest.state === "landed" && latest.cause === "retracted") {
    return "Your message" + label + " was interrupted before the agent took it — it's back in the composer.";
  }
  if (latest.state === "landed" && latest.cause === "aborted") {
    // interrupted-banner-verifies-restore: staleTerminalInput is now a
    // VERIFIED claim (host matched the message fragment after the tail's
    // last composer marker — a transcript echo no longer counts). When the
    // text was not observed in the composer, say that truth instead of
    // instructing the user to press Enter on an input that may be empty
    // (2026-09-06: "That's a lie. It wasn't back.").
    if (!staleTerminalInput)
      return "Response interrupted — your message" + label + " was not restored to the terminal input. Its text is kept in the send ledger (Status tab) if you want it back.";
    // Truthful semantics (2026-07-06 esc drill): the send landed as a
    // transport record but Esc made Claude Code retract and re-stage it
    // in the TERMINAL input, unanswered — and the copy there prepends
    // onto the next terminal-submitted send if not cleared.
    return "Response interrupted — your message" + label + " is back in the terminal input, unanswered. Press Enter there to resend it, or clear it before sending anything new.";
  }
  if (latest.state === "landed" && latest.retried) {
    return "A lost send" + label + " was redelivered automatically.";
  }
  if (latest.state === "stranded" && latest.cause === "mechanical") {
    return "A send" + label + " did not reach the agent; its text is kept in the send ledger (Status tab).";
  }
  return "";
};

// Apply a host `send-restore` event: the restored text goes into the
// composer box and the persisted draft, so the restore survives remounts.
// Aborted restores (p.aborted === true) skip when the composer already holds
// a non-empty draft that differs from the restored text — an already-delivered
// message must not clutter a new draft (2026-07-03 acid test). Strand restores
// (p.aborted falsy) always apply: the text was never delivered and must be
// preserved. When a restore does apply and the composer is non-empty, the
// restored text is appended below a blank line rather than overwriting.
// Called from Main.xmlui / Workspace.xmlui ChangeListeners with their
// respective composer refs.
// toast-issue-closed-on-push: format the host's `issues-closed-on-push`
// payload and toast it. `evtValue` is the bramSubscribeTauriEvent wrapper
// `{ tick, payload }`; the host payload is `{ issues: [n, ...] }`.
window.__bramToastIssuesClosed = function (evtValue, toastApi) {
  var issues = (evtValue && evtValue.payload && evtValue.payload.issues) || [];
  if (!issues.length || typeof toastApi !== "function") return;
  var list = issues
    .map(function (n) {
      return "#" + n;
    })
    .join(", ");
  toastApi("Closed " + list + " on push");
};

window.__bramApplySendRestore = function (snapshot, box) {
  try {
    window.__bramIframeTrace("send-restore", {
      stage: "enter",
      hasSnapshot: !!snapshot,
      hasText: !!(snapshot && snapshot.payload && snapshot.payload.text),
      hasBox: !!box,
    });
  } catch (e) {}
  var p = snapshot && snapshot.payload;
  var text = p && p.text;
  if (!text) return;
  var existing = "";
  try {
    if (box && typeof box.value === "string") {
      existing = box.value;
    } else if (box && box.value != null) {
      existing = String(box.value);
    }
  } catch (e) { existing = ""; }
  var aborted = !!(p && p.aborted);
  if (aborted && existing.trim() !== "" && existing !== text) {
    try {
      window.__bramIframeTrace("send-restore", { chars: text.length, skipped: true });
    } catch (e) {}
    return;
  }
  var merged;
  if (existing.trim() === "" || existing === text) {
    merged = text;
  } else {
    merged = existing + "\n\n" + text;
  }
  __bramWriteLS("bram.worklistMessageDraft", merged);
  if (box && typeof box.setValue === "function") {
    try { box.setValue(merged); } catch (e) {}
  }
  try {
    window.__bramIframeTrace("send-restore", { chars: text.length, merged: existing.trim().length > 0 });
  } catch (e) {}
};

// Stable identity key for the Transcript's pending-menu row: present /
// tool / option keys. Drives the row-lifecycle trace below and is the
// natural candidate for re-keying the synthetic menu event (vs the
// constant "menu-pending") if the stale-row-reuse hypothesis is confirmed.
window.__bramMenuRowKey = function (menu) {
  return window.__bramMenuIdentity(menu);
};

// Trace pending-menu state against Transcript mount state. The menu remains
// interleaved on Transcript; other tabs do not render the full menu.
window.__bramTraceMenuRow = function (menu, stage) {
  try {
    window.__bramIframeTrace("transcript-menu-row", {
      stage: stage || "change",
      present: !!menu,
      tool: (menu && menu.tool) || "",
      options: (menu && menu.options && menu.options.length) || 0,
      key: window.__bramMenuRowKey(menu),
      // Whether the Transcript page is currently mounted. The host setter
      // fires this trace regardless of active tab, so `present:true` with
      // `transcriptMounted:false` means the host pushed a menu while
      // Transcript was unmounted.
      transcriptMounted: !!window.__bramTranscriptMounted,
    });
  } catch (e) {}
};

// Set by Transcript.xmlui on mount/unmount so __bramTraceMenuRow can record
// whether a host menu push happened while Transcript was active. On mount,
// also emit a `stage:mount` row carrying the current menu key.
// Refs menu-miss-mount-instrumentation.
window.__bramSetTranscriptMounted = function (mounted) {
  window.__bramTranscriptMounted = !!mounted;
  if (mounted) window.__bramTraceMenuRow(window.bramAgentMenu, "mount");
  else window.__bramTraceMenuRow(window.bramAgentMenu, "unmount");
};

// The menu-row trace lives in window.__bramApplyAgentMenu (the canonical
// menu-state setter), NOT as a separate pty-menu-changed subscriber — a
// fourth subscriber just joined the churning subscribeTauriEvent registry
// and never reliably fired. See subscribe-tauri-event-churn for that smell.

// Immutable toggle of an id in an array (proven per-item expand pattern,
// matching Workspace's expandedItemIds — avoids object-literal var inits
// that XMLUI's expression engine mishandles).
window.__bramToggleInArray = function (arr, id) {
  arr = arr || [];
  if (arr.indexOf(id) >= 0) return arr.filter(function (x) { return x !== id; });
  return arr.concat([id]);
};

// ai-describe (haiku-command-descriptions): tool-row expand handler.
// Toggles the fold like __bramToggleInArray, and on OPEN of a
// command-bearing entry fires a describe request. The host route is
// double-gated (ai.describeCommands flag + ANTHROPIC_API_KEY) and
// answers {ok:false, reason} when off, so this is a no-op by default.
// Sent even when an agent-authored description exists — the host prompt
// keeps a good description unchanged and upgrades a weak one (approval
// feedback on haiku-command-descriptions).
window.__bramDescribeRequested = {};
// describe-edit-write-rows: the describable text per row. Bash/exec
// (and apply_patch's patch) carry commandDisplay; Edit/MultiEdit carry
// the host-reconstructed diff; a markdown Write carries its content in
// commandMarkdown; other Writes fall back to the summary (tool + path
// — with the agent-context rider, enough for an intent line).
//
// codex-tooluse-describe: everything else falls back to the row summary
// GENERICALLY — no per-tool enumeration. The host summarizer (st_tool_summary)
// probes a candidate arg-field list for unknown tools, so a Codex web/browse
// call, a Task dispatch, a WebFetch, an MCP call, etc. carry real material
// in `summary` instead of a bare name. Read/Grep/Glob are subsumed (their
// summary already carries the target). The floor: skip when `summary` is just
// the tool name (the host probe found nothing) — feeding Haiku a bare name
// would spend a call on a useless line.
window.__bramDescribeMaterial = function (item) {
  if (!item) return "";
  if (item.commandDisplay) return item.commandDisplay;
  var editFamily = { Edit: 1, MultiEdit: 1, NotebookEdit: 1, Write: 1, apply_patch: 1 };
  if (editFamily[item.name]) return item.diff || item.commandMarkdown || item.summary || "";
  var summary = item.summary || "";
  return summary && summary !== item.name ? summary : "";
};
window.__bramExpandTool = function (arr, item) {
  // Arm the xmlui freeze-probe window (xmlui-eval-probe-vendor): for 1.5s
  // after an expansion click, the instrumented vendored engine emits
  // xmlui-probe trace lines (op=eval|stmt|action) synchronously via
  // logToHost → invoke, so a hang in the ensuing re-render names its exact
  // site — the trace stream ends AT the hanging statement/binding/action.
  // Default OFF in shipped Bram (gate-eval-trace-probe-arming): the probe
  // now rides in the vendored bundle, so an unconditional arm would build
  // ~1,300 detail strings per expand feeding a sink that drops them (traces
  // off) or floods the trace log (traces on). Set window.__bramEvalProbeArm
  // = true from the console to restore the expand-trigger while hunting.
  try { if (window.__bramEvalProbeArm) window.__xmluiEvalTraceUntil = performance.now() + 1500; } catch (e) {}
  var next = window.__bramToggleInArray(arr, item && item.id);
  try {
    var opening = item && item.id && (next || []).indexOf(item.id) >= 0;
    if (opening && window.__bramDescribeMaterial(item)) {
      window.__bramRequestCommandDescription(item);
    }
  } catch (e) { /* expand must never fail on describe plumbing */ }
  return next;
};

// Fire-and-forget describe POST. The route is synchronous (the host
// serves each request on its own thread); on success the description is
// spliced straight into the accumulated projection via
// __bramPatchProjectedToolDescription (no refetch — see that helper for
// why a windowed refetch can't deliver it). The host also caches the
// result, so later full projections re-serve it via the overlay. Per-id
// dedupe keeps re-expands from re-POSTing while a request is in flight
// (the host also dedupes).
// The prose nearest BEFORE the tool entry — the agent's stated intent
// for the call ("Let me check whether ..."), the highest-signal
// describe context. Scans backward across TURN BOUNDARIES: Claude
// records prose + tool_use in one assistant turn, but Codex records
// each function_call as its own turn with the prose in a PRECEDING
// turn (the 2026-07-09 ctx=0 finding — same-turn-only lookup found
// nothing on codex). A user turn is an acceptable source too: when a
// command directly answers the user's request, that request IS the
// intent. Lookback bounded to 4 turns; tail-capped to 400 chars so the
// sentence closest to the call survives. Empty when the entry isn't in
// the main projection (e.g. subagent views).
window.__bramDescribeContextForTool = function (toolId) {
  var prev = window.getProjectedTurns && window.getProjectedTurns();
  if (!prev || !prev.turns || !toolId) return "";
  var turns = prev.turns;
  for (var i = 0; i < turns.length; i++) {
    var entries = (turns[i] && turns[i].entries) || [];
    for (var k = 0; k < entries.length; k++) {
      var e = entries[k];
      if (!e || e.kind !== "tool" || e.id !== toolId) continue;
      var prose = "";
      var ti = i, ei = k - 1, back = 0;
      while (!prose && back <= 4 && ti >= 0) {
        var es = (turns[ti] && turns[ti].entries) || [];
        for (var p = ei; p >= 0; p--) {
          var t = es[p];
          if (t && t.kind === "text" && t.text) { prose = t.text; break; }
        }
        if (!prose && ti > 0) {
          // Fall back to the turn's own text (user turns carry their
          // message there rather than in a text entry).
          var tt = turns[ti - 1] && turns[ti - 1].text;
          if (tt) { prose = tt; }
        }
        ti -= 1;
        ei = ((turns[ti] && turns[ti].entries) || []).length - 1;
        back += 1;
      }
      return prose.length > 400 ? prose.slice(-400) : prose;
    }
  }
  return "";
};

// describe-backfill-observability: backfill pressure counters. One
// coalesced `describe-load` line per second while requests are issued or
// in flight — issued_1s (this window), inflight (fetches out minus
// completions), requested_total (session lifetime). The 2026-07-30 boot
// storm (~375 calls in 4 min saturating the main thread during typing)
// was only reconstructible by cross-correlating three other subkinds;
// this draws the curve directly, with a denominator.
var __describeLoad = { inflight: 0, issued: 0, total: 0, armed: false };
// describe-backfill-pacing lever (b): hold NEW describe requests while the
// user typed within the last 2s. In-flight requests complete normally (they
// self-cap at ~3); held ones drain in order once typing quiets. Keyed to
// keystrokes, not focus — see the input-probe comment.
var __describeHold = [];
var __describeHoldArmed = false;
var __DESCRIBE_TYPING_HOLD_MS = 2000;
function __bramDescribeTypingRecent() {
  return Date.now() - (window.__bramLastKeydownAt || 0) < __DESCRIBE_TYPING_HOLD_MS;
}
function __bramDescribeHoldDrain() {
  __describeHoldArmed = false;
  if (!__describeHold.length) return;
  if (__bramDescribeTypingRecent()) {
    __describeHoldArmed = true;
    setTimeout(__bramDescribeHoldDrain, 500);
    return;
  }
  var held = __describeHold;
  __describeHold = [];
  for (var i = 0; i < held.length; i++) {
    try { window.__bramRequestCommandDescription(held[i].item, held[i].onDone, true); } catch (e) { /* ignore */ }
  }
}
// describe-backfill-pacing lever (a): the patch-flush coalesce window widens
// to 2s while the backfill is active (anything in flight or just issued),
// returning to 400ms when the storm drains. At the 2026-07-30 storm's rates
// this cuts ~189 flushes to ~40 and settle churn from ~23% to ~5%, while a
// completed description still lands within ~2s.
window.__bramDescribeFlushWindowMs = function () {
  return (__describeLoad.inflight > 0 || __describeLoad.issued > 0) ? 2000 : 400;
};
function __bramDescribeLoadTick() {
  __describeLoad.armed = false;
  if (__describeLoad.issued === 0 && __describeLoad.inflight === 0 && !__describeHold.length) return;
  try {
    window.__bramIframeTrace("describe-load", {
      issued_1s: __describeLoad.issued,
      inflight: __describeLoad.inflight,
      requested_total: __describeLoad.total,
      held: __describeHold.length,
      window_ms: window.__bramDescribeFlushWindowMs(),
    });
  } catch (e) { /* ignore */ }
  __describeLoad.issued = 0;
  if (__describeLoad.inflight > 0) {
    __describeLoad.armed = true;
    setTimeout(__bramDescribeLoadTick, 1000);
  }
}
function __bramDescribeLoadIssued() {
  __describeLoad.issued++;
  __describeLoad.total++;
  __describeLoad.inflight++;
  window.__bramDescribeInflight = __describeLoad.inflight;
  if (!__describeLoad.armed) {
    __describeLoad.armed = true;
    setTimeout(__bramDescribeLoadTick, 1000);
  }
}
function __bramDescribeLoadDone() {
  if (__describeLoad.inflight > 0) __describeLoad.inflight--;
  window.__bramDescribeInflight = __describeLoad.inflight;
}
// clickable-update-from-banner: the banner's Update now / Relaunch buttons.
// Fire-and-forget POSTs — progress rides the self-update-changed Tauri event
// into the selfUpdate DataSource refetch, so no response handling here beyond
// tracing a refusal (409 while an update runs, or no release info).
window.__bramStartSelfUpdate = function () {
  window
    .fetch("/__self-update", { method: "POST" })
    .then(function (r) { return r.json().catch(function () { return {}; }); })
    .then(function (j) {
      if (j && j.ok === false) {
        window.__bramIframeTrace("self-update", { op: "start-refused", error: String(j.error || "") });
      }
    })
    .catch(function (e) {
      window.__bramIframeTrace("self-update", { op: "start-error", error: String(e) });
    });
};
window.__bramSelfUpdateRelaunch = function () {
  window
    .fetch("/__self-update/relaunch", { method: "POST" })
    .catch(function (e) {
      window.__bramIframeTrace("self-update", { op: "relaunch-error", error: String(e) });
    });
};
window.__bramRequestCommandDescription = function (item, onDone, fromHold) {
  var id = item && item.id;
  var done = function () { try { if (onDone) onDone(); } catch (e) {} };
  if (!id) { done(); return; }
  if (!fromHold) {
    if (window.__bramDescribeRequested[id]) { done(); return; }
    window.__bramDescribeRequested[id] = true;
    // Typing-hold (describe-backfill-pacing): queue instead of fetch while
    // keystrokes are contending for the main thread; the latch above keeps
    // duplicate callers out while the request waits.
    if (__bramDescribeTypingRecent()) {
      __describeHold.push({ item: item, onDone: onDone });
      if (!__describeHoldArmed) {
        __describeHoldArmed = true;
        setTimeout(__bramDescribeHoldDrain, 500);
      }
      return;
    }
  }
  __bramDescribeLoadIssued();
  window
    .fetch("/__describe-command", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: id,
        // These client slices mirror the host budget to avoid oversized
        // transport. The Rust handler remains authoritative and applies
        // Unicode-safe caps after redaction and before hashing/API submission.
        name: String(item.name || "").slice(0, 80),
        // Material, not just commandDisplay (describe-edit-write-rows):
        // diffs and patches can be large, so bound every prompt field.
        command: (window.__bramDescribeMaterial(item) || "").slice(0, 2000),
        description: String(item.description || "").slice(0, 240),
        // Intent prose + result head (iterate 2026-07-08): the agent's
        // stated reason for the call and what it produced — Haiku
        // describes intent, not just syntax. Both capped; the host
        // re-caps defensively.
        context: window.__bramDescribeContextForTool(id),
        result: String(item.result || "").slice(0, 240),
      }),
    })
    .then(function (r) { return r.json(); })
    .then(function (res) {
      __bramDescribeLoadDone();
      if (res && res.ok && res.description) {
        window.__bramDescribeUnavailable = false;
        // Direct splice into the accumulated projection — see
        // __bramPatchProjectedToolDescription for why a refetch can't
        // deliver this. Patch misses (subagent view: the entry isn't in
        // the main projection) are covered by the host's
        // subagents-changed emit, which refetches the subagent stream
        // with the overlay applied.
        window.__bramPatchProjectedToolDescription(id, res.description);
      } else {
        // Latch so the eager scan stops re-POSTing every broadcast; a
        // manual expand bypasses the latch and can revive. Feature off
        // (disabled/no-key) OR a persistent API error the host marked
        // non-retryable (billing 400 / auth 401 / 403 —
        // describe-latch-persistent-api-errors: a credit-less key produced
        // 3,704 identical 400s in one session because this branch used to
        // only latch disabled/no-key). Transient errors (429/5xx/transport)
        // arrive retryable !== false and keep retrying.
        if (
          res &&
          (res.reason === "disabled" ||
            res.reason === "no-key" ||
            res.retryable === false)
        ) {
          window.__bramDescribeUnavailable = true;
        } else {
          window.__bramForgetDescribeSeen(id);
        }
        // Allow a retry on a later expand (disabled/no-key/persistent/
        // transient error all clear the per-id guard; the latch above,
        // when set, is what actually stops the eager re-POST).
        delete window.__bramDescribeRequested[id];
      }
      done();
    })
    .catch(function () {
      __bramDescribeLoadDone();
      delete window.__bramDescribeRequested[id];
      window.__bramForgetDescribeSeen(id);
      done();
    });
};
// Slim change-signal tick (issue-214 candidate #5). The latest-tail
// content pipeline is retired: talk-session-changed IS the signal that
// the live session file changed, and its only remaining consumer is the
// projected-turns refetch (coalesced + reference-preserved above), so
// each tick just requests one. Cross-provider ticks are dropped, like
// the old pipeline's provider-mismatch guard: a background provider's
// session write cannot change the active /__turns projection, and
// refetching a multi-MB projection for it is pure waste (2026-07-07
// codex esc wedge: this session's writes were triggering 1.2 s fetches
// of the codex rollout). The function keeps its historical name —
// Main.xmlui calls it on init and on provider changes with a
// getProvider reading the active provider; re-invocation is idempotent
// because subscribeTalkSessionChange unsubscribes the prior handler
// stored under the same key.
var __bramTurnsTickLast = { sid: "", len: -1 };
window.startBramLatestJsonlPush = function (getProvider) {
  window.__bramRefetchProjectedTurns("provider-start");
  return window.subscribeTalkSessionChange(
    "__bramTurnsTickUnsub",
    function (correlationId, atHostMs, payload) {
      var active = "";
      try {
        var v = typeof getProvider === "function" ? getProvider() : "";
        if (typeof v === "string") active = v;
      } catch (e) {}
      if (active && payload && payload.provider && active !== payload.provider) return;
      // Zero-delta suppression — the old cursor pipeline's dedupe
      // without the cursors: watchers fire 2-3 events per session
      // write, and a tick whose session file identity AND byte size
      // are unchanged cannot change the projection. Append-only JSONL
      // makes (sid, len) a safe change key. Ticks without a usable
      // len (len < 0) always refetch.
      var sid = (payload && payload.sid) || "";
      var len = (payload && typeof payload.len === "number") ? payload.len : -1;
      if (sid && len >= 0 && sid === __bramTurnsTickLast.sid && len === __bramTurnsTickLast.len) return;
      __bramTurnsTickLast = { sid: sid, len: len };
      window.__bramRefetchProjectedTurns("tick");
    }
  );
};

// Continuous variant: register a callback that fires on every resize
// (window.resize event inside the iframe) plus once with the current
// size at registration time. Use this when you want a readout that
// stays live, not just a snapshot on a button click.
var __rpsSubscriber = null;
var __rpsListenerAttached = false;
function __rpsBroadcast() {
  if (typeof __rpsSubscriber === "function") {
    __rpsSubscriber({
      width: Math.round(window.innerWidth || 0),
      height: Math.round(window.innerHeight || 0),
    });
  }
}
window.subscribeRightPaneSize = function (callback) {
  __rpsSubscriber = typeof callback === "function" ? callback : null;
  if (!__rpsSubscriber) return;
  __rpsBroadcast();
  if (!__rpsListenerAttached) {
    window.addEventListener("resize", __rpsBroadcast);
    __rpsListenerAttached = true;
  }
};
// Push local commits from the branch the UI last rendered and refetch
// relevant DataSources when the push completes, so branch and pushed
// state refresh without a manual reload.
window.gitPush = function (commitsDs, statusDs, branch, onError) {
  var invoke = getTauriInvoke();
  // issue-343: evidence before the guard — the old order (guard, then
  // nothing) made a dead Push click perfectly silent, which was Andrew's
  // exact signature on #343's second surface. And the dead case is now
  // user-visible through the pushError banner the button already renders,
  // naming the recovery lever the field event proved.
  window.__bramIframeTrace("click", {
    target: "push",
    op: invoke ? "act" : "no-invoke",
    branch: branch || "",
  });
  if (!invoke) {
    if (typeof onError === "function") {
      onError("Push could not reach the host (IPC unavailable) — reload the pane or restart Bram");
    }
    return;
  }
  invoke("git_push", { branch: branch || null })
    .then(function () {
      if (commitsDs && typeof commitsDs.refetch === "function") {
        commitsDs.refetch();
      }
      if (statusDs && typeof statusDs.refetch === "function") {
        statusDs.refetch();
      }
    })
    .catch(function (e) {
      window.logToHost({ kind: "git-push", phase: "err", error: String(e) });
      if (typeof onError === "function") onError(String(e));
    });
};
// issue-90-q-page: Queue tab helpers. The entries array is the component's
// working copy; every mutator returns a NEW array (xs reactivity needs the
// identity change) and schedules a debounced host save to /__queue/save so
// notes survive reloads and restarts. A synchronous sessionStorage mirror
// closes the debounce window on iframe refresh: restore prefers that unsaved
// snapshot, retries the host write, and clears it only after the matching
// payload is acknowledged. Sends ride toTurn — send-gate, send ledger, and
// strand forensics apply like any other pane send.
var __BRAM_QUEUE_RECOVERY_KEY = "bram.agent-message-queue.unsaved";
// issue-324: the base version this pane last read from /__queue. null until
// hydration, so a pre-hydration save carries no version and the host refuses
// it — the populated queue cannot be clobbered by a click-before-hydrate.
window.__bramQueueVersion = null;
var __bramQueueSaveTimer = null;
function __bramQueueScheduleSave(entries) {
  var snapshot = entries || [];
  var payload = JSON.stringify({
    entries: snapshot,
    version: window.__bramQueueVersion,
  });
  try {
    sessionStorage.setItem(__BRAM_QUEUE_RECOVERY_KEY, payload);
  } catch {}
  if (__bramQueueSaveTimer) clearTimeout(__bramQueueSaveTimer);
  __bramQueueSaveTimer = setTimeout(function () {
    __bramQueueSaveTimer = null;
    fetch("/__queue/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload,
    })
      .then(function (response) {
        if (response.status === 409) {
          // A concurrent writer (or a stale base) moved the version. Do not
          // retry blind — that is the overwrite this guard exists to prevent.
          window.logToHost({ kind: "queue-save", phase: "stale-version" });
          throw new Error("queue save refused: stale-version");
        }
        if (!response.ok) throw new Error("queue save returned " + response.status);
        response
          .json()
          .then(function (r) {
            if (r && typeof r.version === "number") window.__bramQueueVersion = r.version;
          })
          .catch(function () {});
        // queue-remount-stale-hydration: do NOT clear the snapshot on save.
        // It is the session-scoped source of truth (overwritten on every
        // mutation); clearing it handed remount back to the /__queue
        // DataSource's stale-while-revalidate cache, which reverted adds
        // (item gone) and deletes (item back). The snapshot is cleared only
        // by the browser session ending; the host /__queue is the
        // cross-restart backstop, read when the snapshot is absent.
      })
      .catch(function (e) {
        window.logToHost({ kind: "queue-save", phase: "err", error: String(e) });
      });
  }, 400);
}
// worklist-diff-shared-file-provenance: per-file diff sections, attached to
// their own row in the item's files table rather than concatenated into one
// body below it. Concatenation is what let a shared file's neighbouring hunks
// read as this item's work, and what turned a single large untracked file into
// a wall (the live specimen: conventions.md as `@@ -0,0 +1,2144 @@`).
//
// Returns the section for one path, or null when there is nothing to open --
// which is also how the row decides whether to offer a chevron at all.
// The files column sizes to its LONGEST path, computed from the data rather
// than measured from the DOM. Sibling HStacks in an Items loop cannot share a
// content-derived width the way Table Columns can -- XMLUI has no grid-track
// layout and no cross-row sizing outside Table (searched 2026-09-01; the how-to
// corpus returns nothing for "longest"/"widest", and content auto-sizing is
// documented only for Column inside Table). Since the column is monospace,
// character count IS the width, so `ch` is exact and no measurement is needed.
// Clamped so one pathological path cannot squeeze the other two columns out.
window.__bramFilesColumnCh = function (rows) {
  var longest = 0;
  var list = rows || [];
  for (var i = 0; i < list.length; i++) {
    var p = (list[i] && list[i].path) || "";
    if (p.length > longest) longest = p.length;
  }
  if (!longest) return 24;
  var withChevron = longest + 3; // "▸ " prefix plus a trailing breath
  return Math.max(24, Math.min(72, withChevron));
};

window.__bramDiffForPath = function (item, path) {
  var rows = (item && item.diffByFile) || [];
  for (var i = 0; i < rows.length; i++) {
    if (rows[i] && rows[i].path === path) return rows[i];
  }
  return null;
};

// Expansion is keyed by "<itemId>::<path>", never by position. ExpandableItem's
// own state is positional, so inside a loop whose membership changes -- and this
// list changes as work proceeds -- an open row silently transfers to whatever
// now occupies that index. Controlled, id-keyed expansion is the pattern the
// item rows above already use, applied one level down.
window.__bramDiffExpansionKey = function (itemId, path) {
  return String(itemId) + "::" + String(path);
};
window.__bramFlipDiffExpansion = function (keys, itemId, path) {
  var k = window.__bramDiffExpansionKey(itemId, path);
  var list = (keys || []).slice();
  var at = list.indexOf(k);
  if (at === -1) list.push(k);
  else list.splice(at, 1);
  return list;
};
window.__bramDiffExpanded = function (keys, itemId, path) {
  return (keys || []).indexOf(window.__bramDiffExpansionKey(itemId, path)) !== -1;
};

// issue-326: refuse a board older than one already rendered.
//
// /__worklist already serves worklist.json's `version` (the field the guards
// enforce on writers); no consumer looked at it. Three DataSources read this
// route -- the board, the gate bar and the Queue's target list -- so an
// overtaken response could repaint an older board over a newer one, and the
// gate bar is where that stops being cosmetic and becomes an offered action:
// Mary's specimen was "Will commit" on an item the prune had already removed
// (#323 -> #326).
//
// Wired through DataSource's `transformResult` so all three consumers share
// one definition of "newer" without touching their 31 binding sites:
// https://www.xmlui.org/docs/reference/components/DataSource
//
// RECOVERABILITY IS THE DESIGN CONSTRAINT, not an afterthought. #324 shipped a
// monotonic guard with no escape and turned a rare race into permanent, total
// failure. The version can legitimately go backwards -- worklist.json deleted
// or absent (Bram serves an empty default, version 0), restored from a backup,
// or a malformed write dropping the field -- so a naive high-water mark would
// freeze the board forever. Two escapes, both local to this helper:
//   1. a decrease larger than RESET_DELTA is a board RESET, not a stale
//      response (an overtaken reply is off by one or two; a reset by hundreds);
//   2. after MAX_REFUSALS consecutive refusals the mark re-arms and the payload
//      is accepted. A frozen board is worse than a stale one.
var __BRAM_WL_RESET_DELTA = 50;
var __BRAM_WL_MAX_REFUSALS = 3;
var __bramWlSeen = null;
var __bramWlAccepted = null;
var __bramWlRefusals = 0;
window.__bramWorklistAccept = function (payload) {
  if (!payload || typeof payload !== "object") return payload;
  var v = typeof payload.version === "number" ? payload.version : null;
  if (v === null) return payload; // nothing to reason with; never withhold
  if (__bramWlSeen === null || v >= __bramWlSeen) {
    __bramWlSeen = v;
    __bramWlAccepted = payload;
    __bramWlRefusals = 0;
    return payload;
  }
  if (__bramWlSeen - v > __BRAM_WL_RESET_DELTA) {
    window.__bramIframeTrace("worklist-accept", { op: "reset", seen: __bramWlSeen, got: v });
    __bramWlSeen = v;
    __bramWlAccepted = payload;
    __bramWlRefusals = 0;
    return payload;
  }
  if (__bramWlRefusals >= __BRAM_WL_MAX_REFUSALS) {
    window.__bramIframeTrace("worklist-accept", { op: "refuse-cap", seen: __bramWlSeen, got: v });
    __bramWlSeen = v;
    __bramWlAccepted = payload;
    __bramWlRefusals = 0;
    return payload;
  }
  __bramWlRefusals += 1;
  window.__bramIframeTrace("worklist-accept", { op: "stale", seen: __bramWlSeen, got: v, refusals: __bramWlRefusals });
  // Keep the board already rendered -- discard, never blank.
  return __bramWlAccepted || payload;
};
window.__bramQueueRestore = function (hostEntries, hostVersion) {
  // issue-324: capture the host's version at hydration; every later save
  // carries it as its precondition base. Before this runs, __bramQueueVersion
  // stays null and no save can land (host refuses a version-less write).
  window.__bramQueueVersion = typeof hostVersion === "number" ? hostVersion : 0;
  window.__bramIframeTrace("queue", { op: "hydrate", version: window.__bramQueueVersion });
  var fallback = Array.isArray(hostEntries) ? hostEntries : [];
  var raw = "";
  try {
    raw = sessionStorage.getItem(__BRAM_QUEUE_RECOVERY_KEY) || "";
  } catch {}
  if (!raw) return fallback;
  try {
    var recovered = JSON.parse(raw);
    if (!recovered || !Array.isArray(recovered.entries)) throw new Error("invalid entries");
    // queue-remount-stale-hydration: the snapshot is now persistent, so
    // reschedule the host write only when it is genuinely ahead of the
    // host — otherwise every tab switch would emit a redundant save.
    if (JSON.stringify(recovered.entries) !== JSON.stringify(fallback)) {
      __bramQueueScheduleSave(recovered.entries);
    }
    return recovered.entries;
  } catch (e) {
    try { sessionStorage.removeItem(__BRAM_QUEUE_RECOVERY_KEY); } catch {}
    window.logToHost({ kind: "queue-restore", phase: "err", error: String(e) });
    return fallback;
  }
};
window.__bramQueueUpdate = function (entries, idx, text) {
  var next = (entries || []).slice();
  if (!next[idx]) return entries;
  next[idx] = Object.assign({}, next[idx], {
    text: String(text == null ? "" : text),
    updatedAtMs: Date.now(),
  });
  // queue-mutation-trace: length only, never content (queue prose is
  // user-authored and can carry secrets — same discipline as the describe
  // redaction and the send-forensics previews).
  window.__bramIframeTrace("queue", { op: "update", id: next[idx].id || "", chars: String(next[idx].text || "").length });
  __bramQueueScheduleSave(next);
  return next;
};
window.__bramQueueSendMode = function (entry) {
  return entry && entry.sendMode === "iterate" ? "iterate" : "message";
};
window.__bramQueueSetSendMode = function (entries, idx, sendMode, worklistItems) {
  var next = (entries || []).slice();
  if (!next[idx]) return entries;
  var mode = sendMode === "iterate" ? "iterate" : "message";
  var targetItemId = String(next[idx].targetItemId || "");
  var items = worklistItems || [];
  if (mode === "iterate" && !items.some(function (item) { return item.id === targetItemId; })) {
    targetItemId = items.length ? String(items[0].id || "") : "";
  }
  next[idx] = Object.assign({}, next[idx], {
    sendMode: mode,
    targetItemId: targetItemId,
    updatedAtMs: Date.now(),
  });
  __bramQueueScheduleSave(next);
  return next;
};
window.__bramQueueSetTargetItem = function (entries, idx, targetItemId) {
  var next = (entries || []).slice();
  if (!next[idx]) return entries;
  next[idx] = Object.assign({}, next[idx], {
    targetItemId: String(targetItemId || ""),
    updatedAtMs: Date.now(),
  });
  __bramQueueScheduleSave(next);
  return next;
};
window.__bramQueueAdd = function (entries) {
  // issue-324 belt (the markup disables + until entries !== null): if called
  // pre-hydration, do NOT fabricate a one-blank queue and schedule a save
  // that would clobber the stored contents — return the input untouched.
  if (entries === null || entries === undefined) return entries;
  var next = (entries || []).slice();
  var now = Date.now();
  next.unshift({
    id: "q-" + now + "-" + Math.floor(Math.random() * 1e6),
    text: "",
    sendMode: "message",
    targetItemId: "",
    updatedAtMs: now,
  });
  window.__bramIframeTrace("queue", { op: "add", id: next[0].id, chars: 0 });
  __bramQueueScheduleSave(next);
  return next;
};
// suppressTrace: set by __bramQueueSend so a send logs op=send, not a
// second op=delete for the same removal. The Delete button calls with two
// args, so a user delete always traces.
window.__bramQueueRemove = function (entries, idx, suppressTrace) {
  var next = (entries || []).slice();
  var removed = next[idx];
  if (!suppressTrace) {
    window.__bramIframeTrace("queue", { op: "delete", id: (removed && removed.id) || "", chars: String((removed && removed.text) || "").length });
  }
  next.splice(idx, 1);
  __bramQueueScheduleSave(next);
  return next;
};
// __bramQueueReorder: persist a drag-reordered entries array. newOrder comes
// from DndItems' onReorder (the same entry objects, reordered), so we adopt it
// as the new order and save it the same way every other queue mutation does.
window.__bramQueueReorder = function (entries, newOrder) {
  var next = Array.isArray(newOrder) ? newOrder.slice() : (entries || []).slice();
  // queue-mutation-trace: op=reorder, count only — never content (queue prose
  // is user-authored, kept secret-safe like the other queue ops).
  window.__bramIframeTrace("queue", { op: "reorder", count: next.length });
  __bramQueueScheduleSave(next);
  return next;
};
window.__bramQueueCanSendWhenReady = function (entry, ready, worklistItems) {
  if (!ready) return false;
  if (!entry || !String(entry.text || "").trim()) return false;
  if (window.__bramQueueSendMode(entry) !== "iterate") return true;
  var targetItemId = String(entry.targetItemId || "");
  return (worklistItems || []).some(function (item) { return item.id === targetItemId; });
};
window.__bramQueueCanSend = function (entry, status, menu, worklistItems) {
  return window.__bramQueueCanSendWhenReady(
    entry,
    window.__bramQueueReady(status, menu),
    worklistItems
  );
};
window.__bramQueueSend = function (entries, idx, worklistItems) {
  var entry = (entries || [])[idx];
  var text = entry && String(entry.text || "").trim();
  if (!text) return entries;
  var mode = window.__bramQueueSendMode(entry);
  if (mode === "iterate") {
    var targetItemId = String(entry.targetItemId || "");
    var items = worklistItems || [];
    if (!items.some(function (item) { return item.id === targetItemId; })) return entries;
    window.sendIterateWithFeedbackDraft(items, targetItemId, text);
  } else {
    // Include any images pasted onto this item's strip (queue-items-voice-and-
    // image-paste): consume the staged pastes for this item's target and embed
    // their @<path> markers, same as the Worklist message send.
    toTurn(window.__bramWithStagedImageMarkers(text, "queue-item:" + (entry.id || "")));
  }
  window.__bramIframeTrace("queue", { op: "send", id: entry.id || "", mode: mode, chars: text.length });
  return window.__bramQueueRemove(entries, idx, true);
};
// Ready = no open turn (agent-status not "working") and no pending menu.
// Advisory dimming only — the host send-gate remains the enforcement layer
// for a menu racing in at click time.
window.__bramQueueReady = function (status, menu) {
  var working = !!(status && status.state === "working");
  return !working && !menu;
};
window.__bramQueueReadyLabel = function (status, menu) {
  if (menu) return "menu pending — hold";
  if (status && status.state === "working") return "agent working — hold";
  return "ready to send";
};
window.__bramQueueEditedLabel = function (updatedAtMs) {
  var ms = Number(updatedAtMs) || 0;
  if (!ms) return "Last edited —";
  var edited = new Date(ms);
  if (isNaN(edited.getTime())) return "Last edited —";
  return "Last edited " + edited.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
};

// issues-tab-close-via-invoke: manual Close-issue for the Issues tab.
// Rides the issue_close_manual Tauri invoke, NOT an HTTP route — invokes
// are reachable only from Bram's same-origin agent pane (loopback curl and
// the C1-isolated target pane cannot call them), so the H5 close-authority
// contract holds: a clicked button, never an agent channel.
window.__bramCloseIssue = function (number, comment, onDone, onError) {
  var invoke = getTauriInvoke();
  // issue-343: same treatment as gitPush — trace first, and a dead bridge
  // reports through the caller's error surface instead of vanishing.
  window.__bramIframeTrace("click", {
    target: "close-issue",
    op: invoke ? "act" : "no-invoke",
    number: number,
  });
  if (!invoke) {
    if (typeof onError === "function") {
      onError("Close could not reach the host (IPC unavailable) — reload the pane or restart Bram");
    }
    return;
  }
  invoke("issue_close_manual", { number: number, comment: comment || "" })
    .then(function () {
      if (typeof onDone === "function") onDone();
    })
    .catch(function (e) {
      window.logToHost({ kind: "issue-close-manual", phase: "err", error: String(e) });
      if (typeof onError === "function") onError(String(e));
    });
};

// Sessions tab: pending-delete and pending-rename ids persist across
// iframe reloads, so the dim+disable state survives until the user
// explicitly clears it (or the JSONL stops resolving to the same id).
// Two separate keys mirror the in-memory pendingDeletes / pendingRenames
// vars in Sessions.xmlui.
window.loadPendingSessionDeletes = function () {
  try {
    var raw = localStorage.getItem("session-pending-deletes");
    if (!raw) return [];
    var v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch (e) { return []; }
};
window.savePendingSessionDeletes = function (ids) {
  try {
    localStorage.setItem("session-pending-deletes", JSON.stringify(ids || []));
  } catch (e) {}
};
window.loadPendingSessionRenames = function () {
  try {
    var raw = localStorage.getItem("session-pending-renames");
    // Clear on read: the dim is meant to signal "reload Bram to see
    // the new title". A fresh iframe boot means the dim's job is done.
    // Sessions renamed later in this iframe lifetime stay dimmed via
    // the in-memory append in Sessions.xmlui's onSuccess handler.
    localStorage.removeItem("session-pending-renames");
    if (!raw) return [];
    var v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch (e) { return []; }
};
window.savePendingSessionRenames = function (ids) {
  try {
    localStorage.setItem("session-pending-renames", JSON.stringify(ids || []));
  } catch (e) {}
};
// Route external anchors through openExternal and local-file anchors through
// Bram's in-pane preview modal instead of letting the Tauri WebView navigate
// to dead routes. Capture phase so we run before XMLUI's Markdown-internal
// click handlers.
//
// Also routes relative *.md anchors (the MEMORY.md cross-references like
// `[foo.md](memory/foo.md)`) to a callback installed via
// registerContextMemorySelector below. We can't intercept these from
// XMLUI's onClick — the event handler cache deep-clones args, so the DOM
// target / preventDefault are gone by the time the XMLUI expression runs.
// And we can't install the window callback from XMLUI either — the
// scripting engine doesn't expose `window`.
var __contextMemorySelector = null;
window.registerContextMemorySelector = function (fn) {
  __contextMemorySelector = typeof fn === "function" ? fn : null;
};
window.clearContextMemorySelector = function () {
  __contextMemorySelector = null;
};
document.addEventListener("click", function (e) {
  var a = e.target && e.target.closest && e.target.closest("a");
  if (!a) return;
  var href = a.getAttribute("href");
  if (!href) return;
  var linkText = (a.textContent || "").trim().slice(0, 120);
  try {
    window.__bramIframeTrace("local-link-click", {
      stage: "anchor",
      href: href,
      text: linkText,
      tagName: String((e.target && e.target.tagName) || ""),
    });
  } catch (traceErr) {}
  if (href.indexOf("://") === -1 && /\.md(?:[?#].*)?$/i.test(href)) {
    if (typeof __contextMemorySelector === "function") {
      e.preventDefault();
      e.stopPropagation();
      var m = href.match(/([^\/?#]+\.md)(?:[?#]|$)/i);
      var basename = m ? m[1] : "";
      try {
        __contextMemorySelector(basename);
      } catch (err) {
        logToHost({ kind: "memory-link-error", error: String(err && err.message || err) });
      }
      return;
    }
  }
  var localRequest = window.__bramLocalLinkRequestFromHref(href);
  if (localRequest && !localRequest.skip) {
    e.preventDefault();
    e.stopPropagation();
    try {
      window.__bramIframeTrace("local-link-click", {
        stage: "intercept",
        href: href,
        path: localRequest.path || "",
        line: localRequest.line || null,
      });
    } catch (traceErr2) {}
    window.__bramOpenLocalLinkPreview(localRequest);
    return;
  }
  if (localRequest && localRequest.skip) {
    try {
      window.__bramIframeTrace("local-link-click", {
        stage: "skip",
        href: href,
        reason: localRequest.reason || "",
        raw: localRequest.raw || "",
      });
    } catch (traceErr3) {}
  }
  if (/^https?:/i.test(href)) {
    e.preventDefault();
    e.stopPropagation();
    window.openExternal(href);
    return;
  }
}, true);
// search-pin freeze fix (P0 2026-08-16): pin the pane's main scroller only.
// The search pins originally called scrollAllToTop below, whose
// querySelectorAll("*") sweep + per-element scrollHeight reads (each a forced
// layout) + smooth-scroll on every scrollable ran per debounced keystroke —
// observed 1.8s long-tasks per settle on #/search, ending in WebKit recycling
// the frozen page. This targets the App's one real scroll container directly
// and sets scrollTop instantly: O(1) lookup, no layout sweep, no animation
// queue. scrollAllToTop remains for its click-driven callers.
window.__bramScrollMainToTop = function () {
  try {
    var main = document.querySelector('[class*="mainContentArea"]');
    if (main) {
      main.scrollTop = 0;
      return true;
    }
    var root = document.scrollingElement || document.documentElement;
    if (root) root.scrollTop = 0;
    return false;
  } catch (e) {
    return false;
  }
};

// Click-driven; scan the DOM per call.
window.scrollAllToTop = function () {
  var root = document.scrollingElement || document.documentElement || document.body;
  if (root) {
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
  var nodes = document.querySelectorAll("*");
  for (var i = 0; i < nodes.length; i += 1) {
    var el = nodes[i];
    if (!el) continue;
    if (el.scrollHeight > el.clientHeight + 8) {
      try {
        el.scrollTo({ top: 0, behavior: "smooth" });
      } catch (e) {
        el.scrollTop = 0;
      }
    }
  }
};
window.scrollAllToBottom = function () {
  var root = document.scrollingElement || document.documentElement || document.body;
  if (root) {
    window.scrollTo({ top: root.scrollHeight, behavior: "smooth" });
  }
  var nodes = document.querySelectorAll("*");
  for (var j = 0; j < nodes.length; j += 1) {
    var sc = nodes[j];
    if (!sc) continue;
    if (sc.scrollHeight > sc.clientHeight + 8) {
      try {
        sc.scrollTo({ top: sc.scrollHeight, behavior: "smooth" });
      } catch (e) {
        sc.scrollTop = sc.scrollHeight;
      }
    }
  }
};
function getTauriInvoke() {
  try {
    if (window.__TAURI__ && window.__TAURI__.core && typeof window.__TAURI__.core.invoke === "function") {
      return window.__TAURI__.core.invoke.bind(window.__TAURI__.core);
    }
  } catch (e) {}
  try {
    if (window.parent && window.parent.__TAURI__ && window.parent.__TAURI__.core && typeof window.parent.__TAURI__.core.invoke === "function") {
      return window.parent.__TAURI__.core.invoke.bind(window.parent.__TAURI__.core);
    }
  } catch (e) {}
  try {
    if (window.top && window.top.__TAURI__ && window.top.__TAURI__.core && typeof window.top.__TAURI__.core.invoke === "function") {
      return window.top.__TAURI__.core.invoke.bind(window.top.__TAURI__.core);
    }
  } catch (e) {}
  return null;
}
window.addEventListener("message", async (event) => {
  var data = event.data;
  if (!data || data.type !== "inspector-export") return;
  var source = event.source;

  function reply(payload) {
    if (source && typeof source.postMessage === "function") {
      source.postMessage(payload, "*");
    }
  }

  var invoke = getTauriInvoke();
  if (!invoke) {
    reply({ type: "inspector-export-result", ok: false, error: "Tauri IPC unavailable" });
    return;
  }
  try {
    var path = await invoke("save_trace_export", {
      filename: String(data.filename || "xs-trace.json"),
      content: String(data.content || ""),
      mimeType: String(data.mimeType || "application/octet-stream")
    });
    reply({ type: "inspector-export-result", ok: true, path: path });
  } catch (e) {
    logToHost({
      kind: "trace-export-direct-failed",
      error: String((e && e.message) || e),
      at: new Date().toISOString(),
    });
    reply({ type: "inspector-export-result", ok: false, error: String((e && e.message) || e) });
  }
});

// Inspector trace tap (#181). When enabled via the Settings-tab switch
// (traces.inspectorTap in .bram.json), forwards new entries from the
// XMLUI Inspector's window._xsLogs into bram-trace.log as
// [iframe] subkind=inspector-event so they interleave with host traces
// live. Polls at 200 ms with a per-tick cap; overflow emits
// subkind=inspector-overflow. Every field passes through
// __bramTraceSafeValue before IPC; selectivity (filter by category,
// drop per-keystroke noise, etc.) remains a follow-up.
var __inspectorTap = {
  intervalId: null,
  highWater: 0,
  perTickCap: 50,
};
function __inspectorTrace(subkind, fields) {
  try {
    if (typeof window.logToHost !== "function") return;
    var payload = {
      kind: "iframe-trace",
      subkind: subkind,
      at: new Date().toISOString(),
    };
    if (fields && typeof fields === "object") {
      for (var k in fields) {
        if (Object.prototype.hasOwnProperty.call(fields, k)) {
          payload[k] = window.__bramSensitiveTraceKey(k)
            ? "[REDACTED]"
            : window.__bramTraceSafeValue(fields[k], 0);
        }
      }
    }
    window.logToHost(payload);
  } catch (e) {}
}
function __inspectorTapTick() {
  try {
    var logs = window._xsLogs;
    if (!logs || typeof logs.length !== "number") return;
    var total = logs.length;
    if (total <= __inspectorTap.highWater) return;
    var available = total - __inspectorTap.highWater;
    var toSend = Math.min(available, __inspectorTap.perTickCap);
    var t0 = (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
    for (var i = 0; i < toSend; i++) {
      __inspectorTrace("inspector-event", {
        entry: logs[__inspectorTap.highWater + i],
      });
    }
    if (available > toSend) {
      __inspectorTrace("inspector-overflow", {
        dropped: available - toSend,
        totalSeen: total,
      });
      __inspectorTap.highWater = total;
    } else {
      __inspectorTap.highWater += toSend;
    }
    var t1 = (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
    __inspectorTrace("inspector-tap-tick", {
      batch: toSend,
      available: available,
      ms: Math.round((t1 - t0) * 10) / 10,
    });
  } catch (e) {}
}
function __startInspectorTap() {
  if (__inspectorTap.intervalId !== null) return;
  try {
    var logs = window._xsLogs;
    __inspectorTap.highWater =
      logs && typeof logs.length === "number" ? logs.length : 0;
  } catch (e) {
    __inspectorTap.highWater = 0;
  }
  __inspectorTap.intervalId = setInterval(__inspectorTapTick, 200);
}
function __stopInspectorTap() {
  if (__inspectorTap.intervalId === null) return;
  clearInterval(__inspectorTap.intervalId);
  __inspectorTap.intervalId = null;
}
function __applyInspectorTapSetting(enabled) {
  if (enabled) __startInspectorTap();
  else __stopInspectorTap();
}
function __loadInspectorTapSetting() {
  if (typeof window.fetch !== "function") return;
  window
    .fetch("/__settings", { cache: "no-store" })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (s) {
      var enabled = !!(s && s.traces && s.traces.inspectorTap);
      __applyInspectorTapSetting(enabled);
    })
    .catch(function () {});
}
__loadInspectorTapSetting();
try {
  window.subscribeTauriEvent(
    "__bramInspectorTapSettingsUnsub",
    "settings-changed",
    function () { __loadInspectorTapSetting(); }
  );
} catch (e) {}

// Adjustable root font-size for the XMLUI surface (mirrors the terminal-side
// pattern in app/main.js). Buttons in AppHeader call setAppFontSize /
// getAppFontSize. The right pane and the agent tools drawer share origin
// and localStorage; a BroadcastChannel keeps their runtime sizes in lockstep.
(function () {
  var APP_FONT_KEY = "bram.app.fontSize";
  var LEGACY_APP_FONT_KEY = "xmlui-desktop.app.fontSize";
  var APP_FONT_MIN = 10;
  var APP_FONT_MAX = 28;
  var APP_FONT_DEFAULT = 16;

  function clampAppFontSize(n) {
    var v = Math.round(Number(n) || 0);
    if (v < APP_FONT_MIN) v = APP_FONT_MIN;
    if (v > APP_FONT_MAX) v = APP_FONT_MAX;
    return v;
  }

  function applyFontSize(size) {
    try {
      document.documentElement.style.fontSize = size + "px";
    } catch (e) {}
  }

  var bc = null;
  try {
    bc = new BroadcastChannel(APP_FONT_KEY);
    bc.onmessage = function (ev) {
      if (!ev || !ev.data) return;
      applyFontSize(clampAppFontSize(ev.data.size));
    };
  } catch (e) {}

  window.getAppFontSize = function () {
    try {
      var raw = parseInt(
        localStorage.getItem(APP_FONT_KEY) ||
          localStorage.getItem(LEGACY_APP_FONT_KEY) ||
          "",
        10
      );
      return isFinite(raw) ? clampAppFontSize(raw) : APP_FONT_DEFAULT;
    } catch (e) {
      return APP_FONT_DEFAULT;
    }
  };

  window.setAppFontSize = function (n) {
    var size = clampAppFontSize(n);
    applyFontSize(size);
    try {
      localStorage.setItem(APP_FONT_KEY, String(size));
    } catch (e) {}
    if (bc) {
      try { bc.postMessage({ size: size }); } catch (e) {}
    }
    return size;
  };

  window.resetAppFontSize = function () {
    return window.setAppFontSize(APP_FONT_DEFAULT);
  };

  applyFontSize(window.getAppFontSize());
})();

// Surface JS errors and lifecycle events to the host log channel.
window.addEventListener("error", (e) => {
  logToHost({
    kind: "error",
    message: e.message,
    source: e.filename,
    lineno: e.lineno,
    colno: e.colno,
    stack: e.error && e.error.stack,
    at: new Date().toISOString(),
  });
});
window.addEventListener("unhandledrejection", (e) => {
  logToHost({
    kind: "unhandledrejection",
    reason: String(e.reason),
    stack: e.reason && e.reason.stack,
    at: new Date().toISOString(),
  });
});

// ---------------------------------------------------------------------------
// Footer tips (issue-231): one context-driven, dismissible "Tip:" line at the
// footer bottom. Pure functions over snapshots the footer already fetches;
// per-tip dismissal and the global switch persist in localStorage. No timers
// by design — markup re-picks on mount and when the tick bumps (dismiss/next).
//
// Registry fields: `priority` is the pick order — among eligible, not-
// dismissed, not-skipped tips the LOWEST number shows first (spaced by 10 so
// new tips can slot between). Links are optional: `route` is an internal
// deep link (navigate), `url` is external (opened in the system browser via
// openExternal), neither means the tip is informational text only.

// footer-indexing-status: format the /__search-index-status payload for the
// footer's first-row indicator. active_bucket set → "⟳ Indexing <bucket>…";
// idle → "⛁ N indexed". Bucket keys are prettified to plural nouns.
window.__bramFooterIndexBucketLabels = { session: 'sessions', commit: 'commits', issue: 'issues', 'worklist-history': 'history' };
window.__bramFooterIndexLabel = function (status) {
  if (!status) return '';
  var labels = window.__bramFooterIndexBucketLabels;
  var active = status.active_buckets || [];
  if (active.length) {
    var names = active.map(function (b) { return labels[b] || b; });
    // Cold-backfill progress (issue #250): the host publishes per-batch
    // {bucket, done, total} while a long rebuild runs — show it so a
    // multi-minute pass reads as advancing, not just spinning.
    var p = status.progress;
    var suffix = p && p.total ? ' ' + p.done + '/' + p.total : '';
    return 'Indexing ' + names.join(', ') + suffix + '…';
  }
  // Idle: just the indexed total. Per-bucket "+N <bucket>" additions were
  // dropped as noise (footer-drop-per-bucket-additions; history went first in
  // 6884b42) — a growing session re-index made "+N sessions" meaningless, and
  // the commit/issue/history deltas added churn without signal.
  //
  // "Indexed 3,629", not "3,629 indexed": every form this label takes now
  // leads with the verb and trails with the variable part, so the two states
  // read as one sentence changing tense rather than two differently-shaped
  // strings. That is what lets the slot right-align without the label
  // appearing to jump when it flips between counting and working.
  return 'Indexed ' + Number(status.total || 0).toLocaleString();
};

// settings-highlight-deeplink: scroll the setting anchored as
// data-testid="setting-<key>" into view. Called from Settings when it opens (or
// is already open and re-targeted) with ?highlight=<key>; the tint itself is
// reactive markup. Retries across frames until the element is laid out (the
// settings body renders after settingsConfig loads), then scrolls. Frame-based,
// bounded; no-op if the key is empty or never appears.
window.__bramHighlightSetting = function (key) {
  if (!key) return;
  var tries = 0;
  var attempt = function () {
    var el = document.querySelector('[data-testid="setting-' + key + '"]');
    if (el && el.scrollIntoView) {
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      return;
    }
    if (tries++ < 30) requestAnimationFrame(attempt);
  };
  requestAnimationFrame(attempt);
};

window.__bramTipsRegistry = [
  { id: 'tool-descriptions', priority: 10,
    url: 'https://blog.jonudell.net/2026/07/23/agents-that-narrate-their-work-are-the-best-team-players/',
    text: 'Tip: Turn on Tool Descriptions (Settings) to have Haiku enhance the intent headers on tool rows — and add them where Codex leaves none.' },
  { id: 'terminal-toggle', priority: 15,
    text: 'Tip: Use the terminal button in the top toolbar to show or hide the terminal.' },
  { id: 'batch-actions', priority: 20, route: '/worklist2',
    text: 'Tip: Tick several Worklist rows to act on them together.' },
  { id: 'gate-one-click', priority: 22, route: '/worklist2',
    text: "Tip: Use 'Start & commit' to bypass the option to refine." },
  { id: 'gate-shared-message', priority: 24, route: '/worklist2',
    text: "Tip: The Worklist message box applies to whatever button you press. One note fans out to every selected item's feedback." },
  { id: 'queue', priority: 30, route: '/queue?from=tip',
    text: 'Tip: Use the Queue tab to record ideas while an agent works, then send when the agent is ready.' },
  { id: 'session-rename', priority: 40, route: '/sessions?from=tip',
    text: 'Tip: Sessions can be renamed in the Sessions tab. Give the current one a name that matches the project.' },
  { id: 'issue-to-item', priority: 50, route: '/worklist2',
    text: 'Tip: To convert an open issue into a Worklist item, click + New item in the Worklist and pick the issue from the selector.' },
  { id: 'feedback-history', priority: 55, route: '/worklist2',
    text: "Tip: Expand an item's Feedback section to see your past Refine messages for that item, newest first." },
  { id: 'issue-comments-collab', priority: 60,
    url: 'https://blog.jonudell.net/2026/06/17/vibe-coding-as-a-team-sport/',
    text: 'Tip: Use issue comments to communicate with other team members — humans and agents alike.' },
  { id: 'inline-close', priority: 65, route: '/worklist2',
    text: 'Tip: When an in-progress item resolves issues, tickboxes on its row choose which ones close automatically with your next Push.' },
  { id: 'log-first', priority: 70,
    url: 'https://blog.jonudell.net/2026/07/08/dont-infer-behavior-from-code-observe-it-in-logs/',
    text: 'Tip: Tell your agent to record evidence in logs.' },
  { id: 'voice-input', priority: 80,
    url: 'https://blog.jonudell.net/2026/07/16/talking-to-claude-code-and-codex/',
    text: 'Tip: Use voice input to converse more easily with agents.' },
  { id: 'agent-switch', priority: 90,
    text: "Tip: Switch agents to have Claude Code review Codex's work, or vice versa." },
  { id: 'worklist-scope-issue', priority: 100,
    text: "Tip: If a Worklist item's scope gets out of hand, tell the agent to file an issue, then drop the item. You can resurrect it later from the issue and Worklist history." },
  { id: 'paste-screenshot', priority: 110,
    text: 'Tip: Paste a screenshot to show a UI glitch to the agent. It renders in the Worklist and Transcript so you can both see it.' },
  { id: 'iterate-before-approve', priority: 120,
    text: 'Tip: Use Refine to improve an in-progress item.' },
  { id: 'tips-dismiss-interval', priority: 130, route: '/settings?from=tip&highlight=tipsDismissInterval',
    text: "Tip: Use Settings → 'Dismissed tips return after' to control how long a dismissed tip stays hidden." },
];

// The picked tip's link, if any: external url wins, then internal route,
// else '' (informational tip). Markup gates the clickable wrapper on this.
window.__bramTipLink = function (settings, sessions, tick) {
  var t = window.__bramPickTip(settings, sessions, tick);
  return t ? (t.url || t.route || '') : '';
};

window.__bramTipSkips = {}; // session-only "Next" skips; reset on reload

// Dismissals are id -> epoch-ms, expiring after the user-configurable
// interval (bram.tips.dismissInterval: '1d' | '7d' | '30d' | 'forever',
// default one week). A legacy plain-array shape reads as dismissed-now.
function __bramTipDismissedMap() {
  var raw = __bramReadLS('bram.tips.dismissed', '{}');
  try {
    var v = JSON.parse(raw);
    if (Array.isArray(v)) { var m = {}; v.forEach(function (id) { m[id] = Date.now(); }); return m; }
    return (v && typeof v === 'object') ? v : {};
  } catch (e) { return {}; }
}

var __bramTipIntervals = {
  '1m': { ms: 60000, label: '1 minute' },
  '1d': { ms: 86400000, label: '1 day' },
  '7d': { ms: 7 * 86400000, label: '1 week' },
  '30d': { ms: 30 * 86400000, label: '1 month' },
  'forever': { ms: Infinity, label: 'forever' },
};

window.__bramTipsDismissInterval = function () {
  var v = __bramReadLS('bram.tips.dismissInterval', '7d');
  return __bramTipIntervals[v] ? v : '7d';
};

window.__bramSetTipsDismissInterval = function (v) {
  __bramWriteLS('bram.tips.dismissInterval', __bramTipIntervals[v] ? v : '7d');
  return v;
};

window.__bramTipDismissTooltip = function () {
  var v = window.__bramTipsDismissInterval();
  return v === 'forever' ? 'Dismiss this tip forever'
    : 'Dismiss this tip for ' + __bramTipIntervals[v].label;
};

function __bramTipDismissed(id) {
  var at = __bramTipDismissedMap()[id];
  if (!at) return false;
  return (Date.now() - Number(at)) < __bramTipIntervals[window.__bramTipsDismissInterval()].ms;
}

window.__bramTipsEnabled = function () {
  return __bramReadLS('bram.tipsEnabled', '1') !== '0';
};

window.__bramSetTipsEnabled = function (on) {
  __bramWriteLS('bram.tipsEnabled', on ? '1' : '0');
  return !!on;
};

// Search facet-badge initial state: whether the Search tab opens with all four
// facets selected (all on, default) or none (all off). Per-user, not a project
// setting — a personal browse preference must not ride the shared .bram.json.
window.__bramSearchBadgesInitialAllOn = function () {
  return __bramReadLS('bram.searchBadgesInitialAllOn', '1') !== '0';
};
window.__bramSetSearchBadgesInitialAllOn = function (on) {
  __bramWriteLS('bram.searchBadgesInitialAllOn', on ? '1' : '0');
  return !!on;
};

// turn-complete-beep: a per-user (localStorage) audio cue when a permission
// menu appears or the agent finishes a turn. Default ON (it's genuinely useful);
// an explicit off stores '0' and stays off. Per-user, not a project setting — an
// audio preference must not ride the shared .bram.json.
window.__bramBeepEnabled = function () {
  return __bramReadLS('bram.turnCompleteBeep', '1') !== '0';
};
window.__bramSetBeepEnabled = function (on) {
  __bramWriteLS('bram.turnCompleteBeep', on ? '1' : '0');
  if (on) { try { window.__bramSoftBeep(); } catch (e) { /* ignore */ } }  // confirm audibly on enable
  return !!on;
};
// A short, soft sine with a quick attack/release envelope (click-free).
// One lazily-created AudioContext, resumed on demand (autoplay policy needs
// a prior user gesture; the user has invariably clicked before a turn ends).
window.__bramSoftBeep = function () {
  try {
    var Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    var ac = window.__bramBeepCtx || (window.__bramBeepCtx = new Ctx());
    if (ac.state === 'suspended' && ac.resume) { try { ac.resume(); } catch (e) {} }
    var now = ac.currentTime;
    var osc = ac.createOscillator();
    var gain = ac.createGain();
    osc.type = 'sine';
    osc.frequency.value = 660;
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.06, now + 0.02);   // soft attack
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.18); // quick release
    osc.connect(gain); gain.connect(ac.destination);
    osc.start(now);
    osc.stop(now + 0.2);
  } catch (e) { /* audio unavailable: silent, not broken */ }
};
// Beep when the agent turn transitions to finished AND the cue is enabled.
window.__bramBeepOnTurnState = function (newState) {
  try {
    if (String(newState) === 'finished' && window.__bramBeepEnabled()) window.__bramSoftBeep();
  } catch (e) { /* ignore */ }
};
// Beep when a permission menu APPEARS (agent needs a decision), gated on the
// same cue. Transition-only: beep on no-menu -> menu, not on the redetects /
// label-joins that re-fire the menu event while one is already up.
window.__bramLastMenuPresent = false;
window.__bramBeepOnMenu = function (menu) {
  try {
    var present = !!(menu && (menu.tool || (menu.options && menu.options.length)));
    var was = window.__bramLastMenuPresent === true;
    window.__bramLastMenuPresent = present;
    if (present && !was && window.__bramBeepEnabled()) window.__bramSoftBeep();
  } catch (e) { /* ignore */ }
};

// Relevance gates. A tip with no gate is evergreen (eligible until dismissed).
// The settings snapshot is the /__settings payload; done-detection for gated
// tips is the gate itself (opting in retires the tip with no stored state).
function __bramTipEligible(tip, settings) {
  var s = settings || {};
  if (tip.id === 'tool-descriptions') return !(s.ai && s.ai.describeCommands);
  return true;
}

// Highest-priority eligible, not-dismissed, not-skipped tip, or null. The
// sessions arg is reserved for future predicates; tick exists only so markup
// bindings re-evaluate when dismiss/next bump it.
window.__bramPickTip = function (settings, sessions, tick) {
  if (!window.__bramTipsEnabled()) return null;
  var reg = window.__bramTipsRegistry.slice().sort(function (a, b) { return a.priority - b.priority; });
  for (var i = 0; i < reg.length; i++) {
    var t = reg[i];
    if (__bramTipDismissed(t.id)) continue;
    if (window.__bramTipSkips[t.id]) continue;
    if (!__bramTipEligible(t, settings)) continue;
    return t;
  }
  return null;
};

window.__bramDismissTip = function (id, tick) {
  var m = __bramTipDismissedMap();
  if (id) m[id] = Date.now();
  __bramWriteLS('bram.tips.dismissed', JSON.stringify(m));
  return (Number(tick) || 0) + 1;
};

window.__bramSkipTip = function (id, tick) {
  if (id) window.__bramTipSkips[id] = true;
  return (Number(tick) || 0) + 1;
};
