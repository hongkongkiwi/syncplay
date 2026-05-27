# Syncplay Web Client

This package adds a browser client for Syncplay. It runs as a TanStack Start app and uses a WebSocket bridge to reach a Syncplay server over TCP.

## Run it

```sh
pnpm install
pnpm --filter syncplay-web-client dev
```

Open <http://localhost:3000>, pick a local media file, connect to a Syncplay server, then join a room.

To check the built app:

```sh
pnpm --filter syncplay-web-client build
pnpm --filter syncplay-web-client start
```

## Why there is a bridge

Syncplay servers speak a line-based JSON protocol over TCP. Browser JavaScript cannot open TCP sockets, so the app opens a WebSocket to `/syncplay-proxy`; the Vite server bridges that WebSocket to the target Syncplay host and port.

The bridge is locked to local hosts by default:

```sh
SYNCPLAY_WEB_ALLOWED_HOSTS=localhost,127.0.0.1,::1 pnpm --filter syncplay-web-client dev
```

For a hosted deployment, set `SYNCPLAY_WEB_ALLOWED_HOSTS` to the Syncplay hosts that browser users may reach. Use `*` only for private deployments behind your own access controls.

## Current scope

The web client supports room join, chat, room user list, readiness, local file announcement, and browser video sync. File transfer is disabled in the client feature list because browser storage and Syncplay's transfer socket need a separate design.
