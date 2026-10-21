import { createServer } from "node:http";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";

/** 真实 loopback 协议夹具：不模拟企业或 OAuth；仅实现既有 HMAC relay 配对与透传。 */
export async function createHmacTestRelay() {
  const server = createServer((_request, response) => {
    response.writeHead(404).end();
  });
  const sockets = new WebSocketServer({ server });
  const rooms = new Map<string, { hash: string; device?: WebSocket; terminal?: WebSocket }>();
  const messages: Array<{ type: string; role?: string }> = [];
  const send = (socket: WebSocket | undefined, payload: unknown) => {
    if (socket?.readyState === 1) socket.send(JSON.stringify(payload));
  };
  sockets.on("connection", (socket) => {
    let sid = "";
    let role: "device" | "terminal" | undefined;
    let nonce: string | undefined;
    let authenticated = false;
    const status = () => {
      const room = rooms.get(sid);
      const payload = {
        type: "pair_status_ack",
        pair_status: room?.device && room.terminal ? "matched" : "waiting",
      };
      send(room?.device, payload);
      send(room?.terminal, payload);
    };
    socket.on("message", (raw) => {
      const data = JSON.parse(raw.toString());
      messages.push({ type: data.type, role });
      if (data.type === "device_register_init") {
        sid = randomUUID();
        rooms.set(sid, { hash: data.pass_hash });
        send(socket, { type: "device_register_ack", device_sid: sid });
      } else if (data.type === "auth_init") {
        sid = data.device_sid;
        role = data.role;
        if (!rooms.has(sid))
          return send(socket, {
            type: "error",
            code: role === "device" ? "AUTH_FAILED" : "DEVICE_OFFLINE",
            message: "Unknown device",
          });
        nonce = randomUUID();
        send(socket, { type: "auth_challenge", nonce });
      } else if (data.type === "auth_response") {
        const room = rooms.get(sid);
        const proof =
          room && nonce && role
            ? createHmac("sha256", room.hash).update(`${nonce}|${role}|${sid}`).digest("base64url")
            : "";
        nonce = undefined;
        const a = Buffer.from(proof),
          b = Buffer.from(String(data.proof));
        if (!room || !role || !proof || a.length !== b.length || !timingSafeEqual(a, b))
          return send(socket, { type: "error", code: "AUTH_FAILED", message: "Invalid proof" });
        const old = room[role];
        room[role] = socket;
        if (old && old !== socket) {
          send(old, { type: "error", code: "KICKED", message: "Replaced" });
          old.close();
        }
        authenticated = true;
        send(socket, {
          type: "auth_ack",
          device_sid: sid,
          pair_status: room.device && room.terminal ? "matched" : "waiting",
        });
        status();
      } else if (authenticated && data.type === "pair_status_query") status();
      else if (authenticated && data.type === "data") {
        const room = rooms.get(sid);
        send(role === "device" ? room?.terminal : room?.device, {
          type: "data",
          payload: data.payload,
        });
      }
    });
    socket.on("close", () => {
      const room = rooms.get(sid);
      if (room && role && room[role] === socket) {
        delete room[role];
        status();
        if (role === "device")
          send(room.terminal, { type: "error", code: "DEVICE_OFFLINE", message: "Offline" });
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test relay address");
  return {
    wsUrl: `ws://127.0.0.1:${address.port}/ws`,
    httpUrl: `http://127.0.0.1:${address.port}`,
    messages,
    async close() {
      for (const socket of sockets.clients) socket.terminate();
      await new Promise<void>((resolve) => sockets.close(() => resolve()));
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
