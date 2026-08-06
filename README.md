## Safenet Proxy

### Development setup

- Install dependencies
```sh
npm install
```

### Cloudflare Proxy Deployment

The following secrets must be set before deployment. This can be done via the Cloudflare dashboard or the wrangler CLI:

```sh
# Hex-encoded private key used to sign transactions
echo "0xabc..." | npm exec -- wrangler secret put PRIVATE_KEY

# JSON object mapping chain ID → RPC URL
echo '{"11155111":"https://sepolia.infura.io/v3/...","100":"https://rpc.gnosischain.com"}' \
  | npm exec -- wrangler secret put RPC_URLS

# JSON object mapping chain ID → list of consensus contract addresses.
# Each safe transaction is proposed to all addresses in the list via a
# single multicall3 transaction.
echo '{"11155111":["0xAbc..."],"100":["0xDef...","0x123..."]}' \
  | npm exec -- wrangler secret put CONSENSUS_ADDRESSES
```

[For generating/synchronizing types based on your Worker configuration run](https://developers.cloudflare.com/workers/wrangler/commands/#types):

```sh
npm run cf-typegen
```

Pass the `CloudflareBindings` as generics when instantiation `Hono`:

```ts
// src/index.ts
const app = new Hono<{ Bindings: CloudflareBindings }>()
```

Once everything is setup the service can be deployed:

```sh
npm run deploy
```

You can test your service by triggering a request against it:

```sh
curl http://localhost:8787/propose \
    -H "Accept: application/json" \
    -H "content-type: application/json" \
    -d '{"type":"EXECUTED_MULTISIG_TRANSACTION","chainId":"1","address":"0x1280C3d641ad0517918e0E4C41F4AD25f6b39144","safeTxHash":"0x20e178f2ce590c235d30a6e99a78e799053f36bafe2d2022a642be03cb89058c"}'
```

## Planning Epics

When developing larger epics spanning over multiple PRs with an agent (for example a complex feature or big refactor), generate a plan to help guide the agent by outlining the separate phases in the development. It is recommended to use the `/plan-epic` feature from <https://github.com/safe-research/agents> for this.
