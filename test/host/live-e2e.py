#!/usr/bin/env python3
"""Live Keystone + pi-subagents acceptance test.

Runs a real Pi RPC host, drives /goal create through the production RPC approval
UI, and asserts role-based child routing with no per-run model pinning.

Usage:
  python3 test/host/live-e2e.py --depth standard
  python3 test/host/live-e2e.py --depth full

The full variant requires the user's configured oracle model/fallback chain to
be currently usable. The standard variant proves mutation + verification +
independent review all the way to DONE without requiring final auditors.
"""
import argparse
import json
import os
from pathlib import Path
import queue
import shutil
import subprocess
import sys
import tempfile
import threading
import time

parser = argparse.ArgumentParser()
parser.add_argument("--depth", choices=("standard", "full"), default="standard")
parser.add_argument("--timeout", type=int, default=600)
args = parser.parse_args()

def configured_model_chains():
    settings_path = Path.home() / ".pi" / "agent" / "settings.json"
    try:
        settings = json.loads(settings_path.read_text())
        overrides = settings.get("subagents", {}).get("agentOverrides", {})
    except Exception:
        return {}
    chains = {}
    for role in ("scout", "worker", "reviewer", "oracle"):
        override = overrides.get(role) or {}
        chain = [override.get("model"), *(override.get("fallbackModels") or [])]
        chains[role] = [model for model in chain if isinstance(model, str) and model]
    return chains

def matches_configured_model(actual, configured_chain):
    return isinstance(actual, str) and any(
        actual == configured or actual.startswith(configured + ":")
        for configured in configured_chain
    )

repo = Path(__file__).resolve().parents[2]
subagents = Path(os.environ.get("PI_SUBAGENTS_ENTRY", str(repo.parent / "pi-subagents" / "index.ts")))
keystone = repo / "src" / "index.ts"
observer = repo / "test" / "host" / "fixtures" / "e2e-observer.ts"
if not subagents.exists():
    raise SystemExit(f"pi-subagents entry not found: {subagents}")

