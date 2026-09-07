# Developing Bram

Guidance that applies **only when editing Bram's own source** — the
agent pane's XMLUI, `app/__shell/helpers.js`, `app/tools/Globals.xs`,
and the Rust shell. This file is `@`-imported by the source repo's
`CLAUDE.md` and referenced from its `AGENTS.md`; it is **never seeded
into managed projects** (their sessions get `.claude/bram-conventions.md`
only). The audience test for what belongs here vs. there: *would this
text change an agent's behavior in a project that is not the bram
repo?* If yes, it belongs in `app/__shell/conventions.md`.

The rules below are agent-neutral: they bind Claude, Codex, and any
future provider editing this repo.

## Code organization (helpers.js / Globals.xs / window)

Iframe-side code spans four surfaces. The rules below describe where
each kind of code should live, and how XMLUI markup calls into it.

### The surfaces

- **`app/__shell/helpers.js`** — real JavaScript. Async, `fetch`,
  `setTimeout`, `postMessage`, tauri event listeners — anything the
  XMLUI expression engine can't host directly. Functions live on
  `window` (see naming below) and are reached from XMLUI markup as
  `window.foo(...)`. Rebuild-required; see *Build vs. hot-reload
  boundary*.
- **`app/tools/Globals.xs`** — XMLUI's expression engine context.
  Holds xs-scope module state (vars whose readers/writers all live in
  xs) and the few helpers whose proximity to that state earns them a
  place here. Engine restrictions: no async/await, no setTimeout, no
  fetch, no Promise chaining outside DataSource. Top-level
  `function foo(...)` declarations auto-hoist onto `window.foo` —
  but that binding is engine-scoped: it makes `foo` bare-callable
  from XMLUI attribute expressions and lets an xs name shadow a
  helpers.js export, yet the function is NOT reliably reachable as
  `window.foo(...)` from real-JS contexts in helpers.js. Live
  receipt (2026-08-20): a helpers.js click path calling
  `window.initCloseIssueState(...)` failed with "is not a function"
  though the xs declaration existed; the fix was a self-contained
  helpers.js replica. Code that must be callable from both sides
  lives in helpers.js, never in Globals.xs.
- **`window.*`** — the shared namespace. helpers.js writes here
  explicitly; `Globals.xs` writes here implicitly via hoisting. The
  `__bram*` prefix exists to give helpers.js a collision-safe space
  when an xs-side counterpart of the same name would otherwise hoist
  over it.
- **`.xmlui` files** — markup. Attribute handlers (`onClick`,
  `onDidChange`, `onLoaded`, etc.) and binding expressions
  (`value="{...}"`, `when="{...}"`) are tiny expressions, not
  hosting environments for code.

### Where each kind of code goes

- **Pure functions** (sync, no XMLUI component state, no
  engine-hostile primitives) → `window.foo` in `helpers.js`. XMLUI
  markup calls them as `window.foo(...)`.
- **Shims for outside-sandbox operations** (async, fetch, setTimeout,
  postMessage, tauri events) → also `window.foo` in `helpers.js`,
  because the engine can't host them. Markup calls them as
  `window.foo(...)`.
- **xs-only code** → `Globals.xs`, but only when the function
  genuinely needs xs (touches xs-scope module state directly, or is a
  very hot binding-string callee where the `window.` prefix is
  measurably annoying enough to justify the cost).
- **XMLUI attribute handlers** → a single function call:
  `onClick="window.foo(...)"` (or `onClick="foo(...)"` if `foo` is an
  xs function). Never multi-statement bodies, never multi-line arrow
  bodies, never object-literal blobs. See *Failure modes* below.

### When and why do we need delegators?

A *delegator* is `function foo(...) { return window.__bramFoo(...); }`
in `Globals.xs`. Its only purpose is to let XMLUI markup write the
bare name `foo(...)` instead of `window.__bramFoo(...)`.

