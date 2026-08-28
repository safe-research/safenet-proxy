import { type Address, encodeFunctionData, encodePacked, type Hex, zeroAddress } from "viem";
import { SAFE_RELAY_FUNCTIONS } from "../utils/abis.js";

// 0 = `CALL`, 1 = `DELEGATECALL` (used to invoke the MultiSend library, see multisend.ts).
export type SafeOperation = 0 | 1;

export type SafeRelayCall = {
	to: Address;
	value: bigint;
	data: Hex;
	operation?: SafeOperation;
};

// Builds a Safe "pre-validated signature" for `owner`: `r` encodes the owner
// address, `s` is unused, and `v = 1`. Safe's `checkNSignatures` treats `v == 1`
// as pre-approved and, for that case, skips hash/ECDSA verification entirely -
// it only requires `msg.sender == owner` (see
// https://docs.safefoundation.org/smart-account/signatures#pre-validated-signatures).
// That holds here since `owner` is the account submitting `execTransaction`, so no
// real signing is needed. Because the check never looks at the SafeTx hash, this
// signature is also independent of the Safe's nonce - it doesn't need to be fetched
// beforehand.
export function preValidatedSignature(owner: Address): Hex {
	return encodePacked(["uint256", "uint256", "uint8"], [BigInt(owner), 0n, 1]);
}

// A relayed call defaults to a plain `CALL` (operation = 0) with no Safe-native
// gas refund, since the operator EOA already pays for gas directly.
// Encodes calldata for `Safe.execTransaction`, wrapping `call` with a
// pre-validated signature for `owner`. Only valid when `owner` is both an owner
// of a threshold-1 Safe and the `msg.sender` that submits the transaction.
export function encodeSafeRelayTransaction(owner: Address, call: SafeRelayCall): Hex {
	return encodeFunctionData({
		abi: SAFE_RELAY_FUNCTIONS,
		functionName: "execTransaction",
		args: [
			call.to,
			call.value,
			call.data,
			call.operation ?? 0,
			0n,
			0n,
			0n,
			zeroAddress,
			zeroAddress,
			preValidatedSignature(owner),
		],
	});
}
