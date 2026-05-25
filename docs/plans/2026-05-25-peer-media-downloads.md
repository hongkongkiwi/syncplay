# Peer Media Downloads Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let desktop and mobile users request a download of the currently loaded media from a specific room user, with consent, pause/resume, reconnect, and clear handling when either side leaves or changes media.

**Architecture:** Add file-transfer as an opt-in server feature, separate from playback sync. The Syncplay server brokers transfer sessions and relays bytes over a dedicated length-prefixed transfer connection, while the existing JSON control connection carries only offers, consent, progress, cancel, and resume state.

**Tech Stack:** Python/Twisted for desktop server and desktop client, Qt for desktop UI, React Native/Expo for mobile UI, `react-native-tcp-socket` for mobile transfer sockets, Jest and Python unit tests.

---

## Product Rules

- Downloads are never automatic. The receiver requests; the sender must approve unless they have explicitly enabled “auto-approve downloads for current room.”
- Only the loaded local file can be shared. Stream URLs, hidden filenames, hashed filenames, and missing local paths are not shareable.
- The server must default to file transfer disabled. Server operators enable it with a config flag and can set size, bandwidth, concurrency, and per-user limits.
- The server relays data for the first version. Direct peer-to-peer is a later project because NAT, mobile OS background rules, TLS, and firewall behavior make direct connections unreliable.
- The playback socket must stay responsive. Never base64 video chunks into the existing `State` / `Set` flow.
- Every transfer has a stable `transferId`, source username, receiver username, room, filename, file size, chunk size, byte offset, file fingerprint, and status.
- The sender can revoke permission at any time.
- The receiver can pause, resume, or cancel at any time.
- If a user disconnects, leaves the room, changes media, or changes file size/fingerprint, the transfer pauses or fails according to the state rules below.

## Transfer State Machine

Receiver-side states:

- `idle`
- `requesting`
- `waiting-for-approval`
- `approved`
- `downloading`
- `paused-local`
- `paused-source-offline`
- `paused-source-changed-media`
- `paused-receiver-offline`
- `verifying`
- `complete`
- `failed`
- `cancelled`

Sender-side states:

- `idle`
- `incoming-request`
- `approved`
- `uploading`
- `paused-receiver-offline`
- `paused-local`
- `complete`
- `cancelled`
- `failed`

State rules:

- Receiver pause: keep transfer metadata and partial file; server stops forwarding bytes.
- Sender pause: keep transfer metadata; receiver shows “paused by sender.”
- Source leaves room but stays connected: pause with `paused-source-offline` if the source is no longer in the receiver’s room.
- Source disconnects: pause for a server-configured grace period, then fail or keep resumable metadata depending on server retention config.
- Source changes media: pause with `paused-source-changed-media` unless the new file has the same fingerprint and size.
- Receiver disconnects: sender pauses; server retains the transfer ticket for the grace period.
- Receiver reconnects: client sends `resumeToken`, local partial size, and expected fingerprint; server resumes from the byte offset if source and file still match.
- Server restarts: transfers fail. Persisting in-flight transfer metadata is a later task.

## Protocol Design

Advertise features:

```json
{
  "fileTransfer": true,
  "fileTransferVersion": 1,
  "fileTransferMaxSize": 2147483648,
  "fileTransferChunkSize": 262144
}
```

Control messages on the existing JSON protocol:

```json
{"Transfer": {"request": {
  "transferId": "uuid",
  "source": "Aki",
  "receiver": "Mobile",
  "room": "default",
  "file": {"name": "movie.mkv", "duration": 7200, "size": 1234567890},
  "offset": 0
}}}
```

```json
{"Transfer": {"offer": {
  "transferId": "uuid",
  "receiver": "Mobile",
  "file": {"name": "movie.mkv", "duration": 7200, "size": 1234567890}
}}}
```

```json
{"Transfer": {"decision": {
  "transferId": "uuid",
  "accepted": true,
  "chunkSize": 262144,
  "fingerprint": "sha256-first-last-size-v1:..."
}}}
```

```json
{"Transfer": {"ticket": {
  "transferId": "uuid",
  "role": "sender",
  "host": "syncplay.example",
  "port": 8995,
  "token": "opaque-server-token",
  "offset": 0,
  "chunkSize": 262144
}}}
```

