import { test, expect } from "vitest";
import { hashSync } from "bcryptjs";
import { WebSocket } from "ws";
import { DaemonClient, getDaemonAuthFailureReason } from "@getpaseo/client/internal/daemon-client";
import { generateLocalPairingOffer } from "../pairing-offer.js";
import { parseConnectionOfferFromUrl } from "@getpaseo/protocol/connection-offer";
import { buildRelayWebSocketUrl } from "@getpaseo/protocol/daemon-endpoints";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import pino from "pino";
import { generateKeyPair, exportPublicKey } from "@getpaseo/relay/e2ee";
import { startRelayTransport } from "../relay-transport.js";
import { admitSecuredRelaySocket } from "../websocket/secure-relay-ingress.js";

const liveTest = process.env.RUN_LIVE_RELAY_E2E === "1" ? test : test.skip;

liveTest(
  "hosted relay preserves password rejection from a real daemon",
  async () => {
    const daemon = await createTestPaseoDaemon({
      auth: { password: hashSync("diagnostic-password", 4) },
      relayEnabled: true,
      relayEndpoint: "relay.paseo.sh:443",
      relayUseTls: true,
      mcpEnabled: false,
      pluginsEnabled: false,
      agentClients: {},
    });
    const observations: Array<Record<string, unknown>> = [];
    try {
      const pairing = await generateLocalPairingOffer({
        paseoHome: daemon.paseoHome,
        relayEnabled: true,
        relayEndpoint: "relay.paseo.sh:443",
        relayUseTls: true,
        includeQr: false,
      });
      const offer = parseConnectionOfferFromUrl(pairing.url!);
      if (!offer) throw new Error("No relay pairing offer");
      for (const mode of ["direct", "relay"] as const) {
        for (const credential of ["missing", "wrong", "correct"] as const) {
          for (let attempt = 0; attempt < (mode === "relay" ? 3 : 1); attempt++) {
            const frames: string[] = [];
            let closeCode: number | null = null;
            let closeReason: string | null = null;
            const client = new DaemonClient({
              url:
                mode === "direct"
                  ? `ws://127.0.0.1:${daemon.port}/ws`
                  : buildRelayWebSocketUrl({
                      endpoint: "relay.paseo.sh:443",
                      useTls: true,
                      serverId: offer.serverId,
                      role: "client",
                    }),
              clientId: `diagnostic-${mode}-${credential}-${attempt}`,
              clientType: "cli",
              connectTimeoutMs: 20_000,
              reconnect: { enabled: false },
              password: { missing: undefined, wrong: "incorrect", correct: "diagnostic-password" }[
                credential
              ],
              ...(mode === "relay"
                ? { e2ee: { enabled: true, daemonPublicKeyB64: offer.daemonPublicKeyB64 } }
                : {}),
              webSocketFactory: (url, options) => {
                const socket = new WebSocket(url, options?.protocols, {
                  headers: options?.headers,
                });
                socket.on("message", (data, binary) => frames.push(frameKind(data, binary)));
                socket.on("close", (code, reason) => {
                  closeCode = code;
                  closeReason = reason.toString();
                });
                return socket;
              },
            });
            const result = await connectOutcome(client);
            const observation = {
              mode,
              credential,
              attempt,
              ...result,
              frames,
              closeCode,
              closeReason,
            };
            observations.push(observation);
            console.log(JSON.stringify(observation));
          }
        }
      }
    } finally {
      await daemon.close();
    }
    for (const observation of observations) {
      expect(observation, JSON.stringify(observation)).toMatchObject(
        observation.credential === "correct"
          ? { connected: true }
          : {
              connected: false,
              reason:
                observation.credential === "missing" ? "password_required" : "incorrect_password",
            },
      );
    }
  },
  180_000,
);

async function connectOutcome(client: DaemonClient): Promise<Record<string, unknown>> {
  try {
    await client.connect();
    return { connected: true };
  } catch (error) {
    return {
      connected: false,
      error: error instanceof Error ? error.message : String(error),
      reason: getDaemonAuthFailureReason(error),
    };
  } finally {
    await client.close();
  }
}

