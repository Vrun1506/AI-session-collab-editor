import type { Identity } from "@mpa/protocol";
import type { Room } from "./room.js";

/**
 * Who gets the driver token, and why.
 *
 * These rules are the milestone's actual product decision — everything else is
 * plumbing — so they live apart from the socket handling where they can be
 * tested directly. The whole design question is: when may someone take the
 * token without the current driver's consent? Never on demand, or the token is
 * meaningless; but always when waiting on the driver would deadlock the room.
 */

export type GrantReason = "initial" | "handoff" | "idle" | "offline";

export type DriverAction =
  | { kind: "grant"; to: Identity; reason: GrantReason; from: Identity | null }
  /** Recorded so the driver can see who is waiting and hand over. */
  | { kind: "queue"; who: Identity }
  | { kind: "none" };

export function decideDriverRequest(
  room: Room,
  requester: Identity,
  idleMs: number,
): DriverAction {
  const current = room.driver;

  if (!current) {
    return { kind: "grant", to: requester, reason: "initial", from: null };
  }
  if (current.userId === requester.userId) return { kind: "none" };

  // A token held by someone who is not here is not holding anything together.
  if (!room.isConnected(current.userId)) {
    return { kind: "grant", to: requester, reason: "offline", from: current };
  }
  // Nor is one held by someone who wandered off mid-session. The token exists
  // to stop people talking over each other, not to let one person lock a room.
  if (room.driverIdleFor() > idleMs) {
    return { kind: "grant", to: requester, reason: "idle", from: current };
  }
  return { kind: "queue", who: requester };
}

/**
 * Resolve the token after someone disconnects.
 *
 * A driver who drops off wifi for ten seconds should get the wheel back, so the
 * token is not cleared on disconnect. It is only moved when leaving it put
 * would strand the room: somebody is already waiting, or exactly one person is
 * left and it would be absurd to make them ask.
 */
export function decideAfterLeave(room: Room, left: Identity): DriverAction {
  if (!room.isDriver(left.userId)) return { kind: "none" };

  const waiting = room
    .pendingDriverRequests()
    .find((r) => room.isConnected(r.userId));
  if (waiting) {
    return { kind: "grant", to: waiting, reason: "offline", from: left };
  }

  const editors = room.listEditors();
  if (editors.length === 1) {
    const only = editors[0]!;
    return {
      kind: "grant",
      to: { userId: only.userId, name: only.name },
      reason: "offline",
      from: left,
    };
  }
  return { kind: "none" };
}