```json
{"Transfer": {"progress": {
  "transferId": "uuid",
  "transferred": 1048576,
  "size": 1234567890,
  "status": "downloading"
}}}
```

```json
{"Transfer": {"pause": {"transferId": "uuid", "reason": "receiver"}}}
{"Transfer": {"resume": {"transferId": "uuid", "offset": 1048576}}}
{"Transfer": {"cancel": {"transferId": "uuid", "reason": "sender"}}}
{"Transfer": {"error": {"transferId": "uuid", "code": "source-changed-media", "message": "Source changed media."}}}
```

Transfer socket:

1. Client opens a second TCP/TLS connection to the same server port unless the server advertises a separate transfer port.
2. First line is JSON:

```json
{"TransferConnect": {"transferId": "uuid", "token": "opaque-server-token", "role": "sender"}}
```

3. Server validates token, pairs sender and receiver transfer sockets, and switches to length-prefixed binary frames.
4. Frame header is 24 bytes:

```text
uint32 magic "SPFT"
uint16 version
uint16 frameType
uint64 offset
uint32 payloadLength
uint32 headerCrc
```

5. Data frames carry raw bytes. Control frames carry small UTF-8 JSON payloads for `pause`, `resume`, `cancel`, `error`, and `complete`.

## Fingerprint

Use a cheap first-version fingerprint, not a full-file hash:

```text
sha256(filename-normalized + size + first-1MiB + last-1MiB)
```

Reasons:

- Full hashing multi-GB files before transfer makes UX feel broken.
- Size alone is not enough for resume safety.
- First/last sampling catches most wrong-file cases cheaply.

For files under 2 MiB, hash the whole file. Store the fingerprint in transfer metadata and verify it on resume. At completion, receiver may compute a full SHA-256 if the user enables strict verification.

## Security And Abuse Controls

- Server option: `--enable-file-transfers`, default `False`.
- Server option: `--file-transfer-max-size`, default 2 GiB.
- Server option: `--file-transfer-max-active`, default 4 global.
- Server option: `--file-transfer-max-per-user`, default 1 upload and 1 download.
- Server option: `--file-transfer-rate-limit`, default unset.
- Server option: `--file-transfer-token-ttl`, default 10 minutes.
- Only users in the same room can request from each other.
- Sender must still have the same file loaded when accepting and when resuming.
- Receiver writes to a temporary filename first: `.syncplay-download.<transferId>.part`.
- On completion, rename to final filename only after size and fingerprint checks pass.
- Never overwrite an existing file without user confirmation.
- Never expose absolute sender paths to receiver or server logs.
- Do not store server password, transfer tokens, or local file paths in chat logs.

---

### Task 1: Add Shared Transfer Types And Validation

**Files:**
- Create: `syncplay/filetransfer.py`
- Test: `syncplay/tests/test_filetransfer.py`

**Step 1: Write failing tests**

Test cases:

- valid transfer request passes
- missing source or receiver fails
- request from a different room fails
- stream URL file fails
- size above server limit fails
- resume offset must be between `0` and file size

**Step 2: Run test to verify failure**

Run:

```bash
python -m pytest syncplay/tests/test_filetransfer.py -q
```

Expected: fails because `syncplay.filetransfer` does not exist.

**Step 3: Implement minimal module**

Add:

- `TransferStatus`
- `TransferRole`
- `TransferRequest`
- `TransferDecision`
- `TransferSession`
- `validate_transfer_request(source, receiver, file, server_limits)`
- `normalize_transfer_filename(name)`
- `is_shareable_loaded_file(file)`

**Step 4: Run test to verify pass**

Run:

```bash
python -m pytest syncplay/tests/test_filetransfer.py -q
```

Expected: pass.

**Step 5: Commit**

```bash
git add syncplay/filetransfer.py syncplay/tests/test_filetransfer.py
git commit -m "feat(file-transfer): add transfer validation"
```

### Task 2: Add Protocol Message Builders And Parsers

**Files:**
- Modify: `syncplay/protocols.py`
- Modify: `react-native/src/syncplay/protocol.ts`
- Test: `syncplay/tests/test_filetransfer_protocol.py`
- Test: `react-native/__tests__/protocol.test.ts`

