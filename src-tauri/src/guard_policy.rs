// Shadow port of the Claude worklist guard (bram-guard-worklist-policy-shadow),
// phase 1 of the Python-hook retirement. The authoritative implementation is
// app/provider-hooks/claude-worklist-guard.py; this module reproduces its
// decision pipeline as a pure-ish function so `bram guard claude-worklist` can
// write one breadcrumb per invocation and the divergence check is a grep-join
// against the Python guard's own `[worklist-guard]` trace lines.
//
// Shadow discipline, contractual:
//
// - No stdout. The Python guard signals `deny` by exit code 2 plus stderr, and
//   `allow` for lifecycle paths by a JSON permissionDecision on stdout. The
//   shadow prints neither; `run_guard_mode` exits 0 unconditionally.
// - No network. The Python guard POSTs `/__hook-trace` and, on a prose opt-out,
//   `/__audit/direct-edit`. The shadow makes no HTTP call at all.
// - No writes except the breadcrumb line guard.rs appends.
// - Filesystem reads and `git cat-file` are ported as-is: they are what the
//   decisions are made of.
//
// Deliberate divergences from the Python guard are all judell/bram#299 and are
// each marked `#299` at their site: pure forge reads, inline `python -c` whose
// script does not write, and comparison operators inside shell quotes.
//
// Fidelity notes that are NOT divergences, recorded so the grep-join is
// readable:
//
// - The Python guard emits several NON-TERMINAL trace lines per invocation
//   (crossboundary-signed/unparsed, forge-sha-ok, subagent-gate-no-agent-id,
//   the payload-keys observe line). The shadow records only the terminal
//   decision, because the breadcrumb contract is one line per invocation.
// - The breadcrumb's `target` field must not contain whitespace, so where the
//   Python trace target is a 200-char command preview or a comma-joined path
//   list the shadow writes `-`.
// - Python exits 0 silently (no trace at all) on four Write/Edit paths. Those
//   surface here as `no-trace:*` reasons; a `no-trace:` prefix means "the
//   Python guard allows here and emits nothing", so the join expects no twin.

use serde_json::Value;
use std::collections::HashSet;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq)]
pub struct ShadowVerdict {
    pub decision: String,
    pub reason: String,
    pub target: String,
    // Authority mode (bram-guard-authority-flip): the user-facing deny
    // message the Python guard would print to stderr, verbatim. Empty for
    // allows and for deny sites whose message transcription is pending —
    // authority mode then falls back to the no-coverage template, the
    // dominant deny class. Shadow mode ignores this field entirely.
    pub message: String,
    // Set only on a prose-opt-out allow: a stable hash of the matched last
    // user message, for the /__audit/direct-edit breadcrumb authority mode
    // POSTs (the shadow never POSTs). Host dedup keys on the value being
    // stable per turn, not on its algorithm.
    pub audit_turn_key: Option<String>,
}

// Authority-mode fallback deny text, used while a deny site's verbatim
// message transcription is pending. The no-coverage template is transcribed
// from the Python guard's dominant deny (live specimens 2026-08-28/29);
// other reasons get an honest generic that names the reason rather than
// borrowing the wrong template.
pub fn fallback_deny_message(tool: &str, target: &str, root: &Path, reason: &str) -> String {
    let header = format!(
        "[worklist-guard] tool={} target={} cwd={} decision=deny reason={}",
        tool,
        target,
        root.display(),
        reason
    );
    if reason.starts_with("no-coverage") || reason.starts_with("bash-write-no-coverage") {
        return format!(
            "{}\nBlocked: writing to {} requires either a proposed/applied item in resources/worklist.json covering this path, or an explicit opt-out phrase in your last message.\n  - Propose the change in resources/worklist.json first (item with file=\"{}\", non-empty before and after, status proposed). Wait for the user's approved: payload, then retry.\n  - The user can authorize a direct edit by ending their message with \"just do it\", or by clicking the Skip worklist button.\nresolved_project_root={} (marker: resources/.worklist-authorization.json; if this is not the repo root, a stray marker file captured this subtree — remove that resources/.worklist-authorization.json)",
            header,
            target,
            target,
            root.display()
        );
    }
    format!(
        "{}\nBlocked by the Bram worklist guard ({}). See .claude/bram-conventions.md for the governing convention; address the named reason and retry.",
        header, reason
    )
}

fn allow(reason: impl Into<String>, target: impl Into<String>) -> ShadowVerdict {
    ShadowVerdict {
        decision: "allow".into(),
        reason: reason.into(),
        target: target.into(),
        message: String::new(),
        audit_turn_key: None,
    }
}

fn deny(reason: impl Into<String>, target: impl Into<String>) -> ShadowVerdict {
    ShadowVerdict {
        decision: "deny".into(),
        reason: reason.into(),
        target: target.into(),
        message: String::new(),
        audit_turn_key: None,
    }
}

// --- authority-mode deny messages -------------------------------------------
//
// The Python guard's stderr on a deny is TWO parts: `_trace_hook` writes the
// `[worklist-guard] …` diagnostic line first (always, tracing on or off), then
// the site's own `print(msg, file=sys.stderr)`. `authority_worklist_hook`
// eprintln!s `ShadowVerdict::message` and nothing else, so the transcribed
// message carries both halves, joined by a newline.
//
// Three header fields vary per site and are NOT the verdict's own fields:
//
// - `tool` — "Bash" on the Bash branch, the mcp__ tool name on the MCP branch,
//   and the Write/Edit tool name elsewhere (Python stashes it in
//   `__BRAM_TRACE_TOOL` for the deny_* helpers).
// - `target` — the Python trace target, which on Bash is the 200-char command
//   preview and on `mcp-unrecognized-input` is the empty string. The verdict's
//   own `target` stays whitespace-free for the breadcrumb, so the two differ.
// - `cwd` — the payload cwd on the Bash and MCP branches (passed explicitly),
//   and the process cwd everywhere else, where Python lets `_trace_hook`
//   default to `os.getcwd()`.
fn hook_stderr_header(tool: &str, target: &str, cwd: &str, decision: &str, reason: &str) -> String {
    format!(
        "[worklist-guard] tool={} target={} cwd={} decision={} reason={}",
        tool, target, cwd, decision, reason
    )
}

/// Python `os.getcwd()`, with its `except` branch's empty string.
fn process_cwd() -> String {
    std::env::current_dir()
        .map(|p| p.display().to_string())
        .unwrap_or_default()
}

/// A deny carrying the Python guard's verbatim stderr text.
/// `verdict_target` is the breadcrumb's target; `header_*` are the trace
/// line's fields (see above); `body` is the site's `print(...)` text.
fn deny_msg(
    reason: impl Into<String>,
    verdict_target: impl Into<String>,
    header_tool: &str,
    header_target: &str,
    header_cwd: &str,
    body: &str,
) -> ShadowVerdict {
    let reason = reason.into();
    let header = hook_stderr_header(header_tool, header_target, header_cwd, "deny", &reason);
    let mut v = deny(reason, verdict_target);
    v.message = format!("{}\n{}", header, body);
    v
}

/// `deny_coverage` (python claude-worklist-guard.py:1183-1245). Returns the
/// (reason, message-body) pair; the caller owns the trace header fields.
fn deny_coverage_parts(
    target_rel: &str,
    opt_out_attempted: bool,
    project_root: Option<&Path>,
    session_root: Option<&Path>,
    session_bypass_detail: Option<&str>,
) -> (String, String) {
    let mut msg = format!(
        "Blocked: writing to {target} requires either a proposed/applied item in resources/worklist.json covering this path, or an explicit opt-out phrase in your last message.\n  - Propose the change in resources/worklist.json first (item with file=\"{target}\", non-empty before and after, status proposed). Wait for the user's approved: payload, then retry.\n  - The user can authorize a direct edit by ending their message with \"just do it\", or by clicking the Skip worklist button.",
        target = target_rel
    );
    if opt_out_attempted {
        msg.push_str("\n  - (Detected what looked like opt-out language, but it didn't match the expected phrasing. The verbal opt-out is exactly \"just do it\"; otherwise use the Skip worklist button.)");
    }
    let mut reason = "no-coverage-no-opt-out".to_string();
    let (_, worktree) = worktree_coverage_target(target_rel);
    if let Some(worktree) = worktree {
        msg.push_str(&format!(
            "\nworktree={} (coverage checked against the corresponding real-tree path; this denial is still authoritative)",
            worktree
        ));
        reason.push_str(&format!(":worktree={}", worktree));
    }
    if let Some(root) = project_root {
        msg.push_str(&claude_coverage_root_line(root));
        reason.push_str(&format!(":root={}", root.display()));
    }
    if let (Some(sr), Some(detail)) = (session_root, session_bypass_detail) {
        msg.push_str(&format!(
            "\nAlso checked the session project's direct-edit bypass (cwd-derived root: {}): {}.",
            sr.display(),
            bypass_detail_label(detail)
        ));
        reason.push_str(&format!(":session_root={}:{}", sr.display(), detail));
    }
    (reason, msg)
}

/// The `resolved_project_root=` line shared by `deny_coverage` and
/// `deny_bash_coverage` (issue-280).
fn claude_coverage_root_line(project_root: &Path) -> String {
    format!(
        "\nresolved_project_root={} (marker: {}; if this is not the repo root, a stray marker file captured this subtree — remove that {})",
        project_root.display(),
        AUTH_REL,
        AUTH_REL
    )
}

/// judell/bram#287's deny text as the Bash-redirect (python:2087-2096) and MCP
/// (python:2179-2187) surfaces print it. The Write/Edit surface's copy carries
/// an extra clause and is spelled out at that site instead.
const SUBAGENT_WORKLIST_WRITE_BODY: &str = "Worklist proposals and claim edits (resources/worklist.json, resources/worklist-drafts/*) stay in the orchestrator's own turn. A delegated subagent cannot write them directly. See 'Delegating worklist items to subagents' in conventions.md and judell/bram#287.";

/// `_BYPASS_DETAIL_LABELS` (python:1175-1180), with its `.get(detail, detail)`
/// fallback to the raw detail token.
fn bypass_detail_label(detail: &str) -> &str {
    match detail {
        "absent" => "no resources/.worklist-authorization.json there",
        "wrong-kind" => "a record exists there but isn't a direct-edit bypass",
        "stale" => "a direct-edit record there has expired (>1h old)",
        "path-not-covered" => "a fresh direct-edit record there doesn't cover this path",
        other => other,
    }
}

// --- constants (mirror of the Python module's) ------------------------------

const WORKLIST_REL: &str = "resources/worklist.json";
const WORKLIST_DRAFTS_PREFIX: &str = "resources/worklist-drafts/";
const WORKTREE_PREFIX: &str = ".claude/worktrees/";
const AUTH_REL: &str = "resources/.worklist-authorization.json";
const BYPASS_TTL_MS: f64 = 60.0 * 60.0 * 1000.0;
const POST_COMMIT_PUSH_GRACE_MS: f64 = 10.0 * 60.0 * 1000.0;

const LIFECYCLE_PATHS_EXACT: &[&str] = &[
    "resources/worklist.json",
    "resources/.worklist-authorization.json",
    "resources/.inflight-claim.json",
    "resources/.pty-intent.jsonl",
    "resources/.worklist-intent.json",
    "resources/.worklist-result.json",
    "resources/.bram-port",
    "resources/.bram-port.json",
];
const LIFECYCLE_PATHS_PREFIXES: &[&str] = &[
    "resources/worklist-drafts/",
    "resources/worklist-citations/",
    "resources/feedback-drafts/",
    "resources/feedback-history/",
    "resources/bram-traces/",
];

const MCP_WRITE_TOKENS: &[&str] = &[
    "write", "edit", "create", "delete", "remove", "rename", "move", "copy", "patch", "append",
    "truncate", "mkdir", "rmdir", "modify", "replace", "save", "set_",
];

// Order is load-bearing: mcp_paths returns values in this key order.
const MCP_PATH_KEYS: &[&str] = &[
    "path",
    "file_path",
    "filepath",
    "filename",
    "source",
    "src",
    "destination",
    "dest",
    "dst",
    "target",
    "target_path",
    "to",
    "from",
];

const WORKLIST_LIFECYCLE_ROUTES: &[&str] = &[
    "/__worklist/resolve",
    "/__worklist/mutate",
    "/__worklist/commit",
];

const NONREPO_REDIRECT_EXACT: &[&str] = &["/dev/null", "/dev/zero", "/tmp", "/private/tmp"];
const NONREPO_REDIRECT_PREFIXES: &[&str] = &["/tmp/", "/private/tmp/"];

// --- character-scanning primitives ------------------------------------------
//
// The Python guard's classifiers are regexes; guard mode is stdlib-only, so
// each one is hand-ported as a scanner over `Vec<char>`. Every helper below
// encodes one regex construct, so a reader can check the port against the
// pattern it replaces rather than against prose.

fn chars(s: &str) -> Vec<char> {
    s.chars().collect()
}

/// `(^|[\s;&|`(])` — the command-position boundary every verb pattern opens with.
fn at_boundary(c: &[char], i: usize) -> bool {
    if i == 0 {
        return true;
    }
    matches!(
        c[i - 1],
        ' ' | '\t' | '\n' | '\r' | '\u{b}' | '\u{c}' | ';' | '&' | '|' | '`' | '('
    )
}

/// Python `\w`: unicode alphanumerics plus underscore.
fn is_word(ch: char) -> bool {
    ch.is_alphanumeric() || ch == '_'
}

/// Trailing `\b`: end of input, or the next char is not a word char.
fn word_end(c: &[char], i: usize) -> bool {
    i >= c.len() || !is_word(c[i])
}

/// Leading `\b` before a word char at `i`.
fn word_start(c: &[char], i: usize) -> bool {
    i == 0 || !is_word(c[i - 1])
}

/// Literal match at `i`; returns the index just past it.
fn lit(c: &[char], i: usize, s: &str) -> Option<usize> {
    let mut j = i;
    for ch in s.chars() {
        if j >= c.len() || c[j] != ch {
            return None;
        }
        j += 1;
    }
    Some(j)
}

/// `\s+`
fn ws1(c: &[char], i: usize) -> Option<usize> {
    let mut j = i;
    while j < c.len() && c[j].is_whitespace() {
        j += 1;
    }
    if j == i {
        None
    } else {
        Some(j)
    }
}

/// `\s*`
fn ws0(c: &[char], i: usize) -> usize {
    let mut j = i;
    while j < c.len() && c[j].is_whitespace() {
        j += 1;
    }
    j
}

/// `(^|[\s;&|`(])<head>\s+[<sub>\s+]<verb>\b` — the shape of every
/// `gh issue <verb>` / `git <verb>` pattern in `_BASH_WRITE_PATTERNS`.
fn cmd_verb(c: &[char], heads: &[&str], subs: Option<&[&str]>, verbs: &[&str]) -> bool {
    for i in 0..c.len() {
        if !at_boundary(c, i) {
            continue;
        }
        for head in heads {
            let Some(j) = lit(c, i, head) else { continue };
            let Some(mut j) = ws1(c, j) else { continue };
            if let Some(subs) = subs {
                let mut matched = false;
                for s in subs {
                    if let Some(k) = lit(c, j, s) {
                        if let Some(k2) = ws1(c, k) {
                            j = k2;
                            matched = true;
                            break;
                        }
                    }
                }
                if !matched {
                    continue;
                }
            }
            for v in verbs {
                if let Some(k) = lit(c, j, v) {
                    if word_end(c, k) {
                        return true;
                    }
                }
            }
        }
    }
    false
}

/// `(^|[\s;&|`(])<word>\b` — bare-command patterns (`tee`, `rm`, `mv`, …).
fn cmd_word(c: &[char], words: &[&str]) -> bool {
    for i in 0..c.len() {
        if !at_boundary(c, i) {
            continue;
        }
        for w in words {
            if let Some(k) = lit(c, i, w) {
                if word_end(c, k) {
                    return true;
                }
            }
        }
    }
    false
}

/// `(^|[\s;&|`(])<head>\s+<flag>\b` — `node -e`, `bash -c`, `sh -c`.
fn cmd_flag(c: &[char], head: &str, flag: &str) -> bool {
    cmd_flag_at(c, head, flag).is_some()
}

fn cmd_flag_at(c: &[char], head: &str, flag: &str) -> Option<usize> {
    for i in 0..c.len() {
        if !at_boundary(c, i) {
            continue;
        }
        let Some(j) = lit(c, i, head) else { continue };
        let Some(j) = ws1(c, j) else { continue };
        if let Some(k) = lit(c, j, flag) {
            if word_end(c, k) {
                return Some(k);
            }
        }
    }
    None
}

/// `(^|[\s;&|`(])<head>\s+[^|;&]*<flag>\b` — `sed -i`, `perl -i`, where the
/// in-place flag may sit anywhere before the next pipeline separator.
fn cmd_inplace(c: &[char], head: &str, flag: &str) -> bool {
    for i in 0..c.len() {
        if !at_boundary(c, i) {
            continue;
        }
        let Some(j) = lit(c, i, head) else { continue };
        let Some(j) = ws1(c, j) else { continue };
        let mut k = j;
        while k < c.len() && !matches!(c[k], '|' | ';' | '&') {
            if let Some(e) = lit(c, k, flag) {
                if word_end(c, e) {
                    return true;
                }
            }
            k += 1;
        }
    }
    false
}

/// `(^|[\s;&|`(])python[0-9.]*\s+-c\b`. Returns the index just past `-c`.
fn python_dash_c_positions(c: &[char]) -> Vec<usize> {
    let mut out = Vec::new();
    for i in 0..c.len() {
        if !at_boundary(c, i) {
            continue;
        }
        let Some(mut j) = lit(c, i, "python") else {
            continue;
        };
        while j < c.len() && (c[j].is_ascii_digit() || c[j] == '.') {
            j += 1;
        }
        let Some(j) = ws1(c, j) else { continue };
        if let Some(k) = lit(c, j, "-c") {
            if word_end(c, k) {
                out.push(k);
            }
        }
    }
    out
}

/// `open\s*\(\s*['"][^'"]+['"]\s*,\s*['"][wax]` — an inline file open in write,
/// append, or exclusive-create mode. No leading boundary in the Python pattern.
fn open_write_mode(c: &[char]) -> bool {
    for i in 0..c.len() {
        let Some(j) = lit(c, i, "open") else { continue };
        let j = ws0(c, j);
        if j >= c.len() || c[j] != '(' {
            continue;
        }
        let j = ws0(c, j + 1);
        if j >= c.len() || !matches!(c[j], '\'' | '"') {
            continue;
        }
        let mut k = j + 1;
        let start = k;
        while k < c.len() && !matches!(c[k], '\'' | '"') {
            k += 1;
        }
        if k == start || k >= c.len() {
            continue;
        }
        let j = ws0(c, k + 1);
        if j >= c.len() || c[j] != ',' {
            continue;
        }
        let j = ws0(c, j + 1);
        if j >= c.len() || !matches!(c[j], '\'' | '"') {
            continue;
        }
        if j + 1 < c.len() && matches!(c[j + 1], 'w' | 'a' | 'x') {
            return true;
        }
    }
    false
}

/// `(^|[\s;&|`(])git\s+(-C\s+\S+\s+)?push\b`
fn push_cmd(command: &str) -> bool {
    let c = chars(command);
    for i in 0..c.len() {
        if !at_boundary(c.as_slice(), i) {
            continue;
        }
        let Some(j) = lit(&c, i, "git") else { continue };
        let Some(j) = ws1(&c, j) else { continue };
        // Optional `-C <path> `.
        let mut candidates = vec![j];
        if let Some(k) = lit(&c, j, "-C") {
            if let Some(k) = ws1(&c, k) {
                let mut e = k;
                while e < c.len() && !c[e].is_whitespace() {
                    e += 1;
                }
                if e > k {
                    if let Some(k2) = ws1(&c, e) {
                        candidates.push(k2);
                    }
                }
            }
        }
        for cand in candidates {
            if let Some(k) = lit(&c, cand, "push") {
                if word_end(&c, k) {
                    return true;
                }
            }
        }
    }
    false
}

// --- redirect scanning (quote-aware, #299 case 3) ---------------------------

/// Every `> x` / `>> x` redirect target, quotes stripped.
///
/// #299 (case 3): the Python guard's `_REDIRECT_TARGET_RX` is quote-blind, so
/// `awk '$1 >= "2026-08-28"'` reads as a shell redirect and the command is
/// denied `bash-write-no-coverage`. This scanner tracks single- and
/// double-quote state (and backslash escapes) and only reports redirects that
/// are actually unquoted. A `>` inside quotes is a comparison operator, JSON,
/// or jq syntax — never a redirect.
fn redirect_targets(command: &str) -> Vec<String> {
    let c = chars(command);
    let n = c.len();
    let mut out = Vec::new();
    let mut i = 0usize;
    let mut in_single = false;
    let mut in_double = false;
    while i < n {
        let ch = c[i];
        if in_single {
            if ch == '\'' {
                in_single = false;
            }
            i += 1;
            continue;
        }
        if in_double {
            if ch == '\\' {
                i += 2;
                continue;
            }
            if ch == '"' {
                in_double = false;
            }
            i += 1;
            continue;
        }
        match ch {
            '\'' => {
                in_single = true;
                i += 1;
            }
            '"' => {
                in_double = true;
                i += 1;
            }
            '\\' => i += 2,
            '>' => {
                let boundary_ok = at_boundary(&c, i);
                let mut j = i;
                while j < n && c[j] == '>' {
                    j += 1;
                }
                if boundary_ok {
                    let k = ws0(&c, j);
                    if k < n && c[k] != '>' && c[k] != '&' {
                        if matches!(c[k], '\'' | '"') {
                            // Quoted target: consume to the matching quote so
                            // quote state stays coherent for the remainder.
                            let q = c[k];
                            let mut e = k + 1;
                            let mut buf = String::new();
                            while e < n && c[e] != q {
                                buf.push(c[e]);
                                e += 1;
                            }
                            out.push(buf);
                            i = if e < n { e + 1 } else { e };
                            continue;
                        }
                        let mut e = k;
                        while e < n && !c[e].is_whitespace() && c[e] != '>' && c[e] != '&' {
                            e += 1;
                        }
                        let raw: String = c[k..e].iter().collect();
                        out.push(strip_matching_quotes(&raw));
                        i = e;
                        continue;
                    }
                }
                i = j;
            }
            _ => i += 1,
        }
    }
    out
}

fn strip_matching_quotes(s: &str) -> String {
    let v: Vec<char> = s.chars().collect();
    if v.len() >= 2 && v[0] == v[v.len() - 1] && matches!(v[0], '\'' | '"') {
        v[1..v.len() - 1].iter().collect()
    } else {
        s.to_string()
    }
}

fn has_redirect(command: &str) -> bool {
    !redirect_targets(command).is_empty()
}

fn is_nonrepo_redirect_target(t: &str) -> bool {
    NONREPO_REDIRECT_EXACT.contains(&t)
        || NONREPO_REDIRECT_PREFIXES.iter().any(|p| t.starts_with(p))
}

/// True iff a redirect targets somewhere other than a no-op sink or temp
/// scratch space.
fn redirect_is_write(command: &str) -> bool {
    redirect_targets(command)
        .iter()
        .any(|t| !is_nonrepo_redirect_target(t))
}

// --- inline `python -c` content test (#299 case 2) --------------------------

/// Write indicators inside an inline Python script. Deliberately conservative
/// per #299: `.write` catches `sys.stdout.write` too, and any `open(` counts,
/// so the divergence only covers scripts that plainly touch nothing.
const PY_WRITE_HINTS: &[&str] = &[
    "open(",
    ".write",
    "os.remove",
    "os.unlink",
    "os.rename",
    "os.replace",
    "os.rmdir",
    "os.mkdir",
    "os.makedirs",
    "os.system",
    "os.chmod",
    "os.chown",
    "os.truncate",
    "os.link",
    "os.symlink",
    "shutil",
    "subprocess",
    "json.dump(",
    "pickle.dump",
    "csv.writer",
    ".unlink(",
    ".mkdir(",
    ".touch(",
    ".rmdir(",
    ".rename(",
    "urllib",
    "requests.",
    "socket.",
];

/// Extract the argument that follows `-c` at `i`, honouring shell quoting.
/// None means "could not read it" — the conservative branch.
fn shell_arg_after(c: &[char], i: usize) -> Option<String> {
    let j = ws0(c, i);
    if j >= c.len() {
        return None;
    }
    if matches!(c[j], '\'' | '"') {
        let q = c[j];
        let mut e = j + 1;
        let mut buf = String::new();
        while e < c.len() {
            if q == '"' && c[e] == '\\' && e + 1 < c.len() {
                buf.push(c[e + 1]);
                e += 2;
                continue;
            }
            if c[e] == q {
                return Some(buf);
            }
            buf.push(c[e]);
            e += 1;
        }
        return None; // unterminated quote: unreadable
    }
    let mut e = j;
    let mut buf = String::new();
    while e < c.len() && !c[e].is_whitespace() {
        buf.push(c[e]);
        e += 1;
    }
    if buf.is_empty() {
        None
    } else {
        Some(buf)
    }
}

/// #299 (case 2): the Python guard treats the mere presence of `python -c` as
/// a write. Here the inline script is read: if it can be extracted and carries
/// no write indicator, the command is not a write via this pattern. When the
/// script cannot be extracted (unquoted, unterminated, built by expansion) the
/// port stays conservative and matches Python.
fn python_dash_c_writes(command: &str) -> bool {
    let c = chars(command);
    let positions = python_dash_c_positions(&c);
    if positions.is_empty() {
        return false;
    }
    for p in positions {
        match shell_arg_after(&c, p) {
            None => return true,
            Some(script) => {
                // Shell expansion means the text the guard reads is not the
                // text python runs, so the content test cannot conclude
                // anything — stay conservative and match the Python guard.
                if script.contains('$') || script.contains('`') {
                    return true;
                }
                if PY_WRITE_HINTS.iter().any(|h| script.contains(h)) {
                    return true;
                }
            }
        }
    }
    false
}

// --- forge read classification (#299 case 1) --------------------------------

/// `(gh|glab) (issue|pr|mr) (list|view|status|diff|checks)` — pure forge reads.
///
/// #299 (case 1): `gh issue list --state all --json …` was denied while
/// `gh issue view N --json …` passed. Both are reads. In the current Python
/// source neither verb is in `_GH_ISSUE_WRITE_RX` or `_FORGE_WRITE_RX`, so a
/// bare `gh issue list` is already classified read; the observed denial came
/// from the quote-blind redirect scan firing on a `--jq '… > …'` filter (case 3
/// above). This predicate makes the read classification explicit and testable
/// so a future widening of the forge verb lists cannot silently recapture it.
fn forge_read_command(command: &str) -> bool {
    let c = chars(command);
    cmd_verb(
        &c,
        &["gh", "glab"],
        Some(&["issue", "pr", "mr"]),
        &["list", "view", "status", "diff", "checks"],
    )
}

// --- bash write classifier ---------------------------------------------------

#[derive(Clone, Copy, PartialEq)]
enum SkipPattern {
    None,
    GhIssueWrite,
}

const GIT_WRITE_VERBS: &[&str] = &[
    "add",
    "commit",
    "push",
    "rm",
    "mv",
    "reset",
    "checkout",
    "restore",
    "stash",
    "am",
    "apply",
    "cherry-pick",
    "rebase",
    "revert",
    "tag",
    "branch",
];

const GH_ISSUE_WRITE_VERBS: &[&str] = &[
    "close", "reopen", "edit", "comment", "create", "delete", "transfer", "pin", "unpin", "lock",
    "unlock",
];

const FORGE_ISSUE_ONLY_VERBS: &[&str] = &["comment", "create", "edit", "close", "reopen"];

fn gh_issue_write(c: &[char]) -> bool {
    cmd_verb(c, &["gh"], Some(&["issue"]), GH_ISSUE_WRITE_VERBS)
}

// #333: quoted spans are argument DATA for shell-token classification — a
// grep pattern containing `git apply` must not classify the grep as a write.
// Interior characters of single-/double-quoted spans become spaces; the
// delimiters stay. Backslash escapes are honoured outside single quotes.
// Returns None on an unterminated quote: the caller falls back to the flat
// scan, so ambiguity degrades to over-denying, never under-denying.
//
// The interpreter trap is handled structurally, not here: `bash -c` / `sh -c`
// / `node -e` classify as writes by the FLAG, which sits outside the quotes,
// and the python/open inspectors below deliberately receive the RAW command
// because the quoted script body is exactly what they inspect.
fn mask_quoted_spans(command: &str) -> Option<String> {
    let mut out = String::with_capacity(command.len());
    let mut quote: Option<char> = None;
    let mut escaped = false;
    for ch in command.chars() {
        match quote {
            None => {
                if escaped {
                    escaped = false;
                    out.push(ch);
                } else if ch == '\\' {
                    escaped = true;
                    out.push(ch);
                } else if ch == '\'' || ch == '"' {
                    quote = Some(ch);
                    out.push(ch);
                } else {
                    out.push(ch);
                }
            }
            Some(q) => {
                if escaped {
                    escaped = false;
                    out.push(' ');
                } else if q == '"' && ch == '\\' {
                    escaped = true;
                    out.push(' ');
                } else if ch == q {
                    quote = None;
                    out.push(ch);
                } else {
                    out.push(if ch == '\n' { '\n' } else { ' ' });
                }
            }
        }
    }
    (quote.is_none() && !escaped).then_some(out)
}

// #333: every `git <write-verb>` invocation with its argument tokens, up to a
// command separator — so listing forms can be judged per invocation and a
// compound like `git tag --list && git push` still classifies as a write.
fn git_verb_segments(c: &[char]) -> Vec<(&'static str, Vec<String>)> {
    let mut out = Vec::new();
    for i in 0..c.len() {
        if !at_boundary(c, i) {
            continue;
        }
        let Some(j) = lit(c, i, "git") else { continue };
        let Some(j) = ws1(c, j) else { continue };
        for verb in GIT_WRITE_VERBS {
            let Some(k) = lit(c, j, verb) else { continue };
            if !word_end(c, k) {
                continue;
            }
            let mut args = Vec::new();
            let mut p = k;
            loop {
                while p < c.len() && matches!(c[p], ' ' | '\t') {
                    p += 1;
                }
                if p >= c.len() || matches!(c[p], ';' | '&' | '|' | '`' | '(' | ')' | '\n') {
                    break;
                }
                let start = p;
                while p < c.len()
                    && !c[p].is_whitespace()
                    && !matches!(c[p], ';' | '&' | '|' | '`' | '(' | ')')
                {
                    p += 1;
                }
                let tok: String = c[start..p].iter().collect();
                let tok = tok.trim_matches(['\'', '"']).to_string();
                if !tok.is_empty() {
                    args.push(tok);
                }
            }
            out.push((*verb, args));
            break;
        }
    }
    out
}

