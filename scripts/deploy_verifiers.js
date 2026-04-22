const { ethers, network } = require("hardhat");

async function main() {
    console.log("=========================================");
    console.log(`🚀 正在部署 Verifiers 到网络: ${network.name}`);
    console.log("=========================================");

    const [deployer] = await ethers.getSigners();
    console.log("部署账户:", deployer.address);

    const balance = await deployer.getBalance();
    console.log("账户余额:", ethers.utils.formatEther(balance), "ETH\n");

    const EXISTING_ROOT_VERIFIER = process.env.ROOT_VERIFIER_ADDRESS || "";
    let rootVerifierAddress = EXISTING_ROOT_VERIFIER;

    if (rootVerifierAddress) {
        console.log(`♻️ 检测到已有 Root Verifier，跳过部署: ${rootVerifierAddress}`);
    } else {
        console.log("⏳ 正在部署 Root Verifier...");
        const RootVerifier = await ethers.getContractFactory("Groth16Verifier");
        const rootVerifier = await RootVerifier.deploy();
        await rootVerifier.deployed();
        rootVerifierAddress = rootVerifier.address;
        console.log("✅ Root Verifier 已部署至:", rootVerifierAddress);
    }

    console.log("\n⏳ 正在部署 Batch Verifier...");
    const BatchVerifier = await ethers.getContractFactory("BatchGroth16Verifier");
    const batchVerifier = await BatchVerifier.deploy();
    await batchVerifier.deployed();
    console.log("✅ Batch Verifier 已部署至:", batchVerifier.address);

    console.log("\n🎉 Verifiers 部署完成！");
    console.log("=========================================");
    console.log("请将以下地址写入 .env：");
    console.log(`ROOT_VERIFIER_ADDRESS=${rootVerifierAddress}`);
    console.log(`BATCH_VERIFIER_ADDRESS=${batchVerifier.address}`);
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});