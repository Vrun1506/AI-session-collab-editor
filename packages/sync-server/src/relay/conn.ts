import type { WebSocket } from "ws";

/**
 * A peer's connection, reduced to the three things the relay actually needs.
 *
 * The relay used to hold `ws.WebSocket` directly, which meant none of its logic
 * could be exercised without opening a socket — and so the largest and most
 * frequently changed file in the repo was the only one with no tests. Nothing
 * about deciding who may drive, or which range a rewind supersedes, needs a
 * network. This interface is the seam that lets those decisions be tested the
 * way `Room` and `policy` already are.
 */
export interface Conn {
  send(data: string): void;
  close(): void;
  /** False once the socket is closing or closed; sends are dropped. */
  readonly open: boolean;
}

/** Adapts a real `ws` socket to the interface the relay speaks. */
export function connOf(socket: WebSocket): Conn {
  return {
    send: (data) => socket.send(data),
    close: () => socket.close(),
    get open() {
      return socket.readyState === socket.OPEN;
    },
  };
}
