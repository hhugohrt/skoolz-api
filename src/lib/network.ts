import os from "node:os";

function isPrivateLanIp(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p))) return false;
  const [a, b] = parts;
  if (a === 192 && b === 168) return true;
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return false;
}

// Adaptateurs virtuels (VPN, conteneurs, hyperviseurs) à éviter même s'ils exposent une IPv4 privée —
// ils ne sont généralement pas joignables depuis un téléphone sur le même Wi-Fi physique.
const VIRTUAL_ADAPTER_PATTERN = /virtual|vmware|vbox|hyper-v|docker|tailscale|zerotier|wsl|loopback|tap|tun/i;

export function getLanIp(): string | null {
  const interfaces = os.networkInterfaces();
  const candidates: { name: string; address: string }[] = [];

  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] ?? []) {
      if (iface.family === "IPv4" && !iface.internal && isPrivateLanIp(iface.address)) {
        candidates.push({ name, address: iface.address });
      }
    }
  }

  const physical = candidates.find((c) => !VIRTUAL_ADAPTER_PATTERN.test(c.name));
  return (physical ?? candidates[0])?.address ?? null;
}