**Step 1: Write failing tests**

Desktop tests:

- `JSONCommandProtocol` routes `Transfer` to `handleTransfer`
- client protocol can send request, decision, pause, resume, cancel
- unknown transfer subcommand returns a protocol error without dropping old clients for unrelated messages

Mobile tests:

- builds transfer request
- builds transfer decision
- builds pause/resume/cancel messages
- parses transfer progress and errors

**Step 2: Run tests to verify failure**

Run:

```bash
python -m pytest syncplay/tests/test_filetransfer_protocol.py -q
cd react-native && npm test -- --watch=false __tests__/protocol.test.ts
```

Expected: fail because transfer protocol functions do not exist.

**Step 3: Implement protocol additions**

Desktop:

- Add `Transfer` to `JSONCommandProtocol.handleMessages`.
- Add `handleTransfer` stubs to client and server protocols.
- Add sender methods on `SyncClientProtocol`: `sendTransferRequest`, `sendTransferDecision`, `sendTransferPause`, `sendTransferResume`, `sendTransferCancel`.
- Add server protocol sender methods for `offer`, `ticket`, `progress`, `error`.

Mobile:

- Extend `ClientFeatures` with `fileTransfer` and `fileTransferVersion`.
- Add `TransferMessage` TypeScript types.
- Add builders for request/decision/pause/resume/cancel.
- Extend `SyncplayServerMessage` with `Transfer`.

**Step 4: Run tests to verify pass**

Run the same commands.

**Step 5: Commit**

```bash
git add syncplay/protocols.py syncplay/tests/test_filetransfer_protocol.py react-native/src/syncplay/protocol.ts react-native/__tests__/protocol.test.ts
git commit -m "feat(file-transfer): add transfer protocol messages"
```

### Task 3: Add Server-Side Transfer Manager

**Files:**
- Create: `syncplay/filetransfer_server.py`
- Modify: `syncplay/server.py`
- Test: `syncplay/tests/test_filetransfer_server.py`

**Step 1: Write failing tests**

Test cases:

- request is rejected when server feature disabled
- request is rejected if source and receiver are not in the same room
- request creates pending session and sends offer to source
- accept sends transfer tickets to both clients
- cancel notifies both sides and removes session
- source disconnect pauses session
- receiver disconnect pauses session
- source media change pauses session with `source-changed-media`
- resume fails when fingerprint or file size changed
- expired pending sessions are cleaned up

**Step 2: Run test to verify failure**

```bash
python -m pytest syncplay/tests/test_filetransfer_server.py -q
```

Expected: fail because server manager does not exist.

**Step 3: Implement server manager**

Add:

- `TransferManager`
- `request_transfer(watcher, source_username, file)`
- `accept_transfer(watcher, transfer_id, fingerprint)`
- `reject_transfer(watcher, transfer_id, reason)`
- `pause_transfer(watcher, transfer_id, reason)`
- `resume_transfer(watcher, transfer_id, offset, fingerprint)`
- `cancel_transfer(watcher, transfer_id, reason)`
- `handle_watcher_left(watcher)`
- `handle_watcher_file_changed(watcher)`
- `cleanup_expired_sessions(now)`

Wire into `SyncFactory`:

- initialize manager when `enableFileTransfers` is true
- advertise server feature
- call manager on watcher removal
- call manager on file update
- call manager from `SyncServerProtocol.handleTransfer`

**Step 4: Run tests to verify pass**

```bash
python -m pytest syncplay/tests/test_filetransfer_server.py -q
```

Expected: pass.

**Step 5: Commit**

```bash
git add syncplay/filetransfer_server.py syncplay/server.py syncplay/tests/test_filetransfer_server.py
git commit -m "feat(file-transfer): broker transfer sessions on server"
```

### Task 4: Add Binary Transfer Socket Relay

**Files:**
- Create: `syncplay/filetransfer_wire.py`
- Create: `syncplay/filetransfer_protocol.py`
- Modify: `syncplay/server.py`
- Test: `syncplay/tests/test_filetransfer_wire.py`

**Step 1: Write failing tests**

Test cases:

- encode/decode data frame
- reject bad magic/version
- reject payload larger than chunk limit
- pair sender and receiver by valid token
- relay data frame from sender to receiver
- pause stops relay without losing session
- resume restarts from receiver offset
- socket close pauses session

