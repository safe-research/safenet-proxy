import z from "zod";
import { checkedAddressSchema, hexDataSchema } from "../utils/schemas.js";
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

export const configSchema = z
	.object({
		PRIVATE_KEY: hexDataSchema,
		SAFE_API_KEY: z.string(),
		RPC_URLS: jsonStringToRecord(z.url()),
		CONSENSUS_CONFIGS: jsonStringToRecord(z.array(consensusConfigSchema).nonempty()),
		CHAIN_IDS: z.preprocess((val) => {
			const str = typeof val === "string" ? val : "11155111";
			return str.split(",").map((s) => s.trim());
		}, z.array(supportedChainsSchema)),
		SAMPLE_RATE: z.coerce.number().default(10),
	})
	.superRefine((config, ctx) => {
		for (const id of config.CHAIN_IDS) {
			if (config.RPC_URLS[String(id)] === undefined) {
				ctx.addIssue({ code: "custom", message: `RPC_URLS missing entry for chain ${id}` });
			}
			const consensusConfigs = config.CONSENSUS_CONFIGS[String(id)];
			if (consensusConfigs === undefined) {
				ctx.addIssue({
					code: "custom",
					message: `CONSENSUS_CONFIGS missing entry for chain ${id}`,
				});
			} else if (consensusConfigs.length > 1) {
				const chain = supportedChains.find((c) => c.id === id);
				if (!chain?.contracts?.multicall3?.address) {
					ctx.addIssue({
						code: "custom",
						message: `Chain ${id} has multiple CONSENSUS_CONFIGS but does not support multicall3`,
					});
				}
			}
		}
	});
