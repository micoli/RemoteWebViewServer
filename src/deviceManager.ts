import { CDPSession } from "playwright-core";
import sharp from "sharp";
import { DeviceConfig, deviceConfigsEqual, readInjectScriptConfig } from "./config.js";
import { getRoot } from "./cdpRoot.js";
import { FrameProcessor } from "./frameProcessor.js";
import { DeviceBroadcaster } from "./broadcaster.js";
import { hash32 } from "./util.js";
import { SelfTestRunner } from "./selfTest.js";
import { getInjectScriptFromUrl } from "./scriptLoader.js";
import { tryAutofillAsync } from "./haAutofill.js";
import { buildDeviceListPacket, DeviceSummary } from "./protocol.js";

export type DeviceSession = {
  id: string;
  deviceId: string;
  cdp: CDPSession;
  cfg: DeviceConfig;
  url: string;
  lastActive: number;
  frameId: number;
  prevFrameHash: number;
  processor: FrameProcessor;
  selfTestRunner: SelfTestRunner;
  adaptiveMinFrameInterval: number;

  // trailing throttle state
  pendingB64?: string;
  throttleTimer?: NodeJS.Timeout;
  lastProcessedMs?: number;
  statsIntervalId?: NodeJS.Timeout;
};

const PREFERS_REDUCED_MOTION = /^(1|true|yes|on)$/i.test(process.env.PREFERS_REDUCED_MOTION ?? '');

const devices = new Map<string, DeviceSession>();
let _cleanupRunning = false;
export const broadcaster = new DeviceBroadcaster();

export function getDeviceSummaries(): DeviceSummary[] {
  return Array.from(devices.values()).map(d => ({
    id: d.deviceId,
    url: d.url,
    lastActive: d.lastActive,
  }));
}

export function broadcastDeviceList(): void {
  broadcaster.broadcastToAllBrowsers(buildDeviceListPacket(getDeviceSummaries()));
}

export function getAllDeviceSessions(): DeviceSession[] {
  return Array.from(devices.values());
}

async function processB64FrameAsync(dev: DeviceSession, b64: string): Promise<void> {
  try {
    const pngFull = Buffer.from(b64, 'base64');
    const h32 = hash32(pngFull);
    if (dev.prevFrameHash === h32) return;
    dev.prevFrameHash = h32;

    let img = sharp(pngFull);
    if (dev.cfg.rotation) img = img.rotate(dev.cfg.rotation);

    const { data, info } = await img.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const out = await dev.processor.processFrameAsync({ data, width: info.width, height: info.height });
    if (out.rects.length > 0) {
      dev.frameId = (dev.frameId + 1) >>> 0;
      broadcaster.sendFrameChunked(dev.deviceId, out, dev.frameId, dev.cfg.maxBytesPerMessage);
    }
  } catch (e) {
    console.warn(`[device] Failed to process frame for ${dev.deviceId}: ${(e as Error).message}`);
  }
}

