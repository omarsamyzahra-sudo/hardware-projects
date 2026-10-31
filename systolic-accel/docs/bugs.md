# Bugs found during verification

Every entry here was real: it showed up as a failing test (or as a test
that should have failed and didn't), and the fix is in the git history.

| # | What | Found by | Fix |
|---|------|----------|-----|
| 1 | **STATUS read 0 for one cycle at the end of a job.** `busy` drops on the same clock edge as the core's `done` pulse rises, but the sticky `done` bit in the register file is set one edge later. A poll landing in that cycle saw "not busy, not done", which a driver could read as "never started". | cocotb `test_random_jobs` / `test_corner_shapes` (`STATUS 0x0: neither busy nor done`) | STATUS and `irq` use `done_sticky \|\| core_done` (`rtl/accel_axil.sv`). |
| 2 | **One idle cycle per k-tile.** The weight loader waited `N` cycles after a bank's last activation before overwriting it; the real bound is `N - 3`. With M = 16 this cost 17 cycles per tile instead of 16. | cocotb `test_throughput` (136 cycles for 8 extra tiles, ideal 128) | Cooldown `N - 3`, derived in the header of `rtl/accel_core.sv`. Mutation check: `N - 4` fails three tests, so the bound is exact. |
| 3 | **The testbenches could not see requantization bugs.** Random jobs used a scale (`mult / 2^shift`) so large that almost every int8 result saturated at -128 or 127, so deleting the rounding term from the RTL still passed, in both cocotb and UVM. | Mutation: `y = prod >>> shift` (no rounding) passed `smoke_test` | Random jobs now pick a scale that spreads results over the int8 range. Both testbenches count saturated results and fail if too many saturate. A directed exact-halves rounding test was added. The same mutant now fails 4 cocotb tests and the UVM scoreboard. |
| 4 | **A broken B channel hung the UVM test instead of failing it.** With `bvalid` dropped before `bready`, the SVA `a_b_hold` fired, but the driver then waited forever for a handshake. | Mutation: `if (s_bvalid) s_bvalid <= 0` | A 50 ms UVM timeout ends a hung test with a FATAL. SVA failures now print their names (`SVA a_b_hold failed`). |

Not bugs, but things that cost time:

* Icarus rejects `acc[m][n] <= ...` when `m` is a variable on a packed
  multi-dimensional array; the result storage is an unpacked array of row
  vectors, read and written a whole row at a time.
* xsim's `.bat` wrappers split arguments at `=`, so plusargs go through an
  options file (`uvm/run.sh`). xelab can't delete its own `obj` directory
  inside OneDrive, so xsim works in `~/.cache/systolic-accel-xsim`.
* `check` is a UVM phase method; a scoreboard helper with that name breaks
  elaboration.
