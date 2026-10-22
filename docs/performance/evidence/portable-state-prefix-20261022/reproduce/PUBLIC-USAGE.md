Place the published helper files in one new local folder. Preserve the public archive and its external manifest. Python must run without `-O` or `PYTHONOPTIMIZE`; the extractor refuses optimized mode. Use Node 22 or 24 for the analyzer. The measured workload used native Linux Node 24.19.0; running the offline parser elsewhere does not add a runtime qualification.

The extractor verifies the archive SHA `1e272c1f9c9bd10db3be5bcd11c67b98dbcef1f0f5fec53ef328d56720cef6b3` and external manifest SHA `22d25840359e6e271d759f23e4166240c3f49533f47d27e41a91f44e60e05ba9`. It copies exactly 54 selected regular inputs into a new direct child of the helper folder, bounded by member, byte and path checks. The child name must match `[a-z0-9][a-z0-9-]{0,63}` and cannot be a Windows device name; the extractor rejects symlinks, existing targets and any resolved parent outside its own folder. It never follows archive links or extracts unspecified files. A failed attempt may leave a partial fresh folder; use a different child name for another attempt. The earlier drive-relative-path defect is preserved and documented; publish only the repaired `prepare-public-inputs.py` pinned in the final bundle manifest.

From the helper folder, substitute the two downloaded file paths:

```text
python prepare-public-inputs.py PATH_TO_RAW_ARCHIVE PATH_TO_EXTERNAL_MANIFEST public-inputs-fresh
node --test test.v2.mjs test-attribution.mjs
node analyze.v2.mjs public-inputs-fresh/analysis-manifest.on.json f76c1a3ba715ca7bd33b66071b102d3c44cbb4e6edef34640a9cf9d6962a3b71 public-inputs-fresh/analysis.on.NEW.json
node analyze.v2.mjs public-inputs-fresh/analysis-manifest.off.json 8061ddcb82c678f4f63a315951538f6ee831e28b4ecbc244b7f08a34e7ff0709 public-inputs-fresh/analysis.off.NEW.json
```

For the two-copy SDK aggregation, use the SHA of your newly generated CPU-on analysis (printed by the analyzer) and the published dependency receipt, SHA `9a38ab65ff1a998a6af877a8c6281632419aa81f6546f72d6d81902cbf896045`:

```text
node aggregate-public.mjs public-inputs-fresh/analysis.on.NEW.json NEW_ANALYSIS_SHA dependency-code-pins.public.json 9a38ab65ff1a998a6af877a8c6281632419aa81f6546f72d6d81902cbf896045 public-inputs-fresh/aggregation.NEW.json
```

The aggregation recomputes every function/module bucket from validated leaf stacks and the explicit dependency receipt. Its complete per-PID function/module arrays were independently compared with the report summary and agree exactly. The dependency receipt records after-capture hashes and byte identity, separately from pre-run emission pins.

Outputs must be fresh and beneath the helper folder. The extractor produces `public-input-recipe.json`, SHA `5cfe62475ad9ae08ff9b36877c172fce9a98a6a23da143ae469c79f3e5aa5f3b`, mapping every selected byte, original public report, changed analysis-input report, named omission and manifest. The public reports stay unchanged. Separate derivations restore only the public-start-proven runtime path and original serialization order for unchanged emission inventory entries. The existing analyzer gates then run unchanged.

Published successful public CPU-on/off output hashes are `7d64eba2d9a64f91009a243b53e36878ce8fe29623f5714b555ffec5f589a310` and `ee8b86753cb17387d10ce6e217f76f251ddaa00678909f45d19630531ef501d6`. New whole-file output hashes vary with analysis time/runtime. Compare the complete `processes` data, profile hashes, phase values and source pins; do not require a rerun's generated timestamp to equal the publication's timestamp. The private/public comparison found identical complete process objects for both 14-process inventories and identical physical stage data.

Self percentages divide by all ticks, including idle. Weighted percentages divide by preceding elapsed intervals, not actual CPU. Inclusive values overlap and deduplicate recursion per stack. The outputs cover startup, the empty-table 1–288 prefix, drain and shutdown; they do not qualify populated rows, full recovery, Wire consensus, busy-chain ancestry, overhead or improvement.
