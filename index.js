import express from "express";
import cors from "cors";
import { ethers } from "ethers";
import fetch from "node-fetch";
import dotenv from "dotenv";
dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
const contract = new ethers.Contract(process.env.CONTRACT_ADDRESS, [
  "function balanceOf(address owner, uint256 tokenId) view returns (uint256)"
], provider);

const ERC721_IFACE = new ethers.Interface([
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
  "function ownerOf(uint256 tokenId) view returns (address)"
]);

const ERC1155_IFACE = new ethers.Interface([
  "event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)",
  "event TransferBatch(address indexed operator, address indexed from, address indexed to, uint256[] ids, uint256[] values)"
]);

const erc721Contract = new ethers.Contract(process.env.CONTRACT_ADDRESS, [
  "function ownerOf(uint256 tokenId) view returns (address)"
], provider);

const usedTxs = new Set();

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

app.post("/verifyOwnership", async (req, res) => {
  try {
    const { wallet, tokenId, txHash } = req.body;
    if (!wallet || tokenId === undefined || !txHash) {
      return res.status(400).json({ error: "Missing wallet, tokenId or txHash" });
    }

    if (usedTxs.has(txHash)) {
      return res.status(400).json({ error: "Transaction already used" });
    }

    const paymentOk = await x402CheckPayment(txHash, wallet, tokenId);

    let ownsNFT = false;
    try {
      const balance = await contract.balanceOf(wallet, tokenId);
      ownsNFT = balance && balance.toString() !== "0";
    } catch (err) {
      console.warn("balanceOf failed (maybe not ERC-1155):", err?.message?.slice?.(0,200));
      ownsNFT = false;
    }

    let transferVerified = false;
    try {
      const tx = await provider.getTransaction(txHash);
      if (!tx) {
        console.warn("Transaction not found on RPC for hash:", txHash);
      } else {
        if (tx.from && tx.from.toLowerCase() !== wallet.toLowerCase()) {
          console.warn(`tx.from (${tx.from}) != wallet (${wallet})`);
        }

        const receipt = await provider.getTransactionReceipt(txHash);
        if (!receipt) {
          console.warn("Receipt not found yet for", txHash);
        } else if (receipt.status && receipt.status !== 1) {
          console.warn("Transaction failed (status != 1)", receipt.status);
        } else {
          const contractAddrLower = process.env.CONTRACT_ADDRESS.toLowerCase();
          for (const log of receipt.logs) {
            if (!log.address) continue;
            if (log.address.toLowerCase() !== contractAddrLower) continue; // только логи от нашего контракта

            try {
              const parsed = ERC721_IFACE.parseLog(log);
              if (parsed && parsed.name === "Transfer") {
                const from = parsed.args[0];
                const to = parsed.args[1];
                const tid = parsed.args[2].toString();
                if (tid === tokenId.toString() && to.toLowerCase() === wallet.toLowerCase()) {
                  transferVerified = true;
                  break;
                }
              }
            } catch (e) {
            }

            try {
              const parsed1155 = ERC1155_IFACE.parseLog(log);
              if (parsed1155) {
                if (parsed1155.name === "TransferSingle") {
                  const to = parsed1155.args[3];
                  const id = parsed1155.args[4].toString();
                  const value = parsed1155.args[5]?.toString?.() || undefined;
                  if (id === tokenId.toString() && to.toLowerCase() === wallet.toLowerCase() && value && value !== "0") {
                    transferVerified = true;
                    break;
                  }
                }

                if (parsed1155.name === "TransferBatch") {
                  const to = parsed1155.args[3];
                  const ids = parsed1155.args[4].map((v) => v.toString());
                  const values = parsed1155.args[5].map((v) => v.toString());
                  const idx = ids.indexOf(tokenId.toString());
                  if (idx !== -1 && to.toLowerCase() === wallet.toLowerCase() && values[idx] !== "0") {
                    transferVerified = true;
                    break;
                  }
                }
              }
            } catch (e) {
            }
          }

          if (!transferVerified) {
            try {
              const owner = await erc721Contract.ownerOf(tokenId);
              if (owner && owner.toLowerCase() === wallet.toLowerCase()) {
                transferVerified = true;
              }
            } catch (e) {
            }
          }
        }
      }
    } catch (err) {
      console.warn("Error while checking tx/receipt/logs:", err?.message?.slice?.(0,200));
    }

    const verified = paymentOk || ownsNFT || transferVerified;

    if (!verified) {
      return res.status(402).json({ error: "Payment required or invalid", details: { paymentOk, ownsNFT, transferVerified } });
    }

    usedTxs.add(txHash);

    const response = makeResourceDescription(
      "https://genge-api.vercel.app",
      wallet,
      verified
    );

    response.accepts[0].outputSchema.output.wallet = wallet;
    response.accepts[0].outputSchema.output.tokenId = tokenId;
    response.accepts[0].outputSchema.output.verified = true;
    response.accepts[0].outputSchema.output.message = "Ownership or payment verified";

    res.status(200).json(response);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

app.listen(process.env.PORT || 3000, () => {
  console.log(`GENGE API running on port ${process.env.PORT || 3000}`);
});
