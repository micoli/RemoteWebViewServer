import { WebSocket } from "ws";
import { buildFrameStatsPacket, buildFramePackets, buildCurrentURLPacket } from "./protocol.js";
import type { FrameOut } from "./frameProcessor.js";

type OutFrame = { frameId?: number | null; packets: Buffer[] };
type BroadcasterState = { queue: OutFrame[]; sending: boolean };

export class DeviceBroadcaster {
  private _clients = new Map<string, Set<WebSocket>>();
  private _state = new Map<string, BroadcasterState>();
  private _browserClients = new Set<WebSocket>();

  addClient(id: string, ws: WebSocket, isBrowser = false): void {
    if (!this._clients.has(id)) this._clients.set(id, new Set());
    const clientSet = this._clients.get(id)!;

    if (!isBrowser) {
      // Device client (ESP32) reconnecting: kick stale device connections, keep browser observers
      for (const sock of [...clientSet]) {
        if (!this._browserClients.has(sock)) {
          try { sock.close(); } catch {}
          clientSet.delete(sock);
        }
      }
    }

    clientSet.add(ws);

    if (!this._state.has(id)) this._state.set(id, { queue: [], sending: false });

    console.log(`[broadcaster] Client connected to device ${id}, total clients: ${clientSet.size}`);
    ws.once("close", () => this.removeClient(id, ws));
    ws.once("error", () => this.removeClient(id, ws));
  }

  removeClient(id: string, ws: WebSocket): void {
    this._clients.get(id)?.delete(ws);
    if ((this._clients.get(id)?.size ?? 0) === 0) {
      this._clients.delete(id);
      this._state.delete(id);
    }
    console.log(`[broadcaster] Client disconnected from device ${id}, total clients: ${this._clients.get(id)?.size ?? 0}`);
  }

  getClientCount(id: string): number {
    return this._clients.get(id)?.size ?? 0;
  }

  public sendFrameChunked(id: string, data: FrameOut, frameId: number, maxBytes = 12_000): void {
    const peers = this._clients.get(id);
    if (!peers || peers.size === 0 || data.rects.length === 0) return;

    const packets = buildFramePackets(data.rects, data.encoding, frameId, data.isFullFrame, maxBytes);

    const st = this._ensureState(id);
    // Drop stale frames: keep only control packets (no frameId), discard pending frame data
    st.queue = st.queue.filter(f => f.frameId == null);
    st.queue.push({ frameId, packets });
    this._drainAsync(id).catch(() => {});
  }

  public startSelfTestMeasurement(id: string): void {
    const peers = this._clients.get(id);
    if (!peers || peers.size === 0) return;

    const packet = buildFrameStatsPacket();
    const st = this._ensureState(id);
    st.queue.push({ packets: [packet] });
    this._drainAsync(id).catch(() => {});
  }

  registerBrowserClient(ws: WebSocket): void {
    this._browserClients.add(ws);
    ws.once("close", () => this._browserClients.delete(ws));
    ws.once("error", () => this._browserClients.delete(ws));
  }

  sendToBrowserClient(ws: WebSocket, packet: Buffer): void {
    if (!this._browserClients.has(ws)) return;
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.send(packet, { binary: true }); } catch {}
    }
  }

  broadcastToAllBrowsers(packet: Buffer): void {
    for (const ws of this._browserClients) {
      if (ws.readyState === WebSocket.OPEN) {
        try { ws.send(packet, { binary: true }); } catch {}
      }
    }
  }

  sendAdaptiveStatsToBrowsers(id: string, packet: Buffer): void {
    const peers = this._clients.get(id);
    if (!peers) return;
    for (const ws of peers) {
      if (this._browserClients.has(ws) && ws.readyState === WebSocket.OPEN) {
        try { ws.send(packet, { binary: true }); } catch {}
      }
    }
  }


  public sendCurrentURL(id: string, url: string): void {
    const peers = this._clients.get(id);
    if (!peers || peers.size === 0) return;

    const packet = buildCurrentURLPacket(url);
    const st = this._ensureState(id);

    st.queue.push({ packets: [packet] });
    this._drainAsync(id).catch(() => {});
  }

  private _ensureState(id: string): BroadcasterState {
    let st = this._state.get(id);
    if (!st) {
      st = { queue: [], sending: false };
      this._state.set(id, st);
    }
    return st;
  }

  private _sendToPeer(ws: WebSocket, peers: Set<WebSocket>, pkt: Buffer): Promise<void> {
    return new Promise<void>(resolve => {
      if (ws.readyState !== WebSocket.OPEN) {
        peers.delete(ws);
        return resolve();
      }
      ws.send(pkt, { binary: true }, err => {
        if (err) {
          try { ws.close(); } catch {}
          peers.delete(ws);
        }
        resolve();
      });
    });
  }

  private async _drainAsync(id: string): Promise<void> {
    const st = this._ensureState(id);
    if (st.sending) return;
    st.sending = true;

    try {
      const peers = this._clients.get(id);
      if (!peers || peers.size === 0) { st.queue.length = 0; return; }

      while (st.queue.length) {
        const f = st.queue.shift()!;
        for (const pkt of f.packets) {
          await Promise.all([...peers].map(ws => this._sendToPeer(ws, peers, pkt)));
          if (peers.size === 0) { st.queue.length = 0; return; }
        }
      }
    } finally {
      st.sending = false;
    }
  }
}
