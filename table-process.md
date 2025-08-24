# Table Processing Workflow in Hyperion Client

This document explains the complete workflow of how tables are read, filtered, and processed in the XPRNetwork Hyperion client.

## 1. Reading Tables from State History Stream

### 1.1 Data Reception

- WebSocket receives binary data from XPRNetwork State History Plugin
- Data contains blocks with deltas (table changes) and traces (action executions)
- Each block can contain multiple `table_delta_v0` entries

### 1.2 Delta Deserialization

```typescript
const deltas = this.deserialize("table_delta[]", response.deltas);
```

- Binary delta data is deserialized using EOSIO serialization
- Each delta has structure: `[deltaType, deltaData]`
- `deltaData` contains `name` (table name) and `rows` (changed data)

## 2. Table Type Classification

The system processes two types of tables:

### 2.1 System Tables (Direct Processing)

- Tables like `resource_usage`, `resource_limits_state`, `global`, etc.
- Mapped directly to `eosio` contract via `getContractForTable()`
- Processed immediately if whitelisted

### 2.2 User Contract Tables (via contract_row)

- All user contract table changes are embedded in `contract_row` deltas
- Requires extraction and deserialization to find actual contract/table names
- Examples: `futureshit.accounts`, `mytoken.stat`, etc.

## 3. Determining if Table Should be Processed

### 3.1 Whitelist Configuration

```typescript
// Contract whitelist
whitelistedContracts = new Set(["futureshit", "eosio"]);

// Table whitelist (contract → tables mapping)
whitelistedTables = new Map([
  ["futureshit", new Set(["accounts"])],
  ["eosio", new Set(["global", "producers"])],
]);
```

### 3.2 Filter Logic

```typescript
shouldProcessTable(contract, table) {
  if (this.whitelistedTables.size === 0) return true; // No filter = process all

  const contractTables = this.whitelistedTables.get(contract);
  if (!contractTables) return false; // Contract not in whitelist

  return contractTables.has(table); // Check if table is whitelisted for contract
}
```

### 3.3 Decision Process

1. **No Whitelist**: Process all tables
2. **Contract Not Whitelisted**: Skip table
3. **Contract Whitelisted, Table Not Listed**: Skip table
4. **Both Contract and Table Whitelisted**: Process table

## 4. Table Processing Workflow

### 4.1 System Table Processing

```mermaid
flowchart TD
    A[Delta Received] --> B{Table Type?}
    B -->|System Table| C[getContractForTable()]
    C --> D[Map to 'eosio' contract]
    D --> E{shouldProcessTable?}
    E -->|Yes| F[Add to processedDeltas]
    E -->|No| G[Skip]
```

### 4.2 User Contract Table Processing

```mermaid
flowchart TD
    A[Delta Received] --> B{Table == 'contract_row'?}
    B -->|Yes| C[extractTablesFromContractRow()]
    C --> D[For each row in delta.rows]
    D --> E[Deserialize row data]
    E --> F[Extract contract.table from data]
    F --> G{shouldProcessTable?}
    G -->|Yes| H[Create table delta object]
    G -->|No| I[Skip row]
    H --> J[Add to extractedTables]
```

### 4.3 Contract Row Extraction Detail

```typescript
// For each row in contract_row delta
for (const row of deltaData.rows) {
  if (row.present && row.data) {
    // Convert object to Uint8Array
    const dataArray = new Uint8Array(Object.keys(row.data).length);
    Object.keys(row.data).forEach(key => {
      dataArray[parseInt(key)] = row.data[key];
    });

    // Deserialize using ship ABI
    const contractRowData = this.deserialize("contract_row", dataArray);

    if (contractRowData && contractRowData.table) {
      const tableName = contractRowData.table;
      const contractName = contractRowData.code;

      // Apply whitelist filter
      if (this.shouldProcessTable(contractName, tableName)) {
        // Create table delta for microservices
        extractedTables.push({
          type: "table_delta_v0",
          contract: contractName,
          table: tableName,
          data: contractRowData,
          processed: true,
          filtered: true,
          extracted_from: "contract_row",
        });
      }
    }
  }
}
```

## 5. Microservice Emission

### 5.1 Context Creation

Once a table passes filtering, a context object is created:

```typescript
{
  $block: blockData,      // Block information
  $delta: deltaObject,    // Table delta data
  $table: tableName       // Table name for easy access
}
```

### 5.2 Microservice Chain

```typescript
// Each microservice receives the context
const microService = ({$block, $delta, $table}) => {
  if ($table === "accounts") {
    console.log(`Accounts table changed in contract: ${$delta.contract}`);
    // Process the table change
  }
  return {$block, $delta, $table}; // Pass to next microservice
};
```

## 6. Debugging and Monitoring

### 6.1 Log Levels

- `[SOCKET]`: Socket-level processing events
- `[DEBUG]`: Detailed debugging information
- `[LOGGER]`: Microservice-level logging

### 6.2 Key Debug Points

1. **Delta Count**: `Block X has Y deltas`
2. **Contract Row Processing**: `Processing contract_row with X rows`
3. **Table Discovery**: `Found contract row: contract.table`
4. **Whitelist Results**: `Found whitelisted table: contract.table`
5. **Final Count**: `Processed X deltas after filtering`

## 7. Common Issues and Solutions

### 7.1 No Tables Being Processed

- **Cause**: Whitelist too restrictive or contract names incorrect
- **Debug**: Check `Found contract row:` logs to see actual contract.table combinations
- **Solution**: Adjust whitelist to match actual contract names

### 7.2 System Tables Not Processing

- **Cause**: System table not in `getContractForTable()` mapping
- **Solution**: Add table name to `systemTables` Set

### 7.3 Contract Row Deserialization Failures

- **Cause**: Binary data conversion issues
- **Debug**: Check for exceptions in `extractTablesFromContractRow()`
- **Solution**: Verify State History ABI compatibility

## 8. Performance Considerations

### 8.1 Filtering Early

- System applies whitelist filtering before heavy deserialization
- Contract row extraction only occurs for `contract_row` deltas
- Skip processing immediately if contract/table not whitelisted

### 8.2 Memory Management

- Process deltas in streaming fashion
- Don't accumulate large amounts of table data
- Emit to microservices immediately after filtering

## 9. Example Flow

### Input: `futureshit` contract `accounts` table change

1. **Reception**: Block contains `contract_row` delta
2. **Detection**: `table === "contract_row"` → extract tables
3. **Deserialization**: Row data reveals `futureshit.accounts`
4. **Filtering**: Check if `futureshit.accounts` is whitelisted
5. **Processing**: Create delta object with contract/table info
6. **Emission**: Send to microservices as `{$block, $delta, $table: 'accounts'}`
7. **Microservice**: Logger microservice logs the table change