**Step 2: Run test to verify failure**

```bash
python -m pytest syncplay/tests/test_filetransfer_wire.py -q
```

Expected: fail because wire protocol does not exist.

**Step 3: Implement wire protocol**

Add:

- `TransferFrame`
- `encode_frame(frame)`
- `decode_frame(buffer)`
- `TransferSocketProtocol`
- token validation against `TransferManager`
- paired relay with backpressure
- per-session byte counters

Keep JSON control socket and binary transfer socket separate.

**Step 4: Run tests to verify pass**

```bash
python -m pytest syncplay/tests/test_filetransfer_wire.py -q
```

Expected: pass.

**Step 5: Commit**

```bash
git add syncplay/filetransfer_wire.py syncplay/filetransfer_protocol.py syncplay/server.py syncplay/tests/test_filetransfer_wire.py
git commit -m "feat(file-transfer): relay binary transfer sockets"
```

### Task 5: Add Server Configuration

**Files:**
- Modify: `syncplay/ep_server.py`
- Modify: `syncplay/server.py`
- Modify: `syncplay/constants.py`
- Modify: `syncplay/messages_en.py`
- Test: `syncplay/tests/test_filetransfer_server_config.py`

**Step 1: Write failing tests**

Test cases:

- file transfer defaults disabled
- CLI flag enables feature
- max size parsed
- bad max size rejected
- server features include transfer limits only when enabled

**Step 2: Run test to verify failure**

```bash
python -m pytest syncplay/tests/test_filetransfer_server_config.py -q
```

Expected: fail.

**Step 3: Implement config**

Add flags:

- `--enable-file-transfers`
- `--file-transfer-max-size`
- `--file-transfer-max-active`
- `--file-transfer-max-per-user`
- `--file-transfer-rate-limit`
- `--file-transfer-token-ttl`

**Step 4: Run test to verify pass**

```bash
python -m pytest syncplay/tests/test_filetransfer_server_config.py -q
```

Expected: pass.

**Step 5: Commit**

```bash
git add syncplay/ep_server.py syncplay/server.py syncplay/constants.py syncplay/messages_en.py syncplay/tests/test_filetransfer_server_config.py
git commit -m "feat(file-transfer): add server transfer settings"
```

### Task 6: Add Desktop Client Transfer Service

**Files:**
- Create: `syncplay/filetransfer_client.py`
- Modify: `syncplay/client.py`
- Test: `syncplay/tests/test_filetransfer_client.py`

**Step 1: Write failing tests**

Test cases:

- request download from user builds transfer request
- incoming offer requires approval
- accepted upload reads from current loaded path
- upload refuses when current file path missing
- upload pauses when local user changes media
- download writes `.part` file
- resume starts from partial file size
- cancel removes active socket but keeps completed files
- completed download verifies size and fingerprint before rename

**Step 2: Run test to verify failure**

```bash
python -m pytest syncplay/tests/test_filetransfer_client.py -q
```

Expected: fail.

**Step 3: Implement client service**

Add:

- `FileTransferClient`
- `requestDownload(sourceUser)`
- `handleOffer(payload)`
- `acceptOffer(transferId, destinationPath)`
- `rejectOffer(transferId)`
- `pauseTransfer(transferId)`
- `resumeTransfer(transferId)`
- `cancelTransfer(transferId)`
- `handleTicket(payload)`
- `handleProgress(payload)`
- `handleError(payload)`
- local partial-file metadata stored in memory for v1

Wire into `SyncplayClient`:

- initialize `self.fileTransfer`
- include feature flag in `getFeatures`
- forward `Transfer` messages from protocol
- notify service when local file changes, user leaves, or connection drops

**Step 4: Run test to verify pass**

```bash
python -m pytest syncplay/tests/test_filetransfer_client.py -q
```

Expected: pass.

**Step 5: Commit**

```bash
git add syncplay/filetransfer_client.py syncplay/client.py syncplay/tests/test_filetransfer_client.py
git commit -m "feat(file-transfer): add desktop transfer service"
```

### Task 7: Add Desktop UI

**Files:**
- Modify: `syncplay/ui/gui.py`
- Modify: `syncplay/messages_en.py`
- Test: manual Qt smoke test notes in `docs/plans/2026-05-25-peer-media-downloads.md`

