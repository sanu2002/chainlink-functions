// source.js — Chainlink Functions runtime
// Fetches user position from Aster using signed request

const BASE_URL = "https://fapi.asterdex.com";

/**
 * args[0] -> symbol (e.g. BTCUSDT)
 */
if (!args || args.length < 1) {
  throw Error("symbol argument missing");
}

const symbol = args[0];

// ===== SECRETS (securely injected by DON) =====
if (!secrets.ASTER_API_KEY || !secrets.ASTER_API_SECRET_KEY) {
  throw Error("ASTER API secrets not set");
}

const API_KEY = secrets.ASTER_API_KEY;
const API_SECRET = secrets.ASTER_API_SECRET_KEY;

// ===== SIGN REQUEST (WebCrypto ONLY) =====
const encoder = new TextEncoder();
const timestamp = Date.now().toString();
const query = `symbol=${symbol}&timestamp=${timestamp}`;  // Note: Adding 'symbol' to query filters API response to this pair only (reduces size further)

// Import HMAC key
const key = await crypto.subtle.importKey(
  "raw",
  encoder.encode(API_SECRET),
  { name: "HMAC", hash: "SHA-256" },
  false,
  ["sign"]
);

// Sign query
const signatureBuffer = await crypto.subtle.sign(
  "HMAC",
  key,
  encoder.encode(query)
);

// Convert signature to hex
const signature = Array.from(new Uint8Array(signatureBuffer))
  .map(b => b.toString(16).padStart(2, "0"))
  .join("");

// ===== REQUEST =====
const url = `${BASE_URL}/fapi/v2/positionRisk?${query}&signature=${signature}`;

const response = await fetch(url, {
  method: "GET",
  headers: {
    "X-MBX-APIKEY": API_KEY,
    "Content-Type": "application/json",
  },
});

// Read body safely
const bodyText = await response.text();

if (!response.ok) {
  throw Error(`Aster API error ${response.status}: ${bodyText}`);
}

const data = JSON.parse(bodyText);

// ===== TRIM RESPONSE TO FIT 256-BYTE LIMIT =====
// Filter to only this symbol's position (data is array of positions)
const position = Array.isArray(data) ? data.find(p => p.symbol === symbol) : null;

// Select only essential fields (adjust as needed; keeps JSON <150 bytes)
const trimmedData = position ? {
  symbol: position.symbol,
  positionSide: position.positionSide,
  entryPrice: position.entryPrice,
  markPrice: position.markPrice,
  unRealizedProfit: position.unRealizedProfit || "0",
  positionAmount: position.positionAmount || "0",  // Or positionAmt if API uses that
  leverage: position.leverage
} : { symbol, error: "No position found" };

// ===== RETURN =====
// ⚠️ Compact stringify ensures minimal size
return Functions.encodeString(
  JSON.stringify(trimmedData)  // No replacer/space args = compact
);