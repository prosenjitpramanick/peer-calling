# Peer Video Call

Custom audio/video chat sample that uses [simple-peer for WebRTC connections and [Browserify]to bundle the browser script. Two peers can discover one another, manually place a call, and accept or reject the incoming request before streams are connected.

## Features
- Register with a short display name and share your generated peer ID.
- Live roster that shows who is online and whether they are currently busy.
- Explicit call flow: caller initiates, callee accepts or rejects.
- Manual target ID input so you can paste a peer ID directly without picking from the list.
- Quick audio/video checkboxes to mute your camera or mic before or during a call.
- Audio + video streams rendered side-by-side with end-call controls.
- Signaling implemented with a lightweight Express + `ws` server.

## Getting Started
1. Install dependencies:
   ```bash
   npm install
   ```
2. Build the browser bundle:
   ```bash
   npm run build
   ```
3. Start the server (build is run automatically):
   ```bash
   npm start
   ```
4. Open `http://localhost:3000` in two different tabs or browsers. Enter distinct names, join, then select a peer and press **Call Selected**.
5. When a call arrives, the callee can **Accept** or **Reject** the invitation. Accepting connects the simple-peer instance and begins streaming.

### Feature Flags via .env

Create a `.env` file in the project root to control optional client features:

```bash
ENABLE_AUDIO_CALL=true
ENABLE_VIDEO_CALL=true
ENABLE_TEXT_CHAT=true
```

- `ENABLE_AUDIO_CALL` defaults to `true`.
- `ENABLE_VIDEO_CALL` defaults to `true`; set to `false` to run audio-only calls without loading video UI.
- `ENABLE_TEXT_CHAT` defaults to `true`; set to `false` to disable the in-call text chat panel and handlers.

Boolean values accept `true/false`, `1/0`, `yes/no`, and `on/off`.

### Call Webhooks

You can notify an external HTTP endpoint when a call is accepted or when it ends:

```bash
CALL_WEBHOOK_URL=https://your-server.example/hooks/peer-call
```

When configured, the server sends `POST` requests with JSON bodies for:

- `call.accepted`: includes `ownerName`, `ownerId`, `peerName`, `peerId`, and `acceptedAt`.
- `call.ended`: includes the same fields plus `endedAt`, `elapsedMs`, `elapsedSeconds`, `elapsedTime`, and `reason`.

`ownerName` is the peer who received and accepted the call. `peerName` is the peer who initiated it.

### Running behind Apache
If you want Apache to handle public traffic and forward it to Node:

1. Ensure the Node server listens on an internal port (e.g., set `PORT=4000 npm start`).
2. Copy the sample config from `apache-proxy.conf` into your `<VirtualHost>` block. By default it mounts the app under `https://your-host/peer-call/`.
3. Enable the required Apache modules: `proxy`, `proxy_http`, `proxy_wstunnel`, and `headers`.
4. Keep the `/peer-call/ws` `ProxyPass` directives **above** the generic `/peer-call/` rule so Apache upgrades WebSockets before falling through to HTTP.
5. Reload Apache. HTTP traffic and WebSocket upgrades under the `/peer-call` prefix will route to the Node server while static files continue to be served by Express.
5. The front-end auto-detects when it is served from `/peer-call`. If you mount the app under a different prefix, either set `window.__PEER_BASE_PATH__ = '/your-prefix'` before loading `bundle.js` or add `<meta name="peer-base-path" content="/your-prefix">` to `public/index.html`.

### Auto-starting the Node server
To keep `npm start` running after boot (and restart it if it crashes) use the helper files in this repo:

1. Make the supervisor script executable:
   ```bash
   chmod +x scripts/auto-start-peer.sh
   ```
2. Copy the systemd unit file and reload systemd:
   ```bash
   sudo cp systemd/peer-call.service /etc/systemd/system/
   sudo systemctl daemon-reload
   ```
3. Enable and start the service:
   ```bash
   sudo systemctl enable --now peer-call.service
   ```
4. Logs are written to `logs/peer-server.log`; follow them with `tail -f logs/peer-server.log`.

The unit runs the Node app under `/peer-call` on internal port `4000`, restarts it automatically, and starts on every boot.

# Check if service is running
sudo systemctl list-units --type=service --all | grep peer


## Project Structure
```
├── public/          # Static assets served by Express
│   ├── bundle.js    # Browserify output
│   ├── index.html   # UI layout
│   └── styles.css   # Visual design
├── src/
│   └── client.js    # Browser source bundled by Browserify
├── server.js        # Signaling server + static hosting
└── package.json
```

## Notes
- Browserify is invoked via `npm run build`. Re-run this command whenever you change files in `src/`.
- The example uses ephemeral, in-memory state for connected peers. Refreshing clears registrations.
- WebRTC media requires HTTPS in production; the sample assumes local development over HTTP.


API Endpoints Example
curl "http://localhost:4000/api/peers/by-name?name=Alice"
{"id":"f693e79e-294d-4a3a-979a-d42eeece4027","busyState":false}
{"error":"peer-not-found","message":"No peer found with name \"LumenFox41\"."}
# peer-calling
