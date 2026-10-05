import type { InboundSource } from "./state.ts";
import type { RuntimeConfig } from "./config.ts";
import type { TenantConfig } from "./tenants.ts";

/** A bare "stop" interrupts the turn like /stop, so nobody has to know commands. */
export function isStopRequest(text: string): boolean {
	return /^\/stop(?:\s|$)|^stop[.!]*$/i.test(text.trim());
}

export type ParentMessage =
	| { type: "init"; tenant: TenantConfig; app: RuntimeConfig; pluginsDisabled: boolean }
	| { type: "wake" }
	| { type: "interrupt" }
	| { type: "stop" };

export type TenantMessage =
	| { type: "ready" }
	| { type: "changed" }
	| { type: "activity"; active: boolean; source: InboundSource }
	| { type: "error"; message: string };