function frameKind(data: WebSocket.RawData, binary: boolean): string {
  if (binary) return "encrypted-record";
  try {
    const parsed = JSON.parse(data.toString());
    return ["e2ee_ready", "hello.rejected", "session"].includes(parsed.type)
      ? parsed.type
      : "other-json";
  } catch {
    return "encrypted-record";
  }
}

liveTest(
  "close timing isolates loss after the daemon send callback",
  async () => {
    const observations: Array<{
      delayMs: number;
      reason: string | null;
      sendCompleted: boolean;
      frames: string[];
    }> = [];
    for (const delayMs of [0, 500]) {
      const daemonKeyPair = generateKeyPair();
      const serverId = `diagnostic-${randomUUID()}`;
      let markReady!: () => void;
      const ready = new Promise<void>((resolve) => {
        markReady = resolve;
      });
      let sendCompleted = false;
      const controller = startRelayTransport({
        serverId,
        relayEndpoint: "relay.paseo.sh:443",
        relayUseTls: true,
        logger: pino({ level: "silent" }),
        createWebSocket: (url) => {
          const socket = new WebSocket(url);
          if (!new URL(url).searchParams.has("connectionId")) {
            socket.on("message", (data) => {
              if (JSON.parse(data.toString()).type === "sync") markReady();
            });
          }
          return socket;
        },
        attachSocket: async (raw) =>
          admitSecuredRelaySocket(
            raw,
            {
              daemonKeyPair,
              logger: pino({ level: "silent" }),
              requireProtectedMode: () => false,
            },
            async ({ socket }) => {
              async function rejectHello() {
                try {
                  await socket.send(
                    JSON.stringify({
                      type: "hello.rejected",
                      reason: "password_required",
                      accepts: ["password"],
                    }),
                  );
                  sendCompleted = true;
                  if (delayMs) await delay(delayMs);
                  socket.close(4401, "Password required");
                } catch {
                  socket.close(1011, "Diagnostic send failed");
                }
              }
              socket.on("message", rejectHello);
            },
          ),
      });
      try {
        await Promise.race([
          ready,
          new Promise<never>((_resolve, reject) => {
            const timeout = setTimeout(
              () => reject(new Error("Relay control did not become ready")),
              10_000,
            );
            timeout.unref();
          }),
        ]);
        for (let attempt = 0; attempt < 3; attempt++) {
          sendCompleted = false;
          const frames: string[] = [];
          const client = new DaemonClient({
            url: buildRelayWebSocketUrl({
              endpoint: "relay.paseo.sh:443",
              useTls: true,
              serverId,
              role: "client",
            }),
            clientId: `close-timing-${attempt}`,
            clientType: "cli",
            reconnect: { enabled: false },
            connectTimeoutMs: 20_000,
            e2ee: { enabled: true, daemonPublicKeyB64: exportPublicKey(daemonKeyPair.publicKey) },
            webSocketFactory: (url) => {
              const socket = new WebSocket(url);
              socket.on("message", (data, binary) => frames.push(frameKind(data, binary)));
              return socket;
            },
          });
          let reason: string | null = null;
          try {
            await client.connect();
          } catch (error) {
            reason = getDaemonAuthFailureReason(error);
          } finally {
            await client.close();
          }
          const observation = { delayMs, reason, sendCompleted, frames };
          observations.push(observation);
          process.stdout.write(`${JSON.stringify(observation)}\n`);
        }
      } finally {
        await controller.stop();
      }
    }
    expect(observations.filter((item) => item.delayMs === 500)).toEqual(
      Array.from({ length: 3 }, () => ({
        delayMs: 500,
        reason: "password_required",
        sendCompleted: true,
        frames: ["e2ee_ready", "encrypted-record"],
      })),
    );
    expect(
      observations.filter((item) => item.delayMs === 0).every((item) => item.sendCompleted),
    ).toBe(true);
  },
  120_000,
);
