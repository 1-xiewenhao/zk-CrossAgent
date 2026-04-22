require("@nomiclabs/hardhat-ethers");

// 你的测试钱包私钥
const PRIVATE_KEY = "0x168615b4017fd7f6f1cd76b5d2734b47548f05fa295f9e20196080eaa9302026";

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.28",
    settings: {
      evmVersion: "cancun",
      // 🌟 开启极致优化，大幅降低巨型合约部署所需的 Gas 费！
      optimizer: {
        enabled: true,
        runs: 200
      }
    }
  },
  networks: {
    // 🏦 支付链 (Sepolia 主网)
    sepolia: {
      url: "https://ethereum-sepolia-rpc.publicnode.com",
      accounts: [PRIVATE_KEY]
    },
    // 🚀 服务链 (Polygon Amoy 侧链)
    polygonAmoy: {
      // 换成了 Polygon 官方直接维护的核心节点 (最稳，免注册)
      url: "https://rpc-amoy.polygon.technology",
      accounts: [PRIVATE_KEY],
      chainId: 80002
    }
  }
};