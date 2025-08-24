// noinspection JSUnusedGlobalSymbols,JSUnusedGlobalSymbols,JSUnusedGlobalSymbols,JSCheckFunctionSignatures,JSCheckFunctionSignatures,JSUnresolvedVariable,JSUnresolvedVariable

const {Serialize} = require("eosjs");
const WebSocket = require("ws");
const {
  SerialBuffer,
  SerializerState,
  getTypesFromAbi,
  createInitialTypes,
} = require("eosjs/dist/eosjs-serialize");
const {JsonRpc} = require("eosjs");
const fetch = require("node-fetch");
import {Subject} from "rxjs";

const txEnc = new TextEncoder();
const txDec = new TextDecoder();

const WS_SERVER = "ws://testnet.rockerone.io:8080";
const RPC_ENDPOINT = "https://testnet.rockerone.io";

// Types for the microservice architecture
interface BlockData {
  block_number: number;
  block_id: string;
  timestamp: string;
  version?: string;
  counter?: number;
  filtering: {
    contracts: string[];
    tables: Record<string, string[]>;
    enabled: boolean;
  };
}

interface ActionData {
  trace_type: string;
  global_sequence: number;
  account: string;
  name: string;
  authorization: any[];
  data: any;
  console: string;
  receipt: any;
  filtered: boolean;
}

interface TableDelta {
  type: string;
  contract: string;
  table: string;
  data: any;
  processed: boolean;
  filtered?: boolean;
}

interface MicroServiceContext {
  $block: BlockData;
  $delta?: TableDelta;
  $action?: ActionData;
  $table?: string; // table name from delta
}

type MicroService = (context: MicroServiceContext) => MicroServiceContext;

interface SocketTesterConfig {
  socketAddress: string;
  contracts?: string[];
  tables?: Record<string, string[]>;
}

class SocketTester {
  abi = null;
  types = null;
  tables = new Map();
  contractAbis = new Map();
  contractTypes = new Map();
  whitelistedContracts = new Set();
  whitelistedTables = new Map<string, Set<string>>(); // Map<contract, Set<table>>
  rpc = null;
  receivedCounter = 0;
  ws;
  private subject = new Subject<MicroServiceContext>();
  private microservices: MicroService[] = [];
  private socketAddress: string;

  // Connect to the State-History Plugin
  constructor({
    socketAddress,
    contracts = [],
    tables = {},
  }: SocketTesterConfig) {
    this.socketAddress = socketAddress;
    this.rpc = new JsonRpc(RPC_ENDPOINT, {fetch});

    // Setup contract whitelist
    this.whitelistedContracts = new Set<string>(contracts);

    // Setup table whitelist (format: {contract: [table1, table2]})
    this.whitelistedTables = new Map();
    Object.entries(tables).forEach(([contract, contractTables]) => {
      this.whitelistedTables.set(contract, new Set<string>(contractTables));
    });
  }

  // Add microservice to the pipeline
  pipe(microservice: MicroService): SocketTester {
    this.microservices.push(microservice);
    return this;
  }

  // Start the WebSocket connection and process through microservice chain
  start(): void {
    this.ws = new WebSocket(this.socketAddress, {perMessageDeflate: false});
    this.ws.on("message", data => this.onMessage(data));

    // Subscribe to the stream and process through microservice chain
    this.subject.subscribe(context => {
      this.processThroughMicroservices(context);
    });
  }

  // Process context through all microservices
  private processThroughMicroservices(context: MicroServiceContext): void {
    let currentContext = context;

    for (const microservice of this.microservices) {
      try {
        currentContext = microservice(currentContext);
      } catch (error) {
        console.error("Microservice error:", error);
        break;
      }
    }
  }

  // Emit events to the stream
  private emit(context: MicroServiceContext): void {
    this.subject.next(context);
  }

  // Convert JSON to binary. type identifies one of the types in this.types.
  serialize(type, value) {
    const buffer = new SerialBuffer({textEncoder: txEnc, textDecoder: txDec});
    Serialize.getType(this.types, type).serialize(buffer, value);
    return buffer.asUint8Array();
  }

  // Convert binary to JSON. type identifies one of the types in this.types.
  deserialize(type, array) {
    const buffer = new SerialBuffer({
      textEncoder: txEnc,
      textDecoder: txDec,
      array,
    });
    return Serialize.getType(this.types, type).deserialize(
      buffer,
      new SerializerState({bytesAsUint8Array: true})
    );
  }

