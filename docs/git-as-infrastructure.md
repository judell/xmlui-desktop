# Git as Bram infrastructure

Bram uses Git as more than a revision store. Git is also Bram's dirty-state
model, transaction engine, attribution ledger, snapshot store, fixture format,
and part of its cross-process coordination layer. This guide supplies the map:
which Git state each feature owns, which operations may change that state, and
which invariants must survive when the mechanism evolves.

This is an architectural guide, not a replacement for the operational rules in
[`app/__shell/conventions.md`](../app/__shell/conventions.md), the event catalog
in [`trace-vocabulary.md`](trace-vocabulary.md), or the observer design in
[`out-of-band-actions.md`](out-of-band-actions.md).

## The Git model Bram relies on

The distinctions in this table are load-bearing. In particular, a tree is not
a commit, the index is not the working tree, and a linked worktree is not a
second repository.

| Git concept | What it represents | How Bram uses it |
|---|---|---|
| blob | Content of one file, without its path | Content addressed by captured trees and commits |
| tree | A complete path-to-object snapshot | Claim boundaries and safety snapshots point directly to trees |
| commit | A tree plus parentage, author data, and message | Ordinary Worklist history and durable demo-scenario ancestry |
| ref | A mutable name for an object ID | Branches, remote-tracking branches, claim boundaries, and safety snapshots |
| symbolic `HEAD` | A name for the checked-out branch ref | Normal development; moving `HEAD` moves the branch it names |
| detached `HEAD` | `HEAD` containing a commit ID directly | Synthetic scenarios, where no ordinary branch should advance |
| real index | Per-worktree staging state between `HEAD` and the working tree | Ordinary staging and the board's staged/unstaged interpretation |
| temporary index | An alternate index selected with `GIT_INDEX_FILE` | Whole-tree capture and selective commit construction without disturbing the real index |
| working tree | Files visible to tools and editors | Pending user and agent changes, including tracked and untracked files |
| linked worktree | Another checkout sharing the object database and most refs | Isolated agent checkout whose paths Bram maps back to proposal coverage |
| remote-tracking ref | Local record such as `refs/remotes/origin/main` | Push observation, default-branch ancestry checks, and issue-close eligibility |
| refspec | Rule selecting which refs fetch or push transfers | Normal pushes transfer branch refs, not `refs/bram/*` |

Every linked worktree has its own `HEAD` and index. It shares the repository's
object database and most refs with the other worktrees. In the rest of this
guide, **working tree** means the visible files in one checkout; **linked
worktree** means another checkout created by `git worktree`.

The real index participates in familiar comparisons:

- `git diff` compares the working tree with the index.
- `git diff --cached` compares the index with `HEAD`.
- `git diff HEAD` shows the combined tracked difference from `HEAD`.

A temporary index substitutes for the real one. It does not create a second
object database, so `write-tree`, `hash-object`, and commands that stage new
content can still add objects to the shared object store. The important
noninterference guarantee is narrower: Bram does not change the user's real
index or working files while constructing the snapshot.

## Feature map

| Bram feature | Git primitives | Durable state outside Git | Primary implementation |
|---|---|---|---|
| Worklist change summaries | status, diffs, `HEAD`, real index | `resources/worklist.json` | `worklist_change_index` |
| Ordinary Worklist commit | path-scoped `add -A`, staged-file checks, `commit` | authorization, audit, worklist history | `handle_worklist_commit` |
| Claim attribution | temporary index, trees, `refs/bram/claims/*`, tree-to-tree diffs | `.claim-intervals.json` | `capture_claim_tree`, `claim_attribution_runs` |
| Selective entangled commit | interval patches, `apply --check`, temporary index, `write-tree`, `commit-tree`, `update-ref` | claim ledger and Worklist declarations | `interval_stage_commit` |
| Safety snapshot | temporary index, tree, `refs/bram/safety/*` | operator-chosen ref name | documented in `trace-vocabulary.md` |
| Synthetic scenarios | trees, commits, `scenario/*` branches, detached checkout, mixed reset | scenario metadata committed in the branch | `scripts/demo_instance.py` |
| Agent worktree coverage | linked-worktree path convention | proposal file declarations and guard authorization | `worktree_coverage_target` |
| Push and issue-close observation | remote-tracking refs, symbolic remote `HEAD`, ancestry, stable patch IDs | pending-close queue and cache | `start_git_head_watch`, `flush_pending_issue_closes` |