**Default: don't add one.** Call helpers as `window.foo(...)` from
XMLUI markup. This includes inside arrow-function bodies passed to
`subscribeTauriEvent` / `onDidChange` / `onLoaded` etc. — the engine
analyzes the *qualified* `window.foo` member access without trouble.

**Add a delegator only when** (a) the function is called many times
in attribute expressions where the seven-character `window.` prefix
is genuinely annoying, and (b) the name doesn't already exist on the
bare `window` surface. Each delegator we add hoists `function foo`
onto `window.foo`, expanding the collision-prone surface — the
exchange rate has to be worth it.

The `Globals.xs` of today has zero delegators — the fossil set from a
prior model was pared away during the host-route migrations. The rule
above governs whether any new one earns its place.

### The `__bram*` namespace prefix

`__bramFoo` on `window` defends a helpers.js export against being
clobbered by a `function foo` declaration in `Globals.xs` (which
would auto-hoist onto `window.foo`). It is **not** a blanket rule
for every helpers.js name — bare-name window helpers
(`toShell`, `toTurn`, `logToHost`, `openExternal`, `sendKeys`,
`captureScreenshot`, etc.) are fine as long as no `Globals.xs`
declaration shadows them.

The discipline:

- If a name has a matching `Globals.xs` delegator → name the helper
  `window.__bramFoo`. The delegator body is
  `return window.__bramFoo(...)`; no collision.
- If a name lives only in `helpers.js` → bare `window.foo` is fine.
  No prefix required.

### Failure modes that informed these rules

Learned from real incidents; each is a hard rule, not a preference:

- **Attribute expressions stay a single function call.**
  Multi-statement / multi-arrow-body / object-literal blobs in
  handler attributes are the anti-pattern that produced the
  hour-long "parser quirk" hunts. When an XMLUI surface throws a
  weird error and the markup has an inline ternary / `&&` chain /
  multi-statement arrow — the bug is the inline expression, not the
  parser. Extract to a `window.foo` helper first.
- **Bare names inside arrow bodies silently abort analysis.** In an
  arrow body passed to `subscribeTauriEvent` / `onDidChange` /
  `onLoaded`, a bare `foo` with no xs declaration silently kills the
  registration AND every statement after it in the same handler —
  the symptom surfaces as an unrelated component failing to mount.
  Call qualified: `window.foo()`. (Top-level attribute positions
  tolerate bare names; arrow bodies are the trap.)
- **xs `function foo` hoists over `window.foo`.** helpers.js loads
  first; a same-named xs declaration then clobbers the helper with
  the xs-bound version. If the xs function was a delegator calling
  `window.foo(...)`, it now calls itself — infinite recursion,
  swallowed silently by trace try/catch, presenting as hung
  handlers. Fix: name the helper `window.__bramFoo` (when an xs
  delegator exists) or remove the xs declaration entirely.
- **helpers.js top-level *calls* must follow their definitions.**
  The file runs top-to-bottom; a load-time throw
  (`window.X is not a function`) aborts everything after it,
  breaking features unrelated to the edit (menu, voice,
  talk-session). Function *definitions* referencing later names are
  fine; top-level *invocations* are not.
- **`ExpandableItem` expansion state is uncontrolled and positional.**
  Inside an `Items` loop, when the list shrinks (a Worklist prune),
  the component instances are reused by position, so an expansion
  opened on row 3 silently transfers to whatever item now occupies
  row 3. Fix: controlled expansion keyed by item id — a `when`-gated
  body plus an explicit chevron/header toggle writing an id-keyed
  map (the Worklist rows are the live pattern). Filed upstream as an
  ask; until then, never rely on `ExpandableItem`'s own state in
  loops whose membership changes.

### Post-edit verification ritual

After ANY iframe-side change (`.xmlui`, `Globals.xs`, `helpers.js`):
grep `console-error|console-unhandledrejection` in
`resources/bram-traces/bram-trace.log` once the pane has reloaded.
Zero matches is the pass condition; any match is triaged before
reading anything else from the trace.

