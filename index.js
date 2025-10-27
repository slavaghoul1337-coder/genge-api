import express from "express";
import serverless from "serverless-http";
import fetch from "node-fetch";
import { ethers } from "ethers";

const app = express();
app.use(express.json());

// env
const { RPC_URL, CONTRACT_ADDRESS, X402_API, X402_API_KEY, PAY_TO } = process.env;

if (!RPC_URL || !CONTRACT_ADDRESS || !X402_API || !X402_API_KEY || !PAY_TO) {
  console.error("❌ One or more environment variables are missing!");
}

// endpoint
app.post("/verifyOwnership", async (req, res) => {
  try {
    console.log("DEBUG request body:", req.body);

    const { wallet, tokenId, txHash } = req.body;
    if (!wallet || !tokenId || !txHash) {
      return res.status(400).json({ error: "Missing parameters" });
    }

    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const tx = await provider.getTransaction(txHash);

    if (!tx) {
      return res.status(400).json({ error: "Transaction not found" });
    }

    if (tx.to.toLowerCase() !== PAY_TO.toLowerCase()) {
      return res.status(400).json({ error: "Transaction sent to wrong address" });
    }

    const x402Response = await fetch(`${X402_API}?wallet=${wallet}&tokenId=${tokenId}`, {
      headers: { "x-api-key": X402_API_KEY },
    });

    const data = await x402Response.json();
    if (!data.success) {
      return res.status(400).json({ error: "X402 API check failed", details: data });
    }

    res.json({ success: true });

  } catch (err) {
    console.error("Server error:", err);
    res.status(500).json({ error: "Server error", message: err.message });
  }
});

// ✅ Vercel-friendly export
export const handler = serverless(app);
export default app;