## Dirty state and the ordinary Worklist commit

The Worklist board derives its view from Git without staging untracked files.
`worklist_change_index` batches item paths, then uses porcelain status and
`--no-renames` diffs for file state, line counts, and hunk counts. Untracked
files are counted from the filesystem. Bram deliberately avoids `git add -N`:
intent-to-add would make a display query mutate the real index.

The ordinary approved commit path is intentionally conventional:

1. Resolve approved item IDs to their declared paths and validate the
   authorization, status, and file scope.
2. Run source-specific gates. In Bram's own repository this includes
   `cargo fmt --check` when Rust is involved.
3. List paths already staged in the real index and refuse any that are outside
   the approved coverage.
4. Run `git add -A -- <path>` for each approved path. `-A` is necessary so
   additions, edits, and deletions are all represented.
5. Recheck the index, refuse an empty commit, and run path-scoped `git commit`.
6. Record the resulting SHA, refresh commit/history state, bind requested issue
   closes to that SHA, and prune the committed Worklist items.

Staging and diff discovery use `--no-renames` because proposal coverage is
path-based. Treating a rename as a delete plus an add keeps both sides visible
and prevents half of a rename from being silently stranded outside the item.
Installed copies of canonical files are added as explicit twins where that
policy applies.

This path uses Git porcelain, so normal commit hooks run. The selective path
below uses `commit-tree`, so it must enforce important repository gates before
the plumbing commit rather than assuming a pre-commit hook will run.

## Claim intervals: attribution as boundary trees

Bram attributes changes to intervals of exclusive claims, not to individual
filesystem writes. A claim transition captures the whole visible project
state before the incoming claimant can change it:

```text
old claim owns work                         new claim owns work
        |                                          |
        v                                          v
  boundary tree A  ---------- changes ----------> boundary tree B
        |                                             |
        +-- refs/bram/claims/<time-A>                 +-- refs/bram/claims/<time-B>
        +-- ledger record: incoming owner             +-- next ledger record

closed interval patch = git diff tree-A tree-B
open interval patch   = last boundary versus current pending state
```

`capture_claim_tree` creates a unique temporary index, seeds it from `HEAD`,
runs path-scoped `git add -A -- .`, and writes a tree. This captures tracked
changes and untracked, non-ignored files without staging anything in the real
index. The pathspec is relative to the Bram project root; an unscoped `add -A`
could walk an enclosing repository when the project is a nested directory.

The new tree is installed at `refs/bram/claims/<atMs>`, then an ordered record
is appended to `resources/.claim-intervals.json`. The record associates the
boundary with the incoming claim ID set. Record order, not timestamp sorting,
defines adjacency because two boundaries can share a millisecond.

Each closed interval is a fixed tree-to-tree diff and can be cached. The newest
record begins the open interval, whose far end is still changing. A plain
`git diff <last-ref>` is useful for tracked state but cannot represent a newly
untracked file; an exact open-interval snapshot requires the same temporary
index capture used at a boundary. The live attribution path currently uses the
plain diff for that final pair, so this is a known diagnostic boundary rather
than an equivalence between a worktree diff and a tree-to-tree diff.

Ownership has several intentionally honest edge cases:

- A single-ID interval belongs to that item.
- In a multi-ID interval, a path declared by exactly one member can be assigned
  to that member. A path declared by several members remains joint.
- Joint work cannot be split by inventing line ownership. Bram requires the
  joint items to commit together or the human to separate the work.
- Work before the first recorded boundary is unattributed.
- An interval whose item no longer exists is a ghost. Bram does not splice its
  stale patch into a later selective commit; surviving content travels with a
  later whole-file commit.
- An interval records what an item did at that point in the timeline. Later
  work may overwrite it, so attribution is not a promise that every attributed
  line survives in the current working tree.

Claim capture fails open: loss of attribution must not block the lifecycle
operation that changed the claim. But a successful ledger record must have a
successful ref. A bare tree ID written only to JSON is eventually eligible for
garbage collection; the ref is what makes the snapshot a durable Git root.

A boundary is shared by the intervals on both sides. Cleanup may delete its
ref only after neither adjacent interval has a live Worklist owner. The newest
boundary is always retained because it is the base of the open interval. Bram
deletes retired refs lazily after item pruning and updates the sidecar to match.

## Selective commits: Git as a transaction engine

Two begun items can modify the same file without being jointly owned. A
whole-file commit of one item would absorb the other's pending hunks. When the
claim ledger supplies separate interval patches, Bram constructs the requested
commit away from both the working tree and the real index:

```text
requested interval patches
          |
          v
temporary index seeded from HEAD
          |
          +-- git apply --cached --check   (independence proof)
          +-- git apply --cached           (assemble requested state)
          +-- git write-tree
                        |
                        v
             git commit-tree -p <old HEAD>
                        |
                        v
                 git update-ref HEAD
                        |
                        v
        refresh committed paths in the real index

working tree: unchanged throughout
other item's pending hunks: still present
```

The check is semantic, not a hunk-location heuristic. If an item's patch
applies to a temporary index seeded from `HEAD`, the item can stand without its
neighbour. If it does not, the requested state is defined relative to omitted
work; Bram refuses and asks for the dependency to commit first or for both
items to commit together.

`--3way` is forbidden for this check. On a real overlap it can write conflict
markers and still produce a result that plumbing could commit. A refusal is
safer than manufacturing `<<<<<<<` content under the requested item's message.

`git stash create` is not a substitute for temporary-index capture. It was
measured to omit untracked files and can return no object for a clean tree.
Both properties are wrong for a boundary mechanism in which file creation and
clean snapshots are normal.

After `commit-tree`, `update-ref HEAD` advances either the branch named by a
symbolic `HEAD` or detached `HEAD` itself. That operation does not refresh the
real index. Bram therefore resets exactly the committed paths in the real
index to the new `HEAD`, leaving the working tree untouched. Without that
step, committed paths can appear spuriously staged (`MM`) and block the next
approved commit as unrelated staged content.

## Bram's private refs and object reachability

Bram owns two local namespaces:

| Namespace | Target type | Creator | Lifetime |
|---|---|---|---|
| `refs/bram/claims/*` | tree | host claim transitions | automatically retired when neither adjacent interval is live; newest retained |
| `refs/bram/safety/*` | tree | explicit operator snapshot | retained until explicitly deleted |

Both refs point directly to trees, not commits. That is sufficient to keep the
tree and its descendant blobs reachable. Deleting the last retaining ref makes
the objects eligible for later garbage collection; Bram does not use reflogs
as a correctness mechanism because custom-ref reflog behavior depends on Git
configuration and expiry.

`update-ref` is the ref-changing primitive because it supplies Git's atomic
ref update behavior. Scenario replacement additionally supplies the expected
old object ID, giving it compare-and-swap protection against an unexpected
concurrent move.

Normal push configurations transfer branch refs under `refs/heads/*` and
update remote-tracking refs locally. They do not publish `refs/bram/*`. The
claim and safety stores are therefore machine-local unless someone deliberately
uses an explicit refspec. This is a boundary, not secrecy: the referenced file
content is ordinary Git object content in the local repository.

## Synthetic scenarios: commits preserve a fixture

The full-fidelity demo instance uses a disposable repository with a marker, no
remote, and an exact-toplevel check around destructive verbs. Its durable
library consists of `scenario/<name>` branches.

Capturing a scenario starts from its clean boundary commit. It then creates one
commit per claim boundary, using each captured claim tree as that commit's
tree, and finally a commit whose tree contains the pending work and forced-in
scenario sidecars:

```text
demo/base or later clean boundary
        |
claim-tree commit 1
        |
claim-tree commit 2
        |
parked pending-state commit  <--- scenario/<name>
```

The ancestry makes every constituent tree reachable through an ordinary
branch, so a scenario can be bundled or copied using normal Git transport.
Hydration checks out the scenario tip detached, cleans only disposable fixture
state, and performs `git reset --mixed <boundary>`. The pending-state commit's
content is now visible as dirty working-tree/index state relative to the clean
boundary. Hydration then clears claim refs and recreates only those recorded by
the selected scenario.

This is why scenario branches and `refs/bram/claims/*` coexist. The branch is
the durable library representation; the recreated claim refs are the runtime
names the real Bram instance expects. The generated repository must remain
without an upstream so an exploratory fixture cannot be pushed accidentally.

