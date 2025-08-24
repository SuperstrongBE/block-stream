// noinspection JSUnusedGlobalSymbols,JSUnusedGlobalSymbols,JSUnusedGlobalSymbols,JSCheckFunctionSignatures,JSCheckFunctionSignatures,JSUnresolvedVariable,JSUnresolvedVariable

const {Serialize} = require("eosjs");
import WebSocket from "ws";
const {
  SerialBuffer,
  SerializerState,
  getTypesFromAbi,
  createInitialTypes,
} = require("eosjs/dist/eosjs-serialize");
const {JsonRpc} = require("eosjs");
const fetch = require("node-fetch");
import {Subject} from "rxjs";
import * as winston from "winston";

// Import type definitions
import type {
  EOSIOAbi,
  ContractAbiResponse,
  SerializationTypes,
  StateHistoryRow,
  TableDeltaData,
  ContractRowData,
  BlockPosition,
  GetBlocksResponse,
  CustomLogger,
  BlockData,
  ActionData,
  TableDelta,
  MicroServiceContext,
  MicroService,
  ContractConfig,
  SocketTesterConfig,
} from "./types";

const txEnc = new TextEncoder();
const txDec = new TextDecoder();

export class BlockStreamClient {
  abi: EOSIOAbi | null = null; // Protocol ABI from State History
  types: SerializationTypes | null = null; // Serialization types from ABI
  tables = new Map<string, string>();
  contractAbis = new Map<string, EOSIOAbi>();
  contractTypes = new Map<string, SerializationTypes>();
  whitelistedContracts = new Set<string>();
  whitelistedTables = new Map<string, Set<string>>(); // Map<contract, Set<table>>
  whitelistedActions = new Map<string, Set<string>>(); // Map<contract, Set<action>>
  wildcardTables = new Set<string>(); // Contracts with wildcard table access
  rpc: any = null; // JsonRpc from eosjs - external library without proper types
  receivedCounter: number = 0;
  ws!: WebSocket; // Initialized in start() method
  private subject = new Subject<MicroServiceContext>();
  private microservices: MicroService[] = [];
  private socketAddress: string;
  private logger: CustomLogger;
  private enableDebug: boolean;

  // Connect to the State-History Plugin
  constructor(config: SocketTesterConfig) {
    console.log(config);

    this.socketAddress = config.socketAddress;
    this.enableDebug = config.enableDebug ?? false;
    this.rpc = new JsonRpc(config.rpcAddress, {fetch});

    // Setup Winston logger with custom levels
    const customLevels = {
      levels: {
        error: 0,
        warn: 1,
        info: 2,
        micro: 3, // Microservice-level debugging
        socket: 4, // Socket-level debugging
        debug: 5, // General debugging
        verbose: 6, // Very detailed logging
      },
      colors: {
        error: "red",
        warn: "yellow",
        info: "green",
        socket: "cyan",
        micro: "magenta",
        debug: "blue",
        verbose: "gray",
      },
    };

    winston.addColors(customLevels.colors);

    const logFormat = winston.format.combine(
      winston.format.timestamp(),
      winston.format.errors({stack: true}),
      winston.format.json()
    );

    const consoleFormat = winston.format.combine(
      winston.format.colorize(),
      winston.format.timestamp({format: "HH:mm:ss"}),
      winston.format.printf(({timestamp, level, message, ...meta}) => {
        const metaStr = Object.keys(meta).length
          ? ` ${JSON.stringify(meta)}`
          : "";
        return `${timestamp} [${level}]: ${message}${metaStr}`;
      })
    );

    const transports: winston.transport[] = [
      // new winston.transports.File({
      //   filename: config.logFile ?? "hyperion-client.log",
      //   level: config.logLevel ?? "error",
      // }),
    ];

    // Add console transport only if debug is enabled
    if (config.enableDebug) {
      transports.push(
        new winston.transports.Console({
          format: consoleFormat,
          level: config.logLevel ?? "error",
        })
      );
    }

    this.logger = winston.createLogger({
      levels: customLevels.levels,
      level: "error",
      format: logFormat,
      transports,
    }) as unknown as CustomLogger;

    // Initialize whitelists based on configuration format
    this.initializeWhitelists(config.contracts, config.tables);
  }

