import importlib.util
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import time
import unittest


SCRIPT = Path(__file__).resolve().parents[1] / "demo_instance.py"
SPEC = importlib.util.spec_from_file_location("demo_instance", SCRIPT)
assert SPEC and SPEC.loader
demo = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(demo)


def git(repo: Path, *args: str) -> str:
    return subprocess.run(
        ["git", "-C", str(repo), *args],
        check=True,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    ).stdout.strip()


def worktree_snapshot(repo: Path) -> dict[str, bytes]:
    return {
        str(path.relative_to(repo)): path.read_bytes()
        for path in sorted(repo.rglob("*"))
        if path.is_file() and ".git" not in path.relative_to(repo).parts
    }


def claim_refs(repo: Path) -> list[str]:
    return git(
        repo, "for-each-ref", "--format=%(refname) %(objectname)", "refs/bram/claims"
    ).splitlines()


class DemoInstanceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="bram-demo-test-")
        self.repo = Path(self.temp.name) / "fixture"

    def tearDown(self) -> None:
        self.temp.cleanup()

    def new(self, name: str = "full", starters: list[str] | None = None) -> None:
        demo.new_scenario(
            self.repo,
            name,
            starters or ["disjoint-entanglement", "dependency"],
        )

    def test_new_hydrates_pending_work_and_real_claim_refs(self) -> None:
        self.new()
        base = git(self.repo, "rev-parse", "refs/heads/demo/base")
        boundary = json.loads((self.repo / demo.SCENARIO_META).read_text())["boundary"]
        self.assertEqual(git(self.repo, "rev-parse", "HEAD"), boundary)
        self.assertEqual(git(self.repo, "merge-base", "--is-ancestor", base, boundary), "")
        self.assertNotEqual(git(self.repo, "rev-parse", "scenario/full"), boundary)
        self.assertTrue(git(self.repo, "status", "--short"))
        self.assertEqual(git(self.repo, "ls-files", demo.SCENARIO_META), "")

        claims = json.loads((self.repo / demo.CLAIMS).read_text())["intervals"]
        self.assertGreaterEqual(len(claims), 6)
        self.assertEqual(
            claim_refs(self.repo),
            [f"{record['ref']} {record['tree']}" for record in claims],
        )
        for record in claims:
            self.assertEqual(git(self.repo, "cat-file", "-t", record["tree"]), "tree")

    def test_starters_measure_safe_and_dependency_sensitive_commit_orders(self) -> None:
        self.new()
        claims = json.loads((self.repo / demo.CLAIMS).read_text())["intervals"]

        def patch_for(item_id: str, path: str) -> str:
            patches = []
            for index, record in enumerate(claims[:-1]):
                if record["ids"] == [item_id]:
                    patches.append(
                        git(self.repo, "diff", record["ref"], claims[index + 1]["ref"], "--", path)
                    )
            return "\n".join(patches) + "\n"

        def apply_check(candidate: str, bases: list[str] | None = None) -> bool:
            index_path = Path(self.temp.name) / f"index-{time.time_ns()}"
            patch_path = Path(self.temp.name) / f"patch-{time.time_ns()}"
            env = os.environ.copy()
            env["GIT_INDEX_FILE"] = str(index_path)
            subprocess.run(
                ["git", "-C", str(self.repo), "read-tree", "HEAD"],
                env=env,
                check=True,
            )
            for base_patch in bases or []:
                patch_path.write_text(base_patch)
                subprocess.run(
                    ["git", "-C", str(self.repo), "apply", "--cached", str(patch_path)],
                    env=env,
                    check=True,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                )
            patch_path.write_text(candidate)
            checked = subprocess.run(
                ["git", "-C", str(self.repo), "apply", "--cached", "--check", str(patch_path)],
                env=env,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )
            index_path.unlink(missing_ok=True)
            patch_path.unlink(missing_ok=True)
            return checked.returncode == 0

        top = patch_for("disjoint-entanglement-top", "demo/disjoint-entanglement.txt")
        bottom = patch_for("disjoint-entanglement-bottom", "demo/disjoint-entanglement.txt")
        prepare = patch_for("dependency-prepare", "demo/dependency.txt")
        consume = patch_for("dependency-consume", "demo/dependency.txt")
        self.assertTrue(apply_check(top))
        self.assertTrue(apply_check(bottom))
        self.assertTrue(apply_check(prepare))
        self.assertFalse(apply_check(consume))
        self.assertTrue(apply_check(consume, [prepare]))

    def test_reset_is_byte_and_ref_exact(self) -> None:
        self.new()
        (self.repo / "resources/.bram-port").write_text("55123\n")
        (self.repo / "resources/.bram-port.json").write_text('{"port":55123}\n')
        trace = self.repo / "resources/bram-traces/bram-trace.log"
        trace.parent.mkdir(parents=True)
        trace.write_text("live trace\n")
        before_files = worktree_snapshot(self.repo)
        before_refs = claim_refs(self.repo)
        (self.repo / "demo/disjoint-entanglement.txt").write_text("damaged\n")
        (self.repo / demo.WORKLIST).write_text('{"items":[]}\n')
        git(self.repo, "update-ref", "refs/bram/claims/999", "HEAD^{tree}")
        (self.repo / "stray.tmp").write_text("remove me\n")

        self.assertEqual(demo.reset_scenario(self.repo), "full")
        self.assertEqual(worktree_snapshot(self.repo), before_files)
        self.assertEqual(claim_refs(self.repo), before_refs)
        self.assertFalse((self.repo / "stray.tmp").exists())
        self.assertEqual(trace.read_text(), "live trace\n")

    def test_capture_turns_a_stumbled_state_into_a_scenario(self) -> None:
        self.new("starting", ["supersession"])
        stumbled = self.repo / "demo/supersession.txt"
        stumbled.write_text(stumbled.read_text() + "human found this state\n")

        tip = demo.capture_scenario(self.repo, "stumbled")
        expected = worktree_snapshot(self.repo)
        self.assertEqual(git(self.repo, "rev-parse", "scenario/stumbled"), tip)
        self.assertIn("human found this state", stumbled.read_text())
        stumbled.write_text("lost\n")
        demo.use_scenario(self.repo, "stumbled")
        self.assertEqual(worktree_snapshot(self.repo), expected)

    def test_use_activates_only_the_selected_scenario_refs(self) -> None:
        self.new("one", ["disjoint-entanglement"])
        one_refs = claim_refs(self.repo)
        demo.new_scenario(self.repo, "two", ["dependency"])
        two_refs = claim_refs(self.repo)
        self.assertNotEqual(one_refs, two_refs)
        self.assertTrue(set(one_refs).isdisjoint(two_refs))

        demo.use_scenario(self.repo, "one")
        self.assertEqual(claim_refs(self.repo), one_refs)
        claims = json.loads((self.repo / demo.CLAIMS).read_text())["intervals"]
        self.assertTrue(all("disjoint-entanglement" in item for record in claims for item in record["ids"]))

    def test_add_starter_is_live_until_captured(self) -> None:
        self.new("base", ["dependency"])
        demo.add_starter(self.repo, "expired-authorization")
        auth = json.loads((self.repo / demo.AUTH).read_text())
        self.assertEqual(auth["issuedAtMs"], 1)
        self.assertIn("expired-authorization", (self.repo / demo.WORKLIST).read_text())
        demo.capture_scenario(self.repo, "with-expired-auth")
        demo.reset_scenario(self.repo)
        self.assertEqual(json.loads((self.repo / demo.AUTH).read_text())["issuedAtMs"], 1)

    def test_refuses_unmarked_nonempty_remote_and_source_targets(self) -> None:
        unmarked = Path(self.temp.name) / "unmarked"
        unmarked.mkdir()
        (unmarked / "keep.txt").write_text("important\n")
        with self.assertRaises(demo.DemoError):
            demo.initialize_repo(unmarked)
        self.assertTrue((unmarked / "keep.txt").exists())
        with self.assertRaises(demo.DemoError):
            demo.validate_demo(demo.SOURCE_ROOT)

        self.new()
        git(self.repo, "remote", "add", "origin", "https://example.invalid/demo.git")
        with self.assertRaises(demo.DemoError):
            demo.reset_scenario(self.repo)

    def test_environment_scrub_removes_every_parent_session_marker(self) -> None:
        env = {key: "secret" for key in demo.AGENT_ENV_KEYS}
        env["KEEP_ME"] = "yes"
        clean = demo.scrub_agent_environment(env)
        self.assertTrue(all(key not in clean for key in demo.AGENT_ENV_KEYS))
        self.assertEqual(clean["KEEP_ME"], "yes")
        self.assertEqual(clean["BRAM_TRACE"], "1")
        self.assertEqual(clean["BRAM_DEMO_INSTANCE"], "1")

    def test_stale_binary_is_rejected_before_launch(self) -> None:
        fake = Path(self.temp.name) / "stale-bram"
        fake.write_text("#!/bin/sh\nexit 0\n")
        fake.chmod(fake.stat().st_mode | stat.S_IXUSR)
        os.utime(fake, (1, 1))
        with self.assertRaisesRegex(demo.DemoError, "stale Bram binary"):
            demo.assert_binary_current(fake)

    @unittest.skipIf(os.name == "nt", "the PowerShell launcher is smoked on Windows")
    def test_launch_smoke_records_exact_pid_scrubbed_env_and_stderr(self) -> None:
        self.new("launch", ["unattributed"])
        fake = Path(self.temp.name) / "fake-bram"
        fake.write_text(
            "#!/usr/bin/env python3\n"
            "import json, os, pathlib, signal, sys, time\n"
            "repo = pathlib.Path(sys.argv[1])\n"
            "(repo / 'launch-env.json').write_text(json.dumps(dict(os.environ)))\n"
            "print('fake bram stderr', file=sys.stderr, flush=True)\n"
            "signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))\n"
            "while True: time.sleep(.05)\n"
        )
        fake.chmod(fake.stat().st_mode | stat.S_IXUSR)
        old = {key: os.environ.get(key) for key in demo.AGENT_ENV_KEYS}
        try:
            os.environ.update({key: "must-not-leak" for key in demo.AGENT_ENV_KEYS})
            record = demo.launch_demo(self.repo, fake)
            env_path = self.repo / "launch-env.json"
            deadline = time.monotonic() + 3
            while not env_path.exists() and time.monotonic() < deadline:
                time.sleep(.02)
            self.assertTrue(env_path.exists())
            child_env = json.loads(env_path.read_text())
            self.assertTrue(all(key not in child_env for key in demo.AGENT_ENV_KEYS))
            self.assertEqual(child_env["BRAM_TRACE"], "1")
            with self.assertRaisesRegex(demo.DemoError, "stop the running demo PID"):
                demo.new_scenario(self.repo, "must-not-reset-live", ["dependency"])
            self.assertEqual(demo.stop_demo(self.repo), record["pid"])
            self.assertFalse((self.repo / ".git/bram-demo/process.json").exists())
            self.assertIn("fake bram stderr", Path(record["log"]).read_text())
        finally:
            for key, value in old.items():
                if value is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = value

    def test_unix_launcher_smoke_delegates_to_shared_engine(self) -> None:
        if os.name == "nt":
            self.skipTest("Unix launcher")
        self.new("wrapper", ["many-claimants"])
        wrapper = SCRIPT.with_name("demo-instance.sh")
        proc = subprocess.run(
            ["sh", str(wrapper), "--repo", str(self.repo), "status", "--json"],
            check=True,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        self.assertEqual(json.loads(proc.stdout)["activeScenario"], "wrapper")

    def test_windows_launcher_carries_disk_serving_and_build_guards(self) -> None:
        script = SCRIPT.with_name("demo-instance.ps1").read_text()
        self.assertIn("New-Item -ItemType Junction", script)
        self.assertIn("Half-built debug artifacts", script)
        self.assertIn("VsDevCmd", script)
        self.assertNotIn("HardLink", script)


if __name__ == "__main__":
    unittest.main()
