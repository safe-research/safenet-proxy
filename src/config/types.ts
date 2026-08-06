import type z from "zod";
import type { configSchema, consensusConfigSchema } from "./schemas.js";

export type Config = z.infer<typeof configSchema>;
export type ConsensusConfig = z.infer<typeof consensusConfigSchema>;