For the registered trace categories, subkinds, fields, and their diagnostic
purpose, consult the on-demand
[trace vocabulary](trace-vocabulary.md) while reading the log.

Why this is non-negotiable: the xs engine **silently rejects
assignments to member expressions** from inside function bodies it
evaluates — `window.X = value` in a Globals.xs function fails with a
scope error that only the trace sees, while the calling pipeline
just stops. (Top-level `window.X = ...` statements in Globals.xs are
fine — the file loader parses those, not the expression engine.)
Workaround: define the setter in helpers.js (real JS) and call it as
a function from xs.

### Peer-pattern check before designing

Before introducing a new mechanism in the pane, grep 2–3 peer
components for how they handle the same shape of problem, and run
`xmlui_search_howto` for the operative concept. If every other
reactive surface uses the same pattern and the misbehaving component
hand-rolls something different, the outlier is almost certainly
where the bug lives — refit to the canonical pattern before adding
instrumentation.

## Push over polling

Do NOT add `pollIntervalInSeconds` to XMLUI DataSources for
freshness. Drive refetch from events or actions, by tier:

- **Local action** (e.g. posting a comment): bump a reactive var the
  DataSource depends on (a `refreshTick` in queryParams), or call
  `.refetch()` in the action's `onSuccess` — refresh exactly when it
  changed, not on a timer.
- **Cross-component / host state**: subscribe with a `PushSource` on
  `window.bramSubscribeTauriEvent('<event>')` (`git-status-changed`,
  `worklist-changed`, `talk-session-changed`, …) and refetch on its
  tick — the established pattern across the pane.
- **Remote state with no filesystem trigger** (e.g. forge issue edits
  by others): the poll does NOT move to the client and is NOT
  replaced by a manual Refresh button. Relocate it to the Rust host —
  a background thread polls, computes a result signature, and
  synthesizes a Tauri event (`issues-changed` is the precedent) only
  on change; the client subscribes and refetches. The host often
  piggybacks on work it already does (the search indexer fetches
  issues anyway).

## Codex synchronized terminal redraws

Codex brackets full-screen paints with DEC synchronized-output mode 2026
(`CSI ? 2026 h` / `CSI ? 2026 l`). Bram's vendored xterm.js 5.x predates
support for that mode, so `app/main.js` coalesces PTY frames and delivers a
complete synchronized paint to xterm in one write. The hold is bounded at
100 ms: a missing closing marker fails open instead of wedging the terminal.

When changing the PTY write path, replay these three shapes against the
coalescer before hand-testing a real Codex resume: begin/content/end in one
frame, markers split across frames, and a begin with no end. The first two
must flush atomically; the last must flush on the deadline. Then check
`resources/bram-traces/bram-trace.log` for `terminal-write-batch` slow lines
and `xterm-liveness` stalls. Do not replace this with xterm.js 6.0 solely for
mode-2026 support: upstream's current implementation still has an open
ED2-inside-sync viewport-yank bug affecting Codex and Claude.

## Perf diagnosis ordering

**Timeline first, semantic probes second.** When the pane feels slow,
record a browser Timeline (Safari Web Inspector → Timelines, Frames
view) before reaching for Bram's semantic instruments. The Timeline's
Script / Layout / Paint split is the cheap first partition and names
the fix class directly: Layout-dominated frames point at DOM size and
forced reflow (virtualize, bound the region), Script-dominated frames
point at evaluation work — and only then is the eval-trace probe
(which binding? which handler?) the right drill.

Receipt: the 2026-07-31 search-typing-lag hunt fixed three script-side
layers (describe pacing, projection tail-scoping, eval confinement)
before a Timeline recording named Layout as the felt cost —
virtualization (69be17a) was the fix a day-one recording would have
named immediately. The probe still earned its keep by falsifying the
eval theory decisively, and it remains irreplaceable where Timelines
can't go (hard freezes, remote machines, semantic attribution) — but
the ordering lesson stands: category attribution before semantic
attribution.