  // Fetch contract ABI from blockchain
  async fetchContractAbi(contract) {
    try {
      if (this.contractAbis.has(contract)) {
        return this.contractAbis.get(contract);
      }

      console.log(`Fetching ABI for contract: ${contract}`);
      const abiResponse = await this.rpc.get_abi(contract);

      if (abiResponse && abiResponse.abi) {
        const contractTypes = getTypesFromAbi(
          createInitialTypes(),
          abiResponse.abi
        );
        this.contractAbis.set(contract, abiResponse.abi);
        this.contractTypes.set(contract, contractTypes);
        console.log(`✓ ABI loaded for contract: ${contract}`);
        return abiResponse.abi;
      }

      return null;
    } catch (e) {
      console.log(`✗ Failed to fetch ABI for ${contract}: ${e.message}`);
      return null;
    }
  }

  // Initialize contract ABIs for whitelisted contracts
  async initializeContractAbis() {
    console.log(
      `Loading ABIs for ${this.whitelistedContracts.size} whitelisted contracts...`
    );

    const promises = Array.from(this.whitelistedContracts).map(contract =>
      this.fetchContractAbi(contract)
    );

    await Promise.allSettled(promises);
    console.log(
      `ABI initialization complete. Loaded ${this.contractAbis.size} ABIs.`
    );
  }

  // Decode table row value using contract ABI
  decodeTableRowValue(contractName, tableName, valueData) {
    try {
      if (!valueData || typeof valueData !== "object") return valueData;

      // Convert object data to Uint8Array
      const dataArray = new Uint8Array(Object.keys(valueData).length);
      Object.keys(valueData).forEach(key => {
        dataArray[parseInt(key)] = valueData[key];
      });

      // Try to decode with contract ABI if available
      if (this.contractTypes.has(contractName)) {
        const types = this.contractTypes.get(contractName);
        const contractAbi = this.contractAbis.get(contractName);

        // Find the table structure in the ABI
        const tableAbi = contractAbi.tables?.find(t => t.name === tableName);
        if (tableAbi && tableAbi.type) {
          const buffer = new SerialBuffer({
            textEncoder: txEnc,
            textDecoder: txDec,
            array: dataArray,
          });

          const decoded = Serialize.getType(types, tableAbi.type).deserialize(
            buffer,
            new SerializerState({bytesAsUint8Array: true})
          );

          return decoded;
        }
      }

      // If no ABI or decoding fails, return hex representation
      return {
        hex: Array.from(dataArray)
          .map(b => b.toString(16).padStart(2, "0"))
          .join(""),
        note: `Unable to decode table row for ${contractName}.${tableName} - ABI not available or table structure not found`,
      };
    } catch (e) {
      return {
        error: e.message,
        hex: Array.from(Object.keys(valueData))
          .map(k => valueData[k].toString(16).padStart(2, "0"))
          .join(""),
      };
    }
  }

  // Decode action data using contract ABI
  decodeActionData(account, name, data) {
    try {
      if (!data || data.length === 0) return null;

      const hex = Array.from(data)
        .map(b => b.toString(16).padStart(2, "0"))
        .join("");

      // Try to decode with contract ABI if available
      if (this.contractTypes.has(account)) {
        try {
          const types = this.contractTypes.get(account);
          const buffer = new SerialBuffer({
            textEncoder: txEnc,
            textDecoder: txDec,
            array: data,
          });

          const decoded = Serialize.getType(types, name).deserialize(
            buffer,
            new SerializerState({bytesAsUint8Array: true})
          );

          return {
            account,
            name,
            decoded,
            hex,
            abi_decoded: true,
          };
        } catch (decodeError) {
          return {
            account,
            name,
            hex,
            abi_decoded: false,
            decode_error: decodeError.message,
          };
        }
      }

      return {
        account,
        name,
        hex,
        abi_decoded: false,
        note: `No ABI loaded for contract: ${account}`,
      };
    } catch (e) {
      return {
        error: e.message,
        hex: Array.from(data)
          .map(b => b.toString(16).padStart(2, "0"))
          .join(""),
      };
    }
  }

  // Check if action should be processed based on whitelist
  shouldProcessAction(account, name) {
    if (this.whitelistedContracts.size === 0) return true; // No filter = process all
    return this.whitelistedContracts.has(account);
  }

