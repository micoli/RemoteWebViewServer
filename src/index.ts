import http from 'http';
import WebSocket, { WebSocketServer } from "ws"
import env from "env-var";
import { makeConfigFromParams, setConfigFor, logDeviceConfig } from "./config.js";
import { broadcaster, ensureDeviceAsync, cleanupIdleAsync, getDeviceSummaries, broadcastDeviceList, killDeviceAsync } from './deviceManager.js';
import { InputRouter } from "./inputRouter.js";
import { bootstrapAsync } from './browser.js';
import { MsgType, buildDeviceListPacket, parseKillDevicePacket } from './protocol.js';

const WS_PORT = env.get("WS_PORT").default("8081").asIntPositive();
const HEALTH_PORT = env.get("HEALTH_PORT").default("18080").asIntPositive();

const wss = new WebSocketServer({ port: WS_PORT, perMessageDeflate: false });
const inputRouter = new InputRouter();

await bootstrapAsync();

wss.on("connection", async (ws, req) => {
  const url = new URL(req.url || "", `ws://localhost:${WS_PORT}`);
  const id = url.searchParams.get("id") || "default";

  const isBrowser = url.searchParams.get("type") === "browser";
  const attach = url.searchParams.get("attach") === "1";
  const cfg = makeConfigFromParams(url.searchParams);
  setConfigFor(id, cfg);
  logDeviceConfig(id, cfg);

  if (isBrowser) broadcaster.registerBrowserClient(ws);
  broadcaster.addClient(id, ws, isBrowser);

  // Buffer messages arriving before the device session is ready
  const earlyMessages: Array<{ msg: WebSocket.RawData; isBinary: boolean }> = [];
  const earlyHandler = (msg: WebSocket.RawData, isBinary: boolean) => earlyMessages.push({ msg, isBinary });
  ws.on("message", earlyHandler);

  let dev;
  try {
    dev = await ensureDeviceAsync(id, cfg, attach);
  } catch (e) {
    console.error(`[server] ensureDeviceAsync failed for ${id}, closing connection:`, (e as Error).message);
    ws.off("message", earlyHandler);
    broadcaster.removeClient(id, ws);
    ws.close();
    return;
  }

  // Send the current device list only to browser clients
  if (isBrowser) broadcaster.sendToBrowserClient(ws, buildDeviceListPacket(getDeviceSummaries()));

  ws.off("message", earlyHandler);

  const dispatch = (msg: WebSocket.RawData, isBinary: boolean) => {
    if (!isBinary) return;

    const buf: Buffer = Buffer.isBuffer(msg) ? msg : Buffer.from(msg as ArrayBuffer);
    switch (buf.readUInt8(0)) {
      case MsgType.Touch: {
        const clientCount = broadcaster.getClientCount(id);
        if (clientCount > 1) console.warn(`[server] ${clientCount} WS connections for id=${id} — possible duplicate`);
        inputRouter.handleTouchPacketAsync(dev, buf).catch(e => console.warn(`Failed to handle touch packet: ${(e as Error).message}`));
        break;
      }
      case MsgType.Keepalive:
        dev.lastActive = Date.now();
        break;
      case MsgType.FrameStats:
        inputRouter.handleFrameStatsPacketAsync(dev, buf).catch(() => console.warn(`Failed to handle Self test packet`));
        break;
      case MsgType.OpenURL:
        inputRouter.handleOpenURLPacketAsync(dev, buf).catch(e => console.warn(`Failed to handle OpenURL packet: ${(e as Error).message}`));
        break;
      case MsgType.KillDevice: {
        const targetId = parseKillDevicePacket(buf);
        if (targetId) killDeviceAsync(targetId).catch(e => console.warn(`Failed to kill device ${targetId}: ${(e as Error).message}`));
        break;
      }
    }
  };

  // Replay buffered messages. Delay OpenURL so the splash page has time to
  // render and reach the display before the real URL navigation kicks in.
  for (const { msg, isBinary } of earlyMessages) {
    const buf = Buffer.isBuffer(msg) ? msg : Buffer.from(msg as ArrayBuffer);
    if (isBinary && buf.length > 0 && buf.readUInt8(0) === MsgType.OpenURL) {
      setTimeout(() => dispatch(msg, isBinary), 800);
    } else {
      dispatch(msg, isBinary);
    }
  }
  ws.on("message", dispatch);

  ws.on("close", () => {
    dev.lastActive = Date.now();
    broadcaster.removeClient(id, ws);
    broadcastDeviceList();
  })
});

http.createServer(async (req, res) => {
  try {
    res.writeHead(200); res.end('ok');
  } catch (e) {
    res.writeHead(500); res.end('err');
  }
}).listen(HEALTH_PORT);

setInterval(() => cleanupIdleAsync(), 60_000);

console.log(`[server] WebSocket listening on :${WS_PORT}`);
