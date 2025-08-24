// TypeScript type definitions for XPRNetwork Block Stream Client

import * as winston from "winston";

// EOSIO State History types
export interface EOSIOAbi {
  version: string;
  types: Array<{new_type_name: string; type: string}>;
  structs: Array<{
    name: string;
    base: string;
    fields: Array<{name: string; type: string}>;
  }>;
  actions: Array<{name: string; type: string; ricardian_contract?: string}>;
  tables: Array<{
    name: string;
    type: string;
    index_type: string;
    key_names: string[];
    key_types: string[];
  }>;
  ricardian_clauses?: Array<{id: string; body: string}>;
  variants?: Array<{name: string; types: string[]}>;
}

export interface ContractAbiResponse {
  account_name: string;
  abi: EOSIOAbi;
}

export interface SerializationTypes {
  [key: string]: any; // eosjs serialization types - complex internal structure
}

export interface StateHistoryRow {
  present: boolean;
  data?: Record<string, number>; // Binary data as object with numeric keys
}

export interface TableDeltaData {
  name: string;
  rows?: StateHistoryRow[];
}

export interface ContractRowData {
  code: string;
  scope: string;
  table: string;
  primary_key: string;
  payer: string;
  value: Record<string, number>; // Binary data as object
}

export interface BlockPosition {
  block_num: number;
  block_id: string;
}

export interface GetBlocksResponse {
  head: BlockPosition;
  last_irreversible: BlockPosition;
  this_block: BlockPosition;
  prev_block?: BlockPosition;
  block?: Uint8Array;
  traces?: Uint8Array;
  deltas?: Uint8Array;
}

// Custom Logger type that includes our custom log levels
// We can't extend winston.Logger due to method signature incompatibilities
export type CustomLogger = winston.Logger & {
  socket(message: string, meta?: any): winston.Logger;
  micro(message: string, meta?: any): winston.Logger;
};

// Types for the microservice architecture
export interface BlockData {
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

export interface ActionData {
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

export interface TableDelta {
  type: string;
  contract: string;
  table: string;
  data: any;
  processed: boolean;
  filtered?: boolean;
  extracted_from?: string;
}

export interface MicroServiceContext {
  $block: BlockData;
  $delta?: TableDelta;
  $action?: ActionData;
  $table?: string; // table name from delta
  $logger: CustomLogger;
}

export type MicroService = (context: MicroServiceContext) => MicroServiceContext;

export interface ContractConfig {
  tables?: string[]; // Array of table names, or ["*"] for all tables
  actions?: string[]; // Array of action names, undefined means no actions
}

export interface SocketTesterConfig {
  socketAddress: string;
  rpcAddress: string;
  contracts?: Record<string, ContractConfig>; // New enhanced format
  // Legacy support (deprecated)
  tables?: Record<string, string[]>;
  enableDebug?: boolean;
  logFile?: string;
  logLevel?:
    | "error"
    | "warn"
    | "info"
    | "socket"
    | "micro"
    | "debug"
    | "verbose";
}