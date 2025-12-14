const fs = require("fs");
const path = require("path");
const {
  SubscriptionManager,
  SecretsManager,
  simulateScript,
  ResponseListener,
  buildRequestCBOR,
  ReturnType,
  decodeResult,
  Location,
  CodeLanguage,
  FulfillmentCode,
} = require("@chainlink/functions-toolkit");
const functionsConsumerAbi = require("../../abi/functionsClient.json");
const ethers = require("ethers");
require("@chainlink/env-enc").config();
require("dotenv").config();

console.log("PK exists?", !!process.env.PRIVATE_KEY);
console.log("RPC exists?", !!process.env.SEPOLIA_RPC_URL);

// REPLACE these with your actual values
const consumerAddress = "0xf7175fa8AEFfB11895f7c4c3A5f80EaA368110d4"; // Your Functions consumer contract address
const subscriptionId = 6044; // Your Functions subscription ID

const makeRequestSepolia = async () => {
  // Hardcoded for Ethereum Sepolia
  const routerAddress = "0xb83E47C2bC239B3bf370bc41e1459A34b41238D0";
  const linkTokenAddress = "0x779877A7B0D9E8603169DdbD7836e478b4624789";
  const donId = "fun-ethereum-sepolia-1";
  const explorerUrl = "https://sepolia.etherscan.io";
  const gatewayUrls = [
    "https://01.functions-gateway.testnet.chain.link/",
    "https://02.functions-gateway.testnet.chain.link/",
  ];

  // Load source and args
  const source = fs
    .readFileSync(path.resolve(__dirname, "./source.js"))
    .toString();

  const args = ["BTCUSDT"];
  const secrets = {
    ASTER_API_KEY: process.env.ASTER_API_KEY,
    ASTER_API_SECRET_KEY: process.env.ASTER_API_SECRET_KEY,
  };

  // Check secrets early for simulation
  if (!secrets.ASTER_API_KEY || !secrets.ASTER_API_SECRET_KEY) {
    throw new Error("ASTER API secrets missing - check .env for ASTER_API_KEY and ASTER_API_SECRET_KEY");
  }

  const slotIdNumber = 0; // Slot ID for secrets
  const expirationTimeMinutes = 15; // Secrets expiration
  const gasLimit = 300000; // Adjustable gas limit

  // Initialize ethers signer/provider
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) {
    throw new Error("PRIVATE_KEY not provided - check your .env");
  }

  const rpcUrl = process.env.SEPOLIA_RPC_URL;
  if (!rpcUrl) {
    throw new Error("SEPOLIA_RPC_URL not provided - check your .env");
  }

  const provider = new ethers.providers.JsonRpcProvider(rpcUrl);
  const wallet = new ethers.Wallet(privateKey);
  const signer = wallet.connect(provider);

  ///////// START SIMULATION ////////////
  console.log("Starting simulation...");
  const response = await simulateScript({
    source: source,
    args: args,
    bytesArgs: [], // Optional: off-chain bytes args
    secrets: secrets,
  });

  console.log("Simulation result:", response);
  const errorString = response.errorString;
  if (errorString) {
    console.error(`❌ Simulation error: ${errorString}`);
    return; // Exit early on sim error
  } else {
    // Decode as STRING (matches source.js return type)
    const returnType = ReturnType.string;
    const responseBytesHexstring = response.responseBytesHexstring;
    if (ethers.utils.arrayify(responseBytesHexstring).length > 0) {
      const decodedResponse = decodeResult(responseBytesHexstring, returnType);
      console.log(`✅ Simulated response (string):`, decodedResponse);
      try {
        const parsed = JSON.parse(decodedResponse);
        console.log(`✅ Parsed JSON:`, parsed); // e.g., { symbol: 'BTCUSDT', positions: [...] }
      } catch (e) {
        console.warn("⚠️ Response is string but not valid JSON:", e.message);
      }
    }
  }

  //////// ESTIMATE REQUEST COSTS ////////
  console.log("\nEstimating request costs...");
  const subscriptionManager = new SubscriptionManager({
    signer: signer,
    linkTokenAddress: linkTokenAddress,
    functionsRouterAddress: routerAddress,
  });
  await subscriptionManager.initialize();

  const gasPriceWei = await signer.getGasPrice();
  const estimatedCostInJuels = await subscriptionManager.estimateFunctionsRequestCost({
    donId: donId,
    subscriptionId: subscriptionId,
    callbackGasLimit: gasLimit,
    gasPriceWei: BigInt(gasPriceWei),
  });

  console.log(`Estimated cost: ${ethers.utils.formatEther(estimatedCostInJuels)} LINK`);

  //////// MAKE REQUEST ////////
  console.log("\nMaking request...");

  // Encrypt and upload secrets
  const secretsManager = new SecretsManager({
    signer: signer,
    functionsRouterAddress: routerAddress,
    donId: donId,
  });
  await secretsManager.initialize();

  const encryptedSecretsObj = await secretsManager.encryptSecrets(secrets);
  console.log(`Uploading encrypted secrets to gateways ${gatewayUrls.join(', ')} (slot ${slotIdNumber}, expires in ${expirationTimeMinutes}min)...`);
  
  const uploadResult = await secretsManager.uploadEncryptedSecretsToDON({
    encryptedSecretsHexstring: encryptedSecretsObj.encryptedSecrets,
    gatewayUrls: gatewayUrls,
    slotId: slotIdNumber,
    minutesUntilExpiration: expirationTimeMinutes,
  });

  if (!uploadResult.success) {
    throw new Error(`Failed to upload secrets to ${gatewayUrls.join(', ')}: ${JSON.stringify(uploadResult)}`);
  }

  console.log(`✅ Secrets uploaded! Version: ${uploadResult.version}`);
  const donHostedSecretsVersion = parseInt(uploadResult.version);
  const donHostedEncryptedSecretsReference = secretsManager.buildDONHostedEncryptedSecretsReference({
    slotId: slotIdNumber,
    version: donHostedSecretsVersion,
  });

  // Build and send request
  const functionsConsumer = new ethers.Contract(consumerAddress, functionsConsumerAbi, signer);
  const functionsRequestBytesHexString = buildRequestCBOR({
    codeLocation: Location.Inline,
    codeLanguage: CodeLanguage.JavaScript,
    secretsLocation: Location.DONHosted,
    source: source,
    encryptedSecretsReference: donHostedEncryptedSecretsReference,
    args: args,
    bytesArgs: [],
  });

  const transaction = await functionsConsumer.sendRequestCBOR(
    functionsRequestBytesHexString,
    subscriptionId,
    gasLimit,
    ethers.utils.formatBytes32String(donId)
  );

  console.log(`✅ Request sent! Tx hash: ${transaction.hash}`);
  console.log(`View on explorer: ${explorerUrl}/tx/${transaction.hash}`);

  // Listen for response
  const responseListener = new ResponseListener({
    provider: provider,
    functionsRouterAddress: routerAddress,
  });

  (async () => {
    try {
      const response = await new Promise((resolve, reject) => {
        responseListener
          .listenForResponseFromTransaction(transaction.hash)
          .then(resolve)
          .catch(reject);
      });

      const fulfillmentCode = response.fulfillmentCode;
      console.log(`\nFulfillment code: ${fulfillmentCode} | Cost: ${ethers.utils.formatEther(response.totalCostInJuels)} LINK`);

      if (fulfillmentCode === FulfillmentCode.FULFILLED) {
        console.log(`✅ Request ${response.requestId} fulfilled!`);
      } else if (fulfillmentCode === FulfillmentCode.USER_CALLBACK_ERROR) {
        console.log(`⚠️ Request ${response.requestId} fulfilled but callback failed.`);
      } else {
        console.log(`❌ Request ${response.requestId} failed with code ${fulfillmentCode}.`);
      }

      const errorString = response.errorString;
      if (errorString) {
        console.error(`❌ Execution error: ${errorString}`);
      } else {
        const responseBytesHexstring = response.responseBytesHexstring;
        if (ethers.utils.arrayify(responseBytesHexstring).length > 0) {
          // Decode as STRING
          const decodedResponse = decodeResult(responseBytesHexstring, ReturnType.string);
          console.log(`✅ On-chain response (string):`, decodedResponse);
          try {
            const parsed = JSON.parse(decodedResponse);
            console.log(`✅ Parsed JSON:`, parsed); // Your Aster positions data
          } catch (e) {
            console.warn("⚠️ Response is string but not valid JSON:", e.message);
          }
        }
      }
    } catch (error) {
      console.error("Error waiting for response:", error);
    }
  })();
};

makeRequestSepolia().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});