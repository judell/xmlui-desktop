# SQLite as Bram infrastructure

Bram uses SQLite in three different roles: full-text search, a transitional
mirror of Worklist lifecycle state, and a read-only query bridge for target
apps. Those roles share a database engine but not an authority model. Treating
them as one database would blur important boundaries around ownership,
recovery, security, and migration.

This guide is the companion to
[`git-as-infrastructure.md`](git-as-infrastructure.md). The Git guide explains
content-addressed history, refs, indexes, and worktrees. This guide explains
where relational storage helps, where it is only a projection, and how the two
systems should—and should not—depend on each other.

## The three database roles

| Role | Location | Owner and writers | Authority | Main readers |
|---|---|---|---|---|
| Unified search index | `<app_cache_dir>/search-index/<project-key>.db` | Bram's background indexer | Rebuildable projection | Search, History, issue/session detail caches, Status |
| Worklist state mirror | `<app_cache_dir>/worklist-state/<project-key>.db` | Bram's lifecycle mirror and item synchronizer | Transitional shadow; lifecycle files remain authoritative | Status, divergence checks, diagnostic tooling |
| Project query database | Project-relative path named by `.bram.json` `db` | The project or an agent using normal file authorization | Whatever authority the project assigns it; never a Bram internal store | Target-app XMLUI through `POST /query` |

The first two databases are private, machine-local Bram state outside the
repository. Their filename key is derived from the exact project-root path, so
moving a checkout naturally selects a different cache. The third database is
inside the project root by explicit opt-in. Bram opens it only for reads and
does not own its schema or populate it implicitly.

All three use the bundled SQLite linked through `rusqlite`, but that is an
implementation commonality, not permission to connect them. In particular,
`/query` cannot reach either private Bram database. The search index contains
session transcript text, making that separation a security boundary as well
as an architectural one.

## Authority before schema

The first question for any SQLite-backed feature is not “which tables?” but
“what is the source of truth?” Bram currently has three answers:

- **Derived:** the search database may be dropped and reconstructed from
  sessions, Git, Worklist history, and the forge.
- **Mirrored:** the state database is being used to prove that a relational
  representation can agree with the lifecycle files before any full authority
  migration.
- **Project-defined:** the database behind `/query` may be a scratch analysis,
  a generated read model, or primary project data. Bram does not decide.

That classification determines failure behavior. A derived index should skip,
retry, prune, or rebuild. A mirror should preserve the current authority,
record divergence, and repair idempotently. A project database needs the
project's own migration, backup, and write policy; Bram supplies only a guarded
read path.

## The first use: one search index, four logical buckets

The original SQLite subsystem is the unified project search introduced in
issue #230. Its four logical `type` values are:

| Search type | Canonical input | Document key examples | Refresh signal |
|---|---|---|---|
| `session` | Claude and Codex transcript files | absolute session path | transcript discovery, filesystem events, targeted intent refresh |
| `commit` | Git commit metadata and bounded patch text | `commit:<sha>` | Git-state events and startup reconciliation |
| `issue` | Forge issue data | `issue:<number>` | periodic forge refresh and issue activity |
| `worklist-history` | committed/dropped Worklist history JSON and Markdown | `history:<timestamp>` | Worklist-history filesystem changes |

Claude and Codex are separate scan streams but one logical session bucket.
`SessionIntents` appears as an internal refresh request in the indexer; it
updates supplemental intent text for session rows and is not a fifth search
type.

### Schema and query model

[`src-tauri/src/search_index.rs`](../src-tauri/src/search_index.rs) owns the
database layer. The current schema has three application tables:

- `search_index`, an FTS5 virtual table with common display/search columns:
  `type`, `source`, `date`, `link`, `content`, and lower-weight `intent`, plus
  unindexed `file` and `extra` fields.
- `indexed_files`, mapping a generic document key to its change token, size,
  FTS row ID, and indexing time.
- `session_tools`, mapping tool-call IDs to transcript paths so intent updates
  can target affected sessions instead of rescanning everything.