  // Initialize contract, table, and action whitelists
  private initializeWhitelists(
    contracts?: Record<string, ContractConfig>,
    legacyTables?: Record<string, string[]>
  ): void {
    if (contracts) {
      // New enhanced format
      this.logger.info("Using enhanced contract configuration format");

      Object.entries(contracts).forEach(([contractName, config]) => {
        // Add contract to whitelist
        this.whitelistedContracts.add(contractName);

        // Handle tables configuration
        if (config.tables) {
          if (config.tables.includes("*")) {
            // Wildcard - allow all tables for this contract
            this.wildcardTables.add(contractName);
            this.logger.socket(
              "Contract configured with wildcard table access",
              {contract: contractName}
            );
          } else {
            // Specific tables
            this.whitelistedTables.set(contractName, new Set(config.tables));
            this.logger.socket("Contract configured with specific tables", {
              contract: contractName,
              tables: config.tables,
            });
          }
        }

        // Handle actions configuration
        if (config.actions) {
          this.whitelistedActions.set(contractName, new Set(config.actions));
          this.logger.socket("Contract configured with specific actions", {
            contract: contractName,
            actions: config.actions,
          });
        }
      });
    } else if (legacyTables && Object.keys(legacyTables).length > 0) {
      // Legacy format support
      this.logger.warn(
        "Using legacy table configuration format - consider upgrading to enhanced format"
      );

      Object.entries(legacyTables).forEach(([contract, contractTables]) => {
        this.whitelistedContracts.add(contract);
        this.whitelistedTables.set(contract, new Set(contractTables));
      });
    } else {
      // No filtering - process all contracts/tables
      this.logger.info(
        "No contract filtering configured - processing all contracts and tables"
      );
    }
  }

  // Add microservice to the pipeline
  pipe(microservice: MicroService): BlockStreamClient {
    this.microservices.push(microservice);
    return this;
  }

