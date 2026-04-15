import type { Hex } from "viem";
import { safeTransactionWithAccount } from "./schemas.js";
import type { SafeTransactionWithDomain } from "./types.js";

const SHORT_NAMES: Record<string, string> = {
	"1": "eth",
	"10": "oeth",
	"56": "bnb",
	"100": "gno",
	"480": "wc",
	"8453": "base",
	"42161": "arb1",
};

export const transactionDetails = async (
	apiKey: string,
	chainId: bigint,
	safeTxHash: Hex,
): Promise<SafeTransactionWithDomain | null> => {
	const shortName = SHORT_NAMES[chainId.toString()];
	if (shortName === undefined) {
		console.error(`Unknown chain for eip155:${chainId}:${safeTxHash}`);
		return null;
	}
	const response = await fetch(
		`https://api.safe.global/tx-service/${shortName}/api/v2/multisig-transactions/${safeTxHash}/`,
		{
			headers: {
				Authorization: `Bearer ${apiKey}`,
			},
		},
	);
	if (!response.ok) {
		console.error(
			`Could not fetch transaction defails for eip155:${chainId}:${safeTxHash} (status ${response.status})`,
		);
		return null;
	}
	const parsed = safeTransactionWithAccount.safeParse(await response.json());
	if (!parsed.success) {
		console.error(`Could not parse transaction defails for eip155:${chainId}:${safeTxHash} (${parsed.error.message})`);
		return null;
	}
	return {
		chainId,
		...parsed.data,
	};
};