The common row shape lets one FTS5 `MATCH` query search all four buckets, use
weighted `bm25` ranking, filter by allowed types, and return highlighted
snippets. The `file` column is a generic document key, despite its historical
name. `extra` can carry a self-contained structured payload, such as a
Worklist-history group or enriched issue, while other result kinds fetch their
detail from the live source or a focused route.

Each input has a cheap change token. Session files use modification time and
size; immutable or synthetic sources use source-appropriate tokens such as a
commit identity, issue update marker, or history timestamp. `index_doc`
replaces one document and its bookkeeping row in a SQLite transaction.
Unchanged inputs skip extraction and writes.

The index opens in WAL mode so readers can query while the single background
indexer writes. On a search schema-version mismatch, Bram drops its search
tables and recreates them. That is safe precisely because every row is a
projection and the indexer can repopulate it.

### Refresh and recovery

```text
sessions ───────┐
Git commits ────┤
forge issues ───┼── discover → change-token gate → extract → FTS5 row
Worklist history┘                                      |
                                                       v
                                             /__search and Status
```

Startup waits until the project is acknowledged as managed, then indexes in
cheap-first order: Worklist history, sessions, commits, and issues. Local
watcher requests go to one indexer thread, where bursts coalesce into at most
one pass per requested bucket. Periodic issue refresh covers remote activity
that has no local filesystem event. Deleted transcript files are pruned because
an incremental walk of existing files would otherwise leave phantom hits.

Rebuildability does not excuse stale-state blindness. Git history can be
rewritten, forge snapshots can race updates, and events can arrive while Bram
is closed. The driver therefore combines incremental gates with startup
reconciliation, periodic refresh, targeted invalidation, and explicit stale
markers. The complete trace vocabulary is in
[`trace-vocabulary.md`](trace-vocabulary.md).

The search interface is Bram's internal `/__search` family. It is unrelated to
the target-app `/query` route described later: `/__search` queries a fixed Bram
schema with search-specific validation and enrichment; `/query` sends
project-authored SQL to one explicitly configured project database.

## The transitional Worklist state mirror

The second subsystem begins a mirror-then-migrate strategy for Worklist
lifecycle state. Its database is deliberately separate from the search cache:

```text
authoritative lifecycle file write succeeds
                    |
                    v
            best-effort mirror apply
                    |
          +---------+----------+
          |                    |
       current rows      transitions ledger
          |                    |
          +---------+----------+
                    v
       Status + divergence tripwire
```

At this phase, these files remain the source of truth:

- `resources/worklist.json` for items and their status, declared files,
  begun stamp, and issue-close metadata.
- `resources/.worklist-authorization.json` for the active authorization.
- `resources/.inflight-claim.json` for the active lifecycle claim.

The host mirrors authorization and claim changes only after the corresponding
file write succeeds. A mirror error is trace-only and cannot block, roll back,
or reinterpret the successful file operation. The item file is different:
agents write `worklist.json` directly, so there is no single host write choke
point. Bram instead performs an idempotent full-file item synchronization from
three places:

1. The filesystem watcher, after policy enforcement has restored any rejected
   write.
2. The successful mutate path, including the prune reached after a Worklist
   commit.
3. A reconcile-on-read backstop before `/__worklist` is served when the file
   modification time is newer than the latest item synchronization.

Redundancy is intentional. The watcher echo and read backstop make a transient
database error or timing gap self-healing without changing which store is
authoritative.

### State-mirror schema

[`src-tauri/src/worklist_state.rs`](../src-tauri/src/worklist_state.rs) owns
four tables:

| Table | Current-state role | Historical role |
|---|---|---|
| `auth_records` | row matching the active authorization file, when mirrored | retains prior authorizations and consume times |
| `claims` | single uncleared claim | retains cleared and displaced claims |
| `items` | latest mirrored Worklist item fields, with soft tombstones | retains first/last seen and pruned times |
| `transitions` | none; append-only events | records auth, claim, and selected item lifecycle changes |