root = Path(tempfile.mkdtemp(prefix="keystone-live-e2e-"))
keep = False
proc = None
stderr_lines = []
notifies = []
try:
    (root / "src").mkdir()
    (root / "src" / "message.txt").write_text("OLD\n")
    (root / "package.json").write_text(json.dumps({
        "name": "keystone-live-e2e",
        "private": True,
        "scripts": {
            "typecheck": "node -e \"process.exit(0)\"",
            "test": "node -e \"const fs=require('fs'); if(!fs.existsSync('src/message.txt')) process.exit(1)\"",
        },
    }, indent=2) + "\n")
    subprocess.run(["npm", "install", "--package-lock-only", "--ignore-scripts", "--silent"], cwd=root, check=True)
    subprocess.run(["git", "init", "-q"], cwd=root, check=True)
    subprocess.run(["git", "config", "user.email", "e2e@example.com"], cwd=root, check=True)
    subprocess.run(["git", "config", "user.name", "Keystone E2E"], cwd=root, check=True)
    subprocess.run(["git", "add", "."], cwd=root, check=True)
    subprocess.run(["git", "commit", "-qm", "baseline"], cwd=root, check=True)

    env = os.environ.copy()
    env.pop("PI_SUBAGENT_CHILD", None)
    env.pop("PI_OFFLINE", None)
    proc = subprocess.Popen(
        ["pi", "--mode", "rpc", "--no-session", "-e", str(subagents), "-e", str(keystone), "-e", str(observer)],
        cwd=root, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True, bufsize=1,
    )
    outq = queue.Queue()
    def read_out():
        for line in proc.stdout:
            outq.put(line.rstrip("\n"))
    def read_err():
        for line in proc.stderr:
            stderr_lines.append(line.rstrip("\n"))
    threading.Thread(target=read_out, daemon=True).start()
    threading.Thread(target=read_err, daemon=True).start()

    def send(obj):
        proc.stdin.write(json.dumps(obj, separators=(",", ":")) + "\n")
        proc.stdin.flush()

    time.sleep(2)
    send({
        "id": "goal-create",
        "type": "prompt",
        "message": "/goal create Change src/message.txt so its entire contents are exactly KEYSTONE_E2E_OK. Do not change any other project files.",
    })

    depth_prefix = "2. Standard" if args.depth == "standard" else "3. Full"
    completed = False
    failure = None
    deadline = time.time() + args.timeout
    while time.time() < deadline and proc.poll() is None:
        try:
            line = outq.get(timeout=1)
        except queue.Empty:
            continue
        try:
            obj = json.loads(line)
        except Exception:
            continue
        if obj.get("type") != "extension_ui_request":
            continue
        method = obj.get("method")
        if method == "select":
            options = obj.get("options") or []
            choice = next((x for x in options if x.startswith(depth_prefix)), None)
            if not choice:
                failure = f"depth option {depth_prefix!r} not offered: {options!r}"
                break
            send({"type": "extension_ui_response", "id": obj["id"], "value": choice})
        elif method == "confirm":
            send({"type": "extension_ui_response", "id": obj["id"], "confirmed": True})
        elif method == "notify":
            msg = obj.get("message", "")
            notifies.append(msg)
            if "Goal completed:" in msg:
                completed = True
                break
            if any(token in msg for token in ("Execution incomplete:", "Execution failed:", "Preparation failed:")):
                failure = msg
                break

    if proc.poll() is None:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=5)

    goals = list((root / ".keystone" / "goals").glob("*.json"))
    goal_rows = [json.loads(p.read_text()) for p in goals]
    states = [g.get("state") for g in goal_rows]
    observer_rows = []
    obs = root / ".keystone-e2e-observer.jsonl"
    if obs.exists():
        for line in obs.read_text().splitlines():
            try:
                observer_rows.append(json.loads(line))
            except Exception:
                pass

    spawns = [r.get("params", {}) for r in observer_rows if r.get("kind") == "spawn"]
    agents = [r.get("agent") for r in spawns]
    pinned = [r.get("model") for r in spawns if "model" in r]
    parent = next((r.get("model") for r in observer_rows if r.get("kind") == "parent"), None)
    children = []
    for row in observer_rows:
        if row.get("kind") == "child-complete":
            for child in row.get("data", {}).get("results") or []:
                children.append((child.get("agent"), child.get("model"), child.get("status")))

    expected_agents = {"scout", "worker", "reviewer"}
    if args.depth == "full":
        expected_agents.add("oracle")
    configured_chains = configured_model_chains()
    configured_routing_ok = all(
        not configured_chains.get(role)
        or any(
            child_role == role
            and matches_configured_model(child_model, configured_chains[role])
            for child_role, child_model, _status in children
        )
        for role in expected_agents
    )
    message_path = root / "src" / "message.txt"
    message_text = message_path.read_text().strip() if message_path.exists() else None
    ok = (
        completed
        and message_text == "KEYSTONE_E2E_OK"
        and "DONE" in states
        and not pinned
        and expected_agents.issubset(set(agents))
        and configured_routing_ok
    )

    print(f"depth={args.depth} parent_model={parent}")
    print("configured_model_chains=" + json.dumps({
        role: configured_chains.get(role, []) for role in sorted(expected_agents)
    }))
    print(f"states={states}")
    print(f"spawn_agents={agents}")
    print(f"pinned_models={pinned}")
    print("children=" + json.dumps(children))
    if ok:
        print("LIVE_E2E_OK")
    else:
        keep = True
        print(f"LIVE_E2E_FAILED: {failure or 'deadline/acceptance mismatch'}", file=sys.stderr)
        print("notifications=" + json.dumps(notifies, indent=2), file=sys.stderr)
        print("stderr_tail=" + "\n".join(stderr_lines[-40:]), file=sys.stderr)
        print(f"fixture={root}", file=sys.stderr)
        raise SystemExit(2)
finally:
    if proc is not None and proc.poll() is None:
        proc.kill()
    if not keep:
        shutil.rmtree(root, ignore_errors=True)
