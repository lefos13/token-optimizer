import sys
for i in range(4000): print(f"python fixture line {i} deterministic output")
print("python fixture intentional failure" if "--fail" in sys.argv else "python fixture success", file=sys.stderr)
sys.exit(7 if "--fail" in sys.argv else 0)