## Build vs. reload boundary

**Settled 2026-08-26 (the helpers.js-needs-rebuild mantra was wrong,
and launch mode is the variable.)** Bram registers its own `tauri`
scheme handler, which serves every `app/**` asset through
`serve_app_file` (`lib.rs`) — and that function prefers an **on-disk
`app/` root**, falling back to the `include_dir!` embedded tree only
when no candidate directory exists. The candidate that fires under the
documented launch is `exe_dir/app`: launching via the **`./bram`
symlink at the repo root** keeps the executable's parent at the repo
root, where the live source `app/` sits. The symlink is load-bearing.

So, **when launched via `./bram` at the repo root**:

| path | rule |
|---|---|
| `app/tools/**` | Served from disk per request. Pane reload picks up edits AND new files. (Auto-reload only when `ui.toolsPaneHotReload` is on; otherwise reload the pane manually.) |
| `app/__shell/**` (incl. `helpers.js`) | Served from disk per request. Pane reload re-fetches and re-executes it. No rebuild. Proven three ways on 2026-08-26: source chain, a live pane-reload observation, and a loopback probe showing a pre-edit process serving post-edit bytes. |
| `app/vendor/**` | Served from disk per request. `cp` the new build, reload the pane. No rebuild. |
| `app/main.js`, `app/index.html`, `app/styles.css` | Served from disk, but the parent window doesn't reload with the tools iframe — **relaunch the app** to re-execute them. Still no rebuild. |
| `src-tauri/**` | **Rebuild + relaunch.** The only genuinely rebuild-gated path. |

**When launched any other way** — the raw `target/debug/bram` binary,
or an installed bundle with no adjacent `app/` directory — no disk
candidate exists and everything serves from the **embedded** tree
baked at the last `cargo build` of the binary actually running. There
the old mantra is true: rebuild + relaunch for any `app/**` change,
and a running process keeps its launch-time embedded tree regardless
of later builds. This is also why `cargo build` still matters even
for pure-JS changes you validated via reload: it refreshes the
embedded fallback that installed binaries will serve.

