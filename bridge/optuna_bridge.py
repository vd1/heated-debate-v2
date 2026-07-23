"""Optuna bridge consuming the F-SCHEMA engine contract.

Each trial spawns the engine executable, writes one engine input to stdin, and
parses exactly one reward or structured-failure line from stdout. The contract
is defined by the engine; this bridge never redefines it.

Run with: uv run --with optuna bridge/optuna_bridge.py --spec <spec.json> \
  --cases <cases.json> --engine "bun src/cli/engine.ts" --trials 8
"""

from __future__ import annotations

import argparse
import json
import shlex
import subprocess
import sys

ENGINE_SCHEMA_VERSION = "1"


def run_trial(engine: list[str], engine_input: dict) -> dict:
    completed = subprocess.run(
        engine,
        input=json.dumps(engine_input).encode(),
        capture_output=True,
        check=False,
    )
    stdout = completed.stdout.decode()
    lines = [line for line in stdout.split("\n") if line]
    if len(lines) != 1:
        raise RuntimeError(f"engine stdout must be exactly one line, got {len(lines)}")
    output = json.loads(lines[0])
    if output.get("schemaVersion") != ENGINE_SCHEMA_VERSION:
        raise RuntimeError(f"unsupported engine schema version: {output.get('schemaVersion')}")
    return output


def objective_factory(spec: dict, cases_path: str, engine: list[str], artifact_root: str):
    import optuna  # deferred so --help works without optuna installed

    varied = {item["dimensionId"]: item["values"] for item in spec["variedParameters"]}

    def objective(trial: "optuna.Trial") -> float:
        point = {
            dimension: trial.suggest_categorical(dimension, values)
            for dimension, values in varied.items()
        }
        engine_input = {
            "schemaVersion": ENGINE_SCHEMA_VERSION,
            "spec": spec,
            "run": {
                "runId": trial.user_attrs["runId"],
                "caseId": spec["benchmarkCaseIds"][0],
                "point": point,
                "repetition": 0,
            },
        }
        output = run_trial(
            engine + ["--cases", cases_path, "--artifact-root", artifact_root,
                      "--agents", "scripted"],
            engine_input,
        )
        if output["status"] == "failure":
            raise optuna.TrialPruned(output["failure"]["message"])
        reward = output["reward"]
        if reward["status"] != "known":
            raise optuna.TrialPruned(reward.get("reason", "reward unavailable"))
        return float(reward["scalar"])

    return objective


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--spec", required=True)
    parser.add_argument("--cases", required=True)
    parser.add_argument("--engine", required=True)
    parser.add_argument("--artifact-root", default="artifacts")
    parser.add_argument("--trials", type=int, default=8)
    args = parser.parse_args()

    import optuna

    with open(args.spec, encoding="utf-8") as handle:
        spec = json.load(handle)
    study = optuna.create_study(direction="maximize")
    study.optimize(
        objective_factory(spec, args.cases, shlex.split(args.engine), args.artifact_root),
        n_trials=args.trials,
    )
    print(json.dumps({"bestParams": study.best_params, "bestValue": study.best_value}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
