import { z } from "zod";
import { safeTransactionWithDomain } from "../safe/schemas.js";

export const queueMessageSchema = z.object({
	type: z.literal("TRANSACTION"),
	timestamp: z.number(),
	// Whether the transaction was received via a sampled endpoint.
	sampled: z.boolean().default(false),
	data: safeTransactionWithDomain,
});
