import { writeFileSync } from "node:fs";
import { buildAudit, renderMarkdown } from "./audit.js";
import { SqliteEventStore } from "./store.js";

/**
 * Export a room's audit log straight from the database.
 *
 * Deliberately not a request to a running relay. The moment anyone actually
 * needs this — a bad write, a command nobody remembers approving, a bill worth
 * arguing about — is exactly the moment the session is over and the relay is
 * not running. So it reads the log where the log lives.
 *
 *   node dist/audit-cli.js                    # list rooms
 *   node dist/audit-cli.js demo               # markdown to stdout
 *   node dist/audit-cli.js demo --json        # the structured report
 *   node dist/audit-cli.js demo -o audit.md   # to a file
 */

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("-")));
const positional = args.filter((a) => !a.startsWith("-"));

const outIndex = args.findIndex((a) => a === "-o" || a === "--out");
const outPath = outIndex >= 0 ? args[outIndex + 1] : undefined;
const roomId = positional.find((a) => a !== outPath);

const dbPath = process.env.MPA_DB ?? "mpa-sessions.db";
const store = new SqliteEventStore(dbPath);

try {
  if (!roomId) {
    const rooms = store.listRooms();
    if (rooms.length === 0) {
      console.error(`No rooms in ${dbPath}.`);
      process.exit(1);
    }
    console.log(`Rooms in ${dbPath}:`);
    for (const id of rooms) {
      console.log(`  ${id}  (${store.latestSeq(id) + 1} events)`);
    }
    console.log("\nPass one to export it.");
    process.exit(0);
  }

  const events = store.since(roomId, -1);
  if (events.length === 0) {
    console.error(`Room "${roomId}" has no history in ${dbPath}.`);
    process.exit(1);
  }

  const report = buildAudit(roomId, events);
  const text = flags.has("--json")
    ? JSON.stringify(report, null, 2)
    : renderMarkdown(report);

  if (outPath) {
    writeFileSync(outPath, text);
    console.error(
      `Wrote ${report.events} events from "${roomId}" to ${outPath}.`,
    );
  } else {
    console.log(text);
  }
} finally {
  store.close();
}
