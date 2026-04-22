const hre = require("hardhat");

async function main() {

  const CapabilityManager = await hre.ethers.getContractFactory("CapabilityManager");

  const capabilityManager = await CapabilityManager.deploy();

  await capabilityManager.waitForDeployment();

  console.log("CapabilityManager deployed to:", capabilityManager.target);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
