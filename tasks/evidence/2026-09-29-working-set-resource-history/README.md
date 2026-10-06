# Working-set resource history staging evidence

Staging deploy run `36550714488` installed commit `8f07e3712`. A fresh VM ran a 128 MiB file-cache workload, then completed a final resource-history flush.

The captured summary in `staging-live-history.json` contains 53 samples, 24 with a known working set. Mean working set is 293,991,082 bytes (280 MB), peak working set is 447,438,848 bytes (427 MB), and the cache-inclusive sampled peak is 1,293,877,248 bytes (1.2 GB). Every known working-set sample was between zero and `memory.current`.

`staging-live-drawer-desktop.png` and `staging-live-drawer-mobile.png` show the exact deployed Pages bundle rendering that captured real-VM summary. The authenticated session, workspace, and node were removed after the summary was captured, so the screenshot check replayed the captured response into the deployed UI while all other API traffic remained live. Dashboard, projects, and settings smoke routes also rendered without an error boundary.

The temporary verification harnesses were removed after the run. Final repository tests cover the collector, storage/read paths, MCP output, and drawer behavior.