  // Check if table delta should be processed based on whitelist
  shouldProcessTable(contract, table) {
    if (this.whitelistedTables.size === 0) return true; // No filter = process all

    const contractTables = this.whitelistedTables.get(contract);
    if (!contractTables) return false; // Contract not in whitelist

    return contractTables.has(table);
  }

  // Process and decode table deltas with filtering
  processTableDeltas(deltas) {
    if (!deltas || deltas.length === 0) return [];

    const decodedDeltas = [];

    for (const delta of deltas) {
      try {
        const [deltaType, deltaData] = delta;

        // Handle different delta types according to EOSIO State History specification
        if (deltaType === "table_delta_v0") {
          const table = deltaData.name;

          // Special handling for contract_row - this contains user contract table data
          if (table === "contract_row") {
            console.log(
              `[SOCKET] Processing contract_row with ${
                deltaData.rows ? deltaData.rows.length : 0
              } rows`
            );
            const extractedTables =
              this.extractTablesFromContractRow(deltaData);
            console.log(
              `[SOCKET] Extracted tables: ${extractedTables
                .map(t => `${t.contract}.${t.table}`)
                .join(", ")}`
            );
            if (extractedTables.length > 0) {
              console.log(
                `[SOCKET] Extracted ${extractedTables.length} tables from contract_row`
              );
            }
            decodedDeltas.push(...extractedTables);
            continue;
          }

          // For any other table, check if it's explicitly whitelisted
          const matchingContract = this.findContractForTable(table);
          if (matchingContract) {
            console.log(
              `[SOCKET] Processing whitelisted table: ${matchingContract}.${table}`
            );

            decodedDeltas.push({
              type: deltaType,
              contract: matchingContract,
              table,
              data: deltaData,
              processed: true,
              filtered: true,
            });
          } else {
            console.log(`[SOCKET] Skipping non-whitelisted table: ${table}`);
          }
        }
      } catch (e) {
        console.error(`Error processing delta: ${e.message}`);
        decodedDeltas.push({
          error: e.message,
          raw: delta,
          processed: false,
        });
      }
    }

    return decodedDeltas;
  }

  // Generic helper to find which whitelisted contract contains this table
  findContractForTable(tableName) {
    for (const [contract, tables] of this.whitelistedTables.entries()) {
      if (tables.has(tableName)) {
        return contract;
      }
    }
    return null; // Table not found in any whitelisted contract
  }

  // Extract table data from contract_row deltas
  extractTablesFromContractRow(deltaData) {
    const extractedTables = [];

    if (!deltaData.rows || deltaData.rows.length === 0) {
      console.warn(`[SOCKET] No rows in contract_row`);
      return extractedTables;
    }

    for (const row of deltaData.rows) {
      try {
        if (row.present && row.data) {
          // Convert object data to Uint8Array
          const dataArray = new Uint8Array(Object.keys(row.data).length);
          Object.keys(row.data).forEach(key => {
            dataArray[parseInt(key)] = row.data[key];
          });

          // Deserialize the contract row data using the ship ABI
          const contractRowData = this.deserialize("contract_row", dataArray);

          if (
            contractRowData &&
            contractRowData[1] &&
            contractRowData[1].table
          ) {
            const tableName = contractRowData[1].table;
            const contractName = contractRowData[1].code;

            // Apply whitelist filter for the extracted table
            if (this.shouldProcessTable(contractName, tableName)) {
              console.log(
                `[SOCKET] Found whitelisted table: ${contractName}.${tableName}`
              );

              // Decode the table row value if we have the ABI
              let decodedValue = contractRowData[1].value;
              if (this.contractTypes.has(contractName)) {
                decodedValue = this.decodeTableRowValue(
                  contractName,
                  tableName,
                  contractRowData[1].value
                );
              }

              extractedTables.push({
                type: "table_delta_v0",
                contract: contractName,
                table: tableName,
                data: {
                  ...contractRowData[1],
                  value: decodedValue, // Replace binary value with decoded JSON
                },
                processed: true,
                filtered: true,
                extracted_from: "contract_row",
              });
            }
          }
        }
      } catch (e) {
        // Continue with other rows even if one fails
      }
    }
    return extractedTables;
  }

  // Serialize a request and send it to the plugin
  send(request) {
    this.ws.send(this.serialize("request", request));
  }

