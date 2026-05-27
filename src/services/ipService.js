// src/services/ipService.js
// ─────────────────────────────────────────────────────────────────────────────
//  Fetches the device's public IP address from ipify.org.
//
//  Notes:
//  • fetch() is used directly — no package needed.
//  • A 5s AbortController timeout prevents a slow/hung fetch from delaying login.
//  • Returns null on any error — callers must handle null gracefully.
//    Login must NEVER be blocked by a failed IP lookup.
//  • On mobile 4G/5G, the IP is the carrier's NAT gateway (CGNAT), not the
//    device's unique address. Still useful for location and anomaly detection.
// ─────────────────────────────────────────────────────────────────────────────

export async function getPublicIP() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res  = await fetch('https://api.ipify.org?format=json', { signal: controller.signal });
    const data = await res.json();
    return data.ip ?? null;   // e.g. "103.21.244.0"
  } catch {
    return null;              // network error, timeout, or abort — never block login
  } finally {
    clearTimeout(timer);
  }
}
