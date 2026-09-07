#!/usr/bin/env python3
"""Build, save, hydrate, and launch full-fidelity synthetic Bram instances.

The generated repository is deliberately disposable: it has a marker, a local
``demo/base`` branch, no remotes, and parked ``scenario/<name>`` branches.  A
scenario branch ends at a pending-work commit whose metadata names its clean
boundary and claim trees.  ``use`` checks out that commit detached, resets it
mixed to the clean boundary, and recreates the scenario's local claim refs.
The parked branch therefore survives while Bram sees the intended dirty tree.
"""

from __future__ import annotations

import argparse
import atexit
import contextlib
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import tempfile
import time
from typing import Any, Iterable, Iterator, Mapping, Sequence


SOURCE_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_REPO = SOURCE_ROOT.parent / "bram-demo-instance"
MARKER = ".bram-demo.json"
SCENARIO_META = ".bram-demo-scenario.json"
WORKLIST = "resources/worklist.json"
CLAIMS = "resources/.claim-intervals.json"
AUTH = "resources/.worklist-authorization.json"
RUNTIME_DIR = "bram-demo"
FORMAT_VERSION = 1
SCENARIO_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")

AGENT_ENV_KEYS = (
    "CLAUDE_CODE_CHILD_SESSION",
    "CLAUDE_CODE_SESSION_ID",
    "CLAUDE_CODE_BRIDGE_SESSION_ID",
    "CLAUDE_CODE_MESSAGING_SOCKET",
    "CLAUDE_CODE_MESSAGING_TOKEN",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_CODE_EXECPATH",
)

STARTERS = (
    "disjoint-entanglement",
    "dependency",
    "supersession",
    "unattributed",
    "many-claimants",
    "expired-authorization",
)

_LAUNCHED_PROCESSES: dict[int, subprocess.Popen[bytes]] = {}


def _release_process_handles_at_exit() -> None:
    # A launch is intentionally longer-lived than this short CLI invocation.
    # Mark the detached handle as released so Python does not warn that the
    # deliberately surviving process was abandoned. A same-process test/host
    # uses stop_demo(), which removes and waits for the real Popen first.
    for proc in _LAUNCHED_PROCESSES.values():
        proc.returncode = 0


atexit.register(_release_process_handles_at_exit)


class DemoError(RuntimeError):
    """A safe, user-facing refusal or fixture error."""


def starter_seed(starter: str, prefix: str) -> tuple[str, str]:
    seeds = {
        "disjoint-entanglement": (
            f"demo/{prefix}.txt",
            "top: base\n" + "middle\n" * 8 + "bottom: base\n",
        ),
        "dependency": (f"demo/{prefix}.txt", "pipeline = base\n"),
        "supersession": (f"demo/{prefix}.txt", "message: stable\n"),
        "unattributed": (f"demo/{prefix}.txt", "owner: none\n"),
        "many-claimants": (f"demo/{prefix}.txt", "shared: base\n"),
        "expired-authorization": (
            f"demo/{prefix}.txt",
            "authorization: waiting\n",
        ),
    }
    try:
        return seeds[starter]
    except KeyError as exc:
        raise DemoError(f"unknown starter {starter!r}; choose from {', '.join(STARTERS)}") from exc


def _json_bytes(value: Any) -> bytes:
    return (json.dumps(value, indent=2, sort_keys=True) + "\n").encode("utf-8")


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(_json_bytes(value))


def read_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise DemoError(f"cannot read {path}: {exc}") from exc
    if not isinstance(value, dict):
        raise DemoError(f"expected a JSON object in {path}")
    return value


def run_git(
    repo: Path,
    *args: str,
    env: Mapping[str, str] | None = None,
    check: bool = True,
    input_text: str | None = None,
) -> str:
    merged = os.environ.copy()
    if env:
        merged.update(env)
    proc = subprocess.run(
        ["git", "-C", str(repo), *args],
        input=input_text,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=merged,
        check=False,
    )
    if check and proc.returncode:
        detail = proc.stderr.strip() or proc.stdout.strip()
        raise DemoError(f"git {' '.join(args)} failed: {detail}")
    return proc.stdout.strip()


