import { join } from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { TELEMETRY_CHANNEL } from "./protocol.js";
import { TelemetryWriter } from "./writer.js";

export default function telemetry(pi: ExtensionAPI) {
	const writer = new TelemetryWriter(join(getAgentDir(), "telemetry"));
	const unsubscribe = pi.events.on(TELEMETRY_CHANNEL, (event) => {
		void writer.write(event);
	});
	pi.on("session_shutdown", async () => {
		unsubscribe();
		await writer.close();
	});
}
