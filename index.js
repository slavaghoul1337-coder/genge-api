import express from "express";
import serverless from "serverless-http";
import cors from "cors";
import { ethers } from "ethers";
import fetch from "node-fetch";
import dotenv from "dotenv";
dotenv.config();

// Create express app
const app = express();
app.use(cors());
app.use(express.json());

// Provider and contracts
const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
const contract = new ethers.Contract(process.env.CONTRACT_ADDRESS, [
  "function balanceOf(address owner, uint256 tokenId) view returns (uint256)"
], provider);

// Interfaces
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
    const r = await fetch(process.env.X402_API, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.X402_API_KEY}`
      },
      body: JSON.stringify({ txHash, wallet, tokenId })
    });
    const data = await r.json();
    return data.success === true;
  } catch (e) {
    console.error("x402CheckPayment error:", e);
    return false;
  }
}

app.post("/verifyOwnership", async (req, res) => {
  console.log("DEBUG request body:", req.body);

  const { wallet, tokenId, txHash } = req.body || {};

  if (!wallet || tokenId === undefined || !txHash) {
    return res.status(400).json({
      error: "Missing wallet, tokenId or txHash",
      received: req.body
    });
  }

  if (usedTxs.has(txHash)) {
    return res.status(400).json({ error: "Tx already used" });
  }

  // x402
  const paymentOk = await x402CheckPayment(txHash, wallet, tokenId);

  // Balance check
  let ownsNFT = false;
  try {
    const balance = await contract.balanceOf(wallet, tokenId);
    ownsNFT = balance.toString() !== "0";
  } catch (err) {}

  let transferVerified = false;
  const tx = await provider.getTransaction(txHash);

  if (tx) {
    const receipt = await provider.getTransactionReceipt(txHash);
    if (receipt && receipt.logs) {
      const addr = process.env.CONTRACT_ADDRESS.toLowerCase();
      for (const log of receipt.logs) {
        if (!log.address || log.address.toLowerCase() !== addr) continue;
        try {
          const p = ERC721_IFACE.parseLog(log);
          if (p.name === "Transfer" &&
              p.args[1].toLowerCase() === wallet.toLowerCase() &&
              p.args[2].toString() === tokenId.toString()) {
            transferVerified = true;
            break;
          }
        } catch {}
        try {
          const p2 = ERC1155_IFACE.parseLog(log);
          if (p2 && p2.name === "TransferSingle") {
            if (p2.args[3].toLowerCase() === wallet.toLowerCase() &&
                p2.args[4].toString() === tokenId.toString() &&
                p2.args[5].toString() !== "0") {
              transferVerified = true;
              break;
            }
          }
        } catch {}
      }
    }
  }

  const verified = paymentOk || ownsNFT || transferVerified;
  if (!verified) {
    return res.status(402).json({ verified, paymentOk, ownsNFT, transferVerified });
  }

  usedTxs.add(txHash);
  return res.json({ verified: true, wallet, tokenId });
});

// VERCEL EXPORT
export default serverless(app);
