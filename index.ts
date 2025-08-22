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

const txEnc = new TextEncoder();
const txDec = new TextDecoder();

const WS_SERVER = "ws://testnet.rockerone.io:8080";
const RPC_ENDPOINT = "https://testnet.rockerone.io";

class SocketTester {
  abi = null;
  types = null;
  tables = new Map();
  contractAbis = new Map();
  contractTypes = new Map();
  whitelistedContracts = new Set();
  whitelistedTables = new Map(); // Map<contract, Set<table>>
  rpc = null;
  receivedCounter = 0;
  ws;

  // Connect to the State-History Plugin
  constructor({socketAddress, contracts = [], tables = {}}) {
    this.rpc = new JsonRpc(RPC_ENDPOINT, {fetch});

    // Setup contract whitelist
    this.whitelistedContracts = new Set(contracts);

    // Setup table whitelist (format: {contract: [table1, table2]})
    this.whitelistedTables = new Map();
    Object.entries(tables).forEach(([contract, contractTables]) => {
      this.whitelistedTables.set(contract, new Set(contractTables));
    });

    this.ws = new WebSocket(socketAddress, {perMessageDeflate: false});
    this.ws.on("message", data => this.onMessage(data));
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
        // console.log(
        //   "Raw delta:",
        //   JSON.stringify({deltaType, deltaData}, null, 2)
        // );

        // The structure might be different - let's extract contract and table correctly
        const contract = deltaData.code || deltaData.name || deltaData.account;
        const table = deltaData.table || deltaData.scope;

        // console.log(
        //   `Delta found - Contract: ${contract}, Table: ${table}, Type: ${deltaType}`
        // );

        // Apply whitelist filter
        if (!this.shouldProcessTable(contract, table)) {
          // console.log(
          //   `Skipping delta - not in whitelist: ${contract}.${table}`
          // );
          continue; // Skip this delta
        }

        console.log(`✓ Processing delta: ${contract}.${table}`);
        decodedDeltas.push({
          type: deltaType,
          contract,
          table,
          data: deltaData,
          processed: true,
          filtered: true,
        });
      } catch (e) {
        console.log(`Error processing delta: ${e.message}`);
        decodedDeltas.push({
          error: e.message,
          raw: delta,
          processed: false,
        });
      }
    }

    //console.log(`Processed ${decodedDeltas.length} deltas after filtering`);
    return decodedDeltas;
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

    console.log(`\n=== BLOCK ${block_num} RECEIVED ===`);
    console.log(`Traces: ${response.traces ? response.traces.length : 0}`);
    console.log(`Deltas: ${response.deltas ? response.deltas.length : 0}`);

    const blockData = {
      block_number: block_num,
      block_id: response.this_block.block_id,
      timestamp: new Date().toISOString(),
      transactions: [],
      deltas: [],
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
      raw_response: response,
    };

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

            const actionData = {
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
            console.log(JSON.stringify(actionData, null, 2));
            transactionData.action_traces.push(actionData);
          }

          blockData.transactions.push(transactionData);
        }
      }

      // Process table deltas
      if (response.deltas && response.deltas.length > 0) {
        const deltas = this.deserialize("table_delta[]", response.deltas);
        blockData.deltas = this.processTableDeltas(deltas);
      }

    } catch (e) {
      console.log(`Block: ${block_num} | Processing Error: ${e.message}`);
      console.log("Raw response:", JSON.stringify(response, null, 2));
    }

    console.log(`=== END BLOCK ${block_num} ===\n`);
  }

  get_blocks_result_v0(response) {
    const block_num = response.this_block.block_num;
    this.receivedCounter++;


    const blockData = {
      version: "v0",
      block_number: block_num,
      block_id: response.this_block.block_id,
      timestamp: new Date().toISOString(),
      counter: this.receivedCounter,
      transactions: [],
      deltas: [],
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
      raw_response: response,
    };

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

            const actionData = {
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
            console.log(JSON.stringify(actionData, null, 2));
            transactionData.action_traces.push(actionData);
          }

          if (transactionData.action_traces.length > 0) {
            blockData.transactions.push(transactionData);
          }
        }
      }

      // Process table deltas
      if (response.deltas && response.deltas.length > 0) {
        const deltas = this.deserialize("table_delta[]", response.deltas);
        blockData.deltas = this.processTableDeltas(deltas);
      }

    } catch (e) {
      console.log(`Block: ${block_num} | Processing Error: ${e.message}`);
      console.log("Raw response:", JSON.stringify(response, null, 2));
    }

    console.log(`=== END BLOCK ${block_num} ===\n`);
  }
}

// Example usage with contract and table filtering
const tester = new SocketTester({
  socketAddress: WS_SERVER,
  contracts: ["eosio.token", "proton.swap", "xtokens"], // Whitelisted contracts
  tables: {
    "eosio.token": ["accounts", "stat"], // Only these tables for eosio.token
    "proton.swap": ["pools", "trades"], // Only these tables for proton.swap
    xtokens: ["accounts"], // Only accounts table for xtokens
  },
});

// For no filtering (process all contracts/tables), use:
// new SocketTester({socketAddress: WS_SERVER});
