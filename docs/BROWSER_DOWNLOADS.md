# Browser download decision — beta.17

Chrome's Downloads API starts a direct HTTP(S) file transfer without local tools.
Its persistent download ID is saved with the job, and onChanged plus popup polling
reconcile progress, completion and interruption from Chrome's own record. The
filename is derived from the validated selected resource title. The selected URL
is dispatched unchanged: it is not replaced by the webpage or a previous video.
Active selection/session validation from beta.15 is retained.

A standalone manifest omits nativeMessaging. Both editions share all JS/assets;
Full requests nativeMessaging for existing complex download flows. A missing
native capability produces an explicit Full-required message before enqueueing.
Chrome owns temporary direct-download data. Native partial data is retained under
the checkpointed VOD HLS policy (verified fragments only); no sweeping deletion of Downloads occurs.

HLS-to-MP4 is not implemented in this browser release. MSE receives encoded media
for playback; it is not a universal file muxer. An offscreen document can manage
Blobs, but this alone does not resolve alternate audio, encryption, byte ranges,
discontinuities, expiring request contexts or multi-gigabyte memory pressure. A
new JS/WASM muxing dependency would require codec/container coverage, licensing,
memory/cancellation/restart tests and real-site validation. No untested library
or unbounded in-memory segment concatenator has been added.

Full also retains an explicit Options switch to route direct files through the
original Native Host pipeline for captured headers or MP4 conversion. Standalone
always uses Chrome regardless of a synced Full preference. Re-selecting a resource
creates a job with the newly selected engine; retry keeps the existing engine.

Direct Chrome downloads retain the original container and do not force custom Cookie,
Origin, User-Agent or Referer headers. A server may reject the request. Full can
use the captured request context under its existing policy. Chrome completion
means transfer completion; Native completion uses ffprobe and its validation rules.

References checked 2026-11-20:
- https://developer.chrome.com/docs/extensions/reference/api/downloads
- https://developer.chrome.com/docs/extensions/reference/api/offscreen
- https://developer.mozilla.org/en-US/docs/Web/API/MediaSource
