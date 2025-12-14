// Chainlink Functions runtime
// Securely fetches Aster user position using HMAC signature

const BASE_URL = "https://fapi.asterdex.com";

if (!args || args.length < 1) {
  throw Error("symbol argument missing");
}

const symbol = args[0];

// ---- Secrets ----
if (!secrets.ASTER_API_KEY || !secrets.ASTER_API_SECRET_KEY) {
  throw Error("ASTER API secrets not set");
}

const API_KEY = secrets.ASTER_API_KEY;
const API_SECRET = secrets.ASTER_API_SECRET_KEY;

// ---- HMAC signing (WebCrypto only) ----
const encoder = new TextEncoder();
const timestamp = Date.now().toString();
const query = `symbol=${symbol}&timestamp=${timestamp}`;

const key = await crypto.subtle.importKey(
  "raw",
  encoder.encode(API_SECRET),
  { name: "HMAC", hash: "SHA-256" },
  false,
  ["sign"]
);

const signatureBuffer = await crypto.subtle.sign(
  "HMAC",
  key,
  encoder.encode(query)
);

const signature = Array.from(new Uint8Array(signatureBuffer))
  .map((b) => b.toString(16).padStart(2, "0"))
  .join("");

// ---- Request ----
const url = `${BASE_URL}/fapi/v2/positionRisk?${query}&signature=${signature}`;

const response = await fetch(url, {
  method: "GET",
  headers: {
    "X-MBX-APIKEY": API_KEY,
    "Content-Type": "application/json",
  },
});

const bodyText = await response.text();

if (!response.ok) {
  throw Error(`Aster API error ${response.status}: ${bodyText}`);
}

const data = JSON.parse(bodyText);

// ---- Trim response ----
const position = Array.isArray(data)
  ? data.find((p) => p.symbol === symbol)
  : null;

const trimmed = position
  ? {
      symbol: position.symbol,
      positionSide: position.positionSide,
      entryPrice: position.entryPrice,
      markPrice: position.markPrice,
      unRealizedProfit: position.unRealizedProfit || "0",
      positionAmount: position.positionAmount || "0",
      leverage: position.leverage,
    }
  : { symbol, error: "No position found" };

// ---- Return (STRING) ----
return Functions.encodeString(JSON.stringify(trimmed));
