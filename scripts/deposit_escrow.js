require("dotenv").config();

const { ethers, artifacts } = require("hardhat");

async function main() {
    const SEPOLIA_RPC_URL =
        process.env.SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com";
    const ESCROW_ADDRESS = process.env.ESCROW_ADDRESS || "";

    const PAYER_PRIVATE_KEY =
        process.env.PAYER_PRIVATE_KEY || process.env.TRUSTED_ISSUER_PRIVATE_KEY || "";

    const AMOUNT_ETH = process.env.DEPOSIT_AMOUNT_ETH || process.argv[2] || "0.1";

    if (!ESCROW_ADDRESS) throw new Error("Missing ESCROW_ADDRESS in .env");
    if (!PAYER_PRIVATE_KEY) {
        throw new Error("Missing PAYER_PRIVATE_KEY or TRUSTED_ISSUER_PRIVATE_KEY in .env");
    }

    const provider = new ethers.providers.JsonRpcProvider(SEPOLIA_RPC_URL);
    const payerWallet = new ethers.Wallet(PAYER_PRIVATE_KEY, provider);

    const escrowArtifact = await artifacts.readArtifact("EscrowReceipt");
    const escrowContract = new ethers.Contract(
        ESCROW_ADDRESS,
        escrowArtifact.abi,
        payerWallet
    );

    console.log("============================================");
    console.log("💰 [zk-CrossAgent] Escrow 预算池充值脚本");
    console.log("============================================");
    console.log(`tx sender   : ${payerWallet.address}`);
    console.log(`escrow      : ${ESCROW_ADDRESS}`);
    console.log(`payer       : ${payerWallet.address}`);
    console.log(`amount      : ${AMOUNT_ETH} ETH`);

    const estimate = await escrowContract.estimateGas.depositFor(
        payerWallet.address,
        { value: ethers.utils.parseEther(AMOUNT_ETH) }
    );

    const tx = await escrowContract.depositFor(payerWallet.address, {
        value: ethers.utils.parseEther(AMOUNT_ETH)
    });

    console.log(`✅ 已提交 Sepolia 充值交易: ${tx.hash}`);
    const receipt = await tx.wait();

    console.log("🏁 Escrow 预算池充值成功");
    console.log(`estimateGas : ${estimate.toString()}`);
    console.log(`gasUsed     : ${receipt.gasUsed.toString()}`);
}

main().catch((err) => {
    console.error("❌ Escrow 充值失败:", err.message);
    process.exit(1);
});