import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { runSecurityUpdates, safeMessage } from "./security/gate.ts";
import { modelReviewer, resolveReviewModel } from "./security/review.ts";
import { readAutoUpdateSettings, writeReviewModel } from "./security/settings.ts";

const STATUS_KEY = "pi-auto-update";
const truthy = (value: string | undefined) => /^(1|true|yes)$/i.test(value ?? "");
const disabled = () => /^(0|false|no)$/i.test(process.env.PI_AUTO_UPDATE ?? "");

export default function (pi: ExtensionAPI) {
	let inFlight: Promise<void> | undefined;
	let started = false;
	let controller: AbortController | undefined;

	async function runUpdates(ctx: ExtensionContext): Promise<void> {
		if (inFlight) return inFlight;
		controller = new AbortController();
		const signal = controller.signal;
		inFlight = (async () => {
			try {
				if (truthy(process.env.PI_OFFLINE)) throw new Error("offline mode");
				const { report, reportPath } = await runSecurityUpdates({
					agentDir: getAgentDir(), signal,
					reviewer: modelReviewer(ctx, (data) => pi.appendEntry("auto-update-security-usage", data)),
					status: (message) => ctx.ui.setStatus(STATUS_KEY, message),
				});
				const blocked = report.results.filter((item) => item.status === "blocked").length;
				const updated = report.results.filter((item) => item.status === "updated").length;
				pi.appendEntry("auto-update-security-report", { reportPath, report });
				if (ctx.hasUI) ctx.ui.notify(
					`Pi security update completed: ${updated} updated, ${blocked} blocked\n${report.notices.map(safeMessage).join("\n")}\nReport: ${reportPath}${updated ? "\nRestart Pi to load reviewed updates." : ""}`,
					blocked ? "warning" : "info",
				);
			} catch (error) {
				if (ctx.hasUI) ctx.ui.notify("Pi security update blocked: " + safeMessage(error), "warning");
			} finally {
				ctx.ui.setStatus(STATUS_KEY, undefined);
			}
		})().finally(() => { inFlight = undefined; controller = undefined; });
		return inFlight;
	}

	pi.on("session_start", async (event, ctx) => {
		if (event.reason !== "startup" || started) return;
		started = true;
		const reason = truthy(process.env.PI_OFFLINE) ? "offline mode" : disabled() ? "PI_AUTO_UPDATE is disabled" : undefined;
		if (reason) {
			if (ctx.hasUI) ctx.ui.notify("Pi auto-update skipped: " + reason, "info");
			return;
		}
		await runUpdates(ctx);
	});
	pi.on("session_shutdown", async () => { controller?.abort(); await inFlight; });
	pi.registerCommand("auto-update-model", {
		description: "Show or set the independent review model: provider/model or current",
		handler: async (args, ctx) => {
			try {
				const ref = args.trim();
				if (ref) {
					if (inFlight) throw new Error("Wait for the current security update to finish before changing its model");
					if (ref !== "current") resolveReviewModel(ctx, ref); // Never persist an unknown/unauthenticated selection.
					await writeReviewModel(getAgentDir(), ref);
				}
				const settings = await readAutoUpdateSettings(getAgentDir());
				const selected = settings.reviewModel ?? (ctx.model ? `current (${ctx.model.provider}/${ctx.model.id})` : "current (no session model selected)");
				if (ctx.hasUI) ctx.ui.notify(`Security review model: ${selected}\nPersonal setting: autoUpdate.reviewModel\nUse /auto-update-model provider/model or /auto-update-model current`, "info");
			} catch (error) {
				if (ctx.hasUI) ctx.ui.notify("Security review model unchanged: " + safeMessage(error), "warning");
			}
		},
	});
	pi.registerCommand("auto-update-now", {
		description: "Stage, scan and independently review supported package changes; install only approved bytes",
		handler: async (_args, ctx) => { await runUpdates(ctx); },
	});
}
