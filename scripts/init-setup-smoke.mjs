#!/usr/bin/env node
/** Exercise actual init automation, terminal cancellation and offline feature-map contracts. */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { captureQuickstartTree } from "./quickstart-smoke.mjs";
import {
  captureDistManifest,
  captureSourceManifest,
  manifestDigest,
  reserveEvidenceDirectory,
  runEvidenceCommand,
} from "./release-evidence.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI = path.join(ROOT, "apps/cli/dist/index.js");
const hash = (value) => createHash("sha256").update(value).digest("hex");
const writeJson = (file, value) =>
  writeFileSync(file, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });

/** Two declared features share real code; a private helper and unmapped source remain visible. */
export function createInitSetupFixture(root, withManifest = false) {
  mkdirSync(path.join(root, "src"), { recursive: true });
  const sources = {
    "src/accounts.ts": [
      'import { normalizeName } from "./shared.js";',
      "export function lookupAccount(id: string): string | undefined {",
      "  const normalized = normalizeAccountId(id);",
      "  if (!normalized) return undefined;",
      "  return normalizeName(normalized);",
      "}",
      "function normalizeAccountId(id: string): string {",
      '  if (!id) return "";',
      "  return id.trim();",
      "}",
      "",
    ].join("\n"),
    "src/handler.ts": [
      'import { lookupAccount } from "./accounts.js";',
      'import { normalizeName } from "./shared.js";',
      "export function handleAccount(id: string): string {",
      "  const account = lookupAccount(id);",
      '  return account ? normalizeName(account) : "missing";',
      "}",
      "",
    ].join("\n"),
    "src/shared.ts": [
      "export function normalizeName(value: string): string {",
      '  if (!value) return "unknown";',
      "  return value.trim();",
      "}",
      "",
    ].join("\n"),
    "src/unmapped.ts": 'export const intentionallyUnmapped = "visible coverage gap";\n',
    "src/accounts.test.ts": [
      'import { expect, it } from "vitest";',
      'import { lookupAccount } from "./accounts.js";',
      'it("finds an account", () => expect(lookupAccount(" 42 ")).toBe("42"));',
      "",
    ].join("\n"),
    "vision.md": "# Account access\n\nFind existing accounts and keep request handling separate.\n",
    "spec.md": "# Lookup contract\n\nEmpty identifiers have no account.\n",
  };
  for (const [name, content] of Object.entries(sources))
    writeFileSync(path.join(root, name), content, { flag: "wx" });
  if (withManifest) writeJson(path.join(root, "untangle.features.json"), fixtureFeatureManifest());
}

export function fixtureFeatureManifest() {
  const feature = (id, title, code, dependsOn) => ({
    id,
    title,
    stage: "implemented",
    review: "proposed",
    intent: [
      { role: "vision", path: "vision.md", heading: "Account access" },
      { role: "specification", path: "spec.md", heading: "Lookup contract" },
    ],
    owners: ["account-team"],
    code: { include: code },
    tests: { include: ["src/accounts.test.ts"] },
    criteria: [
      { id: "find", description: "Find an existing account", tests: ["src/accounts.test.ts"] },
    ],
    dependsOn,
  });
  return {
    schemaVersion: 1,
    owners: [
      {
        id: "account-team",
        label: "Account team",
        kind: "team",
        status: "declared",
        sources: [{ path: "vision.md", heading: "Account access" }],
      },
    ],
    features: [
      feature("account.lookup", "Account lookup", ["src/accounts.ts", "src/shared.ts"], []),
      feature(
        "account.request",
        "Account request",
        ["src/handler.ts", "src/shared.ts"],
        ["account.lookup"],
      ),
    ],
  };
}

/** Framework-authored declarations stay separate from actual implementation/test evidence. */
export function addSddSetupFixture(root, framework) {
  const files =
    framework === "spec-kit"
      ? {
          ".specify/memory/constitution.md":
            "# Engineering principles\nKeep account responsibility explicit.\n",
          "specs/001-accounts/spec.md":
            "# Feature Specification: Accounts\n\n## Functional Requirements\n\n- **FR-001**: Find accounts by identifier.\n",
          "specs/001-accounts/tasks.md":
            "# Tasks\n\n- [x] T001 [US1] Implement `src/accounts.ts`\n- [ ] T002 [US1] Check `src/accounts.test.ts`\n",
        }
      : {
          "openspec/specs/accounts/spec.md":
            "# Accounts\n\n## Requirements\n\n### Requirement: Account lookup\nThe system SHALL find an account by identifier.\n\n#### Scenario: Known account\n- **WHEN** its identifier is supplied\n- **THEN** return the account\n",
          "openspec/changes/add-account-lookup/proposal.md":
            "# Account lookup\n\n## Why\nKeep account behavior inspectable.\n",
          "openspec/changes/add-account-lookup/tasks.md":
            "# Tasks\n\n- [x] 1.1 Implement `src/accounts.ts`\n- [ ] 1.2 Check `src/accounts.test.ts`\n",
        };
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), content, { flag: "wx" });
  }
}

