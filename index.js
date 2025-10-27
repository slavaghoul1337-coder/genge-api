import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fetch from "node-fetch";
import { ethers } from "ethers";

dotenv.config();

const app = express();
app.use(cors());

// Универсальный парсер тела (надёжно работает на Vercel / Windows curl)
app.use((req, res, next) => {
  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", () => {
    if (!raw) {
      req.body = {};
      return next();
    }
    try {
      // trim + убираем BOM
      raw = raw.trim().replace(/^\uFEFF/, "");
      if (req.headers["content-type"]?.includes("application/json")) {
        req.body = JSON.parse(raw);
      } else {
        // если не JSON - пустой объект
        req.body = {};
      }
      next();
    } catch (e) {
      console.error("JSON parse error:", e.message);
      res.status(400).send("Bad JSON Format");
    }
  });
});

// Настройки и провайдер
const PORT = process.env.PORT || 3000;
const RPC_URL = process.env.RPC_URL;
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS;
const X402_API = process.env.X402_API; // например https://x402.dev/api/checkPayment
const X402_API_KEY = process.env.X402_API_KEY;
const PAY_TO = process.env.PAY_TO;

// Проверки конфигурации
if (!RPC_URL || !CONTRACT_ADDRESS || !PAY_TO) {
  console.warn("WARNING: RPC_URL, CONTRACT_ADDRESS or PAY_TO is missing in env");
}

// Инициализация ethers провайдера и контракта (ABI для ERC-1155/721-style balanceOf(tokenId) assumed)
const provider = new ethers.JsonRpcProvider(RPC_URL);
const abi = [
  // balanceOf(address owner, uint256 tokenId) => common for ERC-1155
  "function balanceOf(address owner, uint256 tokenId) view returns (uint256)"
];
const contract = new ethers.Contract(CONTRACT_ADDRESS, abi, provider);

// Простое in-memory хранилище использованных txHash (для production — замените на БД)
const usedTxs = new Set();

// Проверка платежа через x402 фасилитатора
async function x402CheckPayment(txHash, wallet, tokenId) {
  if (!X402_API || !X402_API_KEY) {
    console.error("x402 API or key not configured");
    return false;
  }

  try {
    const resp = await fetch(X402_API, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${X402_API_KEY}`
      },
      body: JSON.stringify({ txHash, wallet, tokenId })
    });

    // валидация ответа фасилитатора
    const data = await resp.json();
    // ожидаем структуру { success: true, ... } или { success: false, ... }
    return data && data.success === true;
  } catch (err) {
    console.error("x402 check error:", err);
    return false;
  }
}

// RESOURCE_DESCRIPTION — строго типизированный для x402scan (GET должен отдавать 402)
function makeResourceDescription(baseUrl) {
  return {
    x402Version: 1,
    payer: "0x0000000000000000000000000000000000000000",
    accepts: [
      {
        scheme: "exact",
        network: "base",
        maxAmountRequired: "2", // строка
        resource: `${baseUrl}/verifyOwnership`,
        description: "Verify ownership of GENGE NFT or payment transaction",
        mimeType: "application/json",
        payTo: PAY_TO,
        maxTimeoutSeconds: 10,
        asset: "USDC",
        outputSchema: {
          input: {
            type: "http",
            method: "POST",
            bodyType: "json",
            bodyFields: {
              wallet: { type: "string", required: ["wallet"], description: "Wallet address" },
              tokenId: { type: "number", required: ["tokenId"], description: "NFT tokenId" },
              txHash: { type: "string", required: ["txHash"], description: "Transaction hash" }
            }
          },
          output: {
            success: { type: "boolean" },
            message: { type: "string" }
          }
        },
        extra: {
          provider: "GENGE",
          category: "Verification",
          homepage: baseUrl
        }
      }
    ]
  };
}

// GET /verifyOwnership — x402scan expects a 402 with resource description
app.get("/verifyOwnership", (req, res) => {
  // базовый url — лучше задать явно (в ENV) или собрать из хоста
  const BASE_URL = process.env.PUBLIC_URL || `https://${req.headers.host}`;
  const desc = makeResourceDescription(BASE_URL);
  res.status(402).json(desc);
});

// POST /verifyOwnership — real verification
app.post("/verifyOwnership", async (req, res) => {
  try {
    const { wallet, tokenId, txHash } = req.body || {};

    if (!wallet || tokenId === undefined || !txHash) {
      return res.status(400).json({ error: "Missing wallet, tokenId or txHash" });
    }

    // 1) Проверяем, не использован ли txHash
    if (usedTxs.has(txHash)) {
      return res.status(400).json({ error: "Transaction already used" });
    }

    // 2) Проверяем транзакцию через x402 фасилитатора
    const paymentOk = await x402CheckPayment(txHash, wallet, tokenId);
    if (!paymentOk) {
      return res.status(402).json({ error: "Payment required or invalid" });
    }

    // 3) Проверяем владение NFT через контракт
    let balance;
    try {
      balance = await contract.balanceOf(wallet, tokenId);
    } catch (err) {
      console.error("contract.balanceOf error:", err);
      return res.status(500).json({ error: "Contract read error" });
    }

    // ethers BigInt-like object; приводим к числу безопасно для малых значений
    const has = (typeof balance === "bigint") ? (balance > 0n) : (Number(balance) > 0);

    if (!has) {
      return res.status(402).json({ error: "NFT not owned" });
    }

    // 4) Логируем txHash как использованный
    usedTxs.add(txHash);
    // Для production: записать в БД (Postgres/Redis) с отметкой времени, чтобы избежать повторного использования.

    // 5) Формируем X402Response успешной валидации
    const BASE_URL = process.env.PUBLIC_URL || `https://${req.headers.host}`;
    const desc = makeResourceDescription(BASE_URL);
    const successResp = {
      ...desc,
      payer: wallet,
      accepts: desc.accepts.map((a) => ({
        ...a,
        outputSchema: {
          ...a.outputSchema,
          output: {
            success: true,
            wallet,
            tokenId,
            verified: true,
            message: "Ownership and payment verified"
          }
        }
      }))
    };

    return res.status(200).json(successResp);

  } catch (err) {
    console.error("Server error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// Health
app.get("/", (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`GENGE API running on port ${PORT}`);
});
