import { FLAG_OPENURL_FORCE, TouchKind, parseFrameStatsPacket, parseOpenURLPacket, parseTouchPacket, buildFrameStatsUpdatePacket } from "./protocol.js";
import { mapPointForRotation } from "./util.js";
export class InputRouter {
    constructor(broadcaster, moveThrottleMs = 12) {
        this._lastMoveAt = 0;
        this._moveCount = 0;
        this._moveDropped = 0;
        this._scrollStartMs = 0;
        this._broadcaster = broadcaster;
        this._moveThrottleMs = moveThrottleMs;
    }
    async handleTouchPacketAsync(dev, buf) {
        const pkt = parseTouchPacket(buf);
        if (!pkt)
            return;
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
    async handleFrameStatsPacketAsync(dev, buf) {
        const stats = parseFrameStatsPacket(buf);
        const avgTime = stats?.avgTime ?? 0;
        const bytesReceived = stats?.bytes ?? 0;
        dev.selfTestRunner?.setFrameRenderTimeAsync(avgTime, dev.cdp);
        if (avgTime > 0 && !dev.selfTestRunner.isRunning()) {
            const target = Math.ceil(avgTime * 1.1);
            const adapted = Math.max(dev.cfg.minFrameInterval, Math.min(500, target));
            if (adapted !== dev.adaptiveMinFrameInterval) {
                console.log(`[adaptive] minFrameInterval ${dev.adaptiveMinFrameInterval}→${adapted}ms (avg render=${avgTime}ms)`);
                dev.adaptiveMinFrameInterval = adapted;
            }
            const pkt = buildFrameStatsUpdatePacket(avgTime, bytesReceived, dev.adaptiveMinFrameInterval);
            this._broadcaster.sendAdaptiveStatsToBrowsers(dev.deviceId, pkt);
        }
    }
    async handleOpenURLPacketAsync(dev, buf) {
        const pkt = parseOpenURLPacket(buf);
        if (!pkt)
            return;
        if (pkt.url === "self-test") {
            await dev.selfTestRunner.startAsync(dev.deviceId, dev.cdp);
        }
        else {
            dev.selfTestRunner.stop();
            if (dev.url !== pkt.url || (pkt.flags & FLAG_OPENURL_FORCE))
                await dev.cdp.send('Page.navigate', { url: pkt.url });
        }
    }
    async _dispatchTouchAsync(dev, kind, x, y) {
        try {
            const id = 1; // single-finger id
            const rotated = mapPointForRotation(x, y, dev.cfg.width, dev.cfg.height, dev.cfg.rotation);
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
        }
        catch (e) {
            console.warn(`[scroll] CDP dispatch FAILED (${TouchKind[kind]}): ${e.message}`);
        }
    }
}
