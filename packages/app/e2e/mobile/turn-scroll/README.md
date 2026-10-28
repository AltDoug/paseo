# Native turn reading-position diagnostic

Reproduction for [#8057](https://github.com/getpaseo/paseo/issues/8057).
This uses the production turn presentation and native stream strategy with fixed-height
message rows. It isolates viewport behavior; it does not exercise a provider, the full
conversation screen, iOS, or the precise automatic-collapse reading-row report.

Build the Android development client from this checkout. In a disposable checkout,
temporarily replace `packages/app/index.ts` with:

```tsx
import "./src/polyfills/install-early";
import "./src/styles/unistyles";
import { registerRootComponent } from "expo";
import Diagnostic from "./e2e/mobile/turn-scroll/native";
registerRootComponent(Diagnostic);
```

Start Metro from `packages/app` on an available port:

```sh
APP_VARIANT=development npx expo start --lan --port 8097
```

With an Android emulator running, forward that port with `adb reverse tcp:8097 tcp:8097`.
From the repository root, run:

```sh
node packages/app/e2e/mobile/turn-scroll/android.mjs turn-scroll http://127.0.0.1:8097
```

The test expands the middle summary, brings it back into view, collapses it, and
asserts its native window Y stays within two points. Baseline fails with approximately
`expand=-450.3, collapse=450.3`. Measurements use `measureInWindow`, not accessibility
bounds of off-screen rows.

The separate buttons expose the latest turn's running-to-finished projection with a
five-second delay. They measure its summary before and after completion, rather than
claiming to follow a disappearing reading row.

Restore `index.ts`, close the device session, stop Metro, and stop the emulator after use.
This is an intentionally failing diagnostic, not a production fix or a CI unit test.