**Step 1: Add UI behavior checklist**

Desktop user-list context menu:

- “Download file from {username}” appears when user is in your room, has a loaded local file, and advertises file transfer.
- Menu item is disabled when server transfer feature is off.
- Incoming request dialog shows username, filename, size, and destination picker.
- Transfer panel shows progress, speed, pause/resume/cancel.
- If source leaves, text changes to “paused: source offline.”
- If source changes media, text changes to “paused: source changed media.”
- If server rejects due to limits, show server-provided error.

**Step 2: Implement UI wiring**

Use existing user-list context menu code around `showListUserContextMenu` in `syncplay/ui/gui.py`.

Add message keys:

- `file-transfer-request-menu-label`
- `file-transfer-incoming-title`
- `file-transfer-accept-label`
- `file-transfer-reject-label`
- `file-transfer-paused-source-left`
- `file-transfer-paused-source-changed`
- `file-transfer-complete`
- `file-transfer-failed`

**Step 3: Manual smoke test**

Run two desktop clients against a local transfer-enabled server:

```bash
python -m syncplay.ep_server --enable-file-transfers --port 8995
python -m syncplay.ep_client --host localhost --port 8995
python -m syncplay.ep_client --host localhost --port 8995
```

Expected:

- receiver can request sender’s loaded file
- sender sees approval dialog
- receiver sees progress
- pause/resume/cancel buttons work

**Step 4: Commit**

```bash
git add syncplay/ui/gui.py syncplay/messages_en.py docs/plans/2026-05-25-peer-media-downloads.md
git commit -m "feat(file-transfer): add desktop transfer UI"
```

### Task 8: Add Mobile Transfer Protocol And State

**Files:**
- Create: `react-native/src/syncplay/fileTransfer.ts`
- Modify: `react-native/src/syncplay/protocol.ts`
- Modify: `react-native/src/syncplay/connection.ts`
- Modify: `react-native/src/syncplay/state.ts`
- Test: `react-native/__tests__/fileTransfer.test.ts`
- Test: `react-native/__tests__/connection.test.ts`
- Test: `react-native/__tests__/state.test.ts`

**Step 1: Write failing tests**

Test cases:

- request/decision/pause/resume/cancel messages encode correctly
- transfer offer updates app state
- progress updates app state
- source-left and source-changed errors map to paused status
- reconnect resume message includes offset and token

**Step 2: Run test to verify failure**

```bash
cd react-native
npm test -- --watch=false __tests__/fileTransfer.test.ts __tests__/connection.test.ts __tests__/state.test.ts
```

Expected: fail.

**Step 3: Implement mobile state**

Add:

- `TransferSession`
- `TransferStatus`
- transfer actions in reducer
- protocol builders
- `SyncplayConnection` methods for request/decision/pause/resume/cancel

**Step 4: Run test to verify pass**

Run same command.

**Step 5: Commit**

```bash
git add react-native/src/syncplay/fileTransfer.ts react-native/src/syncplay/protocol.ts react-native/src/syncplay/connection.ts react-native/src/syncplay/state.ts react-native/__tests__/fileTransfer.test.ts react-native/__tests__/connection.test.ts react-native/__tests__/state.test.ts
git commit -m "feat(file-transfer): add mobile transfer state"
```

### Task 9: Add Mobile Binary Transfer Socket

**Files:**
- Create: `react-native/src/syncplay/transferSocket.ts`
- Test: `react-native/__tests__/transferSocket.test.ts`

**Step 1: Write failing tests**

Test cases:

- encodes transfer connect handshake
- decodes data frames
- writes file chunks to provided sink
- pause closes or stalls socket without deleting partial file
- resume starts at partial file size
- bad fingerprint fails finalization

Use dependency injection for socket and file sink so Jest does not need real network or device storage.

**Step 2: Run test to verify failure**

```bash
cd react-native
npm test -- --watch=false __tests__/transferSocket.test.ts
```

Expected: fail.

**Step 3: Implement transfer socket**

Use `react-native-tcp-socket` for the socket.

Use a file sink abstraction:

