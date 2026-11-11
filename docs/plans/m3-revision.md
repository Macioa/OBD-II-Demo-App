# M3 Revision Plan

Follow-up to M3 (commit `ebc29b2`), based on the driving test (`docs/test-plans/m3-map.md`, commit `87110ce`).

## R1. Map recenters near the edge

**Now:** the map fits the whole trip on every update. A manual pan turns following off until you tap **⌖ Fit**.

**Change:**
- **Default:** keep the current zoom and pan the map to recenter on the current position when it gets close to the edge. Use an inner margin of about 15 % of the map's width and height. The map stops jumping on every GPS update.
- **Manual drag or pinch:** pause recentering for **10 s** after the last touch, then resume. The timer restarts with each new touch. Use `onRegionDidChange` (`userInteraction: true`) to detect touches.
- **⌖ Fit** stays: one tap fits the whole trip, then the map goes back to edge-recentering.
- **🔒 Lock toggle:** a map button that turns recentering off completely while it's on. The map stays exactly where you leave it, with no edge-recentering and no 10 s resume. The button looks clearly "on" while locked. Turning it off goes back to normal recentering. Tapping **⌖ Fit** while locked fits the trip once and leaves the lock on.
- The current position comes from GPS. When GPS-denied is on, use the estimate instead.

**Files:** `src/screens/TrackMap.tsx`. Put the "is the point near the edge" check in `src/geo/overlay.ts` so it can be unit tested.

**Done when:**
- Driving off-screen makes the map recenter, and the zoom doesn't change.
- After a pan, the map holds still for 10 s, then recenters.
- With 🔒 on, the map never moves by itself, even when the position goes off-screen. Turning it off brings recentering back.
- Unit test for the edge check.

## R2. OBD connection: visible state that keeps reading

**Now** (`src/screens/ObdScreen.tsx`):
- A single **Connect & Read** button runs one long `run()` function: connect, a full probe (modes 09/03/02/06), then a live loop.
- Everything that tracks the connection lives inside that component. The only signs it's running are "Reading..." and a red "Stop & save" button.
- **Bug from the test:** after connecting, switching tabs and coming back, the screen showed **Connect & Read** again. That means `run()` had already ended. The screen stays loaded across tab switches (see `__tests__/tabs.test.tsx`), so the likely cause is a BLE disconnect or a thrown error ending the loop. The screen then quietly went back to idle.

**Change:**
1. **Find the cause first.** Read the saved OBD debug log from that drive (`cache/debug/obd-debug-*.txt` on the phone). Look for `Disconnected from …`, `Error:` or `LIVE LOOP END`.
2. **Move the session out of the screen** into `src/obd/session.ts`: a single shared session that holds the connection, the poll loop and a `status` value. The screen subscribes to it. Switching tabs can't affect it, and Track/recording can read OBD speed from it later (needed for M5).
3. **Clear states and button:**

   | State | Button | Colour | Extra |
   |---|---|---|---|
   | idle | Connect & Read | default | — |
   | connecting / probing | Connecting… (step name) | amber | Cancel |
   | reading (live loop) | ● Reading — cycle N | **green** | **■ Stop** button |
   | stopped by user | Connect & Read | default | "Stopped after N cycles" |
   | link lost / error | Reconnect | red | the reason shown on screen |

4. **Keep reading until Stop:** the loop ends only when you tap **■ Stop**. If the BLE link drops, try to reconnect automatically (for example 3 tries with backoff), show "Reconnecting…", and only switch to the red error state if every try fails.
5. **Status on every tab:** while reading, show a small "OBD ● 42 km/h" badge in the tab bar or on the Track header, so you can see it's connected without opening the Vehicle tab.
6. Optional: let the full probe be skipped on later connects (cache the list of supported PIDs) so it reaches the live loop faster.

**Files:** new `src/obd/session.ts`; `src/screens/ObdScreen.tsx` becomes display only; `App.tsx` gets the badge.

**Done when:**
- Connect, switch tabs several times, come back: it still shows green **Reading**, and the cycle count has kept rising.
- Reading continues until **■ Stop** is tapped.
- Pulling the dongle shows "Reconnecting…", then a red state with the reason.
- A Jest test with a fake BLE manager covers: still reading after tab switches, stops only on Stop, and a disconnect leads to the reconnect and error states.

## Test plan

After implementing, add a driving test plan at `docs/test-plans/m3-revision.md`. It covers R1 (recentering, the 10 s pause after a pan) and R2 (OBD state and colours, tab switches while reading, Stop, unplugging the dongle).
