import { resolve4, resolve6 } from "node:dns/promises";
import { isIP } from "node:net";
import type { NetworkApproval } from "./types.js";

function ipv4Restriction(address: string) {
	const parts = address.split(".").map(Number);
	if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return "invalid address";
	const [a, b] = parts;
	if (a === 0) return "unspecified IPv4";
	if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return "private IPv4";
	if (a === 100 && b >= 64 && b <= 127) return "shared/private IPv4";
	if (a === 127) return "loopback IPv4";
	if (a === 169 && b === 254) return "link-local/metadata IPv4";
	if (a >= 224) return "multicast/reserved IPv4";
	return undefined;
}

function ipRestriction(address: string) {
	if (isIP(address) === 4) return ipv4Restriction(address);
	const normalized = address.toLowerCase().split("%")[0];
	if (normalized === "::" || normalized === "::1") return normalized === "::1" ? "loopback IPv6" : "unspecified IPv6";
	if (normalized.startsWith("fc") || normalized.startsWith("fd")) return "private IPv6";
	if (/^fe[89ab]/.test(normalized)) return "link-local IPv6";
	if (normalized.startsWith("ff")) return "multicast IPv6";
	if (normalized.startsWith("::ffff:")) return ipv4Restriction(normalized.slice(7));
	return undefined;
}

export async function inspectNetworkTarget(raw: string, protocols: readonly string[]): Promise<NetworkApproval> {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new Error("Invalid network URL.");
	}
	if (!protocols.includes(url.protocol)) throw new Error(`URL scheme must be ${protocols.join(" or ")}.`);
	if (url.username || url.password) throw new Error("Credentials in network URLs are not allowed.");
	if (url.hash) throw new Error("URL fragments are not allowed.");
	const hostname = url.hostname.replace(/^\[|\]$/g, "");
	const port = url.port || ({ "ws:": "80", "wss:": "443", "http:": "80", "https:": "443" }[url.protocol]);
	if (!port) throw new Error("URL requires an explicit or standard port.");
	const endpoint = `${url.protocol}//${isIP(hostname) === 6 ? `[${hostname.toLowerCase()}]` : hostname.toLowerCase()}:${port}`;
	const restricted = new Set<string>();
	const resolvedAddresses: string[] = [];
	const literal = ipRestriction(hostname);
	if (literal) restricted.add(literal);
	if (["localhost", "localhost.localdomain", "metadata.google.internal"].includes(hostname.toLowerCase())) restricted.add("local/metadata hostname");
	if (!isIP(hostname)) {
		const addresses = await Promise.allSettled([resolve4(hostname), resolve6(hostname)]);
		const resolved = addresses.flatMap((result) => result.status === "fulfilled" ? result.value : []);
		resolvedAddresses.push(...resolved);
		if (resolved.length === 0) throw new Error(`Could not resolve ${hostname}.`);
		for (const address of resolved) {
			const reason = ipRestriction(address);
			if (reason) restricted.add(`${reason} (${address})`);
		}
	} else {
		resolvedAddresses.push(hostname);
	}
	return { endpoint, hostname, addresses: [...new Set(resolvedAddresses)].sort(), restricted: [...restricted] };
}
