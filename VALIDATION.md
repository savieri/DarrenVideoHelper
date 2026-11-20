# v1.2.1-beta.18 validation

Date: 2026-11-20. Apple Silicon macOS; Python 3.14; FFmpeg/ffprobe 9.0.2;
project-local yt-dlp **2026.10.26**, installed from PyPI with a pinned SHA-256.
This is a public prerelease, not a stable/universal-site claim.

## Startup/storage hotfix evidence

The reported beta.17 registration failure was reproduced before the fix: the actual
Manifest exposes no commands API, but a stale listener accessed it. The old mock
incorrectly supplied that API. Tests now use the real Manifest and include both
editions. Added quota rejection, bounded multi-tab caches, coalesced writes, durable
state before optional session credentials, safe legacy migration, unrelated-setting
preservation, and opaque file-origin coverage. See [the beta.18 report](docs/REPAIR_REPORT_beta18.md).

## Automated regressions

**113/113 passed: 60 JavaScript + 53 Python.** Run `bash scripts/test.sh` with Node.js,
Python 3.11+, FFmpeg and ffprobe available. The HLS tests bind a loopback HTTP
server and generate their own authorized test media.

Coverage includes current-player/session/SPA binding, old selection rejection,
HLS ranking/renditions, Chrome direct-file jobs and persistence, concurrent enqueue,
duplicate dispatch guards, terminal-state consistency, redacted diagnostics,
Native framing/headers, output validation, unsafe input rejection, cancellation
generations, legacy false-resume rejection, installer/manifest policy and the real
HTTP/FFmpeg tests below.

| Scenario | Evidence |
| --- | --- |
| Normal MP4 / WebM / HLS | Real Native protocol and generated files; ffprobe/audio checks passed |
| Segment 828 temporary 503 | Real HTTP server, two injected 503s, then complete 1000-segment file |
| Segment 828 persistent 403 | Bounded requests, no final MP4, verified inputs retained; subsequent authorized retry reused nonsampled bytes |
| Authorized manifest refresh | Fixture issues fresh valid segment URLs; structural and byte checks precede reuse |
| Missing 404 / corrupt HTTP 200 media | No incomplete file published as successful |
| Network disconnect / process kill | Real dropped HTTP response; real SIGKILL of host, later state query and resume |
| Retry-After | Actual delay test and restart deadline test; no early request |
| TS / fMP4 / MAP / BYTERANGE / AES-128 | Real local HTTP and FFmpeg completion |
| Master + default separate audio | Actual merged output contains audio; unused alternate audio not requested |
| Changed sequence / content / local corruption | Reuse blocked or corrupted local data fetched again |
| Wrong selected duration | Stops before media transfer |
| Merge failure | Verified inputs retained, independent retry succeeds |
| Disk full | Disk-space fault injection stops before publication |
| Cancel / cleanup | True Native cancel; isolated cleanup preserves unrelated files |
| Same titles / concurrent jobs | Atomic nonclobbering filenames and separate work directories |
| Atomic publication interruption | Injected failure after link; retry repairs state without a second output |
| Chrome worker/storage restart | API mock regression, not a real Chrome process restart |

## Real Native and installer runs

`scripts/stability_native_smoke.py` passed with the pinned extractor: two framed
pings; direct MP4 and WebM; HLS; completed-job idempotent replay; true host kill,
status query and resume; parallel isolated outputs; duplicate Job ID busy reply;
cancellation with verified data preserved.

The beta.18 macOS installer ran in isolated registration/install directories with Chinese
characters and spaces. It created its own pinned runtime, copied the actual source
modules, passed self-tests, and registered the derived extension ID
`mabnjnddplpelefjgohbjcoajnimpgna`. The user's live Chrome host registration was
not modified by these tests. Internet-download Gatekeeper approval was not automated;
the installer remains unsigned and unnotarized. Release ZIP extraction/reference/source-parity checks
and an extracted installer check are part of release verification.

## Long-transfer stress

The HLS engine is byte-identical to beta.17. The following stress result was run
for beta.17 and was not rerun for this storage/startup hotfix.

`scripts/hls_stress.py`: **2482 segments / 7446.08 seconds / 2,362,476,808 input
bytes**. Two temporary 503s at segment 828 recovered. Output: 116,399,789 bytes,
audio present, full expected duration; only checkpoint.json left in the work
directory. Python peak RSS 41,484,288 bytes; elapsed 18.35 seconds on this Mac.
The generated valid MPEG-TS includes null-packet padding, so this tests large
streaming transfers without claiming real-site throughput or representative 4K
codec complexity. No user media is included in the repository or test results.

## Chrome UI

The beta.17 sample preview used actual popup HTML/CSS/JS rendered in Chrome on a local HTTP fixture with clearly
labeled sample data: 390px body, 374px job cards, readable attention/verification
labels, long-title truncation, resource sorting and refresh. Screenshot is
`docs/images/popup.png`; it is not evidence of a live extension download.

## Not validated

- Original target CDN: its authorization/rate-limit root cause is still unknown;
  local simulated 403 recovery is not a claim that this website is fixed.
- Live beta.18 loading through chrome://extensions, a real browser Downloads API
  transfer, actual Chrome close/reopen, fresh machine without dependencies.
  The automation browser rejects the internal chrome: protocol; it was not bypassed.
- Intel Mac, Windows or Linux execution; live/low-latency HLS; DRM; all timestamp,
  discontinuity and multiple-language variants across websites; full-frame decode
  of every frame. Invalid or unsupported media is retained and rejected.
- Migration of arbitrary old yt-dlp .part files without a compatible checkpoint.
  The supplied old task's recorded recovery/output paths contained no matching
  files in the read-only audit.

See [the detailed repair report](docs/REPAIR_REPORT_beta17.md) for each root cause,
changed file, test, recovery limit and reproduction command.
