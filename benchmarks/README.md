# Token Optimizer benchmarks

This offline suite compares each fixture command directly with the same command feeding a bounded deterministic local digest. The direct command establishes duration and authoritative exit status; the digest path counts the complete byte stream but retains only bounded head/tail evidence. It never contacts a model or the network, and its explicit provider identity is `deterministic-local` / `deterministic-extractive-v1`.

Run `npm run benchmarks`. Node/npm, Python, Rust, and Go fixtures emit deterministic noisy success and exit-7 failure output without dependencies. Missing toolchains are recorded as `skipped`, never passed. The >50 MB workload includes a long line and binary bytes; the run fails at a measured child peak RSS delta of 100 MB or more.

Results use schema version 1 and include command outcome, byte/token counts, measured savings, timing/overhead, child RSS, provider metadata, redaction count, repetitions, environment, timestamp, and commit. Commands and environment metadata exclude secrets and user paths. The committed release-candidate JSON is evidence from one machine, not a universal performance claim: process startup noise, OS RSS reporting, filesystem caches, and single-repetition measurements limit comparisons. Token counts are byte/4 estimates, not tokenizer output. Negative overhead is possible from measurement noise.

For reproducibility, use a clean checkout, set no provider credentials, run `npm run build`, then `npm run benchmarks`. Compare results only on the same machine and toolchain versions.
