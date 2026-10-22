# Reproduce the published analysis

First verify the enclosing evidence directory's `SHA256SUMS`. The raw archive and
external manifest are the only captured-data inputs required by the public
extractor. Use native Node 22 or 24 and Python without optimization.

From this directory:

```sh
python -B prepare-public-inputs.py ../raw-evidence.tar.gz ../manifest.json public-inputs-fresh
node --test test.v2.mjs test-attribution.mjs
node analyze.v2.mjs public-inputs-fresh/analysis-manifest.on.json f76c1a3ba715ca7bd33b66071b102d3c44cbb4e6edef34640a9cf9d6962a3b71 public-inputs-fresh/analysis.on.NEW.json
node analyze.v2.mjs public-inputs-fresh/analysis-manifest.off.json 8061ddcb82c678f4f63a315951538f6ee831e28b4ecbc244b7f08a34e7ff0709 public-inputs-fresh/analysis.off.NEW.json
```

[PUBLIC-USAGE.md](PUBLIC-USAGE.md) documents all pins, derivations, fresh-output
rules, the optional SDK alias aggregation, and comparison of deterministic process
results separately from generated timestamps. The analyzer's v1 and extractor's
earlier defective version are preserved privately; only the repaired versions are
published as executable helpers.

The original five-case Python path-guard suite is retained with its test logs in
the analysis archive. Its valid-extraction test expects a public fixture layout
at `../evidence-prefix-six-20261022/raw-evidence.tar.gz` and `manifest.json`,
relative to the helper directory. Recreate that layout in a separate test folder
before running `python -B test-public-paths.py`. The reproduction commands above
use explicit input paths and do not depend on that optional test layout.

The separate original-archive packager and its nine tests are retained unchanged:

```sh
python -B test-package-recovery-evidence.py
```

`original-archive-recipe.json` identifies the six private source archives by exact
name/hash. Rebuilding the public derivation requires those original archives and
receipts adjacent to that recipe; they are not embedded in this public subset.
The public CPU analysis above does not require them. Source member omissions and
transformations remain explicit in the external manifest.

The complete 25-file frozen analysis, including full profile graphs, per-process
results, aggregation, derived input reports, recipes and original test logs, is
retained in `../analysis-evidence.tar.gz`. Its extra `publication-files.json`
inventories those 25 regular files. The enclosing receipt records the archive
hash/size and exact byte aliases copied into this directory. It contains no
private original archives, full dependency tree or runtime binaries.
