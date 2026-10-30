import { useEffect } from "react";
import { listenToDesktopEvent } from "@/desktop/electron/events";
import { getDesktopHost } from "@/desktop/host";
import { useStableEvent } from "@/hooks/use-stable-event";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { navigateToAgent } from "@/utils/navigate-to-agent";

interface OpenAgentEventPayload {
  serverId?: unknown;
  agentId?: unknown;
  workspaceId?: unknown;
  terminalId?: unknown;
}

function readId(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function AgentNavigationListener() {
  const openAgent = useStableEvent((payload: OpenAgentEventPayload | null) => {
    const serverId = readId(payload?.serverId);
    if (!serverId) {
      return;
    }
    const workspaceId = readId(payload?.workspaceId);
    const terminalId = readId(payload?.terminalId);
    if (workspaceId && terminalId) {
      navigateToWorkspace({ serverId, workspaceId, target: { kind: "terminal", terminalId } });
      return;
    }
    const agentId = readId(payload?.agentId);
    if (agentId) {
      navigateToAgent({ serverId, agentId });
    }
  });

  useEffect(() => {
    const host = getDesktopHost();
    const ready = host?.agentNavigation?.ready;
    if (typeof host?.events?.on !== "function" || typeof ready !== "function") {
      return;
    }

    let disposed = false;
    let unlisten: (() => void) | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const connect = async () => {
      let dispose: (() => void) | null = null;
      try {
        dispose = await listenToDesktopEvent<OpenAgentEventPayload>("open-agent", openAgent);
        if (disposed) {
          dispose();
          return;
        }
        unlisten = dispose;
        const pending = await ready();
        if (!disposed && pending) {
          openAgent(pending);
        }
      } catch {
        dispose?.();
        if (unlisten === dispose) {
          unlisten = null;
        }
        if (!disposed) {
          retryTimer = setTimeout(() => void connect(), 1_000);
        }
      }
    };

    void connect();

    return () => {
      disposed = true;
      if (retryTimer) {
        clearTimeout(retryTimer);
      }
      unlisten?.();
    };
  }, [openAgent]);

  return null;
}
