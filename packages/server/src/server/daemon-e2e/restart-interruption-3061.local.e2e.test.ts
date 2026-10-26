import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import pino from "pino";
import { expect, test } from "vitest";
import { CodexAppServerAgentClient } from "../agent/providers/codex-app-server-agent.js";
import { createTestPaseoDaemon, type TestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { DaemonClient } from "../test-utils/daemon-client.js";

// Diagnostic test: exercises the reported long shell turn and the production stop/start
// lifecycle with a real Codex provider. It does not reproduce an OS crash or desktop UI.
test.runIf(process.env.PASEO_REAL_RESTART_REPRO === "1")(
  "a daemon restart preserves evidence that a real Codex turn was interrupted",
  async () => {
    const root = await mkdtemp(path.resolve(".restart-interruption-3061-"));
    const logger = pino({ level: "silent" });
    await mkdir(path.join(root, "static"));
    let daemon: TestPaseoDaemon | undefined;
    let client: DaemonClient | undefined;
    const start = () =>
      createTestPaseoDaemon({
        paseoHomeRoot: root,
        staticDir: path.join(root, "static"),
        cleanup: false,
        logger,
        agentClients: { codex: new CodexAppServerAgentClient(logger) },
      });
    try {
      daemon = await start();
      client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
      await client.connect();
      const agent = await client.createAgent({
        provider: "codex",
        cwd: root,
        modeId: "full-access",
        title: "Interrupted turn repro",
      });
      await client.sendMessage(
        agent.id,
        "Run exactly this shell command in the working directory, in the foreground, then reply DONE: " +
          "printf started > started-marker; sleep 120; printf finished > finished-marker. " +
          "Do not start background work or stop the command yourself.",
      );
      await expect
        .poll(async () => readFile(path.join(root, "started-marker"), "utf8").catch(() => ""), {
          timeout: 120_000,
          interval: 250,
        })
        .toBe("started");
      expect((await client.fetchAgent(agent.id))?.agent.status).toBe("running");
      await daemon.daemon.agentManager.flush();
      console.log("BEFORE STOP", {
        status: (await daemon.daemon.agentStorage.get(agent.id))?.lastStatus,
        shellStarted: true,
        shellFinished: await readFile(path.join(root, "finished-marker"), "utf8").then(
          () => true,
          () => false,
        ),
      });
      await client.close();
      client = undefined;
      await daemon.close();
      daemon = undefined;
      daemon = await start();
      const stored = await daemon.daemon.agentStorage.get(agent.id);
      client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
      await client.connect();
      const beforeOpen = (await client.fetchAgent(agent.id))?.agent;
      await client.fetchAgentTimeline(agent.id);
      const afterOpen = (await client.fetchAgent(agent.id))?.agent;
      const history = daemon.daemon.agentManager.getTimeline(agent.id);
      console.log("AFTER RESTART", {
        storedStatus: stored?.lastStatus,
        storedLastError: stored?.lastError ?? null,
        storedAttention: stored?.attentionReason ?? null,
        snapshotBeforeOpen: beforeOpen?.status,
        snapshotAfterOpen: afterOpen?.status,
        lastErrorAfterOpen: afterOpen?.lastError ?? null,
        assistantDone: history.some(
          (item) => item.type === "assistant_message" && item.text === "DONE",
        ),
        shellFinished: await readFile(path.join(root, "finished-marker"), "utf8").then(
          () => true,
          () => false,
        ),
      });
      expect(stored).toMatchObject({
        lastStatus: "error",
        requiresAttention: true,
        attentionReason: "error",
      });
      expect(stored?.lastError).toContain("Daemon restarted");
      expect(afterOpen?.lastError).toBe(stored?.lastError);
    } finally {
      await client?.close();
      await daemon?.close();
      await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  },
  180_000,
);
