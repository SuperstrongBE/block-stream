# XPRNetwork Block Stream Client

A powerful, type-safe TypeScript client for streaming real-time blockchain data from XPRNetwork (and other EOSIO chains) using the State History Plugin. Features microservice architecture, ABI decoding, advanced filtering, and structured logging.

## 🚀 Features

- **Real-time block streaming** from EOSIO State History Plugin
- **ABI-powered decoding** - Binary data automatically converted to readable JSON
- **Microservice architecture** - Chain processing functions with `({$block, $delta, $action, $table, $logger}) => {...}`
- **Advanced filtering** - Contract, table, and action whitelisting with wildcard support
- **Structured logging** - Winston logger with custom levels (`socket`, `micro`) and file output
- **Full TypeScript support** - Complete type safety with proper EOSIO types
- **Production ready** - Error handling, reconnection logic, and performance optimized

## 📦 Installation

```bash
bun install
# or
npm install
```

## 🎯 Quick Start

### Basic Usage

```typescript
import {BlockStreamClient} from "./index";

const client = new BlockStreamClient({
  socketAddress: "ws://testnet.rockerone.io:8080",
  contracts: {
    "eosio.token": {
      tables: ["accounts", "stat"],
      actions: ["transfer", "issue"],
    },
  },
  enableDebug: true,
  logFile: "blockchain.log",
});

// Add microservice for processing
client.pipe(({$block, $delta, $action, $table, $logger}) => {
  if ($action) {
    $logger.info("Action received", {
      contract: $action.account,
      action: $action.name,
      block: $block.block_number,
    });
  }

  if ($delta) {
    $logger.info("Table updated", {
      contract: $delta.contract,
      table: $table,
      block: $block.block_number,
    });
  }

  return {$block, $delta, $action, $table, $logger};
});

client.start();
```

## ⚙️ Configuration

### Enhanced Contract Configuration

```typescript
const client = new BlockStreamClient({
  socketAddress: "ws://your-node:8080",
  contracts: {
    // Specific tables and actions
    eosio: {
      tables: ["voters", "producers"],
      actions: ["voteproducer", "regproducer"],
    },

    // All tables, specific actions
    "eosio.token": {
      tables: ["*"], // Wildcard = all tables
      actions: ["transfer", "issue"],
    },

    // All tables, all actions
    mycontract: {
      tables: ["*"],
      // No actions = all actions allowed
    },

    // Specific tables, all actions
    anothercontract: {
      tables: ["accounts", "balances"],
      // No actions = all actions allowed
    },
  },
  enableDebug: true,
  logFile: "stream.log",
  logLevel: "info", // error | warn | info | socket | micro | debug | verbose
});
```

### Legacy Format (Deprecated)

```typescript
// Still supported but deprecated
const client = new BlockStreamClient({
  socketAddress: "ws://your-node:8080",
  tables: {
    "eosio.token": ["accounts"],
  },
});
```

## 🔧 Microservice Architecture

Chain multiple processing functions together:

```typescript
// Logger microservice
const logger = ({$block, $delta, $action, $table, $logger}) => {
  if ($action) {
    $logger.micro("Processing action", {
      contract: $action.account,
      action: $action.name,
    });
  }
  return {$block, $delta, $action, $table, $logger};
};

// Filter microservice
const transferFilter = ({$block, $delta, $action, $table, $logger}) => {
  if ($action && $action.name === "transfer") {
    $logger.micro("Transfer detected", {
      from: $action.data.from,
      to: $action.data.to,
      amount: $action.data.quantity,
    });
  }
  return {$block, $delta, $action, $table, $logger};
};

// Database saver microservice
const dbSaver = ({$block, $delta, $action, $table, $logger}) => {
  if ($delta && $table === "accounts") {
    // Save to database
    $logger.micro("Saving account data", {
      contract: $delta.contract,
      table: $table,
    });
  }
  return {$block, $delta, $action, $table, $logger};
};

// Chain them together
client.pipe(logger).pipe(transferFilter).pipe(dbSaver).start();
```

## 📊 Logging System

### Custom Log Levels

- **`error`** - Critical errors only
- **`warn`** - Warnings and above
- **`info`** - General information and above
- **`socket`** - WebSocket/protocol debugging
- **`micro`** - Microservice-specific debugging
- **`debug`** - General debugging
- **`verbose`** - Everything including detailed JSON structures

### Usage Examples

```typescript
// Production - minimal logging
logLevel: "info", enableDebug: false

// Debug microservices only
logLevel: "micro", enableDebug: true

// Debug socket layer only
logLevel: "socket", enableDebug: true

// Full debug mode
logLevel: "verbose", enableDebug: true
```

## 🎯 Use Cases

### DeFi Monitoring

```typescript
contracts: {
  "eosio.token": {
    tables: ["accounts"],
    actions: ["transfer"]
  }
}
```

### Smart Contract Analytics

```typescript
contracts: {
  "mycontract": {
    tables: ["*"],  // All table changes
    actions: ["*"] // All actions (if implemented)
  }
}
```

## 🔍 Data Structure

### Block Context

```typescript
{
  $block: {
    block_number: number,
    block_id: string,
    timestamp: string,
    filtering: { contracts, tables, enabled }
  },
  $delta?: {
    type: "table_delta_v0",
    contract: string,
    table: string,
    data: { /* decoded table row data */ }
  },
  $action?: {
    account: string,
    name: string,
    data: { /* decoded action data */ },
    authorization: [...]
  },
  $table?: string,  // Quick table name access
  $logger: CustomLogger
}
```

## 🛠️ Development

```bash
# Install dependencies
bun install

# Run with development logging
bun run index.ts

# Type checking
npx tsc --noEmit --skipLibCheck index.ts

# Build
bun build index.ts --target node --outdir dist
```

## 🌐 Network Support

- **XPRNetwork Mainnet**: `wss://mainnet.rockerone.io:8080`
- **XPRNetwork Testnet**: `ws://testnet.rockerone.io:8080`

## 📝 Requirements

- **Bun** or **Node.js** 18+
- **TypeScript** 5+
- **State History Plugin** enabled on target blockchain node

## 🤝 Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## 📄 License

MIT License - see LICENSE file for details

## 🔗 Links

- [XPRNetwork](https://xprnetwork.org/)
- [EOSIO State History Plugin](https://developers.eos.io/manuals/eos/latest/nodeos/plugins/state_history_plugin/)
- [TypeScript Documentation](https://www.typescriptlang.org/)
