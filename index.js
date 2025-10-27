import express from "express";
import cors from "cors";
import { ethers } from "ethers";
import fetch from "node-fetch";
import dotenv from "dotenv";
dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// Провайдер и контракт
const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
const abi = [
  "function balanceOf(address owner, uint256 tokenId) view returns (uint256)"
];
const contract = new ethers.Contract(process.env.CONTRACT_ADDRESS, abi, provider);

// Хранилище использованных txHash
const usedTxs = new Set();

// Проверка платежа через x402 фасилитатора
async function x402CheckPayment(txHash, wallet, tokenId) {
  try {
    const resp = await fetch(`${process.env.X402_API}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.X402_API_KEY}`
      },
      body: JSON.stringify({ txHash, wallet, tokenId })
    });
    const data = await resp.json();
    return data.success === true;
  } catch (err) {
    console.error("x402CheckPayment error:", err);
    return false;
  }
}

// Формирование валидного X402Response
function makeResourceDescription(baseUrl, wallet, verified = false) {
  return {
    x402Version: 1,
    payer: wallet,
    accepts: [
      {
        scheme: "exact",
        network: "base",
        maxAmountRequired: "2",
        resource: `${baseUrl}/verifyOwnership`,
        description: "Verify ownership of GENGE NFT or payment transaction",
        mimeType: "application/json",
        payTo: process.env.PAY_TO,
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
            wallet: { type: "string" },
            tokenId: { type: "number" },
            verified: { type: "boolean" },
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

// Endpoint проверки владения NFT и оплаты
app.post("/verifyOwnership", async (req, res) => {
  try {
    const { wallet, tokenId, txHash } = req.body;
    if (!wallet || tokenId === undefined || !txHash) {
      return res.status(400).json({ error: "Missing wallet, tokenId or txHash" });
    }

    // Проверка, что txHash ещё не использован
    if (usedTxs.has(txHash)) {
      return res.status(400).json({ error: "Transaction already used" });
    }

    // Проверка через x402 фасилитатор
    const paymentOk = await x402CheckPayment(txHash, wallet, tokenId);

    // Проверка владения NFT через контракт
    const balance = await contract.balanceOf(wallet, tokenId);
    const ownsNFT = balance > 0;

    const verified = paymentOk || ownsNFT;

    if (!verified) {
      return res.status(402).json({ error: "Payment required or invalid" });
    }

    // Логируем транзакцию
    usedTxs.add(txHash);

    // Формируем X402Response
    const response = makeResourceDescription(
      "https://genge-api.vercel.app",
      wallet,
      verified
    );

    // Вставляем результат в output
    response.accepts[0].outputSchema.output.wallet = wallet;
    response.accepts[0].outputSchema.output.tokenId = tokenId;
    response.accepts[0].outputSchema.output.verified = true;
    response.accepts[0].outputSchema.output.message = "Ownership verified";

    res.status(200).json(response);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

app.listen(process.env.PORT, () => {
  console.log(`GENGE API running on port ${process.env.PORT}`);
});
