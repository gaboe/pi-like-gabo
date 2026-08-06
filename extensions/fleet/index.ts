import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { FleetView } from "./fleet-view.ts";
import {
  onFleetState,
  openFleetItem,
  queryFleet,
} from "../../vendor/pi-tools/extensions/shared/fleet-protocol.ts";

export default function fleetNavigation(pi: ExtensionAPI) {
  let fleet: FleetView | undefined;
  let stopState: (() => void) | undefined;

  pi.on("session_start", (_event, ctx) => {
    stopState?.();
    stopState = undefined;
    fleet?.dispose();
    fleet = undefined;
    if (ctx.mode !== "tui") return;
    fleet = new FleetView(ctx.ui, (request) => openFleetItem(pi.events, request));
    stopState = onFleetState(pi.events, (state) => fleet?.setState(state));
    queryFleet(pi.events);
  });

  pi.on("session_shutdown", () => {
    stopState?.();
    stopState = undefined;
    fleet?.dispose();
    fleet = undefined;
  });
}
