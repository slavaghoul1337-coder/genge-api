// api/verifyOwnership.js
import { ethers } from "ethers";
import fetch from "node-fetch";
import dotenv from "dotenv";
dotenv.config();

// In-memory used txs (module scope) — OK for single-instance; use Redis/DB in prod
const usedTxs = new Set();

// Minimal ABIs / interfaces
const ERC721_IFACE = new ethers.Interface([
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
  "function ownerOf(uint256 tokenId) view returns (address)"
]);

const ERC1155_IFACE = new ethers.Interface([
  "event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)",
  "event TransferBatch(address indexed operator, address indexed from, address indexed to, uint256[] ids, uint256[] values)"
]);

// helper: x402 check
async function x402CheckPayment(txHash, wallet, tokenId) {
  try {
    if (!process.env.X402_API || !process.env.X402_API_KEY) return false;
    const resp = await fetch(process.env.X402_API, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.X402_API_KEY}`
      },
      body: JSON.stringify({ txHash, wallet, tokenId })
    });
    if (!resp.ok) return false;
    const data = await resp.json();
    return data?.success === true;
  } catch (err) {
    console.error("x402CheckPayment error:", err);
    return false;
  }
}

// Main handler — Vercel will call this for POST /api/verifyOwnership
export default async function handler(req, res) {
  try {
    // Allow only POST
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    // Debug helpful logs (will appear in Vercel logs)
    console.log("DEBUG headers:", req.headers);
    console.log("DEBUG raw body:", req.body);

    const { wallet, tokenId, txHash } = req.body ?? {};

    if (!wallet || tokenId === undefined || !txHash) {
      return res.status(400).json({ error: "Missing wallet, tokenId or txHash", receivedBody: req.body });
    }

    if (usedTxs.has(txHash)) {
      return res.status(400).json({ error: "Transaction already used", txHash });
    }

    // Prepare provider / contracts
    const RPC_URL = process.env.RPC_URL;
    const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS;

    if (!RPC_URL || !CONTRACT_ADDRESS) {
      return res.status(500).json({ error: "Server misconfiguration: RPC_URL or CONTRACT_ADDRESS not set" });
    }

    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const contract = new ethers.Contract(CONTRACT_ADDRESS, [
      "function balanceOf(address owner, uint256 tokenId) view returns (uint256)"
    ], provider);

    const erc721Contract = new ethers.Contract(CONTRACT_ADDRESS, [
      "function ownerOf(uint256 tokenId) view returns (address)"
    ], provider);

    // 1) x402 (optional)
    const paymentOk = await x402CheckPayment(txHash, wallet, tokenId);

    // 2) balanceOf (ERC-1155-like) check
    let ownsNFT = false;
    try {
      const balance = await contract.balanceOf(wallet, tokenId);
      ownsNFT = balance && balance.toString() !== "0";
    } catch (e) {
      // balanceOf might not exist for ERC-721 — ignore
      console.warn("balanceOf check failed:", e?.message?.slice?.(0,200));
      ownsNFT = false;
    }

    // 3) Check transaction -> receipt -> logs -> ownerOf fallback
    let transferVerified = false;
    let txTo = null;

    try {
      const tx = await provider.getTransaction(txHash);
      if (!tx) {
        console.warn("Transaction not found:", txHash);
      } else {
        txTo = tx.to ? tx.to.toLowerCase() : null;
        // receipt
        const receipt = await provider.getTransactionReceipt(txHash);
        if (receipt && receipt.status && receipt.status !== 1) {
          console.warn("Transaction exists but failed (status != 1):", receipt.status);
        } else if (receipt && receipt.logs) {
          const addr = CONTRACT_ADDRESS.toLowerCase();
          for (const log of receipt.logs) {
            if (!log.address) continue;
            if (log.address.toLowerCase() !== addr) continue;

            // try parse ERC-721 Transfer
            try {
              const parsed = ERC721_IFACE.parseLog(log);
              if (parsed && parsed.name === "Transfer") {
                const to = parsed.args[1];
                const tid = parsed.args[2].toString();
                if (tid === tokenId.toString() && to.toLowerCase() === wallet.toLowerCase()) {
                  transferVerified = true;
                  break;
                }
              }
            } catch (e) { /* ignore */ }

            // try parse ERC-1155 events
            try {
              const parsed1155 = ERC1155_IFACE.parseLog(log);
              if (parsed1155) {
                if (parsed1155.name === "TransferSingle") {
                  const to = parsed1155.args[3];
                  const id = parsed1155.args[4].toString();
                  const value = parsed1155.args[5]?.toString?.() || "0";
                  if (id === tokenId.toString() && to.toLowerCase() === wallet.toLowerCase() && value !== "0") {
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
            } catch (e) { /* ignore */ }
          }
        }

        // fallback: ownerOf for ERC-721
        if (!transferVerified) {
          try {
            const owner = await erc721Contract.ownerOf(tokenId);
            if (owner && owner.toLowerCase() === wallet.toLowerCase()) {
              transferVerified = true;
            }
          } catch (e) {
            // token may not exist or not ERC-721; ignore
          }
        }
      }
    } catch (err) {
      console.warn("Error checking tx/receipt/logs:", err?.message?.slice?.(0,200));
    }

    const verified = paymentOk || ownsNFT || transferVerified;

    if (!verified) {
      return res.status(402).json({
        error: "Payment required or invalid",
        details: { paymentOk, ownsNFT, transferVerified, txTo, expected: { payTo: process.env.PAY_TO, contractAddress: CONTRACT_ADDRESS } }
      });
    }

    // mark tx as used
    usedTxs.add(txHash);

    // prepare x402-style response
    const response = {
      x402Version: 1,
      payer: wallet,
      accepts: [
        {
          scheme: "exact",
          network: "base",
          maxAmountRequired: "2",
          resource: (process.env.BASE_URL || `https://${req.headers.host}`) + "/api/verifyOwnership",
          description: "Verify ownership of GENGE NFT or payment transaction",
          mimeType: "application/json",
          payTo: process.env.PAY_TO,
          maxTimeoutSeconds: 10,
          asset: "USDC",
          outputSchema: {
            input: { type: "http", method: "POST" },
            output: { success: true }
          }
        }
      ]
    };

    // add output details
    response.accepts[0].outputSchema.output = {
      wallet,
      tokenId,
      verified: true,
      message: "Ownership or payment verified"
    };

    return res.status(200).json(response);

  } catch (err) {
    console.error("Handler error:", err);
    return res.status(500).json({ error: "Server error", message: err?.message });
  }
}
