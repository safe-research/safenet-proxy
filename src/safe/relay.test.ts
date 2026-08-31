import { type Address, encodeFunctionData, type Hex, zeroAddress } from "viem";
import { describe, expect, it } from "vitest";
import { SAFE_RELAY_FUNCTIONS } from "../utils/abis.js";
import { encodeSafeRelayTransaction, preValidatedSignature } from "./relay.js";

const OWNER: Address = "0x3333333333333333333333333333333333333333";
const TARGET: Address = "0x2222222222222222222222222222222222222222";

const CALL = {
	to: TARGET,
	value: 0n,
	data: "0xdeadbeef" as Hex,
};

describe("preValidatedSignature", () => {
	it("packs the owner address into r, zeroes s, and sets v to 1", () => {
		const signature = preValidatedSignature(OWNER);

		// 32-byte r (owner, left-padded) + 32-byte s (zero) + 1-byte v (0x01)
		const expected = `0x000000000000000000000000${OWNER.slice(2).toLowerCase()}${"0".repeat(64)}01`;
		expect(signature).toBe(expected);
	});

	it("does not depend on any transaction data", () => {
		expect(preValidatedSignature(OWNER)).toBe(preValidatedSignature(OWNER));
	});
});

describe("encodeSafeRelayTransaction", () => {
	it("encodes execTransaction calldata wrapping the call with a pre-validated signature for the owner", () => {
		const data = encodeSafeRelayTransaction(OWNER, CALL);

		const expected = encodeFunctionData({
			abi: SAFE_RELAY_FUNCTIONS,
			functionName: "execTransaction",
			args: [TARGET, 0n, "0xdeadbeef", 0, 0n, 0n, 0n, zeroAddress, zeroAddress, preValidatedSignature(OWNER)],
		});
		expect(data).toBe(expected);
	});
});
