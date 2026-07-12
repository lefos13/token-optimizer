# Token Optimizer release benchmarks

Run `TOKEN_OPTIMIZER_BENCHMARK_MODE=deterministic-local npm run benchmark` from a clean release tree.

Each baseline and product measurement executes its workload exactly once. The product path launches the compiled MCP server through the SDK stdio client, calls `run_command_digest`, and uses a deterministic loopback OpenAI-compatible mock. The mock rejects prompts containing the dynamically generated secret or lacking the production `TOKEN=***` marker. Reports identify the exact source commit and tree used for the run.

Peak RSS is the aggregate RSS of the root process and all descendants sampled with `ps` every 2 ms on Unix. This includes the MCP server, shell, and workload descendants, but very short-lived processes between samples can be missed; RSS values are platform-reported and should not be compared across operating systems. Windows RSS is unavailable. The release gate requires product-minus-baseline peak RSS below 100 MB for the exact 56 MB binary/long-line workload.

Node/npm, Python, Rust, and Go fixtures cover deterministic success and exit-7 failure. Missing toolchains are recorded as skipped. Byte counts are exact; token counts are documented byte/4 estimates. Timing and RSS remain single-machine evidence, not universal performance claims.
