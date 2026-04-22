require("dotenv").config();
const { ethers } = require("hardhat");

async function main() {
    const endpointAddress = process.env.TRUSTED_ENDPOINT;
    if (!endpointAddress) {
        throw new Error("Missing TRUSTED_ENDPOINT in environment");
    }

    const EscrowReceipt = await ethers.getContractFactory("EscrowReceipt");
    const escrow = await EscrowReceipt.deploy(endpointAddress);
    await escrow.deployed();

    console.log("======================================");
    console.log("✅ EscrowReceipt deployed");
    console.log("======================================");
    console.log("trustedEndpoint =", endpointAddress);
    console.log("escrowAddress   =", escrow.address);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});