// #333: the enumerated read-only shapes of mutation-capable git verbs.
// Anything outside them stays a write — `git tag v1` must keep denying.
fn git_invocation_is_readonly(verb: &str, args: &[String]) -> bool {
    match verb {
        // With -l/--list, tag is a listing whatever else follows (patterns
        // are matched, never created).
        "tag" => args.iter().any(|a| a == "-l" || a == "--list"),
        // Bare `git branch` lists. Otherwise: only known listing flags, plus
        // bare pattern tokens when --list is present. NOT `-l`, which
        // historically meant create-with-reflog.
        "branch" => {
            let allowed = [
                "--list",
                "-a",
                "-r",
                "-v",
                "-vv",
                "--all",
                "--remotes",
                "--show-current",
            ];
            let has_list = args.iter().any(|a| a == "--list");
            args.iter()
                .all(|a| allowed.contains(&a.as_str()) || (has_list && !a.starts_with('-')))
        }
        "stash" => matches!(
            args.first().map(String::as_str),
            Some("list") | Some("show")
        ),
        _ => false,
    }
}

/// #333: the classifier names its evidence. `None` = not a write; `Some(tok)`
/// = a write, where `tok` is the matched token — surfaced in the deny reason
/// so a misclassification is a one-line diagnosis instead of a guessing game.
fn write_patterns_token(command: &str, skip: SkipPattern) -> Option<String> {
    // Quote-blind checks first, on the RAW command: redirects have their own
    // quote-awareness (#299 case 3), and the python/open inspectors read
    // quoted script bodies on purpose.
    if redirect_is_write(command) {
        return Some("redirect".to_string());
    }
    if python_dash_c_writes(command) {
        return Some("python -c".to_string());
    }
    let masked_owned = mask_quoted_spans(command);
    let scan: &str = masked_owned.as_deref().unwrap_or(command);
    let c = chars(scan);
    if open_write_mode(&c) {
        return Some("open(write-mode)".to_string());
    }
    if cmd_word(&c, &["tee"]) {
        return Some("tee".to_string());
    }
    if cmd_inplace(&c, "sed", "-i") {
        return Some("sed -i".to_string());
    }
    if cmd_inplace(&c, "perl", "-i") {
        return Some("perl -i".to_string());
    }
    for w in ["rm", "mv", "cp", "truncate", "install"] {
        if cmd_word(&c, &[w]) {
            return Some(w.to_string());
        }
    }
    for (verb, args) in git_verb_segments(&c) {
        if !git_invocation_is_readonly(verb, &args) {
            return Some(format!("git {}", verb));
        }
    }
    if skip != SkipPattern::GhIssueWrite && gh_issue_write(&c) {
        return Some("gh issue <write-verb>".to_string());
    }
    if cmd_flag(&c, "node", "-e") {
        return Some("node -e".to_string());
    }
    if cmd_flag(&c, "bash", "-c") {
        return Some("bash -c".to_string());
    }
    if cmd_flag(&c, "sh", "-c") {
        return Some("sh -c".to_string());
    }
    None
}

fn write_patterns_match(command: &str, skip: SkipPattern) -> bool {
    write_patterns_token(command, skip).is_some()
}

fn bash_writes(command: &str) -> bool {
    write_patterns_match(command, SkipPattern::None)
}

/// conventions.md, "Issue-only forge work with no repo diff".
fn forge_issue_only_write(command: &str) -> bool {
    let c = chars(command);
    if !cmd_verb(&c, &["gh"], Some(&["issue"]), FORGE_ISSUE_ONLY_VERBS) {
        return false;
    }
    // Any redirect at all disqualifies, regardless of target — the refusal
    // that forces "write the body file in its own step".
    if has_redirect(command) {
        return false;
    }
    !write_patterns_match(command, SkipPattern::GhIssueWrite)
}

/// Issue #176: `gh … --body @…`. `(?:^|\s|;|&&|\|\||\|)gh\s.*?--body\s+@\S`,
/// MULTILINE — ported per line because `.` never crosses a newline.
fn is_gh_body_at_antipattern(command: &str) -> bool {
    gh_body_at_match(command).is_some()
}

/// The Python deny prints `Detected: {m.group(0).strip()}`, so authority mode
/// needs the matched span, not just the boolean. `group(0)` opens at the
/// boundary token the alternation consumed — `^` (zero-width), one whitespace
/// / `;` / `|` character, or the two-character `&&` / `||` — and closes one
/// character past the `@`. `.strip()` then removes a whitespace opener but
/// leaves `;` / `|` / `&&` in place.
fn gh_body_at_match(command: &str) -> Option<String> {
    for line in command.split('\n') {
        let c = chars(line);
        for i in 0..c.len() {
            let boundary = i == 0
                || matches!(c[i - 1], ' ' | '\t' | '\r' | '\u{b}' | '\u{c}' | ';' | '|')
                || (c[i - 1] == '&' && i >= 2 && c[i - 2] == '&');
            if !boundary {
                continue;
            }
            let Some(j) = lit(&c, i, "gh") else { continue };
            if j >= c.len() || !c[j].is_whitespace() {
                continue;
            }
            for k in j..c.len() {
                let Some(m) = lit(&c, k, "--body") else {
                    continue;
                };
                let Some(m) = ws1(&c, m) else { continue };
                if m < c.len() && c[m] == '@' && m + 1 < c.len() && !c[m + 1].is_whitespace() {
                    // Leftmost start: the two-character alternatives (`&&`,
                    // `||`) begin one position earlier than the single-char
                    // ones, and re.search takes the earliest start that
                    // matches at all.
                    let start = if i == 0 {
                        0
                    } else if i >= 2 && c[i - 1] == c[i - 2] && matches!(c[i - 1], '&' | '|') {
                        i - 2
                    } else {
                        i - 1
                    };
                    let matched: String = c[start..m + 2].iter().collect();
                    return Some(matched.trim().to_string());
                }
            }
        }
    }
    None
}

// --- cross-boundary signature + SHA verification ----------------------------

const FORGE_WRITE_VERBS: &[&str] = &["create", "comment", "note", "edit", "update", "review"];

fn is_forge_write(command: &str) -> bool {
    let c = chars(command);
    if cmd_verb(
        &c,
        &["gh", "glab"],
        Some(&["issue", "pr", "mr"]),
        FORGE_WRITE_VERBS,
    ) {
        return true;
    }
    if cmd_verb(&c, &["gh"], Some(&["gist"]), &["create", "edit"])
        || cmd_verb(&c, &["glab"], Some(&["snippet"]), &["create", "update"])
    {
        return true;
    }
    let lower = command.to_ascii_lowercase();
    lower.contains("gh api")
        && (lower.contains("--method post")
            || lower.contains("--method patch")
            || lower.contains("-x post")
            || lower.contains("-x patch"))
        && (lower.contains("/comments") || lower.contains("gists/"))
}

fn forge_positional_body_file(command: &str) -> Option<String> {
    let lower = command.to_ascii_lowercase();
    let file_backed = lower.contains("gh gist edit")
        || lower.contains("gh gist create")
        || lower.contains("glab snippet create")
        || lower.contains("glab snippet update");
    if !file_backed {
        return None;
    }
    let token = command.split_whitespace().last()?.trim_matches(['\'', '"']);
    (!token.is_empty() && !token.starts_with('-')).then(|| normalize_body_file_path(token))
}

fn forge_api_body(command: &str) -> Option<String> {
    let lower = command.to_ascii_lowercase();
    let body_pos = lower.find("body=")?;
    let start = body_pos + "body=".len();
    let bytes = command.as_bytes();
    let quote = body_pos
        .checked_sub(1)
        .and_then(|i| bytes.get(i).copied())
        .filter(|b| matches!(*b, b'\'' | b'"'));
    let mut end = start;
    while end < bytes.len() {
        if quote
            .map(|q| bytes[end] == q)
            .unwrap_or(bytes[end].is_ascii_whitespace())
        {
            break;
        }
        end += 1;
    }
    Some(command[start..end].replace("\\n", "\n"))
}

/// `(?:--body-file|-F)(?:=|\s+)(value)`, with two #347 corrections to the
/// original naive positional scan:
/// - Flags are matched only OUTSIDE quoted regions and at a token boundary —
///   a `-F` inside a quoted `--title` argument is prose, not a flag (filing
///   #347 itself was denied on exactly that).
/// - `-F` in gh api carries field syntax: `-F key=@path` is file-backed and
///   the file is the part after the `@` (the prefix was previously left on
///   the path, so a readable signed body was denied as unreadable);
///   `-F key=value` with no `@` names no file and the scan continues.
// guard-no-session-urls: session URLs are private telemetry; a commit or
// forge body carrying one publishes it irreversibly, and no opt-in exists.
// The prose rule (conventions, 'No session URLs in public artifacts')
// demonstrably does not bind a session whose harness default says to append
// the trailer — every ~/budget commit on 2026-09-06 carried one despite the
// seeded rule — so this is enforcement, the cargo-fmt-at-the-gate shape.
// The matcher is deliberately narrow: the session-URL host path and the
// trailer key, case-insensitive. It is applied only to publishing-shaped
// commands (git commit, forge writes) so a grep or trace inspection that
// mentions the URL stays an ordinary read.
pub(crate) fn contains_session_url(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    lower.contains("claude.ai/code/") || lower.contains("claude-session:")
}

// A command that runs `git … commit` in any of its segments. Segment-scoped
// so `git log | grep commit` doesn't read as a commit — and even a false
// positive only matters when the same command also carries a session URL.
fn is_git_commit_command(command: &str) -> bool {
    for line in command.split(['\n', ';', '|']) {
        for sub in line.split("&&") {
            let toks: Vec<&str> = sub.split_whitespace().collect();
            if let Some(gi) = toks.iter().position(|t| *t == "git") {
                if toks[gi + 1..].iter().any(|t| *t == "commit") {
                    return true;
                }
            }
        }
    }
    false
}

// `git commit -F <path>` / `--file <path>` — the message file the guard must
// scan, since the violation rides the message, not the command line.
fn git_commit_message_file_arg(command: &str) -> Option<String> {
    let toks: Vec<&str> = command.split_whitespace().collect();
    for (i, t) in toks.iter().enumerate() {
        if (*t == "-F" || *t == "--file") && i + 1 < toks.len() {
            let v = toks[i + 1].trim_matches(|ch: char| ch == '"' || ch == '\'');
            if !v.is_empty() {
                return Some(v.to_string());
            }
        }
        if let Some(v) = t.strip_prefix("--file=") {
            return Some(
                v.trim_matches(|ch: char| ch == '"' || ch == '\'')
                    .to_string(),
            );
        }
    }
    None
}

// deny when a publishing-shaped command carries a session URL in its command
// text or in a readable message/body file. Returns ("deny", where) or
// ("skip", ""). An unreadable named file is left to the signature check's
// existing unreadable-body denial — this check never fails open on text it
// DID read.
fn session_url_verdict(command: &str, cwd: &Path) -> (&'static str, String) {
    if !is_git_commit_command(command) && !is_forge_write(command) {
        return ("skip", String::new());
    }
    if contains_session_url(command) {
        return ("deny", "command-text".to_string());
    }
    let mut paths: Vec<String> = Vec::new();
    if let Some(p) = git_commit_message_file_arg(command) {
        paths.push(p);
    }
    if let Some(p) = body_file_arg(command) {
        paths.push(p);
    }
    if let Some(p) = input_file_arg(command) {
        paths.push(p);
    }
    for p in paths {
        if p == "-" {
            continue;
        }
        let candidate = Path::new(&p);
        let text = std::fs::read_to_string(candidate)
            .or_else(|_| std::fs::read_to_string(cwd.join(candidate)));
        if let Ok(text) = text {
            if contains_session_url(&text) {
                return ("deny", p);
            }
        }
    }
    ("skip", String::new())
}

fn body_file_arg(command: &str) -> Option<String> {
    let c = chars(command);
    let mut quote: Option<char> = None;
    let mut i = 0usize;
    while i < c.len() {
        if let Some(q) = quote {
            if c[i] == q {
                quote = None;
            }
            i += 1;
            continue;
        }
        if matches!(c[i], '\'' | '"') {
            quote = Some(c[i]);
            i += 1;
            continue;
        }
        let mut matched_end: Option<usize> = None;
        for flag in ["--body-file", "-F"] {
            if !at_boundary(&c, i) {
                break;
            }
            let Some(j) = lit(&c, i, flag) else { continue };
            let k = if j < c.len() && c[j] == '=' {
                j + 1
            } else if let Some(k) = ws1(&c, j) {
                k
            } else {
                continue;
            };
            // Value runs to the matching quote when it opens with one
            // (quoted paths may contain spaces), else to whitespace.
            let mut e = k;
            if e < c.len() && matches!(c[e], '\'' | '"') {
                let q = c[e];
                e += 1;
                while e < c.len() && c[e] != q {
                    e += 1;
                }
                if e < c.len() {
                    e += 1;
                }
            } else {
                while e < c.len() && !c[e].is_whitespace() {
                    e += 1;
                }
            }
            if e > k {
                let raw: String = c[k..e].iter().collect();
                if flag == "-F" {
                    if let Some((_, value)) = raw.split_once('=') {
                        let value = strip_surrounding_quotes(value);
                        match value.strip_prefix('@') {
                            Some(path) => return Some(normalize_body_file_path(path)),
                            // Inline field, not a file: skip the value and
                            // keep scanning (a real --body-file may follow).
                            None => {
                                matched_end = Some(e);
                                break;
                            }
                        }
                    }
                }
                return Some(normalize_body_file_path(&raw));
            }
        }
        i = matched_end.unwrap_or(i + 1);
    }
    None
}

/// `--input(?:=|\s+)(\S+)` — gh api's JSON payload file. Recognized (#347) so
/// the file-backed `--input` route is signature-verified like `-F body=@`,
/// instead of falling open as no-inspectable-body while the equivalent
/// field-syntax write is checked.
fn input_file_arg(command: &str) -> Option<String> {
    if !command.to_ascii_lowercase().contains("gh api") {
        return None;
    }
    let c = chars(command);
    for i in 0..c.len() {
        let Some(j) = lit(&c, i, "--input") else {
            continue;
        };
        if !at_boundary(&c, i) {
            continue;
        }
        let k = if j < c.len() && c[j] == '=' {
            j + 1
        } else if let Some(k) = ws1(&c, j) {
            k
        } else {
            continue;
        };
        let mut e = k;
        while e < c.len() && !c[e].is_whitespace() {
            e += 1;
        }
        if e > k {
            let raw: String = c[k..e].iter().collect();
            return Some(normalize_body_file_path(&raw));
        }
    }
    None
}

/// `(?:--body|-b|--message|-m|--description)(?:=|\s+)("…"|'…'|\S+)`
fn body_literal_arg(command: &str) -> Option<String> {
    let c = chars(command);
    for i in 0..c.len() {
        for flag in ["--body", "-b", "--message", "-m", "--description"] {
            let Some(j) = lit(&c, i, flag) else { continue };
            let k = if j < c.len() && c[j] == '=' {
                j + 1
            } else if let Some(k) = ws1(&c, j) {
                k
            } else {
                continue;
            };
            if k >= c.len() {
                continue;
            }
            if c[k] == '"' {
                let mut e = k + 1;
                while e < c.len() {
                    if c[e] == '\\' && e + 1 < c.len() {
                        e += 2;
                        continue;
                    }
                    if c[e] == '"' {
                        return Some(c[k..=e].iter().collect());
                    }
                    e += 1;
                }
                // Unterminated: fall through to the \S+ arm, as the regex would.
            } else if c[k] == '\'' {
                let mut e = k + 1;
                while e < c.len() && c[e] != '\'' {
                    e += 1;
                }
                if e < c.len() {
                    return Some(c[k..=e].iter().collect());
                }
            }
            let mut e = k;
            while e < c.len() && !c[e].is_whitespace() {
                e += 1;
            }
            if e > k {
                return Some(c[k..e].iter().collect());
            }
        }
    }
    None
}

/// #331: strip exactly one pair of matching surrounding quotes, nothing else.
/// Deliberately NOT unquote_shell: its `\n` unescaping would corrupt a Windows
/// path like `C:\Users\jon\new\body.md`, turning `\new` into a newline. A
/// path token needs its bytes preserved.
fn strip_surrounding_quotes(value: &str) -> &str {
    let b = value.as_bytes();
    if b.len() >= 2 && (b[0] == b'"' || b[0] == b'\'') && b[b.len() - 1] == b[0] {
        &value[1..value.len() - 1]
    } else {
        value
    }
}

/// #331: an MSYS absolute path (`/c/Users/...`) mapped to its drive form
/// (`C:/Users/...`). Pure and platform-independent so it can be tested
/// anywhere; call sites gate on Windows, where the Bash tool is a Git Bash
/// shell and the MSYS spelling is the natural one. On POSIX `/c/...` is a
/// legitimate real path and must not be rewritten.
fn msys_drive_path(value: &str) -> Option<String> {
    let c: Vec<char> = value.chars().collect();
    if c.len() >= 2 && c[0] == '/' && c[1].is_ascii_alphabetic() && (c.len() == 2 || c[2] == '/') {
        let rest: String = c[2..].iter().collect();
        return Some(format!("{}:{}", c[1].to_ascii_uppercase(), rest));
    }
    None
}

/// #331: what body_file_arg and the positional variant hand onward. Quoted
/// paths are the idiomatic Windows spelling and were previously taken
/// verbatim — the file then never opened, and the guard blamed the signature.
fn normalize_body_file_path(raw: &str) -> String {
    let stripped = strip_surrounding_quotes(raw);
    if cfg!(windows) {
        if let Some(mapped) = msys_drive_path(stripped) {
            return mapped;
        }
    }
    stripped.to_string()
}

fn unquote_shell(value: &str) -> String {
    let v: Vec<char> = value.chars().collect();
    if v.len() >= 2 && v[0] == v[v.len() - 1] && matches!(v[0], '\'' | '"') {
        let inner: String = v[1..v.len() - 1].iter().collect();
        return inner.replace("\\\"", "\"").replace("\\n", "\n");
    }
    value.to_string()
}

/// (body_text, reason). None body means "unreadable", with reason naming why.
fn crossboundary_body(command: &str, cwd: &Path) -> (Option<String>, &'static str) {
    if let Some(path) = body_file_arg(command) {
        if path == "-" {
            return (None, "body-file-stdin");
        }
        let candidate = if Path::new(&path).is_absolute() {
            PathBuf::from(&path)
        } else {
            cwd.join(&path)
        };
        return match std::fs::read(&candidate) {
            Ok(bytes) => (
                Some(String::from_utf8_lossy(&bytes).into_owned()),
                "body-file",
            ),
            Err(_) => (None, "body-file-unreadable"),
        };
    }
    // #347: gh api --input <file> is a JSON payload; its `body` field is the
    // inspectable prose. A payload with no body field is metadata-only
    // (input-json-no-body fails open at the verdict sites); an unreadable or
    // unparseable named file is denied, per #331's named-file principle.
    if let Some(path) = input_file_arg(command) {
        if path == "-" {
            return (None, "input-file-stdin");
        }
        let candidate = if Path::new(&path).is_absolute() {
            PathBuf::from(&path)
        } else {
            cwd.join(&path)
        };
        return match std::fs::read(&candidate) {
            Ok(bytes) => match serde_json::from_slice::<serde_json::Value>(&bytes) {
                Ok(v) => match v.get("body").and_then(|b| b.as_str()) {
                    Some(b) => (Some(b.to_string()), "input-json-body"),
                    None => (None, "input-json-no-body"),
                },
                Err(_) => (None, "input-json-unparseable"),
            },
            Err(_) => (None, "input-file-unreadable"),
        };
    }
    if let Some(lit) = body_literal_arg(command) {
        return (Some(unquote_shell(&lit)), "body-literal");
    }
    if let Some(body) = forge_api_body(command) {
        return (Some(body), "api-body-field");
    }
    if let Some(path) = forge_positional_body_file(command) {
        let candidate = if Path::new(&path).is_absolute() {
            PathBuf::from(&path)
        } else {
            cwd.join(&path)
        };
        return match std::fs::read(&candidate) {
            Ok(bytes) => (
                Some(String::from_utf8_lossy(&bytes).into_owned()),
                "positional-body-file",
            ),
            Err(_) => (None, "positional-body-file-unreadable"),
        };
    }
    (None, "no-body-flag")
}

fn normalize_repo_locator(remote: &str) -> Option<String> {
    let mut value = remote.trim().trim_end_matches('/').to_string();
    if let Some(rest) = value.strip_prefix("git@") {
        let (host, path) = rest.split_once(':')?;
        value = format!("{host}/{path}");
    } else if let Some((_, rest)) = value.split_once("://") {
        value = rest.to_string();
        if let Some((_, tail)) = value.split_once('@') {
            value = tail.to_string();
        }
    } else {
        return None;
    }
    value = value
        .trim_end_matches('/')
        .trim_end_matches(".git")
        .to_string();
    let (host, path) = value.split_once('/')?;
    if host.is_empty() || path.is_empty() || !host.contains('.') {
        return None;
    }
    Some(format!("{}/{}", host.to_ascii_lowercase(), path))
}

pub(crate) fn expected_repo_locator(cwd: &Path) -> Option<String> {
    let safe_directory = format!("safe.directory={}", cwd.display());
    let output = std::process::Command::new("git")
        .args(["-c", &safe_directory, "remote", "get-url", "origin"])
        .current_dir(cwd)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    normalize_repo_locator(&String::from_utf8_lossy(&output.stdout))
}

// awaiting-cross-machine-agent-moves: the parsed agent signature, shared
// with the Awaiting You sweep in lib.rs — one grammar, two consumers. The
// standing slots after thread and model are optional and positional:
// `<os>` (added 2026-09-05, #346 legibility) then `<machine>` (the short
// hostname, added same day so two same-OS machines are distinguishable and
// the sweep can classify same-account comments exactly). Older two- and
// three-slot signatures parse with the trailing fields None.
pub(crate) struct AgentSignature<'a> {
    // The thread slot ("main thread" | "subagent") is validated by the parser
    // but not stored: no consumer reads it yet. Re-add the field when one does.
    pub(crate) model: &'a str,
    pub(crate) os: Option<&'a str>,
    pub(crate) machine: Option<&'a str>,
    // awaiting-cross-project-agent-moves: the human-familiar project name
    // ("Bram", "Budget") — display material for the Awaiting surface; the
    // locator is what identity comparisons use.
    pub(crate) project: &'a str,
    pub(crate) locator: &'a str,
}

pub(crate) fn parse_agent_signature(line: &str) -> Option<AgentSignature<'_>> {
    let line = line
        .trim()
        .trim_start_matches(|ch| matches!(ch, '_' | '*' | '>' | '#' | '-' | ' '))
        .trim_end_matches(|ch| matches!(ch, '_' | '*' | ' '));
    let (owner, rest) = line.split_once("'s ")?;
    if owner.trim().is_empty() {
        return None;
    }
    let (agent, rest) = rest.split_once(" (")?;
    if !matches!(agent, "Claude" | "Codex") {
        return None;
    }
    let (standing, rest) = rest.split_once(") speaking from the ")?;
    let mut slots = standing.split(", ");
    let thread = slots.next()?.trim();
    let model = slots.next()?.trim();
    if !matches!(thread, "main thread" | "subagent") || model.is_empty() {
        return None;
    }
    let os = slots.next().map(str::trim).filter(|s| !s.is_empty());
    let machine = slots.next().map(str::trim).filter(|s| !s.is_empty());
    let rest = rest.strip_suffix("):")?;
    let (project, locator) = rest.rsplit_once(" project (")?;
    if project.trim().is_empty() || locator.trim().is_empty() {
        return None;
    }
    Some(AgentSignature {
        model,
        os,
        machine,
        project: project.trim(),
        locator: locator.trim(),
    })
}

fn signature_line_locator(line: &str) -> Option<&str> {
    parse_agent_signature(line).map(|s| s.locator)
}

/// True iff the first non-empty line carries the full canonical signature and
/// names this checkout's normalized origin when one is discoverable.
fn body_is_signed(body: &str, cwd: &Path) -> bool {
    let expected = expected_repo_locator(cwd);
    for line in body.split('\n') {
        if line.trim().is_empty() {
            continue;
        }
        let Some(actual) = signature_line_locator(line) else {
            return false;
        };
        return expected
            .as_deref()
            .map(|want| actual.eq_ignore_ascii_case(want))
            .unwrap_or(true);
    }
    false
}

fn crossboundary_signature_verdict(command: &str, cwd: &Path) -> (&'static str, &'static str) {
    if command.is_empty() {
        return ("skip", "no-command");
    }
    if !is_forge_write(command) {
        return ("skip", "not-forge-write");
    }
    let (body, reason) = crossboundary_body(command, cwd);
    match body {
        None => ("unparsed", reason),
        Some(b) => {
            if body_is_signed(&b, cwd) {
                ("signed", reason)
            } else {
                ("unsigned", reason)
            }
        }
    }
}

/// `\b[0-9a-f]{40}\b`
fn full_shas(body: &str) -> Vec<String> {
    let c = chars(body);
    let mut out: Vec<String> = Vec::new();
    let mut i = 0usize;
    while i < c.len() {
        if !word_start(&c, i) {
            i += 1;
            continue;
        }
        let mut e = i;
        while e < c.len() && (c[e].is_ascii_digit() || matches!(c[e], 'a'..='f')) {
            e += 1;
        }
        if e - i == 40 && word_end(&c, e) {
            out.push(c[i..e].iter().collect());
        }
        i = if e > i { e } else { i + 1 };
    }
    out.sort();
    out.dedup();
    out
}

/// issue-277 B. Fails open on every unreadable shape; denies only on a positive
/// local determination that a named 40-hex string is not a commit here.
fn forge_sha_verdict(command: &str, cwd: &Path) -> (&'static str, String) {
    if command.is_empty() {
        return ("skip", "no-command".into());
    }
    if !is_forge_write(command) {
        return ("skip", "not-forge-write".into());
    }
    let (body, reason) = crossboundary_body(command, cwd);
    let Some(body) = body else {
        return ("unparsed", reason.into());
    };
    let shas = full_shas(&body);
    if shas.is_empty() {
        return ("ok", "no-full-shas".into());
    }
    for sha in &shas {
        let probe = std::process::Command::new("git")
            .arg("cat-file")
            .arg("-e")
            .arg(format!("{}^{{commit}}", sha))
            .current_dir(cwd)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
        match probe {
            Err(_) => return ("unparsed", "git-unavailable".into()),
            Ok(st) => {
                if !st.success() {
                    return ("bad", sha.clone());
                }
            }
        }
    }
    ("ok", format!("verified:{}", shas.len()))
}

// --- subagent gates ----------------------------------------------------------

fn subagent_lifecycle_verdict(
    command: &str,
    agent_id: &str,
) -> (&'static str, Option<&'static str>) {
    if !WORKLIST_LIFECYCLE_ROUTES
        .iter()
        .any(|r| command.contains(r))
    {
        return ("skip", None);
    }
    if !agent_id.trim().is_empty() {
        return ("deny", None);
    }
    ("allow", Some("no-agent-id"))
}

/// judell/bram#287. `rel` is None when the target is outside the project tree.
fn subagent_worklist_write_verdict(
    rel: Option<&str>,
    agent_id: &str,
) -> (&'static str, Option<&'static str>) {
    let is_worklist_surface = match rel {
        Some(r) => r == WORKLIST_REL || r.starts_with(WORKLIST_DRAFTS_PREFIX),
        None => false,
    };
    if is_worklist_surface {
        if !agent_id.trim().is_empty() {
            return ("deny", None);
        }
        return ("skip", Some("no-agent-id"));
    }
    ("skip", None)
}

// --- MCP surface -------------------------------------------------------------

fn mcp_is_mutation(tool_name: &str) -> bool {
    let name = tool_name.to_lowercase();
    MCP_WRITE_TOKENS.iter().any(|t| name.contains(t))
}

fn mcp_paths(tool_input: &Value) -> Vec<String> {
    let Some(obj) = tool_input.as_object() else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for key in MCP_PATH_KEYS {
        match obj.get(*key) {
            Some(Value::String(s)) if !s.is_empty() => out.push(s.clone()),
            Some(Value::Array(items)) => {
                for it in items {
                    if let Some(s) = it.as_str() {
                        if !s.is_empty() {
                            out.push(s.to_string());
                        }
                    }
                }
            }
            _ => {}
        }
    }
    out
}

// --- path helpers ------------------------------------------------------------

fn normalize_components(p: &Path) -> PathBuf {
    use std::path::Component::*;
    let mut out = PathBuf::new();
    for comp in p.components() {
        match comp {
            Prefix(_) | RootDir => out.push(comp.as_os_str()),
            CurDir => {}
            ParentDir => {
                out.pop();
            }
            Normal(s) => out.push(s),
        }
    }
    out
}

/// Lexical `os.path.abspath`: no filesystem access, relative paths resolved
/// against the process cwd exactly as the Python guard's does.
fn abspath(p: &str) -> PathBuf {
    let pb = Path::new(p);
    let joined = if pb.is_absolute() {
        pb.to_path_buf()
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(pb)
    };
    normalize_components(&joined)
}

fn abspath_of(p: &Path) -> PathBuf {
    abspath(&p.to_string_lossy())
}

fn find_project_root(start: &str) -> Option<PathBuf> {
    let mut cur = abspath(start);
    loop {
        if cur.join(AUTH_REL).exists() {
            return Some(cur);
        }
        match cur.parent() {
            Some(parent) if parent != cur => cur = parent.to_path_buf(),
            _ => return None,
        }
    }
}

fn normalize_target(project_root: &Path, target: &str) -> Option<String> {
    if target.is_empty() {
        return None;
    }
    let abs_target = abspath(target);
    let abs_root = abspath_of(project_root);
    if abs_target == abs_root {
        return Some(String::new());
    }
    let root_s = abs_root.to_string_lossy().into_owned();
    let sep = std::path::MAIN_SEPARATOR;
    let prefix = format!("{}{}", root_s, sep);
    let target_s = abs_target.to_string_lossy().into_owned();
    if target_s.starts_with(&prefix) {
        return Some(target_s[prefix.len()..].replace(sep, "/"));
    }
    None
}

/// Map a managed Claude worktree target to its real-tree path for item
/// coverage only (#309). Lifecycle classification, bypass lookup, traces, and
/// deny targets continue to use the original normalized path.
fn worktree_coverage_target(rel: &str) -> (&str, Option<&str>) {
    let Some(tail) = rel.strip_prefix(WORKTREE_PREFIX) else {
        return (rel, None);
    };
    let Some((worktree, mapped)) = tail.split_once('/') else {
        return (rel, None);
    };
    if worktree.is_empty() || mapped.is_empty() {
        return (rel, None);
    }
    (mapped, Some(worktree))
}