Authorization rows are keyed by their issue timestamp and updated on partial or
full consumption. Claim rows preserve the file's single-slot semantics: writing
a new live claim marks an uncleared predecessor as displaced before inserting
the new row. Item synchronization upserts present IDs and soft-tombstones IDs
missing from the latest `worklist.json`; it does not delete them because the
transitions ledger still refers to their history.

The database uses WAL mode and a 250 ms busy timeout. Unlike the search cache,
its schema must never be repaired by dropping tables. The current additive
version added `items` without disturbing earlier state. Future incompatible
changes require explicit data-preserving migrations; changing
`PRAGMA user_version` alone is not a migration.

### What already reads the mirror—and what does not

The migration is intentionally partial. The Worklist response is still built
from the files. Before serving it, Bram reconciles item rows and, when tracing
is enabled, compares independently derived file and database views for:

- item ID, status, `begunAtMs`, and declared files;
- the current claim; and
- the current authorization and consumed state.

A mismatch emits a deduplicated `state-mirror op=divergence` trace and
increments the process health counter. It does not change the response. Tests
deliberately write false database state to prove the tripwire can fire; merely
observing no production divergence would not prove the detector works.

Some Status data already benefits from the relational history. The current
claim is read from the live `claims` row with file fallback, claim write/clear
pairs come from the always-on transitions ledger, and recent authorization
history comes from `auth_records`. The Worklist itself remains file-backed
pending a later, evidence-backed reader flip.

[`scripts/state-mirror-check.py`](../scripts/state-mirror-check.py) is the
on-demand consistency checker. It compares authorization and claim files with
their matching rows, and `--items` also compares live Worklist items. Records
that predate creation of a fresh mirror are reported as informational
`PRE-MIRROR`, because the database could not have observed those writes.
Post-creation disagreements are real mismatches.

This is the important meaning of “transitional”: SQLite has begun serving
useful historical and Status reads, but current file authority and fail-open
mirror writes are still explicit product behavior. The intended direction in
the module is not permission to act as if migration has already happened.

## `/query`: XMLUI access to project SQLite

The third role is not a Bram cache or mirror. It is a bridge from target-app
XMLUI to one database chosen by the project.

Add a project-relative path to `.bram.json`:

```json
{
  "db": "resources/scratch.db"
}
```

Then a target surface can bind a live relational view:

```xml
<DataSource
  id="recentTxns"
  url="/query"
  method="POST"
  dataType="sql"
  body="{{
    sql: 'SELECT txn_date, payee, amount FROM transactions WHERE account = ?1 ORDER BY txn_date DESC LIMIT 100',
    params: [selectedAccount.value]
  }}" />

<Table data="{recentTxns.value}" />
```