def scenario_ref(name: str) -> str:
    if not SCENARIO_RE.fullmatch(name):
        raise DemoError(
            "scenario names may contain letters, digits, '.', '_', and '-' only"
        )
    return f"refs/heads/scenario/{name}"


def _dangerous_roots() -> set[Path]:
    roots = {Path('/').resolve(), Path.home().resolve(), SOURCE_ROOT.resolve()}
    if os.name == "nt":
        roots.add(Path(Path.cwd().anchor).resolve())
    return roots


def _assert_safe_location(repo: Path) -> Path:
    resolved = repo.expanduser().resolve()
    if resolved in _dangerous_roots():
        raise DemoError(f"refusing unsafe demo target: {resolved}")
    return resolved


def validate_demo(repo: Path) -> Path:
    repo = _assert_safe_location(repo)
    marker_path = repo / MARKER
    if not marker_path.is_file():
        raise DemoError(
            f"refusing to mutate {repo}: missing {MARKER} synthetic-repo marker"
        )
    marker = read_json(marker_path)
    if marker.get("kind") != "bram-synthetic-demo" or marker.get("format") != FORMAT_VERSION:
        raise DemoError(f"refusing {repo}: unrecognized {MARKER}")
    top = run_git(repo, "rev-parse", "--show-toplevel")
    if Path(top).resolve() != repo:
        raise DemoError(f"refusing nested or mismatched git root: {top}")
    remotes = run_git(repo, "remote").splitlines()
    if remotes:
        raise DemoError(
            f"refusing demo repo with upstream/remotes ({', '.join(remotes)})"
        )
    return repo


def _fixed_git_env(step: int = 0) -> dict[str, str]:
    stamp = 1_700_000_000 + step
    return {
        "GIT_AUTHOR_NAME": "Bram demo",
        "GIT_AUTHOR_EMAIL": "demo@bram.invalid",
        "GIT_COMMITTER_NAME": "Bram demo",
        "GIT_COMMITTER_EMAIL": "demo@bram.invalid",
        "GIT_AUTHOR_DATE": f"@{stamp} +0000",
        "GIT_COMMITTER_DATE": f"@{stamp} +0000",
    }