**And one sharper fact inside that mode (#332):** `include_dir!`
embeds all of `app/` while `build.rs` declares `rerun-if-changed` for
exactly one file under it (the loose-ends skill). So a markup-only
edit followed by `cargo build` recompiles nothing, and a raw-binary
launch silently serves markup from an older vintage. This is
deliberate — watching `app/` wholesale would recompile a ~55k-line
crate on every `.xmlui` edit, for a path the documented `./bram`
launch serves from disk anyway, and release builds run from clean
checkouts so shipped binaries always embed fresh. The staleness is
made legible instead: `bram --embedded-app-hash` prints the baked
tree's content hash, `bram --hash-app-dir <path>` hashes a checkout
with the same algorithm, `/__app-info` reports `embeddedAppHash` and
`servingEmbedded`, and `tb.ps1` compares the two hashes in its
preflight and warns `STALE EMBEDDED app/` on mismatch. When testing
`app/**` behavior through a raw-binary launch, trust that preflight,
not the build's exit status.

Residual caution, kept on purpose: a pane reload re-executes
`helpers.js` in the iframe, but long-lived listeners, pre-XMLUI
globals, and parent-window state can carry stale behavior across a
reload. For subtle shell-runtime changes, a full relaunch remains the
clean-room validation even though the bytes were already fresh.

**Always `cargo build` (debug), never `cargo build --release`, when
validating changes** — debug builds are seconds, release builds are
minutes, and release is for shipping. Don't suggest `cargo run`
either. And always launch the `./bram` symlink at the repo root, not
an installed/older app — both for fresh code and because the symlink
is what makes disk serving resolve at all.

### Formatting is enforced, so run `cargo fmt`

`src-tauri/` was normalized in `d94a3b9`, and `.github/workflows/fmt.yml`
runs `cargo fmt --check` on every push and pull request. Formatting is
no longer something to remember: run `cargo fmt` before you commit and
the check passes. `src-tauri/rustfmt.toml` pins
`style_edition = "2021"`, so your rustfmt and CI's agree even across
toolchain updates.

And now it is enforced at the gate, not just in CI
(worklist-commit-refuses-unformatted-rust). When a `worklist-commit`
in the source repo stages any `.rs`, the route runs `cargo fmt --check`
on the worktree first and refuses (409 `op=refuse-unformatted-rust`,
claim released) if it is dirty — so an unformatted Rust commit cannot
land through the gate whether or not anyone ran `cargo fmt`, and whether
it goes through whole-file or interval staging. A git pre-commit hook
would NOT cover the interval path: it commits via `git commit-tree`,
which runs no hooks. The worktree check is inductively sufficient — a
clean worktree keeps the reconstructed interval tree clean because
prior gated commits kept HEAD clean. The recurrence that motivated this
(`c2ff3e6a` committed without `cargo fmt`; CI failed on that tip; the
earlier one-shot fix `811ceaa` cleaned the drift but did not stop the
next one) is why the discipline moved from "remember" to "cannot".

That check is deliberately its own workflow. `build.yml` is
`workflow_dispatch`-only because the Tauri matrix builds are expensive;
a fmt check needs no system dependencies and no compilation, so it can
afford to run per push — which is the only place it prevents drift
rather than discovering it during a release.

The sweep is listed in `.git-blame-ignore-revs`, and you can register
it locally:

```sh
git config blame.ignoreRevsFile .git-blame-ignore-revs
```

GitHub's blame view honours the file already, with no configuration.

Do not expect it to do much for `d94a3b9` specifically. Measured after
the fact: of 53,930 lines in `lib.rs`, only **8** blame to the sweep at
all — git's own diff pairing already carries reformatted lines back to
the commit that wrote the code — and those 8 do not move even under an
explicit `--ignore-rev`, because the sweep left them with no predecessor
line to reassign to. The blame-churn objection to reformatting a large
file turned out to be much smaller than it is usually assumed to be.
The file is here as standing hygiene for the next sweep, not because
this one needed rescuing.

Before the sweep this section said the opposite — *never* run the
formatter, because on an unnormalized tree it rewrote 247 regions of
code nobody had touched, and the commit gate stages whole declared
files, so a 12-line fix would ship as a 900-line diff under your item's
id. That is what normalizing bought: the rule stopped depending on
anyone remembering it. The cross-machine coordination that landing it
required is on judell/bram#322.

## Hand-testing the Worklist gate

The gate's selection matrix — which buttons light for which combination of
items, entanglement, and lifecycle state — is exercised by the walkthrough
in `docs/worklist-gate-walkthrough.md`: probe items doing trivial real work,
phase-by-phase expectations, deliberate wedge attempts, and teardown trace
greps. Born as the 0.5.3 release gate (three findings, all fixed in-run).
Run it before a release or after touching the gate surfaces. Its graduation
target is an automated test on transient instances, per the harness pattern
below; the host-observable half could graduate first.

## Developing and testing the startup dance

Startup — Setup seeding a project, hook registration, currency and
staleness checks, the needs-setup and first-run banners — was for a
long time the least testable part of Bram, and it shows in the issue
record: #99, #102, #173, #211, #247 and #249 were all found by a
person noticing, several of them after shipping. #249's gate 1 is the
representative artifact, a hand-run expectation table scored "3 of 4
pass, 1 real finding".

The reason it stayed manual is that verifying startup appeared to
require restarting *your own* Bram — which kills the agent session
doing the verifying. It does not.

### Run a second instance against a throwaway project

`bram <path>` takes a project root (`determine_project_root`,
`src-tauri/src/lib.rs`), and there is no single-instance guard. Each
instance binds its own loopback port and writes its own
`resources/.bram-port`. So a full Bram can run against a scratch
directory while your working session keeps going, untouched:

```sh
BRAM_TRACE=1 ./bram /tmp/scratch-project
```

Two details that are easy to get wrong:

- **`BRAM_TRACE=1` is belt-and-braces, no longer load-bearing.** Traces
  default ON (they were opt-in until 2026-08-26), so a scratch project
  with no `.bram.json` traces without it. Keeping the variable pins the
  intent against the project setting and costs nothing — and nearly
  every startup assertion worth making reads the trace.
- **Kill by PID, never `pkill bram`.** Your own session is a `bram`
  process too.

### The stale-binary trap

`cargo build` replaces the binary file, but a running process keeps
executing the inode it started with. A Bram launched before your build
will happily keep running the old code, and its behavior looks like a
real result. Before trusting any startup finding, check the binary's
mtime against the process start time. This is the concrete form of the
rebuild-and-relaunch rule above; the rule says to relaunch, this says
why a stale run is so easy to mistake for a genuine one.

### Startup is observable without the UI

Setup's effects are entirely inspectable over the loopback port, which
is what makes them assertable:

| what | how |
|---|---|
| installed / needs-setup / currency flags | `GET /__enhance/status` |
| run Setup headlessly | `GET /__enhance/run?force=true` |
| what Setup seeded | the file tree (`.claude/`, `AGENTS.md`, `CLAUDE.md`, `resources/.worklist-authorization.json`) |
| what startup did | `resources/bram-traces/bram-trace.log` |

`/__enhance/status` fields answer *different questions* and can
legitimately disagree — a fact that was itself a bug for a while.
`claudeNeedsSetup` / `codexNeedsSetup` are about installation currency
and key on `core_installed` (the worklist authorization file plus
per-provider hook registration). `firstRun` asks whether this project
has ever been managed at all. Before 2026-08-20 `firstRun` keyed only
on `.bram.json` / `.xmlui-desktop.json` — the *settings* files, written
when a setting is first saved and never by Setup — so a successful
Setup left the "Bram is starting for the first time in this repo"
banner up, with the banner's own text claiming Setup writes
`.bram.json`. Same shape as #211.

### The harness

`scripts/setup-harness.sh` automates the above: per scenario it creates
a pristine temp project, launches the locally built binary against it,
drives Setup over the port, asserts, checks that a second Setup is
byte-idempotent, and tears down (keeping the directory on failure).

```sh
scripts/setup-harness.sh                 # all scenarios
scripts/setup-harness.sh pristine_git    # one
BRAM_BIN=/path/to/bram scripts/setup-harness.sh
```

Exit status is the number of failed assertions. Scenarios vary the
*starting state* rather than the steps, because that is where the
historical failures were: `pristine_nogit`, `pristine_git`,
`already_setup` (the cross-machine re-run from #249), `legacy_hooks`
(retired generic hook names, #173), and `nested` (a managed parent).

Every assertion traces to a bug the record actually caught, which is
the standard for adding another one. Notably `already_setup` asserts
that re-running Setup leaves **tracked** files unmodified — #249's real
failure — while untracked seeded files are expected on a fresh project.

Two boundaries worth keeping:

- **The source repo is deliberately not a scenario.** `is_source_repo`
  takes a different path (#102) and pointing the harness at it would
  dirty your working tree.
- **It is not wired into CI**, because launching the app needs a
  windowing session. It is a command you or an agent runs on demand.

When a startup assertion fails, prefer fixing the *fixture* over the
product until you have shown the failure reproduces outside the
harness — the first `already_setup` failure was the harness committing
its own live trace log, not Setup churn.

## The synthetic-testbed method: drive a real instance, read its trace

**This is the default way to develop a pane or interaction change — not
an occasional technique.** For anything a user sees or clicks, stand up
a throwaway Bram showing the *whole range* of the feature's states at
once, drive it by hand, and refine against its trace. The startup-dance
section above is one *scripted* application of the second-instance
pattern; this is the general, *exploratory* loop it belongs to. Jon,
after a first sitting that reshaped a surface in minutes: "just
absolutely the way to develop."

### The loop

- **Stand up a second full Bram** with the standard synthetic fixture:

  ```sh
  scripts/demo-instance.sh new full-board --from all
  scripts/demo-instance.sh launch
  ```

  This is the startup-dance second-instance pattern generalized past
  startup. The generated fixture's `resources/worklist.json`,
  `resources/.claim-intervals.json`, and `refs/bram/claims/*` display
  disjoint entanglement, a true dependency, supersession, unattributed
  work, many simultaneous claimants, and an expired authorization **on
  one board** — the range a scripted test would cover one case per
  assertion, laid out for the eye simultaneously.
- **The human drives it as a clueless user** — clicking around,
  misclicking, hitting real states. This is the fuzzer. It finds what
  scripted expectations miss because it moves the way hands actually
  move, not the way a test author predicted they would.
- **The agent reads the trace, not the screen.** The orchestrator
  watches the demo instance's
  `resources/bram-traces/bram-trace.log` and diagnoses from
  host-observable evidence — the log-first drill, run live instead of
  post-mortem.
- **Edits land in seconds.** Under the `./bram` symlink launch the demo
  serves `app/**` from the *source* repo's disk (`helpers.js`,
  `*.xmlui`, `vendor/**`) per request, so an edit shows on a pane reload
  with no rebuild and no relaunch — the reload boundary this doc already
  establishes, turned into a development cadence. Edit → reload → look →
  refine, tightened to the length of a reload. (Rust still
  rebuilds+relaunches; the pane does not.)
- **Save or reset on one word.** `scripts/demo-instance.sh capture
  <name>` parks a stumbled-into state as `scenario/<name>`;
  `scripts/demo-instance.sh reset` rehydrates the active scenario byte
  for byte, including its claim refs and ignored scenario-owned
  `resources/` sidecars, while preserving the running instance's port
  and trace files. Each probe can start clean without throwing away a
  finding.

### Why it's the way, not a technique

- It makes the *render-what-the-reader-sees* rule (in
  `app/__shell/conventions.md`) continuous. A green test verifies
  behavior; this verifies communication, live — the half a passing spec
  cannot reach.
- It puts the human on realistic input and the agent on tireless
  observation — each doing what it is best at.
- It turns the trace from a forensic artifact into a live conversation.

### Receipts (proof, not decoration)

In its first sittings the method surfaced, in minutes each:

- the terse-strip + `tooltipMarkdown` redesign — five iterations
  against live renders, each visible on reload;
- an accidental **Drop that could not be canceled** — destructive, a
  ~90s agent turn, and Escape never routed to the agent's PTY (#340);
- an **env-inheritance bug** that silently disabled the demo agent's
  transcript.

None were reachable by reading code; all were obvious the moment a
human drove an instrumented instance.

### Two launch-hygiene requirements the method itself surfaced

- **Scrub `CLAUDE_CODE_*` on launch.** An agent-launched instance
  inherits the parent's `CLAUDE_CODE_CHILD_SESSION` and its siblings;
  the demo's own agent then reads the marker, concludes it is a child
  session, and disables transcript saving. Launch with
  `CLAUDE_CODE_CHILD_SESSION`, `CLAUDE_CODE_SESSION_ID`,
  `CLAUDE_CODE_BRIDGE_SESSION_ID`, `CLAUDE_CODE_MESSAGING_SOCKET`,
  `CLAUDE_CODE_MESSAGING_TOKEN`, `CLAUDE_CODE_ENTRYPOINT`, and
  `CLAUDE_CODE_EXECPATH` unset (`env -u …`). (#339)
- **Kill by PID, never `pkill bram`** — your working session is a
  `bram` process too (the same trap the startup-dance section names).

### Institutionalization (#339)

`scripts/demo_instance.py` is the platform-neutral fixture engine;
`scripts/demo-instance.sh` and `scripts/demo-instance.ps1` are the thin
platform launchers. The default fixture lives beside this checkout at
`../bram-demo-instance`; put `--repo <path>` before the verb to use a
different location. The useful verbs are:

| verb | effect |
|---|---|
| `new <name> --from <starter>` | create and hydrate a scenario; repeat `--from`, or use `--from all` |
| `use <name>` | discard the live probe and hydrate `scenario/<name>` exactly |
| `add <starter>` | add another synthetic state to the live board; it is temporary until captured |
| `capture <name>` | park the current worktree, worklist sidecars, and claim boundaries as a scenario |
| `reset` | rehydrate the active scenario |
| `status [--json]` | report scenarios, active state, item/ref counts, PID, and log path |
| `launch` / `stop` | start the real binary or stop only its recorded PID |

The starter names are `disjoint-entanglement`, `dependency`,
`supersession`, `unattributed`, `many-claimants`, and
`expired-authorization`. For example, a focused board is:

```sh
scripts/demo-instance.sh new ordering \
  --from disjoint-entanglement \
  --from dependency
scripts/demo-instance.sh launch
tail -f ../bram-demo-instance/resources/bram-traces/bram-trace.log
# Human explores; agent reads the trace.
scripts/demo-instance.sh capture ordering-found-cancel-gap
scripts/demo-instance.sh reset
scripts/demo-instance.sh stop
```

On Windows, use the same verbs through
`scripts\demo-instance.ps1`. Run the established `build.ps1` from a VS
Developer PowerShell first. The launcher refuses a debug binary older
than HEAD or a half-build where `bram-guard.exe` is newer than a locked
`bram.exe`; it names existing Bram PIDs rather than killing them. On
every launch it verifies a directory junction named `app` beside the
target-triple debug executable, pointing at this checkout's `app/`.
That is the Windows disk-serving equivalent of Unix's repo-root
`./bram` symlink: no privileged symlink, and no hardlink left stale when
Cargo replaces the executable. If this workflow changes on macOS/Linux,
its automated launcher smoke runs here; if it changes on Windows, run
the corresponding PowerShell launch smoke on Windows before calling it
done.

Both launchers delegate process creation to the shared engine, which
also refuses a binary older than this checkout's HEAD. It
captures stdout/stderr under the demo repo's git directory, records the
exact child PID, enables tracing, and removes
`CLAUDE_CODE_CHILD_SESSION`, `CLAUDE_CODE_SESSION_ID`,
`CLAUDE_CODE_BRIDGE_SESSION_ID`, `CLAUDE_CODE_MESSAGING_SOCKET`,
`CLAUDE_CODE_MESSAGING_TOKEN`, `CLAUDE_CODE_ENTRYPOINT`, and
`CLAUDE_CODE_EXECPATH`. A nested demo agent therefore saves its own
transcript instead of mistaking itself for the parent session.

The durable scenario library is **git branches** (`scenario/<name>`),
strictly more powerful than regenerate-from-script because a branch
captures real *stumbled-into* states, not only synthesized ones — the
externalized-context principle applied to fixtures. A scenario branch
retains the clean boundary, every claim tree, and the pending-work tree
in one commit ancestry. `use` checks out its tip detached, performs
`git reset --mixed <boundary>` so Bram sees pending work, and recreates
only that scenario's `refs/bram/claims/*`. The generated repository has
a conspicuous marker and no remote; every destructive verb verifies
both facts and the exact git toplevel before acting. Transfer a scenario
branch with ordinary Git plumbing (for example, a bundle), but never add
an upstream to the disposable instance.

### Relationship to the scripted sections

The Worklist-gate walkthrough and the startup-dance harness are
*scripted* checks with fixed expectation tables — good for regression,
weak at discovery. This is their *exploratory* complement: unscripted
human driving against the full state range, for finding what you didn't
know to script. The two feed each other — graduating a finding here
into a `scenario/` branch or a harness assertion is how an exploratory
discovery becomes a durable regression guard.
