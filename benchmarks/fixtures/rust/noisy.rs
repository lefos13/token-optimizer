use std::env;
fn main() { for i in 0..4000 { println!("rust fixture line {} deterministic output", i); } let fail=env::args().any(|a| a=="--fail"); eprintln!("rust fixture {}", if fail {"intentional failure"} else {"success"}); if fail {std::process::exit(7)} }