def initialize_repo(repo: Path) -> Path:
    repo = _assert_safe_location(repo)
    if repo.exists() and any(repo.iterdir()):
        if (repo / MARKER).is_file():
            return validate_demo(repo)
        raise DemoError(f"refusing non-empty, unmarked directory: {repo}")
    repo.mkdir(parents=True, exist_ok=True)
    proc = subprocess.run(
        ["git", "init", "-q", "-b", "demo/base", str(repo)],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if proc.returncode:
        run_git(repo, "init", "-q")
        run_git(repo, "checkout", "-q", "-b", "demo/base")
    run_git(repo, "config", "user.name", "Bram demo")
    run_git(repo, "config", "user.email", "demo@bram.invalid")

    write_json(
        repo / MARKER,
        {
            "format": FORMAT_VERSION,
            "kind": "bram-synthetic-demo",
            "warning": "Disposable local fixture. Never add a remote.",
        },
    )
    (repo / ".gitignore").write_text(
        "\n".join(
            [
                ".bram-demo-scenario.json",
                "resources/worklist.json",
                "resources/worklist-drafts/",
                "resources/.claim-intervals.json",
                "resources/.worklist-authorization.json",
                "resources/.worklist-direct-edit.json",
                "resources/.inflight-claim.json",
                "resources/.worklist-intent.json",
                "resources/.worklist-result.json",
                "resources/.bram-port",
                "resources/.bram-port.json",
                "resources/bram-traces/",
                "*.log",
                "",
            ]
        ),
        encoding="utf-8",
    )
    write_json(
        repo / ".bram.json",
        {
            "menus": {"hookDriven": True, "parseAndDisplay": True},
            "traces": {"enabled": True},
            "ui": {"showTargetApp": False, "targetAppMinimized": True},
        },
    )
    (repo / "README.md").write_text(
        "# Bram synthetic demo\n\nGenerated by scripts/demo_instance.py.\n",
        encoding="utf-8",
    )
    (repo / "resources").mkdir(exist_ok=True)
    run_git(repo, "add", "-A")
    run_git(repo, "commit", "-q", "-m", "Synthetic demo boundary", env=_fixed_git_env())
    run_git(repo, "update-ref", "refs/heads/demo/base", "HEAD")
    return validate_demo(repo)


@contextlib.contextmanager
def temporary_index(repo: Path, base: str) -> Iterator[dict[str, str]]:
    fd, raw = tempfile.mkstemp(prefix="bram-demo-index-")
    os.close(fd)
    os.unlink(raw)
    env = {"GIT_INDEX_FILE": raw}
    try:
        run_git(repo, "read-tree", base, env=env)
        yield env
    finally:
        with contextlib.suppress(FileNotFoundError):
            os.unlink(raw)


def capture_tree(repo: Path, base: str = "HEAD", force_paths: Iterable[str] = ()) -> str:
    with temporary_index(repo, base) as env:
        run_git(repo, "add", "-A", "--", ".", env=env)
        existing = [p for p in force_paths if (repo / p).exists()]
        if existing:
            run_git(repo, "add", "-f", "--", *existing, env=env)
        tree = run_git(repo, "write-tree", env=env)
    if not tree:
        raise DemoError("git produced an empty tree id")
    return tree


def _load_controls(repo: Path) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    worklist = (
        read_json(repo / WORKLIST)
        if (repo / WORKLIST).exists()
        else {"description": "Synthetic Bram worklist", "items": [], "version": 1}
    )
    claims = (
        read_json(repo / CLAIMS)
        if (repo / CLAIMS).exists()
        else {"intervals": [], "version": 1}
    )
    meta = (
        read_json(repo / SCENARIO_META)
        if (repo / SCENARIO_META).exists()
        else {"format": FORMAT_VERSION, "starters": []}
    )
    return worklist, claims, meta


def _write_controls(
    repo: Path, worklist: dict[str, Any], claims: dict[str, Any], meta: dict[str, Any]
) -> None:
    write_json(repo / WORKLIST, worklist)
    write_json(repo / CLAIMS, claims)
    write_json(repo / SCENARIO_META, meta)


class StarterBuilder:
    def __init__(self, repo: Path, scenario: str):
        self.repo = repo
        self.scenario = scenario
        self.worklist, self.claims, self.meta = _load_controls(repo)
        self.meta.setdefault("starters", [])
        digest = int(hashlib.sha256(scenario.encode()).hexdigest()[:10], 16)
        prior = [int(x.get("atMs", 0)) for x in self.claims.get("intervals", [])]
        self.next_at_ms = max(prior, default=1_800_000_000_000 + (digest % 10_000_000) * 100)

    def _occurrence(self, starter: str) -> int:
        return 1 + sum(1 for value in self.meta["starters"] if value == starter)

    def _prefix(self, starter: str, occurrence: int) -> str:
        return starter if occurrence == 1 else f"{starter}-{occurrence}"

    def item(
        self,
        item_id: str,
        path: str,
        before: str,
        after: str,
        status: str = "applied",
    ) -> None:
        self.worklist.setdefault("items", []).append(
            {"files": [path], "id": item_id, "status": status}
        )
        draft = self.repo / "resources/worklist-drafts" / f"{item_id}.md"
        draft.parent.mkdir(parents=True, exist_ok=True)
        draft.write_text(f"# Before\n\n{before}\n\n# After\n\n{after}\n", encoding="utf-8")

    def boundary(self, ids: Sequence[str], kind: str = "approved") -> None:
        tree = capture_tree(self.repo)
        self.next_at_ms += 1
        at_ms = self.next_at_ms
        ref = f"refs/bram/claims/{at_ms}"
        run_git(self.repo, "update-ref", ref, tree)
        self.claims.setdefault("intervals", []).append(
            {"atMs": at_ms, "ids": list(ids), "kind": kind, "ref": ref, "tree": tree}
        )

    def file(self, rel: str, text: str) -> None:
        path = self.repo / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")

    def add(self, starter: str) -> None:
        if starter not in STARTERS:
            raise DemoError(f"unknown starter {starter!r}; choose from {', '.join(STARTERS)}")
        occurrence = self._occurrence(starter)
        prefix = self._prefix(starter, occurrence)
        getattr(self, f"starter_{starter.replace('-', '_')}")(prefix)
        self.meta["starters"].append(starter)
        self.worklist["version"] = int(self.worklist.get("version", 0)) + 1
        _write_controls(self.repo, self.worklist, self.claims, self.meta)

    def starter_disjoint_entanglement(self, prefix: str) -> None:
        path = f"demo/{prefix}.txt"
        a, b = f"{prefix}-top", f"{prefix}-bottom"
        self.item(a, path, "The top line is unchanged.", "The top line identifies item A.")
        self.item(b, path, "The bottom line is unchanged.", "The bottom line identifies item B.")
        self.boundary([a])
        self.file(path, "top: changed by A\n" + "middle\n" * 8 + "bottom: base\n")
        self.boundary([b])
        self.file(path, "top: changed by A\n" + "middle\n" * 8 + "bottom: changed by B\n")
        self.boundary([])

    def starter_dependency(self, prefix: str) -> None:
        path = f"demo/{prefix}.txt"
        a, b = f"{prefix}-prepare", f"{prefix}-consume"
        self.item(a, path, "The pipeline is unprepared.", "Prepare the pipeline for a consumer.")
        self.item(b, path, "No consumer is wired.", "Wire a consumer to the prepared pipeline.")
        self.boundary([a])
        self.file(path, "pipeline = prepared\n")
        self.boundary([b])
        self.file(path, "pipeline = prepared + consumer\n")
        self.boundary([])

    def starter_supersession(self, prefix: str) -> None:
        path = f"demo/{prefix}.txt"
        a, b = f"{prefix}-draft", f"{prefix}-replace"
        self.item(a, path, "Only the stable message exists.", "Add an experimental message.")
        self.item(b, path, "The experimental message is visible.", "Replace it with final copy.")
        self.boundary([a])
        self.file(path, "message: stable\nmessage: experimental A\n")
        self.boundary([b])
        self.file(path, "message: stable\nmessage: final B\n")
        self.boundary([])

    def starter_unattributed(self, prefix: str) -> None:
        path = f"demo/{prefix}.txt"
        item_id = f"{prefix}-observer"
        self.item(item_id, path, "The file has no attributed edit.", "Observe an unclaimed edit.")
        self.boundary([])
        self.file(path, "owner: nobody claimed this line\n")
        self.boundary([item_id])
        self.boundary([])

    def starter_many_claimants(self, prefix: str) -> None:
        path = f"demo/{prefix}.txt"
        ids = [f"{prefix}-{n}" for n in range(1, 7)]
        for item_id in ids:
            self.item(item_id, path, "The shared value is at baseline.", f"Contribute {item_id}.")
        self.boundary(ids)
        self.file(path, "shared: " + ", ".join(ids) + "\n")
        self.boundary([])

    def starter_expired_authorization(self, prefix: str) -> None:
        path = f"demo/{prefix}.txt"
        item_id = f"{prefix}-approval"
        self.item(
            item_id,
            path,
            "The item awaits approval.",
            "Exercise the expired authorization path.",
            status="proposed",
        )
        self.file(path, "authorization: expired\n")
        write_json(
            self.repo / AUTH,
            {
                "commitToo": False,
                "consumedAtMs": None,
                "ids": [item_id],
                "interruptedAtMs": None,
                "issuedAtMs": 1,
                "items": [],
                "kind": "approved",
                "source": "synthetic-expired-authorization",
            },
        )


def _control_paths(repo: Path) -> list[str]:
    paths = [SCENARIO_META, WORKLIST, CLAIMS, AUTH, "resources/worklist-drafts"]
    return [path for path in paths if (repo / path).exists()]


def _claim_records(repo: Path) -> list[dict[str, Any]]:
    if not (repo / CLAIMS).exists():
        return []
    claims = read_json(repo / CLAIMS).get("intervals", [])
    if not isinstance(claims, list):
        raise DemoError(f"expected an intervals array in {CLAIMS}")
    records: list[dict[str, Any]] = []
    for raw in claims:
        if not isinstance(raw, dict) or not isinstance(raw.get("ref"), str):
            raise DemoError(f"invalid claim record in {CLAIMS}")
        record = dict(raw)
        tree = run_git(repo, "rev-parse", f"{record['ref']}^{{tree}}")
        record["tree"] = tree
        records.append(record)
    return records


def _commit_tree(repo: Path, tree: str, parent: str, message: str, step: int) -> str:
    return run_git(
        repo,
        "commit-tree",
        tree,
        "-p",
        parent,
        "-m",
        message,
        env=_fixed_git_env(step),
    )


def capture_scenario(repo: Path, name: str, force: bool = False) -> str:
    repo = validate_demo(repo)
    ref = scenario_ref(name)
    old = run_git(repo, "rev-parse", "--verify", "--quiet", ref, check=False)
    if old and not force:
        raise DemoError(f"scenario {name!r} already exists; pass --force to replace it")
    boundary = run_git(repo, "rev-parse", "HEAD")
    _, _, live_meta = _load_controls(repo)
    records = _claim_records(repo)
    scenario_doc = {
        "boundary": boundary,
        "claimIntervals": records,
        "format": FORMAT_VERSION,
        "name": name,
        "starters": list(live_meta.get("starters", [])),
    }
    write_json(repo / SCENARIO_META, scenario_doc)
    final_tree = capture_tree(repo, boundary, _control_paths(repo))

    parent = boundary
    for index, record in enumerate(records, 1):
        parent = _commit_tree(
            repo,
            str(record["tree"]),
            parent,
            f"Scenario {name}: claim boundary {index}",
            index,
        )
    pending = _commit_tree(
        repo, final_tree, parent, f"Scenario {name}: parked pending work", len(records) + 1
    )
    run_git(repo, "update-ref", ref, pending, *( [old] if old else [] ))
    use_scenario(repo, name)
    return pending


def _clear_claim_refs(repo: Path) -> None:
    refs = run_git(repo, "for-each-ref", "--format=%(refname)", "refs/bram/claims")
    for ref in refs.splitlines():
        if ref:
            run_git(repo, "update-ref", "-d", ref)


def _scenario_doc(repo: Path, name: str) -> tuple[str, dict[str, Any]]:
    ref = scenario_ref(name)
    tip = run_git(repo, "rev-parse", "--verify", ref)
    raw = run_git(repo, "show", f"{ref}:{SCENARIO_META}")
    try:
        doc = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise DemoError(f"scenario {name!r} has invalid metadata: {exc}") from exc
    if not isinstance(doc, dict) or doc.get("name") != name or doc.get("format") != FORMAT_VERSION:
        raise DemoError(f"scenario {name!r} has incompatible metadata")
    return tip, doc


def _runtime_root(repo: Path) -> Path:
    git_dir = Path(run_git(repo, "rev-parse", "--git-dir"))
    if not git_dir.is_absolute():
        git_dir = repo / git_dir
    path = git_dir.resolve() / RUNTIME_DIR
    path.mkdir(parents=True, exist_ok=True)
    return path


def use_scenario(repo: Path, name: str) -> None:
    repo = validate_demo(repo)
    tip, doc = _scenario_doc(repo, name)
    boundary = str(doc.get("boundary", ""))
    run_git(repo, "cat-file", "-e", f"{boundary}^{{commit}}")

    # Destructive by design, but only after the synthetic marker, exact git
    # toplevel, and no-remote checks above have all passed.
    run_git(repo, "reset", "--hard", "-q")
    # Do not clean before checkout: that creates a moment where ignored
    # worklist sidecars disappear, and a running Bram can race the hydrate by
    # restoring its newer cached version. Forced checkout replaces any
    # untracked sidecar that obstructs the parked tree without that gap.
    run_git(repo, "checkout", "--detach", "--force", "-q", tip)
    # Process/session infrastructure is not scenario state. Preserve the live
    # port and trace while a human is driving the second instance, along with
    # Setup's active agent files. Everything else untracked is disposable.
    run_git(
        repo,
        "clean",
        "-fdx",
        "-q",
        "-e",
        ".claude/",
        "-e",
        "AGENTS.md",
        "-e",
        "CLAUDE.md",
        "-e",
        "resources/.bram-port",
        "-e",
        "resources/.bram-port.json",
        "-e",
        "resources/bram-traces/",
    )
    run_git(repo, "reset", "--mixed", "-q", boundary)

    _clear_claim_refs(repo)
    for record in doc.get("claimIntervals", []):
        ref = str(record.get("ref", ""))
        tree = str(record.get("tree", ""))
        if not ref.startswith("refs/bram/claims/"):
            raise DemoError(f"scenario {name!r} contains an unsafe claim ref")
        run_git(repo, "cat-file", "-e", f"{tree}^{{tree}}")
        run_git(repo, "update-ref", ref, tree)

    write_json(
        _runtime_root(repo) / "active.json",
        {"boundary": boundary, "name": name, "ref": scenario_ref(name), "tip": tip},
    )


def reset_scenario(repo: Path) -> str:
    repo = validate_demo(repo)
    active_path = _runtime_root(repo) / "active.json"
    if not active_path.exists():
        raise DemoError("no active scenario; run 'use <name>' first")
    name = str(read_json(active_path).get("name", ""))
    use_scenario(repo, name)
    return name


def add_starter(repo: Path, starter: str) -> None:
    repo = validate_demo(repo)
    active_path = _runtime_root(repo) / "active.json"
    scenario = (
        str(read_json(active_path).get("name", "scratch"))
        if active_path.exists()
        else "scratch"
    )
    symbolic = run_git(repo, "symbolic-ref", "--quiet", "HEAD", check=False)
    if symbolic:
        raise DemoError("live demo HEAD is not detached; run 'use <scenario>' before add")
    builder = StarterBuilder(repo, scenario)
    occurrence = builder._occurrence(starter)
    prefix = builder._prefix(starter, occurrence)
    path, seed = starter_seed(starter, prefix)
    builder.file(path, seed)
    # Extend the clean boundary with only this starter's baseline. Existing
    # dirty scenario work stays out of the new commit and remains in place.
    with temporary_index(repo, "HEAD") as env:
        run_git(repo, "add", "--", path, env=env)
        tree = run_git(repo, "write-tree", env=env)
    parent = run_git(repo, "rev-parse", "HEAD")
    boundary = _commit_tree(
        repo, tree, parent, f"Starter {starter}: clean baseline", occurrence + 100
    )
    run_git(repo, "update-ref", "HEAD", boundary)
    builder.add(starter)


def new_scenario(repo: Path, name: str, starters: Sequence[str], force: bool = False) -> str:
    scenario_ref(name)
    repo = initialize_repo(repo)
    process_path = _runtime_root(repo) / "process.json"
    if process_path.exists():
        pid = int(read_json(process_path).get("pid", 0) or 0)
        if pid and _process_alive(pid):
            raise DemoError(f"stop the running demo PID {pid} before creating a new scenario")
    base = run_git(repo, "rev-parse", "refs/heads/demo/base")
    run_git(repo, "reset", "--hard", "-q", base)
    run_git(repo, "clean", "-fdx", "-q")
    run_git(repo, "checkout", "--detach", "--force", "-q", base)
    _clear_claim_refs(repo)
    expanded = list(starters)
    if not expanded:
        expanded = list(STARTERS)
    elif "all" in expanded:
        if expanded != ["all"]:
            raise DemoError("use --from all by itself, or list individual starters")
        expanded = list(STARTERS)
    occurrences: dict[str, int] = {}
    for starter in expanded:
        if starter not in STARTERS:
            raise DemoError(f"unknown starter {starter!r}; choose from {', '.join(STARTERS)}")
        occurrences[starter] = occurrences.get(starter, 0) + 1
        n = occurrences[starter]
        prefix = starter if n == 1 else f"{starter}-{n}"
        path, seed = starter_seed(starter, prefix)
        target = repo / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(seed, encoding="utf-8")
    run_git(repo, "add", "--", "demo")
    run_git(
        repo,
        "commit",
        "-q",
        "-m",
        f"Scenario {name}: clean starter baseline",
        env=_fixed_git_env(50),
    )
    boundary = run_git(repo, "rev-parse", "HEAD")
    write_json(
        repo / SCENARIO_META,
        {"boundary": boundary, "format": FORMAT_VERSION, "name": name, "starters": []},
    )
    builder = StarterBuilder(repo, name)
    for starter in expanded:
        builder.add(starter)
    return capture_scenario(repo, name, force=force)


def scrub_agent_environment(env: Mapping[str, str]) -> dict[str, str]:
    clean = dict(env)
    for key in AGENT_ENV_KEYS:
        clean.pop(key, None)
    clean["BRAM_TRACE"] = "1"
    clean["BRAM_DEMO_INSTANCE"] = "1"
    return clean


def assert_binary_current(binary: Path) -> None:
    """Refuse evidence from a debug binary older than the checked-out HEAD."""
    head_raw = run_git(SOURCE_ROOT, "log", "-1", "--format=%ct", check=False)
    if not head_raw.isdigit():
        return
    binary_mtime = binary.stat().st_mtime
    head_time = int(head_raw)
    if binary_mtime < head_time:
        raise DemoError(
            "stale Bram binary: "
            f"{binary} predates HEAD; rebuild before measuring this checkout"
        )


def _process_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def launch_demo(repo: Path, binary: Path) -> dict[str, Any]:
    repo = validate_demo(repo)
    binary = binary.expanduser().absolute()
    if not binary.is_file() or not os.access(binary, os.X_OK):
        raise DemoError(f"Bram binary is missing or not executable: {binary}")
    assert_binary_current(binary)
    runtime = _runtime_root(repo)
    pid_path = runtime / "process.json"
    if pid_path.exists():
        prior = read_json(pid_path)
        prior_pid = int(prior.get("pid", 0))
        if prior_pid and _process_alive(prior_pid):
            raise DemoError(f"demo Bram is already running as PID {prior_pid}")
        pid_path.unlink()
    log_path = runtime / "bram.log"
    log = log_path.open("ab", buffering=0)
    flags = 0
    if os.name == "nt":
        flags = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
    try:
        proc = subprocess.Popen(
            [str(binary), str(repo)],
            cwd=str(SOURCE_ROOT),
            env=scrub_agent_environment(os.environ),
            stdin=subprocess.DEVNULL,
            stdout=log,
            stderr=subprocess.STDOUT,
            start_new_session=(os.name != "nt"),
            creationflags=flags,
        )
    finally:
        log.close()
    time.sleep(0.15)
    code = proc.poll()
    if code is not None:
        tail = log_path.read_text(encoding="utf-8", errors="replace")[-2000:]
        raise DemoError(f"Bram exited during launch ({code}); log tail:\n{tail}")
    record = {
        "binary": str(binary),
        "log": str(log_path),
        "pid": proc.pid,
        "repo": str(repo),
        "startedAtMs": int(time.time() * 1000),
    }
    _LAUNCHED_PROCESSES[proc.pid] = proc
    write_json(pid_path, record)
    return record


def stop_demo(repo: Path, timeout: float = 5.0) -> int:
    repo = validate_demo(repo)
    pid_path = _runtime_root(repo) / "process.json"
    if not pid_path.exists():
        raise DemoError("no recorded demo process")
    record = read_json(pid_path)
    if Path(str(record.get("repo", ""))).resolve() != repo:
        raise DemoError("recorded process belongs to a different repository")
    pid = int(record.get("pid", 0))
    if pid <= 0:
        raise DemoError("invalid recorded demo PID")
    proc = _LAUNCHED_PROCESSES.pop(pid, None)
    if _process_alive(pid):
        try:
            os.kill(pid, signal.SIGTERM)
        except PermissionError as exc:
            raise DemoError(f"permission denied stopping recorded PID {pid}") from exc
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if proc is not None and proc.poll() is not None:
                break
            if proc is None and not _process_alive(pid):
                break
            time.sleep(0.05)
        still_alive = proc.poll() is None if proc is not None else _process_alive(pid)
        if still_alive and os.name != "nt":
            try:
                os.kill(pid, signal.SIGKILL)
            except PermissionError as exc:
                raise DemoError(f"permission denied force-stopping recorded PID {pid}") from exc
        if proc is not None:
            with contextlib.suppress(subprocess.TimeoutExpired):
                proc.wait(timeout=1)
    pid_path.unlink(missing_ok=True)
    return pid


def status(repo: Path) -> dict[str, Any]:
    repo = validate_demo(repo)
    runtime = _runtime_root(repo)
    active_path = runtime / "active.json"
    active = read_json(active_path) if active_path.exists() else {}
    branches = run_git(
        repo, "for-each-ref", "--format=%(refname:strip=3)", "refs/heads/scenario"
    ).splitlines()
    refs = run_git(
        repo, "for-each-ref", "--format=%(refname) %(objectname)", "refs/bram/claims"
    ).splitlines()
    worklist = read_json(repo / WORKLIST) if (repo / WORKLIST).exists() else {"items": []}
    process_path = runtime / "process.json"
    process = read_json(process_path) if process_path.exists() else {}
    pid = int(process.get("pid", 0) or 0)
    return {
        "activeScenario": active.get("name"),
        "claimRefs": refs,
        "dirty": run_git(repo, "status", "--short").splitlines(),
        "items": len(worklist.get("items", [])),
        "log": str(runtime / "bram.log"),
        "pid": pid if pid and _process_alive(pid) else None,
        "repo": str(repo),
        "scenarios": branches,
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--repo",
        type=Path,
        default=Path(os.environ.get("BRAM_DEMO_REPO", DEFAULT_REPO)),
        help=f"synthetic repository (default: {DEFAULT_REPO})",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    new = sub.add_parser("new", help="create and hydrate a scenario")
    new.add_argument("name")
    new.add_argument("--from", dest="starters", action="append", choices=(*STARTERS, "all"))
    new.add_argument("--force", action="store_true")

    use = sub.add_parser("use", help="hydrate a parked scenario exactly")
    use.add_argument("name")

    capture = sub.add_parser("capture", help="park the current stumbled-into state")
    capture.add_argument("name")
    capture.add_argument("--force", action="store_true")

    sub.add_parser("reset", help="rehydrate the active scenario")

    add = sub.add_parser("add", help="add a starter to the live dirty fixture")
    add.add_argument("starter", choices=STARTERS)

    launch = sub.add_parser("launch", help="launch the real Bram and record its exact PID")
    launch.add_argument(
        "--binary",
        type=Path,
        default=Path(os.environ.get("BRAM_DEMO_DEFAULT_BINARY", SOURCE_ROOT / "bram")),
    )

    stop = sub.add_parser("stop", help="stop only the recorded demo PID")
    stop.add_argument("--timeout", type=float, default=5.0)

    status_parser = sub.add_parser("status", help="show scenarios and live fixture state")
    status_parser.add_argument("--json", action="store_true")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.command == "new":
            tip = new_scenario(args.repo, args.name, args.starters or ["all"], args.force)
            print(f"created and hydrated scenario/{args.name} ({tip[:12]})")
        elif args.command == "use":
            use_scenario(args.repo, args.name)
            print(f"hydrated scenario/{args.name}")
        elif args.command == "capture":
            tip = capture_scenario(args.repo, args.name, args.force)
            print(f"captured and hydrated scenario/{args.name} ({tip[:12]})")
        elif args.command == "reset":
            print(f"reset scenario/{reset_scenario(args.repo)}")
        elif args.command == "add":
            add_starter(args.repo, args.starter)
            print(f"added {args.starter}; capture it to make it durable")
        elif args.command == "launch":
            record = launch_demo(args.repo, args.binary)
            print(f"launched PID {record['pid']}")
            print(f"log: {record['log']}")
        elif args.command == "stop":
            print(f"stopped PID {stop_demo(args.repo, args.timeout)}")
        elif args.command == "status":
            value = status(args.repo)
            if args.json:
                print(json.dumps(value, indent=2, sort_keys=True))
            else:
                print(f"repo: {value['repo']}")
                print(f"active: {value['activeScenario'] or '-'}")
                print(f"scenarios: {', '.join(value['scenarios']) or '-'}")
                print(f"items: {value['items']}  claims: {len(value['claimRefs'])}")
                print(f"dirty paths: {len(value['dirty'])}  pid: {value['pid'] or '-'}")
                print(f"log: {value['log']}")
        return 0
    except DemoError as exc:
        print(f"demo-instance: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
