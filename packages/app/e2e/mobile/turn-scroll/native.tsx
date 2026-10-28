import { useCallback, useMemo, useRef, useState } from "react";
import { Button, Pressable, Text, View, type ViewStyle } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { KeyboardShiftProvider } from "@/keyboard/shift";
import { createNativeStreamStrategy } from "@/agent-stream/strategy-native";
import { createStreamPresentation } from "@/agent-stream/presentation";
import type { StreamViewportHandle } from "@/agent-stream/strategy";
import type { StreamItem } from "@/types/stream";

const frameStyle: ViewStyle = { flex: 1, paddingTop: 45, paddingBottom: 30 };
const listStyle: ViewStyle = { flex: 1 };
const resultStyle = { color: "#111", height: 50 };
const textStyle = { color: "#111", padding: 8 };
const rowStyles: ViewStyle[] = [false, true].flatMap((work) =>
  [false, true].map((host) => ({
    height: work ? 90 : 60,
    borderBottomWidth: 1,
    borderColor: "#bbb",
    backgroundColor: host ? "#ccddff" : "#fff",
    justifyContent: "center",
  })),
);
function Row({
  item,
  expanded,
  isHost,
  attach,
  toggle,
}: {
  item: StreamItem;
  expanded: boolean;
  isHost: boolean;
  attach(id: string, view: View | null): void;
  toggle(id: string): void;
}) {
  const ref = useCallback((view: View | null) => attach(item.id, view), [attach, item.id]);
  const onPress = useCallback(() => toggle(item.id), [toggle, item.id]);
  const style = rowStyles[(item.id.startsWith("work") ? 2 : 0) + (isHost ? 1 : 0)];
  const stateLabel = expanded ? " Collapse" : " Expand";
  return (
    <View ref={ref} collapsable={false} style={style}>
      <Pressable testID={item.id} onPress={onPress}>
        <Text style={textStyle}>
          {item.id}
          {isHost ? stateLabel : ""}
        </Text>
      </Pressable>
    </View>
  );
}
function measureY(view: View | undefined): Promise<number> {
  if (!view) return Promise.reject(new Error("Diagnostic row is not mounted"));
  return new Promise((resolve) => view.measureInWindow((_x, y) => resolve(y)));
}
function settleLayout(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 1500));
}
const strategy = createNativeStreamStrategy();
const tail: StreamItem[] = Array.from({ length: 10 }, (_, n) => {
  const turnId = `turn-${n}`;
  const timestamp = new Date(2026, 0, 1, 0, n);
  return [
    { kind: "user_message" as const, id: `host-${n}`, turnId, timestamp, text: `Prompt ${n}` },
    ...Array.from({ length: 5 }, (_work, i) => ({
      kind: "assistant_message" as const,
      id: `work-${n}-${i}`,
      turnId,
      timestamp,
      text: `Work ${n}-${i}`,
    })),
    { kind: "assistant_message" as const, id: `reply-${n}`, turnId, timestamp, text: `Reply ${n}` },
  ];
}).flat();

function Transcript() {
  const present = useMemo(createStreamPresentation, []);
  const viewportRef = useRef<StreamViewportHandle | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [running, setRunning] = useState(false);
  const [report, setReport] = useState("Ready");
  const rows = useRef(new Map<string, View>());
  const presentation = present({
    tail,
    head: [],
    transform: undefined,
    display: "collapseTurns",
    expandedTurnHostIds: expanded,
    isTurnActive: running,
    activeTurnId: running ? "turn-9" : null,
  });
  const historyMounted = strategy.orderTail(presentation.tail);
  const sample = useCallback(async (id: string, next: () => void, label = "complete") => {
    const before = await measureY(rows.current.get(id));
    next();
    await settleLayout();
    const after = await measureY(rows.current.get(id));
    setReport(
      `${label} ${id}: before=${before.toFixed(1)} after=${after.toFixed(1)} delta=${(after - before).toFixed(1)}`,
    );
  }, []);
  const attach = useCallback((id: string, view: View | null) => {
    if (view) rows.current.set(id, view);
    else rows.current.delete(id);
  }, []);
  const toggle = useCallback(
    (id: string) => {
      const turn = presentation.turns.turnsByHostId.get(id);
      if (!turn) return;
      sample(
        id,
        () => {
          viewportRef.current?.holdReadingPosition();
          setExpanded((previous) => {
            const next = new Set(previous);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
          });
        },
        turn.expanded ? "collapse" : "expand",
      );
    },
    [presentation.turns.turnsByHostId, sample],
  );
  const renderRow = (item: StreamItem) => {
    const turn = presentation.turns.turnsByHostId.get(item.id);
    return (
      <Row
        item={item}
        isHost={!!turn}
        expanded={!!turn?.expanded}
        attach={attach}
        toggle={toggle}
      />
    );
  };
  const start = useCallback(() => setRunning(true), []);
  const finish = useCallback(
    () => setTimeout(() => sample("host-9", () => setRunning(false)), 5000),
    [sample],
  );
  return (
    <View style={frameStyle}>
      <Text testID="result" style={resultStyle}>
        {report}
      </Text>
      <Button title="Start running turn" onPress={start} />
      <Button title="Finish in 5 seconds" onPress={finish} />
      <View style={listStyle}>
        {strategy.render({
          agentId: "diagnostic",
          segments: { historyVirtualized: [], historyMounted, liveHead: [] },
          liveHeadRowRevision: expanded,
          historyRowRevision: {
            contentById: new Set(),
            displayStateById: new Set([...expanded, ...presentation.turns.turnsByHostId.keys()]),
            globalDisplayState: running,
          },
          readingRowReplacements: presentation.readingRowReplacements,
          boundary: { hasVirtualizedHistory: false, hasMountedHistory: true, hasLiveHead: false },
          renderers: {
            renderHistoryVirtualizedRow: renderRow,
            renderHistoryMountedRow: renderRow,
            renderLiveHeadRow: renderRow,
            renderLiveAuxiliary: () => null,
          },
          listEmptyComponent: null,
          viewportRef,
          routeBottomAnchorRequest: null,
          isAuthoritativeHistoryReady: true,
          onNearBottomChange: () => {},
          onNearHistoryStart: () => false,
          isLoadingOlderHistory: false,
          hasOlderHistory: false,
          olderHistoryProgressKey: null,
          scrollEnabled: true,
          listStyle: { flex: 1 },
          baseListContentContainerStyle: {},
          forwardListContentContainerStyle: {},
          contentMaxWidth: 400,
        })}
      </View>
    </View>
  );
}
export default function Diagnostic() {
  return (
    <SafeAreaProvider>
      <KeyboardProvider>
        <KeyboardShiftProvider>
          <Transcript />
        </KeyboardShiftProvider>
      </KeyboardProvider>
    </SafeAreaProvider>
  );
}
