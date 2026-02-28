# AgentGate Standalone Service Example

This example demonstrates how to deploy AgentGate as a **separate service** that communicates with your backend via HTTP.

## Architecture

```
┌──────────────────┐         ┌──────────────────┐
│   AgentGate      │         │   Your Backend   │
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
   - `AGENTGATE_WALLET_ADDRESS`: Your wallet to receive USDC payments
   - `BACKEND_API_URL`: URL of your backend service
   - `INTERNAL_AUTH_SECRET`: Shared secret for service-to-service auth
   - `PRODUCTS`: JSON array of product tiers

3. **Install dependencies:**
   ```bash
   bun install
   ```

4. **Start the service:**
   ```bash
   bun run start
   ```

## Token Modes

### Native Mode (Default)

AgentGate issues its own JWT tokens. Your backend validates them using `@agentgate/validator`.

**Configuration:**
```bash
TOKEN_MODE=native
```

**Backend Integration:**
```typescript
import { validateAgentGateToken } from "@agentgate/sdk";

app.use("/api", async (req, res, next) => {
  try {
    const payload = await validateAgentGateToken(
      req.headers.authorization,
      { secret: process.env.AGENTGATE_ACCESS_TOKEN_SECRET }
    );
    req.agentGateToken = payload;
    next();
  } catch (err) {
    res.status(401).json({ error: err.message });
  }
});
```

### Remote Mode

Your backend issues custom tokens (API keys, session IDs, etc.). AgentGate calls your backend to get the token.

**Configuration:**
```bash
TOKEN_MODE=remote
```

**Backend Endpoints Required:**

1. `POST /internal/verify-resource` - Verify resource exists
   ```json
   { "resourceId": "photo-1", "tierId": "basic" }
   ```
   Response: `{ "valid": true }`

2. `POST /internal/issue-token` - Issue token
   ```json
   {
     "requestId": "uuid",
     "challengeId": "uuid",
     "resourceId": "photo-1",
     "tierId": "basic",
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
   AGENTGATE_PUBLIC_URL=https://agentgate.yourcompany.com
   ```

3. **Use mainnet:**
   ```bash
   AGENTGATE_NETWORK=mainnet
   ```

4. **Secure internal auth:**
   - Use a strong `INTERNAL_AUTH_SECRET`
   - Use HTTPS for `BACKEND_API_URL`
   - Consider using mutual TLS or API keys for additional security
