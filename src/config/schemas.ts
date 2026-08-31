import z from "zod";
import { bigintStringSchema, checkedAddressSchema, hexDataSchema } from "../utils/schemas.js";
import { supportedChains } from "./chains.js";

export const supportedChainsSchema = z.coerce
	.number()
	.pipe(z.union(supportedChains.map((chain) => z.literal(chain.id))));

const jsonStringToRecord = <V extends z.ZodTypeAny>(valueSchema: V) =>
	z.preprocess((val) => (typeof val === "string" ? JSON.parse(val) : val), z.record(z.string(), valueSchema));

export const consensusConfigSchema = z.object({
	address: checkedAddressSchema,
	oracle: checkedAddressSchema.optional(),
});

export const relayingSafeConfigSchema = z.object({
	safe: checkedAddressSchema,
	multiSend: checkedAddressSchema,
});

export const configSchema = z
	.object({
		PRIVATE_KEY: hexDataSchema,
		SAFE_API_KEY: z.string(),
		RPC_URLS: jsonStringToRecord(z.url()),
		CONSENSUS_CONFIGS: jsonStringToRecord(z.array(consensusConfigSchema).nonempty()),
		RELAYING_SAFES: jsonStringToRecord(relayingSafeConfigSchema).default({}),
		CHAIN_IDS: z.preprocess((val) => {
			const str = typeof val === "string" ? val : "11155111";
			return str.split(",").map((s) => s.trim());
		}, z.array(supportedChainsSchema)),
		SAMPLE_RATE: z.coerce.number().default(10),
		// Maximum gas for a single batched execTransaction submitted through a relaying Safe,
		// to stay well clear of the chain's block gas limit. Proposals are packed into as few
		// MultiSend batches as fit under this limit.
		MAX_BATCH_GAS: bigintStringSchema.default(5_000_000n),
	})
	.superRefine((config, ctx) => {
		for (const id of config.CHAIN_IDS) {
			if (config.RPC_URLS[String(id)] === undefined) {
				ctx.addIssue({ code: "custom", message: `RPC_URLS missing entry for chain ${id}` });
			}
			if (config.CONSENSUS_CONFIGS[String(id)] === undefined) {
				ctx.addIssue({
					code: "custom",
					message: `CONSENSUS_CONFIGS missing entry for chain ${id}`,
				});
			}
		}
	});
