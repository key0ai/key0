# Key0 Standalone Service Example

This example demonstrates how to deploy Key0 as a **separate service** that communicates with your backend via HTTP.

> **Tip:** For the simplest standalone deployment, use the Docker image directly — run `docker compose -f docker/docker-compose.yml up` and configure everything via the built-in Setup UI at `http://localhost:3000/setup`. This example is for when you need to customize the server code beyond what env vars provide.

## Architecture

```
┌──────────────────┐         ┌──────────────────┐
│   Key0      │         │   Your Backend   │
│   Service        │         │   Service        │
│                  │         │                  │
│  - Agent Card    │         │  - Business      │
│  - Payment Flow  │────────►│    Logic        │
│  - Token Issue   │  HTTP   │  - Protected     │
│                  │         │    APIs         │
└──────────────────┘         └──────────────────┘
```

## Setup

1. **Copy environment file:**
   ```bash
   cp .env.example .env
   ```

2. **Configure environment variables:**
   - `KEY0_WALLET_ADDRESS`: Your wallet to receive USDC payments
   - `BACKEND_API_URL`: URL of your backend service
   - `INTERNAL_AUTH_SECRET`: Shared secret for service-to-service auth
   - `USE_GAS_WALLET`: Set to `true` to enable gas wallet facilitation mode
   - `GAS_WALLET_PRIVATE_KEY`: Private key for gas wallet (required if USE_GAS_WALLET=true)
   - `PLANS`: JSON array of pricing plans

3. **Install dependencies:**
   ```bash
   bun install
   ```

4. **Start the service:**
   ```bash
   bun run start
   ```

## Facilitation Modes

### Standard Mode (Default)

Uses the Coinbase CDP facilitator for payment settlement. The facilitator handles the on-chain transaction execution.

**Configuration:**
```bash
USE_GAS_WALLET=false  # or omit this variable
```

### Gas Wallet Mode

Uses your own gas wallet to handle payment settlement directly. This mode is self-contained and doesn't require an external facilitator.

**Configuration:**
```bash
USE_GAS_WALLET=true
GAS_WALLET_PRIVATE_KEY=0xYourPrivateKeyHere
```

**Important:**
- The gas wallet must have sufficient ETH for gas fees on the target network
- This mode uses `@x402/evm/exact/facilitator` with `ExactEvmScheme` for settlement
- Supports ERC-6492 signatures for smart wallet deployment
- Monitor your gas wallet balance regularly

## Token Modes

### Native Mode (Default)

Key0 issues its own JWT tokens. Your backend validates them using `@key0/validator`.

**Configuration:**
```bash
TOKEN_MODE=native
```

**Backend Integration:**
```typescript
import { validateKey0Token } from "@key0ai/key0";

app.use("/api", async (req, res, next) => {
  try {
    const payload = await validateKey0Token(
      req.headers.authorization,
      { secret: process.env.KEY0_ACCESS_TOKEN_SECRET }
    );
    req.key0Token = payload;
    next();
  } catch (err) {
    res.status(401).json({ error: err.message });
  }
});
```

### Remote Mode

Your backend issues custom tokens (API keys, session IDs, etc.). Key0 calls your backend to get the token.

**Configuration:**
```bash
TOKEN_MODE=remote
```

**Backend Endpoints Required:**

1. `POST /internal/issue-token` - Issue token
   ```json
   {
     "requestId": "uuid",
     "challengeId": "uuid",
     "resourceId": "photo-1",
     "planId": "basic",
     "txHash": "0x..."
   }
   ```
   Response: `{ "token": "your-api-key", "expiresAt": "2024-...", "tokenType": "Bearer" }`

3. `POST /internal/payment-received` - Notification (optional)
   ```json
   { "type": "AccessGrant", ... }
   ```

## Backend Service Example

See `examples/backend-integration/` for a complete backend service example that works with this standalone service.

## Production Deployment

1. **Use Redis for storage:**
   ```bash
   REDIS_URL=redis://your-redis-host:6379
   ```

2. **Set public URL:**
   ```bash
   KEY0_PUBLIC_URL=https://key0.yourcompany.com
   ```

3. **Use mainnet:**
   ```bash
   KEY0_NETWORK=mainnet
   ```

4. **Secure internal auth:**
   - Use a strong `INTERNAL_AUTH_SECRET`
   - Use HTTPS for `BACKEND_API_URL`
   - Consider using mutual TLS or API keys for additional security
