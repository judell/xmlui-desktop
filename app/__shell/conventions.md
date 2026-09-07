# Working with Bram

Bram is a **workspace for AI-assisted web app development** — it
works with any project, whatever it serves. The shell puts a real
terminal alongside an "agent tools" pane that includes a Worklist
(pending items + commits), a Sessions browser, and a Context viewer
(CLAUDE.md + memory + hooks + settings, searchable).

Bram can *optionally* embed a **target app** — a project iframe that
previews a web UI inside Bram (vanilla HTML/JS, a React or other Node
app, a Python web app, an XMLUI app, etc.). This pane is **off by
default** and is a minority case: most users run their own app in
their own server and view it in their own browser, so the embedded
preview is reserved for a simple app or a quick check. Don't assume
an iframe is present — detect before you rely on it.

> Note on memory: this file is loaded into every session in this
> project via a `@`-import in `CLAUDE.md`, and Setup seeds it into
> every managed project as `.claude/bram-conventions.md`. **Don't save
> project-related memories** — preferring the worklist, helper APIs,
> release quirks, conventions you discover, etc. Per-user memory is
> private to one agent on one machine; shared files reach everyone
> running Bram (Claude and Codex alike). Route by audience: would the
> knowledge change an agent's behavior in a project that is NOT the
> Bram source repo? Yes → here. No (it only matters when editing
> Bram's own source) → `docs/developing-bram.md`, which loads only in
> the source repo. XMLUI-framework-generic findings → upstream xmlui
> docs, reachable through the xmlui-mcp server. Memory stays reserved
> for things that genuinely can't live in any repo (cross-project
> user preferences, provider-specific tool quirks, etc.).

Bram's own UI is XMLUI. When developing Bram, expect the
XMLUI MCP server to be available, read the xmlui_rules,
and follow them. The same holds if the app under development
is XMLUI.

### Guard source of truth

The guards are Rust, compiled into Bram itself
(retire-python-hooks-rust-only): the policy lives in
`src-tauri/src/guard_policy.rs` and the hook plumbing (dispatch, menu
POSTs, fail-closed fault handling, breadcrumbs) in
`src-tauri/src/guard.rs`. Hook registrations invoke
`~/.bram/bram-guard` (`bram-guard.exe` on Windows), a link Bram installs
at startup and re-ensures on a ticker, pointing at the dedicated
`bram-guard` binary built beside the app (GUI subsystem on Windows in
every profile, so hook spawns never flash a conhost). There are no
script files to edit or keep in sync — editing a guard is editing the
Rust source, and validating it is `cargo build` + relaunch, which
refreshes the link's target. Registration strings carry a bare
`guard <hook>` subcommand; a `--authority` token from the transition era
is still accepted and ignored.

The retired Python hook scripts (`.claude/hooks/claude-*.py` in managed
projects, `~/.bram/codex-*.py` user-globally) are deleted by Setup once
**no settings source** references them — project `settings.json`,
project `settings.local.json`, or the user-global
`~/.claude/settings.json` for the Claude pair, `~/.codex/config.toml`
for the Codex pair (the same #173/#227 reference-gated prune that
covers the older generic names). Bram never rewrites the global files:
a stale reference there holds the deletion back and is named in the
Setup result instead. A lingering script is surfaced by the Status
tab's "Retired Python hooks" rows.

`app/shell/` holds shell-launch support only (`claude-code-shellrc`,
`claude-code-profile.ps1` configure the shell that launches the agent
CLI; `codex-startup-instructions.md` is startup text injected into Codex
sessions) — no hook adapters. `app/provider-hooks/` is gone with the
Python guards it held; the history (including the shadow-soak and
authority-flip receipts) is in git and on judell/bram#269 and #313.

**Bram-bundled skills** follow the same canonical/installed split:
`app/skills/<name>/SKILL.md` is canonical; Setup seeds it into each
managed project's `.claude/skills/<name>/SKILL.md`, and `build.rs`
syncs the source repo's own installed copy (`loose-ends` is the first
member; new Bram-blessed skills drop into `app/skills/` and ride the
same path). Ownership is marker-based: Setup refreshes only files
carrying the `<!-- bram-managed -->` marker line — a same-named skill
without it is user-owned, never clobbered, and reported as skipped in
the Setup result. Skill staleness is deliberately NOT part of the
needs-setup banner; refresh is best-effort at Setup time. This is a
Claude-only surface (Codex has no skills concept). Do not make
functional edits in an installed `.claude/skills/` copy of a bundled
skill; edit `app/skills/<name>/SKILL.md`.

### XMLUI lookup order

When you are figuring out how to do a thing in XMLUI, ask the XMLUI
MCP server for how-to documents first (`xmlui_search_howto`). The
how-to corpus usually carries the complete pattern and tradeoffs.
After that, use `xmlui_component_docs` for exact component props,
events, and exposed methods. Use examples as a fallback or to confirm
local style, not as the first source of truth.

When a non-obvious markup choice depends on documentation, cite the
relevant how-to or component URL in the response.


## Code organization (developing Bram only)

The helpers.js / Globals.xs / window code-organization discipline, the
delegator and `__bram*` naming rules, the xs-engine failure modes, and
the post-edit verification ritual moved to `docs/developing-bram.md`
in the Bram source repo — they apply only when editing Bram's own
source, so they are not seeded into managed projects.


## Coordinate via worklist.json

`resources/worklist.json` is the canonical surface for multi-step
coordination between you and the user. The Worklist tab in the agent
agent pane renders it as a checklist under "Worklist".

### When to route through the worklist

**Default: every change request goes through `resources/worklist.json`.**
Single-file, single-line, single-attribute — size doesn't matter.
Propose first, wait for the user's `approved:` payload, then apply.
The two-stage proposed → applied flow lets the user redirect or veto
before any code is touched, and the worklist history serves as the
audit trail for what landed and why.

Skip the worklist only in these specific contexts, never because the
change is "small":

