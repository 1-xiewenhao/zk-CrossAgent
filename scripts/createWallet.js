const { ethers } = require("hardhat");

function main() {
    // 随机生成一个真实的以太坊钱包
    const wallet = ethers.Wallet.createRandom();
    
    console.log("=========================================");
    console.log("🎉 你的专属公链测试钱包已生成！");
    console.log("=========================================");
    console.log("钱包地址 (Address):", wallet.address);
    console.log("钱包私钥 (Private Key):", wallet.privateKey);
    console.log("=========================================");
    console.log("⚠️ 请务必保存好这串私钥！接下来的公链部署全靠它。");
    console.log("⚠️ 注意：这只是测试钱包，绝对不要往里面打真实的、有价值的资产！");
}

main();