See the command workflow in
[`developing-bram.md`](developing-bram.md#institutionalization-339).

## Linked agent worktrees and proposal coverage

An agent may edit through a managed path shaped like
`.claude/worktrees/<name>/<project-relative-path>`. Git gives that linked
worktree its own checkout, `HEAD`, and index, but it shares the repository's
objects and refs.

For the Worklist guard's **coverage test only**, Bram strips
`.claude/worktrees/<name>/` and compares the remaining path with the proposal's
real-tree file or directory entries. This lets a proposal for `src/a.rs` cover
the corresponding edit in a managed agent worktree without adding a fake
worktree-prefixed twin to the item.

The original normalized path remains authoritative for lifecycle-file
classification, bypass lookup, trace output, and denial reporting. Directory
coverage is separator-anchored after mapping, so a proposal for `src` covers
`src/a.rs` but not `src-old/a.rs`. If the guard denies an edit in a linked
worktree, that denial remains authoritative; worktree mapping broadens no
authorization.

## Remotes, rewritten history, and out-of-band changes

Several Bram features need to know not just the local commit, but what the
remote default branch can see.

The default-branch resolver first reads the symbolic
`refs/remotes/origin/HEAD`. If absent, it asks Git to refresh that symbolic ref
from the remote and finally consults the forge adapter, verifying that the
reported remote-tracking branch exists. It does not guess `main` or `master`.

A queued issue close becomes eligible only when its bound commit is an ancestor
of the resolved remote default branch. A rebase changes commit SHAs even when a
patch is unchanged, so Bram also computes `git patch-id --stable` and can scan
recent remote branch history to re-anchor the queued action. A patch ID is a
content identity aid, not a replacement for the final ancestry check.

Pushes and fetches can update loose files under `refs/remotes/<remote>/` or
rewrite `.git/packed-refs`. Branch switches update `.git/HEAD`. Bram watches
all of those locations and recomputes on sightings. The watch is an accelerator,
not the only source of truth: startup and user-triggered recomputation must
also recover changes made while Bram was closed or while an event was missed.
The broader pattern is documented in
[`out-of-band-actions.md`](out-of-band-actions.md).

## Read-only diagnostic playbook

These commands do not intentionally change repository content or refs.
`GIT_OPTIONAL_LOCKS=0` also asks status not to take an optional index lock merely
to refresh cached file metadata.

```sh
# Establish the exact checkout and Git directory.
git rev-parse --show-toplevel
git rev-parse --git-dir
git rev-parse --symbolic-full-name HEAD

# Inspect visible state without an optional index refresh.
GIT_OPTIONAL_LOCKS=0 git status --short
git diff --cached --name-only --no-renames
git diff HEAD --no-renames -- path/to/file

# Inventory Bram refs and verify what each one targets.
git for-each-ref --format='%(refname) %(objecttype) %(objectname)' refs/bram
git cat-file -t refs/bram/claims/<boundary>
git ls-tree -r --name-only refs/bram/claims/<boundary>

# Compare a closed claim interval or inspect one file at a boundary.
git diff refs/bram/claims/<older> refs/bram/claims/<newer> -- path/to/file
git show refs/bram/claims/<boundary>:path/to/file

# Inspect linked worktrees and remote-tracking state.
git worktree list --porcelain
git remote -v
git symbolic-ref --quiet refs/remotes/origin/HEAD
git for-each-ref --format='%(refname) %(objectname)' refs/remotes
```

Replace angle-bracket placeholders before running a command; the brackets are
documentation notation, not shell syntax. For claim ownership, read the refs
together with `resources/.claim-intervals.json`. The ref supplies durable
content; the sidecar supplies order, owners, and lifecycle meaning.

Do not diagnose an open interval by assuming `git diff <claim-ref>` includes
untracked files. If that distinction matters, use Bram's own attribution view
or reproduce the temporary-index capture in a disposable clone.

## Mutating plumbing is implementation machinery

The following are descriptions of Bram internals, not operator recipes for a
live repository:

| Operation | Mutation | Bram's guardrail |
|---|---|---|
| `read-tree` / `add -A` under `GIT_INDEX_FILE` | fills a unique temporary index and may write objects | seed from known base, scope pathspec, remove temp file |
| `write-tree` | writes a tree object | retain it immediately through a ref, commit, or both |
| `commit-tree` | writes a commit object but runs no commit hooks | run repository gates first; supply explicit parent and message |
| `update-ref` | moves or deletes a ref | validated namespace/target; expected-old ID where replacement races matter |
| path-scoped `reset` after selective commit | refreshes real-index entries from new `HEAD` | only committed paths; never `--hard` in a live project |
| scenario checkout/reset/clean | deliberately rewrites disposable fixture state | marker, no-remote, exact-toplevel, and process-state exclusions |

## Invariants and failure patterns

| Invariant | Owning feature | Failure if broken | Source or detailed document |
|---|---|---|---|
| Resolve and operate from the exact project toplevel | all Git-backed features | status, refs, or destructive fixture commands target the wrong repository | `project_root` in `src-tauri/src/lib.rs`; `validate_demo` in `scripts/demo_instance.py` |
| Scope whole-tree capture to the project subtree | claim capture, scenarios | a nested project hashes unrelated enclosing-repository content | `capture_claim_tree`; `capture_tree` |
| Include untracked, non-ignored files in snapshots | claims, safety, scenarios | file creation becomes unattributed or absent from a fixture | `capture_claim_tree`; `trace-vocabulary.md` § claim and safety refs |
| Use a unique temporary index and clean it up | claims, selective commits, scenarios | concurrent captures collide or leak staging state | `capture_claim_tree`; `interval_stage_commit`; `temporary_index` |
| Keep every durable snapshot reachable | claims, safety, scenarios | Git garbage collection removes a boundary still named in metadata | `record_claim_interval`; `prune_claim_intervals`; `capture_scenario` |
| Treat ledger insertion order as claim order | claim attribution | same-millisecond boundaries are reordered and ownership shifts | `claim_intervals_partition`; `claim_attribution_runs` |
| Compare closed intervals tree-to-tree | claim attribution | current worktree changes contaminate historical ownership | `claim_attribution_runs`; `trace-vocabulary.md` |
| Prove selective independence with `apply --check`, without `--3way` | entangled commit | dependent or conflict-marker content lands under the wrong item | `claim_interval_independence`; `interval_stage_commit` |
| Refresh only committed real-index paths after moving `HEAD` | selective commit | phantom staged entries block or contaminate the next commit | `interval_stage_commit` |
| Enforce hooks' important guarantees before `commit-tree` | selective commit | plumbing bypasses formatting or policy checks | `handle_worklist_commit`; `developing-bram.md` § formatting |
| Move refs atomically and account for symbolic or detached `HEAD` | selective commits, scenarios | branch or detached state diverges from the created commit | `interval_stage_commit`; `capture_scenario`; `use_scenario` |
| Keep `refs/bram/*` local unless explicitly transported | claims, safety | private runtime state is mistaken for normal pushed branch history | `trace-vocabulary.md`; normal push refspec behavior |
| Translate only managed worktree coverage paths | guard | legitimate edits are denied or unrelated paths become authorized | `worktree_coverage_target`; `coverage_verdict` in `src-tauri/src/guard_policy.rs` |
| Observe loose refs, packed refs, and `HEAD`, then recompute | push/default-branch UI | out-of-band Git changes remain invisible | `start_git_head_watch`; `out-of-band-actions.md` |
| Resolve the remote default branch instead of guessing its name | push and issue-close queue | ancestry is tested against the wrong branch | `origin_default_ref` in `src-tauri/src/lib.rs` |
| Treat commit SHA as rewrite-unstable | close-on-push | rebased or squashed work permanently strands queued closes | `git_commit_patch_id`; `find_origin_commit_by_patch_id`; `flush_pending_issue_closes` |
| Keep destructive fixture operations inside a marked, remote-free repo | synthetic scenarios | exploratory reset/clean damages real or publishable work | `validate_demo`; `use_scenario` in `scripts/demo_instance.py` |

## Source landmarks

- [`src-tauri/src/lib.rs`](../src-tauri/src/lib.rs): `git_run`,
  `worklist_change_index`, `handle_worklist_commit`, claim capture and replay,
  interval staging, ref watching, default-branch resolution, and issue-close
  reconciliation.
- [`src-tauri/src/guard_policy.rs`](../src-tauri/src/guard_policy.rs):
  `worktree_coverage_target` and `coverage_verdict`.
- [`scripts/demo_instance.py`](../scripts/demo_instance.py): temporary-index
  capture, scenario commit ancestry, detached hydration, and ref recreation.
- [`app/__shell/conventions.md`](../app/__shell/conventions.md): canonical
  Worklist authorization, lifecycle, staging, and linked-worktree rules.
- [`trace-vocabulary.md`](trace-vocabulary.md): claim-interval events, manual
  safety snapshots, ref ownership, and operational diagnostics.
- [`out-of-band-actions.md`](out-of-band-actions.md): watchers, sightings,
  self-healing recomputation, and missed-event reasoning.
- [`worklist-gate-design.md`](worklist-gate-design.md): security model and the
  division of responsibility between the agent, host, and guard.
