const fs = require("fs");
const path = require("path");
require("dotenv").config();

const {
  SubscriptionManager,
  SecretsManager,
  simulateScript,
  ResponseListener,
  ReturnType,
  decodeResult,
  FulfillmentCode,
} = require("@chainlink/functions-toolkit");

const ethers = require("ethers");
const functionsConsumerAbi = require("../../abi/functionsClient.json");

// ---------------- CONFIG ----------------

const consumerAddress = "0xf7175fa8AEFfB11895f7c4c3A5f80EaA368110d4";
const subscriptionId = 6044;

// Sepolia constants
const ROUTER_ADDRESS = "0xb83E47C2bC239B3bf370bc41e1459A34b41238D0";
const LINK_TOKEN_ADDRESS = "0x779877A7B0D9E8603169DdbD7836e478b4624789";
const DON_ID = "fun-ethereum-sepolia-1"; // ✅ correct DON
const EXPLORER_URL = "https://sepolia.etherscan.io";

const GATEWAY_URLS = [
  "https://01.functions-gateway.testnet.chain.link/",
  "https://02.functions-gateway.testnet.chain.link/",
];

// ---------------- MAIN ----------------

async function makeRequestSepolia() {
  // Load source
  const source = fs.readFileSync(
    path.join(__dirname, "source.js"),
    "utf8"
  );

  const args = ["BTCUSDT"];

  const secrets = {
    ASTER_API_KEY: process.env.ASTER_API_KEY,
    ASTER_API_SECRET_KEY: process.env.ASTER_API_SECRET_KEY,
  };

  if (!secrets.ASTER_API_KEY || !secrets.ASTER_API_SECRET_KEY) {
    throw new Error("ASTER secrets missing in .env");
  }

  const slotId = 0;
  const expirationMinutes = 15;
  const gasLimit = 300_000;

  // Provider & signer
  const provider = new ethers.providers.JsonRpcProvider(
    process.env.ETHEREUM_SEPOLIA_RPC_URL
  );

  const signer = new ethers.Wallet(
    process.env.PRIVATE_KEY,
    provider
  );

  // ---------- SIMULATION ----------
  console.log("🔎 Simulating Functions source...");

  const sim = await simulateScript({
    source,
    args,
    secrets,
  });

  if (sim.errorString) {
    throw new Error(sim.errorString);
  }

  const simDecoded = decodeResult(
    sim.responseBytesHexstring,
    ReturnType.string
  );

  console.log("✅ Simulation output:", simDecoded);

  // ---------- COST ESTIMATION ----------
  console.log("\n💰 Estimating request cost...");

  const subManager = new SubscriptionManager({
    signer,
    linkTokenAddress: LINK_TOKEN_ADDRESS,
    functionsRouterAddress: ROUTER_ADDRESS,
  });

  await subManager.initialize();

  const gasPriceWei = await signer.getGasPrice();

  const estimatedCost = await subManager.estimateFunctionsRequestCost({
    donId: DON_ID,
    subscriptionId,
    callbackGasLimit: gasLimit,
    gasPriceWei: BigInt(gasPriceWei),
  });

  console.log(
    "Estimated LINK cost:",
    ethers.utils.formatEther(estimatedCost)
  );

  // ---------- SECRETS ----------
  console.log("\n🔐 Uploading encrypted secrets...");

  const secretsManager = new SecretsManager({
    signer,
    functionsRouterAddress: ROUTER_ADDRESS,
    donId: DON_ID,
  });

  await secretsManager.initialize();

  const encrypted = await secretsManager.encryptSecrets(secrets);

  const upload = await secretsManager.uploadEncryptedSecretsToDON({
    encryptedSecretsHexstring: encrypted.encryptedSecrets,
    gatewayUrls: GATEWAY_URLS,
    slotId,
    minutesUntilExpiration: expirationMinutes,
  });

  if (!upload.success) {
    throw new Error("Secrets upload failed");
  }

  console.log("✅ Secrets uploaded. Version:", upload.version);

  // ---------- SEND REQUEST ----------
  const consumer = new ethers.Contract(
    consumerAddress,
    functionsConsumerAbi,
    signer
  );

  const tx = await consumer.sendRequest(
    source,
    "0x",
    slotId,
    Number(upload.version),
    args,
    [],
    subscriptionId,
    gasLimit,
    ethers.utils.formatBytes32String(DON_ID)
  );

  console.log(
    `\n🚀 Request sent: ${EXPLORER_URL}/tx/${tx.hash}`
  );

  // ---------- LISTEN ----------
  const listener = new ResponseListener({
    provider,
    functionsRouterAddress: ROUTER_ADDRESS,
  });

  const response = await listener.listenForResponseFromTransaction(tx.hash);

  console.log("\n📬 Fulfillment code:", response.fulfillmentCode);

  if (response.errorString) {
    console.error("❌ Execution error:", response.errorString);
    return;
  }

  const decoded = decodeResult(
    response.responseBytesHexstring,
    ReturnType.string
  );

  console.log("✅ Final decoded response:", decoded);
}

makeRequestSepolia().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
