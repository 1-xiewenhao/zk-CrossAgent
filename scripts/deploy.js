require("dotenv").config();
const { ethers, network } = require("hardhat");

async function main() {
    console.log("=========================================");
    console.log(`🚀 正在部署 CapabilityManager 到网络: ${network.name}`);
    console.log("=========================================");

    const [deployer] = await ethers.getSigners();
    console.log("部署账户:", deployer.address);

    const balance = await deployer.getBalance();
    console.log("账户余额:", ethers.utils.formatEther(balance), "ETH\n");

    const ROOT_VERIFIER_ADDRESS = process.env.ROOT_VERIFIER_ADDRESS;
    const BATCH_VERIFIER_ADDRESS = process.env.BATCH_VERIFIER_ADDRESS;

    console.log("ROOT_VERIFIER_ADDRESS =", ROOT_VERIFIER_ADDRESS);
    console.log("BATCH_VERIFIER_ADDRESS =", BATCH_VERIFIER_ADDRESS);

    if (!ROOT_VERIFIER_ADDRESS) {
        throw new Error("Missing ROOT_VERIFIER_ADDRESS in .env");
    }
    if (!BATCH_VERIFIER_ADDRESS) {
        throw new Error("Missing BATCH_VERIFIER_ADDRESS in .env");
    }

    console.log("⏳ 正在部署 CapabilityManager...");
    const CapabilityManager = await ethers.getContractFactory("CapabilityManager");
    const capManager = await CapabilityManager.deploy(
        ROOT_VERIFIER_ADDRESS,
        BATCH_VERIFIER_ADDRESS
    );
    await capManager.deployed();

    console.log("✅ CapabilityManager 已部署至:", capManager.address);
    console.log("=========================================");
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});