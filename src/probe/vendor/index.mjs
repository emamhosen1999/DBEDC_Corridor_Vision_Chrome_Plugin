/**
 * Vendor adapter registry with auto-detection.
 *
 * Detection order matters: we ask ONVIF for the manufacturer string first, because
 * that is one unauthenticated request and is definitive. Only if that fails do we
 * probe vendor APIs speculatively, and the result is cached on the inventory record
 * so it costs nothing on subsequent cycles.
 */
import { uniview } from './uniview.mjs';
import { hikvision } from './hikvision.mjs';
import { dahua } from './dahua.mjs';
import { onvifDeviceInfo } from '../onvif.mjs';

export const ADAPTERS = { uniview, hikvision, dahua };

const MANUFACTURER_MAP = [
  [/uniview|unv\b/i, 'uniview'],
  [/hikvision|hik\b/i, 'hikvision'],
  [/dahua|lorex|amcrest/i, 'dahua'],
];

export function getAdapter(vendor) {
  return ADAPTERS[String(vendor ?? '').toLowerCase()] ?? null;
}

/** Map an ONVIF manufacturer/model string to an adapter name. */
export function vendorFromManufacturer(manufacturer, model = '') {
  const hay = `${manufacturer ?? ''} ${model ?? ''}`;
  for (const [re, name] of MANUFACTURER_MAP) if (re.test(hay)) return name;
  return null;
}

/**
 * Work out which vendor a camera is, cheapest method first.
 * Returns `{ vendor, via, info }`, or `{ vendor: null }` when nothing identifies it.
 */
export async function detectVendor(host, { port = 80, username, password, timeoutMs = 4000, onvifPort = 80, hint } = {}) {
  if (hint && getAdapter(hint)) return { vendor: hint, via: 'configured' };

  const onvif = await onvifDeviceInfo(host, { port: onvifPort, username, password, timeoutMs });
  if (onvif.ok) {
    const vendor = vendorFromManufacturer(onvif.manufacturer, onvif.model);
    if (vendor) return { vendor, via: 'onvif', info: onvif };
    return { vendor: null, via: 'onvif', info: onvif };   // ONVIF works; generic probing is fine
  }

  // Speculative: ask each vendor to identify itself. Runs once per camera, then cached.
  for (const [name, adapter] of Object.entries(ADAPTERS)) {
    try {
      const r = await adapter.identify(host, { port, username, password, timeoutMs });
      if (r.ok) return { vendor: name, via: 'probe', info: r };
    } catch { /* try the next adapter */ }
  }
  return { vendor: null, via: 'none' };
}