The authoritative XMLUI workflow and scratch-pad pattern live in
[`app/__shell/conventions.md`](../app/__shell/conventions.md#live-sql-views-via-query-project-sqlite).
The wire contract is cataloged in [`docs/apis.md`](apis.md); the upstream
component behavior is documented in the
[XMLUI `DataSource` reference](https://www.xmlui.org/docs/reference/components/DataSource).

### Route contract and security boundary

`handle_query_route` reloads project configuration, resolves the configured
path against the project root, canonicalizes both paths, and refuses a database
that is missing or resolves outside the root. No `db` setting means there is no
SQL surface. A symlink cannot be used to escape the project because the
canonical target is checked.

The engine enforces read-only access twice:

- the connection opens with `SQLITE_OPEN_READ_ONLY`; and
- the connection enables `PRAGMA query_only`.

This is stronger than classifying statement text as “probably a SELECT.” A
mutation fails at SQLite even if it is hidden behind a pragma, common table
expression, trigger, or unfamiliar syntax. Agents may create or update the
database through normal gate-governed filesystem work; target markup cannot
use `/query` as a write tunnel.

The preferred request is `{ "sql": "...", "params": [...] }`. JSON string
and bare-text SQL forms exist for XMLUI runtime compatibility. Parameters are
bound through SQLite rather than interpolated, so dynamic UI values should
always be parameters. Nulls, booleans, integers, reals, and strings map to
SQLite scalar values; arrays or objects are serialized as JSON text.

A successful response is a JSON array with one object per row and column names
as keys. SQLite null, integer, real, and text values map naturally. Blob values
currently become lossy UTF-8 strings; a project that needs binary fidelity
should select an explicit textual encoding such as `hex(blob_column)`. The
route materializes the full result, so target queries should use filters and
`LIMIT` rather than relying on implicit pagination.

Expected failures are observable as `query-route` trace lines: no configured
database, missing database, path outside the root, malformed body, or a SQLite
error. The engine's read-only refusal arrives as a SQL error. Successful traces
carry row count and duration, not SQL text or returned data.

The HTTP status boundary is correspondingly small: `200` returns the JSON row
array; `409` means no database is configured or its path is unreadable; `403`
means the resolved path escapes the project; `400` covers malformed request
bodies and SQLite prepare/query errors; and absence of a project root is a
host-level `500`.

Relative `/query` reaches Bram when its loopback server is the target app's
content upstream. If a project supplies its own development server, the same
URL reaches that server instead. Such a project implements the same wire
contract itself; the XMLUI markup need not change.

### Suitable project databases

The bridge works well for:

- a gitignored scratch database materializing an agent's normalization, join,
  or aggregation for a live table or chart;
- a project-owned analytical database with an established writer and migration
  policy; or
- a generated read model that the project knows how to rebuild.

It is not a route to Bram's search or state-mirror databases, a general file
browser, or a substitute for a production application's authenticated data
API.

## How Git and SQLite should relate

Git and SQLite solve complementary problems:

| Need | Prefer Git | Prefer SQLite |
|---|---|---|
| immutable content snapshots and parentage | yes | no |
| named movable history points and remote transport | refs and branches | no native equivalent |
| collaborative textual review and merge | source/config/migrations | not a live database file |
| full-text search across heterogeneous records | source remains elsewhere | FTS5 projection |
| current-state joins and lifecycle questions | awkward graph/file scans | indexed tables and SQL |
| append-only operational ledger | possible but cumbersome | transactionally appended rows |
| exact dirty working-tree state | Git index/worktree/status | only if deliberately sampled, then stale |
| interactive target-app analysis | version query/schema source in Git | query project data through `/query` |

### Relationships Bram should use

**Index canonical Git and file data for discovery.** Commit rows in search make
Git history queryable beside sessions, issues, and Worklist history. The row is
a projection; the commit object and refs remain the authority for existence,
ancestry, and content.

**Carry provenance across the boundary.** A relational row may record a commit
SHA, ref name, tree ID, project key, source path, or observed time. The meaning
must travel with the value: a SHA names exact content but can disappear from
visible history after rebase; a ref name is stable as a name but mutable as a
pointer; a path is checkout-relative; a patch ID is useful for re-anchoring but
is not a universal business identifier.

**Make projections repeatable and idempotent.** Search uses per-document
change tokens and replace-in-transaction writes. The state mirror uses upserts,
soft tombstones, watcher resync, and reconcile-on-read. Duplicate notification
or a restart should converge on the same secondary state.

**Observe changes from both sides of process lifetime.** Filesystem and ref
watchers provide low-latency refresh, while startup scans, periodic refresh,
and on-read reconciliation recover missed or out-of-band events. See
[`out-of-band-actions.md`](out-of-band-actions.md).

**Let relational views answer relational questions.** “Which sessions mention
this commit?”, “how many claim clears followed writes?”, or “which items were
pruned after a status transition?” are natural SQLite queries. Git should not
be distorted into a mutable relational ledger to answer them.

### Relationships Bram should avoid

**A SQLite row is not Git reachability.** Recording a tree or commit ID in a
table does not stop Git garbage collection. If Bram needs an object to remain
available, a Git ref or reachable commit must retain it. SQLite can describe
the object; Git owns its lifetime.

**An index row is not proof of current Git state.** It cannot prove current
`HEAD`, remote ancestry, ref existence, or dirty worktree content. Re-read Git
for decisions whose safety depends on those facts.

**There is no cross-store atomic transaction.** A SQLite transaction can commit
several rows atomically. `git update-ref` can move refs atomically. Neither can
include the other's operation. Bram must choose an authority, commit that
operation first, then update the secondary store idempotently and retain a way
to detect and repair interruption.

**A live SQLite database is usually a poor Git collaboration artifact.** Git
stores the entire database as an opaque blob, cannot meaningfully line-diff or
merge concurrent row changes, and may catch `-wal` or `-shm` sidecars that do
not form a standalone snapshot. Bram's internal databases therefore live in
the app cache, not the repository.

Committing SQLite is not categorically forbidden. A project may intentionally
version a small, closed, deterministic database as a release artifact. Do so
only with all writers stopped, WAL content checkpointed, sidecars excluded,
reproducible source or migrations retained, and no expectation of row-level
review or branch merging. Schema definitions, migrations, import sources, and
rebuild scripts are almost always better Git artifacts than the active file.

**Do not silently promote a cache into authority.** Once behavior begins
reading a projection, schema preservation, migrations, backup, repair, and
divergence semantics become product requirements. The state mirror stages that
transition explicitly; search remains explicitly disposable.

## Cross-store design rule

For any new feature spanning Git/files and SQLite, write down this sequence:

```text
1. Name the authority.
2. Commit the authoritative change.
3. Emit or discover a stable replay key.
4. Update the secondary store idempotently.
5. Expose lag or divergence.
6. Reconcile on startup/read/event loss.
7. Define schema migration and rebuild/repair behavior.
```

Examples:

- **Search:** source transcript or Git object first; document key and change
  token identify the projection; reindex repairs it; schema mismatch rebuilds.
- **Current state mirror:** lifecycle file first; timestamp/item ID identifies
  the mirror operation; watcher and read resync repair it; divergence remains
  visible; schema changes preserve rows.
- **Project query database:** the project declares the authority and writer;
  Bram does not mirror it; `/query` is read-only; the project owns recovery.

If no one can say how step 5 or 6 works, the design is not yet safe enough to
put between a Git decision and a user-visible claim.

## Read-only diagnostic playbook

Prefer the Status tab for normal operation: it reports search bucket counts and
state-mirror path, size, last application, transition count, and divergences.
For direct inspection, use SQLite's read-only CLI mode and an explicit path:

```sh
# Search schema version and logical bucket counts.
sqlite3 -readonly /path/to/search-index.db \
  'PRAGMA user_version; SELECT type, count(*) FROM search_index GROUP BY type ORDER BY type;'

# Search bookkeeping without revealing indexed content.
sqlite3 -readonly /path/to/search-index.db \
  'SELECT count(*) AS docs, max(indexed_at) AS latest FROM indexed_files;'

# Mirror schema and health.
sqlite3 -readonly /path/to/worklist-state.db \
  'PRAGMA user_version; SELECT kind, count(*) FROM transitions GROUP BY kind ORDER BY kind;'

# Current live claim and latest item-sync watermark.
sqlite3 -readonly /path/to/worklist-state.db \
  "SELECT kind, ids, written_at_ms FROM claims WHERE cleared_at_ms IS NULL; SELECT max(last_synced_ms) FROM items;"

# File-versus-mirror consistency check.
scripts/state-mirror-check.py \
  --project-root /path/to/project \
  --db /path/to/worklist-state.db \
  --items
```

Search rows can contain session, issue, and patch content. Do not paste raw
`content` or `extra` columns into logs or bug reports. The built-in search trace
intentionally records counts, timings, sizes, and allowlisted facet names—not
queries, snippets, titles, or paths.

To exercise the project bridge without mutating its database, use a parameterized
`SELECT` through XMLUI or send the documented body to `POST /query`. Inspect the
`query-route` trace for refusal and timing information. Do not point `.bram.json`
at a Bram cache by copying it into the project; that defeats the boundary the
route is designed to preserve.

## Invariants and failure patterns

| Invariant | Owner | Failure if broken | Recovery or evidence |
|---|---|---|---|
| Keep all three database roles and authority models distinct | architecture and route boundaries | a cache, mirror, or project database is trusted for the wrong decision | separate paths/modules; explicit `db`; this guide's role table |
| Keep search rebuildable | unified search | a schema bump or stale row becomes an unrecoverable product-state loss | `search_index::ensure_schema`; full startup indexing |
| Use source-specific change tokens and idempotent replacement | search indexer | repeated scans are expensive or duplicate results | `needs_index`; transactional `index_doc`; missing-file prune |
| Never expose private Bram databases through `/query` | query route | transcript or lifecycle state leaks into target markup | explicit project-relative `db`; canonical inside-root check |
| Enforce `/query` read-only in SQLite, not with SQL text heuristics | query route | unfamiliar syntax bypasses a hand-written allowlist | read-only open flag plus `PRAGMA query_only`; mutation refusal tests |
| Keep lifecycle files authoritative during phase A | state mirror | a failed secondary write changes or blocks Worklist behavior | file-first call order; trace-only `worklist_state_apply` errors |
| Reconcile agent-authored item state from complete snapshots | state mirror items | direct `worklist.json` edits never reach the mirror | watcher, mutate, and reconcile-on-read full sync |
| Preserve mirror history across schema evolution | state mirror | a version bump destroys the evidence needed for migration | additive schema today; explicit future migrations; never drop tables |
| Prove divergence detection can fail loudly | state mirror tripwire | zero observed divergence gives false confidence in a dead detector | deliberate-fire `compare_divergence_catches_*` tests |
| Keep secondary updates idempotent and repairable | every cross-store projection | crash between authority and SQLite leaves permanent split-brain | stable keys, upserts/tombstones, startup/read reconciliation |
| Re-read Git for reachability, ancestry, refs, and dirty state | Git-dependent decisions | stale relational rows authorize or report nonexistent state | Git commands and watchers; `git-as-infrastructure.md` |
| Retain Git objects with Git refs or commits, not SQLite rows | claim/safety/scenario infrastructure | object IDs remain in SQL after Git garbage collection | `refs/bram/*` or scenario ancestry |
| Treat commit SHAs as exact but rewrite-unstable provenance | search and cross-store links | rebase/squash strands relational references | reindex/reconcile; stable patch ID only as a supplemental re-anchor |
| Do not pretend Git and SQLite share an atomic transaction | cross-store workflows | one side commits and the other silently does not | authority-first ordering, replay key, divergence, repair |
| Keep active SQLite files out of ordinary Git collaboration | project data policy | opaque binary churn, WAL inconsistency, and unmergeable branches | version schema/migrations/sources; generate or checkpoint artifacts deliberately |
| Bound and parameterize project queries | target-app authors | excessive response memory or unsafe string construction | bound `params`, filtering, and explicit `LIMIT` |

## Source landmarks

- [`src-tauri/src/search_index.rs`](../src-tauri/src/search_index.rs): FTS5
  schema, schema-version rebuild, document bookkeeping, indexing transactions,
  queries, and missing-file pruning.
- [`src-tauri/src/worklist_state.rs`](../src-tauri/src/worklist_state.rs):
  file-first mirror contract, persistent schema, mirror operations, item sync,
  divergence comparison, and Status read helpers.
- [`src-tauri/src/lib.rs`](../src-tauri/src/lib.rs): `search_index_db_path`,
  `start_search_indexer`, bucket drivers, `worklist_state_db_path`, lifecycle
  mirror choke points, `observe_state_mirror_divergence`,
  `parse_query_route_body`, `execute_readonly_query`, and
  `handle_query_route`.
- [`scripts/state-mirror-check.py`](../scripts/state-mirror-check.py):
  cross-store consistency checks and pre-mirror interpretation.
- [`docs/apis.md`](apis.md): canonical `/query` request, response, and status
  contract.
- [`trace-vocabulary.md`](trace-vocabulary.md): `search-index`, `state-mirror`,
  and `query-route` events and privacy rules.
- [`out-of-band-actions.md`](out-of-band-actions.md): watcher, periodic,
  sighting, and prevention patterns used to recover external changes.
- [`git-as-infrastructure.md`](git-as-infrastructure.md): Git object
  reachability, refs, remote ancestry, patch IDs, and worktree state.
