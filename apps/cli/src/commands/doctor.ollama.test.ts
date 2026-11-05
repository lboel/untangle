/**
 * `untangle doctor` — „antwortet nicht" ist nicht dasselbe wie „laedt noch".
 *
 * DER BEFUND DER ABNAHME: `doctor` hatte eine starre Vorgabefrist von 15 s
 * fuer den Ollama-Test. Das reicht fuer den KALTSTART eines Modells nicht —
 * gemessen 31-37 s beim ersten Laden, danach unter einer Sekunde. Ergebnis:
 * FAIL fuer einen vollkommen gesunden Dienst. Eine falsche Aussage ueber die
 * Umgebung ist E4 an der Oberflaeche, egal wie gut sie gemeint ist.
 *
 * Diese Tests fahren gegen einen ECHTEN HTTP-Server auf 127.0.0.1, nicht
 * gegen einen gefaelschten Transport: die Unterscheidung, um die es geht,
 * entsteht erst aus dem Verhalten eines Sockets. Drei Faelle:
 *
 *   1. der Dienst gibt kein Lebenszeichen  -> FAIL, sofort, ohne Warten;
 *   2. der Dienst antwortet, /api/embed haengt -> FAIL, aber BENANNT anders;
 *   3. der Dienst antwortet spaet (Kaltstart) -> OK, mit genannter Dauer.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createServer as createTcpServer, type Server as TcpServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BufferIo } from "../cli/io.js";
import { run } from "../index.js";

const MODEL = "testmodell";
const DIMENSIONS = 4;

let projectRoot: string;
const closers: (() => Promise<void>)[] = [];

beforeEach(() => {
  projectRoot = mkdtempSync(path.join(tmpdir(), "untangle-doctor-ollama-"));
  writeFileSync(
    path.join(projectRoot, "package.json"),
    `${JSON.stringify({ name: "fremdprojekt", version: "1.0.0", type: "module" }, null, 2)}\n`,
    "utf8",
  );
  writeFileSync(path.join(projectRoot, "main.ts"), "export const answer = 42;\n", "utf8");
});

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  rmSync(projectRoot, { recursive: true, force: true });
});

/** Ein Ollama-Doppelgaenger: /api/tags antwortet sofort, /api/embed nach `embedDelayMs`. */
async function startFakeOllama(embedDelayMs: number | "nie"): Promise<string> {
  const sockets = new Set<Socket>();
  const server: Server = createServer((request, response) => {
    if (request.url === "/api/tags") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ models: [{ name: `${MODEL}:latest` }] }));
      return;
    }
    if (request.url === "/api/embed") {
      request.resume();
      if (embedDelayMs === "nie") return; // absichtlich: keine Antwort, je.
      setTimeout(() => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            model: MODEL,
            embeddings: [Array.from({ length: DIMENSIONS }, () => 0.5)],
          }),
        );
      }, embedDelayMs).unref();
      return;
    }
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("Ollama is running");
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("kein Port");
  closers.push(
    () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  );
  return `http://127.0.0.1:${String(address.port)}`;
}

/** Ein Port, der die Verbindung ANNIMMT und dann schweigt — kein Lebenszeichen. */
async function startSilentPort(): Promise<string> {
  const sockets = new Set<Socket>();
  const server: TcpServer = createTcpServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("kein Port");
  closers.push(
    () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  );
  return `http://127.0.0.1:${String(address.port)}`;
}

async function doctor(
  url: string,
  flags: readonly string[],
): Promise<{ code: number; io: BufferIo }> {
  const io = new BufferIo();
  const code = await run(["doctor", `--root=${projectRoot}`, ...flags], {
    io,
    cwd: projectRoot,
    env: {
      UNTANGLE_EMBEDDINGS_MODE: "external",
      UNTANGLE_EMBEDDINGS_URL: url,
      UNTANGLE_EMBEDDINGS_MODEL: MODEL,
      UNTANGLE_EMBEDDINGS_DIMENSIONS: String(DIMENSIONS),
    },
    signal: new AbortController().signal,
  });
  return { code, io };
}

/** Der Ollama-Block aus der Textausgabe — die anderen Tests gehen uns hier nichts an. */
function ollamaBlock(output: string): string {
  const blocks = output.split("\n\n");
  return blocks.find((block) => block.includes("] Ollama")) ?? "";
}

describe("doctor: Kaltstart gegen Ausfall (Abnahmebefund)", () => {
  it("nennt einen schweigenden Dienst 'kein Lebenszeichen' und wartet NICHT auf einen Kaltstart", async () => {
    const url = await startSilentPort();
    const startedAt = performance.now();
    const { io } = await doctor(url, ["--timeout=400", "--cold-start-timeout=60000"]);
    const block = ollamaBlock(io.outText);

    expect(block).toContain("[FAIL] Ollama");
    expect(block).toContain("no sign of life");
    // Der springende Punkt: die Kaltstart-Zusatzfrist von 60 s wird gar nicht
    // erst angetreten, weil nichts antwortet, worauf zu warten sich lohnte.
    expect(performance.now() - startedAt).toBeLessThan(30_000);
    expect(block).not.toContain("laedt noch");
  }, 40_000);

  it("unterscheidet einen antwortenden Dienst mit haengendem /api/embed AUSDRUECKLICH davon", async () => {
    const url = await startFakeOllama("nie");
    const { io } = await doctor(url, ["--timeout=400", "--cold-start-timeout=800"]);
    const block = ollamaBlock(io.outText);

    expect(block).toContain("[FAIL] Ollama");
    expect(block).toContain("RESPONDS");
    expect(block).toContain("loading or stalled");
    expect(block).toContain("/api/embed");
    // Und der Unterschied steht auch in den Fakten, nicht nur in der Prosa.
    expect(block).toContain("lebenszeichen: true");
    expect(block).not.toContain("no sign of life");
  }, 40_000);

  it("besteht den Test, wenn der Dienst nur LANGSAM ist — und nennt die Dauer", async () => {
    const url = await startFakeOllama(900);
    const { io } = await doctor(url, ["--timeout=300", "--cold-start-timeout=20000"]);
    const block = ollamaBlock(io.outText);

    // Das ist der Befund selbst: derselbe Dienst wurde vorher FAIL gemeldet.
    expect(block).toContain("[OK  ] Ollama");
    expect(block).toContain(`Ready: ${MODEL}`);
    expect(block).toContain("ersteFristGerissen: true");
    expect(block).toContain("initial deadline of 300ms");
    // Der Hinweis auf das Weiterwarten steht auf stderr, nicht in den Nutzdaten.
    expect(io.errText).toContain("cold start");
  }, 40_000);

  it("nennt einen schnellen Dienst NICHT kaltgestartet", async () => {
    const url = await startFakeOllama(0);
    const { io } = await doctor(url, ["--timeout=10000"]);
    const block = ollamaBlock(io.outText);

    expect(block).toContain("[OK  ] Ollama");
    expect(block).toContain("ersteFristGerissen: false");
    expect(io.errText).not.toContain("cold start");
  }, 40_000);
});