/** Never infer completed tests or authority from a successful visualization command. */
export function assertFeatureMapFixture(result, root) {
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.kind, "feature_map_artifact");
  assert.equal(result.summary.features, 2);
  assert.equal(result.summary.truncated, false);
  assert(result.summary.unmappedCodeFiles >= 1);
  assert.equal(result.report.semanticConformance, "not_independently_proven");
  assert.equal(result.report.ownershipAuthority, "manifest_declarations");
  const lookup = result.report.features.find((feature) => feature.id === "account.lookup");
  assert.equal(lookup.code.complete, true);
  assert(lookup.code.metrics.cognitive.execution_unit > 0);
  assert(lookup.code.hotspots.some((hotspot) => hotspot.symbol === "normalizeAccountId"));
  assert.equal(lookup.testEvidence.status, "not_run");
  assert(
    lookup.ownership.some((owner) => owner.id === "account-team" && owner.status === "declared"),
  );
  const kinds = new Set(result.graph.nodes.map((node) => node.kind));
  for (const kind of ["feature", "code", "test", "owner", "intent", "unmapped"])
    assert(kinds.has(kind), `Expected actual ${kind} nodes.`);
  const shared = result.graph.nodes.find(
    (node) => node.kind === "code" && node.path === "src/shared.ts",
  );
  assert(shared, "The shared file must remain one actual code node.");
  const identifiers = new Set(result.graph.nodes.map((node) => node.id));
  assert.equal(
    identifiers.size,
    result.graph.nodes.length,
    "Graph node identifiers must be unique.",
  );
  for (const edge of result.graph.edges)
    assert(
      identifiers.has(edge.from) && identifiers.has(edge.to),
      "An edge has an absent endpoint.",
    );
  assert.equal(
    result.graph.edges.filter((edge) => edge.kind === "code" && edge.to === shared.id).length,
    2,
  );
  assert(result.graph.edges.some((edge) => edge.kind === "dependency"));
  for (const file of [result.htmlPath, result.jsonPath]) {
    const relative = path.relative(path.join(root, ".untangle", "feature-map"), file);
    assert(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
  }
}

/** A real PTY has separate stdout, tty stderr/stdin and observable terminal mode restoration. */
export const PTY_PROBE = String.raw`
import base64, fcntl, hashlib, json, os, pty, select, signal, struct, subprocess, sys, termios, time
request = json.loads(sys.argv[1])
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", request.get("rows", 30), request.get("columns", 100), 0, 0))
before = termios.tcgetattr(slave)
child = subprocess.Popen(request["argv"], cwd=request["cwd"], env={**os.environ, **request.get("env", {})}, stdin=slave, stdout=subprocess.PIPE, stderr=slave, start_new_session=True, close_fds=True)
os.set_blocking(master, False)
os.set_blocking(child.stdout.fileno(), False)
stdout, terminal = bytearray(), bytearray()
actions = request.get("actions", [request])
next_action, transcript_cursor = 0, 0
deadline, timed_out = time.monotonic() + request.get("timeoutSeconds", 45), False
while child.poll() is None:
    if time.monotonic() >= deadline:
        timed_out = True
        os.killpg(child.pid, signal.SIGKILL)
        child.wait()
        break
    ready, _, _ = select.select([master, child.stdout.fileno()], [], [], 0.05)
    for fd in ready:
        try:
            chunk = os.read(fd, 65536)
        except (BlockingIOError, OSError):
            chunk = b""
        (terminal if fd == master else stdout).extend(chunk)
    decoded = terminal.decode("utf-8", errors="replace")
    if next_action < len(actions) and actions[next_action]["marker"] in decoded[transcript_cursor:]:
        action = actions[next_action]
        if action.get("signal"):
            child.send_signal(getattr(signal, action["signal"]))
        else:
            os.write(master, base64.b64decode(action["inputBase64"]))
        next_action += 1
        transcript_cursor = len(decoded)
for fd in [master, child.stdout.fileno()]:
    while True:
        try:
            chunk = os.read(fd, 65536)
        except (BlockingIOError, OSError):
            break
        if not chunk:
            break
        (terminal if fd == master else stdout).extend(chunk)
after = termios.tcgetattr(slave)
# PENDIN is a kernel-owned pending-input status, set by macOS while restoring
# canonical mode even when the caller passes the exact original attributes.
pendin = getattr(termios, "PENDIN", 0)
def user_mode(attributes):
    result = list(attributes)
    result[3] &= ~pendin
    return result
result = {"exitCode":child.returncode,"actionSent":next_action == len(actions),"actionsSent":next_action,"expectedActions":len(actions),"timedOut":timed_out,"terminalRestored":user_mode(before) == user_mode(after),"rawAttributesEqual":before == after,"ignoredKernelStatusFlags":{"PENDIN":pendin},"stdout":stdout.decode("utf-8", errors="replace"),"terminal":terminal.decode("utf-8", errors="replace"),"beforeModeSha256":hashlib.sha256(repr(before).encode()).hexdigest(),"afterModeSha256":hashlib.sha256(repr(after).encode()).hexdigest(),"beforeUserModeSha256":hashlib.sha256(repr(user_mode(before)).encode()).hexdigest(),"afterUserModeSha256":hashlib.sha256(repr(user_mode(after)).encode()).hexdigest()}
os.close(master)
os.close(slave)
print(json.dumps(result))
`;