/// Whether `rel` is covered by a declared file/directory entry, plus the
/// managed worktree name when one was mapped. Directory matching mirrors the
/// commit gate's separator-anchored expansion from #295 and happens after the
/// #309 worktree mapping.
fn coverage_verdict<'a>(covered: &HashSet<String>, rel: &'a str) -> (bool, Option<&'a str>) {
    let (mapped, worktree) = worktree_coverage_target(rel);
    let is_covered = covered.iter().any(|declared| {
        let entry = declared.trim_end_matches('/');
        !entry.is_empty()
            && (mapped == entry
                || mapped
                    .strip_prefix(entry)
                    .map_or(false, |rest| rest.starts_with('/')))
    });
    (is_covered, worktree)
}

fn with_worktree_marker(mut verdict: ShadowVerdict, worktree: Option<&str>) -> ShadowVerdict {
    if let Some(name) = worktree {
        verdict.reason.push_str(":worktree=");
        verdict.reason.push_str(name);
    }
    verdict
}

fn is_lifecycle_path(rel: &str) -> bool {
    if rel.is_empty() {
        return false;
    }
    LIFECYCLE_PATHS_EXACT.contains(&rel)
        || LIFECYCLE_PATHS_PREFIXES.iter().any(|p| rel.starts_with(p))
}

fn is_worklist_draft(rel: &str) -> bool {
    rel.starts_with(WORKLIST_DRAFTS_PREFIX)
        && rel.ends_with(".md")
        && !rel[WORKLIST_DRAFTS_PREFIX.len()..].contains('/')
}

// --- worklist.json readers ---------------------------------------------------

/// Mirrors `items_by_id`: a single malformed item collapses the whole map to
/// empty, because the Python comprehension raises and the except swallows it.
fn items_by_id(text: &str) -> Option<Vec<(String, Value)>> {
    let doc: Value = serde_json::from_str(text).ok()?;
    let obj = doc.as_object()?;
    let items = match obj.get("items") {
        None => return Some(Vec::new()),
        Some(Value::Array(a)) => a,
        Some(_) => return None,
    };
    let mut out = Vec::new();
    for it in items {
        let o = it.as_object()?;
        let id = o.get("id")?;
        let key = match id {
            Value::String(s) => s.clone(),
            other => other.to_string(),
        };
        out.push((key, it.clone()));
    }
    Some(out)
}

fn items_map(text: &str) -> Vec<(String, Value)> {
    items_by_id(text).unwrap_or_default()
}

fn item_status(item: &Value) -> String {
    item.get("status")
        .and_then(|v| v.as_str())
        .unwrap_or("proposed")
        .to_string()
}

type StateChanges = (Vec<(String, String)>, Vec<(String, String, String)>);

fn worklist_state_changes(
    old_items: &[(String, Value)],
    new_items: &[(String, Value)],
) -> StateChanges {
    let mut removed = Vec::new();
    let mut status_changed = Vec::new();
    for (id, old_item) in old_items {
        match new_items.iter().find(|(nid, _)| nid == id) {
            None => removed.push((id.clone(), item_status(old_item))),
            Some((_, new_item)) => {
                let (o, n) = (item_status(old_item), item_status(new_item));
                if o != n {
                    status_changed.push((id.clone(), o, n));
                }
            }
        }
    }
    (removed, status_changed)
}

fn worklist_items_with_inline_prose(content: &str) -> Vec<String> {
    let Ok(doc) = serde_json::from_str::<Value>(content) else {
        return Vec::new();
    };
    let Some(items) = doc.get("items").and_then(|v| v.as_array()) else {
        return Vec::new();
    };
    let mut bad = Vec::new();
    for it in items {
        let Some(o) = it.as_object() else { continue };
        if o.get("status")
            .and_then(|v| v.as_str())
            .unwrap_or("proposed")
            != "proposed"
        {
            continue;
        }
        let nonempty = |k: &str| {
            o.get(k)
                .and_then(|v| v.as_str())
                .map(|s| !s.trim().is_empty())
                .unwrap_or(false)
        };
        if nonempty("before") || nonempty("after") {
            let label = o
                .get("id")
                .and_then(|v| v.as_str())
                .filter(|s| !s.trim().is_empty())
                .unwrap_or("<no-id>");
            bad.push(label.to_string());
        }
    }
    bad
}

fn worklist_version_from_text(text: &str) -> (bool, i64) {
    let Ok(doc) = serde_json::from_str::<Value>(text) else {
        return (false, 0);
    };
    if !doc.is_object() {
        return (false, 0);
    }
    match doc.get("version") {
        Some(Value::Number(n)) if n.is_i64() => (true, n.as_i64().unwrap_or(0)),
        _ => (false, 0),
    }
}

fn worklist_covered_files(project_root: &Path) -> HashSet<String> {
    let mut covered = HashSet::new();
    let Ok(text) = std::fs::read_to_string(project_root.join(WORKLIST_REL)) else {
        return covered;
    };
    let Ok(doc) = serde_json::from_str::<Value>(&text) else {
        return covered;
    };
    let Some(items) = doc.get("items").and_then(|v| v.as_array()) else {
        return covered;
    };
    for it in items {
        let Some(o) = it.as_object() else { continue };
        let st = o
            .get("status")
            .and_then(|v| v.as_str())
            .unwrap_or("proposed");
        if st != "proposed" && st != "applied" {
            continue;
        }
        if let Some(f) = o.get("file").and_then(|v| v.as_str()) {
            covered.insert(f.to_string());
        }
        if let Some(fs) = o.get("files").and_then(|v| v.as_array()) {
            for p in fs {
                if let Some(s) = p.as_str() {
                    covered.insert(s.to_string());
                }
            }
        }
    }
    covered
}

// --- authorization record ----------------------------------------------------

fn now_ms() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as f64)
        .unwrap_or(0.0)
}

fn num_field(rec: &serde_json::Map<String, Value>, keys: &[&str]) -> f64 {
    for k in keys {
        if let Some(v) = rec.get(*k).and_then(|v| v.as_f64()) {
            if v != 0.0 {
                return v;
            }
        }
    }
    0.0
}

// issue-352: direct-edit grants moved to their own sidecar so a gate click
// (which replaces the single-slot shared authorization file) can no longer
// destroy a live grant mid-TTL — the Budget-project incident: a Drop click
// clobbered a 20s-old grant and the just-authorized edit was denied. The
// sidecar is authoritative; the legacy shared-file location stays honored
// for one release so a grant written by an old binary survives the upgrade
// mid-window.
const DIRECT_EDIT_REL: &str = "resources/.worklist-direct-edit.json";

fn bypass_lookup_detail(project_root: &Path, path_rel: &str) -> (bool, &'static str) {
    let primary = bypass_lookup_in(&project_root.join(DIRECT_EDIT_REL), path_rel);
    if primary.0 {
        return primary;
    }
    let legacy = bypass_lookup_in(&project_root.join(AUTH_REL), path_rel);
    if legacy.0 {
        return legacy;
    }
    // Neither matched: report the more informative failure for the deny
    // message (a stale/path-not-covered beats a bare absent).
    if primary.1 != "absent" {
        primary
    } else {
        legacy
    }
}

fn bypass_lookup_in(file: &Path, path_rel: &str) -> (bool, &'static str) {
    let Ok(text) = std::fs::read_to_string(file) else {
        return (false, "absent");
    };
    let Ok(doc) = serde_json::from_str::<Value>(&text) else {
        return (false, "absent");
    };
    let Some(rec) = doc.as_object() else {
        return (false, "wrong-kind");
    };
    if rec.get("kind").and_then(|v| v.as_str()) != Some("direct-edit") {
        return (false, "wrong-kind");
    }
    let issued = num_field(rec, &["issuedAtMs", "issued_at_ms"]);
    if now_ms() - issued > BYPASS_TTL_MS {
        return (false, "stale");
    }
    let covered = rec
        .get("paths")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str())
                .any(|s| s == path_rel || s == "*")
        })
        .unwrap_or(false);
    if covered {
        (true, "ok")
    } else {
        (false, "path-not-covered")
    }
}

fn fresh_bypass(project_root: &Path, path_rel: &str) -> bool {
    bypass_lookup_detail(project_root, path_rel).0
}

type CrossRootVerdict = (
    bool,
    Option<&'static str>,
    &'static str,
    Option<&'static str>,
);

/// issue-262: consult the target project's bypass record and, only when it
/// differs, the session (cwd) project's.
fn cross_root_bypass_verdict(
    target_root: &Path,
    path_rel: &str,
    session_root: Option<&Path>,
) -> CrossRootVerdict {
    let (matched, target_detail) = bypass_lookup_detail(target_root, path_rel);
    if matched {
        return (true, Some("target"), target_detail, None);
    }
    let Some(session_root) = session_root else {
        return (false, None, target_detail, None);
    };
    if abspath_of(session_root) == abspath_of(target_root) {
        return (false, None, target_detail, None);
    }
    let (session_matched, session_detail) = bypass_lookup_detail(session_root, path_rel);
    if session_matched {
        (true, Some("session"), target_detail, Some(session_detail))
    } else {
        (false, None, target_detail, Some(session_detail))
    }
}

fn post_commit_push_grace(project_root: &Path) -> bool {
    let Ok(text) = std::fs::read_to_string(project_root.join(AUTH_REL)) else {
        return false;
    };
    let Ok(doc) = serde_json::from_str::<Value>(&text) else {
        return false;
    };
    let Some(rec) = doc.as_object() else {
        return false;
    };
    if rec.get("kind").and_then(|v| v.as_str()) != Some("approved") {
        return false;
    }
    let consumed = num_field(rec, &["consumedAtMs", "consumed_at_ms"]);
    if consumed == 0.0 {
        return false;
    }
    now_ms() - consumed <= POST_COMMIT_PUSH_GRACE_MS
}

// --- transcript / opt-out ----------------------------------------------------

fn last_user_text(transcript_path: &str) -> String {
    if transcript_path.is_empty() {
        return String::new();
    }
    // ci-retire-python-hook-checks: read LOSSILY. `read_to_string` errors on
    // invalid UTF-8, and this is untrusted input read only for opt-out phrase
    // matching — so one undecodable byte anywhere in a transcript used to
    // yield empty text, silently disabling "just do it" and denying the edit.
    // The Python guard opened it with errors="replace" for exactly this, and
    // its test_undecodable_transcript_bytes pinned it ("even a corrupt
    // transcript must not take the guard down"). #249 in mirror image: Python
    // crashed loudly, this failed quiet.
    let Ok(bytes) = std::fs::read(transcript_path) else {
        return String::new();
    };
    let text = String::from_utf8_lossy(&bytes);
    // The Python guard scans forward, parsing EVERY line to keep only the
    // last non-empty user text; on a 30 MB session that is ~10k JSON parses
    // per guard invocation, and at debug opt-level (the shipping profile)
    // the authority-mode deny measured ~3x slower than the Python guard on
    // the identical payload (1.16 s vs 0.40 s, 2026-08-29). Scanning in
    // REVERSE parses a handful of tail lines instead: the first qualifying
    // record from the end is the forward scan's last, by construction —
    // semantics unchanged, shape fixed.
    for line in text.lines().rev() {
        let Ok(m) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if m.get("type").and_then(|v| v.as_str()) != Some("user") {
            continue;
        }
        let content = m.get("message").and_then(|v| v.get("content"));
        let c = match content {
            Some(Value::String(s)) => s.clone(),
            Some(Value::Array(parts)) => parts
                .iter()
                .filter(|p| p.get("type").and_then(|v| v.as_str()) == Some("text"))
                .filter_map(|p| p.get("text").and_then(|v| v.as_str()))
                .collect::<Vec<_>>()
                .join(""),
            _ => continue,
        };
        // A trailing tool_result-only record must not clobber a real
        // message — in reverse, that means skip empties and keep looking.
        if !c.trim().is_empty() {
            return c;
        }
    }
    String::new()
}

/// `\bjust do it\b`, case-insensitive — the single documented opt-out phrase.
fn has_opt_out(msg: &str) -> bool {
    let lower = msg.to_lowercase();
    let c: Vec<char> = lower.chars().collect();
    let needle: Vec<char> = "just do it".chars().collect();
    if c.len() < needle.len() {
        return false;
    }
    for i in 0..=(c.len() - needle.len()) {
        if c[i..i + needle.len()] == needle[..]
            && word_start(&c, i)
            && word_end(&c, i + needle.len())
        {
            return true;
        }
    }
    false
}

/// issue-171: an Iterate turn's real text lives in the feedback drafts.
fn iterate_feedback_text(project_root: &Path, last_msg: &str) -> String {
    let stripped = last_msg.trim();
    let Some(rest) = stripped.strip_prefix("iterate:") else {
        return String::new();
    };
    let Ok(doc) = serde_json::from_str::<Value>(rest.trim()) else {
        return String::new();
    };
    let Some(items) = doc.get("items").and_then(|v| v.as_array()) else {
        return String::new();
    };
    let mut out: Vec<String> = Vec::new();
    for it in items {
        let Some(r) = it.get("feedbackRef").and_then(|v| v.as_str()) else {
            continue;
        };
        if r.is_empty() || r.contains('/') || r.contains('\\') || r.contains("..") {
            continue;
        }
        let path = project_root
            .join("resources")
            .join("feedback-drafts")
            .join(format!("{}.md", r));
        if let Ok(bytes) = std::fs::read(&path) {
            out.push(String::from_utf8_lossy(&bytes).into_owned());
        }
    }
    out.join("\n")
}

/// Last-chance authorization shared by every write surface (judell/bram#263).
/// Returns the last user message on a match so authority mode can compute
/// the audit-breadcrumb turn key; the shadow makes no network call, so for
/// it this remains read-only (Some = would-allow).
fn opt_out_clears(project_root: &Path, payload: &Value) -> Option<String> {
    let transcript = str_field(payload, "transcript_path");
    let last_msg = last_user_text(&transcript);
    if has_opt_out(&last_msg) {
        return Some(last_msg);
    }
    let draft = iterate_feedback_text(project_root, &last_msg);
    if !draft.is_empty() && has_opt_out(&draft) {
        return Some(last_msg);
    }
    None
}

// Stable per-turn key for the direct-edit audit breadcrumb (FNV-1a over the
// matched message; see the ShadowVerdict field for why sha256 parity with
// the Python guard is not required).
fn opt_out_turn_key(msg: &str) -> String {
    let mut hash: u64 = 0xcbf29ce484222325;
    for b in msg.as_bytes() {
        hash ^= u64::from(*b);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{:016x}", hash)
}

fn opt_out_allow(reason: &str, target: impl Into<String>, matched_msg: &str) -> ShadowVerdict {
    let mut v = allow(reason, target);
    v.audit_turn_key = Some(opt_out_turn_key(matched_msg));
    v
}

// --- payload accessors --------------------------------------------------------

fn str_field(payload: &Value, key: &str) -> String {
    payload
        .get(key)
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string()
}

fn tool_input(payload: &Value) -> Value {
    payload
        .get("tool_input")
        .cloned()
        .unwrap_or_else(|| serde_json::json!({}))
}

fn payload_cwd(payload: &Value) -> PathBuf {
    let cwd = str_field(payload, "cwd");
    if cwd.is_empty() {
        std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
    } else {
        PathBuf::from(cwd)
    }
}

fn resolve_session_root(payload: &Value) -> Option<PathBuf> {
    let cwd = payload.get("cwd").and_then(|v| v.as_str())?;
    if cwd.is_empty() {
        return None;
    }
    find_project_root(cwd)
}

// --- the pipeline -------------------------------------------------------------

/// Shadow verdict for one PreToolUse payload. `None` means this provider has no
/// ported policy.
pub fn shadow_worklist_decision(provider: &str, payload: &Value) -> Option<ShadowVerdict> {
    match provider {
        "claude-rs" => Some(claude_decision(payload)),
        "codex-rs" => Some(codex_decision(payload)),
        _ => None,
    }
}

fn claude_decision(payload: &Value) -> ShadowVerdict {
    let tool_name = str_field(payload, "tool_name");
    if tool_name == "Bash" {
        return bash_branch(payload);
    }
    if tool_name.starts_with("mcp__") {
        return mcp_branch(payload, &tool_name);
    }
    if tool_name != "Write" && tool_name != "Edit" {
        return allow("no-trace:not-write-edit", "-");
    }
    write_edit_branch(payload, &tool_name)
}

fn bash_branch(payload: &Value) -> ShadowVerdict {
    let ti = tool_input(payload);
    let command = ti
        .get("command")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let cwd = payload_cwd(payload);
    // Python's `preview = command[:200]` — the trace target on every Bash-branch
    // decision, and so the `target=` field of the transcribed header.
    let preview: String = command.chars().take(200).collect();
    let cwd_s = cwd.to_string_lossy().to_string();

    if let Some(matched) = gh_body_at_match(&command) {
        // python:1892-1909
        return deny_msg(
            "gh-body-at-antipattern",
            "-",
            "Bash",
            &preview,
            &cwd_s,
            &format!(
                "gh --body takes a literal string, not stdin or a file reference.\nUse --body-file - (stdin) or --body-file <path> instead.\nDetected: {}",
                matched
            ),
        );
    }
    let (cb_verdict, cb_detail) = crossboundary_signature_verdict(&command, &cwd);
    // #331: an unreadable named body is still denied (fail-open would defeat
    // the check), but it is a DIFFERENT failure from an unsigned body and
    // must say so — the flat "crossboundary-unsigned" cost the Windows filer
    // three turns of re-verifying a signature the guard never read.
    if cb_verdict == "unparsed"
        && !matches!(
            cb_detail,
            "body-file-stdin" | "no-body-flag" | "input-file-stdin" | "input-json-no-body"
        )
    {
        let path = body_file_arg(&command)
            .or_else(|| input_file_arg(&command))
            .or_else(|| forge_positional_body_file(&command))
            .unwrap_or_else(|| "<unresolved path>".to_string());
        return deny_msg(
            format!("crossboundary-unparsed:{}", cb_detail),
            "-",
            "Bash",
            &preview,
            &cwd_s,
            &format!(
                "The body file for this forge write could not be read, so its signature could not be verified:\n    {}\nAn unreadable named body is denied rather than silently bypassed (conventions.md, 'Signing agent-authored forge artifacts'). Check the path and retry — quoted and MSYS-style paths are accepted.",
                path
            ),
        );
    }
    if cb_verdict == "unsigned" {
        // python:1916-1934
        return deny_msg(
            "crossboundary-unsigned",
            "-",
            "Bash",
            &preview,
            &cwd_s,
            "This agent-authored forge artifact lacks the full repository-qualified signature.\nOpen the first line with:\n    <owner>'s <Agent> (<thread>, <model>, <os>, <machine>) speaking from the <Project> project (<origin-host>/<path>):\nSee conventions.md, 'Signing agent-authored forge artifacts' — every artifact, every comment, not just the first in a thread.",
        );
    }
    let (sha_verdict, sha_detail) = forge_sha_verdict(&command, &cwd);
    if sha_verdict == "bad" {
        // python:1947-1965
        return deny_msg(
            format!("forge-sha-unresolved:{}", sha_detail),
            "-",
            "Bash",
            &preview,
            &cwd_s,
            &format!(
                "The body contains a full commit SHA that does not resolve in this repository:\n    {}\nA fabricated or rebase-orphaned SHA renders as an ordinary link and 404s silently. Resolve the real hash with `git rev-parse <short-sha>` (or `git log --oneline`) and retry. See judell/bram#277.",
                sha_detail
            ),
        );
    }
    let (su_verdict, su_where) = session_url_verdict(&command, &cwd);
    if su_verdict == "deny" {
        return deny_msg(
            "no-session-url",
            "-",
            "Bash",
            &preview,
            &cwd_s,
            &format!(
                "This commit or forge write carries an agent session URL or Claude-Session \
                 trailer (found in: {}). Session links are private telemetry; publishing \
                 them is irreversible and no opt-in exists. Remove the trailer/URL and \
                 retry. See conventions.md, 'No session URLs in public artifacts'.",
                su_where
            ),
        );
    }
    let agent_id = str_field(payload, "agent_id");
    let (sl_verdict, _) = subagent_lifecycle_verdict(&command, &agent_id);
    if sl_verdict == "deny" {
        // python:2007-2025
        return deny_msg(
            "subagent-lifecycle-call",
            "-",
            "Bash",
            &preview,
            &cwd_s,
            "Worklist lifecycle calls (/__worklist/resolve, /__worklist/mutate, worklist-commit) stay in the orchestrator's own turn, after delegated subagents return. A subagent transcript cannot make them directly. See 'Delegating worklist items to subagents' in conventions.md.",
        );
    }
    if forge_issue_only_write(&command) {
        return allow("forge-issue-only", "-");
    }
    // #299 (case 1): a pure forge read is a read. Asserted explicitly here so
    // the classification is a tested property, not an accident of which verbs
    // the write regexes happen to list.
    if forge_read_command(&command) && !bash_writes(&command) {
        return allow("bash-read-only", "-");
    }
    if !bash_writes(&command) {
        let reason = if has_redirect(&command) && !redirect_is_write(&command) {
            "bash-write-nonrepo-target"
        } else {
            "bash-read-only"
        };
        return allow(reason, "-");
    }
    let Some(project_root) = find_project_root(&cwd.to_string_lossy()) else {
        return allow("unmanaged-repo", "-");
    };
    if !agent_id.trim().is_empty() {
        for raw_target in redirect_targets(&command) {
            let candidate = if Path::new(&raw_target).is_absolute() {
                PathBuf::from(&raw_target)
            } else {
                cwd.join(&raw_target)
            };
            let rel = normalize_target(&project_root, &candidate.to_string_lossy());
            let (sw, _) = subagent_worklist_write_verdict(rel.as_deref(), &agent_id);
            if sw == "deny" {
                // python:2082-2097. Note the Bash-branch trace target is the
                // command preview, not the redirect target.
                return deny_msg(
                    "subagent-worklist-write",
                    rel.unwrap_or_else(|| "-".into()),
                    "Bash",
                    &preview,
                    &cwd_s,
                    SUBAGENT_WORKLIST_WRITE_BODY,
                );
            }
        }
    }
    if command.contains(WORKLIST_DRAFTS_PREFIX) || command.contains(".worklist-intent.json") {
        return allow("bram-lifecycle-channel", "-");
    }
    let covered = worklist_covered_files(&project_root);
    if !covered.is_empty() || fresh_bypass(&project_root, "*") {
        return allow("covered-by-worklist-item", "-");
    }
    if let Some(msg) = opt_out_clears(&project_root, payload) {
        return opt_out_allow("opt-out-phrase", "-", &msg);
    }
    if push_cmd(&command) && post_commit_push_grace(&project_root) {
        return allow("post-commit-push-grace", "-");
    }
    // `deny_bash_coverage` (python:1284-1323). The root line is unconditional
    // here because this call site always passes a project_root.
    let mut body = "Bash blocked: this command writes to the filesystem or performs a sensitive side effect, and resources/worklist.json has no proposed or applied items covering active work.\n  - Propose the work in the worklist first, wait for the user's approved: payload, then retry.\n  - The user can authorize a direct edit by ending their message with \"just do it\", or by clicking the Skip worklist button.".to_string();
    body.push_str(&claude_coverage_root_line(&project_root));
    if push_cmd(&command) {
        body.push_str("\n  - This looks like a push. The user can click Push in the Commits tab; an agent push is allowed only in the 10-minute window after a gate commit (see judell/bram#283).");
    }
    // #333: name the evidence. The classifier knows which token made this a
    // write; saying so turns a misclassification report into a one-line
    // diagnosis instead of three lost turns.
    let token =
        write_patterns_token(&command, SkipPattern::None).unwrap_or_else(|| "?".to_string());
    deny_msg(
        format!(
            "bash-write-no-coverage:token={}:root={}",
            token,
            project_root.display()
        ),
        "-",
        "Bash",
        &preview,
        &cwd_s,
        &body,
    )
}

fn mcp_branch(payload: &Value, tool_name: &str) -> ShadowVerdict {
    let ti = tool_input(payload);
    let cwd = payload_cwd(payload);
    if !mcp_is_mutation(tool_name) {
        return allow("mcp-read-only", "-");
    }
    let Some(project_root) = find_project_root(&cwd.to_string_lossy()) else {
        return allow("unmanaged-repo", "-");
    };
    let cwd_s = cwd.to_string_lossy().to_string();
    let candidates = mcp_paths(&ti);
    if candidates.is_empty() {
        // issue-360: a name-classified "mutation" with no extractable path is
        // usually not a repo mutation at all (external connectors — Drive
        // create_file, Calendar create_event — carry no path key), but it can
        // also be a filesystem-shaped tool whose input key MCP_PATH_KEYS
        // doesn't know. So the default stays fail-closed, and the user's
        // explicit authorizations are consulted first instead of being
        // unreachable: the Skip worklist button's wildcard direct-edit grant,
        // then the "just do it" prose opt-out. Target carries the tool name
        // so the trace names what was released.
        if fresh_bypass(&project_root, "*") {
            return allow("mcp-no-path-bypass", tool_name);
        }
        if let Some(msg) = opt_out_clears(&project_root, payload) {
            return opt_out_allow("opt-out-phrase", tool_name, &msg);
        }
        // python:2131-2144. Python's trace target here is the empty string.
        return deny_msg(
            "mcp-unrecognized-input",
            "-",
            tool_name,
            "",
            &cwd_s,
            &format!(
                "{tool} blocked: this looks like a mutation, but the guard could not extract any file path from tool_input.\nIf this tool does not modify repository files (an external connector, for example), the user can authorize it by ending their message with \"just do it\" or clicking the Skip worklist button.\nOtherwise propose the change in resources/worklist.json first, or extend MCP_PATH_KEYS (src-tauri/src/guard_policy.rs) to recognize this tool's input shape.",
                tool = tool_name
            ),
        );
    }
    let agent_id = str_field(payload, "agent_id");
    let covered = worklist_covered_files(&project_root);
    let mut violations: Vec<String> = Vec::new();
    for target in &candidates {
        let Some(rel) = normalize_target(&project_root, target) else {
            continue;
        };
        if rel == WORKLIST_REL {
            // python:2151-2165
            let body = format!(
                "{tool} blocked: edits to {worklist} must use Write/Edit (so the guard can validate prunes, the version bump, and inline prose) or /__worklist/mutate for mechanical transitions.",
                tool = tool_name,
                worklist = WORKLIST_REL
            );
            return deny_msg(
                "mcp-worklist-write",
                rel.clone(),
                tool_name,
                &rel,
                &cwd_s,
                &body,
            );
        }
        let (sw, _) = subagent_worklist_write_verdict(Some(&rel), &agent_id);
        if sw == "deny" {
            // python:2174-2188
            return deny_msg(
                "subagent-worklist-write",
                rel.clone(),
                tool_name,
                &rel,
                &cwd_s,
                SUBAGENT_WORKLIST_WRITE_BODY,
            );
        }
        let (is_covered, _) = coverage_verdict(&covered, &rel);
        if is_lifecycle_path(&rel) || is_covered || fresh_bypass(&project_root, &rel) {
            continue;
        }
        violations.push(rel);
    }
    if let Some(first) = violations.first() {
        if let Some(msg) = opt_out_clears(&project_root, payload) {
            return opt_out_allow("opt-out-phrase", first.clone(), &msg);
        }
        // `deny_coverage(violations[0], opt_out_attempted=False, project_root=…)`
        // (python:2200). No session-root leg on this surface, and
        // `deny_coverage`'s own `_trace_hook` passes no cwd, so the header
        // carries the process cwd rather than the payload's.
        let (reason, body) = deny_coverage_parts(first, false, Some(&project_root), None, None);
        return deny_msg(
            reason.clone(),
            first.clone(),
            tool_name,
            first,
            &process_cwd(),
            &body,
        );
    }
    // Python traces the comma-joined candidate list here; the breadcrumb's
    // target field must stay whitespace-free, so the shadow writes `-`.
    allow("covered-by-worklist-item", "-")
}

fn write_edit_branch(payload: &Value, tool_name: &str) -> ShadowVerdict {
    let ti = tool_input(payload);
    let fp = ti.get("file_path").and_then(|v| v.as_str()).unwrap_or("");
    if fp.is_empty() {
        return allow("no-trace:no-file-path", "-");
    }
    let start = Path::new(fp)
        .parent()
        .map(|p| p.to_string_lossy().into_owned())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| ".".to_string());
    let Some(project_root) = find_project_root(&start) else {
        return allow("no-trace:unmanaged-repo", "-");
    };
    let Some(rel) = normalize_target(&project_root, fp) else {
        return allow("no-trace:outside-project", "-");
    };

    // Every deny below is reached through Python's `deny_*` helpers or an
    // inline `print`, none of which pass a cwd to `_trace_hook` — so the
    // header's `cwd=` is the guard process's own, not the payload's.
    let hook_cwd = process_cwd();

    let agent_id = str_field(payload, "agent_id");
    let (sw, _) = subagent_worklist_write_verdict(Some(&rel), &agent_id);
    if sw == "deny" {
        // python:2239-2256. This surface's wording carries an extra clause the
        // Bash / MCP twins do not ("-- it can widen its own item's coverage…").
        return deny_msg(
            "subagent-worklist-write",
            rel.clone(),
            tool_name,
            &rel,
            &hook_cwd,
            "Worklist proposals and claim edits (resources/worklist.json, resources/worklist-drafts/*) stay in the orchestrator's own turn. A delegated subagent cannot write them directly -- it can widen its own item's coverage, author new items, or edit claim state with no denial. See 'Delegating worklist items to subagents' in conventions.md and judell/bram#287.",
        );
    }

    if rel != WORKLIST_REL && is_lifecycle_path(&rel) {
        return allow("bram-lifecycle-channel", rel);
    }

    if rel == WORKLIST_REL {
        if !Path::new(fp).exists() {
            return allow("worklist-bootstrap", rel);
        }
        let old = match std::fs::read_to_string(fp) {
            Ok(old) => old,
            Err(err) => {
                // Python raises here; the top-level `except BaseException`
                // (python:2350-2382) traces `decision=error reason=<summary>`
                // and prints the guard-bug text. The summary is a Python
                // exception repr — its Rust twin below is the closest reading,
                // never byte-identical.
                let summary: String = format!("OSError: {}", err).chars().take(500).collect();
                let header = hook_stderr_header(
                    tool_name,
                    "",
                    &hook_cwd,
                    "error",
                    &summary.chars().take(200).collect::<String>(),
                );
                let mut v = deny("guard-error:worklist-unreadable", rel);
                v.message = format!(
                    "{}\nBlocked: the Bram worklist guard failed and denied by default.\n  - {}\n  - This is a guard bug, not a policy decision. Please report it.",
                    header, summary
                );
                return v;
            }
        };
        let new = if tool_name == "Write" {
            ti.get("content")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string()
        } else {
            let o = ti.get("old_string").and_then(|v| v.as_str()).unwrap_or("");
            let n = ti.get("new_string").and_then(|v| v.as_str()).unwrap_or("");
            let replace_all = ti
                .get("replace_all")
                .map(|v| !matches!(v, Value::Null | Value::Bool(false)))
                .unwrap_or(false);
            if replace_all {
                old.replace(o, n)
            } else {
                old.replacen(o, n, 1)
            }
        };
        let old_items = items_map(&old);
        let new_items = items_map(&new);
        let (removed, status_changed) = worklist_state_changes(&old_items, &new_items);
        if removed.is_empty() && status_changed.is_empty() {
            let inline_bad = worklist_items_with_inline_prose(&new);
            if !inline_bad.is_empty() {
                // `deny_inline_prose` (python:1388-1409)
                let mut lines = vec!["Blocked: inline `before` / `after` on proposed worklist item(s) — prose must live in resources/worklist-drafts/<id>.md.".to_string()];
                for label in &inline_bad {
                    lines.push(format!(
                        "  - item {label}: remove inline before/after; write prose to resources/worklist-drafts/{label}.md instead",
                        label = label
                    ));
                }
                lines.push("Draft file format: `# Before` section then `# After` section, both in Markdown. The server merge surfaces the draft prose alongside the metadata in worklist.json.".to_string());
                return deny_msg(
                    "worklist-inline-prose",
                    rel,
                    tool_name,
                    WORKLIST_REL,
                    &hook_cwd,
                    &lines.join("\n"),
                );
            }
            let (old_has, old_version) = worklist_version_from_text(&old);
            let (new_has, new_version) = worklist_version_from_text(&new);
            if old_has && (!new_has || new_version != old_version + 1) {
                // `deny_stale_worklist_version` (python:1342-1371)
                let detail = if new_has {
                    format!(
                        "You set version={}, but on-disk version is {}. Expected version={}.",
                        new_version,
                        old_version,
                        old_version + 1
                    )
                } else {
                    format!(
                        "Your write is missing the `version` field. On-disk version is {}; the new content must set version={}.",
                        old_version,
                        old_version + 1
                    )
                };
                let body = format!(
                    "Blocked: stale base on resources/worklist.json. {}\n  - Re-read resources/worklist.json, base your edit on the current contents, and include the bumped version field on the write. This guards against concurrent-writer races between your propose / Edit and other agents or the /__worklist/mutate route.",
                    detail
                );
                return deny_msg(
                    "stale-worklist-version",
                    rel,
                    tool_name,
                    WORKLIST_REL,
                    &hook_cwd,
                    &body,
                );
            }
            return allow("worklist-author", rel);
        }
        // `deny_mechanical_worklist_change` (python:1412-1444)
        let mut lines = vec![
            "Blocked: mechanical worklist state changes must go through `POST /__worklist/mutate`, not a direct edit to `resources/worklist.json`.".to_string(),
            "  - Direct worklist edits are for proposing items or refining their prose during iterate.".to_string(),
            "  - Use mutate for `prune` and `advance` after a verified `drop:` / `approved:` turn.".to_string(),
        ];
        if !removed.is_empty() {
            let detail = removed
                .iter()
                .map(|(id, status)| format!("\"{}\" (status={})", id, status))
                .collect::<Vec<_>>()
                .join(", ");
            lines.push(format!("  - Removed item ids: {}", detail));
        }
        if !status_changed.is_empty() {
            let detail = status_changed
                .iter()
                .map(|(id, old_status, new_status)| {
                    format!("\"{}\" ({}->{})", id, old_status, new_status)
                })
                .collect::<Vec<_>>()
                .join(", ");
            lines.push(format!("  - Status changes: {}", detail));
        }
        lines.push("  - Example: curl -4 -sS -X POST -d '{\"op\":\"prune\",\"ids\":[\"item-id\"]}' http://127.0.0.1:$(cat resources/.bram-port)/__worklist/mutate".to_string());
        return deny_msg(
            "mechanical-worklist-change",
            rel,
            tool_name,
            WORKLIST_REL,
            &hook_cwd,
            &lines.join("\n"),
        );
    }

    if is_worklist_draft(&rel) {
        return allow("worklist-draft", rel);
    }

    let covered = worklist_covered_files(&project_root);
    // Python's `deny_coverage` recomputes the worktree from the target, so the
    // coverage verdict's own copy is only consulted for the allow leg.
    let (is_covered, _worktree) = coverage_verdict(&covered, &rel);
    if is_covered {
        return allow("covered-by-worklist-item", rel);
    }
    let session_root = resolve_session_root(payload);
    let (bypass_ok, bypass_via, _target_detail, session_detail) =
        cross_root_bypass_verdict(&project_root, &rel, session_root.as_deref());
    if bypass_ok {
        let reason = if bypass_via == Some("target") {
            "fresh-bypass".to_string()
        } else {
            format!(
                "fresh-bypass:session-root={}",
                session_root
                    .as_ref()
                    .map(|p| p.display().to_string())
                    .unwrap_or_default()
            )
        };
        return allow(reason, rel);
    }
    if let Some(msg) = opt_out_clears(&project_root, payload) {
        return opt_out_allow("opt-out-phrase", rel, &msg);
    }
    // `deny_coverage` (python:2330-2337). `opt_out_attempted` is the near-miss
    // heuristic computed at the call site from the last user message.
    let last_msg = last_user_text(&str_field(payload, "transcript_path")).to_lowercase();
    let opt_out_attempted = last_msg.contains("worklist") && last_msg.contains("no");
    let (reason, body) = deny_coverage_parts(
        &rel,
        opt_out_attempted,
        Some(&project_root),
        session_root.as_deref(),
        session_detail,
    );
    deny_msg(reason, rel.clone(), tool_name, &rel, &hook_cwd, &body)
}

