import {BlockStreamClient} from "../src/index";
import {MicroServiceContext} from "../src/types";

const WS_SERVER = "ws://testnet.rockerone.io:8080";
const RPC_ENDPOINT = "https://testnet.rockerone.io";
// Example usage with enhanced microservice architecture

const tableLoggerMicroService = ({
  $block,
  $delta,
  $action,
  $table,
  $logger,
}: MicroServiceContext) => {
  if ($delta && $table && $table === "accounts") {
    $logger.micro("Table delta found", JSON.stringify($delta.data, null, 2));
  }

  return {$block, $delta, $action, $table, $logger};
};

new BlockStreamClient({
  socketAddress: WS_SERVER,
  rpcAddress: RPC_ENDPOINT,
  contracts: {
    futureshit: {
      tables: ["*"], // All tables (wildcard)
    },
  },
  enableDebug: true, // Enable debug logging to console
  logFile: "stream-block-client.log", // Log file location
  logLevel: "micro", // Only show microservice logs and above (socket logs hidden)
})
  .pipe(tableLoggerMicroService)

  //Start the client
  .start();
