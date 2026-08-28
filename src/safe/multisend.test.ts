import { type Address, encodeFunctionData, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { MULTI_SEND_FUNCTIONS } from "../utils/abis.js";
import { encodeMultiSendCall, encodeMultiSendTransactions } from "./multisend.js";
import type { SafeRelayCall } from "./relay.js";

const MULTI_SEND: Address = "0x4444444444444444444444444444444444444444";
const TARGET_1: Address = "0x1111111111111111111111111111111111111111";
const TARGET_2: Address = "0x2222222222222222222222222222222222222222";

const CALL_1: SafeRelayCall = { to: TARGET_1, value: 1n, data: "0xdead" as Hex };
const CALL_2: SafeRelayCall = { to: TARGET_2, value: 0n, data: "0xbeef01" as Hex };

describe("encodeMultiSendTransactions", () => {
	it("packs each call as operation | to | value | data length | data, concatenated", () => {
		const packed = encodeMultiSendTransactions([CALL_1, CALL_2]);

		const expected =
			"0x" +
			// CALL_1: operation(1 byte) + to(20 bytes) + value(32 bytes) + dataLength(32 bytes) + data
			"00" +
			TARGET_1.slice(2).toLowerCase() +
			`${"0".repeat(63)}1` +
			`${"0".repeat(63)}2` +
			"dead" +
			// CALL_2
			"00" +
			TARGET_2.slice(2).toLowerCase() +
			"0".repeat(64) +
			`${"0".repeat(62)}03` +
			"beef01";
		expect(packed).toBe(expected);
	});

	it("encodes the operation byte for delegatecall entries", () => {
		const packed = encodeMultiSendTransactions([{ ...CALL_1, operation: 1 }]);
		expect(packed.slice(0, 4)).toBe("0x01");
	});

	it("returns empty bytes for an empty call list", () => {
		expect(encodeMultiSendTransactions([])).toBe("0x");
	});
});

describe("encodeMultiSendCall", () => {
	it("wraps the packed calls in a multiSend call targeting multiSendAddress with operation 1", () => {
		const call = encodeMultiSendCall(MULTI_SEND, [CALL_1, CALL_2]);

		expect(call.to).toBe(MULTI_SEND);
		expect(call.value).toBe(0n);
		expect(call.operation).toBe(1);
		expect(call.data).toBe(
			encodeFunctionData({
				abi: MULTI_SEND_FUNCTIONS,
				functionName: "multiSend",
				args: [encodeMultiSendTransactions([CALL_1, CALL_2])],
			}),
		);
	});
});
