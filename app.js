require('dotenv').config();
const express = require('express');
const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());

// Load ABIs
const routerAbi = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'abi', 'IUniswapV3RouterABI.json'), 'utf8')
);
const quoterAbi = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'abi', 'IUniswapV3QuoterABI.json'), 'utf8')
);

// Environment variables
const RPC_URL = process.env.RPC_URL;
const UNISWAP_V3_ROUTER_ADDRESS = "0xE592427A0AEce92De3Edee1F18E0157C05861564";
const QUOTER_ADDRESS = "0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6";
const feeTiers = [500, 3000, 10000]; // Fee tiers in ascending order

// Increased this if you expect more complex transactions
const MAX_GAS_LIMIT = ethers.BigNumber.from(300000); 

// WETH mainnet address
const WETH_ADDRESS = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";

/**
 * Convert "eth" → WETH address. Otherwise assume it's an ERC-20 token address.
 * This means if user says "eth", we treat it as WETH — but we do NOT send native ETH as value.
 * The user must already have WETH if they want to trade it.
 */
function toAddress(tokenStr) {
  if (!tokenStr) throw new Error("Invalid token string");
  const lower = tokenStr.toLowerCase();
  return lower === "eth" ? WETH_ADDRESS : tokenStr;
}

/**
 * Get the ERC-20 `decimals()` on-chain.
 * If it's WETH, we know it's 18 decimals.
 */
async function getTokenDecimals(tokenAddress, provider) {
  const lower = tokenAddress.toLowerCase();
  if (lower === WETH_ADDRESS.toLowerCase()) {
    return 18;
  }
  // Otherwise call decimals() on the ERC-20
  const abi = ["function decimals() view returns (uint8)"];
  const contract = new ethers.Contract(tokenAddress, abi, provider);
  return await contract.decimals();
}

/**
 * Dynamically parse `amountIn` given the token's decimals.
 * If token is "eth" (treated as WETH here), we assume 18 decimals too.
 */
async function parseAmountIn(amountInString, tokenInString, provider) {
  if (!amountInString) throw new Error("Missing amountIn");
  const tokenAddress = toAddress(tokenInString); 
  const decimals = await getTokenDecimals(tokenAddress, provider);
  return ethers.utils.parseUnits(amountInString, decimals);
}

/**
 * Attempt to get the best quote from Quoter by trying each fee tier.
 */
async function getBestQuote(provider, tokenInAddress, tokenOutAddress, amountInWei) {
  const quoter = new ethers.Contract(QUOTER_ADDRESS, quoterAbi, provider);

  for (let fee of feeTiers) {
    try {
      const amountOut = await quoter.callStatic.quoteExactInputSingle(
        tokenInAddress,
        tokenOutAddress,
        fee,
        amountInWei,
        0
      );
      console.log(`Fee tier ${fee} => Output (raw): ${amountOut.toString()}`);
      return { fee, amountOut };
    } catch (error) {
      console.error(`Fee tier ${fee} failed: ${error.message}`);
    }
  }
  throw new Error("No valid liquidity pool found.");
}

/**
 * Example slippage logic. Tweak as needed.
 */
function calculateSlippage(tokenIn, tokenOut) {
  const BASE_SLIPPAGE = 0.005; // 0.5%
  const MAX_SLIPPAGE = 0.03;   // 3%

  if (
    tokenIn.toLowerCase() === WETH_ADDRESS.toLowerCase() &&
    tokenOut.toLowerCase() === "usdt"
  ) {
    return BASE_SLIPPAGE; 
  } else if (
    tokenIn.toLowerCase() === WETH_ADDRESS.toLowerCase() || 
    tokenOut.toLowerCase() === WETH_ADDRESS.toLowerCase()
  ) {
    return Math.min(BASE_SLIPPAGE * 2, MAX_SLIPPAGE); 
  } else {
    return MAX_SLIPPAGE; 
  }
}

// --- API Endpoints ---

/**
 * POST /swap
 * Swaps one token for another, always using ERC-20 logic even if user says "eth".
 * They must have WETH if they typed "eth" for tokenIn. 
 * If they typed "eth" for tokenOut, they receive WETH (no unwrap).
 *
 * Example:
 *   curl -X POST http://localhost:8000/swap \
 *     -H "Content-Type: application/json" \
 *     -H "Authorization: 0xYOUR_PRIVATE_KEY" \
 *     -d '{"amountIn":"10","tokenIn":"eth","tokenOut":"0xABC..."}'
 */
