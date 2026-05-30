import type { WsServerMessage } from "@agents_fleet/shared";
export type { WsServerMessage };

export function openWs(): WebSocket {
  const url = new URL("/ws", window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return new WebSocket(url.toString());
}
