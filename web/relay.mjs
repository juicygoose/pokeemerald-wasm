// Minimal WebSocket room relay for wasm netplay (M2 of docs/netplay-next-steps).
//
// Groups 2-4 peers into a room and forwards one small JSON message per peer per
// event (serial transfer, frame boundary, control). It is deliberately dumb: it
// never inspects or rewrites the serial words, it only fans them out to the
// other peers in the room. All lockstep logic lives in the clients
// (tools/wasm_relay_transport.mjs); the relay is just the wire.
//
// No npm dependency: this is a hand-rolled RFC 6455 server over Node's built-in
// http 'upgrade' event (the matching client side uses Node's global WebSocket).
//
// Wire protocol (JSON text frames):
//   client -> relay  {type:'join', room, max?}      join/create a room
//   relay  -> client {type:'joined', playerId, playerCount, max}
//   relay  -> client {type:'ready'}                 sent to all once room is full
//   client -> relay  {type:'xfer', seq, word}       a staged serial word
//   client -> relay  {type:'frameEnd', frame}       end of a frame's transfers
//   client -> relay  {type:'bye'}                   leave
//   relay  -> client (xfer/frameEnd are forwarded verbatim with `from` added)
//   relay  -> client {type:'peerGone', playerId}    a peer disconnected

import { createHash } from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

// --- RFC 6455 framing ---------------------------------------------------------
function acceptKey(key) {
  return createHash('sha1').update(key + GUID).digest('base64');
}

// Encode a server->client text frame (unmasked).
function encodeFrame(str) {
  const payload = Buffer.from(str, 'utf8');
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 0x10000) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x81; // FIN + text opcode
  return Buffer.concat([header, payload]);
}

// Pull complete frames out of a growing buffer. Returns {messages, rest, closed}.
// Handles text (0x1), close (0x8), ping (0x9), pong (0xA); assumes unfragmented
// frames (our messages are tiny), but tolerates 16/64-bit lengths.
function drainFrames(buf) {
  const messages = [];
  let closed = false;
  let off = 0;
  while (off + 2 <= buf.length) {
    const b0 = buf[off];
    const b1 = buf[off + 1];
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let p = off + 2;
    if (len === 126) { if (p + 2 > buf.length) break; len = buf.readUInt16BE(p); p += 2; }
    else if (len === 127) { if (p + 8 > buf.length) break; len = Number(buf.readBigUInt64BE(p)); p += 8; }
    let maskKey;
    if (masked) { if (p + 4 > buf.length) break; maskKey = buf.subarray(p, p + 4); p += 4; }
    if (p + len > buf.length) break; // wait for more bytes
    const payload = buf.subarray(p, p + len);
    if (masked) for (let i = 0; i < len; i++) payload[i] ^= maskKey[i & 3];
    off = p + len;
    if (opcode === 0x8) { closed = true; break; }
    else if (opcode === 0x1) messages.push(payload.toString('utf8'));
    // opcode 0x9 (ping) / 0xA (pong) / continuation: ignored for our traffic
  }
  return { messages, rest: buf.subarray(off), closed };
}

// --- Room bookkeeping ---------------------------------------------------------
class Peer {
  constructor(socket) {
    this.socket = socket;
    this.room = null;
    this.playerId = -1;
    this.alive = true;
  }
  send(obj) {
    if (this.alive) this.socket.write(encodeFrame(JSON.stringify(obj)));
  }
}

export class Relay {
  constructor({ log = () => {} } = {}) {
    this.rooms = new Map(); // roomId -> Peer[]
    this.log = log;
  }

  // Attach to a Node http.Server: relay takes over 'upgrade' requests.
  attach(httpServer) {
    httpServer.on('upgrade', (req, socket) => this._handleUpgrade(req, socket));
    return this;
  }

  _handleUpgrade(req, socket) {
    const key = req.headers['sec-websocket-key'];
    if (!key) { socket.destroy(); return; }
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`,
    );
    const peer = new Peer(socket);
    let buf = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const { messages, rest, closed } = drainFrames(buf);
      buf = rest;
      for (const m of messages) this._onMessage(peer, m);
      if (closed) socket.end();
    });
    socket.on('close', () => this._onClose(peer));
    socket.on('error', () => this._onClose(peer));
  }

  _onMessage(peer, raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type === 'join') return this._join(peer, msg);
    if (peer.room == null) return;
    if (msg.type === 'bye') return this._onClose(peer);
    // Forward gameplay messages (xfer/frameEnd/anything else) to the other peers.
    const others = (this.rooms.get(peer.room) || []).filter((p) => p !== peer && p.alive);
    for (const o of others) o.send({ ...msg, from: peer.playerId });
  }

  _join(peer, { room, max = 2 }) {
    if (peer.room != null) return;
    let members = this.rooms.get(room);
    if (!members) { members = []; this.rooms.set(room, members); }
    if (members.length >= max) { peer.send({ type: 'full' }); peer.socket.end(); return; }
    peer.room = room;
    peer.playerId = members.length; // arrival order -> player id (0 = master)
    members.push(peer);
    peer.send({ type: 'joined', playerId: peer.playerId, playerCount: members.length, max });
    this.log(`room ${room}: peer joined as player ${peer.playerId} (${members.length}/${max})`);
    if (members.length === max) {
      for (const p of members) p.send({ type: 'ready', playerCount: max });
      this.log(`room ${room}: ready with ${max} players`);
    }
  }

  _onClose(peer) {
    if (!peer.alive) return;
    peer.alive = false;
    if (peer.room == null) return;
    const members = this.rooms.get(peer.room);
    if (members) {
      const idx = members.indexOf(peer);
      if (idx >= 0) members.splice(idx, 1);
      for (const p of members) p.send({ type: 'peerGone', playerId: peer.playerId });
      if (members.length === 0) this.rooms.delete(peer.room);
    }
    this.log(`room ${peer.room}: peer ${peer.playerId} left`);
  }
}

// Convenience: start a standalone relay-only server (no static files).
export function startRelayServer(port = 0, opts = {}) {
  return new Promise((resolveP) => {
    import('node:http').then(({ createServer }) => {
      const server = createServer((_req, res) => res.writeHead(426).end('upgrade required'));
      const relay = new Relay(opts).attach(server);
      server.listen(port, function () {
        resolveP({ server, relay, port: this.address().port });
      });
    });
  });
}
