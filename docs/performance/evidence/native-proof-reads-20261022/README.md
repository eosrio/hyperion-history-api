# Wire proof-read baseline, 2026-10-22

These are actual Elasticsearch 9.5.5 component measurements from the unchanged
original Wire prefix, run sequentially on native Linux Node 24.19.0 and 22.23.3.
The broker is controlled. The known valid-input expiry remains reproduced;
these files do not qualify the full worker, MongoDB, Wire release or Bun runtime.

Run `python verify.py` from this directory to authenticate every published file,
all 37 raw archive members, both diagnosis outcomes and the eight CPU profiles.
The raw archive contains 36 payload files, totaling 75,420,681 bytes, plus its
5,982-byte manifest. No payload in that archive was redacted or reserialized.

`summary.json` contains descriptive measurements and limits. `cleanup-projection.json`
is explicitly a projection of complete private host receipts: private addresses,
listeners and full incumbent inventories are omitted, and the original receipt
hashes are retained. The complete private originals were independently checked.

Two excluded launcher attempts stopped before proof measurement. Their unmodified
stdout/stderr is under `pilots/`; neither supplies a timing sample. The successful
Linux cases retain their own source/build/runtime/dependency manifests, full logs,
service-resource samples, owned service identity/settings and four CPU captures
each. Host-side SSH wrappers and the complete private host inventory are outside
this archive's declared scope.

See [the report](../../native-proof-read-amplification.md) and
[reproduction/cleanup instructions](../../../diagnostics/native-worker-proof-credit.md).