// =============================================================================
// Codex adapter
// =============================================================================
//
// Authoritative source: app/provider-hooks/codex-worklist-guard.py. The shared
// core above is reused wherever the two Python guards are literally the same
// code (the write-pattern scanners, the signature / SHA gates, the MCP surface,
// push-grace, draft-path shapes); everything below is where Codex genuinely
// differs. The differences, verified against the Python rather than assumed:
//
// - **No project-root walk.** `cwd` IS the root (`claude_coverage_root_line`'s
//   "anchored at cwd"), so there is no `find_project_root`, no `resolve_
//   session_root`, and no issue-262 cross-root bypass. A cwd with no
//   `resources/.worklist-authorization.json` allows unconditionally.
// - **No transcript, no prose opt-out at PreToolUse.** `has_opt_out` runs on
//   the UserPromptSubmit surface only, where the Python guard WRITES a
//   `direct-edit` record; PreToolUse then reads that record through
//   `fresh_bypass()`. The shadow never writes, so the write half is
//   deliberately not ported (see `codex_user_prompt_branch`).
// - **`apply_patch`, not Write/Edit.** Targets come out of the patch body
//   (`*** Update File:` / `+++ b/`), and the worklist-json validators work on
//   a reconstructed post-patch file.
// - **The `.worklist-intent.json` coordination channel** (#130) plus its
//   pending/stale gate, which has no Claude counterpart.
// - **`resources/worklist-citations/` is an exemption of its own** here; the
//   Claude guard folds it into `_LIFECYCLE_PATHS_PREFIXES`.
// - **No `gh issue <verb>` entry in `_BASH_WRITE_PATTERNS`,** hence no
//   `forge_issue_only_write` exemption — `gh issue close 5` is simply not a
//   write on this side.
// - **No subagent gates.** The Codex hook payload carries no agent identity
//   (the Python says so at length at both sites), so #287 has nothing to key
//   on.
// - **Reason strings are derived, not named.** Codex's `allow()` defaults to
//   `passed-checks` and its `deny()` traces `message.splitlines()[0][:120]`.
//   So the shadow builds the Python message verbatim and truncates it the same
//   way, instead of carrying the Claude guard's short named reasons.
//
// judell/bram#299 inheritance: the Codex guard carries byte-identical copies of
// `_REDIRECT_TARGET_RX` / `_REDIRECT_WRITE_RX` and of the
// `python[0-9.]*\s+-c\b` pattern, so cases 2 and 3 misclassify here exactly as
// they do on the Claude side and the shared core's fixes apply unchanged. Case 1
// is inherited as an assertion only: with no `gh` entry in this guard's write
// patterns, a pure forge read was never captured here, so `forge_read_command`
// changes no verdict on this side — it is pinned by test so a future widening
// cannot silently recapture it.

const WORKLIST_CITATIONS_PREFIX: &str = "resources/worklist-citations/";
const WORKLIST_INTENT_REL: &str = "resources/.worklist-intent.json";
const WORKLIST_RESULT_REL: &str = "resources/.worklist-result.json";
const INTENT_STALE_SECONDS: f64 = 120.0;

/// Codex `deny()`: the traced reason is the message's first line, 120 chars.
fn codex_deny_reason(message: &str) -> String {
    if message.is_empty() {
        return "blocked".to_string();
    }
    // Python `.splitlines()[0]` — our messages only ever carry `\n`, but the
    // other Python line terminators are cheap to honour.
    let first = message
        .split(|c| {
            matches!(
                c,
                '\n' | '\r' | '\u{b}' | '\u{c}' | '\u{85}' | '\u{2028}' | '\u{2029}'
            )
        })
        .next()
        .unwrap_or("");
    first.chars().take(120).collect()
}

fn codex_deny(message: &str, target: &str) -> ShadowVerdict {
    let mut v = deny(codex_deny_reason(message), target);
    // The full Python-verbatim message was always constructed here and then
    // truncated into the reason; authority mode prints it, so keep it.
    v.message = message.to_string();
    v
}

fn codex_allow(reason: &str, target: &str) -> ShadowVerdict {
    allow(reason, target)
}

/// Python `str.splitlines()` for the terminators a patch body can carry.
fn py_splitlines(s: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let bytes = s.as_bytes();
    let mut start = 0usize;
    let mut i = 0usize;
    while i < bytes.len() {
        match bytes[i] {
            b'\n' => {
                out.push(&s[start..i]);
                i += 1;
                start = i;
            }
            b'\r' => {
                out.push(&s[start..i]);
                i += if i + 1 < bytes.len() && bytes[i + 1] == b'\n' {
                    2
                } else {
                    1
                };
                start = i;
            }
            _ => i += 1,
        }
    }
    if start < s.len() {
        out.push(&s[start..]);
    }
    out
}

// --- codex path / authorization helpers --------------------------------------

/// Codex `normalize_target`: `os.path.abspath(os.path.join(cwd, target))`.
/// The join against the PROJECT cwd is the difference from the Claude core's
/// `normalize_target`, which abspaths the target against the PROCESS cwd.
fn codex_normalize_target(cwd: &Path, target: &str) -> Option<String> {
    if target.is_empty() {
        return None;
    }
    let joined = if Path::new(target).is_absolute() {
        PathBuf::from(target)
    } else {
        cwd.join(target)
    };
    let abs_target = abspath_of(&joined);
    let abs_cwd = abspath_of(cwd);
    if abs_target == abs_cwd {
        return Some(String::new());
    }
    let sep = std::path::MAIN_SEPARATOR;
    let prefix = format!("{}{}", abs_cwd.to_string_lossy(), sep);
    let t = abs_target.to_string_lossy().into_owned();
    if t.starts_with(&prefix) {
        Some(t[prefix.len()..].replace(sep, "/"))
    } else {
        None
    }
}

/// Codex `fresh_bypass`: reads ONLY snake_case `issued_at_ms` (the Claude
/// guard accepts `issuedAtMs` first), and has no per-root detail vocabulary.
/// issue-352: sidecar first, legacy shared file honored for one release —
/// the same precedence as the Claude arm's bypass_lookup_detail.
fn codex_fresh_bypass(cwd: &Path, path_rel: &str) -> bool {
    codex_fresh_bypass_in(&cwd.join(DIRECT_EDIT_REL), path_rel)
        || codex_fresh_bypass_in(&cwd.join(AUTH_REL), path_rel)
}

fn codex_fresh_bypass_in(file: &Path, path_rel: &str) -> bool {
    let Ok(text) = std::fs::read_to_string(file) else {
        return false;
    };
    let Ok(doc) = serde_json::from_str::<Value>(&text) else {
        return false;
    };
    let Some(rec) = doc.as_object() else {
        return false;
    };
    if rec.get("kind").and_then(|v| v.as_str()) != Some("direct-edit") {
        return false;
    }
    let issued = rec
        .get("issued_at_ms")
        .and_then(|v| v.as_f64())
        .unwrap_or(0.0);
    if now_ms() - issued > BYPASS_TTL_MS {
        return false;
    }
    rec.get("paths")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str())
                .any(|s| s == path_rel || s == "*")
        })
        .unwrap_or(false)
}

fn is_worklist_citation(rel: &str) -> bool {
    rel.starts_with(WORKLIST_CITATIONS_PREFIX)
        && rel.ends_with(".json")
        && !rel[WORKLIST_CITATIONS_PREFIX.len()..].contains('/')
}

fn is_coordination_file(rel: &str) -> bool {
    rel == WORKLIST_INTENT_REL || rel == WORKLIST_RESULT_REL
}

fn current_worklist_text(cwd: &Path) -> String {
    // Lossy for the same reason as last_user_text: an undecodable byte would
    // otherwise read as an empty worklist, i.e. no coverage for any path, and
    // deny every edit with a misleading reason. Our own file, so likelier to
    // carry an em-dash than a corrupt byte — but the failure mode is the same.
    std::fs::read(cwd.join(WORKLIST_REL))
        .map(|b| String::from_utf8_lossy(&b).into_owned())
        .unwrap_or_default()
}

/// Codex `worklist_items` — the raw item array, for `_patch_removes_worklist_items`.
fn codex_worklist_items(cwd: &Path) -> Vec<Value> {
    let Ok(doc) = serde_json::from_str::<Value>(&current_worklist_text(cwd)) else {
        return Vec::new();
    };
    let Some(obj) = doc.as_object() else {
        return Vec::new();
    };
    match obj.get("items") {
        Some(Value::Array(a)) => a.clone(),
        _ => Vec::new(),
    }
}

/// Codex `items_by_id_from_content`: skips non-dict items and non-string /
/// blank ids instead of collapsing the whole map (the Claude `items_by_id`
/// comprehension raises on a missing `id` and the except returns `{}`).
fn codex_items_by_id(content: &str) -> Vec<(String, Value)> {
    let Ok(doc) = serde_json::from_str::<Value>(content) else {
        return Vec::new();
    };
    let Some(items) = doc.get("items").and_then(|v| v.as_array()) else {
        return Vec::new();
    };
    let mut out: Vec<(String, Value)> = Vec::new();
    for it in items {
        let Some(o) = it.as_object() else { continue };
        let Some(id) = o.get("id").and_then(|v| v.as_str()) else {
            continue;
        };
        if id.trim().is_empty() {
            continue;
        }
        // Python dict semantics: a repeated id keeps the last item.
        match out.iter_mut().find(|(k, _)| k == id) {
            Some(slot) => slot.1 = it.clone(),
            None => out.push((id.to_string(), it.clone())),
        }
    }
    out
}

/// Codex `bash_writes`: identical to the Claude core minus the
/// `gh issue <write-verb>` pattern, which this guard's
/// `_BASH_WRITE_PATTERNS` does not carry at all.
fn codex_bash_writes(command: &str) -> bool {
    write_patterns_match(command, SkipPattern::GhIssueWrite)
}

// --- pending-intent gate (#130, no Claude counterpart) -----------------------

#[derive(Debug, Clone, PartialEq)]
enum IntentDetail {
    NoPending,
    StaleOverwrite,
    Pending {
        nonce: Option<String>,
        route: Option<String>,
        age_seconds: i64,
    },
}

fn intent_write_verdict(cwd: &Path) -> (&'static str, IntentDetail) {
    let path = cwd.join(WORKLIST_INTENT_REL);
    let Ok(meta) = std::fs::metadata(&path) else {
        return ("allow", IntentDetail::NoPending);
    };
    let Ok(modified) = meta.modified() else {
        return ("allow", IntentDetail::NoPending);
    };
    let mtime_ms = modified
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as f64)
        .unwrap_or(0.0);
    let age_seconds = (now_ms() - mtime_ms) / 1000.0;
    if age_seconds > INTENT_STALE_SECONDS {
        return ("allow", IntentDetail::StaleOverwrite);
    }
    let doc = std::fs::read_to_string(&path)
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok());
    let field = |k: &str| {
        doc.as_ref()
            .and_then(|d| d.as_object())
            .and_then(|o| o.get(k))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
    };
    (
        "deny",
        IntentDetail::Pending {
            nonce: field("nonce"),
            route: field("route"),
            // Python `int(age_seconds)` truncates toward zero.
            age_seconds: age_seconds as i64,
        },
    )
}

fn opt_str(v: &Option<String>) -> String {
    match v {
        Some(s) => s.clone(),
        None => "None".to_string(),
    }
}

fn intent_pending_message(tool_label: &str, detail: &IntentDetail) -> String {
    let (nonce, route, age) = match detail {
        IntentDetail::Pending {
            nonce,
            route,
            age_seconds,
        } => (opt_str(nonce), opt_str(route), *age_seconds),
        _ => ("None".to_string(), "None".to_string(), 0),
    };
    format!(
        "{tool} blocked: resources/.worklist-intent.json already holds a pending \
request (route={route}, nonce={nonce}, age={age}s) that has not drained yet. \
Wait for resources/.worklist-result.json to appear, or retry once the prior \
request clears.",
        tool = tool_label,
        route = route,
        nonce = nonce,
        age = age
    )
}

// --- codex patch parsing ------------------------------------------------------

/// Concatenation of the string-valued `input` / `patch` / `content` / `command`
/// keys, each prefixed with a newline (Codex `patch_text`).
fn patch_text(tool_input: &Value) -> String {
    if let Some(s) = tool_input.as_str() {
        return s.to_string();
    }
    let Some(obj) = tool_input.as_object() else {
        return String::new();
    };
    let mut text = String::new();
    for key in ["input", "patch", "content", "command"] {
        if let Some(v) = obj.get(key).and_then(|v| v.as_str()) {
            text.push('\n');
            text.push_str(v);
        }
    }
    text
}

/// `^\*\*\* (?:Update|Add|Delete) File: (.+?)\s*$` plus the `^\+\+\+ b/(.+?)\s*$`
/// unified-diff fallback. Python collects these into a SET; the shadow keeps
/// first-seen order so the violation list (and therefore the deny message the
/// reason is cut from) is deterministic.
fn patch_targets(tool_input: &Value) -> Vec<String> {
    fn push(out: &mut Vec<String>, v: &str) {
        // `(.+?)\s*$`: trailing whitespace is not part of the path. A
        // whitespace-only remainder yields no target here where Python's lazy
        // `.+?` would capture one space; no real patch produces that shape.
        let trimmed = v.trim_end();
        if !trimmed.is_empty() && !out.iter().any(|e| e == trimmed) {
            out.push(trimmed.to_string());
        }
    }
    let text = patch_text(tool_input);
    let mut out: Vec<String> = Vec::new();
    for line in py_splitlines(&text) {
        for head in ["*** Update File: ", "*** Add File: ", "*** Delete File: "] {
            if let Some(rest) = line.strip_prefix(head) {
                push(&mut out, rest);
            }
        }
        if let Some(rest) = line.strip_prefix("+++ b/") {
            push(&mut out, rest);
        }
    }
    out
}

fn added_block_text(patch: &str) -> String {
    patch
        .split('\n')
        .filter(|l| l.starts_with('+') && !l.starts_with("+++"))
        .map(|l| &l[1..])
        .collect::<Vec<_>>()
        .join("\n")
}

fn removed_block_text(patch: &str) -> String {
    patch
        .split('\n')
        .filter(|l| l.starts_with('-') && !l.starts_with("---"))
        .map(|l| &l[1..])
        .collect::<Vec<_>>()
        .join("\n")
}

/// Codex `_worklist_content_after_apply_patch`: a best-effort interpreter for
/// `*** Update File: resources/worklist.json` hunks. None means "too unusual to
/// apply confidently", which routes the caller to the patch-text heuristics.
fn worklist_content_after_apply_patch(cwd: &Path, patch: &str) -> Option<String> {
    let old_content = current_worklist_text(cwd);
    if old_content.is_empty() {
        return None;
    }
    let lines = py_splitlines(patch);
    let header = format!("*** Update File: {}", WORKLIST_REL);
    let mut content = old_content;
    let mut saw_worklist_update = false;
    let mut i = 0usize;
    while i < lines.len() {
        if lines[i] != header {
            i += 1;
            continue;
        }
        saw_worklist_update = true;
        i += 1;
        while i < lines.len() {
            let line = lines[i];
            if line.starts_with("*** ") && line != "*** End of File" {
                break;
            }
            if !line.starts_with("@@") {
                i += 1;
                continue;
            }
            i += 1;
            let mut old_parts: Vec<&str> = Vec::new();
            let mut new_parts: Vec<&str> = Vec::new();
            while i < lines.len() {
                let hline = lines[i];
                if hline.starts_with("@@") || hline.starts_with("*** ") {
                    break;
                }
                if let Some(rest) = hline.strip_prefix(' ') {
                    old_parts.push(rest);
                    new_parts.push(rest);
                } else if let Some(rest) = hline.strip_prefix('-') {
                    old_parts.push(rest);
                } else if let Some(rest) = hline.strip_prefix('+') {
                    new_parts.push(rest);
                } else {
                    return None;
                }
                i += 1;
            }
            let old_text = old_parts.join("\n");
            let new_text = new_parts.join("\n");
            if !old_text.is_empty() {
                if !content.contains(&old_text) {
                    return None;
                }
                content = content.replacen(&old_text, &new_text, 1);
            } else if !new_text.is_empty() {
                return None;
            }
        }
    }
    if saw_worklist_update {
        Some(content)
    } else {
        None
    }
}

// --- codex worklist validators -----------------------------------------------

/// `"<key>"\s*:\s*"([^"]*)"` over a text blob. `require_nonempty` selects the
/// `[^"]+` form `_ID_RE` uses.
fn json_key_string_values(text: &str, key: &str, require_nonempty: bool) -> Vec<String> {
    let c = chars(text);
    let needle = format!("\"{}\"", key);
    let mut out = Vec::new();
    let mut i = 0usize;
    while i < c.len() {
        let Some(j) = lit(&c, i, &needle) else {
            i += 1;
            continue;
        };
        let j = ws0(&c, j);
        if j >= c.len() || c[j] != ':' {
            i += 1;
            continue;
        }
        let j = ws0(&c, j + 1);
        if j >= c.len() || c[j] != '"' {
            i += 1;
            continue;
        }
        let mut e = j + 1;
        while e < c.len() && c[e] != '"' {
            e += 1;
        }
        if e >= c.len() || (require_nonempty && e == j + 1) {
            i += 1;
            continue;
        }
        out.push(c[j + 1..e].iter().collect::<String>());
        i = e + 1;
    }
    out
}

/// `"files"\s*:\s*\[\s*"` — the files-array opener `_patch_adds_violating_
/// draft_only` counts alongside the `"file"` hits.
fn files_array_opener_count(text: &str) -> usize {
    let c = chars(text);
    let mut n = 0usize;
    let mut i = 0usize;
    while i < c.len() {
        let Some(j) = lit(&c, i, "\"files\"") else {
            i += 1;
            continue;
        };
        let j = ws0(&c, j);
        if j >= c.len() || c[j] != ':' {
            i += 1;
            continue;
        }
        let j = ws0(&c, j + 1);
        if j >= c.len() || c[j] != '[' {
            i += 1;
            continue;
        }
        let j = ws0(&c, j + 1);
        if j >= c.len() || c[j] != '"' {
            i += 1;
            continue;
        }
        n += 1;
        i = j + 1;
    }
    n
}

fn item_has_file(o: &serde_json::Map<String, Value>) -> bool {
    if let Some(f) = o.get("file").and_then(|v| v.as_str()) {
        if !f.trim().is_empty() {
            return true;
        }
    }
    if let Some(fs) = o.get("files").and_then(|v| v.as_array()) {
        for e in fs {
            if let Some(s) = e.as_str() {
                if !s.trim().is_empty() {
                    return true;
                }
            }
        }
    }
    false
}

type DraftViolations = Vec<(String, Vec<String>)>;

/// Codex `_worklist_items_violating_draft_only`. Wider than the Claude guard's
/// `worklist_items_with_inline_prose`: missing `id` and missing `file`/`files`
/// are violations here too. None means the content did not parse as JSON, which
/// the Python callers treat as falsy (no deny).
fn worklist_items_violating_draft_only(content: &str) -> Option<DraftViolations> {
    let doc: Value = serde_json::from_str(content).ok()?;
    let Some(items) = doc.get("items").and_then(|v| v.as_array()) else {
        return Some(Vec::new());
    };
    let mut bad: DraftViolations = Vec::new();
    for it in items {
        let Some(o) = it.as_object() else { continue };
        if o.get("status")
            .and_then(|v| v.as_str())
            .unwrap_or("proposed")
            != "proposed"
        {
            continue;
        }
        let mut violations: Vec<String> = Vec::new();
        let item_id = o.get("id").and_then(|v| v.as_str()).unwrap_or("");
        if item_id.trim().is_empty() {
            violations.push("id".to_string());
        }
        if !item_has_file(o) {
            violations.push("file (or non-empty files array)".to_string());
        }
        let nonempty = |k: &str| {
            o.get(k)
                .and_then(|v| v.as_str())
                .map(|s| !s.trim().is_empty())
                .unwrap_or(false)
        };
        if nonempty("before") {
            violations
                .push("inline `before` (move to resources/worklist-drafts/<id>.md)".to_string());
        }
        if nonempty("after") {
            violations
                .push("inline `after` (move to resources/worklist-drafts/<id>.md)".to_string());
        }
        if !violations.is_empty() {
            let label = if item_id.trim().is_empty() {
                "<no-id>"
            } else {
                item_id
            };
            bad.push((label.to_string(), violations));
        }
    }
    Some(bad)
}

/// Codex `_patch_adds_violating_draft_only`: the same rule applied to a patch's
/// added lines, for the case where the post-patch file could not be rebuilt.
fn patch_adds_violating_draft_only(patch: &str) -> DraftViolations {
    let added = added_block_text(patch);
    let ids: Vec<String> = json_key_string_values(&added, "id", true)
        .into_iter()
        .filter(|v| !v.trim().is_empty())
        .collect();
    let file_hits = json_key_string_values(&added, "file", false)
        .into_iter()
        .filter(|v| !v.trim().is_empty())
        .count();
    let files = file_hits + files_array_opener_count(&added);
    let befores = json_key_string_values(&added, "before", false)
        .into_iter()
        .filter(|v| !v.trim().is_empty())
        .count();
    let afters = json_key_string_values(&added, "after", false)
        .into_iter()
        .filter(|v| !v.trim().is_empty())
        .count();
    let item_count = ids.len().max(files);
    let mut violations: Vec<String> = Vec::new();
    if item_count > 0 {
        if ids.len() < item_count {
            violations.push(format!("id (saw {} of {})", ids.len(), item_count));
        }
        if files < item_count {
            violations.push(format!("file or files (saw {} of {})", files, item_count));
        }
    }
    if befores > 0 {
        violations.push(format!(
            "inline `before` (move to resources/worklist-drafts/<id>.md; saw {})",
            befores
        ));
    }
    if afters > 0 {
        violations.push(format!(
            "inline `after` (move to resources/worklist-drafts/<id>.md; saw {})",
            afters
        ));
    }
    if violations.is_empty() {
        return Vec::new();
    }
    let label = ids
        .first()
        .cloned()
        .unwrap_or_else(|| "<missing-id>".into());
    vec![(label, violations)]
}

/// Codex `_patch_removes_worklist_items`.
fn patch_removes_worklist_items(cwd: &Path, patch: &str) -> Vec<(String, String)> {
    let mut old_items: Vec<(String, Value)> = Vec::new();
    for item in codex_worklist_items(cwd) {
        if let Some(id) = item.get("id").and_then(|v| v.as_str()) {
            let id = id.to_string();
            match old_items.iter_mut().find(|(k, _)| *k == id) {
                Some(slot) => slot.1 = item.clone(),
                None => old_items.push((id, item.clone())),
            }
        }
    }
    let removed_ids = json_key_string_values(&removed_block_text(patch), "id", true);
    let readded_ids = json_key_string_values(&added_block_text(patch), "id", true);
    let mut ids: Vec<String> = removed_ids
        .into_iter()
        .filter(|id| !id.is_empty() && !readded_ids.contains(id))
        .collect();
    ids.sort();
    ids.dedup();
    let mut out = Vec::new();
    for id in ids {
        if let Some((_, item)) = old_items.iter().find(|(k, _)| *k == id) {
            out.push((id, item_status(item)));
        }
    }
    out
}

/// Codex `_worklist_new_content_from_tool_input` (the MCP surface).
fn worklist_new_content_from_tool_input(cwd: &Path, tool_input: &Value) -> Option<String> {
    let old_content = current_worklist_text(cwd);
    let obj = tool_input.as_object()?;
    for key in ["content", "text"] {
        if let Some(v) = obj.get(key).and_then(|v| v.as_str()) {
            return Some(v.to_string());
        }
    }
    if let Some(edits) = obj.get("edits").and_then(|v| v.as_array()) {
        let mut new_content = old_content;
        for edit in edits {
            let e = edit.as_object()?;
            let old_text = e.get("oldText").and_then(|v| v.as_str())?;
            let new_text = e.get("newText").and_then(|v| v.as_str())?;
            new_content = new_content.replacen(old_text, new_text, 1);
        }
        return Some(new_content);
    }
    let old_text = obj.get("old_string").and_then(|v| v.as_str());
    let new_text = obj.get("new_string").and_then(|v| v.as_str());
    if let (Some(o), Some(n)) = (old_text, new_text) {
        return Some(old_content.replacen(o, n, 1));
    }
    None
}

// --- codex deny messages (verbatim; the reason is cut from line 1) ------------

fn coverage_root_line(cwd: &Path) -> String {
    format!(
        "\nresolved_project_root={} (marker: {}, anchored at cwd)",
        abspath_of(cwd).display(),
        AUTH_REL
    )
}

fn worklist_validation_error(bad: &DraftViolations, tool_name: &str) -> String {
    if bad.is_empty() {
        return format!("{} blocked: worklist validation failed.", tool_name);
    }
    let detail = bad
        .iter()
        .map(|(label, v)| format!("  - item {}: {}", label, v.join(", ")))
        .collect::<Vec<_>>()
        .join("\n");
    format!(
        "{tool} blocked: proposed worklist item(s) violate draft-only rule.\n{detail}\n\
Required for every proposed item: \"id\" (kebab-case identifier) and \"file\" \
(or \"files\" array for multi-file items). Prose must live in \
resources/worklist-drafts/<id>.md (Markdown with `# Before` and `# After` \
sections); inline \"before\"/\"after\" keys in worklist.json are rejected. \
Write the draft file first, then add the metadata-only item to worklist.json.",
        tool = tool_name,
        detail = detail
    )
}

