import { type Address, concatHex, encodeFunctionData, encodePacked, type Hex, size } from "viem";
import { MULTI_SEND_FUNCTIONS } from "../utils/abis.js";
import type { SafeRelayCall } from "./relay.js";

// Encodes `calls` into MultiSend's packed transaction format: each entry is
// `operation (1 byte) | to (20 bytes) | value (32 bytes) | data length (32 bytes) | data`,
// concatenated back-to-back with no separators.
export function encodeMultiSendTransactions(calls: SafeRelayCall[]): Hex {
	return concatHex(
		calls.map((call) =>
			encodePacked(
				["uint8", "address", "uint256", "uint256", "bytes"],
				[call.operation ?? 0, call.to, call.value, BigInt(size(call.data)), call.data],
			),
		),
	);
}

// Builds the Safe call that atomically runs `calls` via the MultiSend library deployed
// at `multiSendAddress`. The returned call must be executed with `operation: 1`
// (delegatecall) - already set on the result - so that each batched call runs with the
// Safe itself as `msg.sender`, rather than with MultiSend as the caller.
export function encodeMultiSendCall(multiSendAddress: Address, calls: SafeRelayCall[]): SafeRelayCall {
	const data = encodeFunctionData({
		abi: MULTI_SEND_FUNCTIONS,
		functionName: "multiSend",
		args: [encodeMultiSendTransactions(calls)],
	});
	return { to: multiSendAddress, value: 0n, data, operation: 1 };
}
