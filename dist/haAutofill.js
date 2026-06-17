import env from "env-var";
const ENABLED = /^(1|true|yes|on)$/i.test(env.get("HA_CREDENTIAL_AUTOFILL").default("false").asString());
const USERNAME = env.get("HA_USERNAME").default("").asString();
const PASSWORD = env.get("HA_PASSWORD").default("").asString();
export async function tryAutofillAsync(cdp, url) {
    if (!ENABLED || !USERNAME || !PASSWORD)
        return;
    if (!url.includes("auth/authorize"))
        return;
    console.log(`[autofill] auth page detected: ${url}`);
    const script = `
    (async () => {
      function deepQuery(selector, root) {
        root = root || document;
        const el = root.querySelector(selector);
        if (el) return el;
        for (const host of root.querySelectorAll('*')) {
          if (host.shadowRoot) {
            const found = deepQuery(selector, host.shadowRoot);
            if (found) return found;
          }
        }
        return null;
      }

      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        if (document.title.includes("Home Assistant")) {
          const u = deepQuery('input[name="username"]');
          const p = deepQuery('input[name="password"]');
          if (u && p) {
            u.value = ${JSON.stringify(USERNAME)};
            p.value = ${JSON.stringify(PASSWORD)};
            u.dispatchEvent(new Event('input', { bubbles: true }));
            p.dispatchEvent(new Event('input', { bubbles: true }));
            u.dispatchEvent(new Event('change', { bubbles: true }));
            p.dispatchEvent(new Event('change', { bubbles: true }));
            const btn = document.querySelector('.action ha-button');
            if (btn) {
              btn.click();
              return "filled+submitted";
            }
            return "filled";
          }
        }
        await new Promise(r => setTimeout(r, 250));
      }
      return "timeout";
    })()
  `;
    try {
        const res = await cdp.send('Runtime.evaluate', {
            expression: script,
            awaitPromise: true,
            returnByValue: true,
        });
        console.log(`[autofill] result: ${res?.result?.value}`);
    }
    catch (e) {
        console.warn(`[autofill] failed: ${e.message}`);
    }
}