  // Receive a message
  async onMessage(data) {
    try {
      if (!this.abi) {
        // First message is the protocol ABI
        this.abi = JSON.parse(data);

        console.log("✓ Protocol ABI received");
        for (const struct of this.abi.structs) {
          console.log(struct.name, "\n", struct.fields, "\n");
        }

        this.types = getTypesFromAbi(createInitialTypes(), this.abi);
        for (const table of this.abi.tables) {
          this.tables.set(table.name, table.type);
        }

        // Initialize contract ABIs if whitelisted contracts are specified
        if (this.whitelistedContracts.size > 0) {
          await this.initializeContractAbis();
        }

        this.send(["get_status_request_v0", {}]);
      } else {
        const [type, response] = this.deserialize("result", data);

        if (this[type]) {
          this[type](response);
        } else {
          console.log("Unhandled Type:", type);
        }

        // Ack Block
        this.send(["get_blocks_ack_request_v0", {num_messages: 1}]);
      }
    } catch (e) {
      console.log(e);
      process.exit(1);
    }
  }

  // Report status

  get_status_result_v0(response) {
    // request from head block
    this.receivedCounter = 0;
    this.send([
      "get_blocks_request_v0",
      {
        max_messages_in_flight: 1,
        have_positions: [],
        irreversible_only: false,
        fetch_block: true,
        fetch_traces: true,
        fetch_deltas: true,
        start_block_num: response.head.block_num,
        end_block_num: 0xffffffff - 1,
      },
    ]);
  }

  get_blocks_result_v1(response) {
    const block_num = response.this_block.block_num;
    this.receivedCounter++;

    const blockData: BlockData = {
      block_number: block_num,
      block_id: response.this_block.block_id,
      timestamp: new Date().toISOString(),
      filtering: {
        contracts: Array.from(this.whitelistedContracts),
        tables: Object.fromEntries(
          Array.from(this.whitelistedTables.entries()).map(([k, v]) => [
            k,
            Array.from(v),
          ])
        ),
        enabled:
          this.whitelistedContracts.size > 0 || this.whitelistedTables.size > 0,
      },
    };

    try {
      // Process transaction traces
      if (response.traces && response.traces.length > 0) {
        const traces = this.deserialize("transaction_trace[]", response.traces);
        for (const trace of traces) {
          const [traceType, tx] = trace;

          // Process action traces with filtering
          for (const act_trace of tx.action_traces || []) {
            const [actTraceType, act] = act_trace;

            // Apply whitelist filter
            if (!this.shouldProcessAction(act.act.account, act.act.name)) {
              continue; // Skip this action
            }

            const actionData: ActionData = {
              trace_type: actTraceType,
              global_sequence: act.global_sequence,
              account: act.act.account,
              name: act.act.name,
              authorization: act.act.authorization,
              data: this.decodeActionData(
                act.act.account,
                act.act.name,
                act.act.data
              ),
              console: act.console || "",
              receipt: act.receipt,
              filtered: true,
            };

            // Emit context with action
            this.emit({
              $block: blockData,
              $action: actionData,
            });
          }
        }
      }

      // Process table deltas
      if (response.deltas && response.deltas.length > 0) {
        const deltas = this.deserialize("table_delta[]", response.deltas);
        const processedDeltas = this.processTableDeltas(deltas);

        for (const delta of processedDeltas) {
          // Emit context with delta
          this.emit({
            $block: blockData,
            $delta: delta,
            $table: delta.table,
          });
        }
      }
    } catch (e) {
      console.log(`Block: ${block_num} | Processing Error: ${e.message}`);
    }
  }

