# Realtime Server

## Run

```bash
npm run dev
```

Default port is `4000` (override with `PORT`).

## Environment

- `PORT`: HTTP/WebSocket port.
- `ROOM_CODE`: room label included in `session:state` (default `FUTBOL`).

## Main Socket Events

- Server -> client: `session:state`, `session:error`
- Client -> server:
  - `session:register-player`
  - `session:set-games`
  - `session:open-lobby`
  - `session:start-game`
  - `session:buzz`
  - `session:mark-correct`
  - `session:mark-wrong`
  - `session:resume`
  - `session:pause`
  - `session:next-game`
  - `session:sync-registered-subjects`

## HTTP Endpoints

- `GET /health`
- `GET /session`