- **Explicit user opt-out in this turn.** The user ends their message with
 the single phrase "just do it" (case-insensitive). The opt-out must be in
 the same turn as the change request — don't carry it forward across turns
 or infer it from past patterns. Retired phrases ("skip the worklist",
 "commit this directly", "inline the fix", "no worklist for this", "don't
 bother with the worklist") no longer opt out — narrowed
 (opt-out-single-phrase-and-audit) from a seven-regex list to one explicit
 phrase, to cut the risk of an accidental match in ordinary prose. Both
 Claude and Codex honor the same phrase, but along different paths:
 Claude's guard matches `_OPT_OUT_PATTERNS` against `transcript_path` on every
 `PreToolUse` and allows inline; for Codex, Bram's host-side `toTurn` path
 matches the same phrase and writes a one-turn `direct-edit` record
 (`kind:"direct-edit"`, `paths:["*"]`, 1h TTL) to
 `resources/.worklist-direct-edit.json` — the grant's OWN sidecar
 (issue-352: the shared authorization file is single-slot and any gate
 click replaces it, which destroyed a live grant mid-TTL) — which the
 single Codex `PreToolUse` hook reads via `fresh_bypass()` (legacy
 records in `.worklist-authorization.json` stay honored for one
 release). The phrase itself is
 identical, so the user-facing contract is the same regardless of agent.
 Codex prose opt-outs record a `direct-edit` line in the audit ledger via
 that same host `toTurn` path; Claude prose opt-outs have no equivalent
 host chokepoint on their allow path, so the Claude guard instead POSTs a
 best-effort breadcrumb to `POST /__audit/direct-edit` right before
 allowing — one `direct-edit` audit-ledger record per opted-out turn,
 deduped host-side so the guard's per-tool-call firing doesn't produce
 duplicates.

- **`skip-worklist:` structured prefix on this turn.** The user's
  turn begins literally with `skip-worklist: ` followed by the
  request text. Same family as `approved:` / `drop:` / `iterate:`,
  but for authorizing a direct edit rather than a lifecycle
  transition. The user-facing affordance is the **skip worklist**
  button beside the message input in Bram's footer — it prepends
  the prefix and submits. Same convention as for Approve / Drop /
  Refine: tell users to click the button, do not instruct them to
  type or paste the wire format. When the host's `toTurn` write path
  sees the prefix it writes the same one-turn `direct-edit` record to
  `resources/.worklist-direct-edit.json` that the prose opt-out
  writes, then forwards the **entire turn text including the prefix**
  to the agent (unlike `approved:` / `drop:` / `iterate:`, which the
  agent is told not to mention but the prefix is left in place so the
  agent can see it). Agents seeing a `skip-worklist:` prefix on their
  turn must skip the propose-first convention and act on the rest of
  the message as a direct edit; do not write a new worklist item.
  The PreToolUse hook will allow the edits via the existing
  `fresh_bypass()` path.

- **Correcting code you just wrote in the current iteration.**
  If you wrote a typo or off-by-one in the last assistant turn and
  you're fixing it on the next turn, that's iteration on
  in-progress work, not a fresh change request. Direct fix is
  fine.

- **Iterating on an uncommitted draft.** If the user and you are
  bouncing edits on a file that hasn't been committed yet — e.g.,
  shaping a new component during the same conversation — direct
  edits keep the loop tight. Once the draft is committed, fresh
  edits become change requests and route through the worklist.

- **Issue-only forge work with no repo diff.** If the user asks you to
  create, edit, comment on, close, or reopen a forge issue, and the
  task will not modify tracked files in the repo and will not produce a
  commit, skip the worklist and do it directly — using the project's
  detected forge CLI (`gh` on GitHub, `glab` on GitLab; see *Updating
  forge issues via gh / glab*). If the issue request is paired with
  repo changes, the repo changes still go through the worklist.

### What worklist items represent (and when to drop)

**Worklist items represent repository changes.** A `proposed` item
names a `file` (or `files`) plus `before` / `after` prose in
`resources/worklist-drafts/<id>.md`, describing what would change
on disk. An `applied` item has those changes on disk
waiting for the user to approve a commit — and so, now, can a
`proposed` item that has been begun (approved and started, but not
advanced): once its changes are on disk and exclusive to it, the pane
offers Commit on it directly, `status` unchanged. See *Field notes*
below and *Transports → Apply-and-commit gate*. Items exist to give
the user explicit veto power over what lands in their repo.

Investigation work does NOT belong in the worklist. Things like:

- Checking whether a port is open or a server is running.
- Restarting a process or a Docker container.

…all happen in chat, not as worklist items. They produce no
`before` / `after` because there's nothing to write. They produce
no commit because there's nothing to land.

**If an investigation reveals nothing to commit, guide the user to
Drop.** Sometimes the agent proposes an item expecting code work
and the investigation turns up no actionable change — the bug was
a runtime configuration issue, the fix was a process restart,
every check passed. In that case:

- Do NOT call `/__worklist/mutate op:"advance"`. Marking the item
  as `applied` produces a row with nothing to commit (the legacy tab's
  TO COMMIT badge on an empty diff), which is exactly the user-visible
  failure mode of #88.
- Instead, summarize the finding in chat ("checked X, Y, Z; the
  issue is runtime-only, no code change needed") and explicitly
  recommend the user click **Drop** on that item in the Worklist
  tab.
- The user's Drop click works the same as any other drop —
  `/__worklist/resolve` with `kind: "drop"`, then
  `/__worklist/mutate op:"prune"`. Standard flow.

**Recovery if you've already advanced.** If you call `advance`
before realizing the apply was a no-op, the recovery is identical:
explain the finding in chat, recommend Drop on the resulting TO
COMMIT row. The user's Drop click works equally well on `proposed`
and `applied` items. No special undo path needed.

**Drop removes the item, not the bytes — and orphaned changes are
misattributed, not merely unattributed.** Every surface in the pane reasons
about changed files *through items*: the overlap index walks `item.files`,
`changeSummary` is computed per item, and exclusivity asks whether another
**begun** item claims the path. A changed file that no item declares is not
shown as belonging to nobody; it is credited to whichever begun item happens
to declare it, and is committable under that item's id and message with
nothing recording the mistake afterwards.

Two live cases, hours apart on 2026-08-24:

- `notice-banner-component` was green-lit two days earlier and produced
  nothing — its component file was never created and five of its seven declared
  files were untouched. The row nevertheless read
  `✓ Will commit +10 −35 in 1 of 7 planned` and offered **Commit**, because it
  was the only *begun* claimant of a file that edits made outside any
  authorized item had landed in. Exclusivity passed honestly.
- `issue-278-overlap-explorer` was dropped after its React Flow view lost to
  the table it was meant to improve on. The drop left 326 changed lines across
  three files plus 230 KB of vendored extension belonging to nothing.

So, when dropping an item that has **begun**:

- Say what remains on disk before the drop completes, and propose one of:
  revert it, re-home it under another item's `files`, or leave it
  deliberately — then say which was chosen. Both cases above had a defensible
  resolution and they were different ones.
- Prefer `git stash push -m "<item id> (dropped): <what>"` over discarding.
  The judgement that work is worthless is usually made minutes after making
  it; a stash costs nothing and keeps it recoverable.

This is also the strongest argument for not editing outside an authorized
item: unauthorized edits do not merely skip an audit trail, they are credited
to someone else.

### Placeholder items (droppable reminders)

One shape of item carries no diff yet and is still legitimate: a
**placeholder** for an action that is already decided but gated on an
external condition — an upstream merge, a release being cut, another
agent's verdict — that will resolve after this session ends. Chat
context dies with the session; the placeholder is what carries the
reminder across. Live precedents:
`file-upstream-null-expr-crash-after-3763` and
`revendor-after-xmlui-release` (bram), `watch-for-3764-merge` (xmlui).

- **Shape.** `Before` states the awaited condition plus enough
  self-contained context that no conversation history is needed to act
  on it. `After` states the action Approve green-lights, and says
  explicitly what condition would make Drop the right verdict. `files`
  lists what the eventual action will touch (empty for issue-only
  actions).
- **Lifecycle.** Approve = the condition is met; do the action, and the
  item behaves like any other approved item from there. Drop = the
  condition was mooted or the action superseded — an expected, honorable
  ending for this kind, not a failure.
- **Boundary.** This does not reopen the door to investigation items. A
  placeholder records a *decided future action*; an open question is
  still chat's job.

### Schema and draft layout

Proposals split metadata from review prose across two files:

```text
resources/worklist.json              # compact metadata index
resources/worklist-drafts/<id>.md    # before / after prose per item
```

The draft file:

```markdown
# Before

what's there now, relevant context, rejected alternatives

# After

what you'll change it to
```

The metadata item:

```json
{
  "id": "kebab-case-id",
  "status": "proposed",
  "files": ["path/to/file.xmlui"],
  "closesIssues": [{ "number": 42, "title": "..." }]
}
```

Bram merges draft prose into `/__worklist` and `/__worklist/resolve`,
so the Worklist tab and approval flow see one combined item. Hashes
cover metadata + resolved prose together. If a draft file is missing,
`/__worklist` returns empty `before` / `after` plus
`"_draftMissing": true` and the UI shows a placeholder.

`worklist.json` also carries a top-level `version` integer that guards
against concurrent-writer races between agents and the
`/__worklist/mutate` route. Every write to `worklist.json` MUST set
`version: N+1` where `N` is the value present on disk at the moment
you read it. The PreToolUse hooks (Claude and Codex both) compute the
current on-disk version and deny the write if the new content does
not bump it by exactly one. `/__worklist/mutate` does the same bump
on its own RMW path under a serializing mutex. The flow for an agent
proposing or refining items is:

1. Read `worklist.json` and capture its `version`.
2. Construct the new content with `version: <captured + 1>`.
3. Write. If the hook denies with `reason=stale-worklist-version`,
   re-read the file (another writer landed first), rebase your
   change on the new contents, and retry.

Files without a `version` field (legacy) are treated as version 0;
the first write that introduces the field at version 1 is the
natural migration path and the hooks allow it.

Prose lives only in the draft file. Inline `before` / `after` keys
in `worklist.json` are rejected by both guards — the proposal
authoring channel writes metadata to `worklist.json` and prose to
the matching `worklist-drafts/<id>.md`, never both. Refine-time
prose edits go to the draft file; `worklist.json` only changes
when metadata (`files`, `closesIssues`, etc.) shifts.

**Field notes:**

- `files: ["path/a", "path/b"]` for multi-file items; `file` (singular)
  is the older single-file form. A directory entry is allowed and covers
  everything under it at the commit gate — staging and verification both
  expand it (#295). Once an item is committable, its
  inline diff concatenates all listed files.
- `closesIssues` declares which GitHub issues the commit resolves
  (drives the close-on-commit dialog — see *Commit & git etiquette*).
  Set conservatively: only when the commit truly closes the issue, not
  when it merely cross-references (`see #N`, `related to #N`, partial
  multi-step work). Omit or use `[]` to skip the dialog.
- `begunAtMs` is **host-written, never authored by an agent**. The host
  stamps it when it first records an `approved` authorization covering
  the item, and never clears or moves it while the item lives — a
  re-approval (iterate, second gate) leaves the original stamp. It is
  the durable answer to "has work on this item begun?", which the
  Worklist strip and the overlap banner both need. The other two signals
  for that question — the authorization record and the inflight claim —
  are single-slot and displaceable, so on their own they let an item
  with real work on disk report "No changes yet" as soon as another item
  was approved. Don't set it by hand; don't rely on its absence meaning
  anything except "never approved".
- `status` tracks the item's stage, but as of 0.5.1 it no longer gates
  committability by itself (see *Transports → Apply-and-commit gate*):
  - `"proposed"` (default if omitted): user is approving you to make
    the change. The Worklist row's strip reads "No changes yet" until
    work begins; the legacy tab badges this **TO APPLY**. The current
    pane instead reasons about three states keyed on what the user can
    do — not started, nothing to commit, has changes you can commit —
    and a `proposed` item can reach that third state on its own, once
    begun with exclusive changes, without ever becoming `applied`.
  - `"applied"`: change is on disk, user is approving `git commit`
    (legacy badge **TO COMMIT**). Push decided separately via the Push
    button. `applied` still means committable; it is just no longer
    the only status that does.

Default to the two-stage flow: approved `proposed` → advance to
`applied` → user approves a separate commit → prune. Skip the
`applied` stage only when the user says "apply and commit" up front.
Drops prune directly with no `applied` stage. Don't pre-mark new
items `"applied"` unless the change is genuinely already on disk. This
default governs how an agent *authors and completes* an item's status;
it is independent of the pane's own committability judgment, which the
user exercises through the Commit button regardless of which status
the item currently carries.

`resources/worklist.json` doesn't need to exist in advance — Bram
serves an empty default; the Worklist tab creates the file (and
`resources/`) on first use.

### Lifecycle: propose → triage → mechanical transitions

1. **Propose** — write draft prose to
   `resources/worklist-drafts/<id>.md`, then write a metadata item to
   `resources/worklist.json`. Each item should be small, discrete, and
   independently rejectable. Writing the item is *asking* the user to
   approve, not approval itself. Don't show or instruct on raw
   `approved:` / `drop:` / `iterate:` payloads — the Worklist tab's
   buttons generate the `{id, feedback}` shape.

2. **User triages** — ticks the rows to act on, optionally types one
   message in the box beside the buttons, and clicks one of them. The
   message fans out to every selected item, so a plural payload's items
   may carry identical feedback text; treat each item's feedback on its
   own terms, but answer identical fanned-out feedback **once** in chat,
   never repeated per item — the per-item copies belong to the items'
   histories, not the transcript. All action buttons emit the same payload
   shape: `{"items":[{"id":"...","feedback":"..."}, ...]}`
   — ids plus optional per-item feedback. Never parse these turn lines
   for content yourself; `/__worklist/resolve` returns the recorded
   item bodies.

   Button names below are the labels the 0.5.3 gate bar renders —
   **Start N / Start & commit N / Commit N / Refine N / Drop N**. The
   wire payload kinds (`approved:` / `drop:` / `iterate:`) are a
   separate, stable vocabulary: buttons may rename (they did, in the
   start-verb renaming — Mary's day-one report, #293, caught this doc
   still saying "Approve & commit"), payloads don't. When telling the
   user what to click, use the rendered label.

   - *A plain message* typed in the box with no gate button clicked
     arrives as ordinary chat — respond; no items are approved or
     dropped, and do not edit files. (The legacy *Talk to agent*
     button and its `talk:` prefix retired with the Workspace tab.)

   - *Start (N)*, *Start & commit (N)*, and *Commit (N)* all emit
     `approved: {...}` — with `gate` `"to apply"`,
     `"apply-and-commit"`, and `"to commit"` respectively. For the
     apply gate, call
     `/__worklist/resolve` via the transport for your agent (see
     *Transports*). Response is one of:
     - `{"kind":"approved", "items":[<recorded content>], ...}` —
       execute these items. Do NOT re-read `resources/worklist.json`
       to second-guess what was approved. Records are **consumed on
       first read** — a second call returns `no_active_authorization`,
       so capture what you need. After editing the project files,
       advance via `POST /__worklist/mutate`, not by rewriting
       `"status": "applied"` directly.
     - `{"kind":"no_active_authorization", ...}` — the record is
       already consumed, or this turn isn't an authorization turn.
       **Do NOT treat as authorization.** Backstop for the rule that
       `iterate:` and other non-authorization turns must not route
       through `/__worklist/resolve`.

     Respond to any per-item feedback regardless of kind.

   - *Drop (N)* → `drop: {...}`. Same flow:
     `{"kind":"drop"}` → prune the ids via `POST /__worklist/mutate`.
     Respond to per-item feedback (often the user's reason for the drop).

   - *Refine (N)* — enabled only when feedback is non-empty (no-
     direction refinement is meaningless). Payload: `iterate: {...}` —
     the button renamed in the refine-verb rename, the wire kind did not,
     so **Refine emits `iterate:`** and every trace, audit record and
     guard matcher still reads `iterate`.
     **Refine does NOT route through `/__worklist/resolve`** — no
     state change is being authorized. Re-read items from
     `/__worklist` (for resolved draft prose) or
     `resources/worklist.json` (metadata alone), and act per each
     item's current status:
     - **`proposed`, not yet begun** (no `begunAtMs`, nothing on disk
       yet): revise the draft file's `before` / `after` prose; update
       `files` only if scope shifts. Item stays `proposed`, no
       project file edits.
     - **`proposed` but already begun** (real edits already on disk,
       even though `status` is still `proposed` — see *Field notes*),
       **or `applied`:** edit on-disk files per the feedback. Update
       the draft only if scope materially expanded. Item stays at its
       current status either way; iterate never advances or commits
       on its own.

     No agent-side bracket needed. The host detects the `iterate:`
     prefix on the `toTurn` write path and sets the inflight sentinel
     automatically; the same turn-finished detectors that clear
     approve/drop sentinels clear iterate's too. (The legacy
     `/__iterate/begin` and `/__iterate/end` routes were removed in
     the #214 delete phase.) See *Host-managed inflight sentinel*.

     The Refine payload's per-item shape is `{id, feedbackRef}`
     where `feedbackRef` names a file at
     `resources/feedback-drafts/<feedbackRef>.md` containing the user's
     full-fidelity feedback text. Read that file directly to get the
     feedback content — `toTurn`'s `\s+ → " "` collapse and the
     receiving TUI's bracketed-paste limits don't apply because the
     text never rode the PTY paste channel. Feedback refs are allocated
     per click, typically `<unix-ms>-<item-id>`; they are not item ids.
     The feedback text is the new user-authored submission for this turn.
     An item may instead carry inline `{id, feedback}` — that is the
     **degradation fallback only**, taken per item when its draft write
     failed, so an iterate still lands rather than blocking the click
     (its text has ridden the paste channel and is subject to the
     collapse above). For a while after the worklist2 rewrite the gate's
     Refine emitted inline unconditionally while the Queue tab drafted —
     an accidental fork, repaired under #285; both emitters draft first
     now, and both opt-out matchers (guard-side and host-side) read the
     drafts (#171, #284).
     Successful `/__worklist/mutate` advance/prune promotes matching
     drafts from `feedback-drafts/` to `feedback-history/` so drafts do
     not accumulate. Each draft write emits a `[feedback-draft] op=write`
     trace line with `feedback_id` and byte count. Approve and Drop
     still use the inline `{id, feedback}` shape (their feedback is
     usually short); their migration to `feedbackRef` is filed as
     follow-up. See #144.

3. **Mechanical transitions** — `POST /__worklist/mutate` is the only
   channel for approval-driven state changes:
   - `{"op":"advance","ids":[...],"status":"applied"}` after an
     approved apply.
   - `{"op":"prune","ids":[...]}` after a drop, or after a commit of
     already-`applied` items.

4. **Empty state is fine** — `{ "description": "", "items": [] }`.

### Transports

Both transports dispatch through the same host-side handlers, so
response kinds, consume-on-read, the inflight sentinel, and the auth
checks are identical. What differs is *how* the call is made.

**Apply gate: skip `resolve` — edit, then `mutate op:"advance"`.** The
host sets the inflight sentinel at approval time (on the `toTurn` write
path, the way `iterate:` does), and `mutate op:"advance"` consumes the
`approved` auth, so `resolve`'s two side effects are covered without a
round-trip. Its return value is dead weight for an apply — the bodies are
the proposal you authored. So an apply-approve is one call: edit from the
proposal, then `mutate op:"advance"`.

**The third outcome: approved, investigated, nothing to apply.** An approve
gate has three endings, not two. Besides "work applied" and "work applied and
committed", there is the case where the first step of the approved item
falsifies its own premise — the investigation shows the change is unnecessary,
or the hypothesis it rested on is wrong. This is a normal ending, not a
failure, and it has its own handling:

- **Do not `mutate op:"advance"`.** Advancing asserts the work is on disk. It
  is not, and marking the item `applied` produces a row with nothing to
  commit.
- **Retire the claim explicitly.** The host set the inflight sentinel at
  approval time and nothing on this path clears it, so the spinner runs and —
  because row selection is locked while a claim is live — the user cannot even
  click Drop to resolve it. Call
  `POST /__worklist/end` with `{"ids": [...]}` naming the approved ids.
  Both the method and the body are required; a `GET` returns `POST only` and
  an empty body returns `{"error":"ids[] required"}`.
- **Report the finding in chat and recommend Drop**, exactly as the
  *investigation reveals nothing to commit* guidance above prescribes for the
  `advance` case. This extends that rule to cover the claim.

Live case, 2026-08-24: `issue-275-transcript-row-remount-churn` was approved to
apply, its first step disproved the item's own hypothesis, no files changed,
and no lifecycle call was correct to make. The claim stayed live and locked the
row until it was unwound by hand.

The same rule covers a subtler ending: **a turn that ends by asking the user
a decision must not leave a claim live.** Holding the claim "while you
decide" locks the row, so the two buttons that ARE the answer (Approve /
Drop) are unavailable, the spinner implies work that is not happening, and
the only remaining channel — a verbal reply in chat — is advertised nowhere
on the surface. Call `POST /__worklist/end` before ending the turn; the
row unlocks and the decision gets ordinary affordances. (Live case,
2026-08-26: `issue-262-cross-project-direct-edit-auth`'s apply surfaced a
premise conflict with the issue's recorded disposition; the orchestrator
held the claim across the question and the user was left asking "nobody is
working but we are still spinning" with no visible way to respond.)

And an apply-and-commit gate has a FOURTH ending in the same family
(issue-348, where it ran the spinner for minutes with rows locked): **the
user takes over the commit.** "I'll commit" is an ordinary thing to say —
Commit is a button — but the claim set at approval expects the agent's
`worklist-commit` to retire it, and a turn that ends on the user's
announcement leaves the claim live, which locks row selection and thereby
bars the user from the very Commit they announced. When the user says they
will commit (or you end the turn handing them that choice), call
`POST /__worklist/end` with the approved ids before ending the turn — the
row unlocks, the pane's Commit works, and the host is already resilient
from there: `worklist-commit` retires claims by the ids it resolves,
whichever approval carried the click.

**Apply-and-commit gate: skip `advance` — edit if needed, then
`worklist-commit`.** `gate: "apply-and-commit"` is no longer only the
pre-approval one-click **Start & commit** button's payload. As of
0.5.1 the pane also puts a plain **Commit** on a `proposed` item that
has already begun and whose changes are EXCLUSIVE — every changed path
free of any other begun item's claim (`window.__bramSelectionAllCommittable`
in `helpers.js`). Clicking either control submits the identical
`gate: "apply-and-commit"` shape, and the host side is unchanged between
them — the widening is entirely in when the pane *offers* the button, not
in what the host accepts. So the agent handles both triggers the same
way: whatever produced the payload, do **not** `mutate op:"advance"`
first. Make any remaining proposed file edits, then call
`worklist-commit { ids, message }` directly — the host commits the
still-`proposed` item's files (authorized by the `commitToo` auth record
the click wrote, the `allow_proposed` path) and prunes, exactly as the
commit gate does. `closesIssues` / close-on-push behave identically to a
normal commit. The host sets the sentinel at approval time and
`worklist-commit` clears it. Both triggers — the one-click Start &
commit button and the widened plain-Commit offer — are always available.
(A `worklist.oneClickApproveCommit` setting once gated them; it was
retired in the 0.5.3 run after its config-off path produced a dead-end
row — the offer was only ever visibility, never authorization, so
removing the flag removed a bug class and no capability.)

**Interval staging (#327) makes entangled commits safe, so Commit is
offered on any begun item with changes.** When a commit would stage a
path carrying lines attributed to a begun item *outside the request*,
`worklist-commit` no longer refuses — it stages only the requested
items' OWN hunks: their claim-interval patches applied to a scratch
index seeded from `HEAD`, committed via `git commit-tree` +
`update-ref`, with the worktree and the real index **never touched**.
The neighbour's uncommitted work simply stays in the worktree
(`git diff HEAD` then shows exactly it). The commit is hunk-exact —
per-item authorship is preserved in git history, which is the
misattribution this whole mechanism exists to prevent (trace:
`op=entangled-interval-stage` then `op=interval-staged`).

Order-independence is decided by git, not enforced: the interval
patch is gated with `git apply --check` against the HEAD-seeded index.
Success means any order is fine; failure means the requested item's
change is *defined relative to* another begun item's work not in the
request, and the response names the item to commit first. `--3way` is
deliberately not used (it writes conflict markers and succeeds).

The **409 refusal survives only** when an entangled item has NO claim
interval to stage from — work predating the capture phase, or done
with no claim live. There is nothing to isolate, so the honest answer
is to commit the items together (safe: every line accounted for by an
id in that commit) or separate the hunks by hand. This is also the
`no-interval` fallback the host reports.

Consequently the pane offers Commit on any begun item with changes of
its own (exclusive or shared), and the strip's `unique:` figure is what
a commit now takes on a contended path. The #336 whole-file
withholding, and the #337 selection-scoping that softened it, both
retire into interval staging.

**The dangerous default is the opposite of the intuition** (#336's
field lesson, stated because the person who wrote these conventions
had it backwards): committing all N entangled items **together** is
safe — every changed line is accounted for by an id in that commit —
while committing **one of N** is what silently absorbs a neighbour's
work. Separation is the risky operation, not aggregation.

**Commit gate: call `worklist-commit`.** This is the traditional
two-stage path: every id in the request is already `applied`, so
`gate` is plain `approved`, not `apply-and-commit`. Send one request
with `{ ids, message }` when the selected items land together. For
`split-shared-files`, isolate one item's hunks on disk, call
`worklist-commit` for that id, restore the next item's isolated hunks,
and repeat. The interval-diff route serves each item's own patch, and
`git apply --check` (forward and reverse) gates each step — both
field-proven exact (#336's follow-up: two entangled items, `unique:`
figures matching the isolated diffs to the line). **Build-gate every
intermediate state before committing it**: hunk isolation can produce
a tree that compiles in neither direction, and a non-building
intermediate commit poisons `git bisect` for exactly the
investigations these per-item commits exist to support. Each successful subset call retires only those ids from the
authorization and inflight claim; the remaining ids and embedded item
bodies stay live for the later commits, and the final call consumes the
record. The host verifies approved auth, requires every requested id to
be `applied` (relaxed to also accept `proposed` only when `commitToo` is
set — see *Apply-and-commit gate* above), stages only those items' files,
refuses unrelated staged files, commits, and prunes the requested
items. **Issue close is
automatic — the agent does nothing.** When the approved feedback
carries `close-issue:` selections (from the close-on-commit
dialog), the host records only the requested ids' selections at commit
time bound to that commit's SHA, then
closes each issue automatically after the user's next explicit **Push** (only
once its commit reaches the default branch; in a squash-merge repo, a merged
PR containing the commit completes the close instead, and a queued close
whose issue is already closed by other means retires — #282). There is no
agent-reachable close
route — `/__issue/close` was removed — so there is nothing for the agent to
call and no close step to instruct the user to run; closing follows Push with
no further action (close-on-push-automatic, security H5). Closing never pushes.

**`worklist-commit` is single-shot per approval — on a timeout, never
re-POST.** A large commit takes as long as `git` takes: an 85-file commit
ran past a caller's 120 s tool timeout (#308), and a blocked HTTP request
looks identical to a wedged one. It is not wedged, and the retry is the
dangerous move, because a timeout tells you nothing about the route: it may
still be staging, or it may have committed and returned into a socket
nobody was reading. So when the call times out, **check `git log` first**
and treat what you find there as the answer. The route is built to survive
the mistake — it serializes against itself, so a re-POST queues behind the
in-flight commit rather than racing its `git` invocations, and the approval
is consumed exactly once, so the second request cannot produce a second
commit. What it returns instead is an error naming the completed commit
("this commit ALREADY RAN … verify with git log"); read that as success,
not failure. Watch the phases in
`resources/bram-traces/bram-trace.log` — `[worklist-commit] op=staging`,
`op=committing`, `op=committed` — to tell a long commit from a stuck one
without touching git state.

The Codex intent channel carries the same rule: **do not rewrite
`resources/.worklist-intent.json` with a fresh nonce after a slow commit.**
That is the re-POST in another spelling, and the intent file is the one
transport where writing again is trivially easy. Read
`resources/.worklist-result.json` and the git state first; a result whose
nonce matches your original request is still coming, and the commit it
describes may already exist.

**Drops: still `resolve` before `mutate`.** Resolve returns the recorded
items and writes the drop sentinel (drops aren't set at approval time), then
`mutate op:"prune"` clears it.

#### Claude: loopback curl

Bram writes its bound port at startup to `resources/.bram-port` (plain
decimal, no newline). Read that file once and substitute the literal
number into curl:

```
curl -4 -sS --retry-connrefused --retry 3 --retry-delay 1 \
  "http://127.0.0.1:61455/__worklist/resolve"
```

(replace `61455` with whatever `Read resources/.bram-port` returned).
The literal port matches the `.claude/settings.json` allowlist and
runs without a prompt. `$BRAM_PORT` won't work — Claude Code's
permission matcher doesn't expand variables, so `$` breaks the match
(see https://code.claude.com/docs/en/permissions.md).

The POST routes (`worklist-mutate`, `worklist-commit`) have their
own allowlist entries, but the match is narrow — keep the call in
this exact shape or it will prompt:

```
curl -4 -sS --retry-connrefused --retry 3 --retry-delay 1 -X POST \
  -H "Content-Type: application/json" --data @/tmp/body.json \
  "http://127.0.0.1:61455/__worklist/commit"
```

Two pitfalls, both of which prompted a real `worklist-commit` call:

- **Include literal `-X POST`.** The POST allowlist entries require
  it; relying on `--data` to imply POST matches neither the POST
  entries (which need `-X POST`) nor the GET entry (whose URL must
  follow `--retry-delay 1` with no flags between).
- **Keep the curl a standalone command.** Build the JSON body in a
  *separate* Bash call (`jq … > /tmp/body.json`), then `--data
  @/tmp/body.json`. A compound `cat <<EOF … && jq … && curl …` makes
  the command string start with `cat`, so no `curl …` prefix can
  match and the whole thing prompts. The body-building step is also
  where apostrophes/quotes in a commit message belong — out of the
  allowlisted curl line.

Flag rationale:
- `-4` + `127.0.0.1` (not `localhost`): Bram binds IPv4 only;
  `localhost` may try `::1` first and fail with `curl: (7)`.
- `-sS` (not `-s`): `-s` swallows `Failed to connect`, so a stale-port
  race surfaces as `(no output)` instead of `curl: (7)`.

If the port keeps refusing after fresh re-reads, treat it as a
stale-port / restarting-server diagnostic — don't continue without
the lifecycle call. Check the Status tab's **Port file** row, which
cross-checks the running process, `.bram-port`, and the
`.bram-port.json` sidecar (port + pid + project root + startup
timestamp). If `.bram-port` is missing entirely (agent launched
outside Bram's PTY shell), fall back to
`lsof -nP -iTCP -sTCP:LISTEN | grep bram`.

#### Codex: filesystem intent/result files

Codex's `workspace-write` sandbox refuses loopback connections (issue
#130); the only knob that would fix it (`network_access = true`)
grants all outbound network. So Codex drives the lifecycle through
two coordination dot-files instead:

1. **Write** `resources/.worklist-intent.json`:

   ```json
   { "nonce": "<unique-per-request>", "route": "<route>", "body": { ... } }
   ```

   `route` is one of `worklist-resolve`, `worklist-mutate`, or
   `worklist-commit`. `body` matches the HTTP route:
   - `worklist-resolve` — omit, or `{ "ids": [...] }` to filter.
   - `worklist-mutate` — `{ "op": "advance", "ids": [...], "status": "applied" }`
     or `{ "op": "prune", "ids": [...] }`.
   - `worklist-commit` — `{ "ids": [...], "message": "..." }`.

   There is no `issue-close` route: closing is fully automatic on the
   user's next Push (close-on-push-automatic, security H5). The agent
   never writes a close intent.

2. **Read** `resources/.worklist-result.json` for the record whose
   `nonce` matches (ignore stale results from prior requests):

   ```json
   { "nonce": "<echoed>", "ok": true,  "status": 200, "result": { ... }, "completedAtMs": 0 }
   { "nonce": "<echoed>", "ok": false, "status": 400, "error":  { ... }, "completedAtMs": 0 }
   ```

   `result` is byte-for-byte what the HTTP route would have returned.
   The host writes within watcher latency (a few ms) and then deletes
   the intent file; a brief read-retry covers the race. **Do not
   continue silently** on a missing result or `ok: false`.

The Codex PreToolUse guard exempts `.worklist-intent.json` from
worklist coverage — it's a coordination file, like the loopback curl
is for Claude. Trace each drain by grepping `[worklist-intent]` in
`resources/bram-traces/bram-trace.log`.

### Authoring conventions

#### Choosing an id

For items clearly derived from a single GitHub issue, prefix the id
with `issue-<N>-` followed by a short slug
(`issue-86-pty-intent-relay`, `issue-91-defer-sentinel-clear`). Skip
the prefix for exploratory items, cross-cutting refactors, or items
that touch multiple issues — use a bare descriptive slug
(`worklist-drafts-separate-prose-from-metadata`).

The prefix complements `closesIssues` rather than replacing it: the
id is for human scanning (Worklist tab, `git log`, chat),
`closesIssues` drives the close-on-commit dialog. Pair them when
both apply.

Item ids are **immutable**. Renaming is not supported: removing an
existing id from `worklist.json` reads as an unauthorized prune and the
host reverts the write, while any draft file you already moved stays
moved — leaving the row with `_draftMissing` and no prose until someone
restores the filename by hand. The rollback is silent; your write
returns success, so nothing tells you it failed. If an id turns out to
under-name its item, keep the id and say so in the draft. Tracked in
judell/bram#276.

#### Keep the `files` list current as understanding evolves

An item's `files` is the agent's *prediction* of what the change will
touch, and the pane's change-activity count uses it as the denominator
(`files: 2 of 3 planned`). When a listed file proves unneeded mid-work,
**update the item's `files` to match** — an ordinary `worklist.json`
edit (version-bumped, guard-allowed) — so the count converges to
`N of N planned` before the commit gate. The draft prose keeps the
original prediction as the audit trail. The clean expression of "the
plan was wrong, not the work" is a corrected plan, not a caveat on the
count; a committed item whose count still reads `2 of 3` invites the
misreading that work went missing (live case: 2026-08-20,
`rethink-activity-indicators`, where an unneeded `helpers.js` guess
made a complete commit read as a partial one).

#### Refer to items by id, not by ordinal

Name worklist items in chat by their `id` verbatim
(`codex-launcher-require-hook`), never by position ("item 3", "the
second one"). Ordinals shift as items move through approve / apply
/ drop / prune; ids are stable and match the Worklist tab UI and
the `approved:` / `drop:` payloads.

#### Match prose verbosity to change complexity

Match `before` / `after` prose to the size and judgment-load of the
change.

**Small, mechanical changes** (typo, one-line tweak, rename, clear
bug with one obvious fix): a short paragraph each is enough. Don't
pad with alternatives-considered when there was effectively one
path — the commit message + diff carry the audit trail.

**Complex or judgment-load changes** (multiple reasonable
approaches, multi-file non-mechanical, *why* will fade in a month):
name the alternatives, mark `[chosen]` on the picked path:

> Alternatives considered:
>
> - Embedded diff via DataSource — rejected: each row would fire its own request.
> - Full-tree diff at the top of the worklist — rejected: hides per-item attribution.
> - **[chosen]** Server augmentation via `/__worklist` — single payload, per-item diffs travel with each row.

Rule of thumb: would a reader six months from now reconstruct the
decision from current code + git log alone? Yes → short. No →
fulsome.

#### Use Markdown in item prose

Worklist `before` / `after` prose and worklist-history entries
render as Markdown in the agent pane. Use real syntax: `- `
per bullet (not inline `(a) ... (b) ...` enumerations that collapse
to one paragraph), backticks for inline code, fenced blocks for
multi-line snippets, blank lines between paragraphs, `**strong**`
sparingly (e.g. **[chosen]**).

#### Minimize the bytes of each worklist edit

`worklist.json` stays a compact metadata index; iterate-time prose
edits hit only the draft file. Full-item `Write` rewrites of
`worklist.json` are valid but wasteful for one-paragraph tweaks
that don't actually need to touch `worklist.json` — prose changes
go to the draft alone. Mechanical prune / advance go through
`/__worklist/mutate`, not direct rewrite.

#### Don't `grep -n` a single-line JSON file

`worklist.json` is one line; grep dumps the whole file into the
transcript. Use `Read` with `offset`/`limit` or `jq` to extract
just what you need.

#### Don't update `after` prose on every iterate

Small TO-COMMIT refinements don't need an audit trail in the
worklist — the commit message and diff cover it. Update the draft
file's `after` only when scope materially expands (new file added
to `files`, or the change's intent shifts).

#### Test Worklist UX through the worklist itself

When a change touches the Worklist UX (button states, gray-out,
feedback flow, pruning), surface it as a pending item even when the
diff is already on disk. Approving the item exercises the new
behavior end-to-end — file rewrites, pruning, Talk-page update — as
the actual test.

### Enforcement and security contract

The structured `approved:` / `drop:` line is not authority by itself.
The host records each clicked id into
`resources/.worklist-authorization.json` with its kind (`approved` /
`drop`); `/__worklist/resolve` is the only way an agent receives the
recorded item bodies; `/__worklist/mutate` is the only way an agent
advances or prunes:

- `advance` requires an `approved` auth record covering every id.
- `prune` requires `drop`, except the post-commit prune path also
  accepts `approved` when the requested ids are already `applied`.

Same-turn `resolve → edit files → mutate` is valid: `mutate` reads
the stored auth record, not just resolve's consumption state.

There is **no content-hash verification**. An earlier design recomputed
each item's content hash at record time and flipped mismatches to a
`rejected_stale` kind — an optimistic-concurrency guard against the
worklist changing between click and record. Bram only ever shares a
worklist between agents **serially, never concurrently**, so that guard
never fired and was removed. The remaining concurrency guard is the
`version` integer on `worklist.json` (file-write races, hook-enforced);
self-authorization is gated structurally — `resolve` / `mutate` are the
only channels and the auth record is consumed on read — not by a hash.

Defense in depth: Claude and Codex each install PreToolUse hooks
that validate worklist coverage before file-mutating tools run, and
the desktop watcher reverts unauthorized prunes. Both guards also
reject `worklist.json` writes that put non-empty `before` /
`after` on any proposed item — prose must live in
`resources/worklist-drafts/<id>.md`. Hook errors and revert
messages are the convention enforcing itself — not bugs to work
around.

**Don't ask before editing the worklist or calling mutate.** The
proposal-authoring write channel is hook-guarded, the mechanical
transition channel is the server endpoint. No verbal confirmation
is needed to add items, refine prose, or call `mutate` for an
already-approved transition. Save the verbal back-and-forth for
design decisions (which items to propose, what to bake in), not for
mechanics.


## Talking to users

### Name UI affordances, not protocols

When the user needs to take an action that has a UI control, name the
control. Say "Click the **Start** button" (Start & commit, Commit,
Refine, Drop, Push, Trust this hook, Setup). Never say "send `approved: {...}`", "paste the
structured approval payload", or describe the wire format — the button
generates the verified payload for them. This is what reopened #62:
Codex told the user to paste raw JSON instead of pointing at the
Worklist tab.

### Keep internal jargon out of user-facing chat

"Inflight sentinel", "resolve/mutate", "PreToolUse hook", "worklist
authorization record" describe internals. In chat, talk about what
the user sees and does: "the Worklist tab", "approve the item", "the
spinner cleared". Use the jargon only when the user has asked about
internals, or when you're pointing at a file path they'll need to grep.

### Cite, don't gesture

When referencing a file, route, or doc, name it (`resources/worklist.json`,
`/__worklist/resolve`, `docs/apis.md §11`) so the user can verify in
one click. Vague references ("the worklist system", "the relevant
config") force a follow-up question. Same rule as the CLAUDE.md
guidance: if you can't cite, say so.

### Match terseness to the question

No preamble ("Great question!", "Let me explain..."), no restating the
user's question, no trailing summary of what you just did unless it's
load-bearing. The Worklist tab shows the items, the diff shows the
code; chat is for what those surfaces can't show.

### Narrate as you reach for tools

Before a tool call (or a batch of them), say in a sentence what you
are about to do and why — "rebuilding the engine to pick up the
tooltip fix", "rerunning the one failing spec before the full suite".
When a result changes your plan, say so before acting on the new plan.
Long-running work (builds, test suites, background tasks) gets a
status line when it starts and when it lands, not silence until a
final summary.

This does not conflict with *Match terseness to the question* — the
audit trail in worklist drafts and commit messages still carries the
full story; narration is the live, one-line version so the user can
follow (and redirect) work in flight.

### Cross-project pivots

When the user pivots the conversation to work on a different project
("let's look at ~/other-app"), flag the boundary before proceeding and
offer the choice: a quick read-only look from here, or a handoff to that
project's own session. Sustained investigation, issue filing, and
follow-up work belong in the target project's session, because project
memory — session transcripts, the `/__search` index, worklist history —
is scoped by working directory and records work where it *runs*, not
where it belongs: the home project's index fills with foreign content
while the target project keeps no record the work happened. If the user
chooses to proceed from the current session anyway, make any artifact
left in the target project (issue, doc, commit message) self-contained —
carry the evidence inline rather than pointing at the wrong project's
transcript.

That subsection is about pivoting *this* session's attention. When two
sessions both stay put on opposite sides of a boundary and coordinate,
see *Working across project boundaries* below.


## Signing agent-authored forge artifacts

**Every agent-authored forge artifact opens with a signature** — issue
bodies, issue comments, PR descriptions, PR comments, reviews. Every
repo, boundary or not.

The reason is not "which project is this from" but **who is speaking**.
Agents post through the human's account, so an unsigned agent comment is
indistinguishable from one the human wrote, and that is equally true in
the project you are sitting in. An earlier version of this convention
scoped the requirement to artifacts that cross a project boundary; the
result was judell/bram#253, where unsigned agent comments sat beside
Jon's own replies while a cross-boundary issue filed in the same period
was correctly signed. The record was inconsistent along an axis no
reader cares about. The cross-boundary case is a subset of the problem,
and it was mistaken for the whole of it.

**The form.** One canonical opener, nine slots, all load-bearing —
*which build*, *whose* agent, *which* agent, *which thread*, *which
model*, *which platform*, *which machine*, the familiar project name,
and the exact repository that anchors the speaker's evidence:

    <owner>'s <Agent> (Bram <version>, <thread>, <model>, <os>, <machine>) speaking from the <Project> project (<forge-host>/<owner-or-group>/<repo>):

`<version>` is Bram's own version and leads the parenthetical — it is
first because "which build?" is the question a reader asks before any
other triage step, and a version-less report is expensive to place after
the fact: judell/bram#343 and #362 are both field cases where the
absence of a version cost real archaeology to reconstruct which build a
report came from. A running instance reads its version from
`GET /__app-info` (`current`); a managed project without a live instance
reachable reads the `<!-- bram vX.Y.Z -->` marker on the first line of
`.claude/bram-conventions.md`. If neither is reachable, write
`Bram unknown` rather than guessing. `<thread>` is `main thread` or
`subagent`; `<model>` names the model producing the words; `<os>` names
the host platform — `macOS`, `Windows`, or `Linux` (finer detail like a
distro is allowed, not required); `<machine>` is the host's short
hostname (`hostname -s`; `COMPUTERNAME` on Windows). This project's
instances:

    Jon's Claude (Bram 0.6.5, main thread, Fable 5, macOS, Tuck) speaking from the Bram project (github.com/judell/bram):
    Jon's Claude (Bram 0.6.5, subagent, Opus 5, macOS, Tuck) speaking from the Bram project (github.com/judell/bram):
    Jon's Claude (Bram 0.6.5, main thread, Opus 5, Windows, JON-PC) speaking from the Bram project (github.com/judell/bram):
    Jon's Codex (Bram 0.6.5, main thread, gpt-5.2-codex, macOS, Tuck) speaking from the XMLUI project (github.com/xmlui-org/xmlui):

Older signature forms (no version slot, or no os/machine slots) remain
valid historical text, and — same soft rollout as the #346 os/machine
slots — the guards do not yet enforce this slot's presence on a new
write; they parse it when present and leave it optional otherwise.

The repository locator is the checkout's `origin`, normalized to
`host/path`: omit the scheme, credentials, trailing slash, and `.git`.
Do not assume a public forge or a two-segment path —
`gitlab.com/group/subgroup/project` and
`forge.example.org/team/project` are valid. The familiar project name
stays because it reads well; the locator is the unambiguous identity
across forks, mirrors, same-named repositories, and forge providers.

A form that names only the project ("from the xmlui side") leaves "who
is speaking" unanswered, which is the half that matters when two agents
work the same thread. Across a boundary the third slot also answers
*which side the evidence comes from*. The second and third
parenthetical slots, `<thread>` and `<model>` (added 2026-08-28, when
multi-agent orchestration made them unrecoverable otherwise — the
version slot leading the parenthetical is newer still, see below),
answer *evidential standing* — an orchestrator holds the design
discussion, a delegated subagent saw only its brief — and
*attribution*: judgment quality belongs to the model that produced the
words, and heavy passes routinely run on a different model than the
main loop. The fourth and fifth, `<os>` and `<machine>` (both added
2026-09-05, judell/bram#346), answer *which machine*: two sessions of
the same owner's same agent coordinating across platforms render
otherwise-identical signatures, and the model
name doesn't reliably distinguish them — on #346 every participant read
"Jon's Claude … (github.com/judell/bram)" and the thread was illegible.
The hostname slot also makes the signature machine-READABLE provenance:
Awaiting You classifies a same-account comment by it — unsigned means
the human typed it, this host's name means this machine's agent, any
other means *your agent elsewhere moved* and the row surfaces — which
is the only way that surface can see cross-machine agent activity at
all, since every agent posts through the owner's account and forges
send no notifications for one's own comments.

Two rules that follow:

- **The executor signs.** Whoever makes the forge write signs with
  their own thread and model; a subagent's findings posted by the
  orchestrator are the orchestrator speaking (its signature), with the
  subagent's work attributed inline where it matters.
- **Old-form signatures remain valid historical text, not valid new
  writes.** Do not retrofit old threads merely because the form grew.
  The guards require the full current form on every new inspectable
  artifact. If the checkout has no network-shaped `origin` (for example
  a new local-only repository), they still require a syntactically full
  locator but cannot compare it to an expected remote; state that
  limitation rather than implying remote verification.

**The scope.** **Every artifact, not just the first in a thread.** The
observed failure is decay: the opening comment is signed, and by the
fourth it has worn down to "Short addendum —" because by then it feels
redundant. It isn't. The reader the signature exists for — someone
opening the thread months later, or a third agent joining mid-way — has
no memory of comment #1.

Commit messages are deliberately excluded. Conventions ask for a
signature on any commit message another session will read, and that
stays as-is: commit subjects are short, `git log` is dense, and commits
already carry an author field that the comment box does not.

**The retrofit rule.** If you notice a missing signature after posting,
add it in a *new* comment rather than only editing the body. A body edit
fixes the page; it does not reach anyone who already got the
notification, and a silently-corrected record reads as a discipline that
was not there.

**Enforcement.** Both provider guards check this on `PreToolUse` and
**deny** an unsigned forge write rather than warning. You should never
meet that check: sign by default and it never fires. A denial means you
forgot, and costs one turn to fix. The guards fail open only when no
inspectable prose body exists (`--body-file -` or a metadata-only command
with no body flag). A named body file that should be readable but is not
is denied rather than silently bypassed. Coverage includes issue/PR/MR
prose writes, GitHub gists, GitLab
snippets, and inspectable `gh api` comment/gist writes. Recognized
file-backed writes whose named file cannot be read are denied; stdin and
metadata-only commands remain explicit unparsed cases because there is
no body the hook can judge.

**Write the body file in its own step.** Build the body in one call,
post it in the next — never both in a single command. `PreToolUse` runs
*before* the command executes, so a body written by that same command
does not exist yet when the guard looks for it, and the check fails open
against the very artifact it exists to verify. The `--body-file`
indirection itself is still right (it keeps apostrophes and quotes out of
the allowlisted command line); only the ordering matters.

Two things follow from getting it right: the signature is genuinely
verified rather than nominally required, and an issue-only post is
allowed on its own merits rather than depending on whatever worklist
items happen to be in flight — a heredoc redirect in the same command is
another write pattern, which correctly disqualifies the issue-only
exemption. The deny reason names which happened (#331 — an unreadable
body was previously reported as an unsigned one, steering the fix
effort at the wrong target):

- `crossboundary-unparsed:body-file-unreadable` — the named body file
  could not be read; the write is denied (never silently bypassed) and
  the message names the path that failed to open. Quoted paths and, on
  Windows, MSYS `/c/...` spellings are accepted.
- `crossboundary-unsigned` — the body was read and lacks the
  signature.


## Working across project boundaries

Some of the best work happens between two sessions that each hold
evidence the other cannot reach, coordinating through issue threads.
Three shapes recur, and the practices are the same in all three — only
the asymmetry differs:

- **Downstream ↔ upstream.** Your project consumes a library; a bug or
  gap here is a change there.
- **Machine ↔ machine.** The same repo running on two platforms, where
  a failure reproduces on only one of them.
- **Agent ↔ agent.** The same repo, two agents, each able to reach
  things the other can't.

### Name the boundary

Say which side of the boundary you are on, and scope every claim to it.
The *signature* that carries this is not boundary-scoped — it is required
on every agent-authored forge artifact, in every repo. See *Signing
agent-authored forge artifacts* above for the form and the rule.

### Scope claims to what your side can observe

Say "from this side" and mean it. State what you verified and how; name
what you *cannot* check from here rather than letting silence imply
it's fine. *Local absence is not disproof* (in *Log-first development*)
is the special case of this rule for machine-specific artifacts; this
is the general one.

### The thread is the design document

Chat dies with the session; the thread is what the other side reads,
and months later it's the only record of why. So file at mechanism
depth — symptom, the mechanism cited at the *other* side's
`file:line`, blast radius, and the trace or measurement receipts — not
"this seems broken."

One issue, one mechanism. When a second mechanism surfaces mid-thread,
split it into its own issue and say in both places what moved and what
remains.

### Make the ask specific, and report gates by name

Ask for something answerable: a litmus test to run, a build to
validate, a specific gate to clear. When work is gated, enumerate the
gates and report their status per side ("gate 2 is green; from this
side, remaining: ..."), so neither session has to guess what the other
is waiting on.

### Green-light before irreversible or expensive steps

Vendoring a candidate build, merging, restarting something shared —
request the go-ahead across the boundary explicitly, and grant it
explicitly. An assumed green light is how two sessions end up half-way
through incompatible states.

### Reproduce before fixing; correct the record in public

On the other side of a boundary the currency is a reproduction — a
failing test pins the decision so prose doesn't have to. Build it
before proposing a fix, because it frequently contradicts the filing.

When it does, post a **correction comment** carrying the measurements.
Do not quietly edit the original body: the other side may have already
acted on it, and the correction is the most useful thing in the thread.

### Recompute rather than defer

Being upstream, or being the side where the bug reproduces, is not
authority over arithmetic. When the other session's claim conflicts
with yours, re-run the numbers and read the source before conceding —
then concede once, to the evidence, and move on. Deference and
digging in are the same failure.

### Verify the artifact you run, not the source diff

A merged fix, a green CI run, and a source diff are not the build in
your hands. Verify the artifact you actually execute (checksum,
marker string, behavioral probe), and when you report results, label
which of your instruments are authoritative and which are only
corroborating.

### Render what the reader will see

The rule above has a second half for changes whose deliverable is
something a human reads or sees — a docs page, a pane surface, a
rendered table: the artifact-you-run is the **rendered output**, and
the commit gate includes looking at it. A passing spec verifies
behavior, not communication. Receipt (xmlui wave 3, 2026-08-27,
judell/bram#291): five real defects surfaced only when the committed
how-to pages were opened in a docs server — clipped playgrounds, a
bold run that swallowed its lead clause, a demo whose central claim
was invisible because the spec drove the selection itself — every one
invisible to green tests and to reading the markdown. When the work
is delegated, this must be an explicit instruction in the subagent's
prompt, not an assumed judgment: a delegated agent that cannot verify
its own work will report success (wave 1's lesson), and "verify"
for a rendered artifact means render it.

### Close every hard stretch with two questions

This is the engine that turns local pain into shared improvement.
When a struggle ends, ask:

- *What documentation would have short-circuited this?* → name the
  question you couldn't answer and where you looked.
- *What feature would have obviated this workaround?* → carry the
  workaround itself as the evidence.

Then file each one on the other side. If that boundary doesn't take
issues from you, write the ask up locally anyway, fully formed and
evidence-backed, so it exists the day a channel opens.

Any workaround you land carries the issue number it's waiting on, and
its retirement is its own worklist item. A workaround with no filed
issue is a decision to keep the pain.

Where the other side publishes a searchable doc corpus, the
documentation half has a stricter form — validate the gap against the
current corpus before filing, since the fastest way to lose standing
is to report a gap that closed last week. See *Coordinating MCP demand
with search*.

### Carry gated follow-ups, and don't edit across the boundary

Actions gated on the other side (a merge, a release, a verdict) become
**placeholder items** — see *Placeholder items (droppable reminders)*.

Act only in the repo whose session you're in. The thread is the
transport, not a shortcut for reaching across and editing the other
project directly.


## Host-managed inflight sentinel

The Worklist spinner is keyed to `resources/.inflight-claim.json`,
which host-side HTTP handlers write and clear. Full route / file-shape
reference: `docs/apis.md` §11. Agent-side conventions:

### What the agent calls

- **`approved:` (apply gate)** → no `resolve`. The host detects the
  `approved:` prefix on the `toTurn` write path and sets the sentinel
  automatically (the way it does for `iterate:`). Edit from the proposal
  you authored, then `mutate op:"advance"`, which consumes the `approved`
  auth and clears the sentinel. One call.
- **`approved:` (commit gate)** → `worklist-commit` with `{ ids, message }`.
  The host stages only the approved files, commits, prunes, consumes auth,
  and clears the sentinel. If the approved feedback includes `close-issue:`
  lines, the host itself records the pending close bound to the new SHA;
  the agent does nothing further — closing fires automatically on the
  user's next Push. There is no `issue-close` route to call.
- **`approved:` (apply-and-commit gate)** → `worklist-commit` with
  `{ ids, message }` after editing, with **no** `mutate op:"advance"` step.
  Set by either the one-click **Start & commit** button or, as of
  0.5.1, a plain **Commit** on a `proposed` item that has begun with
  exclusive changes; the host's `commitToo` auth lets `worklist-commit`
  stage and commit the still-`proposed` files, then prune either way.
  See *Transports → Apply-and-commit gate*.
- **`drop:`** → `resolve` → `mutate op:"prune"`. Drops aren't set at
  approval time, so `resolve` is what raises the spinner.
- **`iterate:`** → no agent-side bracket needed. The host detects the
  `iterate:` prefix on the `toTurn` write path and sets the sentinel
  automatically (parallel to how `resolve` sets it for the commit gate and
  drops); the same turn-finished detectors that clear approve/drop
  sentinels clear iterate's too. (The legacy `/__iterate/begin` and
  `/__iterate/end` routes were removed in the #214 delete phase.)

Several of the bullets above say a mutate/commit call "clears the
sentinel" — true in the common one-id case, but see *Incremental claim
and authorization retirement* for what actually happens when the claim
covers more than one id.

### Incremental claim and authorization retirement

A claim can cover more than one id — approving several unentangled
items in one click writes one claim listing all of them. Resolving
just one of those ids is normal now, not refused: `mutate
op:"advance"`, `op:"prune"`, and `worklist-commit` (which delegates a
prune to the same path) each retire exactly the ids they resolved and
rewrite the claim with whatever is left, tracing
`[inflight-sentinel] op=clear-shrink resolved=[...] remaining=[...]`.
The claim file only disappears once the last id resolves. This is what
lets two disjoint items be started together in one click and then
completed — applied, committed, or dropped — in separate turns, each
clearing its own slice of the spinner instead of leaving it stuck until
every id is accounted for in a single call.

The authorization record retires by the same named subset. Until the
last id resolves it keeps `consumedAtMs` empty, removes the completed ids
and their embedded bodies, and traces
`[auth-record] op=consume-shrink resolved=[...] remaining=[...]`. This
is load-bearing for `split-shared-files`: one plural Commit approval can
produce several sequential `worklist-commit` calls without the first
commit consuming authority for the rest. The original `issuedAtMs` and
interrupt flag remain unchanged, so TTL and cancel fail-closed behavior
still cover the entire sequence.

This is distinct from `op=clear-partial`, which is still a refusal: the
blunt clears — turn-end detectors, cancel paths, startup cleanup, the
drop policy validator — cannot name which ids they're resolving, so
they still require full coverage of whatever claim is live, and log
`op=clear-partial` when a request covers only part of it. That shape
signals something colliding (a second claimant overwrote or partly
overlapped the live claim), not ordinary progress — do not read
`clear-partial` as "working as intended" the way `clear-shrink` is.
Only routes that resolve specific, named ids may shrink.

### Failure modes

A stuck spinner is the convention enforcing itself; there is no
arbitrary live-session timeout. Bram does have host-side completion
detectors that can clear a lingering claim without a cooperative agent
tail call: Claude session JSONL `stop_reason:"end_turn"`, Codex session
JSONL `task_complete`, PTY silence, and explicit cancellation paths. Most
commonly:

- **Approved/drop stuck:** `mutate` was never called, or errored
  before the clear — or the turn ended in the third outcome above, where
  no `mutate` was ever *correct* to call. Recovery, in order:
  `POST /__worklist/end` with `{"ids": [...]}` naming the claimed ids (the
  route is not iterate-specific, despite appearing only under *Refine stuck*
  in earlier revisions of this file); or call `mutate` manually if the work
  really is on disk; or restart Bram (`cleanup_stale_inflight_claim` runs at
  startup), which is the heaviest option and ends any agent session running
  inside it.
- **Refine stuck:** rare now that the host auto-detects the
  `iterate:` prefix and the turn-finished clearer fires for all
  sentinel kinds. If it does stick, host-side completion detectors
  will clear it on the next normal turn end; `/__worklist/end` remains
  available as an explicit manual unwind. It now returns
  `{"ok":true,"cleared":<bool>,"remaining":[...]}` instead of a bare
  `{"ok":true}` — `cleared:false` with a non-empty `remaining` means
  the call only resolved part of a multi-id claim (see *Incremental
  claim retirement* above), not that the call failed.
- **Premature clear:** silence alone is not authoritative. PTY silence
  can request a sentinel clear, but the host first checks the latest
  provider JSONL completion detector. If JSONL says the assistant turn is
  still non-final, the host logs
  `[agent-status] op=skip-sentinel-clear ... reason=jsonl-non-final` and
  leaves the sentinel intact. If a premature clear is suspected, inspect
  `[agent-status] op=skip-sentinel-clear`, `[jsonl-turn-end]`, and
  `[inflight-sentinel]` in `bram-trace.log`. Missing/unreadable JSONL
  falls back to the legacy silence-clear behavior.

The Status tab's Inflight Sentinel section includes a `Turn completion`
row. Use it first when diagnosing a stuck spinner: it reports the last
detector source, provider, skip/detect reason, timestamp, and whether
the observed completion happened after the active claim.

Do not conflate this with XMLUI component-local busy states. APICall
spinners/buttons are driven by the APICall component's `inProgress`
state and lifecycle handlers; Worklist spinners are driven by Bram's
host-managed inflight sentinel. XMLUI fixes such as
xmlui-org/xmlui#3540 can resolve delayed APICall `onSuccess` cleanup,
but they do not replace the host turn-completion detector needed for
approved/drop/iterate worklist cycles, which are sent through `toTurn`
and cleared through `/__inflight` plus host lifecycle events.


## Commit & git etiquette

### Don't nudge toward commit approval

A committable item — `applied`, or a begun `proposed` item with
exclusive changes — sits indefinitely until an `approved:` payload
covers it. Describe the state factually ("relay has changes ready to
commit — confidence high on happy path, untested edges noted above")
and stop. The user clicks Start & commit (or Commit) when ready, or doesn't.
The exception is a *minor* change the user explicitly asks you to
commit directly.

### Don't infer commit / drop / advance from feedback

"Looks good", "seems pretty good", "it works" — these are not
authorization to commit applied items, drop proposed items, or
otherwise advance worklist state. Wait for explicit "commit it" or a
structured `approved:` payload.

`voice: ...` is a transport marker (the user dictated instead of
typed), not a refusal trigger. Voice *state-advancement* phrases
("voice: looks good") behave like typed talk — informational only.
Voice *task requests* ("voice: create foo.txt", "voice: fix the bug
in X") are acted on the same as if typed. If a verbal phrase is
ambiguous, ask one focused question instead of acting.

### Hold the commit while a related item is still being started

When a committable item and a not-yet-begun `proposed` item touch the
same surface (feature + tuning adjustment, fix + follow-up regression
patch), don't process the commit if the user's `approved:` covers
both. Apply the proposed item only; leave the prior one committable
and uncommitted. The user verifies the combined behavior, then
approves a single commit covering both. This avoids intermediate
"kinda-works" commits where a feature is split from its companion
fix — bad for git history and bisect.

### Warn when a new item would entangle a committable item

Whenever you're about to **propose** or **apply** an item whose
`files` overlaps the `files` of an existing committable item —
`applied`, or a `proposed` item that has begun (`begunAtMs` set — see
*Field notes*) — surface that fact in chat *before* writing the
proposal or applying the edits:

> "issue-X has changes ready to commit and touches the same file(s) —
> recommend committing it first; otherwise this item's edits will mix
> into X's on-disk diff and need manual separation later."

Don't auto-block — the user may have a reason to proceed (the two
items are genuinely meant to ship together, X is about to be
dropped, etc.). The warning is so the user can decide *order*
intentionally rather than discovering the entanglement at commit
time. The check is mechanical: intersect the candidate item's
`files` list with the union of `files` across begun items (`applied`
status, or `proposed` with `begunAtMs` set) in
`resources/worklist.json`; non-empty intersection triggers the
warning.

### Delegating worklist items to subagents

Parallelize the *work*; serialize the *gates*.

- Subagents receive file paths and instructions only. They do **not**
  call `/__worklist/resolve`, `/__worklist/mutate`, or
  `worklist-commit`. Every lifecycle call stays in the orchestrator's
  own turn, after the subagents return.
- The reason is structural: the inflight sentinel holds one claim
  (writing a second overwrites the first), and an authorization
  record carries one whole-record consumed flag (the first `mutate`
  consumes it, and the next subagent is told
  `no_active_authorization` for work that was in fact approved).
  Neither surface can represent two concurrent claimants.
- Before delegating in parallel, intersect the `files` lists of the
  candidate items. **Non-empty intersection → do not parallelize
  those two**; run them in sequence.
- Worktrees under `.claude/worktrees/<name>/` inherit the corresponding
  real-tree coverage: for example, an item covering `app/x.js` also covers
  `.claude/worktrees/agent-a/app/x.js`. Do not add worktree-prefixed twins to
  an item's `files`; the guards strip that one prefix for coverage matching,
  including declared-directory coverage, while retaining the original path
  in traces and diagnostics (judell/bram#309).
- A worktree denial is still a denial. Report it to the orchestrator; never
  route around it through another tool or scripted write. The bypass observed
  in #309 is why this rule is explicit. A blocked worktree with zero changes
  is eligible for harness cleanup, so report promptly rather than waiting in
  place.
- Attribution: `worklist.json` has no agent field, so a committable
  item's diff produced by several subagents carries no record of
  which one made which edit. If that matters for a batch, commit the
  items separately.
- **Hook-enforced on Claude, and verified by deliberate violation.** A
  lifecycle call from a delegated subagent is denied at `PreToolUse`
  (`decision=deny reason=subagent-lifecycle-call`), and the call never
  reaches the host. The check keys on the payload's `agent_id`, which is
  populated only for subagent-originated tool calls.

  It has not always worked. It originally tested for a `/subagents/`
  segment in `transcript_path` — a field present on every payload but
  never carrying a subagent path — so it was inert from the day it
  shipped, and no amount of quiet running would have revealed that. It
  was found by deliberately breaking the rule
  (xmlui-org/xmlui-mcp#33): the call reached the host and was stopped
  only by the authorization layer, which happened to refuse an id it did
  not cover. Had the id been covered, it would have succeeded.

  Two lessons worth keeping attached to this rule. Enforcement claims
  need a **fire** behind them rather than an inspection — see
  *Distinguish soak observers from tripwires*. And a check keyed on the
  *shape* of a path supplied by someone else's payload asserts something
  that payload never promised.

### Serializing entangled items approved together

One gate click can approve multiple items whose `files` intersect. The
parallel-delegation rule above already forbids working those
concurrently; this is the sequencing discipline for completing them
serially, learned from the 2026-08-28 two-item run (judell/bram#269,
the finding comment and its same-day correction):

- **Complete them strictly in sequence, committing the first before
  applying the second**, so the shared file never carries two items'
  hunks. Each commit then stages a clean per-item diff with no hunk
  surgery, and the second item's changes become exclusive the moment
  the first commit lands.
- **A same-click plural approval cannot split its shared files at the
  gate** (#356): one click writes ONE claim and one capture boundary,
  so both items' edits to a shared declared path land in a JOINT
  interval that per-item staging has nothing to stage from. A
  `split-shared-files` commit of one such id is **refused** (409,
  `op=refuse-joint-interval`, claim released), naming the joint ids —
  it is not honored, and before this refusal existed it silently
  absorbed the neighbour's hunks under the requested id (the issue's
  filing case and its same-day source-repo reproduction). Commit the
  joint items **together** (safe — every changed line is accounted for
  by an id in that commit), or separate the hunks by hand. When
  per-item commits on a shared file are the goal, approve the items in
  **separate clicks**: each then gets its own claim and boundary, and
  interval staging splits them correctly.
- **End the remaining ids' claim before handing the user a commit
  decision.** A live claim locks row selection, and the locked
  selection is where the Commit button lives — the user sees a gate bar
  with nothing actionable ("no button to commit with!"). Call
  `POST /__worklist/end` with the still-claimed ids; this is the
  multi-id generalization of the third-outcome rule above ("a turn that
  ends by asking the user a decision must not leave a claim live").
- **Do not plan to resume the later item on the claim or the
  authorization record.** Both are single-slot and displaceable: the
  user's next gate click — typically the very commit being waited
  for — writes a fresh authorization that silently displaces the
  surviving one, and a later `mutate op:"advance"` is denied
  `id not in auth`. The durable resume state is `begunAtMs` plus the
  on-disk diff (exactly the `begunAtMs` field note's inventory). After
  the first commit cleans the shared file, the later item's changes are
  exclusive and the pane's widened plain-**Commit** offer on a begun
  `proposed` item is the legitimate resume channel; a fresh **Start**
  click is the fallback when the later item's edits don't exist yet.

### Suggest a branch when isolation helps

Bram should guide users toward good git practice, not force ceremony.
Before broad, risky, exploratory, multi-commit, review-before-main, or
issue-close-sensitive work — especially when the current
branch/worktree already contains unrelated changes — suggest creating
or switching to a branch and explain the benefit briefly. Do not
branch for small direct fixes or straightforward docs tweaks, and do
not change branches without clear user consent.

### Notice when sibling commits should be squashed

If two consecutive unpushed commits are really one feature (mechanism
+ config, backend route + frontend caller, struct + only constructor),
flag it before push: "`<sha1>` and `<sha2>` are two halves of the same
feature — want to squash them?" If yes, and **both commits are
unpushed**:

```
git reset --soft HEAD~2     # keeps both diffs staged
git commit -F <new-msg>     # one combined commit
```

Verify with `git log --oneline -3` and `git log --oneline @{u}..HEAD`.
Never squash already-pushed commits without explicit force-push consent.

### Don't rewrite a commit the worklist history has recorded

Being unpushed is not sufficient license to rebase. `resources/worklist-history/`
stores each entry's commit URL **by SHA**, and the History tab renders those
links — so rewriting a recorded commit orphans them permanently. That is a
different failure from an unpushed link, which 404s only until you push and
then heals; an orphaned SHA never resolves again.

So the usual "it's unpushed, amend freely" reasoning does not apply to any
commit that produced a history entry, which is every commit made through the
commit gate. Prefer a follow-up commit. (Found 2026-08-22 while deciding whether
to amend `626e73d`: the rewrite would have broken the very file-link feature
that commit introduced, in Bram's own history.)

Since #277 the tooling holds this line with you rather than against you:
`scripts/bump.sh` preflights the current release window's history entries
and names any whose SHA is no longer an ancestor of HEAD before the
behind-origin error steers you into a rebase; the History tab marks an
orphaned entry ("orphaned by a rebase") instead of rendering a dead forge
link; and both provider guards deny a forge write whose body contains a
full 40-hex SHA that does not resolve locally — which catches fabricated
hashes and rebase-orphaned citations with the same test.

### Don't quote unpushed-commit counts in chat

After a commit lands, confirm with its short SHA and subject and stop.
Don't say "N unpushed commits now" or list unpushed SHAs in prose — the
Commits tab has the exact count and list; any number you'd state is
guesswork.

The same goes for recommending Push: don't advise it from a remembered
state — the user pushes without narrating it, so a session-long tally
of "commits made" says nothing about what's still unpushed (live
pattern, 2026-08-27: repeated "push the stack" advice while
`@{u}..HEAD` was empty). If push state matters to the point being
made, check `git log @{u}..HEAD` first; otherwise say nothing — the
Push button already carries the true count and the queued-close banner
already says what a push will do.

### Commit-then-push: the post-commit grace

`worklist-commit` prunes its items, so an emptied board would deny the very
`git push` the user just asked to follow the commit ("commit this, then push
and raise a PR" — #283, where the denial even advised proposing an item for
a change that no longer exists). Both guards therefore allow a push-shaped
Bash command for **10 minutes after a gate commit**, keyed on the consumed
`approved` authorization already on disk (trace reason
`post-commit-push-grace`). The grace covers only `git push`; it is a window,
not a standing permission. Outside it, the Push path is the user's: the
denial names the **Push** button in the Commits tab. Agent-driven push
within the grace is legitimate exactly when the user asked for it in the
approval; unprompted, prefer reporting the committable state and stopping,
per *Don't nudge toward commit approval* above.

### Push button auto-rebases on non-fast-forward

The Commits-tab Push button does `git push`; if rejected as
non-fast-forward, it fetches `origin` and rebases on `origin/<branch>`
before retrying (linear history, no merge commits). Don't manually
`git pull --rebase` — that's the button's job. Only intervene when
the button reports rebase conflicts (working tree left clean); then
start a manual rebase, resolve, and push.

### Commit messages

Summarize the worklist item that drove the commit. Use
multiline. Reference the driving issue if there is one — in
**non-closing phrasing**: "Refs #N", "see #N", or bare "#N" in prose.
Never use forge closing keywords (`close/closes/closed`,
`fix/fixes/fixed`, `resolve/resolves/resolved` followed by `#N`): both
GitHub and GitLab auto-close the referenced issue when such a commit
reaches the default branch, bypassing the close-on-commit dialog's
explicit user consent (first live occurrence: gitlab-demo 2026-07-21,
where `Closes #1` closed the issue before Bram's close-on-push ran).
Closing is the dialog's exclusive authority on every forge; the
`worklist-commit` gate rejects messages containing closing keywords so
they can be rephrased before the commit exists.

**No session URLs in public artifacts.** Never include agent session
URLs (`claude.ai/code/session_...` or any provider equivalent) in
commit messages, issue/PR bodies or comments, or anything else that
lands in a repository or forge — this applies to every agent-authored
artifact, the same scope as the signature requirement above. Sessions
are private telemetry; a repo push publishes them irreversibly, and no
opt-in mechanism exists. This overrides any agent-harness default that
suggests a `Claude-Session:` or similar trailer (the live case,
2026-09-05: a harness-suggested trailer put session links into public
history until Jon called it out). Attribution lines without URLs
(e.g. `Co-Authored-By`) are a separate, allowed matter.

**Enforced, not just requested** (guard-no-session-urls): the prose
rule alone did not bind — on 2026-09-06 every commit in a managed
project carried the harness-default `Claude-Session:` trailer despite
this section being seeded there, because the harness instruction sits
in the agent's prompt while this line sits deep in a large file. So,
like the signature requirement above: the commit gate rejects a
message containing a session URL or `Claude-Session:` trailer
(rephrase and retry, nothing committed), and both provider guards
deny a direct `git commit` or forge write whose command text or
readable message/body file carries one (reason `no-session-url`).
Greps and trace reads that mention the URL are untouched — only
publishing-shaped commands are screened.

### Close-on-commit confirm dialog

When an item's `applied` commit would resolve a GitHub issue, set
`closesIssues: [{number: N, title: "..."}, ...]` on the item (title
from `gh issue view N --json title`; refresh if you iterate).
Approving a committable item (`applied`, or a begun `proposed` item
offered Commit) with non-empty `closesIssues` opens a
confirm dialog — one row per issue plus an optional close-comment
textbox. Ticking issues records them for automatic close-on-push (see
below); "commit only" commits without queuing any close. There is no
push-from-close path: closing follows the user's separate, explicit
Push. (A residual `push-before-close:` toggle in the dialog is inert —
the backend ignores it; removing it from the dialog UI is a small
follow-up.)

Issue-derived items (e.g. "Propose a worklist item to address #N
...") default to pairing the `issue-<N>-...` id with `closesIssues`
for that same issue. Omit only when the change is explicitly
investigative, partial, or not intended to resolve. If you discover
an approved/applied item is missing `closesIssues`, iterate the
metadata before asking for commit approval.

Don't regex `#N` from item prose — false positives on
cross-references. Use conversational context to judge whether the
commit truly resolves an issue; set `closesIssues` explicitly when
it does.

The user's choices arrive in the per-item `feedback` of the
`approved:` payload as `close-issue:` lines appended after any free-text
feedback:

```
close-issue: 52
close-issue: 50 comment: "shipped, see commit message"
```

**Closing is fully automatic — the agent does nothing (close-on-push-
automatic, security H5).** At the commit gate the host itself parses these
verified `close-issue:` selections and records a pending close bound to the
new commit SHA. Nothing closes or pushes at commit time. On the user's next
explicit **Push**, once each commit reaches the default branch, the host
closes its issue automatically with the `Closed by <commit-url>` comment
(prefixed with the user's comment when one was given). Two refinements
(#282, found where squash-merge made the original predicate unsatisfiable):
a record whose issue is already closed by other means retires quietly
(`op=retired-already-closed`), and on GitHub a **merged PR** containing the
bound commit completes the close (`op=closed-via-pr`, `Closed by <pr-url>`)
even though the squashed SHA itself never lands on the default branch.

So after `worklist-commit` returns its `sha`, you are **done** — do not
resolve the SHA and do not tell the user to run a close step. There is no
close route or `issue-close` intent to write (both were removed); the host
does everything. Report the commit and stop; closing follows their Push with
no further action. **Closing never pushes** — the user's explicit
Push is the only thing that publishes commits, so closing one issue can
never silently push others stacked behind it.

**Approve without closing** arrives as feedback with no `close-issue:`
lines — commit only, nothing queued.

**Narrate the close outcome from the response, never from `closesIssues`.**
`worklist-commit`'s success body carries `queuedCloses` — the issue
numbers the host actually enqueued (`{"ok":true,"sha":"…","queuedCloses":[16]}`;
the Codex result file carries the same bytes). Announce "queued to close
on your next Push" **only** for issues named there. An empty
`queuedCloses` means the user declined every tick (or none was offered):
say nothing about closing, or state plainly that no close was queued.
The item's `closesIssues` is the *offer* — it is what makes the gate
render the tick, and it stays correctly set even when the user unticks —
so narrating from it reports intent as outcome (#354's field failure: the
user deliberately declined, the host honoured it, and the report claimed
a close was queued anyway).


## Bram shell mechanics

### Target app helpers (opt-in)

Bram's own Worklist and Sessions tabs already use these helpers
internally — the worklist Approve/Drop flow works with no extra
setup. You only need these if **your own** project markup wants to
talk back to the agent (custom Approve buttons, in-page forms that
submit a fresh user turn).

Include `<script src="/__shell/helpers.js"></script>` in your
project's `index.html` to expose:

| helper | usage |
|---|---|
| `toShell(text)` | inject text into stdin; user must press Enter |
| `toTurn(text)` | submit text as a complete user turn (auto-Enter) |
| `openExternal(url)` | open URL in the system browser |
| `logToHost(payload)` | log to Bram stderr without bothering you |

Use `toTurn` for one-shot form submissions (Approve, Confirm). Use
`toShell` to inject text the user can edit before sending.

> **Since C1 (target-pane origin isolation).** The target pane is served at a
> distinct `bramapp://localhost` origin, so `getTauriInvoke()` returns `null`
> there and `toShell` / `toTurn` / `sendKeys` / `openExternal` **no-op** inside
> an embedded target app — the pane is display-only. `helpers.js` is still
> served (so XMLUI apps boot) but its host-driving functions are inert; only
> Bram's own agent pane (Worklist/Sessions), which stays same-origin, drives
> them. If an embedded app needs to talk back to the agent, render the control
> in the agent pane instead. The target scheme (`handle_target_scheme` in
> `lib.rs`) refuses the dynamic host routes (`__file`, `__worklist/*`,
> `__settings`, …) and serves only project content plus the static
> `__vendor/*` / `__shell/*` namespaces.

### UI patterns

#### Fold optional companion input into existing actions

When a surface already has clear primary actions (Approve / Drop /
Submit) and a new optional input is added (free-text feedback, notes,
override flag), fold the input value into the existing actions'
onClick payloads rather than adding a separate Submit / Send button.
Render the input above or beside the primary buttons; clear it after
submission. A separate submit button creates a third decision point
("which button do I click for what?") and forces the user to send
two messages when one would do. Only add a separate submit button if
the auxiliary input is genuinely independent of the primary actions.

### Build vs. hot-reload boundary (developing Bram only)

The hot-reload table, launch discipline, and debug-build rules moved
to `docs/developing-bram.md` in the Bram source repo.

### Live SQL views via `/query` (project SQLite)

When a managed project keeps data in SQLite, its target app (or the
agent pane) can bind live views directly instead of consuming derived
files: set `"db": "<relative path>"` in `.bram.json`, and Bram's
loopback serves `POST /query` — the receiving end of XMLUI's
`DataSource dataType="sql"`. Request body is `{ sql, params }`; the
response is a JSON array of column-keyed row objects:

```xml
<DataSource id="txns" url="/query" method="POST" dataType="sql"
  body="{{ sql: 'SELECT * FROM transactions ORDER BY txn_date', params: [] }}" />
```

- **Read-only, enforced at the engine** (read-only open plus
  `PRAGMA query_only`): the UI can never mutate project data through
  this route. The agent writes the database through ordinary
  gate-governed file access (`sqlite3` CLI etc.) — that division of
  authority is the design.
- **Scratch-pad pattern**: the agent can materialize an analysis (a
  normalized import, an aggregation, a cross-source join) as tables in
  a project-local scratch database — e.g. a gitignored
  `resources/scratch.db` pointed at by `db` — and hand the user a live
  table or chart in three lines of markup. Analyses that prove out get
  promoted to project-owned data and, if the app ships, a project-owned
  endpoint.
- **Scope**: only the explicitly designated project file is reachable —
  never Bram's own databases — and the path must resolve inside the
  project root. No `db` configured → the route refuses with guidance.
- **Limitation**: when the project runs its own dev server, relative
  `/query` reaches that server, not Bram; such projects implement their
  own endpoint against the same wire contract (the xmlui test server is
  one existing implementation), and the markup carries over unchanged.

### Updating forge issues via gh / glab

Use the project's forge CLI directly — the Issues tab refetches on the
indexer's `issues-changed` signal (no polling), so updates surface without
a restart. There is no manual refresh; `/__issues?fresh=1` remains a
curl-only diagnostic that live-builds and rewrites the cached list. The forge is detected from the
`origin` remote (`.bram.json` `"forge"` override for ambiguous
self-hosted remotes; `GET /__app-info` reports the detection — see
`docs/forge-adapter.md`). On GitHub projects:

- `gh issue edit <n> --title "…" --body "…"`
- `gh issue comment <n> --body "…"`
- `gh issue close <n>` / `gh issue reopen <n>`

On GitLab projects the parallel `glab` commands apply (`glab issue
note <n> -m "…"` for comments). The worklist contract around issues
(`closesIssues`, `issue-<N>-` ids, close-on-push-automatic) is
forge-agnostic and identical on both.

**When filing or commenting on an issue against Bram itself
(judell/bram), cite the Bram version.** Triage of a version-less
report starts with "which build is this?", unanswerable after the
fact (live case: judell/bram#343). Two cheap lookups: the
`<!-- bram vX.Y.Z -->` marker on the first line of
`.claude/bram-conventions.md` (stamped by Setup at seed time), or the
version field of `GET /__app-info` on the loopback port. If neither
is available — an old seed, no running instance — say so in the
report rather than omitting the version silently.

### Resource-heavy test suites: cap the workers

When running a multi-worker browser test suite (Playwright, or anything
else that spawns a browser per worker) from an agent session, cap
parallelism explicitly — e.g. `npx playwright test --workers=2` —
instead of accepting the default worker-per-core.

The receipt: on 2026-09-04 a subagent ran a Playwright spec five times
back-to-back at default parallelism (8 workers) on a machine whose swap
was nearly full. The machine-wide memory pressure froze **every**
webview on the machine — both running Bram instances' panes stalled for
26–126 seconds at a stretch, tracking the test runs exactly. An
identical 78.6 s freeze from 2026-08-25 carries the same signature, so
this is a class, not a one-off.

The worst multiplier is the fail-retry loop: a failing test that
retries with tracing enabled spawns extra browsers *and* records
traces. Iterating on a failing spec is exactly when the cap matters
most — which is also exactly when an agent is most likely to be
re-running the suite over and over.

### Windows: Smart App Control blocks on unsigned binaries

Bram ships unsigned binaries, and on some Windows 11 machines Smart
App Control (SAC) blocks them. Most users see no problem; when a block
does hit, this is the advice protocol (user-facing twin: the Bram
README's *Smart App Control* section — keep the two in sync):

- **Recognize both symptom shapes.** (1) Bram itself refused at
  launch — a Windows Security dialog naming Smart App Control. (2)
  Since the reentrant `bram-guard` hook binary (`~/.bram`, spawned on
  every hook event): hook invocations failing while the app runs
  fine — the signature is missing `claude-rs` / `codex-rs` breadcrumbs
  in `resources/bram-traces/hook-events.log`, or hook timeouts/errors,
  with no visible launch failure.
- **Verify before advising.** Confirm the block dialog actually names
  Smart App Control — Defender and SmartScreen blocks read
  differently, and their remedies differ.
- **State the trade-off honestly, then let the user decide.**
  Disabling SAC is currently the only workaround short of a signed
  executable (signing is not currently planned). Windows Defender
  remains fully active with SAC off — if the user deems Defender
  sufficient protection, disabling is the supported path. Name the UI
  path: **Windows Security → App & browser control → Smart App Control
  settings**, and point at Microsoft's Smart App Control FAQ
  (https://support.microsoft.com/en-us/windows/smart-app-control-frequently-asked-questions-285ea03d-fa88-4d56-882e-6698afdb7003) —
  including that the switch is effectively one-way on current Windows
  builds (re-enabling has required a Windows reset).
- **Never flip the setting on the user's behalf.** It is a
  machine-level security decision; the agent names the control and the
  consequences, the user clicks.


## Log-first development

Agents default to writing and reading code; in Bram the higher-value
habit is writing and reading logs. Behavior here arises from the
interplay of Rust, the parent shell, XMLUI, two agent CLIs, and
Markdown/Python-governed workflow — runtime questions ("was the right
message sent at the right time? did the transition fire? did it
render?") are answered by evidence, not inspection. The norms:

- **The drill.** When behavior goes wrong — or a new mechanism is
  being designed — the first question is: does the trace already
  capture what happened? If no, add the instrumentation (as its own
  worklist item when scope warrants) and keep dogfooding until the
  problem recurs; the next occurrence should be self-diagnosing. If
  yes, use it before theorizing. A fix proposed without trace
  evidence should say so explicitly.
- **Observe-only first for behavior changes.** Mechanisms that will
  act on inferred conditions (auto-clears, auto-reveals, suppressors)
  ship first as trace lines only, with graduation criteria written
  into the worklist draft as falsifiable checks against the soak
  ("every would-X corresponds to a corroborated moment; zero fire
  during Y"). Precedents: the send-ledger's observe-only phase, the
  reveal-floor observer. The design review is a grep.
- **Distinguish soak observers from tripwires — they graduate
  differently, and applying the wrong shape retires a working
  instrument.** A *soak observer* fires during normal operation, so a
  soak accumulates positive instances and the criteria above apply as
  written. A *tripwire* fires only when a rule is violated, and the
  rule usually exists precisely to prevent the condition — so correct
  operation reads zero indefinitely, and zero is **success, not absent
  evidence**. Its graduation question is not "did it fire" but "is the
  condition reachable, and would a fire be actionable?", settled by
  reasoning about the mechanism rather than by waiting.
  The inflight-claim collision instruments are the type case — a concept
  name, not a grep target: they emit under `[inflight-sentinel]` and
  `[auth-record]` (see `docs/trace-vocabulary.md`).

  The trap: **a tripwire's zero and a dead instrument's zero are
  identical in a grep.** So a tripwire needs a *provenance* check in
  place of a soak — a deliberate violation in a test, or a review
  confirming the emit is wired and the path reachable. A THIRD zero is
  possible and was met on 2026-08-22: an instrument documented under a
  name it never emitted, whose grep therefore matched nothing while it
  was firing correctly. A name that cannot be grepped is a provenance
  check that silently fails. Receipt: the `inflight-collision` item
  draft borrowed the soak shape and asserted that
  a two-subagent run producing no lines would falsify it. The first
  two-track exercise (2026-08-19, xmlui-org/xmlui-mcp#33) ran two full
  gate cycles with zero fires — the convention worked — and by its own
  criterion that argued for dropping the tripwire that had just
  demonstrated the convention holding.
- **Baselines are commits.** Perf work starts with an instrumentation
  commit that records the before (see `a99c7d9`, "sets up the
  before/after": ~1.7 footer re-renders/sec while typing, 49 ms avg
  drift), and the same trace line verifies the after. Numbers in
  commit messages come from the trace, not from estimates.
- **Logs cannot prove absence.** Event-shaped logging proves presence
  only: a missing line means "nothing flushed", not "nothing
  happened" (the `[pty-in]` small-read accumulator is the canonical
  trap). Any claim of the form "X never happens" requires an
  instrument that affirmatively records zeros with a denominator —
  the reveal-floor's per-turn gap distributions are the pattern.
- **Exhaust on-disk evidence before declaring anything unverifiable.**
  Before writing "can't test from here" / "needs separate
  investigation", enumerate what already exists: rotated
  `bram-traces/bram-trace-*.log` archives (days of history, not just
  the live log), `git log`/`git blame`, Inspector exports, persisted
  tool results. Issue #69's hook regression was "unverifiable" until
  one grep across the rotated archives found 243 records that flipped
  the conclusion.
- **Local absence is not disproof.** For a bug reported from another
  machine or user, "not in my repo/history/disk" is expected for
  machine-specific artifacts and proves nothing about the remote
  case (issue #123). Verify the mechanism locally; frame the
  specifics as "can't be checked from here", never as discrediting
  the report.
- **Register new subkinds.** Every new trace op or subkind lands in
  `docs/trace-vocabulary.md` in the same change that introduces it,
  so the reading half keeps pace with the writing half.


## Search-first

Bram indexes the whole project history in embedded SQLite FTS5 (#230) —
Claude + Codex session transcripts, commits, issues, worklist-history — and
serves it at `GET /__search`. That turns the past into one bounded, ranked,
snippet-first query instead of per-source greps. Session JSONLs are 20–30 MB
and ungreppable without wrecking context, so before this the transcript
history was effectively write-only to the agent.

**The drill.** Before diagnosing a reported bug, proposing a worklist item,
filing an issue, or asserting a fact about the project's past, **query
`/__search` and cite what it returns.** The two highest-value triggers are bug
reports ("has this recurred / been fixed?") and "have we done X / did we
decide Y" questions. This is the log-first drill widened from the trace to the
whole history.

**Proactive triggers.** Search-first is not only for explicit questions about
the past. Fire a `/__search` *before* acting, and cite what it returns,
whenever:

- the user asks to "search the project" in any phrasing — `/__search` leads,
  grep follows for current-tree state (the FTS index covers history, not the
  working tree; the two are complements, in that order);
- you are about to reconstruct environment or infrastructure state — remote
  pod/VM setup, which corpora/indexes/models exist and where artifacts live,
  connection or proxy patterns ("where does X live" questions you are about
  to answer by directory listing). Infra state is exactly the knowledge that
  lives only in session history: it's not in the repo, not in CLAUDE.md, and
  each agent session starts blind to it;
- you are about to re-derive an operational recipe the project has plausibly
  executed before — setup scripts, launch/detach patterns, copy-back flows.

The test: if you find yourself groveling through the tree or asking the user
for a fact that a prior session likely established, the query was already
overdue.

**The call** (Claude loopback curl; literal port from `resources/.bram-port`,
already in the `.claude/settings.json` allowlist, so no prompt):

```
curl -4 -sS "http://127.0.0.1:61455/__search?q=<urlencoded>&limit=20&types=commit,issue"
```

(replace `61455` with whatever `Read resources/.bram-port` returned.)

- `q` defaults to **AND** across terms (every term must appear); wrap it in
  double quotes for an exact phrase. `mode=` overrides: `and` (default),
  `phrase`, `prefix`, `raw` (raw FTS5 boolean — `OR` / `NEAR` / `NOT`); invalid
  syntax falls back to a phrase match.
- `types=` filters buckets (`session` / `commit` / `issue` /
  `worklist-history`); omit for all. `limit` defaults 50, clamps 1–500.
- Ranked snippets are enough to judge relevance; for a hit's full stored
  content, `GET /__search/doc`.
- Compact read: `… | jq -r '.[] | "\(.type)\t\(.key)\t\(.snippet[0:140])"'`.

**Caveats.** FTS5 is keyword/phrase, not semantic — a miss means "nothing
matched those terms," not proof of absence (the same trap as event-shaped
logs). Scope is the current project. The issues bucket refreshes ~every 45s;
a just-created issue may not be indexed for a beat.

**Commit diffs are indexed.** Each `commit:` doc carries the commit's patch
text alongside its message (search-index-commit-diffs), so code-string
questions over commit history ("when did this identifier change") work in
`/__search` too — one query spans the discourse half (issues, sessions,
messages) and the code half of an investigation. Bounds, traced never
silent: diff lines over 2,000 chars are elided (`[long line elided]` —
neutralizes one-line minified vendor bumps while their file headers stay
searchable) and patches cap at 256 KB per commit (`[patch truncated]`);
truncations emit `[search-index] op=diff-truncated` with counts only.
`git log -S` / `git grep` remain the precision tools — uncapped,
regex-capable, any depth beyond the indexed `-n2000`.

### Coordinating MCP demand with search

When the question is "which how-to is missing, weak, or wrong?" for an
MCP-served project (XMLUI is the live one), treat MCP analytics as a
**nomination source**, never as proof. The analytics log is global across
projects and outcome-blind: a search always returns something, `result_count`
does not measure usefulness, and clock proximity cannot establish that a
project transcript caused or followed a query.

Validate a nominated topic with the project's `GET /__search` index across
sessions, commits, issues, and worklist history. Look for what happened after
the search: a how-to read that resolved it, repeated reformulation followed by
component or source fallback, a workaround committed, an issue filed, or a
later conclusion that reversed the first one. Then check the **current**
`xmlui_list_howto` / `xmlui_search_howto` corpus before calling anything a gap.

Classify the result instead of forcing every weak search into "missing
how-to": it may be a missing recipe, a discoverability problem, an inaccurate
reference page, an engine bug that needs a reproducer, a contradiction, or an
already-fixed gap. Operator test phrases and unrelated global MCP activity are
noise unless indexed project memory independently corroborates them. File an
upstream issue only when that evidence chain survives the current-corpus
check, and include the followable search, session, commit, and documentation
receipts.

Use `scripts/xmlui-howto-gap-miner.py` for a repeatable first pass. It groups
nearby `xmlui_search_howto` calls only when at least two meaningful terms
overlap, consolidates high-similarity recurrences across dates, attaches only
locally-near component/example/source fallbacks, and nominates a compact query
using recurrence plus corpus-wide term rarity. It asks `GET /__search` for
downstream project evidence and reconciles the result against the current
how-to directory. Its classification is a review hint, not a verdict; read the
returned snippets and current-doc matches before filing anything. Typical use
from the Bram repo:

```
python3 scripts/xmlui-howto-gap-miner.py --since 2026-06-01 --top 20
python3 scripts/xmlui-howto-gap-miner.py --since 2026-06-01 --json
```

The tool deliberately does not score `result_count`, parse provider-specific
transcripts, or correlate frustration by clock time. `--analytics`,
`--howto-dir`, `--search-url`, and `--port-file` make each input explicit;
defaults target the local XMLUI analytics/cache, `~/xmlui` how-tos, and this
project's `resources/.bram-port`.

### Citing evidence in issues and the search-wins ledger (issue #233)

When an issue comment, ledger entry, or postmortem cites evidence, make the
references followable:

- **Commits**: link the full-SHA forge URL
  (`https://<forge>/<owner>/<repo>/commit/<full-sha>`), displayed as the
  short SHA — bare short SHAs in backticks do **not** autolink on GitHub.
  Resolve with `git rev-parse <short>`.
- **Issues**: bare `#N` autolinks; use it.
- **Local-only sources** (session transcripts, worklist-history records)
  have no web URL. Name them by path or key, and where a runnable query
  helps the reader, include the `/__search` query (`q` / `mode` / `types`)
  that finds them — a distinctive phrase in `phrase` mode pinpoints; broad
  AND queries only retrieve.

**The search-wins ledger.** Keep a ledger issue in the project that collects
receipts for the claim that agent + indexed project memory changes the work
(this repo's is #233, which defines the entry format). Capture rule: record
an entry **at the moment** a live question is answered by the index and
something materially changes (a plan killed or redirected, prior art
recovered, duplicate work prevented). Routine lookups don't qualify; entries
are never reconstructed later. Ledgers are **project-local by design** —
receipts carry project specifics, so they belong in the project's own
tracker. Sharing standout entries upstream (to the flagship collection at
judell/bram#233) is a per-entry choice by the project's humans, never an
automatic behavior.

Worklist drafts follow the same rule: **plans cite inline in their prose**
(typed, followable refs — `code:path:line`, commit SHAs, issue numbers, doc
URLs, pinpointing `/__search` queries). Do not author
`resources/worklist-citations/<id>.json` files; that plumbing is dormant
(#232's postmortem has the rationale). For handing a user a runnable query
from the pane, use Search deep-linking:
`navigate('/search', { queryParams: { q, mode, types } })`.


## Debugging Bram itself

Three forensics surfaces, used together. The first two are raw
streams; the third is a dashboard that derives signals from them.

**`resources/bram-traces/bram-trace.log`** — host-side rolling log of HTTP
routes, iframe events, and inflight-sentinel writes / clears.
**On by default**; switch it off per project through **Settings → Traces**,
and `BRAM_TRACE` in the environment overrides the project setting either
way. Grep it directly when enabled. PTY previews and serialized
iframe payloads use Bram's `loomweave-scanner`-backed credential redactor before
persistence; Bram adds narrow structural expansion for complete PEM blocks and
Authorization/assignment values. Redaction is defense in depth, not a guarantee
for arbitrary content. At startup the prior active log is archived. A
background pass sanitizes and gzips raw archives older than
`traces.archiveAfterDays` (default 14 days, configurable from 1–3650), removing
each raw source only after its `.log.gz` replacement has been fully written,
synced, and atomically installed. Compressed history is retained indefinitely
with no byte cap, so trace storage is intentionally unbounded. The active log
is never an archive candidate during its session. Best for plumbing: stuck spinner,
sentinel anomalies, route errors, agent-turn-end detection,
heartbeat drift, close-cycle verification (`grep
"[issue-close-queue] op=closed" resources/bram-traces/bram-trace.log` —
one line per issue the host auto-closed after a Push; absence around a
known close timestamp means the commit hadn't reached the default branch
yet, or no close was queued at the commit gate; see also
`op=retired-already-closed` and `op=closed-via-pr`, #282).

**Inspector Export** — XMLUI runtime trace (events, state changes,
handler invocations) for Bram's own XMLUI UI, captured on demand.
Best for in-pane misbehavior: a button doesn't fire, a DataSource
shows wrong data, a state change doesn't propagate, a component
renders wrong. Ask the user to open the Inspector (magnifying-glass
icon), reproduce, then click **Export** — writes
`~/Downloads/xs-trace-<timestamp>.json`. Analyze with the xmlui MCP
tools.

- **`xmlui_find_trace`** — locate the export by timestamp or content.

- **`xmlui_distill_trace`** — reduce to interactions / state changes
  / handler boundaries relevant to a specific question.

Don't read the raw JSON initially, it's huge, only grep as necessary.

**Status tab** — curated dashboard in the agent pane that
surfaces signals derived from `bram-trace.log` (rotated history
included) and from Inspector exports, alongside live process state.
Sections include Startup Run, Worklist, Inflight Sentinel, Hooks,
Authorization, Latest Tail And Fanout, and
Guards/Staleness/Interrupts/Traces. Check the Status tab first for
a quick read on whether something looks off — then drop down to
`bram-trace.log` or an Inspector Export for the underlying detail.
