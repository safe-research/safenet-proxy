import type { Context } from "hono";
import { type Address, isAddressEqual } from "viem";
import { enabledSafes } from "../config/safes.js";
import { configSchema } from "../config/schemas.js";
import type { Config } from "../config/types.js";
import type { QueueMessage } from "../queue/types.js";
import { safeTransactionWithDomain, type TransactionEvent, transactionEventSchema } from "../safe/schemas.js";
import { transactionDetails } from "../safe/service.js";
import { handleError } from "../utils/errors.js";

export const handleProposal = async (
	c: Context<{
		Bindings: CloudflareBindings;
	}>,
	sampled = false,
) => {
	try {
		const config = configSchema.parse(c.env);
		if (sampled && config.SAMPLE_RATE < Math.random() * 100) {
			return c.body(null, 202);
		}

		const request = transactionEventSchema.safeParse(await c.req.json());
		if (
			!request.success ||
			!isWebhookTypeEnabled(config, request.data.type) ||
			(sampled && !isSafeEnabled(request.data.address))
		) {
			return c.body(null, 202);
		}

		// Fetch transaction details synchronously
		c.executionCtx.waitUntil(processProposalAsync(config, c.env.PROPOSAL_QUEUE, request.data));

		return c.body(null, 202);
	} catch (e: unknown) {
		const { response, code } = handleError(e);
		return c.json(response, code);
	}
};

export const handleTx = async (
	c: Context<{
		Bindings: CloudflareBindings;
	}>,
	sampled = false,
) => {
	try {
		const config = configSchema.parse(c.env);
		if (sampled && config.SAMPLE_RATE >= Math.random() * 100) {
			return c.body(null, 202);
		}

		const request = safeTransactionWithDomain.safeParse(await c.req.json());
		if (!request.success || (sampled && !isSafeEnabled(request.data.safe))) {
			return c.body(null, 202);
		}

		const message: QueueMessage = {
			type: "TRANSACTION",
			timestamp: Date.now(),
			data: request.data,
		};

		await c.env.PROPOSAL_QUEUE.send(message, { contentType: "v8" });

		return c.body(null, 202);
	} catch (e: unknown) {
		const { response, code } = handleError(e);
		return c.json(response, code);
	}
};

function isWebhookTypeEnabled(config: Config, type: TransactionEvent["type"]): boolean {
	return config.WEBHOOK_TYPE === type;
}

function isSafeEnabled(safe: Address): boolean {
	return enabledSafes.length === 0 || enabledSafes.some((enabledSafe) => isAddressEqual(enabledSafe, safe));
}

async function processProposalAsync(
	config: Config,
	queue: Queue<QueueMessage>,
	event: TransactionEvent,
): Promise<void> {
	try {
		const details = await transactionDetails(config.SAFE_API_KEY, event.chainId, event.safeTxHash);
		if (details === null) {
			return;
		}

		// Queue the transaction
		const message: QueueMessage = {
			type: "TRANSACTION",
			timestamp: Date.now(),
			data: details,
		};

		await queue.send(message, { contentType: "v8" });
	} catch (error) {
		console.error("Error processing proposal:", error);
	}
}