app.post('/swap', async (req, res) => {
  const { authorization } = req.headers;
  const { amountIn, tokenIn, tokenOut } = req.body;

  if (!authorization) {
    return res.status(401).json({ error: "Private key required in Authorization header" });
  }
  if (!amountIn || !tokenIn || !tokenOut) {
    return res.status(400).json({ error: "Missing required parameters in request body" });
  }

  try {
    // Provider + wallet
    const provider = new ethers.providers.JsonRpcProvider(RPC_URL);
    const wallet = new ethers.Wallet(authorization, provider);

    // Convert tokens ("eth" => WETH)
    const tokenInAddress = toAddress(tokenIn);
    const tokenOutAddress = toAddress(tokenOut);

    // Parse input amount with correct decimals
    const amountInWei = await parseAmountIn(amountIn, tokenIn, provider);

    // We ALWAYS treat these as ERC-20 flows, so no sending native ETH:
    // That means no "valueToSend" for the swap.
    const valueToSend = ethers.constants.Zero;

    // Check ERC-20 balance + allowance for tokenIn
    // (Even if user typed "eth", we interpret that as WETH and do an allowance check)
    const tokenContract = new ethers.Contract(
      tokenInAddress,
      [
        "function allowance(address owner, address spender) view returns (uint256)",
        "function balanceOf(address owner) view returns (uint256)",
        "function approve(address spender, uint256 amount) external returns (bool)"
      ],
      wallet
    );

    // Check balance
    const balance = await tokenContract.balanceOf(wallet.address);
    if (balance.lt(amountInWei)) {
      return res.status(400).json({ error: "Insufficient token balance." });
    }

    // Check allowance
    const allowance = await tokenContract.allowance(wallet.address, UNISWAP_V3_ROUTER_ADDRESS);
    if (allowance.lt(amountInWei)) {
      const approveTx = await tokenContract.approve(
        UNISWAP_V3_ROUTER_ADDRESS,
        ethers.constants.MaxUint256
      );
      await approveTx.wait();
      console.log("Approval complete.");
    }

    // Quote best output
    const { fee, amountOut } = await getBestQuote(provider, tokenInAddress, tokenOutAddress, amountInWei);

    // Slippage
    const dynamicSlippage = calculateSlippage(tokenInAddress, tokenOutAddress);
    // e.g.: amountOutMinimum = amountOut * (1 - slippage)
    const amountOutMinimum = amountOut
      .mul(100 - (dynamicSlippage * 100))
      .div(100);

    // Prepare swap
    const router = new ethers.Contract(UNISWAP_V3_ROUTER_ADDRESS, routerAbi, wallet);
    const params = {
      tokenIn: tokenInAddress,
      tokenOut: tokenOutAddress,
      fee,
      recipient: wallet.address,
      deadline: Math.floor(Date.now() / 1000) + 300,
      amountIn: amountInWei,
      amountOutMinimum,
      sqrtPriceLimitX96: 0
    };

    // Execute swap (no value since we’re not sending ETH)
    const swapTx = await router.exactInputSingle(params, {
      gasLimit: MAX_GAS_LIMIT,
      value: valueToSend
    });
    const receipt = await swapTx.wait();

    res.status(200).json({ transactionHash: receipt.transactionHash });
  } catch (error) {
    console.error("Error executing swap:", error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /quote
 * Returns an estimated output amount for a given input amount, 
 * also always treating "eth" as WETH for the purpose of quoting.
 *
 * Example:
 *   curl -X POST http://localhost:8000/quote \
 *     -H "Content-Type: application/json" \
 *     -d '{"amountIn":"10","tokenIn":"eth","tokenOut":"0xABC..."}'
 */
app.post('/quote', async (req, res) => {
  const { amountIn, tokenIn, tokenOut } = req.body;

  if (!amountIn || !tokenIn || !tokenOut) {
    return res.status(400).json({ error: "Missing required parameters in request body" });
  }

  try {
    const provider = new ethers.providers.JsonRpcProvider(RPC_URL);

    const tokenInAddress = toAddress(tokenIn);
    const tokenOutAddress = toAddress(tokenOut);

    // Parse input with dynamic decimals
    const amountInWei = await parseAmountIn(amountIn, tokenIn, provider);

    // Get quote
    const { fee, amountOut } = await getBestQuote(provider, tokenInAddress, tokenOutAddress, amountInWei);

    // Format the output for readability
    const outDecimals = await getTokenDecimals(tokenOutAddress, provider);
    const amountOutFormatted = ethers.utils.formatUnits(amountOut, outDecimals);

    res.status(200).json({
      feeTier: fee,
      amountOut: amountOutFormatted,
      amountOutRaw: amountOut.toString()
    });
  } catch (error) {
    console.error("Error getting quote:", error);
    res.status(500).json({ error: error.message });
  }
});

// Start server
const PORT = process.env.PORT || 8000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
