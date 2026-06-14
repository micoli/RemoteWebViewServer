import type { DeviceSession } from "./deviceManager.js";
import { TouchKind, parseFrameStatsPacket, parseOpenURLPacket, parseTouchPacket } from "./protocol.js";
import { mapPointForRotation } from "./util.js";

export class InputRouter {
  private _lastMoveAt = 0;
  private readonly _moveThrottleMs: number;
  private _moveCount = 0;
  private _moveDropped = 0;
  private _scrollStartMs = 0;

  constructor(moveThrottleMs = 12) {
    this._moveThrottleMs = moveThrottleMs;
  }

  public async handleTouchPacketAsync(dev: DeviceSession, buf: Buffer): Promise<void> {
    const pkt = parseTouchPacket(buf);
    if (!pkt) return;

    if (pkt.kind === TouchKind.Down) {
      this._moveCount = 0;
      this._moveDropped = 0;
      this._scrollStartMs = Date.now();
      console.log(`[scroll] DOWN  display=(${pkt.x},${pkt.y})`);
    }

    if (pkt.kind === TouchKind.Move) {
      const now = Date.now();
      if (now - this._lastMoveAt < this._moveThrottleMs) {
        this._moveDropped++;
        return;
      }
      this._lastMoveAt = now;
      this._moveCount++;
    }

    if (pkt.kind === TouchKind.Up) {
      const dt = Date.now() - this._scrollStartMs;
      console.log(`[scroll] UP    display=(${pkt.x},${pkt.y}) moves=${this._moveCount} dropped=${this._moveDropped} duration=${dt}ms`);
    }

    await this._dispatchTouchAsync(dev, pkt.kind, pkt.x, pkt.y);
  }

  public async handleFrameStatsPacketAsync(dev: DeviceSession, buf: Buffer): Promise<void> {
    const value = parseFrameStatsPacket(buf);
    dev.selfTestRunner?.setFrameRenderTimeAsync(value ?? 0, dev.cdp);
  }

  public async handleOpenURLPacketAsync(dev: DeviceSession, buf: Buffer): Promise<void> {
    const pkt = parseOpenURLPacket(buf);
      if (!pkt) return;

      if (pkt.url === "self-test") {
        await dev.selfTestRunner.startAsync(dev.deviceId, dev.cdp);
      } else {
        dev.selfTestRunner.stop();
        
        if (dev.url !== pkt.url)
          await dev.cdp.send('Page.navigate', { url: pkt.url });
      }
  }

  private async _dispatchTouchAsync(dev: DeviceSession, kind: TouchKind, x: number, y: number): Promise<void> {
    try {
      const id = 1; // single-finger id
      const rotated = mapPointForRotation(
        x, y,
        dev.cfg.width, dev.cfg.height,
        dev.cfg.rotation
      );
      const points = [{ x: rotated.x, y: rotated.y, radiusX: 1, radiusY: 1, force: 1, id }];

      switch (kind) {
        case TouchKind.Down:
          console.log(`[scroll] CDP touchStart browser=(${rotated.x},${rotated.y})`);
          await dev.cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: points });
          console.log(`[scroll] CDP touchStart OK`);
          break;

        case TouchKind.Move:
          await dev.cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: points });
          break;

        case TouchKind.Up:
          console.log(`[scroll] CDP touchEnd browser=(${rotated.x},${rotated.y})`);
          await dev.cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
          console.log(`[scroll] CDP touchEnd OK`);
          break;

        case TouchKind.Tap:
          await dev.cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: points });
          await dev.cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
          break;
      }
    } catch (e) {
      console.warn(`[scroll] CDP dispatch FAILED (${TouchKind[kind]}): ${(e as Error).message}`);
    }
  }
}
