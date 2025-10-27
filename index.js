import express from "express";
import cors from "cors";
import { ethers } from "ethers";
import fetch from "node-fetch";
import dotenv from "dotenv";
dotenv.config();

const app = express();
app.use(cors());
app.use((req, res, next) => {
  let raw = '';
  req.on('data', chunk => { raw += chunk; });
  req.on('end', () => {
    console.log('--- RAW REQUEST START ---');
    console.log('method:', req.method);
    console.log('url:', req.url);
    console.log('headers:', JSON.stringify(req.headers, null, 2));
    console.log('rawBody (first 2000 chars):', raw.slice(0, 2000));
    console.log('--- RAW REQUEST END ---');
    // положим сырое тело в req.rawBody для диагностики (не переопределяем req.body)
    req.rawBody = raw;
    next();
  });
});
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

// In-memory set for used txs (replace with Redis/DB in prod)
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
    // Top-level debug: request body + presence of key env vars (no secrets)
    console.log("DEBUG request body:", JSON.stringify(req.body).slice(0,2000));
    console.log("DEBUG env keys present:", {
      RPC_URL: !!process.env.RPC_URL,
      CONTRACT_ADDRESS: !!process.env.CONTRACT_ADDRESS,
      PAY_TO: !!process.env.PAY_TO,
      X402_API: !!process.env.X402_API,
      X402_API_KEY: !!process.env.X402_API_KEY,
      PORT: !!process.env.PORT,
    });

    const { wallet, tokenId, txHash } = req.body;
    if (!wallet || tokenId === undefined || !txHash) {
      return res.status(400).json({
        error: "Missing wallet, tokenId or txHash",
        receivedBody: req.body
      });
    }

    if (usedTxs.has(txHash)) {
      return res.status(400).json({ error: "Transaction already used", txHash });
    }

    // 1) Optional check with x402 façade
    const paymentOk = await x402CheckPayment(txHash, wallet, tokenId);

    // 2) balanceOf (ERC-1155 style) check
    let ownsNFT = false;
    try {
      const balance = await contract.balanceOf(wallet, tokenId);
      ownsNFT = balance && balance.toString() !== "0";
    } catch (err) {
      console.warn("balanceOf failed (maybe not ERC-1155):", err?.message?.slice?.(0,200));
      ownsNFT = false;
    }

    // 3) Parse tx/receipt/logs — most reliable confirmation path
    let transferVerified = false;
    let txTo = null;
    try {
      const tx = await provider.getTransaction(txHash);
      if (!tx) {
        console.warn("Transaction not found on RPC for hash:", txHash);
      } else {
        // debug tx basic
        console.log("DEBUG tx:", { hash: tx.hash, from: tx.from, to: tx.to, dataHead: tx.data?.slice?.(0,200) });

        txTo = tx.to ? tx.to.toLowerCase() : null;
        const payTo = process.env.PAY_TO ? process.env.PAY_TO.toLowerCase() : null;
        const contractAddrLower = process.env.CONTRACT_ADDRESS ? process.env.CONTRACT_ADDRESS.toLowerCase() : null;

        // Tolerant behavior: don't fail immediately if tx.to differs — many mints use factories/relayers.
        if (txTo && payTo && txTo !== payTo && contractAddrLower && txTo !== contractAddrLower) {
          console.warn(`tx.to (${txTo}) != PAY_TO (${payTo}) and != CONTRACT_ADDRESS (${contractAddrLower}). Continuing with logs/ownerOf checks.`);
        }

        if (tx.from && tx.from.toLowerCase() !== wallet.toLowerCase()) {
          console.warn(`tx.from (${tx.from}) != wallet (${wallet}) — possible relayer/factory flow.`);
        }

        const receipt = await provider.getTransactionReceipt(txHash);
        if (!receipt) {
          console.warn("Receipt not found yet for", txHash);
        } else if (receipt.status && receipt.status !== 1) {
          console.warn("Transaction failed (status != 1)", receipt.status);
        } else {
          // scan logs from our contract address
          for (const log of receipt.logs) {
            if (!log.address) continue;
            if (!contractAddrLower) continue;
            if (log.address.toLowerCase() !== contractAddrLower) continue;

            // try ERC-721 Transfer
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
              // not an ERC-721 log — ignore
            }

            // try ERC-1155 TransferSingle / TransferBatch
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
              // not an ERC-1155 log — ignore
            }
          }

          // Final fallback: ownerOf for ERC-721
          if (!transferVerified) {
            try {
              const owner = await erc721Contract.ownerOf(tokenId);
              if (owner && owner.toLowerCase() === wallet.toLowerCase()) {
                transferVerified = true;
              }
            } catch (e) {
              // ownerOf may throw if token doesn't exist — ignore
            }
          }
        }
      }
    } catch (err) {
      console.warn("Error while checking tx/receipt/logs:", err?.message?.slice?.(0,200));
    }

    const verified = paymentOk || ownsNFT || transferVerified;

    if (!verified) {
      return res.status(402).json({
        error: "Payment required or invalid",
        details: { paymentOk, ownsNFT, transferVerified, txTo, expected: { payTo: process.env.PAY_TO, contractAddress: process.env.CONTRACT_ADDRESS } }
      });
    }

    // mark tx as used
    usedTxs.add(txHash);

    const response = makeResourceDescription(
      process.env.BASE_URL || "https://genge-api.vercel.app",
      wallet,
      verified
    );

    response.accepts[0].outputSchema.output.wallet = wallet;
    response.accepts[0].outputSchema.output.tokenId = tokenId;
    response.accepts[0].outputSchema.output.verified = true;
    response.accepts[0].outputSchema.output.message = "Ownership or payment verified";

    return res.status(200).json(response);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Server error", message: err?.message });
  }
});

app.listen(process.env.PORT || 3000, () => {
  console.log(`GENGE API running on port ${process.env.PORT || 3000}`);
});