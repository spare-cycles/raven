/**
 * Fallback wake-up for omp sessions that run with `mcp.notifications: false` (so omp neither subscribes to nor
 * injects resource updates): turns `raven mcp`'s `notifications/raven/delivery` into an aside, which starts a turn
 * when the session is idle. Load it with `omp -e <path>/raven-wake.ts`. With native injection on, leave it out, or
 * every delivery wakes the session twice.
 */

type Delivery = { readonly uri?: unknown; readonly from?: unknown; readonly subject?: unknown };

type McpNotification = {
  readonly server: string;
  readonly method: string;
  readonly params?: Delivery;
};

type ExtensionApi = {
  on: (event: "mcp_notification", handler: (event: McpNotification) => void) => void;
  sendMessage: (
    message: { customType: string; content: string; display: boolean; attribution: "agent" },
    options: { deliverAs: "aside" },
  ) => void;
};

/** `DELIVERY` in `src/mcp.ts`; repeated here so the extension loads without raven's dependencies. */
const DELIVERY = "notifications/raven/delivery";

export default function ravenWake(pi: ExtensionApi): void {
  pi.on("mcp_notification", (event) => {
    if (event.method !== DELIVERY) {
      return;
    }
    const { uri, from, subject } = event.params ?? {};
    const what = typeof subject === "string" ? `"${subject}" from ${String(from)}` : "waiting";
    pi.sendMessage(
      {
        customType: "raven-wake",
        content: `New raven mail ${what} (${String(uri)}). Read it with the fetch_inbox tool.`,
        display: true,
        attribution: "agent",
      },
      { deliverAs: "aside" },
    );
  });
}
