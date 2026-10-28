import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

const [, , session, metroUrl] = process.argv;
assert(session && metroUrl, "Pass a session name and the Metro URL serving native.tsx");
function ad(...args) {
  return execFileSync("agent-device", [...args, "--session", session], {
    encoding: "utf8",
    timeout: 60_000,
  });
}
ad(
  "open",
  "sh.paseo.debug",
  `exp+voice-mobile://expo-development-client/?url=${encodeURIComponent(metroUrl)}`,
  "--platform",
  "android",
  "--relaunch",
);
ad("wait", "text", "Ready");
ad("press", 'id="host-7"', "--settle");
ad("wait", "text", "expand host-7: before=");
const expansion = ad("get", "text", 'id="result"');
console.log(expansion.trim());
const expandedDelta = Number(/delta=([\d.-]+)/.exec(expansion)?.[1]);
ad("scroll", "up", "--until", 'id="host-7"');
ad("wait", "stable", "1000", "10000");
ad("press", 'id="host-7"', "--settle");
ad("wait", "text", "collapse host-7: before=");
const collapse = ad("get", "text", 'id="result"');
console.log(collapse.trim());
const collapsedDelta = Number(/delta=([\d.-]+)/.exec(collapse)?.[1]);
assert(
  Number.isFinite(expandedDelta) && Number.isFinite(collapsedDelta),
  "Both native measurements must complete",
);
assert(
  Math.abs(expandedDelta) <= 2 && Math.abs(collapsedDelta) <= 2,
  `The summary must stay under the reader: expand=${expandedDelta}, collapse=${collapsedDelta}`,
);