- Android/iOS implementation writes into app document cache first.
- Final destination uses user-selected folder or app document directory.
- The first version can save into app documents and expose “Share/open file” after completion if direct user-folder write is blocked.

**Step 4: Run test to verify pass**

Run same command.

**Step 5: Commit**

```bash
git add react-native/src/syncplay/transferSocket.ts react-native/__tests__/transferSocket.test.ts
git commit -m "feat(file-transfer): add mobile transfer socket"
```

### Task 10: Add Mobile UI

**Files:**
- Modify: `react-native/App.tsx`
- Modify: `react-native/README.md`
- Test: `react-native/__tests__/screens.test.ts`

**Step 1: Write failing tests**

Screen registry should include transfer UI if it becomes its own tab, or App helper tests should verify transfer action visibility:

- show download action for another user with shareable file and transfer support
- hide download action for self
- hide download action when file is a stream URL
- show pause/resume/cancel controls by status

**Step 2: Run test to verify failure**

```bash
cd react-native
npm test -- --watch=false __tests__/screens.test.ts
```

Expected: fail.

**Step 3: Implement UI**

Add a Transfers screen or a Transfers panel in Room:

- request button in `UserRow`
- incoming request modal
- active transfer list
- pause/resume/cancel buttons
- progress and speed text
- final “Open” / “Share” action after completion

**Step 4: Run test to verify pass**

Run same command.

**Step 5: Commit**

```bash
git add react-native/App.tsx react-native/README.md react-native/__tests__/screens.test.ts
git commit -m "feat(file-transfer): add mobile transfer UI"
```

### Task 11: End-To-End Failure Mode Tests

**Files:**
- Create: `syncplay/tests/test_filetransfer_e2e.py`
- Create: `docs/file-transfers.md`

**Step 1: Write integration tests**

Scenarios:

- sender approves and receiver completes
- receiver pauses and resumes
- sender pauses and resumes
- sender disconnects and reconnects within grace period
- receiver disconnects and reconnects within grace period
- sender changes media mid-transfer
- receiver cancels
- sender cancels
- server limit rejects transfer

**Step 2: Run tests**

```bash
python -m pytest syncplay/tests/test_filetransfer_e2e.py -q
```

Expected: pass after prior tasks.

**Step 3: Add docs**

`docs/file-transfers.md` should cover:

- server opt-in
- privacy model
- consent model
- where files are saved
- pause/resume behavior
- what happens if someone leaves, changes media, or reconnects
- mobile storage limits

**Step 4: Commit**

```bash
git add syncplay/tests/test_filetransfer_e2e.py docs/file-transfers.md
git commit -m "test(file-transfer): cover transfer failure modes"
```

### Task 12: Full Verification

**Files:**
- No code changes unless verification finds bugs.

**Step 1: Desktop tests**

```bash
python -m pytest syncplay/tests -q
```

Expected: all pass.

**Step 2: Mobile tests**

```bash
cd react-native
npm test -- --watch=false
npm run typecheck
npx expo install --check
cd android && ./gradlew :app:assembleDebug
```

Expected:

- Jest pass
- TypeScript pass
- Expo dependency check pass
- Android debug build success

**Step 3: Manual desktop/mobile smoke**

Run transfer-enabled local server, one desktop client, one mobile client:

- desktop source loads local file
- mobile requests download
- desktop approves
- mobile pauses and resumes
- desktop changes media mid-transfer and mobile shows paused/failed status
- repeat with desktop receiver and mobile source if mobile can provide a readable local URI

**Step 4: Commit fixes if needed**

Commit any fixes with narrow messages:

```bash
git commit -m "fix(file-transfer): handle <specific case>"
```

## Open Questions Before Coding

- Should server relay be allowed on public servers, or should official public servers keep it disabled?
- Should mobile save completed files only in app storage for v1, or require a destination folder picker?
- Should auto-approve be allowed at all, or should every request require a prompt?
- Should strict full-file SHA-256 verification be on by default despite the extra wait after completion?
- What is the default max file size? This plan uses 2 GiB, but many users will want larger movie files.

## Recommended First Build Slice

Build in this order:

1. Protocol and server manager without byte relay.
2. Desktop-only relay with two desktop clients.
3. Mobile receiver.
4. Mobile sender.

That gives us a working, reviewable core before mobile storage edge cases take over the project.