export function assertCancelledPty(result) {
  assert.equal(result.timedOut, false, result.terminal);
  assert.equal(result.actionSent, true, "The action must follow an actual ready prompt.");
  assert.equal(result.exitCode, 130, result.terminal);
  assert.equal(result.stdout, "", "A cancelled setup must not emit a configuration payload.");
  assert.equal(result.terminalRestored, true, "The wizard leaked its raw terminal mode.");
}

export async function runInitSetupSmoke(
  outDir,
  { readyMarker = "How do you want to start?" } = {},
) {
  const output = reserveEvidenceDirectory(
    ROOT,
    outDir ?? path.join(ROOT, ".untangle", `init-setup-smoke-${randomUUID()}`),
  );
  const temporary = realpathSync(mkdtempSync(path.join(tmpdir(), "untangle-init-setup-")));
  const unrelated = path.join(temporary, "unrelated working directory");
  mkdirSync(unrelated);
  const unrelatedTree = captureQuickstartTree(unrelated);
  const fresh = (name, manifest = false) => {
    const root = path.join(temporary, name);
    createInitSetupFixture(root, manifest);
    return root;
  };
  const source = captureSourceManifest(ROOT),
    dist = captureDistManifest(ROOT);
  const report = {
    schemaVersion: 1,
    status: "running",
    node: process.version,
    sourceDigest: manifestDigest(source),
    distDigest: manifestDigest(dist),
    cases: [],
    commands: [],
    limitations: [
      "Existing built files are exercised; build correspondence is supplied by the preceding release build gate.",
      "No Sonar/Sentrux service, installer, credentials or model is started by this offline smoke.",
      "The declared test file is inspected but not executed; testEvidence must remain not_run.",
      "Real PTY coverage requires Python3 and POSIX; missing infrastructure is a failed/unverified gate, not a skip.",
      "PTY mode comparison preserves all user flags/control characters, excluding only the kernel-owned PENDIN pending-input status; raw and normalized hashes are retained.",
    ],
  };
  writeJson(path.join(output, "sources.json"), source);
  writeJson(path.join(output, "dist.json"), dist);
  let sequence = 0;
  const command = async (name, argv, exit = 0) => {
    assert.deepEqual(captureSourceManifest(ROOT), source, "Sources changed before command.");
    assert.deepEqual(captureDistManifest(ROOT), dist, "Build changed before command.");
    const result = await runEvidenceCommand(argv, { cwd: unrelated, timeoutMs: 120_000 });
    const stem = `${String(++sequence).padStart(2, "0")}-${name}`;
    writeFileSync(path.join(output, "gates", `${stem}.stdout`), result.stdout, { flag: "wx" });
    writeFileSync(path.join(output, "gates", `${stem}.stderr`), result.stderr, { flag: "wx" });
    report.commands.push({
      name,
      command: argv,
      exitCode: result.exitCode,
      signal: result.signal,
      stdout: { path: `gates/${stem}.stdout`, sha256: hash(result.stdout) },
      stderr: { path: `gates/${stem}.stderr`, sha256: hash(result.stderr) },
    });
    assert.deepEqual(captureSourceManifest(ROOT), source, "Sources changed during command.");
    assert.deepEqual(captureDistManifest(ROOT), dist, "Build changed during command.");
    assert.equal(result.operationalError, undefined, result.operationalError);
    assert.equal(result.signal, null);
    assert.equal(result.exitCode, exit, result.stderr + result.stdout);
    assert.deepEqual(
      captureQuickstartTree(unrelated),
      unrelatedTree,
      "The selected root was ignored.",
    );
    return result;
  };
  const cli = (...args) => [process.execPath, CLI, ...args];
  const check = async (name, run) => {
    try {
      await run();
      report.cases.push({ name, status: "passed" });
    } catch (error) {
      report.cases.push({ name, status: "failed", error: String(error) });
      throw error;
    }
  };
  const withoutNetworkProbes = async (run) => {
    const requests = [];
    const server = createServer((request, response) => {
      requests.push(request.url);
      response.writeHead(503).end("Unexpected service probe during offline/cancelled setup.");
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const url = `http://127.0.0.1:${server.address().port}`;
      await run({ UNTANGLE_QDRANT_URL: url, UNTANGLE_OLLAMA_URL: url });
      assert.deepEqual(
        requests,
        [],
        "Setup contacted a service despite offline mode or cancellation before selection.",
      );
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  };
  try {
    await check("interactive setup is advertised by the actual installed command", async () => {
      const r = await command("interactive-help", cli("init", "--help"));
      assert(r.stdout.includes("--interactive"));
    });
    await check("piped JSON dry-run neither prompts nor writes", async () => {
      const root = fresh("dry run project");
      const before = captureQuickstartTree(root);
      const r = await command(
        "dry-json",
        cli("init", `--root=${root}`, "--offline", "--dry-run", "--format=json"),
      );
      assert.equal(JSON.parse(r.stdout).outcome, "would-create");
      assert.equal(r.stderr.toString(), "");
      assert.deepEqual(captureQuickstartTree(root), before);
    });
    await check("explicit interactive mode rejects a pipe before any write", async () => {
      const root = fresh("non tty project");
      const before = captureQuickstartTree(root);
      await command("non-tty", cli("init", `--root=${root}`, "--interactive", "--offline"), 2);
      assert.deepEqual(captureQuickstartTree(root), before);
    });
    await check("interactive JSON and dry-run conflicts fail before writes", async () => {
      const root = fresh("conflict project");
      const before = captureQuickstartTree(root);
      for (const flag of ["--format=json", "--dry-run"])
        await command(
          flag.includes("format") ? "interactive-json" : "interactive-dry-run",
          cli("init", `--root=${root}`, "--interactive", flag),
          2,
        );
      assert.deepEqual(captureQuickstartTree(root), before);
    });
    await check("noninteractive offline setup is idempotent and config-only", async () => {
      const root = fresh("ordinary project");
      const before = captureQuickstartTree(root);
      const first = await command(
        "offline-init",
        cli("init", `--root=${root}`, "--no-interactive", "--offline", "--format=json"),
      );
      assert.equal(JSON.parse(first.stdout).outcome, "created");
      const after = captureQuickstartTree(root);
      assert.deepEqual(
        after.filter((entry) => entry.path !== "untangle.toml"),
        before,
      );
      const second = await command(
        "offline-again",
        cli("init", `--root=${root}`, "--no-interactive", "--offline", "--format=json"),
      );
      assert.equal(JSON.parse(second.stdout).outcome, "unchanged");
      assert.deepEqual(captureQuickstartTree(root), after);
    });
    await check("existing user configuration is never silently replaced", async () => {
      const root = fresh("existing config");
      writeFileSync(
        path.join(root, "untangle.toml"),
        '# Hand maintained configuration\nprojectId = "preserve-me"\n',
      );
      const before = captureQuickstartTree(root);
      const r = await command(
        "preserve",
        cli("init", `--root=${root}`, "--offline", "--no-interactive", "--format=json"),
        1,
      );
      assert.equal(JSON.parse(r.stdout).outcome, "differs");
      assert.deepEqual(captureQuickstartTree(root), before);
    });
    for (const [name, action] of [
      ["escape", { inputBase64: "Gw==" }],
      ["control-c", { inputBase64: "Aw==" }],
      ["signal", { signal: "SIGINT" }],
    ]) {
      await check(`real PTY ${name} cancels without writes and restores terminal`, async () => {
        const root = fresh(`pty ${name}`);
        const before = captureQuickstartTree(root);
        const request = {
          argv: cli("init", `--root=${root}`, "--interactive", "--offline"),
          cwd: unrelated,
          marker: readyMarker,
          ...action,
        };
        const r = await command(`pty-${name}`, [
          "python3",
          "-c",
          PTY_PROBE,
          JSON.stringify(request),
        ]);
        const result = JSON.parse(r.stdout);
        assertCancelledPty(result);
        assert.deepEqual(captureQuickstartTree(root), before);
      });
    }
    await check(
      "ordinary local TTY invocation opens the wizard before writing or probing",
      async () => {
        const root = fresh("automatic pty");
        const before = captureQuickstartTree(root);
        const request = {
          argv: cli("init", `--root=${root}`),
          cwd: unrelated,
          env: { CI: "" },
          marker: readyMarker,
          inputBase64: "Gw==",
        };
        await withoutNetworkProbes(async (env) => {
          request.env = { ...request.env, ...env };
          const r = await command("pty-automatic", [
            "python3",
            "-c",
            PTY_PROBE,
            JSON.stringify(request),
          ]);
          assertCancelledPty(JSON.parse(r.stdout));
        });
        assert.deepEqual(captureQuickstartTree(root), before);
      },
    );
    await check(
      "real offline TTY quick setup completes with separate stdout and local map",
      async () => {
        const root = fresh("pty complete project", true);
        const before = captureQuickstartTree(root);
        const request = {
          argv: cli("init", `--root=${root}`, "--interactive", "--offline"),
          cwd: unrelated,
          actions: [
            readyMarker,
            "Add an analyzer or local search service?",
            "Create a local feature/code map?",
            "Open the feature/code map after setup?",
            "Apply this setup?",
          ].map((marker) => ({ marker, inputBase64: "DQ==" })),
        };
        let r;
        await withoutNetworkProbes(async (env) => {
          request.env = env;
          r = await command("pty-complete", ["python3", "-c", PTY_PROBE, JSON.stringify(request)]);
        });
        const result = JSON.parse(r.stdout);
        assert.equal(result.timedOut, false, result.terminal);
        assert.equal(result.exitCode, 0, result.terminal);
        assert.equal(result.actionsSent, 5);
        assert.equal(result.terminalRestored, true);
        assert.equal(result.stdout, `${path.join(root, "untangle.toml")}\n`);
        const after = captureQuickstartTree(root);
        assert.deepEqual(
          after.filter(
            (entry) => entry.path !== "untangle.toml" && !entry.path.startsWith(".untangle"),
          ),
          before,
        );
        const savedMap = after.find(
          (entry) =>
            entry.path.startsWith(".untangle/feature-map/") && entry.path.endsWith(".json"),
        );
        assert(savedMap, "The wizard must actually write the selected local map.");
        const saved = JSON.parse(readFileSync(path.join(root, savedMap.path), "utf8"));
        assert.equal(saved.report.root, root);
        assert.equal(saved.report.features.length, 2);
        assert(saved.report.features.every((feature) => feature.testEvidence.status === "not_run"));
      },
    );
    await check(
      "feature map uses actual full feature scopes and explicit relationships offline",
      async () => {
        const root = fresh("mapped project", true);
        const before = captureQuickstartTree(root);
        const r = await command(
          "feature-map",
          cli("graph", "features", `--root=${root}`, "--format=json"),
        );
        const result = JSON.parse(r.stdout);
        assertFeatureMapFixture(result, root);
        assert.equal(hash(readFileSync(result.htmlPath)), result.sha256.html);
        assert.equal(hash(readFileSync(result.jsonPath)), result.sha256.json);
        const saved = JSON.parse(readFileSync(result.jsonPath, "utf8"));
        assert.deepEqual(saved.graph, result.graph);
        assert.deepEqual(saved.report, result.report);
        assert.deepEqual(
          captureQuickstartTree(root).filter((entry) => !entry.path.startsWith(".untangle")),
          before,
        );
        writeJson(path.join(output, "feature-map.json"), result);
      },
    );
    for (const framework of ["spec-kit", "openspec"]) {
      await check(
        `real spec-driven TUI connects ${framework} and maps its proposed source-bound draft`,
        async () => {
          const root = fresh(`pty ${framework} project`);
          addSddSetupFixture(root, framework);
          const before = captureQuickstartTree(root);
          const actions = [
            { marker: readyMarker, inputBase64: "G1tCDQ==" },
            ...["Vision document", "Specification document", "Feature manifest"].map((marker) => ({
              marker,
              inputBase64: "DQ==",
            })),
            { marker: "Connect detected spec-driven artifacts?", inputBase64: "G1tCDQ==" },
            ...[
              "Add an analyzer or local search service?",
              "Create a local feature/code map?",
              "Open the feature/code map after setup?",
              "Apply this setup?",
            ].map((marker) => ({ marker, inputBase64: "DQ==" })),
          ];
          const request = {
            argv: cli("init", `--root=${root}`, "--interactive", "--offline"),
            cwd: unrelated,
            actions,
          };
          let result;
          await withoutNetworkProbes(async (env) => {
            request.env = env;
            const r = await command(`pty-${framework}-complete`, [
              "python3",
              "-c",
              PTY_PROBE,
              JSON.stringify(request),
            ]);
            result = JSON.parse(r.stdout);
          });
          assert.equal(result.timedOut, false, result.terminal);
          assert.equal(result.exitCode, 0, result.terminal);
          assert.equal(result.actionsSent, 9);
          assert.equal(result.terminalRestored, true);
          assert.equal(result.stdout, `${path.join(root, "untangle.toml")}\n`);
          const after = captureQuickstartTree(root);
          assert.deepEqual(
            after.filter(
              (entry) => entry.path !== "untangle.toml" && !entry.path.startsWith(".untangle"),
            ),
            before,
          );
          const connection = after.find(
            (entry) =>
              entry.path.startsWith(".untangle/sdd/") && entry.path.endsWith("/report.json"),
          );
          const draftFile = after.find(
            (entry) =>
              entry.path.startsWith(".untangle/sdd/") &&
              entry.path.endsWith("/untangle.features.json"),
          );
          assert(
            connection && draftFile,
            "The actual confirmed TUI must save the connector report and manifest.",
          );
          const connected = JSON.parse(readFileSync(path.join(root, connection.path), "utf8"));
          const draft = JSON.parse(readFileSync(path.join(root, draftFile.path), "utf8"));
          assert.deepEqual(connected.frameworks, [framework]);
          assert(connected.features.some((feature) => feature.tasks.some((task) => task.checked)));
          assert.deepEqual(draft.owners, []);
          assert(
            draft.features.every(
              (feature) => feature.stage === "planned" && feature.review === "proposed",
            ),
          );
          const mapFile = after.find(
            (entry) =>
              entry.path.startsWith(".untangle/feature-map/") && entry.path.endsWith(".json"),
          );
          assert(mapFile);
          const map = JSON.parse(readFileSync(path.join(root, mapFile.path), "utf8"));
          assert.equal(map.report.features.length, draft.features.length);
          assert(
            map.report.features.every(
              (feature) => feature.stage === "planned" && feature.testEvidence.status === "not_run",
            ),
          );
          assert(
            map.report.features.some(
              (feature) => (feature.code.metrics?.cognitive.execution_unit ?? 0) > 0,
            ),
          );
        },
      );
    }
    assert.deepEqual(captureSourceManifest(ROOT), source);
    assert.deepEqual(captureDistManifest(ROOT), dist);
    report.status = "verified";
    return report;
  } catch (error) {
    report.status = "failed";
    report.error = error.stack ?? String(error);
    throw error;
  } finally {
    writeJson(path.join(output, "acceptance.json"), report);
    rmSync(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = process.argv.slice(2);
  const out = options.find((arg) => arg.startsWith("--out-dir="))?.slice("--out-dir=".length);
  const marker = options
    .find((arg) => arg.startsWith("--ready-marker="))
    ?.slice("--ready-marker=".length);
  if (options.some((arg) => !arg.startsWith("--out-dir=") && !arg.startsWith("--ready-marker="))) {
    process.stderr.write(
      "Usage: node scripts/init-setup-smoke.mjs [--out-dir=<new-directory>] [--ready-marker=<exact prompt>]\n",
    );
    process.exitCode = 2;
  } else {
    try {
      const result = await runInitSetupSmoke(
        out,
        marker === undefined ? {} : { readyMarker: marker },
      );
      process.stdout.write(
        JSON.stringify({ status: result.status, cases: result.cases.length }) + "\n",
      );
    } catch (error) {
      process.stderr.write(`${error.stack ?? String(error)}\n`);
      process.exitCode = 1;
    }
  }
}
