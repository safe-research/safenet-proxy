import { Hono } from "hono";
import { cors } from "hono/cors";
import { handleProposal, handleTx } from "./proposals/handler.js";
import { handleQueueBatch } from "./queue/consumer.js";
import type { QueueMessage } from "./queue/types.js";

const app = new Hono<{ Bindings: CloudflareBindings }>();

app.use("/*", cors());

app.post("/tx", async (c) => {
	return handleTx(c);
});

app.post("/propose", async (c) => {
	return handleProposal(c);
});

app.post("/sampled", async (c) => {
	return handleProposal(c, true);
});

export default {
	fetch: app.fetch,
	queue: handleQueueBatch,
} satisfies ExportedHandler<CloudflareBindings, QueueMessage>;