export async function ensureDeviceAsync(id: string, cfg: DeviceConfig, attach = false): Promise<DeviceSession> {
  const root = getRoot();
  if (!root) throw new Error("CDP not ready");

  let device = devices.get(id);
  if (device) {
    if (attach || deviceConfigsEqual(device.cfg, cfg)) {
      try {
        device.lastActive = Date.now();
        device.processor.requestFullFrame();
        // Capture current page state and push it immediately to the reconnecting client.
        // Chrome won't emit a screencast frame for a static page on its own.
        try {
          const { data: b64 } = await (device.cdp as any).send('Page.captureScreenshot', { format: 'png' }) as { data: string };
          await processB64FrameAsync(device, b64);
        } catch (e) {
          console.warn(`[device] captureScreenshot failed for ${id}: ${(e as Error).message}`);
        }
        if (device.url) broadcaster.sendCurrentURL(id, device.url);
        // Restart screencast for ongoing live updates
        await device.cdp.send('Page.stopScreencast').catch(() => {});
        await device.cdp.send('Page.startScreencast', {
          format: 'png',
          maxWidth: device.cfg.width,
          maxHeight: device.cfg.height,
          everyNthFrame: device.cfg.everyNthFrame,
        });
        return device;
      } catch (e) {
        console.warn(`[device] CDP session broken for ${id}, recreating: ${(e as Error).message}`);
        await deleteDeviceAsync(device).catch(() => {});
      }
    } else {
      console.log(`[device] Reconfiguring device ${id}`);
      await deleteDeviceAsync(device);
    }
  }

  const { targetId } = await root.send<{ targetId: string }>('Target.createTarget', {
    url: 'about:blank',
    width: cfg.width,
    height: cfg.height,
  });

  const { sessionId } = await root.send<{ sessionId: string }>('Target.attachToTarget', {
    targetId,
    flatten: true
  });
  const session = (root as any).session(sessionId);

  console.log(`[device] CDP setup: Page.enable for ${id}`);
  await session.send('Page.enable');
  console.log(`[device] CDP setup: Emulation.setDeviceMetricsOverride for ${id}`);
  await session.send('Emulation.setDeviceMetricsOverride', {
    width: cfg.width,
    height: cfg.height,
    deviceScaleFactor: 1,
    mobile: true
  });
  if (PREFERS_REDUCED_MOTION) {
    await session.send('Emulation.setEmulatedMedia', {
      media: 'screen',
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
    });
  }

  const keyboardScript = await getInjectScriptFromUrl(readInjectScriptConfig());
  if (keyboardScript) {
    await session.send('Page.addScriptToEvaluateOnNewDocument', { source: keyboardScript });
  }

  console.log(`[device] CDP setup: Page.navigate for ${id}`);
  await session.send('Page.navigate', { url: 'data:text/html,<html><body style="margin:0;background:#000"></body></html>' });
  console.log(`[device] CDP setup: Page.startScreencast for ${id}`);
  await session.send('Page.startScreencast', {
    format: 'png',
    maxWidth: cfg.width,
    maxHeight: cfg.height,
    everyNthFrame: cfg.everyNthFrame
  });

  const processor = new FrameProcessor({
    tileSize: cfg.tileSize,
    fullframeTileCount: cfg.fullFrameTileCount,
    fullframeAreaThreshold: cfg.fullFrameAreaThreshold,
    jpegQuality: cfg.jpegQuality,
    fullFrameEvery: cfg.fullFrameEvery,
    maxBytesPerMessage: cfg.maxBytesPerMessage,
  });

  const newDevice: DeviceSession = {
    id: targetId,
    deviceId: id,
    cdp: session,
    cfg: cfg,
    url: '',
    lastActive: Date.now(),
    frameId: 0,
    prevFrameHash: 0,
    processor,
    selfTestRunner: new SelfTestRunner(broadcaster),
    adaptiveMinFrameInterval: cfg.minFrameInterval,
    pendingB64: undefined,
    throttleTimer: undefined,
    lastProcessedMs: undefined,
    statsIntervalId: undefined,
  };
  devices.set(id, newDevice);
  newDevice.processor.requestFullFrame();

  const flushPending = async () => {
    const dev = newDevice;
    dev.throttleTimer = undefined;
    const b64 = dev.pendingB64;
    dev.pendingB64 = undefined;
    if (!b64) return;
    await processB64FrameAsync(dev, b64);
    dev.lastProcessedMs = Date.now();
  };

  session.on('Page.screencastFrame', async (evt: any) => {
    // ACK immediately to keep producer running
    session.send('Page.screencastFrameAck', { sessionId: evt.sessionId }).catch(() => { });

    if (broadcaster.getClientCount(newDevice.deviceId) === 0)
      return;
    newDevice.lastActive = Date.now();
    newDevice.pendingB64 = evt.data;

    const now = Date.now();
    const since = newDevice.lastProcessedMs ? (now - newDevice.lastProcessedMs) : Infinity;
    if (!newDevice.throttleTimer) {
      const delay = Math.max(0, newDevice.adaptiveMinFrameInterval - (Number.isFinite(since) ? since : 0));
      newDevice.throttleTimer = setTimeout(flushPending, delay);
    }
  });

  newDevice.statsIntervalId = setInterval(() => {
    if (broadcaster.getClientCount(newDevice.deviceId) > 0 && !newDevice.selfTestRunner.isRunning()) {
      broadcaster.startSelfTestMeasurement(newDevice.deviceId);
    }
  }, 10_000);

  const handleNavigation = (url: string) => {
    if (url === 'about:blank') return;
    if (newDevice.url !== url) {
      newDevice.url = url;
      broadcaster.sendCurrentURL(newDevice.deviceId, url);
      console.log(`[device] URL changed to: ${url}`);
      broadcastDeviceList();
    }
    tryAutofillAsync(session, url).catch(() => {});
  };

  session.on('Page.frameNavigated', (evt: any) => {
    // Only track the main frame, ignore iframes
    if (!evt.frame.parentId) {
      handleNavigation(evt.frame.url);
    }
  });
  session.on('Page.navigatedWithinDocument', (evt: any) => {
    handleNavigation(evt.url);
  });
  
  return newDevice;
}

export async function cleanupIdleAsync(ttlMs = 5 * 60_000) {
  if (_cleanupRunning) return;
  _cleanupRunning = true;

  try {
    const now = Date.now();
    const staleIds = Array.from(devices.values())
      .filter(d => now - d.lastActive > ttlMs)
      .map(d => d.deviceId);

    for (const id of staleIds) {
      const dev = devices.get(id);
      if (!dev) continue;

      console.log(`[device] Cleaning up idle device ${id}`);
      await deleteDeviceAsync(dev).catch(() => { /* swallow */ });
      broadcastDeviceList();
    }
  } finally {
    _cleanupRunning = false;
  }
}

export async function killDeviceAsync(id: string): Promise<void> {
  const dev = devices.get(id);
  if (!dev) return;
  await deleteDeviceAsync(dev);
  broadcastDeviceList();
}

async function deleteDeviceAsync(device: DeviceSession) {
  const root = getRoot();

  if (!devices.delete(device.deviceId))
    return;

  if (device.throttleTimer)
    clearTimeout(device.throttleTimer);

  if (device.statsIntervalId)
    clearInterval(device.statsIntervalId);

  try { await device.cdp.send("Page.stopScreencast").catch(() => { }); } catch { }
  try { await root?.send("Target.closeTarget", { targetId: device.id }); } catch { }
}