  get_blocks_result_v0(response) {
    const block_num = response.this_block.block_num;
    this.receivedCounter++;

    const blockData: BlockData = {
      block_number: block_num,
      block_id: response.this_block.block_id,
      timestamp: new Date().toISOString(),
      version: "v0",
      counter: this.receivedCounter,
      filtering: {
        contracts: Array.from(this.whitelistedContracts),
        tables: Object.fromEntries(
          Array.from(this.whitelistedTables.entries()).map(([k, v]) => [
            k,
            Array.from(v),
          ])
        ),
        enabled:
          this.whitelistedContracts.size > 0 || this.whitelistedTables.size > 0,
      },
    };
    // Emit block context
    this.emit({
      $block: blockData,
    });

    try {
      // Process transaction traces
      if (response.traces && response.traces.length > 0) {
        const traces = this.deserialize("transaction_trace[]", response.traces);
        for (const trace of traces) {
          const [traceType, tx] = trace;

          const transactionData = {
            trace_type: traceType,
            id: tx.id,
            status: tx.status,
            cpu_usage_us: tx.cpu_usage_us,
            net_usage_words: tx.net_usage_words,
            action_traces: [],
          };

          // Process action traces with filtering
          for (const act_trace of tx.action_traces || []) {
            const [actTraceType, act] = act_trace;

            // Apply whitelist filter
            if (!this.shouldProcessAction(act.act.account, act.act.name)) {
              continue; // Skip this action
            }

            const actionData: ActionData = {
              trace_type: actTraceType,
              global_sequence: act.global_sequence,
              account: act.act.account,
              name: act.act.name,
              authorization: act.act.authorization,
              data: this.decodeActionData(
                act.act.account,
                act.act.name,
                act.act.data
              ),
              console: act.console || "",
              receipt: act.receipt,
              filtered: true,
            };
            // Emit context with action
            this.emit({
              $block: blockData,
              $action: actionData,
            });
          }
        }
      }

      // Process table deltas
      if (response.deltas && response.deltas.length > 0) {
        const deltas = this.deserialize("table_delta[]", response.deltas);
        console.log(`[DEBUG] Block ${block_num} has ${deltas.length} deltas`);
        const processedDeltas = this.processTableDeltas(deltas);
        console.log(
          `[DEBUG] Processed ${processedDeltas.length} deltas after filtering`
        );
        for (const delta of processedDeltas) {
          // Emit context with delta
          this.emit({
            $block: blockData,
            $delta: delta,
            $table: delta.table,
          });
        }
      }
    } catch (e) {
      console.log(`Block: ${block_num} | Processing Error: ${e.message}`);
    }
  }
}

// Example microservices

// Microservice 1: Logger - logs all events
const loggerMicroService = ({
  $block,
  $delta,
  $action,
  $table,
}: MicroServiceContext) => {
  if ($action) {
    console.log(
      `[LOGGER] ACTION - Block ${$block.block_number}: ${$action.account}.${$action.name}`
    );
  } else if ($delta) {
    console.log(
      `[LOGGER] DELTA - Block ${$block.block_number}: Table ${$table}`
    );
  } else {
    console.log(`[LOGGER] BLOCK ${$block.block_number}`);
  }

  return {$block, $delta, $action, $table};
};

// Microservice 2: Transfer filter - only processes transfer actions
const transferFilterMicroService = ({
  $block,
  $delta,
  $action,
  $table,
}: MicroServiceContext) => {
  // Only pass through transfer actions, block everything else
  if ($action && $action.name === "transfer") {
    console.log(
      `[TRANSFER FILTER] Processing transfer from ${$action.account}`
    );
    return {$block, $delta, $action, $table};
  }

  // For non-transfer actions, return without action to filter them out
  return {$block, $delta, $action, $table};
};

// Microservice 3: Action transformer - outputs detailed action JSON
const actionTransformMicroService = ({
  $block,
  $delta,
  $action,
  $table,
}: MicroServiceContext) => {
  if ($action) {
    console.log(`[TRANSFORMER] Action`);
  }

  return {$block, $delta, $action, $table};
};

// Microservice 3: Action transformer - outputs detailed action JSON
const tableLoggerMicroService = ({
  $block,
  $delta,
  $action,
  $table,
}: MicroServiceContext) => {
  if ($delta && $table) {
    console.log(
      `[MICRO] Delta found - Table: ${$table}, Contract: ${$delta.contract}`
    );
    console.log(`[MICRO] Delta details:`, JSON.stringify($delta, null, 2));
  }

  return {$block, $delta, $action, $table};
};

// Example usage with microservice architecture
const tester = new SocketTester({
  socketAddress: WS_SERVER,
  contracts: ["eosio", "futureshit"], // Whitelisted contracts
  tables: {
    eosio: ["voters"], // Only these tables for eosio.token
    futureshit: ["accounts"], // Only accounts table for xtokens
  },
});

// Chain microservices and start processing
tester.pipe(tableLoggerMicroService).start();

// For no filtering (process all contracts/tables), use:
// new SocketTester({socketAddress: WS_SERVER});
