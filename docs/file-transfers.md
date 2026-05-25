# File Transfers

Syncplay file transfers are server-relayed and off by default.

Enable them with `syncplay-server --enable-file-transfers`. Operators can also set file size, active transfer, per-user, rate, and token lifetime limits.

The receiver requests a file from a specific room user. The sender must approve before any ticket is issued. The receiver never tells the server what file the sender has; the server reads the sender’s current room and media metadata from its own watcher state.

The playback JSON socket only carries request, offer, decision, ticket, progress, pause, resume, cancel, and error messages. Media bytes use the transfer socket frame format. The server reports relayed byte counts to both sides.

Desktop downloads use a temporary `.syncplay-download.<transferId>.part` name first, then rename the file after size and fingerprint checks pass. The mobile app uses a filename-based `.part` file in the selected folder or app document folder, then moves it to the final filename when the complete frame arrives.

If the sender leaves, the receiver sees the transfer paused as `source-offline`. If the sender changes media, the transfer pauses as `source-changed-media`. A resume only works when the source file size and fingerprint still match.

Desktop senders get an approval prompt before the transfer starts, and desktop receivers get a save-file picker. Mobile receivers can pick a download folder from the Transfers screen. Mobile senders upload from the local media library item that matches the loaded filename.