  // Start the WebSocket connection and process through microservice chain
  start(): void {
    this.ws = new WebSocket.WebSocket(this.socketAddress, {
      perMessageDeflate: false,
    });
    this.ws.on("message", (data: WebSocket.RawData) => {
      const buffer =
        data instanceof ArrayBuffer ? Buffer.from(data) : (data as Buffer);
      this.onMessage(buffer);
    });

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
      } catch (error: any) {
        this.logger.error("Microservice error", {
          error: error.message,
          stack: error.stack,
        });
        break;
      }
    }
  }

  // Emit events to the stream
  private emit(context: MicroServiceContext): void {
    this.subject.next(context);
  }

  // Convert JSON to binary. type identifies one of the types in this.types.
  serialize(type: string, value: any): Uint8Array {
    const buffer = new SerialBuffer({textEncoder: txEnc, textDecoder: txDec});
    Serialize.getType(this.types, type).serialize(buffer, value);
    return buffer.asUint8Array();
  }

  // Convert binary to JSON. type identifies one of the types in this.types.
  deserialize(type: string, array: Uint8Array): any {
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
  async fetchContractAbi(contract: string): Promise<EOSIOAbi | null> {
    try {
      if (this.contractAbis.has(contract)) {
        return this.contractAbis.get(contract) || null;
      }

      this.logger.socket("Fetching ABI for contract", {contract});
      const abiResponse = await this.rpc.get_abi(contract);

      if (abiResponse?.abi) {
        const contractTypes = getTypesFromAbi(
          createInitialTypes(),
          abiResponse.abi
        );
        this.contractAbis.set(contract, abiResponse.abi);
        this.contractTypes.set(contract, contractTypes);
        this.logger.info("ABI loaded successfully", {contract});
        return abiResponse.abi;
      }

      return null;
    } catch (e: any) {
      this.logger.warn("Failed to fetch ABI", {contract, error: e.message});
      return null;
    }
  }

  // Initialize contract ABIs for whitelisted contracts
  async initializeContractAbis(): Promise<void> {
    this.logger.info("Loading ABIs for whitelisted contracts", {
      count: this.whitelistedContracts.size,
    });

    const promises = Array.from(this.whitelistedContracts).map(contract =>
      this.fetchContractAbi(contract)
    );

    await Promise.allSettled(promises);
    this.logger.info("ABI initialization complete", {
      loaded: this.contractAbis.size,
    });
  }

  // Decode table row value using contract ABI
  decodeTableRowValue(
    contractName: string,
    tableName: string,
    valueData: Record<string, number>
  ): any {
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
        const tableAbi = contractAbi?.tables?.find(t => t.name === tableName);
        if (tableAbi?.type) {
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
    } catch (e: any) {
      return {
        error: e.message,
        hex: Array.from(Object.keys(valueData))
          .map(k => valueData[k].toString(16).padStart(2, "0"))
          .join(""),
      };
    }
  }

  // Decode action data using contract ABI
  decodeActionData(account: string, name: string, data: Uint8Array): any {
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
        } catch (decodeError: any) {
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
    } catch (e: any) {
      return {
        error: e.message,
        hex: Array.from(data)
          .map(b => b.toString(16).padStart(2, "0"))
          .join(""),
      };
    }
  }

  // Check if action should be processed based on whitelist
  shouldProcessAction(account: string, name: string): boolean {
    // If no contracts configured, process all
    if (this.whitelistedContracts.size === 0) return true;

    // Contract must be whitelisted
    if (!this.whitelistedContracts.has(account)) return false;

    // If no specific actions configured for this contract, allow all actions
    const contractActions = this.whitelistedActions.get(account);
    if (!contractActions) return true;

    // Check if specific action is whitelisted
    return contractActions.has(name);
  }

  // Check if table delta should be processed based on whitelist
  shouldProcessTable(contract: string, table: string): boolean {
    // If no contracts configured, process all
    if (
      this.whitelistedContracts.size === 0 &&
      this.whitelistedTables.size === 0
    )
      return true;

    // Contract must be whitelisted
    if (!this.whitelistedContracts.has(contract)) return false;

    // Check if contract has wildcard table access
    if (this.wildcardTables.has(contract)) return true;

    // Check specific table whitelist
    const contractTables = this.whitelistedTables.get(contract);
    if (!contractTables) return true; // Contract whitelisted but no specific tables = allow all

    return contractTables.has(table);
  }

  // Process and decode table deltas with filtering
  processTableDeltas(deltas: Array<[string, TableDeltaData]>): TableDelta[] {
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
            this.logger.socket("Processing contract_row", {
              rows: deltaData.rows ? deltaData.rows.length : 0,
            });
            const extractedTables =
              this.extractTablesFromContractRow(deltaData);
            this.logger.socket("Extracted tables from contract_row", {
              tables: extractedTables.map(t => `${t.contract}.${t.table}`),
            });
            if (extractedTables.length > 0) {
              this.logger.info("Tables extracted from contract_row", {
                count: extractedTables.length,
              });
            }
            decodedDeltas.push(...extractedTables);
            continue;
          }

          // For any other table, check if it's explicitly whitelisted
          const matchingContract = this.findContractForTable(table);
          if (matchingContract) {
            this.logger.info("Processing whitelisted table", {
              contract: matchingContract,
              table,
            });

            decodedDeltas.push({
              type: deltaType,
              contract: matchingContract,
              table,
              data: deltaData,
              processed: true,
              filtered: true,
            });
          } else {
            this.logger.socket("Skipping non-whitelisted table", {table});
          }
        }
      } catch (e: any) {
        this.logger.error("Error processing delta", {
          error: e.message,
          stack: e.stack,
        });
        decodedDeltas.push({
          type: "error",
          contract: "unknown",
          table: "unknown",
          data: {error: e.message, raw: delta},
          processed: false,
        });
      }
    }

    return decodedDeltas;
  }

  // Generic helper to find which whitelisted contract contains this table
  findContractForTable(tableName: string): string | null {
    for (const [contract, tables] of Array.from(
      this.whitelistedTables.entries()
    )) {
      if (tables.has(tableName)) {
        return contract;
      }
    }
    return null; // Table not found in any whitelisted contract
  }

  // Extract table data from contract_row deltas
  extractTablesFromContractRow(deltaData: TableDeltaData): TableDelta[] {
    const extractedTables: TableDelta[] = [];

    if (!deltaData.rows || deltaData.rows.length === 0) {
      this.logger.socket("No rows in contract_row");
      return extractedTables;
    }

    for (const row of deltaData.rows) {
      try {
        if (row.present && row.data) {
          // Convert object data to Uint8Array
          const dataArray = new Uint8Array(Object.keys(row.data).length);
          Object.keys(row.data).forEach(key => {
            dataArray[parseInt(key)] = row.data![key];
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
              this.logger.info("Found whitelisted table in contract_row", {
                contract: contractName,
                table: tableName,
              });

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
      } catch (e: any) {
        // Continue with other rows even if one fails
      }
    }
    return extractedTables;
  }

  // Serialize a request and send it to the plugin
  send(request: [string, any]): void {
    this.ws.send(this.serialize("request", request));
  }

  // Receive a message
  async onMessage(data: Buffer): Promise<void> {
    try {
      if (!this.abi) {
        // First message is the protocol ABI
        this.abi = JSON.parse(data.toString());

        this.logger.info("Protocol ABI received");
        for (const struct of this.abi!.structs) {
          this.logger.socket("ABI struct", {
            name: struct.name,
            fields: struct.fields,
          });
        }

        this.types = getTypesFromAbi(createInitialTypes(), this.abi!);
        for (const table of this.abi!.tables) {
          this.tables.set(table.name, table.type);
        }

        // Initialize contract ABIs if whitelisted contracts are specified
        if (this.whitelistedContracts.size > 0) {
          await this.initializeContractAbis();
        }

        this.send(["get_status_request_v0", {}]);
      } else {
        const dataArray = new Uint8Array(data);
        const [type, response] = this.deserialize("result", dataArray);

        if (type && typeof (this as any)[type] === "function") {
          (this as any)[type](response);
        } else {
          this.logger.warn("Unhandled message type", {type});
        }

        // Ack Block
        this.send(["get_blocks_ack_request_v0", {num_messages: 1}]);
      }
    } catch (e: any) {
      this.logger.error("WebSocket message processing error", {
        error: e.message,
        stack: e.stack,
      });
      process.exit(1);
    }
  }

  // Report status

  get_status_result_v0(response: {
    head: any;
    last_irreversible: any;
    chain_id: string;
  }): void {
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

  get_blocks_result_v1(response: any): void {
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
              $logger: this.logger,
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
            $logger: this.logger,
          });
        }
      }
    } catch (e: any) {
      this.logger.error("Block processing error", {
        block: block_num,
        error: e.message,
        stack: e.stack,
      });
    }
  }

  get_blocks_result_v0(response: GetBlocksResponse): void {
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
      $logger: this.logger,
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
              $logger: this.logger,
            });
          }
        }
      }

      // Process table deltas
      if (response.deltas && response.deltas.length > 0) {
        const deltas = this.deserialize("table_delta[]", response.deltas);
        this.logger.socket("Block deltas count", {
          block: block_num,
          deltas: deltas.length,
        });
        const processedDeltas = this.processTableDeltas(deltas);
        this.logger.socket("Processed deltas after filtering", {
          processed: processedDeltas.length,
        });
        for (const delta of processedDeltas) {
          // Emit context with delta
          this.emit({
            $block: blockData,
            $delta: delta,
            $table: delta.table,
            $logger: this.logger,
          });
        }
      }
    } catch (e: any) {
      this.logger.error("Block processing error", {
        block: block_num,
        error: e.message,
        stack: e.stack,
      });
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
  $logger,
}: MicroServiceContext) => {
  if ($action) {
    $logger.micro("Action processed", {
      block: $block.block_number,
      contract: $action.account,
      action: $action.name,
    });
  } else if ($delta) {
    $logger.micro("Delta processed", {
      block: $block.block_number,
      table: $table,
      contract: $delta.contract,
    });
  } else {
    $logger.micro("Block processed", {block: $block.block_number});
  }

  return {$block, $delta, $action, $table, $logger};
};

// Microservice 2: Transfer filter - only processes transfer actions
const transferFilterMicroService = ({
  $block,
  $delta,
  $action,
  $table,
  $logger,
}: MicroServiceContext) => {
  // Only pass through transfer actions, block everything else
  if ($action && $action.name === "transfer") {
    $logger.micro("Transfer action filtered", {
      from: $action.account,
      block: $block.block_number,
    });
    return {$block, $delta, $action, $table, $logger};
  }

  // For non-transfer actions, return without action to filter them out
  return {$block, $delta, $action, $table, $logger};
};

// Microservice 3: Action transformer - outputs detailed action JSON
const actionTransformMicroService = ({
  $block,
  $delta,
  $action,
  $table,
  $logger,
}: MicroServiceContext) => {
  if ($action) {
    $logger.micro("Action transformed", {
      action: $action.name,
      contract: $action.account,
    });
  }

  return {$block, $delta, $action, $table, $logger};
};
