# File Transfers

Syncplay file transfers are server-relayed and off by default.

Enable them with `syncplay-server --enable-file-transfers`. Operators can also set file size, active transfer, per-user, rate, and token lifetime limits.

The receiver requests a file from a specific room user. The sender must approve before any ticket is issued. The receiver never tells the server what file the sender has; the server reads the sender’s current room and media metadata from its own watcher state.

The playback JSON socket only carries request, offer, decision, ticket, progress, pause, resume, cancel, and error messages. Media bytes use the transfer socket frame format.

Files download to a temporary `.syncplay-download.<transferId>.part` name first. The client renames or exposes the file only after size and fingerprint checks pass.

If the sender leaves, the receiver sees the transfer paused as `source-offline`. If the sender changes media, the transfer pauses as `source-changed-media`. A resume only works when the source file size and fingerprint still match.

Mobile clients store partial data through the transfer socket file sink. The first mobile UI exposes transfer request, pause, resume, and cancel controls; destination-folder handling stays platform-specific because Android and iOS expose different filesystem permissions.
