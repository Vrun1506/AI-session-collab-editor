/**
 * Counts live delta frames against characters delivered.
 *
 * Exists to answer one question with data instead of assumption: does the
 * agent stream per token, or in chunks? A buffering layer was once added to
 * the agent-host on the assumption of per-token deltas; this script showed the
 * frame count was identical with and without it, and the buffering was
 * removed. Re-run it before adding any batching, or after switching models or
 * providers.
 *
 *   node tools/count-frames.mjs "your prompt here"
 *   MPA_ROOM=team node tools/count-frames.mjs "..."
 *
 * Uses Node's built-in WebSocket (Node 22+), so it needs no dependencies and
 * can run from anywhere in the repo.
 */
const room = process.env.MPA_ROOM ?? "team";
const relay = process.env.MPA_RELAY_URL ?? "ws://127.0.0.1:7331";
const prompt = process.argv[2];

if (!prompt) {
  console.error('usage: node tools/count-frames.mjs "your prompt"');
  process.exit(1);
}

const socket = new WebSocket(relay);
let deltaFrames = 0;
let deltaChars = 0;
let otherFrames = 0;

socket.addEventListener("open", () => {
  socket.send(
    JSON.stringify({
      type: "hello",
      roomId: room,
      userId: "frame-counter",
      name: "frame-counter",
      role: "editor",
      // Skip history; only live frames are being measured.
      sinceSeq: Number.MAX_SAFE_INTEGER,
    }),
  );
  socket.send(JSON.stringify({ type: "submitPrompt", text: prompt }));
});

socket.addEventListener("message", (event) => {
  const msg = JSON.parse(event.data);

  if (msg.type === "error") {
    console.error(`relay error: ${msg.message}`);
    process.exit(1);
  }
  if (msg.type !== "event") return;

  const body = msg.event.body;
  if (body.type === "assistant.delta" || body.type === "thinking.delta") {
    deltaFrames++;
    deltaChars += body.text.length;
  } else {
    otherFrames++;
  }

  if (body.type === "turn.completed") {
    const perFrame = deltaFrames ? (deltaChars / deltaFrames).toFixed(1) : "0";
    console.log(
      `delta frames: ${deltaFrames} | chars: ${deltaChars} | ` +
        `avg chars/frame: ${perFrame} | other frames: ${otherFrames}`,
    );
    process.exit(0);
  }
});

socket.addEventListener("error", () => {
  console.error(`could not connect to relay at ${relay} — is it running?`);
  process.exit(1);
});
