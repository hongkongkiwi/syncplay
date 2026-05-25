# Syncplay Mobile

This is an Expo React Native client for Syncplay. It speaks the same newline-delimited JSON protocol as the desktop app and connects to a Syncplay server over TCP or TLS.

It needs a native development build because the app uses native modules for TCP sockets, file access, video playback, and local storage. Expo Go won’t load it.

## Run

```bash
npm install
npm run ios
# or
npm run android
```

The native projects are generated in `ios/` and `android/` because the TCP socket dependency includes native code.

Useful build checks:

```bash
npm test -- --watch=false
npm run typecheck
npx expo install --check
cd android && ./gradlew :app:assembleDebug
```

Android release signing reads these values from Gradle properties or environment variables:

```bash
SYNCPLAY_UPLOAD_STORE_FILE=/path/to/upload.keystore
SYNCPLAY_UPLOAD_STORE_PASSWORD=...
SYNCPLAY_UPLOAD_KEY_ALIAS=...
SYNCPLAY_UPLOAD_KEY_PASSWORD=...
```

For iOS, open `ios/SyncplayMobile.xcworkspace` or run:

```bash
npm run ios
```

## What works

- Connect to a Syncplay server with host, port, name, room, and optional server password.
- Choose a public server, enter `host:port` manually, and switch between plain TCP and TLS.
- Use the native synced mobile player. External app handoff is not offered because third-party mobile players do not provide reliable position, pause, play, or seek control back to this app.
- Pick local videos through the system file picker or open a stream URL.
- Build a searchable media list before connecting. Pick individual files or scan a folder, then playlist entries and room-user files are matched by filename.
- Send file, play/pause, seek, readiness, room, and chat updates.
- Apply remote play/pause, seek, and small playback-rate corrections to the local video player.
- Show room users, ready state, current files, server messages, and chat.
- Join saved rooms or rooms currently visible on the server, including managed-room entries with operator passwords.
- Use shared playlists for URLs and known filenames, including remote playlist selection.
- Create managed rooms, identify as room operator, and set another user's ready state.
- Persist server, room, media search, and session options locally.
- Reconnect after socket errors unless the user disconnects manually.
- Keep room passwords out of persisted preferences. You need to re-enter them after app restart.

## Watch Flow

1. Pick a public server or enter `host:port` manually.
2. Enter a display name and room. Syncplay does not use accounts or registration.
3. Leave the player as the native synced mobile player.
4. Add media files or a media folder to the search list. Folder scanning is deeper on Android. iOS folder access can be temporary, so keep picked files available as a fallback.
5. Connect to the server.
6. Open a local video, open a stream URL, or pick a shared playlist item that matches a local filename.
7. Mark yourself ready and use the room controls to play, pause, seek, chat, or switch rooms.

## Matching Rules

Syncplay does not send video files between devices. Everyone needs access to the same media through a local file or a stream URL.

The mobile app matches remote playlist entries and other users' files by filename against the media search list. If it cannot find a match, it shows the missing name and leaves the current player item alone. Add the matching file or folder, then choose the playlist item again.

Stream URLs are opened directly from the playlist or manual URL field.

## Accounts

There are no Syncplay user accounts in this client. The server connection uses:

- server address
- display name
- room name
- optional server password
- optional managed-room operator password

## Current Limits

- Mobile uses the native Expo video player, not mpv, VLC, MPC-HC, or mplayer. External-player handoff is intentionally left out because it cannot keep Syncplay state dependable on iOS or Android.
- File matching is name-based. The app does not hash media files before joining.
- Folder scanning depends on the mobile OS file picker permission model.
- Custom TLS certificates are not exposed in the UI.
- Background playback depends on platform behavior and app build settings.

## Screens

- Connect: server, identity, room, password, player, and media search setup.
- Watch: video player, transport controls, typed seek, stream URL, file picker, media search list, and playback status.
- Room: room members, room joining, saved rooms, shared playlist, managed rooms, and ready controls.
- Chat: server messages and room chat.
- Settings: sync correction hold, reconnect, automatic file switching, background playback, and connection actions.

## After Native Dependency Changes

Rebuild the dev client after adding or updating native dependencies:

```bash
npm run ios
# or
npm run android
```

Restarting Metro is not enough if the installed dev client was built before the native dependency changed.
