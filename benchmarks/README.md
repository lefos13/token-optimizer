# Token Optimizer release benchmarks

Run `TOKEN_OPTIMIZER_BENCHMARK_MODE=deterministic-local npm run benchmark` from a clean release tree.

Each sample executes its baseline and product workload exactly once. Release workloads use three samples; their aggregate contains median, minimum, maximum, and range for duration, baseline duration, provider latency, baseline/product RSS, and RSS overhead, while samples remain authoritative. The product path launches the compiled MCP server through the SDK stdio client, calls `run_command_digest`, and uses a deterministic loopback OpenAI-compatible mock. The mock rejects prompts containing the dynamically generated secret or lacking the production `TOKEN=***` marker.

Reports identify the exact source commit/tree, dependency versions, lockfile hash, and a SHA-256 hash over every sorted file under `dist/`, the benchmark script and fixtures, `package.json`, and `package-lock.json`. A release run captures these values after its initial clean-tree check, verifies the tree is still clean and every provenance value is unchanged after measurement, and only then writes output. Mid-run changes fail with `BENCHMARK_SOURCE_CHANGED` and produce no new report.

Peak RSS is the aggregate RSS of the root process and all descendants sampled with `ps` every 2 ms on Unix. This includes the MCP server, shell, and workload descendants, but very short-lived processes between samples can be missed; RSS values are platform-reported and should not be compared across operating systems. Failed sampling and Windows report `unavailable` with null metrics and cannot pass the release gate. The gate requires median product-minus-baseline peak RSS below 100 MB for the exact 56 MB binary/long-line workload; the distance below 100 MB is the measured margin, while the reported sample range shows uncertainty.

Node/npm, Python, Rust, and Go fixtures cover deterministic success and exit-7 failure. Missing toolchains are recorded as skipped. Byte counts are exact; token counts are documented byte/4 estimates. Timing and RSS remain single-machine evidence, not universal performance claims.