fn mechanical_worklist_change_error(
    removed: &[(String, String)],
    status_changed: &[(String, String, String)],
    tool_name: &str,
) -> String {
    let mut lines = vec![
        format!(
            "{} blocked: mechanical worklist state changes must go through \
`POST /__worklist/mutate`, not a direct edit to `resources/worklist.json`.",
            tool_name
        ),
        "Direct worklist edits are for proposing items or refining prose during iterate."
            .to_string(),
        "Use mutate for `prune` and `advance` after a verified `drop:` / `approved:` turn."
            .to_string(),
    ];
    if !removed.is_empty() {
        let detail = removed
            .iter()
            .map(|(id, st)| format!("\"{}\" (status={})", id, st))
            .collect::<Vec<_>>()
            .join(", ");
        lines.push(format!("Removed item ids: {}", detail));
    }
    if !status_changed.is_empty() {
        let detail = status_changed
            .iter()
            .map(|(id, o, n)| format!("\"{}\" ({}->{})", id, o, n))
            .collect::<Vec<_>>()
            .join(", ");
        lines.push(format!("Status changes: {}", detail));
    }
    lines.push(
        "Example: curl -4 -sS -X POST -d \
'{\"op\":\"advance\",\"ids\":[\"item-id\"],\"status\":\"applied\"}' \
http://127.0.0.1:$(cat resources/.bram-port)/__worklist/mutate"
            .to_string(),
    );
    lines.join("\n")
}

fn stale_worklist_version_error(
    old_version: i64,
    new_version: i64,
    new_present: bool,
    tool_name: &str,
) -> String {
    let detail = if new_present {
        format!(
            "You set version={}, but on-disk version is {}. Expected version={}.",
            new_version,
            old_version,
            old_version + 1
        )
    } else {
        format!(
            "Your write is missing the `version` field. On-disk version is {}; \
the new content must set version={}.",
            old_version,
            old_version + 1
        )
    };
    format!(
        "{} blocked: stale base on resources/worklist.json. {} Re-read the file, \
base your edit on the current contents, and include the bumped version field. \
This guards against concurrent-writer races between your propose / apply_patch \
and other agents or the /__worklist/mutate route.",
        tool_name, detail
    )
}

// --- UserPromptSubmit --------------------------------------------------------

/// `_CHANGE_KEYWORDS`, expanded. The Python regex is one `\b(a|b|...)\b`
/// alternation, so a per-alternative `\b<literal>\b` scan is equivalent.
const CHANGE_KEYWORDS: &[&str] = &[
    "fix",
    "fixes",
    "fixed",
    "fixing",
    "add",
    "adds",
    "added",
    "adding",
    "change",
    "changes",
    "changed",
    "changing",
    "update",
    "updates",
    "updated",
    "updating",
    "modify",
    "modifies",
    "modified",
    "modifying",
    "implement",
    "implements",
    "implemented",
    "implementing",
    "create",
    "creates",
    "created",
    "creating",
    "build",
    "builds",
    "building",
    "buildt",
    "rewrite",
    "rewrites",
    "rewriting",
    "refactor",
    "refactors",
    "refactored",
    "refactoring",
    "edit",
    "edits",
    "edited",
    "editing",
    "delete",
    "deletes",
    "deleted",
    "deleting",
    "remove",
    "removes",
    "removed",
    "removing",
    "rename",
    "renames",
    "renamed",
    "renaming",
    "patch",
    "patches",
    "patched",
    "patching",
    "improve",
    "improves",
    "improved",
    "improving",
    "convert",
    "converts",
    "converted",
    "converting",
    "migrate",
    "migrates",
    "migrated",
    "migrating",
    "extend",
    "extends",
    "extended",
    "extending",
    "integrate",
    "integrates",
    "integrated",
    "integrating",
    "replace",
    "replaces",
    "replaced",
    "replacing",
    "tweak",
    "tweaks",
    "tweaked",
    "tweaking",
    "adjust",
    "adjusts",
    "adjusted",
    "adjusting",
    "broken",
    "missing",
    "wrong",
    "lets",
    "let's",
    "please",
    "i want",
    "id like",
    "i'd like",
    "can you",
    "could you",
    "make it",
    "make the",
    "make a",
    "make an",
    "should be",
    "should have",
    "should use",
];

fn looks_like_change_request(prompt: &str) -> bool {
    if prompt.trim().chars().count() < 30 {
        return false;
    }
    let lower = prompt.to_lowercase();
    let c: Vec<char> = lower.chars().collect();
    for i in 0..c.len() {
        if !word_start(&c, i) {
            continue;
        }
        for kw in CHANGE_KEYWORDS {
            if let Some(e) = lit(&c, i, kw) {
                if word_end(&c, e) {
                    return true;
                }
            }
        }
    }
    false
}

// --- the codex pipeline -------------------------------------------------------

fn codex_decision(payload: &Value) -> ShadowVerdict {
    let cwd = payload_cwd(payload);
    let event = str_field(payload, "hook_event_name");

    if event == "UserPromptSubmit" {
        return codex_user_prompt_branch(payload, &cwd);
    }

    // PreToolUse path: the managed-repo marker is required, and unlike the
    // Claude guard there is no walk — cwd is the root or nothing is.
    if !cwd.join(AUTH_REL).exists() {
        return codex_allow("passed-checks", "-");
    }

    let tool_name = str_field(payload, "tool_name");
    let ti = tool_input(payload);
    let covered = worklist_covered_files(&cwd);

    if tool_name == "apply_patch" {
        return codex_apply_patch_branch(&cwd, &ti, &covered);
    }
    if tool_name == "Bash" {
        return codex_bash_branch(&cwd, &ti, &covered);
    }
    if tool_name.starts_with("mcp__") {
        return codex_mcp_branch(&cwd, &tool_name, &ti, &covered);
    }
    codex_allow("passed-checks", "-")
}

/// The Python guard WRITES a `direct-edit` authorization record on the opt-out
/// path (`write_direct_edit_record`). The shadow is read-only by contract, so
/// only the decision is reproduced; the record is deliberately not written and
/// the reason is unchanged either way (`passed-checks`). The reminder-injection
/// ending emits no `[worklist-guard]` line at all, so it records here with the
/// `no-trace:` prefix the Claude port uses for the same situation.
fn codex_user_prompt_branch(payload: &Value, cwd: &Path) -> ShadowVerdict {
    if !cwd.join(AUTH_REL).exists() {
        return codex_allow("passed-checks", "-");
    }
    let prompt = str_field(payload, "prompt");
    if has_opt_out(&prompt) {
        return codex_allow("passed-checks", "-");
    }
    if !looks_like_change_request(&prompt) {
        return codex_allow("passed-checks", "-");
    }
    codex_allow("no-trace:gate-reminder", "-")
}

/// Best-effort trace target, mirroring `_HOOK_CTX["target"]`. The breadcrumb's
/// target field must stay whitespace-free, so a path with a space writes `-`.
fn codex_target(rel: &str) -> String {
    if rel.is_empty() || rel.chars().any(|c| c.is_whitespace()) {
        "-".to_string()
    } else {
        rel.to_string()
    }
}

fn codex_apply_patch_branch(
    cwd: &Path,
    tool_input: &Value,
    covered: &HashSet<String>,
) -> ShadowVerdict {
    let raw_targets = patch_targets(tool_input);
    let trace_target = raw_targets
        .first()
        .map(|t| codex_normalize_target(cwd, t).unwrap_or_else(|| t.clone()))
        .map(|t| codex_target(&t))
        .unwrap_or_else(|| "-".to_string());

    if raw_targets.is_empty() {
        return codex_deny(
            "apply_patch blocked: could not parse target file(s) from the patch \
payload. Propose the change in resources/worklist.json first so the guard can \
verify coverage.",
            "-",
        );
    }

    let touches_worklist = raw_targets
        .iter()
        .any(|t| codex_normalize_target(cwd, t).as_deref() == Some(WORKLIST_REL));
    if touches_worklist {
        let patch_body = patch_text(tool_input);
        match worklist_content_after_apply_patch(cwd, &patch_body) {
            Some(new_content) => {
                if let Some(bad) = worklist_items_violating_draft_only(&new_content) {
                    if !bad.is_empty() {
                        return codex_deny(
                            &worklist_validation_error(&bad, "apply_patch"),
                            &trace_target,
                        );
                    }
                }
                let old_text = current_worklist_text(cwd);
                let (removed, status_changed) = worklist_state_changes(
                    &codex_items_by_id(&old_text),
                    &codex_items_by_id(&new_content),
                );
                if !removed.is_empty() || !status_changed.is_empty() {
                    return codex_deny(
                        &mechanical_worklist_change_error(&removed, &status_changed, "apply_patch"),
                        &trace_target,
                    );
                }
                let (old_has, old_version) = worklist_version_from_text(&old_text);
                let (new_has, new_version) = worklist_version_from_text(&new_content);
                if old_has && (!new_has || new_version != old_version + 1) {
                    return codex_deny(
                        &stale_worklist_version_error(
                            old_version,
                            new_version,
                            new_has,
                            "apply_patch",
                        ),
                        &trace_target,
                    );
                }
            }
            None => {
                let removed = patch_removes_worklist_items(cwd, &patch_body);
                if !removed.is_empty() {
                    return codex_deny(
                        &mechanical_worklist_change_error(&removed, &[], "apply_patch"),
                        &trace_target,
                    );
                }
                let bad = patch_adds_violating_draft_only(&patch_body);
                if !bad.is_empty() {
                    return codex_deny(
                        &worklist_validation_error(&bad, "apply_patch"),
                        &trace_target,
                    );
                }
            }
        }
    }

    let mut violations: Vec<String> = Vec::new();
    let mut denied_worktree: Option<String> = None;
    for t in &raw_targets {
        let Some(rel) = codex_normalize_target(cwd, t) else {
            continue; // outside the project tree
        };
        if rel == WORKLIST_REL || is_worklist_draft(&rel) || is_worklist_citation(&rel) {
            continue;
        }
        if rel == WORKLIST_RESULT_REL {
            continue;
        }
        if rel == WORKLIST_INTENT_REL {
            let (verdict, detail) = intent_write_verdict(cwd);
            if verdict == "deny" {
                return codex_deny(
                    &intent_pending_message("apply_patch", &detail),
                    &trace_target,
                );
            }
            // `intent-stale-overwrite` traces here in Python but is
            // non-terminal, so it is not the breadcrumb's decision.
            continue;
        }
        let (is_covered, worktree) = coverage_verdict(covered, &rel);
        if is_covered || codex_fresh_bypass(cwd, &rel) {
            continue;
        }
        if denied_worktree.is_none() {
            denied_worktree = worktree.map(str::to_string);
        }
        violations.push(rel);
    }
    if !violations.is_empty() {
        let bad = violations.join(", ");
        let message = format!(
            "apply_patch blocked: {} is not covered by any proposed or applied \
item in resources/worklist.json, and no fresh direct-edit authorization covers \
it. Propose the change in the worklist first (status: 'proposed'), wait for the \
user's approved: payload, then retry.{}",
            bad,
            coverage_root_line(cwd)
        );
        return with_worktree_marker(
            codex_deny(&message, &trace_target),
            denied_worktree.as_deref(),
        );
    }
    codex_allow("passed-checks", &trace_target)
}

fn codex_bash_branch(cwd: &Path, tool_input: &Value, covered: &HashSet<String>) -> ShadowVerdict {
    let command = tool_input
        .get("command")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    if is_gh_body_at_antipattern(&command) {
        // Python appends `Detected: <regex match>` as a third line. The traced
        // reason is line 1 only, so the match text is not reconstructed here.
        return codex_deny(
            "gh --body takes a literal string, not stdin or a file reference.\n\
Use --body-file - (stdin) or --body-file <path> instead.\nDetected: <match>",
            "-",
        );
    }
    let (cb_verdict, cb_detail) = crossboundary_signature_verdict(&command, cwd);
    // #331: same split as the Claude site — codex_deny's reason is the first
    // message line, so the distinct first line is what makes the trace
    // distinguish unreadable from unsigned.
    if cb_verdict == "unparsed"
        && !matches!(
            cb_detail,
            "body-file-stdin" | "no-body-flag" | "input-file-stdin" | "input-json-no-body"
        )
    {
        let path = body_file_arg(&command)
            .or_else(|| input_file_arg(&command))
            .or_else(|| forge_positional_body_file(&command))
            .unwrap_or_else(|| "<unresolved path>".to_string());
        return codex_deny(
            &format!(
                "The body file for this forge write could not be read, so its signature could not be verified.\n    {}\nAn unreadable named body is denied rather than silently bypassed (conventions.md, 'Signing agent-authored forge artifacts'). Check the path and retry — quoted and MSYS-style paths are accepted.",
                path
            ),
            "-",
        );
    }
    if cb_verdict == "unsigned" {
        return codex_deny(
            "This agent-authored forge artifact lacks the full repository-qualified signature.\nOpen the first line with:\n    <owner>'s <Agent> (<thread>, <model>, <os>, <machine>) speaking from the <Project> project (<origin-host>/<path>):\nSee conventions.md, 'Signing agent-authored forge artifacts' — every artifact, every comment, not just the first in a thread.",
            "-",
        );
    }
    let (sha_verdict, sha_detail) = forge_sha_verdict(&command, cwd);
    if sha_verdict == "bad" {
        return codex_deny(
            &format!(
                "The body contains a full commit SHA that does not resolve in this \
repository:\n    {}\nA fabricated or rebase-orphaned SHA renders as an ordinary \
link and 404s silently. Resolve the real hash with `git rev-parse <short-sha>` \
and retry. See judell/bram#277.",
                sha_detail
            ),
            "-",
        );
    }

    let (su_verdict, su_where) = session_url_verdict(&command, cwd);
    if su_verdict == "deny" {
        return codex_deny(
            &format!(
                "This commit or forge write carries an agent session URL or Claude-Session \
                 trailer (found in: {}). Session links are private telemetry; publishing \
                 them is irreversible and no opt-in exists. Remove the trailer/URL and \
                 retry. See conventions.md, 'No session URLs in public artifacts'.",
                su_where
            ),
            "-",
        );
    }

    // #299 (case 1): a pure forge read is a read. Unlike the Claude guard this
    // side has no `gh issue <verb>` write pattern, so the forge verbs were
    // never captured here and this changes no verdict — it is pinned so a
    // future widening of the write patterns cannot silently recapture them.
    if forge_read_command(&command) && !codex_bash_writes(&command) {
        return codex_allow("passed-checks", "-");
    }
    if !codex_bash_writes(&command) {
        // #299 (case 3) rides in through the quote-aware `has_redirect`.
        if has_redirect(&command) && !redirect_is_write(&command) {
            return codex_allow("bash-write-nonrepo-target", "-");
        }
        return codex_allow("passed-checks", "-");
    }
    if command.contains(WORKLIST_DRAFTS_PREFIX) {
        return codex_allow("passed-checks", "-");
    }
    if command.contains(".worklist-intent.json") {
        let (verdict, detail) = intent_write_verdict(cwd);
        if verdict == "deny" {
            return codex_deny(&intent_pending_message("Bash", &detail), "-");
        }
        if detail == IntentDetail::StaleOverwrite {
            return codex_allow("intent-stale-overwrite", "-");
        }
        return codex_allow("passed-checks", "-");
    }
    if !covered.is_empty() || codex_fresh_bypass(cwd, "*") {
        return codex_allow("passed-checks", "-");
    }
    if push_cmd(&command) && post_commit_push_grace(cwd) {
        return codex_allow("post-commit-push-grace", "-");
    }
    let mut message = format!(
        "Bash blocked: this command writes to the filesystem, and \
resources/worklist.json has no proposed or applied items covering the change. \
Propose the work in the worklist first, or have the user issue a direct-edit \
authorization.{}",
        coverage_root_line(cwd)
    );
    if push_cmd(&command) {
        message.push_str(
            "\n  - This looks like a push. The user can click Push in the Commits \
tab; an agent push is allowed only in the 10-minute window after a gate commit \
(see judell/bram#283).",
        );
    }
    codex_deny(&message, "-")
}

fn codex_mcp_branch(
    cwd: &Path,
    tool_name: &str,
    tool_input: &Value,
    covered: &HashSet<String>,
) -> ShadowVerdict {
    if !mcp_is_mutation(tool_name) {
        return codex_allow("passed-checks", "-");
    }
    let candidates = mcp_paths(tool_input);
    if candidates.is_empty() {
        // issue-360: same shape as the Claude branch above — consult the
        // wildcard direct-edit grant (Codex's "just do it" and Skip worklist
        // both land there via the host's toTurn path) before the fail-closed
        // deny. Codex has no transcript opt-out at PreToolUse by design.
        if codex_fresh_bypass(cwd, "*") {
            return codex_allow("mcp-no-path-bypass", tool_name);
        }
        return codex_deny(
            &format!(
                "{} blocked: looks like a mutation but the guard could not extract \
any file path from tool_input. If this tool does not modify repository files (an \
external connector, for example), the user can authorize it by ending their \
message with \"just do it\" or clicking the Skip worklist button. Otherwise \
propose the change in resources/worklist.json first, or extend MCP_PATH_KEYS \
(src-tauri/src/guard_policy.rs) to recognize this MCP tool's input shape.",
                tool_name
            ),
            "-",
        );
    }
    let touches_worklist = candidates
        .iter()
        .any(|t| codex_normalize_target(cwd, t).as_deref() == Some(WORKLIST_REL));
    if touches_worklist && tool_input.is_object() {
        let Some(new_content) = worklist_new_content_from_tool_input(cwd, tool_input) else {
            return codex_deny(
                &format!(
                    "{} blocked: worklist edits that advance status or prune items must \
use `/__worklist/mutate`. For direct authoring/refinement edits, use a write/edit \
shape whose resulting content the guard can inspect.",
                    tool_name
                ),
                "-",
            );
        };
        if !new_content.trim().is_empty() {
            if let Some(bad) = worklist_items_violating_draft_only(&new_content) {
                if !bad.is_empty() {
                    return codex_deny(&worklist_validation_error(&bad, tool_name), "-");
                }
            }
            let old_text = current_worklist_text(cwd);
            let (removed, status_changed) = worklist_state_changes(
                &codex_items_by_id(&old_text),
                &codex_items_by_id(&new_content),
            );
            if !removed.is_empty() || !status_changed.is_empty() {
                return codex_deny(
                    &mechanical_worklist_change_error(&removed, &status_changed, tool_name),
                    "-",
                );
            }
            let (old_has, old_version) = worklist_version_from_text(&old_text);
            let (new_has, new_version) = worklist_version_from_text(&new_content);
            if old_has && (!new_has || new_version != old_version + 1) {
                return codex_deny(
                    &stale_worklist_version_error(old_version, new_version, new_has, tool_name),
                    "-",
                );
            }
        }
    }
    let mut violations: Vec<String> = Vec::new();
    let mut denied_worktree: Option<String> = None;
    for t in &candidates {
        let Some(rel) = codex_normalize_target(cwd, t) else {
            continue;
        };
        if rel == WORKLIST_REL
            || is_worklist_draft(&rel)
            || is_worklist_citation(&rel)
            || is_coordination_file(&rel)
        {
            continue;
        }
        let (is_covered, worktree) = coverage_verdict(covered, &rel);
        if is_covered || codex_fresh_bypass(cwd, &rel) {
            continue;
        }
        if denied_worktree.is_none() {
            denied_worktree = worktree.map(str::to_string);
        }
        violations.push(rel);
    }
    if !violations.is_empty() {
        let message = format!(
            "{} blocked: {} is not covered by any proposed or applied item in \
resources/worklist.json, and no fresh direct-edit authorization covers it. \
Propose the change in the worklist first, wait for the user's approved: \
payload, then retry.{}",
            tool_name,
            violations.join(", "),
            coverage_root_line(cwd)
        );
        return with_worktree_marker(codex_deny(&message, "-"), denied_worktree.as_deref());
    }
    codex_allow("passed-checks", "-")
}

// --- parity suite -------------------------------------------------------------
//
// A port of `self_test()` in app/provider-hooks/claude-worklist-guard.py
// (lines 1204-1574). Every Python assertion has a twin here, in source order.
// The judell/bram#299 cases assert the NEW classification and are labelled.

#[cfg(test)]
mod guard_policy_tests {
    use super::*;

    // --- ported from the retired scripts/tests/test_provider_hook_encoding.py,
    // whose subject (the Python guards) went away with them. The behaviours it
    // pinned are still ours to keep. ---

    #[test]
    fn session_urls_deny_in_publishing_commands_only() {
        let cwd = std::env::temp_dir();
        // Inline -m trailer: the ~/budget shape.
        let (v, w) = session_url_verdict(
            "git commit -m \"Fix\n\nClaude-Session: https://claude.ai/code/session_01Eau\"",
            &cwd,
        );
        assert_eq!((v, w.as_str()), ("deny", "command-text"));
        // Forge write with the URL in the command line.
        let (v, _) = session_url_verdict(
            "gh issue comment 5 --body \"see https://claude.ai/code/session_abc\"",
            &cwd,
        );
        assert_eq!(v, "deny");
        // A grep mentioning the URL is a read — never captured.
        let (v, _) = session_url_verdict("grep -r claude.ai/code/ resources/", &cwd);
        assert_eq!(v, "skip");
        // Clean commit passes.
        let (v, _) = session_url_verdict("git commit -m \"Honest message\"", &cwd);
        assert_eq!(v, "skip");
        // Message file carrying the trailer: read and denied, naming the file.
        let f = cwd.join(format!("bram-su-test-{}.txt", std::process::id()));
        std::fs::write(
            &f,
            "Subject\n\nClaude-Session: https://claude.ai/code/session_x\n",
        )
        .unwrap();
        let (v, w) = session_url_verdict(&format!("git commit -F {}", f.to_string_lossy()), &cwd);
        assert_eq!(v, "deny");
        assert!(w.ends_with(".txt"));
        let _ = std::fs::remove_file(&f);
    }

    #[test]
    fn git_commit_detection_is_segment_scoped() {
        assert!(is_git_commit_command("git commit -m x"));
        assert!(is_git_commit_command("cd /x && git -C /y commit -F msg"));
        assert!(!is_git_commit_command("git log --oneline | head"));
        assert!(!is_git_commit_command("echo commit"));
    }

    #[test]
    fn opt_out_survives_an_undecodable_transcript() {
        // The Python guard read the transcript with errors="replace" because a
        // corrupt byte must not take the guard down. Rust's read_to_string
        // returns Err on invalid UTF-8, which silently yielded empty text and
        // disabled opt-out matching entirely.
        let dir = std::env::temp_dir().join(format!("bram-enc-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let tp = dir.join("corrupt.jsonl");
        let mut bytes = serde_json::json!({
            "type": "user",
            "message": {"role": "user", "content": "please fix it just do it"}
        })
        .to_string()
        .into_bytes();
        bytes.push(b'\n');
        // A lone 0xFF is valid in no UTF-8 sequence.
        bytes.extend_from_slice(&[0xFF, 0xFE, b'\n']);
        std::fs::write(&tp, &bytes).unwrap();

        let text = last_user_text(tp.to_str().unwrap());
        assert!(
            has_opt_out(&text),
            "opt-out must survive undecodable bytes; got {text:?}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn non_ascii_transcript_reads_like_its_ascii_equivalent() {
        // Drafts are full of em-dashes; a non-ASCII transcript must behave
        // exactly as an ASCII one does.
        let dir = std::env::temp_dir().join(format!("bram-enc2-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let tp = dir.join("spicy.jsonl");
        std::fs::write(
            &tp,
            serde_json::json!({
                "type": "user",
                "message": {"role": "user", "content": "café — naïve 日本語 just do it"}
            })
            .to_string()
                + "\n",
        )
        .unwrap();
        assert!(has_opt_out(&last_user_text(tp.to_str().unwrap())));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn worklist_text_survives_undecodable_bytes() {
        // An unreadable worklist would otherwise present as "no items", i.e.
        // no coverage for any path, denying every edit with a wrong reason.
        let dir = std::env::temp_dir().join(format!("bram-enc3-{}", std::process::id()));
        let _ = std::fs::create_dir_all(dir.join("resources"));
        let mut bytes =
            br#"{"items":[{"id":"a","status":"proposed","files":["src/x.rs"]}],"#.to_vec();
        bytes.extend_from_slice(&[0xFF]);
        bytes.extend_from_slice(br#""version":1}"#);
        std::fs::write(dir.join(WORKLIST_REL), &bytes).unwrap();
        let text = current_worklist_text(&dir);
        assert!(!text.is_empty(), "must not read as an empty worklist");
        assert!(text.contains("src/x.rs"), "content must survive: {text:?}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn scratch(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("bram-guard-policy-{}-{}", name, std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("create scratch dir");
        dir
    }

    // --- bash write / read corpus (python lines 1205-1249) ------------------

    #[test]
    fn bash_write_commands_are_writes() {
        let write_commands = [
            "echo x > out.txt",
            "printf x >> out.txt",
            "printf x | tee out.txt",
            "sed -i '' s/a/b/ file.txt",
            "perl -i -pe s/a/b/ file.txt",
            "python -c \"open('x', 'w').write('x')\"",
            "node -e \"require('fs').writeFileSync('x','x')\"",
            "git commit -m test",
            "git push",
            "gh issue close 119 --repo judell/bram",
            "rm stale.txt",
            "mv a b",
            "cp a b",
            "truncate -s 0 file.txt",
            "bash -c 'echo x > out.txt'",
            "sh -c 'echo x > out.txt'",
            "echo hi > /dev/stdout",
            "cat > src-tauri/src/lib.rs",
            "cat > /tmp/b.md && git commit -m x",
        ];
        for c in write_commands {
            assert!(bash_writes(c), "{c}");
        }
    }

    #[test]
    fn bash_read_commands_are_reads() {
        let read_commands = [
            "ls -la",
            "rg Bash app/provider-hooks/claude-worklist-guard.py",
            "git status --short",
            "gh issue view 119 --repo judell/bram",
            "python --version",
            "curl -I https://example.com",
            "git ls-files x >/dev/null 2>&1",
            "echo hi > /dev/null",
            "echo hi >> /dev/zero",
            "cat > /tmp/body.md",
            "cat > /private/tmp/x/body.md",
        ];
        for c in read_commands {
            assert!(!bash_writes(c), "{c}");
        }
    }

    // --- judell/bram#299: three deliberate divergences ----------------------

    #[test]
    fn issue_299_pure_forge_reads_are_reads() {
        // #299 case 1. Python's own classifier already lets the bare forms
        // through; these pin it, and forge_read_command makes it explicit.
        for c in [
            "gh issue list",
            "gh issue list --state all --json number,title,state,updatedAt --limit 200",
            "gh issue view 299 --json title,body",
            "glab issue list --state opened",
            "gh pr list --json number,title",
        ] {
            assert!(!bash_writes(c), "{c}");
            assert!(forge_read_command(c), "{c}");
        }
        // A jq comparison filter is the shape that actually got denied.
        let jq = "gh issue list --state all --json number --jq '.[]|select(.number > 200)'";
        assert!(!bash_writes(jq), "{jq}");
        // Still not a blanket exemption: a chained write is still a write.
        assert!(bash_writes("gh issue list && git commit -m x"));
    }

    #[test]
    fn issue_299_inline_python_c_reads_are_reads() {
        // #299 case 2: keyed on what the inline script does, not on `-c`.
        for c in [
            "python -c \"print(1)\"",
            "python3 -c 'import sys; print(sys.version)'",
            "python3 -c \"import json,sys; d=json.loads(sys.stdin.read()); print(len(d))\"",
        ] {
            assert!(!bash_writes(c), "{c}");
        }
        // Anything that touches a file, or that cannot be read, stays a write.
        for c in [
            "python -c \"open('x', 'w').write('x')\"",
            "python3 -c \"import shutil; shutil.rmtree('x')\"",
            "python3 -c \"import os; os.remove('x')\"",
            "python3 -c $SCRIPT",
        ] {
            assert!(bash_writes(c), "{c}");
        }
    }

    #[test]
    fn issue_299_quoted_comparison_is_not_a_redirect() {
        // #299 case 3: `>` / `>=` inside quotes is a comparison, not a redirect.
        for c in [
            "awk '$1 >= \"2026-08-28T06:16\"' file.txt",
            "sort -k1 f | awk '$2 > \"3\"'",
            "jq '.[] | select(.n > 5)' data.json",
            "grep -E \"a > b\" file",
        ] {
            assert!(!bash_writes(c), "{c}");
            assert!(!has_redirect(c), "{c}");
        }
        // Unquoted redirects still register.
        assert!(has_redirect("echo x > out.txt"));
        assert_eq!(redirect_targets("echo x > out.txt"), vec!["out.txt"]);
        assert_eq!(
            redirect_targets("cat > \"my file.txt\""),
            vec!["my file.txt"]
        );
    }

    // --- forge_issue_only_write (python lines 1251-1272) --------------------

    #[test]
    fn forge_issue_only_exemption() {
        assert!(forge_issue_only_write("gh issue comment 5 --body-file f"));
        assert!(forge_issue_only_write("gh issue close 5"));
        assert!(forge_issue_only_write("gh issue reopen 5"));
        assert!(forge_issue_only_write(
            "gh issue edit 5 --title \"new title\""
        ));
        assert!(forge_issue_only_write("gh issue create --title x --body y"));
        assert!(!forge_issue_only_write(
            "gh issue comment 5 --body-file f && git commit -m x"
        ));
        assert!(!forge_issue_only_write("gh issue delete 5"));
        assert!(!forge_issue_only_write("gh issue transfer 5 other/repo"));
        assert!(!forge_issue_only_write("gh issue pin 5"));
        assert!(!forge_issue_only_write("gh issue lock 5"));
        assert!(!forge_issue_only_write("gh issue view 5"));
        assert!(!forge_issue_only_write("git commit -m x"));
    }

    // --- MCP surface (python lines 1274-1291) -------------------------------

    #[test]
    fn mcp_mutation_recognition() {
        for name in [
            "mcp__filesystem__write_file",
            "mcp__filesystem__edit_file",
            "mcp__filesystem__move_file",
            "mcp__filesystem__create_directory",
        ] {
            assert!(mcp_is_mutation(name), "{name}");
        }
        for name in [
            "mcp__filesystem__read_text_file",
            "mcp__filesystem__list_directory",
            "mcp__xmlui__xmlui_search_howto",
            "mcp__xmlui__xmlui_component_docs",
        ] {
            assert!(!mcp_is_mutation(name), "{name}");
        }
    }

    // --- opt-out reachability (python lines 1293-1328) ----------------------

    fn transcript(dir: &Path, tag: &str, text: &str) -> String {
        let p = dir.join(format!("t-{}.jsonl", tag));
        let mut body = serde_json::json!({
            "type": "user",
            "message": {"content": [{"type": "text", "text": text}]},
        })
        .to_string();
        body.push('\n');
        body.push_str(
            &serde_json::json!({
                "type": "user",
                "message": {"content": [{"type": "tool_result", "text": ""}]},
            })
            .to_string(),
        );
        body.push('\n');
        std::fs::write(&p, body).unwrap();
        p.to_string_lossy().into_owned()
    }

    #[test]
    fn opt_out_phrase_is_reachable_from_every_surface() {
        let td = scratch("optout");
        let t1 = transcript(&td, "a", "patch it, just do it");
        assert_eq!(last_user_text(&t1), "patch it, just do it");
        assert!(has_opt_out(&last_user_text(&t1)));
        let t2 = transcript(&td, "b", "skip the worklist");
        assert!(!has_opt_out(&last_user_text(&t2)));
        assert!(!has_opt_out(&last_user_text("")));

        let t3 = transcript(&td, "c", "do the build, just do it");
        assert!(opt_out_clears(&td, &serde_json::json!({"transcript_path": t3})).is_some());
        let t4 = transcript(&td, "d", "please do the build");
        assert!(opt_out_clears(&td, &serde_json::json!({"transcript_path": t4})).is_none());
        assert!(opt_out_clears(&td, &serde_json::json!({})).is_none());
        let _ = std::fs::remove_dir_all(&td);
    }

    // --- signature gates (python lines 1330-1381) ---------------------------

    // #333: read-only listing forms of mutation-capable git verbs, and write
    // tokens inside quoted argument data. The adversarial half is the point:
    // every mutating neighbour must keep denying, and quoted-but-executed
    // interpreter bodies must stay classified as writes.
    #[test]
    fn bash_classifier_git_listing_forms_and_quoting() {
        // Case A: listing forms are read-only…
        for cmd in [
            "git tag --list",
            "git tag -l \"v0.6.*\"",
            "git tag --list | tail -20 && git status -sb && git log --oneline",
            "git stash list",
            "git stash show",
            "git branch",
            "git branch -a",
            "git branch --list \"issue-*\"",
        ] {
            assert!(!bash_writes(cmd), "should be read-only: {}", cmd);
        }
        // …and every mutating neighbour still denies.
        for cmd in [
            "git tag v1.0",
            "git tag -a v1.0 -m x",
            "git stash",
            "git stash pop",
            "git branch -d old",
            "git branch new-branch",
            "git branch --list && git push",
            "git commit -m \"x\"",
        ] {
            assert!(bash_writes(cmd), "must stay a write: {}", cmd);
        }

        // Case B: write tokens inside quoted argument data are data.
        for cmd in [
            "grep -n \"GIT_INDEX_FILE\\|git apply\\|--check\\|temp_dir\" src-tauri/src/lib.rs | head -40",
            "grep 'rm -rf' notes.md",
            "echo \"git push origin\"",
            "rg \"git checkout\" docs/",
        ] {
            assert!(!bash_writes(cmd), "quoted pattern is data: {}", cmd);
        }
        // Quoted-but-executed stays a write: the interpreter FLAG classifies.
        for cmd in [
            "sh -c \"rm -rf x\"",
            "bash -c 'git tag v1'",
            "python3 -c 'open(\"f\",\"w\").write(\"x\")'",
            "rm \"some file.txt\"",
            "git commit -m \"just listing things: git tag --list\"",
        ] {
            assert!(bash_writes(cmd), "must stay a write: {}", cmd);
        }
        // Unterminated quote: masking declines, flat scan rules — over-deny.
        // (`|` is a word boundary; a bare `"` never was, which is why the
        // token needs the pipe in front to demonstrate the fallback.)
        assert!(bash_writes("grep \"x\\|rm -rf notes.md"));
        assert!(!bash_writes("grep \"x\\|rm -rf\" notes.md"));

        // The classifier names its evidence.
        assert_eq!(
            write_patterns_token("rm x", SkipPattern::None).as_deref(),
            Some("rm")
        );
        assert_eq!(
            write_patterns_token("git tag v1", SkipPattern::None).as_deref(),
            Some("git tag")
        );
        assert_eq!(
            write_patterns_token("git tag --list", SkipPattern::None),
            None
        );
    }

    // #331: the fixture gap that shipped the bug — every prior test passed a
    // bare path. Quoted paths (the idiomatic Windows spelling) and MSYS paths
    // never parsed; the guard then blamed the signature it had never read.
    #[test]
    fn body_file_quoted_and_msys_paths() {
        let td = scratch("sig331");
        let signed = "Jon's Claude (main thread, Opus 5) speaking from the Bram project (github.com/judell/bram):\n\nBody.";
        let body_path = td.join("signed.md");
        std::fs::write(&body_path, signed).unwrap();

        // Double-quoted absolute path reads and verifies.
        let quoted_abs = format!("gh issue comment 5 --body-file \"{}\"", body_path.display());
        assert_eq!(
            crossboundary_signature_verdict(&quoted_abs, &td).0,
            "signed"
        );

        // Single-quoted relative path resolves against cwd.
        assert_eq!(
            crossboundary_signature_verdict("gh issue comment 5 --body-file 'signed.md'", &td).0,
            "signed"
        );

        // An unreadable named file is unparsed WITH the distinguishing
        // detail — the deny site formats this as
        // crossboundary-unparsed:body-file-unreadable, never as unsigned.
        assert_eq!(
            crossboundary_signature_verdict(
                "gh issue comment 5 --body-file \"/nope/missing.md\"",
                &td
            ),
            ("unparsed", "body-file-unreadable")
        );

        // MSYS mapping is pure and testable everywhere; call sites gate on
        // Windows. /tmp must not read as a drive.
        assert_eq!(
            msys_drive_path("/c/Users/jon/body.md").as_deref(),
            Some("C:/Users/jon/body.md")
        );
        assert_eq!(msys_drive_path("/tmp/body.md"), None);
        assert_eq!(msys_drive_path("relative/path.md"), None);

        // Quote stripping preserves backslashes byte-for-byte: unquote_shell's
        // \n unescaping would corrupt C:\Users\jon\new\b.md.
        assert_eq!(
            strip_surrounding_quotes("\"C:\\Users\\jon\\new\\b.md\""),
            "C:\\Users\\jon\\new\\b.md"
        );
        assert_eq!(strip_surrounding_quotes("'x.md'"), "x.md");
        assert_eq!(strip_surrounding_quotes("\"mismatched'"), "\"mismatched'");

        let _ = std::fs::remove_dir_all(&td);
    }

    // issue-352: a gate click writing the shared single-slot file must not
    // revoke a live direct-edit grant — the grant lives in its own sidecar.
    // Replays the Budget-project timeline: grant written, unrelated Drop
    // recorded 20s later, the authorized edit must still pass.
    #[test]
    fn direct_edit_grant_survives_gate_click_clobber() {
        let td = scratch("sig352");
        std::fs::create_dir_all(td.join("resources")).unwrap();
        let now = now_ms() as i64;
        // The grant, in its sidecar (new-binary shape).
        std::fs::write(
            td.join(DIRECT_EDIT_REL),
            format!(
                "{{\"kind\":\"direct-edit\",\"issued_at_ms\":{},\"issuedAtMs\":{},\"paths\":[\"*\"]}}",
                now, now
            ),
        )
        .unwrap();
        // The unrelated gate click, replacing the shared slot entirely.
        std::fs::write(
            td.join(AUTH_REL),
            format!(
                "{{\"kind\":\"drop\",\"ids\":[\"belt-tightening-log\"],\"issued_at_ms\":{}}}",
                now
            ),
        )
        .unwrap();
        assert!(
            fresh_bypass(&td, "README.md"),
            "Claude arm: grant must survive"
        );
        assert!(
            codex_fresh_bypass(&td, "README.md"),
            "Codex arm: grant must survive"
        );
        // Legacy compat: a grant still in the shared file (old binary) is
        // honored when no sidecar exists.
        let _ = std::fs::remove_file(td.join(DIRECT_EDIT_REL));
        std::fs::write(
            td.join(AUTH_REL),
            format!(
                "{{\"kind\":\"direct-edit\",\"issued_at_ms\":{},\"issuedAtMs\":{},\"paths\":[\"*\"]}}",
                now, now
            ),
        )
        .unwrap();
        assert!(
            fresh_bypass(&td, "README.md"),
            "legacy location still honored"
        );
        assert!(codex_fresh_bypass(&td, "README.md"));
        // A stale sidecar grant reports stale, not absent, and does not pass.
        std::fs::write(
            td.join(DIRECT_EDIT_REL),
            format!(
                "{{\"kind\":\"direct-edit\",\"issued_at_ms\":{},\"issuedAtMs\":{},\"paths\":[\"*\"]}}",
                now - 2 * 3_600_000,
                now - 2 * 3_600_000
            ),
        )
        .unwrap();
        std::fs::write(td.join(AUTH_REL), "{\"kind\":\"none\"}").unwrap();
        assert_eq!(bypass_lookup_detail(&td, "README.md"), (false, "stale"));
        let _ = std::fs::remove_dir_all(&td);
    }

    // #347: the two extractor defects found retrofitting signatures, plus the
    // --input route they forced as a workaround.
    #[test]
    fn body_file_field_syntax_quotes_and_input() {
        let td = scratch("sig347");
        let signed = "Jon's Claude (main thread, Fable 5, macOS) speaking from the Bram project (github.com/judell/bram):\n\nBody.";
        let body_path = td.join("signed.md");
        std::fs::write(&body_path, signed).unwrap();

        // gh api field syntax: the file is AFTER the @ — previously the
        // whole `body=@/path` token was opened as the path and a readable
        // signed body was denied unreadable.
        let api_patch = format!(
            "gh api repos/judell/bram/issues/comments/1 -X PATCH -F body=@{}",
            body_path.display()
        );
        assert_eq!(crossboundary_signature_verdict(&api_patch, &td).0, "signed");

        // -F key=value with no @ names no file; the real --body-file later
        // in the command is the one verified.
        let inline_field = format!(
            "gh api repos/judell/bram/issues/comments/1 -X PATCH -F state=open --body-file {}",
            body_path.display()
        );
        assert_eq!(
            crossboundary_signature_verdict(&inline_field, &td).0,
            "signed"
        );

        // A flag-shaped substring inside a quoted argument is prose, not a
        // flag — filing #347 itself was denied on its own --title.
        let quoted_title = format!(
            "gh issue create --title \"Guard mis-parses gh api -F body=@file: prefix left\" --body-file {}",
            body_path.display()
        );
        assert_eq!(
            crossboundary_signature_verdict(&quoted_title, &td).0,
            "signed"
        );

        // Unreadable field-syntax file: denied naming the BARE path.
        assert_eq!(
            crossboundary_body(
                "gh api repos/judell/bram/issues/comments/1 -X PATCH -F body=@/nope/missing.md",
                &td
            ),
            (None, "body-file-unreadable")
        );
        assert_eq!(
            body_file_arg("gh api x -X PATCH -F body=@/nope/missing.md").as_deref(),
            Some("/nope/missing.md")
        );

        // --input: signed JSON body verifies; missing body field fails open
        // as metadata-only; unreadable and unparseable stay denied.
        let payload = td.join("payload.json");
        std::fs::write(&payload, serde_json::json!({ "body": signed }).to_string()).unwrap();
        let input_cmd = format!(
            "gh api repos/judell/bram/issues/comments/1 -X PATCH --input {}",
            payload.display()
        );
        assert_eq!(
            crossboundary_signature_verdict(&input_cmd, &td),
            ("signed", "input-json-body")
        );
        let meta_only = td.join("meta.json");
        std::fs::write(&meta_only, "{\"state\":\"closed\"}").unwrap();
        let meta_cmd = format!(
            "gh api repos/judell/bram/issues/comments/1 -X PATCH --input {}",
            meta_only.display()
        );
        assert_eq!(
            crossboundary_signature_verdict(&meta_cmd, &td),
            ("unparsed", "input-json-no-body")
        );
        assert_eq!(
            crossboundary_signature_verdict(
                "gh api repos/judell/bram/issues/comments/1 -X PATCH --input /nope/missing.json",
                &td
            ),
            ("unparsed", "input-file-unreadable")
        );
        let not_json = td.join("not.json");
        std::fs::write(&not_json, "not json at all").unwrap();
        let bad_cmd = format!(
            "gh api repos/judell/bram/issues/comments/1 -X PATCH --input {}",
            not_json.display()
        );
        assert_eq!(
            crossboundary_signature_verdict(&bad_cmd, &td),
            ("unparsed", "input-json-unparseable")
        );

        let _ = std::fs::remove_dir_all(&td);
    }

    #[test]
    fn crossboundary_signature_gates() {
        let td = scratch("sig");
        let signed = "Jon's Claude (main thread, Opus 5) speaking from the Bram project (github.com/judell/bram):\n\nBody.";
        let unsigned = "Vendored the build; the tooltip renders.";
        let verdict = |cmd: &str| crossboundary_signature_verdict(cmd, &td).0;

        assert_eq!(verdict("gh issue view 12 --repo xmlui-org/xmlui"), "skip");
        assert_eq!(verdict("ls -la"), "skip");
        assert_eq!(
            verdict(&format!("gh issue comment 5 --body \"{}\"", unsigned)),
            "unsigned"
        );
        assert_eq!(
            verdict(&format!("gh issue comment 5 --body \"{}\"", signed)),
            "signed"
        );
        assert_eq!(
            verdict(&format!(
                "gh issue comment 5 --repo judell/bram --body \"{}\"",
                unsigned
            )),
            "unsigned"
        );
        assert!(!td.join(".git").join("config").exists());
        assert_eq!(
            verdict(&format!(
                "gh issue comment 5 --repo xmlui-org/xmlui --body \"{}\"",
                signed
            )),
            "signed"
        );
        assert_eq!(
            verdict(&format!(
                "gh issue comment 5 --repo xmlui-org/xmlui --body \"{}\"",
                unsigned
            )),
            "unsigned"
        );
        assert_eq!(
            verdict(&format!("gh pr comment 9 --body \"{}\"", unsigned)),
            "unsigned"
        );
        assert_eq!(
            verdict(&format!("glab issue note 3 -m \"{}\"", unsigned)),
            "unsigned"
        );
        assert_eq!(verdict("gh issue comment 5 --body-file -"), "unparsed");
        assert_eq!(
            verdict("gh issue comment 5 --body-file /nope/missing.md"),
            "unparsed"
        );
        assert_eq!(verdict("gh issue comment 5"), "unparsed");
        assert_eq!(verdict("gh issue close 5"), "skip");

        let body_path = td.join("comment.md");
        std::fs::write(&body_path, signed).unwrap();
        assert_eq!(
            crossboundary_signature_verdict(
                &format!("gh issue comment 5 --body-file {}", body_path.display()),
                &td
            ),
            ("signed", "body-file")
        );
        let _ = std::fs::remove_dir_all(&td);
    }

    #[test]
    fn body_is_signed_tolerates_markdown_emphasis() {
        let td = scratch("signature-markdown");
        assert!(body_is_signed(
            "_Jon's Codex (main thread, GPT-5.6-sol) speaking from the XMLUI project (github.com/xmlui-org/xmlui):_",
            &td
        ));
        assert!(body_is_signed(
            "> **Jon's Claude (subagent, Opus 5) speaking from the Bram project (github.com/judell/bram):**",
            &td
        ));
        assert!(!body_is_signed(
            "Bram side — a correction to my green light.",
            &td
        ));
        assert!(!body_is_signed("", &td));
        let _ = std::fs::remove_dir_all(&td);
    }

    #[test]
    fn repository_qualified_signatures_cover_gist_api_and_origin_match() {
        let td = scratch("signature-origin");
        std::fs::create_dir_all(td.join(".git").join("refs")).unwrap();
        std::fs::create_dir_all(td.join(".git").join("objects")).unwrap();
        std::fs::write(td.join(".git").join("HEAD"), "ref: refs/heads/main\n").unwrap();
        std::fs::write(
            td.join(".git").join("config"),
            "[core]\n\trepositoryformatversion = 0\n\tbare = false\n[remote \"origin\"]\n\turl = git@gitlab.com:group/subgroup/project.git\n",
        )
        .unwrap();

        let signed = "Jon's Codex (main thread, GPT-5.6-sol) speaking from the Bram project (gitlab.com/group/subgroup/project):\n\nBody.";
        let wrong_repo = "Jon's Codex (main thread, GPT-5.6-sol) speaking from the Bram project (github.com/judell/bram):\n\nBody.";
        let old_form = "Jon's Codex speaking from the Bram project:\n\nBody.";
        assert_eq!(
            expected_repo_locator(&td),
            Some("gitlab.com/group/subgroup/project".to_string())
        );
        assert!(body_is_signed(signed, &td));
        assert!(!body_is_signed(wrong_repo, &td));
        assert!(!body_is_signed(old_form, &td));
        assert_eq!(
            normalize_repo_locator("https://GitLab.com/group/subgroup/project.git\n"),
            Some("gitlab.com/group/subgroup/project".to_string())
        );

        let gist_body = td.join("gist.md");
        std::fs::write(&gist_body, signed).unwrap();
        assert_eq!(
            crossboundary_signature_verdict(
                &format!(
                    "gh gist edit deadbeef --filename gist.md {}",
                    gist_body.display()
                ),
                &td
            ),
            ("signed", "positional-body-file")
        );
        assert_eq!(
            crossboundary_signature_verdict(
                &format!(
                    "gh api --method POST gists/deadbeef/comments -f \"body={}\"",
                    signed.replace('\n', "\\n")
                ),
                &td
            ),
            ("signed", "api-body-field")
        );
        assert_eq!(
            crossboundary_signature_verdict(
                "gh gist edit deadbeef --filename gist.md missing.md",
                &td
            ),
            ("unparsed", "positional-body-file-unreadable")
        );
        let _ = std::fs::remove_dir_all(&td);
    }

    // --- mcp_paths (python lines 1383-1387) ---------------------------------

    #[test]
    fn mcp_path_extraction() {
        assert_eq!(
            mcp_paths(&serde_json::json!({"path": "app/x.xmlui"})),
            vec!["app/x.xmlui"]
        );
        assert_eq!(
            mcp_paths(&serde_json::json!({"source": "a", "destination": "b"})),
            vec!["a", "b"]
        );
        let empty: Vec<String> = Vec::new();
        assert_eq!(mcp_paths(&serde_json::json!({"paths": ["a", "b"]})), empty);
        assert_eq!(
            mcp_paths(&serde_json::json!({"edits": [{"oldText": "x"}]})),
            empty
        );
        assert_eq!(mcp_paths(&serde_json::json!("not-a-dict")), empty);
    }

    // --- subagent lifecycle gate (python lines 1389-1440) -------------------

    #[test]
    fn subagent_lifecycle_gate_keys_on_agent_id() {
        let lifecycle_cmd = "curl -4 -sS -X POST -H \"Content-Type: application/json\" \
             --data @/tmp/body.json http://127.0.0.1:61455/__worklist/mutate";
        assert_eq!(
            subagent_lifecycle_verdict(lifecycle_cmd, "b1iz1vf6f"),
            ("deny", None)
        );
        assert_eq!(
            subagent_lifecycle_verdict(lifecycle_cmd, ""),
            ("allow", Some("no-agent-id"))
        );
        assert_eq!(
            subagent_lifecycle_verdict(lifecycle_cmd, "   "),
            ("allow", Some("no-agent-id"))
        );
        assert_eq!(
            subagent_lifecycle_verdict("git status", "b1iz1vf6f"),
            ("skip", None)
        );
        // A subagent transcript path in the agent_id slot must not deny.
        assert_eq!(
            subagent_lifecycle_verdict("git status", "/tmp/subagents/agent-1.jsonl"),
            ("skip", None)
        );
    }

    // --- subagent worklist-write gate (python lines 1442-1464) --------------

    #[test]
    fn subagent_worklist_write_gate() {
        assert_eq!(
            subagent_worklist_write_verdict(Some(WORKLIST_REL), "b1iz1vf6f"),
            ("deny", None)
        );
        assert_eq!(
            subagent_worklist_write_verdict(
                Some("resources/worklist-drafts/some-item.md"),
                "b1iz1vf6f"
            ),
            ("deny", None)
        );
        assert_eq!(
            subagent_worklist_write_verdict(Some(WORKLIST_REL), ""),
            ("skip", Some("no-agent-id"))
        );
        assert_eq!(subagent_worklist_write_verdict(None, ""), ("skip", None));
        assert_eq!(
            subagent_worklist_write_verdict(Some(WORKLIST_REL), "   "),
            ("skip", Some("no-agent-id"))
        );
        assert_eq!(
            subagent_worklist_write_verdict(Some("app/tools/Main.xmlui"), "b1iz1vf6f"),
            ("skip", None)
        );
    }

    #[test]
    fn issue_309_worktree_coverage_mapping() {
        let covered: HashSet<String> = ["app/x.txt", "components"]
            .into_iter()
            .map(str::to_string)
            .collect();

        assert_eq!(
            coverage_verdict(&covered, ".claude/worktrees/agent-a/app/x.txt"),
            (true, Some("agent-a"))
        );
        // #295 directory-entry coverage is evaluated after #309 mapping.
        assert_eq!(
            coverage_verdict(
                &covered,
                ".claude/worktrees/agent-a/components/nested/y.xmlui"
            ),
            (true, Some("agent-a"))
        );
        assert_eq!(
            coverage_verdict(&covered, ".claude/worktrees/agent-a/app/y.txt"),
            (false, Some("agent-a"))
        );

        let claude_hook: HashSet<String> = [".claude/hooks/guard.py"]
            .into_iter()
            .map(str::to_string)
            .collect();
        assert_eq!(
            coverage_verdict(&claude_hook, ".claude/hooks/guard.py"),
            (true, None)
        );
        assert_eq!(
            coverage_verdict(&covered, "scratch/.claude/worktrees/agent-a/app/x.txt"),
            (false, None)
        );
    }

    // --- cross-root direct-edit bypass (python lines 1466-1574) -------------

    fn write_auth(root: &Path, kind: &str, paths: &[&str], age_ms: f64) {
        let rec = serde_json::json!({
            "kind": kind,
            "paths": paths,
            "issuedAtMs": now_ms() - age_ms,
        });
        std::fs::write(root.join(AUTH_REL), rec.to_string()).unwrap();
    }

    fn clear_auth(root: &Path) {
        let _ = std::fs::remove_file(root.join(AUTH_REL));
    }

    #[test]
    fn cross_root_bypass_consults_both_roots() {
        let base = scratch("crossroot");
        let target_root = base.join("target-project");
        let session_root = base.join("session-project");
        std::fs::create_dir_all(target_root.join("resources")).unwrap();
        std::fs::create_dir_all(session_root.join("resources")).unwrap();

        // resolve_session_root walks up to the marker, and fails quietly.
        write_auth(&session_root, "direct-edit", &["*"], 0.0);
        assert_eq!(
            resolve_session_root(&serde_json::json!({"cwd": session_root.to_string_lossy()})),
            Some(abspath_of(&session_root))
        );
        assert_eq!(
            resolve_session_root(&serde_json::json!({
                "cwd": session_root.join("nested").join("dir").to_string_lossy()
            })),
            Some(abspath_of(&session_root))
        );
        assert_eq!(
            resolve_session_root(&serde_json::json!({"cwd": base.to_string_lossy()})),
            None
        );
        assert_eq!(resolve_session_root(&serde_json::json!({})), None);
        assert_eq!(resolve_session_root(&serde_json::json!({"cwd": 123})), None);
        clear_auth(&session_root);

        // (a) target root only -> matched via target, session never consulted.
        write_auth(&target_root, "direct-edit", &["*"], 0.0);
        assert_eq!(
            cross_root_bypass_verdict(&target_root, "some/file.txt", Some(&session_root)),
            (true, Some("target"), "ok", None)
        );
        assert!(fresh_bypass(&target_root, "some/file.txt"));
        clear_auth(&target_root);

        // (b) session root only -> matched via session.
        write_auth(&session_root, "direct-edit", &["*"], 0.0);
        assert!(!fresh_bypass(&target_root, "some/file.txt"));
        assert_eq!(
            cross_root_bypass_verdict(&target_root, "some/file.txt", Some(&session_root)),
            (true, Some("session"), "absent", Some("ok"))
        );
        clear_auth(&session_root);

        // (c) neither -> both lookups run, both absent.
        assert_eq!(
            cross_root_bypass_verdict(&target_root, "some/file.txt", Some(&session_root)),
            (false, None, "absent", Some("absent"))
        );

        // (d) stale in the session root -> named as stale, not a false ok.
        write_auth(
            &session_root,
            "direct-edit",
            &["*"],
            BYPASS_TTL_MS + 60_000.0,
        );
        assert_eq!(
            cross_root_bypass_verdict(&target_root, "some/file.txt", Some(&session_root)),
            (false, None, "absent", Some("stale"))
        );
        clear_auth(&session_root);

        // (e) session root == target root -> the second lookup never runs.
        write_auth(&target_root, "direct-edit", &["*"], 0.0);
        assert_eq!(
            cross_root_bypass_verdict(&target_root, "some/file.txt", Some(&target_root)),
            (true, Some("target"), "ok", None)
        );
        clear_auth(&target_root);
        assert_eq!(
            cross_root_bypass_verdict(&target_root, "some/file.txt", Some(&target_root)),
            (false, None, "absent", None)
        );

        // No session root at all -> single lookup.
        assert_eq!(
            cross_root_bypass_verdict(&target_root, "some/file.txt", None),
            (false, None, "absent", None)
        );
        let _ = std::fs::remove_dir_all(&base);
    }

    // --- pipeline-level checks (not in the Python self-test, which exercises
    // main() only through the live hook) ------------------------------------

    #[test]
    fn wrong_provider_returns_none() {
        let payload = serde_json::json!({"tool_name": "Bash"});
        assert!(shadow_worklist_decision("gemini-rs", &payload).is_none());
        assert!(shadow_worklist_decision("claude-rs", &payload).is_some());
        assert!(shadow_worklist_decision("codex-rs", &payload).is_some());
    }

    #[test]
    fn bash_read_only_pipeline_allows() {
        let v = shadow_worklist_decision(
            "claude-rs",
            &serde_json::json!({
                "hook_event_name": "PreToolUse",
                "tool_name": "Bash",
                "tool_input": {"command": "ls -la"},
                "cwd": "/",
            }),
        )
        .unwrap();
        assert_eq!(v.decision, "allow");
        assert_eq!(v.reason, "bash-read-only");
    }

    #[test]
    fn gh_body_at_antipattern_denies() {
        let v = shadow_worklist_decision(
            "claude-rs",
            &serde_json::json!({
                "tool_name": "Bash",
                "tool_input": {"command": "gh issue comment 5 --body @body.md"},
                "cwd": "/",
            }),
        )
        .unwrap();
        assert_eq!(
            (v.decision.as_str(), v.reason.as_str()),
            ("deny", "gh-body-at-antipattern")
        );
        assert!(!is_gh_body_at_antipattern(
            "gh issue comment 5 --body \"x\""
        ));
    }

    #[test]
    fn write_edit_pipeline_covers_worklist_surfaces() {
        let root = scratch("we");
        std::fs::create_dir_all(root.join("resources")).unwrap();
        std::fs::write(root.join(AUTH_REL), "{}").unwrap();
        std::fs::create_dir_all(root.join("app")).unwrap();

        // A lifecycle path is implicitly authorized.
        let inflight = root.join("resources/.inflight-claim.json");
        let v = shadow_worklist_decision(
            "claude-rs",
            &serde_json::json!({
                "tool_name": "Write",
                "tool_input": {"file_path": inflight.to_string_lossy(), "content": "{}"},
                "cwd": root.to_string_lossy(),
            }),
        )
        .unwrap();
        assert_eq!(
            (v.decision.as_str(), v.reason.as_str()),
            ("allow", "bram-lifecycle-channel")
        );

        // An uncovered project file is denied and the root is named.
        let target = root.join("app/x.txt");
        let v = shadow_worklist_decision(
            "claude-rs",
            &serde_json::json!({
                "tool_name": "Write",
                "tool_input": {"file_path": target.to_string_lossy(), "content": "x"},
                "cwd": root.to_string_lossy(),
            }),
        )
        .unwrap();
        assert_eq!(v.decision, "deny");
        assert_eq!(v.target, "app/x.txt");
        assert!(
            v.reason.starts_with("no-coverage-no-opt-out:root="),
            "reason: {}",
            v.reason
        );

        // Covered by a proposed item -> allowed.
        std::fs::write(
            root.join(WORKLIST_REL),
            serde_json::json!({
                "version": 1,
                "items": [{"id": "i1", "status": "proposed", "files": ["app/x.txt"]}]
            })
            .to_string(),
        )
        .unwrap();
        let v = shadow_worklist_decision(
            "claude-rs",
            &serde_json::json!({
                "tool_name": "Write",
                "tool_input": {"file_path": target.to_string_lossy(), "content": "x"},
                "cwd": root.to_string_lossy(),
            }),
        )
        .unwrap();
        assert_eq!(
            (v.decision.as_str(), v.reason.as_str()),
            ("allow", "covered-by-worklist-item")
        );

        // A stale version bump on worklist.json itself is denied.
        let wl = root.join(WORKLIST_REL);
        let v = shadow_worklist_decision(
            "claude-rs",
            &serde_json::json!({
                "tool_name": "Write",
                "tool_input": {
                    "file_path": wl.to_string_lossy(),
                    "content": serde_json::json!({
                        "version": 1,
                        "items": [
                            {"id": "i1", "status": "proposed", "files": ["app/x.txt"]},
                            {"id": "i2", "status": "proposed", "files": ["app/y.txt"]}
                        ]
                    }).to_string(),
                },
                "cwd": root.to_string_lossy(),
            }),
        )
        .unwrap();
        assert_eq!(
            (v.decision.as_str(), v.reason.as_str()),
            ("deny", "stale-worklist-version")
        );

        // A correct bump authors cleanly.
        let v = shadow_worklist_decision(
            "claude-rs",
            &serde_json::json!({
                "tool_name": "Write",
                "tool_input": {
                    "file_path": wl.to_string_lossy(),
                    "content": serde_json::json!({
                        "version": 2,
                        "items": [
                            {"id": "i1", "status": "proposed", "files": ["app/x.txt"]},
                            {"id": "i2", "status": "proposed", "files": ["app/y.txt"]}
                        ]
                    }).to_string(),
                },
                "cwd": root.to_string_lossy(),
            }),
        )
        .unwrap();
        assert_eq!(
            (v.decision.as_str(), v.reason.as_str()),
            ("allow", "worklist-author")
        );

        // Removing an item is a mechanical change.
        let v = shadow_worklist_decision(
            "claude-rs",
            &serde_json::json!({
                "tool_name": "Write",
                "tool_input": {
                    "file_path": wl.to_string_lossy(),
                    "content": serde_json::json!({"version": 2, "items": []}).to_string(),
                },
                "cwd": root.to_string_lossy(),
            }),
        )
        .unwrap();
        assert_eq!(
            (v.decision.as_str(), v.reason.as_str()),
            ("deny", "mechanical-worklist-change")
        );

        // Inline prose on a proposed item is denied.
        let v = shadow_worklist_decision(
            "claude-rs",
            &serde_json::json!({
                "tool_name": "Write",
                "tool_input": {
                    "file_path": wl.to_string_lossy(),
                    "content": serde_json::json!({
                        "version": 2,
                        "items": [
                            {"id": "i1", "status": "proposed", "files": ["app/x.txt"], "before": "x"}
                        ]
                    }).to_string(),
                },
                "cwd": root.to_string_lossy(),
            }),
        )
        .unwrap();
        assert_eq!(
            (v.decision.as_str(), v.reason.as_str()),
            ("deny", "worklist-inline-prose")
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn issue_309_claude_worktree_pipeline_maps_only_coverage() {
        let root = scratch("worktree-claude");
        std::fs::create_dir_all(root.join("resources")).unwrap();
        std::fs::write(root.join(AUTH_REL), "{}").unwrap();
        std::fs::write(
            root.join(WORKLIST_REL),
            serde_json::json!({
                "version": 1,
                "items": [{
                    "id": "i1",
                    "status": "proposed",
                    "files": ["app/x.txt", "components"]
                }]
            })
            .to_string(),
        )
        .unwrap();

        let covered = root.join(".claude/worktrees/agent-a/app/x.txt");
        let v = shadow_worklist_decision(
            "claude-rs",
            &serde_json::json!({
                "tool_name": "Write",
                "tool_input": {"file_path": covered.to_string_lossy(), "content": "x"},
                "cwd": root.to_string_lossy(),
            }),
        )
        .unwrap();
        assert_eq!(
            (v.decision.as_str(), v.reason.as_str()),
            ("allow", "covered-by-worklist-item")
        );
        assert_eq!(v.target, ".claude/worktrees/agent-a/app/x.txt");

        let covered_dir = root.join(".claude/worktrees/agent-a/components/nested/y.xmlui");
        let v = shadow_worklist_decision(
            "claude-rs",
            &serde_json::json!({
                "tool_name": "Write",
                "tool_input": {"file_path": covered_dir.to_string_lossy(), "content": "x"},
                "cwd": root.to_string_lossy(),
            }),
        )
        .unwrap();
        assert_eq!(
            (v.decision.as_str(), v.reason.as_str()),
            ("allow", "covered-by-worklist-item")
        );

        let uncovered = root.join(".claude/worktrees/agent-a/app/y.txt");
        let v = shadow_worklist_decision(
            "claude-rs",
            &serde_json::json!({
                "tool_name": "Write",
                "tool_input": {"file_path": uncovered.to_string_lossy(), "content": "x"},
                "cwd": root.to_string_lossy(),
            }),
        )
        .unwrap();
        assert_eq!(v.decision, "deny");
        assert!(
            v.reason
                .starts_with("no-coverage-no-opt-out:worktree=agent-a:root="),
            "reason: {}",
            v.reason
        );
        assert_eq!(v.target, ".claude/worktrees/agent-a/app/y.txt");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn mcp_pipeline_branches() {
        let root = scratch("mcp");
        std::fs::create_dir_all(root.join("resources")).unwrap();
        std::fs::write(root.join(AUTH_REL), "{}").unwrap();

        let v = shadow_worklist_decision(
            "claude-rs",
            &serde_json::json!({
                "tool_name": "mcp__filesystem__read_text_file",
                "tool_input": {"path": "a"},
                "cwd": root.to_string_lossy(),
            }),
        )
        .unwrap();
        assert_eq!(
            (v.decision.as_str(), v.reason.as_str()),
            ("allow", "mcp-read-only")
        );

        let v = shadow_worklist_decision(
            "claude-rs",
            &serde_json::json!({
                "tool_name": "mcp__filesystem__write_file",
                "tool_input": {"contents": "x"},
                "cwd": root.to_string_lossy(),
            }),
        )
        .unwrap();
        assert_eq!(
            (v.decision.as_str(), v.reason.as_str()),
            ("deny", "mcp-unrecognized-input")
        );

        let v = shadow_worklist_decision(
            "claude-rs",
            &serde_json::json!({
                "tool_name": "mcp__filesystem__write_file",
                "tool_input": {"path": root.join(WORKLIST_REL).to_string_lossy()},
                "cwd": root.to_string_lossy(),
            }),
        )
        .unwrap();
        assert_eq!(
            (v.decision.as_str(), v.reason.as_str()),
            ("deny", "mcp-worklist-write")
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn helpers_match_the_python_predicates() {
        assert!(is_lifecycle_path("resources/.bram-port"));
        assert!(is_lifecycle_path("resources/worklist-drafts/x.md"));
        assert!(!is_lifecycle_path(""));
        assert!(!is_lifecycle_path("app/tools/Main.xmlui"));
        assert!(is_worklist_draft("resources/worklist-drafts/x.md"));
        assert!(!is_worklist_draft("resources/worklist-drafts/sub/x.md"));
        assert!(!is_worklist_draft("resources/worklist-drafts/x.json"));
        assert!(push_cmd("git push"));
        assert!(push_cmd("git -C /tmp/repo push origin main"));
        assert!(push_cmd("git commit -m x && git push"));
        assert!(!push_cmd("pushd /tmp"));
        assert_eq!(worklist_version_from_text("{\"version\": 3}"), (true, 3));
        assert_eq!(worklist_version_from_text("{}"), (false, 0));
        assert_eq!(worklist_version_from_text("nope"), (false, 0));
        assert_eq!(
            full_shas("see 0123456789abcdef0123456789abcdef01234567 here"),
            vec!["0123456789abcdef0123456789abcdef01234567"]
        );
        assert!(full_shas("deadbeef").is_empty());
    }

    // issue-360: a name-classified MCP "mutation" with no extractable path
    // (external connectors — Drive create_file, Calendar create_event) honors
    // the user's explicit opt-outs; without one, the fail-closed deny stands.
    #[test]
    fn mcp_zero_path_honors_opt_outs() {
        let root = scratch("mcp360");
        std::fs::create_dir_all(root.join("resources")).unwrap();
        std::fs::write(root.join(AUTH_REL), "{}").unwrap();

        let payload = serde_json::json!({
            "tool_name": "mcp__claude_ai_Google_Drive__create_file",
            "tool_input": {"title": "x", "textContent": "y"},
            "cwd": root.to_string_lossy(),
        });

        // No grant, no opt-out: fail-closed.
        let v = shadow_worklist_decision("claude-rs", &payload).unwrap();
        assert_eq!(
            (v.decision.as_str(), v.reason.as_str()),
            ("deny", "mcp-unrecognized-input")
        );

        // Fresh wildcard direct-edit grant (Skip worklist): released, and the
        // trace target names the released tool.
        write_auth(&root, "direct-edit", &["*"], 0.0);
        let v = shadow_worklist_decision("claude-rs", &payload).unwrap();
        assert_eq!(
            (v.decision.as_str(), v.reason.as_str()),
            ("allow", "mcp-no-path-bypass")
        );
        assert_eq!(v.target, "mcp__claude_ai_Google_Drive__create_file");

        // Stale grant: deny again.
        write_auth(&root, "direct-edit", &["*"], BYPASS_TTL_MS + 60_000.0);
        let v = shadow_worklist_decision("claude-rs", &payload).unwrap();
        assert_eq!(
            (v.decision.as_str(), v.reason.as_str()),
            ("deny", "mcp-unrecognized-input")
        );

        // "just do it" prose opt-out: released, with the audit turn key set
        // (drives the direct-edit breadcrumb dedup).
        std::fs::write(root.join(AUTH_REL), "{}").unwrap();
        let tp = transcript(&root, "m360", "create the event, just do it");
        let v = shadow_worklist_decision(
            "claude-rs",
            &serde_json::json!({
                "tool_name": "mcp__claude_ai_Google_Calendar__create_event",
                "tool_input": {"summary": "lunch"},
                "cwd": root.to_string_lossy(),
                "transcript_path": tp,
            }),
        )
        .unwrap();
        assert_eq!(
            (v.decision.as_str(), v.reason.as_str()),
            ("allow", "opt-out-phrase")
        );
        assert_eq!(v.target, "mcp__claude_ai_Google_Calendar__create_event");
        assert!(v.audit_turn_key.is_some());

        let _ = std::fs::remove_dir_all(&root);
    }

    // --- authority-mode deny-message parity (bram-guard-authority-flip) -----
    //
    // Shadow mode ignores ShadowVerdict::message; authority mode prints it as
    // the whole of stderr, so these assert the transcribed text against the
    // Python guard's `print(msg, file=sys.stderr)` bodies, verbatim, with the
    // authoritative line numbers cited beside each. The `[worklist-guard] …`
    // header `_trace_hook` writes first is line 1 of every message; `body_of`
    // strips it so each assertion reads as the Python source does.

    fn claude_decide(payload: Value) -> ShadowVerdict {
        shadow_worklist_decision("claude-rs", &payload).unwrap()
    }

    fn body_of(v: &ShadowVerdict) -> &str {
        v.message
            .split_once('\n')
            .map(|(_, body)| body)
            .unwrap_or("")
    }

    fn header_of(v: &ShadowVerdict) -> &str {
        v.message.split('\n').next().unwrap_or("")
    }

    fn managed_claude(name: &str) -> PathBuf {
        let root = scratch(name);
        std::fs::create_dir_all(root.join("resources")).unwrap();
        std::fs::create_dir_all(root.join("app")).unwrap();
        std::fs::write(root.join(AUTH_REL), "{}").unwrap();
        root
    }

    #[test]
    fn message_parity_no_coverage_write() {
        // python claude-worklist-guard.py:1183-1245 (deny_coverage), reached
        // from :2330. opt_out_attempted is false (no transcript), and the
        // session-root leg is skipped because cwd resolves to the same root.
        let root = managed_claude("msg-no-coverage");
        std::fs::write(root.join("app/x.txt"), "hello").unwrap();
        let v = claude_decide(serde_json::json!({
            "tool_name": "Write",
            "tool_input": {
                "file_path": root.join("app/x.txt").to_string_lossy(),
                "content": "new",
            },
            "cwd": root.to_string_lossy(),
        }));
        assert_eq!(v.decision, "deny");
        let expected = format!(
            "Blocked: writing to app/x.txt requires either a proposed/applied item in resources/worklist.json covering this path, or an explicit opt-out phrase in your last message.\n  - Propose the change in resources/worklist.json first (item with file=\"app/x.txt\", non-empty before and after, status proposed). Wait for the user's approved: payload, then retry.\n  - The user can authorize a direct edit by ending their message with \"just do it\", or by clicking the Skip worklist button.\nresolved_project_root={root} (marker: resources/.worklist-authorization.json; if this is not the repo root, a stray marker file captured this subtree — remove that resources/.worklist-authorization.json)",
            root = root.display()
        );
        assert_eq!(body_of(&v), expected);
        // The header is `_trace_hook`'s stderr diagnostic: Write/Edit denials
        // pass no cwd, so it carries the guard process's own.
        assert_eq!(
            header_of(&v),
            format!(
                "[worklist-guard] tool=Write target=app/x.txt cwd={} decision=deny reason=no-coverage-no-opt-out:root={}",
                process_cwd(),
                root.display()
            )
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn message_parity_no_coverage_worktree_line() {
        // python:1211-1217 — the worktree marker paragraph, appended before
        // the resolved_project_root line (#309).
        let root = managed_claude("msg-worktree");
        let target = root.join(".claude/worktrees/agent-a/app/x.txt");
        std::fs::create_dir_all(target.parent().unwrap()).unwrap();
        std::fs::write(&target, "hello").unwrap();
        let v = claude_decide(serde_json::json!({
            "tool_name": "Write",
            "tool_input": {"file_path": target.to_string_lossy(), "content": "new"},
            "cwd": root.to_string_lossy(),
        }));
        assert!(body_of(&v).contains(
            "\nworktree=agent-a (coverage checked against the corresponding real-tree path; this denial is still authoritative)\nresolved_project_root="
        ), "body: {}", body_of(&v));
        assert!(v.reason.contains(":worktree=agent-a:root="), "{}", v.reason);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn message_parity_bash_write_no_coverage() {
        // python:1284-1323 (deny_bash_coverage), reached from :2117. The push
        // bullet (judell/bram#283) rides on _PUSH_CMD_RX only.
        let root = managed_claude("msg-bash-coverage");
        let base = "Bash blocked: this command writes to the filesystem or performs a sensitive side effect, and resources/worklist.json has no proposed or applied items covering active work.\n  - Propose the work in the worklist first, wait for the user's approved: payload, then retry.\n  - The user can authorize a direct edit by ending their message with \"just do it\", or by clicking the Skip worklist button.";
        let root_line = format!(
            "\nresolved_project_root={} (marker: resources/.worklist-authorization.json; if this is not the repo root, a stray marker file captured this subtree — remove that resources/.worklist-authorization.json)",
            root.display()
        );

        let v = claude_decide(serde_json::json!({
            "tool_name": "Bash",
            "tool_input": {"command": "rm stale.txt"},
            "cwd": root.to_string_lossy(),
        }));
        assert_eq!(v.decision, "deny");
        assert_eq!(body_of(&v), format!("{}{}", base, root_line));
        // Bash denials DO pass cwd to _trace_hook, and the trace target is the
        // 200-char command preview rather than the breadcrumb's `-`.
        assert_eq!(
            header_of(&v),
            format!(
                "[worklist-guard] tool=Bash target=rm stale.txt cwd={root} decision=deny reason=bash-write-no-coverage:token=rm:root={root}",
                root = root.display()
            )
        );

        let v = claude_decide(serde_json::json!({
            "tool_name": "Bash",
            "tool_input": {"command": "git push origin main"},
            "cwd": root.to_string_lossy(),
        }));
        assert_eq!(
            body_of(&v),
            format!(
                "{}{}\n  - This looks like a push. The user can click Push in the Commits tab; an agent push is allowed only in the 10-minute window after a gate commit (see judell/bram#283).",
                base, root_line
            )
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn message_parity_stale_worklist_version() {
        // python:1342-1371 (deny_stale_worklist_version), both `detail` arms.
        let root = managed_claude("msg-stale-version");
        let wl = root.join(WORKLIST_REL);
        std::fs::write(&wl, r#"{"version":1,"items":[]}"#).unwrap();

        let v = claude_decide(serde_json::json!({
            "tool_name": "Write",
            "tool_input": {
                "file_path": wl.to_string_lossy(),
                "content": r#"{"version":1,"items":[]}"#,
            },
            "cwd": root.to_string_lossy(),
        }));
        assert_eq!(v.reason, "stale-worklist-version");
        assert_eq!(
            body_of(&v),
            "Blocked: stale base on resources/worklist.json. You set version=1, but on-disk version is 1. Expected version=2.\n  - Re-read resources/worklist.json, base your edit on the current contents, and include the bumped version field on the write. This guards against concurrent-writer races between your propose / Edit and other agents or the /__worklist/mutate route."
        );

        let v = claude_decide(serde_json::json!({
            "tool_name": "Write",
            "tool_input": {"file_path": wl.to_string_lossy(), "content": r#"{"items":[]}"#},
            "cwd": root.to_string_lossy(),
        }));
        assert_eq!(
            body_of(&v),
            "Blocked: stale base on resources/worklist.json. Your write is missing the `version` field. On-disk version is 1; the new content must set version=2.\n  - Re-read resources/worklist.json, base your edit on the current contents, and include the bumped version field on the write. This guards against concurrent-writer races between your propose / Edit and other agents or the /__worklist/mutate route."
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn message_parity_inline_prose() {
        // python:1388-1409 (deny_inline_prose), including the `<no-id>` label
        // for an item with no usable id.
        let root = managed_claude("msg-inline-prose");
        let wl = root.join(WORKLIST_REL);
        std::fs::write(&wl, r#"{"version":1,"items":[]}"#).unwrap();
        let v = claude_decide(serde_json::json!({
            "tool_name": "Write",
            "tool_input": {
                "file_path": wl.to_string_lossy(),
                "content": r#"{"version":2,"items":[{"id":"a","status":"proposed","before":"x"},{"status":"proposed","after":"y"}]}"#,
            },
            "cwd": root.to_string_lossy(),
        }));
        assert_eq!(v.reason, "worklist-inline-prose");
        assert_eq!(
            body_of(&v),
            "Blocked: inline `before` / `after` on proposed worklist item(s) — prose must live in resources/worklist-drafts/<id>.md.\n  - item a: remove inline before/after; write prose to resources/worklist-drafts/a.md instead\n  - item <no-id>: remove inline before/after; write prose to resources/worklist-drafts/<no-id>.md instead\nDraft file format: `# Before` section then `# After` section, both in Markdown. The server merge surfaces the draft prose alongside the metadata in worklist.json."
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn message_parity_mechanical_worklist_change() {
        // python:1412-1444 (deny_mechanical_worklist_change), with both the
        // Removed and Status-changes detail lines present.
        let root = managed_claude("msg-mechanical");
        let wl = root.join(WORKLIST_REL);
        std::fs::write(
            &wl,
            r#"{"version":1,"items":[{"id":"a","status":"proposed"},{"id":"b","status":"proposed"}]}"#,
        )
        .unwrap();
        let v = claude_decide(serde_json::json!({
            "tool_name": "Write",
            "tool_input": {
                "file_path": wl.to_string_lossy(),
                "content": r#"{"version":2,"items":[{"id":"b","status":"applied"}]}"#,
            },
            "cwd": root.to_string_lossy(),
        }));
        assert_eq!(v.reason, "mechanical-worklist-change");
        assert_eq!(
            body_of(&v),
            "Blocked: mechanical worklist state changes must go through `POST /__worklist/mutate`, not a direct edit to `resources/worklist.json`.\n  - Direct worklist edits are for proposing items or refining their prose during iterate.\n  - Use mutate for `prune` and `advance` after a verified `drop:` / `approved:` turn.\n  - Removed item ids: \"a\" (status=proposed)\n  - Status changes: \"b\" (proposed->applied)\n  - Example: curl -4 -sS -X POST -d '{\"op\":\"prune\",\"ids\":[\"item-id\"]}' http://127.0.0.1:$(cat resources/.bram-port)/__worklist/mutate"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn message_parity_crossboundary_unsigned() {
        // python:1916-1934 — the signature deny, and python:1892-1909 for the
        // #176 antipattern, whose `Detected:` tail is `m.group(0).strip()`:
        // a whitespace opener is stripped, a `;` / `&&` / `||` opener is not.
        let v = claude_decide(serde_json::json!({
            "tool_name": "Bash",
            "tool_input": {"command": "gh issue comment 5 --body 'plain unsigned text'"},
            "cwd": "/",
        }));
        assert_eq!(v.reason, "crossboundary-unsigned");
        assert_eq!(
            body_of(&v),
            "This agent-authored forge artifact lacks the full repository-qualified signature.\nOpen the first line with:\n    <owner>'s <Agent> (<thread>, <model>, <os>, <machine>) speaking from the <Project> project (<origin-host>/<path>):\nSee conventions.md, 'Signing agent-authored forge artifacts' — every artifact, every comment, not just the first in a thread."
        );

        let at = '@';
        let v = claude_decide(serde_json::json!({
            "tool_name": "Bash",
            "tool_input": {"command": format!("echo hi && gh issue comment 5 --body {at}-")},
            "cwd": "/",
        }));
        assert_eq!(v.reason, "gh-body-at-antipattern");
        assert_eq!(
            body_of(&v),
            format!(
                "gh --body takes a literal string, not stdin or a file reference.\nUse --body-file - (stdin) or --body-file <path> instead.\nDetected: gh issue comment 5 --body {at}-"
            )
        );
        let v = claude_decide(serde_json::json!({
            "tool_name": "Bash",
            "tool_input": {"command": format!("echo hi;gh issue comment 5 --body {at}x.md")},
            "cwd": "/",
        }));
        // `@\S` consumes exactly one character, so the reported span stops at
        // `@x` — and the `;` opener survives `.strip()`.
        assert_eq!(
            body_of(&v).lines().last().unwrap(),
            format!("Detected: ;gh issue comment 5 --body {at}x")
        );
    }

    #[test]
    fn message_parity_subagent_and_mcp_denials() {
        // python:2247-2255 (Write/Edit wording, with the extra clause),
        // python:2087-2096 + 2179-2187 (the shorter Bash / MCP wording),
        // python:2137-2143 and python:2158-2164 (the two MCP-only denials).
        let root = managed_claude("msg-subagent");
        let wl = root.join(WORKLIST_REL);
        std::fs::write(&wl, r#"{"version":1,"items":[]}"#).unwrap();

        let v = claude_decide(serde_json::json!({
            "tool_name": "Write",
            "agent_id": "agent-7",
            "tool_input": {"file_path": wl.to_string_lossy(), "content": "{}"},
            "cwd": root.to_string_lossy(),
        }));
        assert_eq!(v.reason, "subagent-worklist-write");
        assert_eq!(
            body_of(&v),
            "Worklist proposals and claim edits (resources/worklist.json, resources/worklist-drafts/*) stay in the orchestrator's own turn. A delegated subagent cannot write them directly -- it can widen its own item's coverage, author new items, or edit claim state with no denial. See 'Delegating worklist items to subagents' in conventions.md and judell/bram#287."
        );

        let v = claude_decide(serde_json::json!({
            "tool_name": "Bash",
            "agent_id": "agent-7",
            "tool_input": {"command": "echo x > resources/worklist.json"},
            "cwd": root.to_string_lossy(),
        }));
        assert_eq!(v.reason, "subagent-worklist-write");
        assert_eq!(body_of(&v), SUBAGENT_WORKLIST_WRITE_BODY);

        let v = claude_decide(serde_json::json!({
            "tool_name": "mcp__fs__write_file",
            "tool_input": {"blob": "x"},
            "cwd": root.to_string_lossy(),
        }));
        assert_eq!(v.reason, "mcp-unrecognized-input");
        assert_eq!(
            body_of(&v),
            "mcp__fs__write_file blocked: this looks like a mutation, but the guard could not extract any file path from tool_input.\nIf this tool does not modify repository files (an external connector, for example), the user can authorize it by ending their message with \"just do it\" or clicking the Skip worklist button.\nOtherwise propose the change in resources/worklist.json first, or extend MCP_PATH_KEYS (src-tauri/src/guard_policy.rs) to recognize this tool's input shape."
        );
        // Python's trace target on this one branch is the empty string.
        assert!(
            header_of(&v).contains(" target= cwd="),
            "header: {}",
            header_of(&v)
        );

        let v = claude_decide(serde_json::json!({
            "tool_name": "mcp__fs__write_file",
            "tool_input": {"path": wl.to_string_lossy()},
            "cwd": root.to_string_lossy(),
        }));
        assert_eq!(v.reason, "mcp-worklist-write");
        assert_eq!(
            body_of(&v),
            "mcp__fs__write_file blocked: edits to resources/worklist.json must use Write/Edit (so the guard can validate prunes, the version bump, and inline prose) or /__worklist/mutate for mechanical transitions."
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn message_parity_subagent_lifecycle_call() {
        // python:2016-2024
        let root = managed_claude("msg-lifecycle");
        let v = claude_decide(serde_json::json!({
            "tool_name": "Bash",
            "agent_id": "agent-7",
            "tool_input": {"command": "curl -sS http://127.0.0.1:1/__worklist/mutate"},
            "cwd": root.to_string_lossy(),
        }));
        assert_eq!(v.reason, "subagent-lifecycle-call");
        assert_eq!(
            body_of(&v),
            "Worklist lifecycle calls (/__worklist/resolve, /__worklist/mutate, worklist-commit) stay in the orchestrator's own turn, after delegated subagents return. A subagent transcript cannot make them directly. See 'Delegating worklist items to subagents' in conventions.md."
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn message_parity_forge_sha_unresolved() {
        // python:1956-1964. cwd is a non-repo scratch dir, so `git cat-file`
        // exits nonzero and the verdict is `bad` with the SHA as its detail.
        let root = managed_claude("msg-forge-sha");
        let sha = "0123456789abcdef0123456789abcdef01234567";
        let v = claude_decide(serde_json::json!({
            "tool_name": "Bash",
            "tool_input": {
                "command": format!(
                    "gh issue comment 5 --body \"Jon's Claude (main thread, Opus 5) speaking from the Bram project (github.com/judell/bram):\\n\\nSee {sha}\""
                ),
            },
            "cwd": root.to_string_lossy(),
        }));
        assert_eq!(v.reason, format!("forge-sha-unresolved:{sha}"));
        assert_eq!(
            body_of(&v),
            format!("The body contains a full commit SHA that does not resolve in this repository:\n    {sha}\nA fabricated or rebase-orphaned SHA renders as an ordinary link and 404s silently. Resolve the real hash with `git rev-parse <short-sha>` (or `git log --oneline`) and retry. See judell/bram#277.")
        );
        let _ = std::fs::remove_dir_all(&root);
    }
}

// --- codex parity suite -------------------------------------------------------
//
// A port of `self_test()` in app/provider-hooks/codex-worklist-guard.py
// (lines 973-1198). Every Python assertion has a twin here, in source order,
// except the four covering `write_direct_edit_record` (lines 1098-1103): the
// shadow never writes, so that surface is replaced by a test asserting the
// decision is reproduced AND the record is NOT written. The judell/bram#299
// cases assert the NEW classification and are labelled.

#[cfg(test)]
mod codex_guard_policy_tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("bram-codex-policy-{}-{}", name, std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("create scratch dir");
        dir
    }

    /// Python `_self_test_replacement_patch` (lines 962-970).
    fn replacement_patch(old_content: &str, new_content: &str) -> String {
        let mut out = format!("*** Begin Patch\n*** Update File: {}\n@@\n", WORKLIST_REL);
        for line in old_content.split_inclusive('\n') {
            out.push('-');
            out.push_str(line);
        }
        for line in new_content.split_inclusive('\n') {
            out.push('+');
            out.push_str(line);
        }
        out.push_str("*** End Patch\n");
        out
    }

    fn pretty(v: &Value) -> String {
        serde_json::to_string_pretty(v).unwrap() + "\n"
    }

    // --- deny-reason derivation (python lines 974-981 + deny(), lines 172-190) --
    //
    // The Python `pre_tool_use_deny_response` shape is a stdout contract the
    // shadow deliberately does not emit; what carries over is `deny()`'s traced
    // reason, which is `message.splitlines()[0][:120]`.

    #[test]
    fn deny_reason_is_first_line_truncated_to_120() {
        assert_eq!(codex_deny_reason("one line"), "one line");
        assert_eq!(codex_deny_reason("first\nsecond\nthird"), "first");
        let long = "x".repeat(200);
        assert_eq!(codex_deny_reason(&long).chars().count(), 120);
        assert_eq!(codex_deny_reason(""), "blocked");
        // The four canonical first lines, pinned against the Python messages.
        assert_eq!(
            codex_deny_reason(&worklist_validation_error(
                &vec![("i1".to_string(), vec!["id".to_string()])],
                "apply_patch"
            )),
            "apply_patch blocked: proposed worklist item(s) violate draft-only rule."
        );
        assert!(codex_deny_reason(&mechanical_worklist_change_error(
            &[("i1".to_string(), "proposed".to_string())],
            &[],
            "apply_patch"
        ))
        .starts_with("apply_patch blocked: mechanical worklist state changes must go through"));
        assert!(
            codex_deny_reason(&stale_worklist_version_error(1, 1, true, "apply_patch"))
                .starts_with(
                "apply_patch blocked: stale base on resources/worklist.json. You set version=1,"
            )
        );
        // coverage_root_line opens with a newline, so it never reaches a reason.
        assert!(coverage_root_line(Path::new("/tmp")).starts_with('\n'));
    }

    // --- bash write / read corpus (python lines 983-1013) ----------------------

    #[test]
    fn codex_bash_write_commands_are_writes() {
        for c in [
            "echo x > out.txt",
            "printf x >> out.txt",
            "git commit -m test",
            "rm stale.txt",
            "echo hi > /dev/stdout",
            "cat > src-tauri/src/lib.rs",
            "cat > /tmp/b.md && git commit -m x",
        ] {
            assert!(codex_bash_writes(c), "{c}");
        }
    }

    #[test]
    fn codex_bash_read_commands_are_reads() {
        for c in [
            "ls -la",
            "git status --short",
            "curl -I https://example.com",
            "git ls-files x >/dev/null 2>&1",
            "echo hi > /dev/null",
            "echo hi >> /dev/zero",
            "cat > /tmp/body.md",
            "cat > /private/tmp/x/body.md",
        ] {
            assert!(!codex_bash_writes(c), "{c}");
        }
    }

    /// Not in the Python self-test, but the load-bearing difference between the
    /// two guards' `_BASH_WRITE_PATTERNS`: Codex carries no `gh issue <verb>`
    /// entry, so forge issue writes are simply not writes on this side (and
    /// there is no `forge_issue_only_write` exemption to compensate).
    #[test]
    fn codex_has_no_gh_issue_write_pattern() {
        for c in [
            "gh issue close 119 --repo judell/bram",
            "gh issue delete 5",
            "gh issue transfer 5 other/repo",
            "gh issue pin 5",
        ] {
            assert!(!codex_bash_writes(c), "{c}");
            assert!(bash_writes(c), "claude side still writes: {c}");
        }
    }

    // --- apply_patch reconstruction + validators (python lines 1015-1085) ------

    #[test]
    fn apply_patch_worklist_reconstruction_and_validators() {
        let root = scratch("patch");
        std::fs::create_dir_all(root.join("resources")).unwrap();

        let old_doc = serde_json::json!({
            "description": "",
            "items": [{"id": "existing", "status": "proposed", "file": "a.txt"}]
        });
        let old_content = pretty(&old_doc);
        std::fs::write(root.join(WORKLIST_REL), &old_content).unwrap();

        let new_item_doc = serde_json::json!({
            "description": "",
            "items": [
                {"id": "existing", "status": "proposed", "file": "a.txt"},
                {"id": "new-item", "status": "proposed", "file": "b.txt"}
            ]
        });
        let new_item_content = pretty(&new_item_doc);
        let applied = worklist_content_after_apply_patch(
            &root,
            &replacement_patch(&old_content, &new_item_content),
        );
        assert_eq!(applied.as_deref(), Some(new_item_content.as_str()));
        let applied = applied.unwrap();
        assert_eq!(
            worklist_items_violating_draft_only(&applied),
            Some(Vec::new())
        );
        assert_eq!(
            worklist_state_changes(
                &codex_items_by_id(&old_content),
                &codex_items_by_id(&applied)
            ),
            (Vec::new(), Vec::new())
        );

        // Inline prose on a new proposed item is rejected.
        let inline_doc = serde_json::json!({
            "description": "",
            "items": [
                {"id": "existing", "status": "proposed", "file": "a.txt"},
                {"id": "inline-item", "status": "proposed", "file": "b.txt",
                 "before": "old", "after": "new"}
            ]
        });
        let inline_content = pretty(&inline_doc);
        let inline_bad = worklist_items_violating_draft_only(&inline_content).unwrap();
        assert!(!inline_bad.is_empty());
        assert_eq!(inline_bad[0].0, "inline-item");
        // The patch-text validator also flags an apply_patch adding inline prose.
        let inline_patch_bad =
            patch_adds_violating_draft_only(&replacement_patch(&old_content, &inline_content));
        assert!(!inline_patch_bad.is_empty());
        assert!(inline_patch_bad[0].1.join(" ").contains("inline"));

        // A status transition is a mechanical change.
        let transitioned =
            old_content.replace("\"status\": \"proposed\"", "\"status\": \"applied\"");
        assert_eq!(
            worklist_state_changes(
                &codex_items_by_id(&old_content),
                &codex_items_by_id(&transitioned)
            ),
            (
                Vec::new(),
                vec![(
                    "existing".to_string(),
                    "proposed".to_string(),
                    "applied".to_string()
                )]
            )
        );

        let removed = pretty(&serde_json::json!({"description": "", "items": []}));
        assert_eq!(
            worklist_state_changes(
                &codex_items_by_id(&old_content),
                &codex_items_by_id(&removed)
            ),
            (
                vec![("existing".to_string(), "proposed".to_string())],
                Vec::new()
            )
        );

        // `_patch_removes_worklist_items` is the fallback when the post-patch
        // file cannot be rebuilt (not asserted in the Python self-test, but it
        // is the other half of the touches-worklist branch).
        let prune_patch = format!(
            "*** Begin Patch\n*** Update File: {}\n@@\n-    \"id\": \"existing\",\n*** End Patch\n",
            WORKLIST_REL
        );
        assert_eq!(
            patch_removes_worklist_items(&root, &prune_patch),
            vec![("existing".to_string(), "proposed".to_string())]
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn patch_targets_reads_both_patch_dialects() {
        let ti = serde_json::json!({
            "input": "*** Begin Patch\n*** Update File: app/a.txt\n*** Add File: app/b.txt\n\
        *** Delete File: app/c.txt   \n*** End Patch\n"
        });
        assert_eq!(
            patch_targets(&ti),
            vec!["app/a.txt", "app/b.txt", "app/c.txt"]
        );
        assert_eq!(
            patch_targets(&serde_json::json!({"patch": "--- a/x\n+++ b/app/d.txt\n"})),
            vec!["app/d.txt"]
        );
        assert!(patch_targets(&serde_json::json!({"content": "no patch here"})).is_empty());
        assert!(patch_targets(&serde_json::json!({})).is_empty());
    }

    // --- opt-out parity (python lines 1087-1103) -------------------------------

    #[test]
    fn codex_opt_out_phrase_parity() {
        assert!(has_opt_out("just do it"));
        assert!(!has_opt_out("Skip the worklist"));
        assert!(!has_opt_out("commit this directly"));
        assert!(!has_opt_out("looks good"));
        assert!(!has_opt_out("go ahead and merge"));
        assert!(!has_opt_out(""));
    }

    /// Replaces the Python self-test's four `write_direct_edit_record`
    /// assertions (lines 1098-1103). The shadow reproduces the DECISION on the
    /// opt-out path and writes nothing: the record the Python guard would have
    /// created is the one side effect this port must not have.
    #[test]
    fn user_prompt_opt_out_decides_without_writing_the_record() {
        let root = scratch("prompt");
        std::fs::create_dir_all(root.join("resources")).unwrap();
        std::fs::write(root.join(AUTH_REL), "{}").unwrap();

        let v = shadow_worklist_decision(
            "codex-rs",
            &serde_json::json!({
                "hook_event_name": "UserPromptSubmit",
                "prompt": "patch the tooltip, just do it",
                "cwd": root.to_string_lossy(),
            }),
        )
        .unwrap();
        assert_eq!(
            (v.decision.as_str(), v.reason.as_str()),
            ("allow", "passed-checks")
        );
        assert_eq!(
            std::fs::read_to_string(root.join(AUTH_REL)).unwrap(),
            "{}",
            "shadow wrote a direct-edit record"
        );

        // A change-shaped prompt injects the reminder, which the Python guard
        // emits with NO trace line at all.
        let v = shadow_worklist_decision(
            "codex-rs",
            &serde_json::json!({
                "hook_event_name": "UserPromptSubmit",
                "prompt": "please fix the tooltip so it stops clipping in the footer",
                "cwd": root.to_string_lossy(),
            }),
        )
        .unwrap();
        assert_eq!(
            (v.decision.as_str(), v.reason.as_str()),
            ("allow", "no-trace:gate-reminder")
        );

        // Short / non-change prompts pass through.
        let v = shadow_worklist_decision(
            "codex-rs",
            &serde_json::json!({
                "hook_event_name": "UserPromptSubmit",
                "prompt": "what is in the worklist",
                "cwd": root.to_string_lossy(),
            }),
        )
        .unwrap();
        assert_eq!(
            (v.decision.as_str(), v.reason.as_str()),
            ("allow", "passed-checks")
        );

        // Unmanaged cwd: never inspected.
        let bare = scratch("prompt-bare");
        let v = shadow_worklist_decision(
            "codex-rs",
            &serde_json::json!({
                "hook_event_name": "UserPromptSubmit",
                "prompt": "please fix the tooltip so it stops clipping in the footer",
                "cwd": bare.to_string_lossy(),
            }),
        )
        .unwrap();
        assert_eq!(
            (v.decision.as_str(), v.reason.as_str()),
            ("allow", "passed-checks")
        );

        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&bare);
    }

    #[test]
    fn change_request_heuristic_mirrors_the_keyword_regex() {
        assert!(!looks_like_change_request("fix it")); // < 30 chars
        assert!(looks_like_change_request(
            "could you take a look at the footer alignment there"
        ));
        assert!(looks_like_change_request(
            "the tooltip is broken on the second row of the table"
        ));
        assert!(!looks_like_change_request(
            "where does the projection broadcast happen in this codebase"
        ));
        // `\b` on both ends: an embedded stem does not match.
        assert!(!looks_like_change_request(
            "the address book listing shows nothing at all for me here"
        ));
    }

    // --- signature gates (python lines 1105-1158) ------------------------------
    //
    // Byte-identical to the Claude guard's, and reused from the shared core;
    // pinned here so a change to either Python copy shows up on both sides.

    #[test]
    fn codex_crossboundary_signature_gates() {
        let td = scratch("codex-sig");
        let signed = "Jon's Claude (main thread, Opus 5) speaking from the Bram project (github.com/judell/bram):\n\nBody.";
        let unsigned = "Vendored the build; the tooltip renders.";
        let verdict = |cmd: &str| crossboundary_signature_verdict(cmd, &td).0;

        assert_eq!(verdict("gh issue view 12 --repo xmlui-org/xmlui"), "skip");
        assert_eq!(verdict("ls -la"), "skip");
        assert_eq!(
            verdict(&format!("gh issue comment 5 --body \"{}\"", unsigned)),
            "unsigned"
        );
        assert_eq!(
            verdict(&format!("gh issue comment 5 --body \"{}\"", signed)),
            "signed"
        );
        assert_eq!(
            verdict(&format!(
                "gh issue comment 5 --repo judell/bram --body \"{}\"",
                unsigned
            )),
            "unsigned"
        );
        assert!(!td.join(".git").join("config").exists());
        assert_eq!(
            verdict(&format!(
                "gh issue comment 5 --repo xmlui-org/xmlui --body \"{}\"",
                signed
            )),
            "signed"
        );
        assert_eq!(
            verdict(&format!(
                "gh issue comment 5 --repo xmlui-org/xmlui --body \"{}\"",
                unsigned
            )),
            "unsigned"
        );
        assert_eq!(
            verdict(&format!("gh pr comment 9 --body \"{}\"", unsigned)),
            "unsigned"
        );
        assert_eq!(
            verdict(&format!("glab issue note 3 -m \"{}\"", unsigned)),
            "unsigned"
        );
        assert_eq!(verdict("gh issue comment 5 --body-file -"), "unparsed");
        assert_eq!(
            verdict("gh issue comment 5 --body-file /nope/missing.md"),
            "unparsed"
        );
        assert_eq!(verdict("gh issue comment 5"), "unparsed");
        assert_eq!(verdict("gh issue close 5"), "skip");

        let body_path = td.join("comment.md");
        std::fs::write(&body_path, signed).unwrap();
        assert_eq!(
            crossboundary_signature_verdict(
                &format!("gh issue comment 5 --body-file {}", body_path.display()),
                &td
            ),
            ("signed", "body-file")
        );

        assert!(body_is_signed(
            "_Jon's Codex (main thread, GPT-5.6-sol) speaking from the XMLUI project (github.com/xmlui-org/xmlui):_",
            &td
        ));
        assert!(body_is_signed(
            "> **Jon's Claude (subagent, Opus 5) speaking from the Bram project (github.com/judell/bram):**",
            &td
        ));
        assert!(!body_is_signed(
            "Bram side — a correction to my green light.",
            &td
        ));
        assert!(!body_is_signed("", &td));
        let _ = std::fs::remove_dir_all(&td);
    }

    // --- pending-intent gate (python lines 1160-1198) --------------------------

    #[test]
    fn intent_write_verdict_gate() {
        let root = scratch("intent");
        std::fs::create_dir_all(root.join("resources")).unwrap();
        let intent_path = root.join(WORKLIST_INTENT_REL);

        assert_eq!(
            intent_write_verdict(&root),
            ("allow", IntentDetail::NoPending)
        );

        std::fs::write(
            &intent_path,
            serde_json::json!({"nonce": "n1", "route": "worklist-mutate", "body": {}}).to_string(),
        )
        .unwrap();
        let (verdict, detail) = intent_write_verdict(&root);
        assert_eq!(verdict, "deny");
        match &detail {
            IntentDetail::Pending {
                nonce,
                route,
                age_seconds,
            } => {
                assert_eq!(nonce.as_deref(), Some("n1"));
                assert_eq!(route.as_deref(), Some("worklist-mutate"));
                assert!((*age_seconds as f64) < INTENT_STALE_SECONDS);
            }
            other => panic!("expected Pending, got {:?}", other),
        }

        // Backdated mtime -> allow, traced as an overwrite rather than a
        // collision. `os.utime` has no std equivalent; `touch -t` is the port.
        let touched = std::process::Command::new("touch")
            .arg("-t")
            .arg("202001010000")
            .arg(&intent_path)
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if touched {
            assert_eq!(
                intent_write_verdict(&root),
                ("allow", IntentDetail::StaleOverwrite)
            );
        }

        // Unparsable but FRESH -> deny, with nonce/route reported as None.
        std::fs::write(&intent_path, "not json").unwrap();
        let (verdict, detail) = intent_write_verdict(&root);
        assert_eq!(verdict, "deny");
        match &detail {
            IntentDetail::Pending { nonce, route, .. } => {
                assert!(nonce.is_none() && route.is_none());
            }
            other => panic!("expected Pending, got {:?}", other),
        }
        let reason = codex_deny_reason(&intent_pending_message("Bash", &detail));
        assert!(
            reason.starts_with(
                "Bash blocked: resources/.worklist-intent.json already holds a pending \
request (route=None, nonce=None, age=0s)"
            ),
            "reason: {reason}"
        );
        assert_eq!(reason.chars().count(), 120);
        let _ = std::fs::remove_dir_all(&root);
    }

    // --- judell/bram#299 inheritance ------------------------------------------

    #[test]
    fn issue_299_codex_inherits_all_three_divergences() {
        // Case 1: pure forge reads. This guard never had a `gh` write pattern,
        // so the predicate changes no verdict here — pinned so a future
        // widening cannot silently recapture it.
        for c in [
            "gh issue list",
            "gh issue list --state all --json number,title,state,updatedAt --limit 200",
            "gh issue view 299 --json title,body",
            "glab issue list --state opened",
        ] {
            assert!(forge_read_command(c), "{c}");
            assert!(!codex_bash_writes(c), "{c}");
        }
        assert!(codex_bash_writes("gh issue list && git commit -m x"));

        // Case 2: inline `python -c` is classified on what the script does.
        for c in [
            "python -c \"print(1)\"",
            "python3 -c 'import sys; print(sys.version)'",
        ] {
            assert!(!codex_bash_writes(c), "{c}");
        }
        for c in [
            "python -c \"open('x', 'w').write('x')\"",
            "python3 -c \"import shutil; shutil.rmtree('x')\"",
            "python3 -c $SCRIPT",
        ] {
            assert!(codex_bash_writes(c), "{c}");
        }

        // Case 3: a `>` inside quotes is a comparison, not a redirect.
        for c in [
            "awk '$1 >= \"2026-08-28T06:16\"' file.txt",
            "jq '.[] | select(.n > 5)' data.json",
            "grep -E \"a > b\" file",
        ] {
            assert!(!codex_bash_writes(c), "{c}");
            assert!(!has_redirect(c), "{c}");
        }
        assert!(codex_bash_writes("echo x > out.txt"));
    }

    // --- codex-specific helpers ------------------------------------------------

    #[test]
    fn codex_helpers_match_the_python_predicates() {
        assert!(is_worklist_citation("resources/worklist-citations/x.json"));
        assert!(!is_worklist_citation(
            "resources/worklist-citations/sub/x.json"
        ));
        assert!(!is_worklist_citation("resources/worklist-citations/x.md"));
        assert!(is_coordination_file(WORKLIST_INTENT_REL));
        assert!(is_coordination_file(WORKLIST_RESULT_REL));
        assert!(!is_coordination_file(WORKLIST_REL));
        // Codex normalize_target joins against the PROJECT cwd, not the process cwd.
        let root = Path::new("/tmp/proj");
        assert_eq!(
            codex_normalize_target(root, "app/x.txt").as_deref(),
            Some("app/x.txt")
        );
        assert_eq!(
            codex_normalize_target(root, "/tmp/proj/app/x.txt").as_deref(),
            Some("app/x.txt")
        );
        assert_eq!(codex_normalize_target(root, "/etc/hosts"), None);
        assert_eq!(
            codex_normalize_target(root, "/tmp/proj").as_deref(),
            Some("")
        );
        assert_eq!(codex_normalize_target(root, ""), None);
        // Python `.splitlines()` parity for the patch reader.
        assert_eq!(py_splitlines("a\nb\r\nc\rd"), vec!["a", "b", "c", "d"]);
        assert_eq!(py_splitlines("a\n"), vec!["a"]);
        assert!(py_splitlines("").is_empty());
        // items_by_id skips blank/non-string ids instead of collapsing the map.
        let text = r#"{"items":[{"id":"a"},{"no":"id"},{"id":""},{"id":"b"}]}"#;
        let m = codex_items_by_id(text);
        assert_eq!(
            m.iter().map(|(k, _)| k.as_str()).collect::<Vec<_>>(),
            vec!["a", "b"]
        );
        assert!(items_by_id(text).is_none(), "claude side collapses");
    }

    #[test]
    fn codex_fresh_bypass_reads_snake_case_only() {
        let root = scratch("bypass");
        std::fs::create_dir_all(root.join("resources")).unwrap();
        // camelCase issuedAtMs is NOT read by this guard: with no snake_case
        // field the record reads as issued at epoch 0, hence stale.
        std::fs::write(
            root.join(AUTH_REL),
            serde_json::json!({"kind": "direct-edit", "paths": ["*"], "issuedAtMs": now_ms()})
                .to_string(),
        )
        .unwrap();
        assert!(!codex_fresh_bypass(&root, "any/path"));
        assert!(fresh_bypass(&root, "any/path"), "claude side accepts it");

        std::fs::write(
            root.join(AUTH_REL),
            serde_json::json!({"kind": "direct-edit", "paths": ["*"], "issued_at_ms": now_ms()})
                .to_string(),
        )
        .unwrap();
        assert!(codex_fresh_bypass(&root, "any/path"));

        std::fs::write(
            root.join(AUTH_REL),
            serde_json::json!({
                "kind": "direct-edit", "paths": ["app/x.txt"], "issued_at_ms": now_ms()
            })
            .to_string(),
        )
        .unwrap();
        assert!(codex_fresh_bypass(&root, "app/x.txt"));
        assert!(!codex_fresh_bypass(&root, "app/y.txt"));

        std::fs::write(
            root.join(AUTH_REL),
            serde_json::json!({
                "kind": "direct-edit", "paths": ["*"],
                "issued_at_ms": now_ms() - BYPASS_TTL_MS - 60_000.0
            })
            .to_string(),
        )
        .unwrap();
        assert!(!codex_fresh_bypass(&root, "any/path"));
        let _ = std::fs::remove_dir_all(&root);
    }

    // --- pipeline-level checks -------------------------------------------------

    fn managed(name: &str) -> PathBuf {
        let root = scratch(name);
        std::fs::create_dir_all(root.join("resources")).unwrap();
        std::fs::create_dir_all(root.join("app")).unwrap();
        std::fs::write(root.join(AUTH_REL), "{}").unwrap();
        root
    }

    fn decide(root: &Path, tool: &str, ti: Value) -> ShadowVerdict {
        shadow_worklist_decision(
            "codex-rs",
            &serde_json::json!({
                "hook_event_name": "PreToolUse",
                "tool_name": tool,
                "tool_input": ti,
                "cwd": root.to_string_lossy(),
            }),
        )
        .unwrap()
    }

    #[test]
    fn unmanaged_cwd_allows_everything() {
        let root = scratch("unmanaged");
        let v = decide(&root, "Bash", serde_json::json!({"command": "rm -rf x"}));
        assert_eq!(
            (v.decision.as_str(), v.reason.as_str()),
            ("allow", "passed-checks")
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn codex_bash_pipeline_branches() {
        let root = managed("codex-bash");

        let v = decide(&root, "Bash", serde_json::json!({"command": "ls -la"}));
        assert_eq!(
            (v.decision.as_str(), v.reason.as_str()),
            ("allow", "passed-checks")
        );

        let v = decide(
            &root,
            "Bash",
            serde_json::json!({"command": "git ls-files x >/dev/null 2>&1"}),
        );
        assert_eq!(
            (v.decision.as_str(), v.reason.as_str()),
            ("allow", "bash-write-nonrepo-target")
        );

        let v = decide(
            &root,
            "Bash",
            serde_json::json!({"command": "rm stale.txt"}),
        );
        assert_eq!(v.decision, "deny");
        assert!(
            v.reason.starts_with(
                "Bash blocked: this command writes to the filesystem, and \
resources/worklist.json has no proposed"
            ),
            "reason: {}",
            v.reason
        );
        assert_eq!(v.reason.chars().count(), 120);

        // Any coverage at all opens the Bash gate.
        std::fs::write(
            root.join(WORKLIST_REL),
            serde_json::json!({
                "version": 1,
                "items": [{"id": "i1", "status": "proposed", "files": ["app/x.txt"]}]
            })
            .to_string(),
        )
        .unwrap();
        let v = decide(
            &root,
            "Bash",
            serde_json::json!({"command": "rm stale.txt"}),
        );
        assert_eq!(
            (v.decision.as_str(), v.reason.as_str()),
            ("allow", "passed-checks")
        );
        std::fs::remove_file(root.join(WORKLIST_REL)).unwrap();

        // The drafts substring and the intent channel are lifecycle writes.
        let v = decide(
            &root,
            "Bash",
            serde_json::json!({"command": "echo x > resources/worklist-drafts/a.md"}),
        );
        assert_eq!(
            (v.decision.as_str(), v.reason.as_str()),
            ("allow", "passed-checks")
        );

        let v = decide(
            &root,
            "Bash",
            serde_json::json!({"command": "echo '{}' > resources/.worklist-intent.json"}),
        );
        assert_eq!(
            (v.decision.as_str(), v.reason.as_str()),
            ("allow", "passed-checks")
        );

        std::fs::write(root.join(WORKLIST_INTENT_REL), "{\"nonce\":\"n9\"}").unwrap();
        let v = decide(
            &root,
            "Bash",
            serde_json::json!({"command": "echo '{}' > resources/.worklist-intent.json"}),
        );
        assert_eq!(v.decision, "deny");
        assert!(
            v.reason.starts_with(
                "Bash blocked: resources/.worklist-intent.json already holds a pending"
            ),
            "reason: {}",
            v.reason
        );
        std::fs::remove_file(root.join(WORKLIST_INTENT_REL)).unwrap();

        // gh --body @ still denies, ahead of everything else.
        let v = decide(
            &root,
            "Bash",
            serde_json::json!({"command": "gh issue comment 5 --body @body.md"}),
        );
        assert_eq!(
            (v.decision.as_str(), v.reason.as_str()),
            (
                "deny",
                "gh --body takes a literal string, not stdin or a file reference."
            )
        );

        // Unsigned forge write.
        let v = decide(
            &root,
            "Bash",
            serde_json::json!({"command": "gh issue comment 5 --body \"no signature here\""}),
        );
        assert_eq!(v.decision, "deny");
        assert!(v.reason.starts_with(
            "This agent-authored forge artifact lacks the full repository-qualified signature"
        ));

        // A push with a fresh consumed approval rides the grace.
        std::fs::write(
            root.join(AUTH_REL),
            serde_json::json!({"kind": "approved", "consumedAtMs": now_ms()}).to_string(),
        )
        .unwrap();
        let v = decide(&root, "Bash", serde_json::json!({"command": "git push"}));
        assert_eq!(
            (v.decision.as_str(), v.reason.as_str()),
            ("allow", "post-commit-push-grace")
        );
        std::fs::write(root.join(AUTH_REL), "{}").unwrap();

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn codex_apply_patch_pipeline_branches() {
        let root = managed("codex-patch-pipe");

        // Unparseable patch payload.
        let v = decide(
            &root,
            "apply_patch",
            serde_json::json!({"input": "nothing"}),
        );
        assert_eq!(v.decision, "deny");
        assert!(
            v.reason
                .starts_with("apply_patch blocked: could not parse target file(s)"),
            "reason: {}",
            v.reason
        );

        // Uncovered project file.
        let patch = "*** Begin Patch\n*** Update File: app/x.txt\n@@\n-a\n+b\n*** End Patch\n";
        let v = decide(&root, "apply_patch", serde_json::json!({"input": patch}));
        assert_eq!(v.decision, "deny");
        assert_eq!(v.target, "app/x.txt");
        assert!(
            v.reason
                .starts_with("apply_patch blocked: app/x.txt is not covered by any proposed"),
            "reason: {}",
            v.reason
        );

        // Covered by a proposed item. The worklist file is newline-terminated
        // because `replacement_patch` is a faithful port of the Python helper,
        // which builds one patch line per `splitlines(True)` chunk.
        std::fs::write(
            root.join(WORKLIST_REL),
            serde_json::json!({
                "version": 1,
                "items": [{"id": "i1", "status": "proposed", "files": ["app/x.txt"]}]
            })
            .to_string()
                + "\n",
        )
        .unwrap();
        let v = decide(&root, "apply_patch", serde_json::json!({"input": patch}));
        assert_eq!(
            (v.decision.as_str(), v.reason.as_str()),
            ("allow", "passed-checks")
        );

        // Drafts, citations, and the result file are exempt without coverage.
        for (rel, label) in [
            ("resources/worklist-drafts/i1.md", "draft"),
            ("resources/worklist-citations/i1.json", "citation"),
            (WORKLIST_RESULT_REL, "result"),
        ] {
            let p = format!(
                "*** Begin Patch\n*** Update File: {}\n@@\n-a\n+b\n*** End Patch\n",
                rel
            );
            let v = decide(&root, "apply_patch", serde_json::json!({"input": p}));
            assert_eq!(
                (v.decision.as_str(), v.reason.as_str()),
                ("allow", "passed-checks"),
                "{label}"
            );
        }

        // A patch that prunes an item is a mechanical change.
        let old = std::fs::read_to_string(root.join(WORKLIST_REL)).unwrap();
        let prune = replacement_patch(
            &old,
            &(serde_json::json!({"version": 2, "items": []}).to_string() + "\n"),
        );
        let v = decide(&root, "apply_patch", serde_json::json!({"input": prune}));
        assert_eq!(v.decision, "deny");
        assert!(
            v.reason
                .starts_with("apply_patch blocked: mechanical worklist state changes"),
            "reason: {}",
            v.reason
        );

        // A stale version bump.
        let stale = replacement_patch(
            &old,
            &(serde_json::json!({
                "version": 1,
                "items": [
                    {"id": "i1", "status": "proposed", "files": ["app/x.txt"]},
                    {"id": "i2", "status": "proposed", "files": ["app/y.txt"]}
                ]
            })
            .to_string()
                + "\n"),
        );
        let v = decide(&root, "apply_patch", serde_json::json!({"input": stale}));
        assert_eq!(v.decision, "deny");
        assert!(
            v.reason
                .starts_with("apply_patch blocked: stale base on resources/worklist.json."),
            "reason: {}",
            v.reason
        );

        // A correct bump authors cleanly.
        let good = replacement_patch(
            &old,
            &(serde_json::json!({
                "version": 2,
                "items": [
                    {"id": "i1", "status": "proposed", "files": ["app/x.txt"]},
                    {"id": "i2", "status": "proposed", "files": ["app/y.txt"]}
                ]
            })
            .to_string()
                + "\n"),
        );
        let v = decide(&root, "apply_patch", serde_json::json!({"input": good}));
        assert_eq!(
            (v.decision.as_str(), v.reason.as_str()),
            ("allow", "passed-checks")
        );

        // Inline prose on a proposed item.
        let prose = replacement_patch(
            &old,
            &(serde_json::json!({
                "version": 2,
                "items": [{"id": "i1", "status": "proposed", "files": ["app/x.txt"], "before": "x"}]
            })
            .to_string()
                + "\n"),
        );
        let v = decide(&root, "apply_patch", serde_json::json!({"input": prose}));
        assert_eq!(
            (v.decision.as_str(), v.reason.as_str()),
            (
                "deny",
                "apply_patch blocked: proposed worklist item(s) violate draft-only rule."
            )
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn issue_309_codex_worktree_pipeline_maps_only_coverage() {
        let root = managed("codex-worktree");
        std::fs::write(
            root.join(WORKLIST_REL),
            serde_json::json!({
                "version": 1,
                "items": [{
                    "id": "i1",
                    "status": "proposed",
                    "files": ["app/x.txt", "components"]
                }]
            })
            .to_string()
                + "\n",
        )
        .unwrap();

        let patch = |rel: &str| {
            format!(
                "*** Begin Patch\n*** Update File: {}\n@@\n-a\n+b\n*** End Patch\n",
                rel
            )
        };

        let v = decide(
            &root,
            "apply_patch",
            serde_json::json!({
                "input": patch(".claude/worktrees/agent-a/app/x.txt")
            }),
        );
        assert_eq!(
            (v.decision.as_str(), v.reason.as_str()),
            ("allow", "passed-checks")
        );
        assert_eq!(v.target, ".claude/worktrees/agent-a/app/x.txt");

        let v = decide(
            &root,
            "apply_patch",
            serde_json::json!({
                "input": patch(
                    ".claude/worktrees/agent-a/components/nested/y.xmlui"
                )
            }),
        );
        assert_eq!(
            (v.decision.as_str(), v.reason.as_str()),
            ("allow", "passed-checks")
        );

        let v = decide(
            &root,
            "apply_patch",
            serde_json::json!({
                "input": patch(".claude/worktrees/agent-a/app/y.txt")
            }),
        );
        assert_eq!(v.decision, "deny");
        assert!(
            v.reason.ends_with(":worktree=agent-a"),
            "reason: {}",
            v.reason
        );
        assert_eq!(v.target, ".claude/worktrees/agent-a/app/y.txt");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn codex_mcp_pipeline_branches() {
        let root = managed("codex-mcp");

        let v = decide(
            &root,
            "mcp__filesystem__read_text_file",
            serde_json::json!({"path": "app/x.txt"}),
        );
        assert_eq!(
            (v.decision.as_str(), v.reason.as_str()),
            ("allow", "passed-checks")
        );

        let v = decide(
            &root,
            "mcp__filesystem__write_file",
            serde_json::json!({"contents": "x"}),
        );
        assert_eq!(v.decision, "deny");
        assert!(
            v.reason
                .starts_with("mcp__filesystem__write_file blocked: looks like a mutation"),
            "reason: {}",
            v.reason
        );

        // issue-360: a fresh wildcard direct-edit grant (snake_case
        // issued_at_ms — the only spelling the Codex arm reads) releases the
        // zero-path deny; the trace target names the released tool.
        std::fs::write(
            root.join(DIRECT_EDIT_REL),
            serde_json::json!({
                "kind": "direct-edit", "paths": ["*"], "issued_at_ms": now_ms()
            })
            .to_string(),
        )
        .unwrap();
        let v = decide(
            &root,
            "mcp__filesystem__write_file",
            serde_json::json!({"contents": "x"}),
        );
        assert_eq!(
            (v.decision.as_str(), v.reason.as_str()),
            ("allow", "mcp-no-path-bypass")
        );
        assert_eq!(v.target, "mcp__filesystem__write_file");
        std::fs::remove_file(root.join(DIRECT_EDIT_REL)).unwrap();

        let v = decide(
            &root,
            "mcp__filesystem__write_file",
            serde_json::json!({"path": root.join("app/y.txt").to_string_lossy()}),
        );
        assert_eq!(v.decision, "deny");
        assert!(
            v.reason
                .starts_with("mcp__filesystem__write_file blocked: app/y.txt is not covered"),
            "reason: {}",
            v.reason
        );

        // Unlike the Claude guard, a worklist.json write via MCP is validated
        // rather than denied outright.
        let v = decide(
            &root,
            "mcp__filesystem__write_file",
            serde_json::json!({
                "path": root.join(WORKLIST_REL).to_string_lossy(),
                "content": serde_json::json!({
                    "version": 1,
                    "items": [{"id": "i1", "status": "proposed", "files": ["app/x.txt"]}]
                }).to_string(),
            }),
        );
        assert_eq!(
            (v.decision.as_str(), v.reason.as_str()),
            ("allow", "passed-checks")
        );

        // No inspectable content -> the mutate-route denial.
        let v = decide(
            &root,
            "mcp__filesystem__write_file",
            serde_json::json!({"path": root.join(WORKLIST_REL).to_string_lossy()}),
        );
        assert_eq!(v.decision, "deny");
        assert!(
            v.reason.starts_with(
                "mcp__filesystem__write_file blocked: worklist edits that advance status"
            ),
            "reason: {}",
            v.reason
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn unknown_tool_names_pass_through() {
        let root = managed("codex-other");
        let v = decide(&root, "Read", serde_json::json!({"file_path": "x"}));
        assert_eq!(
            (v.decision.as_str(), v.reason.as_str()),
            ("allow", "passed-checks")
        );
        let _ = std::fs::remove_dir_all(&root);
    }
}
